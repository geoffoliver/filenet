import { lstat } from 'node:fs/promises';

import { type FSWatcher, watch } from 'chokidar';

import type { Db } from './db';
import { indexFile } from './indexer';

export const DEFAULT_DELETE_GRACE_MS = 30_000;
export const DEFAULT_STABILITY_THRESHOLD_MS = 2000;

const DOTFILE_SEGMENT = /(^|[/\\])\../;

export interface FileWatcherOptions {
  deleteGraceMs?: number;
  stabilityThresholdMs?: number;
}

export interface FileWatcherHandle {
  stop: () => void;
  syncFolders: (folders: string[]) => void;
}

async function handleAddOrChange(db: Db, path: string): Promise<void> {
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink()) return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    console.error(`File watcher: failed to stat ${path}:`, err);
    return;
  }
  try {
    await indexFile(db, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    console.error(`File watcher: failed to index ${path}:`, err);
  }
}

export function startFileWatcher(
  db: Db,
  folders: string[],
  options: FileWatcherOptions = {},
): FileWatcherHandle {
  const { stabilityThresholdMs = DEFAULT_STABILITY_THRESHOLD_MS } = options;

  const watcher: FSWatcher = watch([...folders], {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (path: string) => DOTFILE_SEGMENT.test(path),
    awaitWriteFinish: { stabilityThreshold: stabilityThresholdMs, pollInterval: 20 },
  });

  watcher.on('add', (path) => {
    void handleAddOrChange(db, path);
  });
  watcher.on('change', (path) => {
    void handleAddOrChange(db, path);
  });
  watcher.on('unlink', () => {
    // Implemented in Task 2.
  });
  watcher.on('error', (err) => {
    console.error('File watcher error:', err);
  });

  return {
    stop: () => {
      void watcher.close();
    },
    syncFolders: () => {
      // Implemented in Task 3.
    },
  };
}
