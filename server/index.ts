import { AddFriendBodySchema, FriendActionBodySchema, PatchSettingsBodySchema } from './schemas';
import { type PeerData, handleMessage, handleOpen } from './peer';
import { acceptFriendRequest, addOutgoingFriend, getFriends, rejectFriendRequest } from './friends';
import {
  closeAndUnregisterPeer,
  connectToPeer,
  getConnectedPeer,
  notifyFriendAccepted,
  notifyFriendRejected,
  unregisterPeer,
} from './connections';
import { getOrCreateSettings, sanitizeSettings, updateSettings } from './config';
import { createPrismaClient } from './db';
import { getOrCreateIdentity } from './identity';

const prisma = createPrismaClient();
const PORT = parseInt(process.env.P2P_PORT ?? '7734', 10);
const MGMT_PORT = parseInt(process.env.MGMT_PORT ?? '7735', 10);
if (isNaN(PORT) || PORT < 1 || PORT > 65535)
  throw new Error(`Invalid P2P_PORT: "${process.env.P2P_PORT ?? ''}"`);
if (isNaN(MGMT_PORT) || MGMT_PORT < 1 || MGMT_PORT > 65535)
  throw new Error(`Invalid MGMT_PORT: "${process.env.MGMT_PORT ?? ''}"`);
if (PORT === MGMT_PORT) throw new Error('P2P_PORT and MGMT_PORT must be different');

const identity = await getOrCreateIdentity(prisma);
console.log(`Node ID:   ${identity.nodeId}`);
console.log(`P2P port:  ${PORT}`);
console.log(`Mgmt port: ${MGMT_PORT} (localhost only)`);

// Management API — localhost only, no WebSocket upgrade
Bun.serve({
  port: MGMT_PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);

    try {
      if (url.pathname === '/api/friends') {
        if (req.method === 'GET') {
          const friends = await getFriends(prisma);
          return Response.json(friends);
        }

        if (req.method === 'POST') {
          const result = AddFriendBodySchema.safeParse(await req.json());
          if (!result.success) {
            return new Response(result.error.issues[0].message, { status: 400 });
          }
          const { name, address, port, password } = result.data;
          const friend = await addOutgoingFriend(prisma, { name, address, port });
          connectToPeer(identity, prisma, address, port, PORT, { name, password }).catch(
            (err: unknown) => {
              console.error(`Failed to connect to ${address}:${port}:`, err);
            },
          );
          return Response.json(friend, { status: 201 });
        }
      }

      if (url.pathname.startsWith('/api/friends/')) {
        const id = url.pathname.slice('/api/friends/'.length);
        if (!id || id.includes('/')) {
          return new Response('Invalid friend id', { status: 400 });
        }

        if (req.method === 'PUT') {
          const result = FriendActionBodySchema.safeParse(await req.json());
          if (!result.success) {
            return new Response(result.error.issues[0].message, { status: 400 });
          }
          const { action } = result.data;
          if (action === 'accept') {
            const updated = await acceptFriendRequest(prisma, id);
            if (updated.nodeId) {
              const peer = getConnectedPeer(updated.nodeId);
              if (peer) {
                const settings = await getOrCreateSettings(prisma);
                notifyFriendAccepted(peer, settings.name || null);
              }
            }
            return Response.json(updated);
          }
          if (action === 'reject') {
            const friend = await prisma.friend.findUnique({ where: { id } });
            if (!friend) return new Response(`Friend ${id} not found`, { status: 404 });
            await rejectFriendRequest(prisma, id);
            if (friend.nodeId) {
              const peer = getConnectedPeer(friend.nodeId);
              if (peer) notifyFriendRejected(peer);
              closeAndUnregisterPeer(friend.nodeId);
            }
            return new Response(null, { status: 204 });
          }
        }

        if (req.method === 'DELETE') {
          const toDelete = await prisma.friend.findUnique({ where: { id } });
          if (!toDelete) return new Response(`Friend ${id} not found`, { status: 404 });
          if (toDelete.nodeId) closeAndUnregisterPeer(toDelete.nodeId);
          await prisma.friend.delete({ where: { id } });
          return new Response(null, { status: 204 });
        }
      }

      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') {
          const settings = await getOrCreateSettings(prisma);
          return Response.json(sanitizeSettings(settings));
        }

        if (req.method === 'PATCH') {
          const result = PatchSettingsBodySchema.safeParse(await req.json());
          if (!result.success) {
            return new Response(result.error.issues[0].message, { status: 400 });
          }
          const updated = await updateSettings(prisma, result.data);
          return Response.json(sanitizeSettings(updated));
        }
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: unknown) {
      const isDuplicate = err instanceof Error && err.message.startsWith('Already have a friend');
      if (isDuplicate) return new Response((err as Error).message, { status: 409 });

      const isConflict =
        err instanceof Error &&
        (err.message.startsWith('Cannot reject') || err.message.startsWith('Cannot accept'));
      if (isConflict) return new Response((err as Error).message, { status: 409 });

      const isNotFound = err instanceof Error && err.message.includes('not found');
      if (isNotFound) return new Response((err as Error).message, { status: 404 });

      if (err instanceof SyntaxError) return new Response('Invalid JSON body', { status: 400 });

      console.error('Management API error:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
});

// P2P server — public, WebSocket + pubkey endpoint only
Bun.serve<PeerData>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/pubkey') {
      return Response.json({
        nodeId: identity.nodeId,
        publicKey: identity.publicKey.toString('base64'),
      });
    }

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', nodeId: identity.nodeId });
    }

    if (
      server.upgrade(req, {
        data: {
          identity,
          prisma,
          localPort: PORT,
          state: { phase: 'pending' },
        },
      })
    ) {
      return undefined;
    }

    return new Response('Not Found', { status: 404 });
  },
  websocket: {
    open(ws) {
      handleOpen(ws);
    },
    message(ws, raw) {
      handleMessage(ws, raw);
    },
    close(ws) {
      const state = ws.data.state;
      if (state.phase === 'authenticated') {
        const current = getConnectedPeer(state.peerNodeId);
        if (current && (current.ws as unknown) === ws) unregisterPeer(state.peerNodeId);
      }
    },
  },
});
