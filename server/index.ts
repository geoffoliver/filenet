import { type PeerData, handleMessage, handleOpen } from './peer';
import {
  acceptFriendRequest,
  addOutgoingFriend,
  getFriends,
  rejectFriendRequest,
  removeFriend,
} from './friends';
import { getOrCreateSettings, updateSettings } from './config';
import { connectToPeer } from './connections';
import { createPrismaClient } from './db';
import { getOrCreateIdentity } from './identity';

const prisma = createPrismaClient();
const PORT = parseInt(process.env.P2P_PORT ?? '7734');

const identity = await getOrCreateIdentity(prisma);
console.log(`Node ID:  ${identity.nodeId}`);
console.log(`Listening on port ${PORT}`);

Bun.serve<PeerData>({
  port: PORT,
  async fetch(req, server) {
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

    // Management API — friends
    if (url.pathname === '/api/friends') {
      if (req.method === 'GET') {
        const friends = await getFriends(prisma);
        return Response.json(friends);
      }

      if (req.method === 'POST') {
        const body = (await req.json()) as {
          name: string;
          address: string;
          port?: number;
          password?: string;
        };
        const port = body.port ?? 7734;
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

      if (req.method === 'PUT') {
        const body = (await req.json()) as { action: 'accept' | 'reject' };
        if (body.action === 'accept') {
          const updated = await acceptFriendRequest(prisma, id);
          return Response.json(updated);
        }
        if (body.action === 'reject') {
          await rejectFriendRequest(prisma, id);
          return new Response(null, { status: 204 });
        }
        return new Response('Bad Request', { status: 400 });
      }

      if (req.method === 'DELETE') {
        await removeFriend(prisma, id);
        return new Response(null, { status: 204 });
      }
    }

    // Management API — settings
    if (url.pathname === '/api/settings') {
      if (req.method === 'GET') {
        const settings = await getOrCreateSettings(prisma);
        return Response.json(settings);
      }

      if (req.method === 'PATCH') {
        const body = (await req.json()) as Record<string, unknown>;
        const updated = await updateSettings(prisma, body as any);
        return Response.json(updated);
      }
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
    close(_ws) {
      // TODO: remove from connected peers registry, notify UI
    },
  },
});
