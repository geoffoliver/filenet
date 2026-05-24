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

const SETTINGS_PATCHABLE = new Set([
  'name',
  'invitePassword',
  'autoAcceptFromAnyone',
  'autoAcceptFromFriendsOfFriends',
]);

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
          const rawPostBody = await req.json();
          if (!rawPostBody || typeof rawPostBody !== 'object' || Array.isArray(rawPostBody)) {
            return new Response('Request body must be a JSON object', { status: 400 });
          }
          const body = rawPostBody as {
            name: string;
            address: string;
            port?: number;
            password?: string;
          };
          if (typeof body.name !== 'string' || !body.name.trim()) {
            return new Response('name must be a non-empty string', { status: 400 });
          }
          if (typeof body.address !== 'string' || !body.address.trim()) {
            return new Response('address must be a non-empty string', { status: 400 });
          }
          if (body.password !== undefined && typeof body.password !== 'string') {
            return new Response('password must be a string', { status: 400 });
          }
          const port = body.port ?? 7734;
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            return new Response('port must be an integer between 1 and 65535', { status: 400 });
          }
          const friend = await addOutgoingFriend(prisma, {
            name: body.name,
            address: body.address,
            port,
          });
          connectToPeer(identity, prisma, body.address, port, PORT, {
            name: body.name,
            password: body.password,
          }).catch((err: unknown) => {
            console.error(`Failed to connect to ${body.address}:${port}:`, err);
          });
          return Response.json(friend, { status: 201 });
        }
      }

      if (url.pathname.startsWith('/api/friends/')) {
        const id = url.pathname.slice('/api/friends/'.length);
        if (!id || id.includes('/')) {
          return new Response('Invalid friend id', { status: 400 });
        }

        if (req.method === 'PUT') {
          const rawPutBody = await req.json();
          if (!rawPutBody || typeof rawPutBody !== 'object' || Array.isArray(rawPutBody)) {
            return new Response('Request body must be a JSON object', { status: 400 });
          }
          const body = rawPutBody as { action: 'accept' | 'reject' };
          if (body.action === 'accept') {
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
          if (body.action === 'reject') {
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
          return new Response('action must be accept or reject', { status: 400 });
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
          const rawPatchBody = await req.json();
          if (!rawPatchBody || typeof rawPatchBody !== 'object' || Array.isArray(rawPatchBody)) {
            return new Response('Request body must be a JSON object', { status: 400 });
          }
          const body = rawPatchBody as Record<string, unknown>;
          const unknown = Object.keys(body).filter((k) => !SETTINGS_PATCHABLE.has(k));
          if (unknown.length > 0) {
            return new Response(`Unknown fields: ${unknown.join(', ')}`, { status: 400 });
          }
          if ('name' in body && typeof body.name !== 'string') {
            return new Response('name must be a string', { status: 400 });
          }
          if (
            'invitePassword' in body &&
            body.invitePassword !== null &&
            typeof body.invitePassword !== 'string'
          ) {
            return new Response('invitePassword must be a string or null', { status: 400 });
          }
          if ('autoAcceptFromAnyone' in body && typeof body.autoAcceptFromAnyone !== 'boolean') {
            return new Response('autoAcceptFromAnyone must be a boolean', { status: 400 });
          }
          if (
            'autoAcceptFromFriendsOfFriends' in body &&
            typeof body.autoAcceptFromFriendsOfFriends !== 'boolean'
          ) {
            return new Response('autoAcceptFromFriendsOfFriends must be a boolean', {
              status: 400,
            });
          }
          const updated = await updateSettings(prisma, body as any);
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
