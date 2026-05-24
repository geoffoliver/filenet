import {
  type PeerData, handleMessage, handleOpen, 
} from './peer';
import { createPrismaClient } from './db';
import { getOrCreateIdentity } from './identity';

const prisma = createPrismaClient();
const PORT = parseInt(process.env.P2P_PORT ?? '7734');

const identity = await getOrCreateIdentity(prisma);
console.log(`Node ID:  ${identity.nodeId}`);
console.log(`Listening on port ${PORT}`);

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

    if (server.upgrade(req, { data: { identity, state: { phase: 'pending' } } })) {
      return undefined;
    }

    return new Response('Not Found', { status: 404 });
  },
  websocket: {
    open(ws) {
      handleOpen(ws);
    },
    message(ws, raw) {
      handleMessage(ws, raw, (_ws, msg) => {
        if (msg.type === 'ping') {
          // sendEncrypted(ws, { type: 'pong', timestamp: Date.now() });
        }
      });
    },
    close(_ws) {
      // TODO: clean up peer state / notify UI
    },
  },
});
