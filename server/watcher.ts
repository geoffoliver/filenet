import { lstat } from 'node:fs/promises';
import { normalize } from 'node:path';

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

// chokidar always hands `ignored` a forward-slash-normalized path (its own
// internal normalizePath()), on every platform — including Windows, where
// a configured folder path is still backslash-based. Normalize the folder
// the same way before comparing, or the prefix match below never fires on
// Windows, silently ignoring everything (verified against chokidar's
// source: matchPatterns() -> normalizePath() converts `\` to `/` before
// any `ignored` predicate runs, for both file paths and the watched root).
function toComparablePath(path: string): string {
  return normalize(path).replace(/\\/g, '/');
}

// Mirrors scanDirectory's dotfile skip (server/indexer.ts) — only tests
// each entry as it recurses, never the configured root folder or anything
// above it. Strip the matching watched root off first so a shared folder
// living under a dotted ancestor (e.g. ~/.Movies) isn't wrongly excluded.
export function isIgnoredPath(path: string, folders: Iterable<string>): boolean {
  for (const folder of folders) {
    const normalizedFolder = toComparablePath(folder);
    if (path === normalizedFolder) return false;
    const prefix = normalizedFolder.endsWith('/') ? normalizedFolder : `${normalizedFolder}/`;
    if (path.startsWith(prefix)) {
      return DOTFILE_SEGMENT.test(path.slice(prefix.length));
    }
  }
  // Not under any currently-watched folder (e.g. a stale event right after
  // syncFolders removed it) — fail safe and ignore it.
  return true;
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
    ignored: (path: string) => isIgnoredPath(path, folders),
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
