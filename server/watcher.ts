import { lstat } from 'node:fs/promises';
import { normalize } from 'node:path';

import { type FSWatcher, watch } from 'chokidar';

import { indexFile, removeIndexedFile } from './indexer';
import type { Db } from './db';

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

async function confirmAndRemove(db: Db, path: string): Promise<void> {
  try {
    await lstat(path);
    // File exists again — an add/change event already re-indexed it (or
    // will shortly); nothing to do here.
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      try {
        await removeIndexedFile(db, path);
      } catch (removeErr) {
        // This runs fire-and-forget from a setTimeout callback (see
        // `void confirmAndRemove(...)` below) — an uncaught rejection here
        // would be an unhandled promise rejection that crashes the process.
        console.error(`File watcher: failed to remove deleted file ${path} from index:`, removeErr);
      }
    } else {
      console.error(`File watcher: failed to confirm deletion of ${path}:`, err);
    }
  }
}

export function startFileWatcher(
  db: Db,
  folders: string[],
  options: FileWatcherOptions = {},
): FileWatcherHandle {
  const {
    deleteGraceMs = DEFAULT_DELETE_GRACE_MS,
    stabilityThresholdMs = DEFAULT_STABILITY_THRESHOLD_MS,
  } = options;

  const watched = new Set(folders);
  const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelPendingDelete(path: string) {
    const timer = pendingDeletes.get(path);
    if (timer !== undefined) {
      clearTimeout(timer);
      pendingDeletes.delete(path);
    }
  }

  const watcher: FSWatcher = watch([...watched], {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (path: string) => isIgnoredPath(path, watched),
    awaitWriteFinish: { stabilityThreshold: stabilityThresholdMs, pollInterval: 20 },
  });

  watcher.on('add', (path) => {
    cancelPendingDelete(path);
    void handleAddOrChange(db, path);
  });
  watcher.on('change', (path) => {
    cancelPendingDelete(path);
    void handleAddOrChange(db, path);
  });
  watcher.on('unlink', (path) => {
    cancelPendingDelete(path);
    const timer = setTimeout(() => {
      pendingDeletes.delete(path);
      void confirmAndRemove(db, path);
    }, deleteGraceMs);
    pendingDeletes.set(path, timer);
  });
  watcher.on('error', (err) => {
    console.error('File watcher error:', err);
  });

  return {
    stop: () => {
      for (const timer of pendingDeletes.values()) clearTimeout(timer);
      pendingDeletes.clear();
      watcher.close().catch(() => {});
    },
    syncFolders: (folders: string[]) => {
      const next = new Set(folders);
      for (const folder of next) {
        if (!watched.has(folder)) {
          watched.add(folder);
          watcher.add(folder);
        }
      }
      for (const folder of [...watched]) {
        if (!next.has(folder)) {
          watched.delete(folder);
          void watcher.unwatch(folder);
        }
      }
    },
  };
}
