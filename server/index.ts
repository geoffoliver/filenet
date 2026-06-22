import {
  type PeerData,
  dispatchSearchMessage,
  dispatchVouchMessage,
  handleMessage,
  handleOpen,
} from './peer';
import { clearActiveUploadSessionsForPeer, dispatchTransferMessage } from './transfer-protocol';
import { connectToPeer, getConnectedPeer, unregisterPeer } from './connections';
import { getOrCreateSettings, parseSharedFolders } from './config';
import { createManagementFetch } from './management';
import { createPrismaClient } from './db';
import { getOrCreateIdentity } from './identity';
import { pauseAllActiveDownloads } from './download-manager';
import { startPeriodicRescan } from './indexer';
import { startReconnectLoop } from './reconnect';

const prisma = createPrismaClient();
const MGMT_PORT = parseInt(process.env.MGMT_PORT ?? '7735', 10);
if (isNaN(MGMT_PORT) || MGMT_PORT < 1 || MGMT_PORT > 65535)
  throw new Error(`Invalid MGMT_PORT: "${process.env.MGMT_PORT ?? ''}"`);

const identity = await getOrCreateIdentity(prisma);
const startupSettings = await getOrCreateSettings(prisma);
const PORT = parseInt(process.env.P2P_PORT ?? String(startupSettings.listenPort), 10);
if (isNaN(PORT) || PORT < 1 || PORT > 65535)
  throw new Error(
    process.env.P2P_PORT !== undefined
      ? `Invalid P2P_PORT env var: "${process.env.P2P_PORT}"`
      : `Invalid listenPort in settings: ${startupSettings.listenPort}`,
  );
if (PORT === MGMT_PORT)
  throw new Error(
    `P2P port and management port must be different — both resolved to ${PORT}` +
      ` (P2P from ${process.env.P2P_PORT !== undefined ? 'P2P_PORT env var' : 'listenPort in settings'},` +
      ` management from ${process.env.MGMT_PORT !== undefined ? 'MGMT_PORT env var' : 'default 7735'})`,
  );
console.log(`Node ID:   ${identity.nodeId}`);
console.log(`P2P port:  ${PORT}`);
console.log(`Mgmt port: ${MGMT_PORT} (localhost only)`);

const stopRescan = startPeriodicRescan(
  prisma,
  async () => {
    const s = await getOrCreateSettings(prisma);
    return parseSharedFolders(s.sharedFolders);
  },
  async () => {
    const s = await getOrCreateSettings(prisma);
    return s.rescanIntervalMinutes;
  },
);

const connectPeerFn = (
  address: string,
  port: number,
  friendRequest?: { name: string; password?: string },
) =>
  connectToPeer(identity, prisma, address, port, PORT, friendRequest, async (nodeId, msg) => {
    await dispatchSearchMessage(msg, nodeId, prisma, identity);
    await dispatchTransferMessage(msg, nodeId, prisma);
    await dispatchVouchMessage(msg, nodeId, prisma);
  });

const stopReconnect = startReconnectLoop(prisma, identity, connectPeerFn);

const shutdown = () => {
  stopRescan();
  stopReconnect();
  pauseAllActiveDownloads(prisma)
    .catch(() => {})
    .finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Management API — localhost only, no WebSocket upgrade
Bun.serve({
  port: MGMT_PORT,
  hostname: '127.0.0.1',
  fetch: createManagementFetch({ identity, prisma, connectPeer: connectPeerFn }),
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
        clearActiveUploadSessionsForPeer(state.peerNodeId);
      }
    },
  },
});
