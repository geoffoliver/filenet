import { type PeerData, handleMessage, handleOpen } from './peer';
import { connectToPeer, getConnectedPeer, unregisterPeer } from './connections';
import { getOrCreateSettings, parseSharedFolders } from './config';
import { createManagementFetch } from './management';
import { createPrismaClient } from './db';
import { getOrCreateIdentity } from './identity';
import { startPeriodicRescan } from './indexer';

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

const initialSettings = await getOrCreateSettings(prisma);
startPeriodicRescan(
  prisma,
  async () => {
    const s = await getOrCreateSettings(prisma);
    return parseSharedFolders(s.sharedFolders);
  },
  initialSettings.rescanIntervalMinutes,
);

// Management API — localhost only, no WebSocket upgrade
Bun.serve({
  port: MGMT_PORT,
  hostname: '127.0.0.1',
  fetch: createManagementFetch({
    identity,
    prisma,
    connectPeer: (address, port, friendRequest) =>
      connectToPeer(identity, prisma, address, port, PORT, friendRequest),
  }),
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
