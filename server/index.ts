import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';

import {
  type PeerData,
  dispatchChatMessage,
  dispatchGroupCreateMessage,
  dispatchSearchMessage,
  dispatchVouchMessage,
  handleMessage,
  handleOpen,
} from './peer';
import { applyMigrations, createDb } from './db';
import { clearActiveUploadSessionsForPeer, dispatchTransferMessage } from './transfer-protocol';
import { connectToPeer, getConnectedPeer, unregisterPeer } from './connections';
import { createUpdateManager, parseFinishUpdateArgs, runFinishUpdate } from './updater';
import { getOrCreateSettings, parseSharedFolders } from './config';
import { isCompiledBinary, resolveAssetPath } from './runtime-paths';
import { startPeriodicRescan, stopScanWorker } from './indexer';
import { createUiServer } from './ui-server';
import { getOrCreateIdentity } from './identity';
import { openBrowser } from './browser-opener';
import { pauseAllActiveDownloads } from './download-manager';
import { startFileWatcher } from './watcher';
import { startReconnectLoop } from './reconnect';

const finishUpdateArgs = parseFinishUpdateArgs(process.argv);
if (finishUpdateArgs) {
  await runFinishUpdate(
    finishUpdateArgs.oldPid,
    finishUpdateArgs.stagingDir,
    finishUpdateArgs.installDir,
    finishUpdateArgs.launchCwd,
  );
  // runFinishUpdate calls process.exit(0) on success; nothing below this
  // point should ever run when --finish-update was passed.
}

const db = createDb();
applyMigrations(db);

const identity = await getOrCreateIdentity(db);
const startupSettings = await getOrCreateSettings(db);

function resolveCurrentVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const pkgPath = resolveAssetPath('package.json', import.meta.dir);
  try {
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch (err) {
    throw new Error(
      `Could not determine Filenet's version: APP_VERSION is not set and ${pkgPath} could not be read. ` +
        'This should only happen if the binary was built without going through `bun run build:binaries` (which bakes APP_VERSION in) — see README.md.',
      { cause: err },
    );
  }
}

const compiledBinary = isCompiledBinary(import.meta.dir);
const installDir = compiledBinary ? dirname(process.execPath) : process.cwd();

const updateManager = createUpdateManager({
  mode: compiledBinary ? 'binary' : 'source',
  currentVersion: resolveCurrentVersion(),
  installDir,
  getRepo: async () => {
    const s = await getOrCreateSettings(db);
    return s.updateRepo;
  },
});

const stopUpdateChecks = updateManager.startPeriodicChecks(async () => {
  const s = await getOrCreateSettings(db);
  return s.updateCheckIntervalMinutes;
});

const P2P_PORT = parseInt(process.env.P2P_PORT ?? String(startupSettings.listenPort), 10);
if (isNaN(P2P_PORT) || P2P_PORT < 1 || P2P_PORT > 65535)
  throw new Error(
    process.env.P2P_PORT !== undefined
      ? `Invalid P2P_PORT env var: "${process.env.P2P_PORT}"`
      : `Invalid listenPort in settings: ${startupSettings.listenPort}`,
  );

const UI_PORT = parseInt(process.env.PORT ?? '3000', 10);
if (isNaN(UI_PORT) || UI_PORT < 1 || UI_PORT > 65535)
  throw new Error(`Invalid PORT env var: "${process.env.PORT ?? ''}"`);

if (P2P_PORT === UI_PORT)
  throw new Error(
    `P2P port and UI port must be different — both resolved to ${P2P_PORT}` +
      ` (P2P from ${process.env.P2P_PORT !== undefined ? 'P2P_PORT env var' : 'listenPort in settings'},` +
      ` UI from ${process.env.PORT !== undefined ? 'PORT env var' : 'default 3000'})`,
  );

console.log(`Node ID:  ${identity.nodeId}`);
console.log(`P2P port: ${P2P_PORT}`);
console.log(`UI port:  ${UI_PORT}`);
console.log(`UI:       http://localhost:${UI_PORT}`);

const stopRescan = startPeriodicRescan(
  db,
  async () => {
    const s = await getOrCreateSettings(db);
    return parseSharedFolders(s.sharedFolders);
  },
  async () => {
    const s = await getOrCreateSettings(db);
    return s.rescanIntervalMinutes;
  },
);

const fileWatcher = startFileWatcher(
  db.$client.filename,
  parseSharedFolders(startupSettings.sharedFolders),
);

const connectPeerFn = (
  address: string,
  port: number,
  friendRequest?: { name: string; password?: string },
) =>
  connectToPeer(identity, db, address, port, P2P_PORT, friendRequest, async (nodeId, msg) => {
    await dispatchSearchMessage(msg, nodeId, db, identity);
    await dispatchTransferMessage(msg, nodeId, db);
    await dispatchVouchMessage(msg, nodeId, db);
    await dispatchChatMessage(msg, nodeId, db, identity.nodeId);
    await dispatchGroupCreateMessage(msg, nodeId, db);
  });

const stopReconnect = startReconnectLoop(db, identity, connectPeerFn);

const shutdown = () => {
  stopRescan();
  stopReconnect();
  stopUpdateChecks();
  fileWatcher.stop();
  stopScanWorker();
  pauseAllActiveDownloads(db)
    .catch(() => {})
    .finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

Bun.serve({
  port: UI_PORT,
  fetch: createUiServer({
    identity,
    db,
    connectPeer: connectPeerFn,
    updater: updateManager,
    watcher: fileWatcher,
    outDir: resolveAssetPath('out', import.meta.dir),
  }),
});

if (startupSettings.autoOpenBrowser) {
  openBrowser(`http://localhost:${UI_PORT}`);
}

Bun.serve<PeerData>({
  port: P2P_PORT,
  fetch(req, server) {
    if (
      server.upgrade(req, {
        data: {
          identity,
          db,
          localPort: P2P_PORT,
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
        if (current && (current.ws as unknown) === ws) {
          unregisterPeer(state.peerNodeId);
          clearActiveUploadSessionsForPeer(state.peerNodeId);
        }
      }
    },
  },
});
