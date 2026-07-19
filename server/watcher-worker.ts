import {
  type FileWatcherHandle,
  type FileWatcherOptions,
  runFileWatcherInProcess,
} from './watcher';
import { createDb } from './db';

// Runs the real file watcher (server/watcher.ts's runFileWatcherInProcess)
// on a thread separate from the one serving the HTTP/UI. Watching a folder
// that already has many pre-existing files (e.g. configuring a large music
// library as a shared folder for the first time) means chokidar has to
// walk and register every one of them up front — verified to block the
// main thread's event loop so completely that even a setInterval heartbeat
// never fires until it's done, which for a large enough library is the
// same "whole app is unresponsive" problem the scan worker (see
// server/scan-worker.ts) fixes for scanning itself.

export interface WatcherWorkerInitMessage {
  type: 'init';
  dbPath: string;
  folders: string[];
  options?: FileWatcherOptions;
}

export interface WatcherWorkerSyncMessage {
  type: 'sync';
  folders: string[];
}

export interface WatcherWorkerStopMessage {
  type: 'stop';
}

export type WatcherWorkerMessage =
  | WatcherWorkerInitMessage
  | WatcherWorkerSyncMessage
  | WatcherWorkerStopMessage;

let handle: FileWatcherHandle | null = null;

self.onmessage = (event: MessageEvent<WatcherWorkerMessage>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    const db = createDb(msg.dbPath);
    handle = runFileWatcherInProcess(db, msg.folders, msg.options);
  } else if (msg.type === 'sync') {
    handle?.syncFolders(msg.folders);
  } else if (msg.type === 'stop') {
    handle?.stop();
    handle = null;
  }
};
