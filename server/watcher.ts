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

// Cleans up any indexed row for a path handleAddOrChange decided NOT to
// index (symlink, non-regular file, or vanished before it could be
// stat'd/read). An add/change event always cancels a pending delete timer
// for the same path first (see cancelPendingDelete below) — if we then
// bail out here without indexing, nothing else is left to remove a
// previously-indexed row at that path, so it would otherwise survive
// until the next periodic/manual scan. removeIndexedFile is a no-op when
// no row exists, so calling this unconditionally is safe.
async function removeStaleRow(db: Db, path: string): Promise<void> {
  try {
    await removeIndexedFile(db, path);
  } catch (err) {
    console.error(`File watcher: failed to remove stale index row for ${path}:`, err);
  }
}

async function handleAddOrChange(db: Db, path: string): Promise<void> {
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink()) {
      await removeStaleRow(db, path);
      return;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      await removeStaleRow(db, path);
      return;
    }
    console.error(`File watcher: failed to stat ${path}:`, err);
    return;
  }
  try {
    await indexFile(db, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      await removeStaleRow(db, path);
      return;
    }
    console.error(`File watcher: failed to index ${path}:`, err);
  }
}

async function confirmAndRemove(db: Db, path: string): Promise<void> {
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink()) {
      // A symlink now lives at this path. Symlinks are never indexed, and
      // on some platforms (verified on Linux/inotify via chokidar's own
      // event model) chokidar never emits an add/change event when a
      // deleted file is immediately replaced by a symlink at the same
      // path — unlike macOS, where that same sequence fires a change
      // event that handleAddOrChange cleans up reactively. Without this,
      // the stale row would survive indefinitely on those platforms
      // instead of just until the next periodic rescan.
      await removeStaleRow(db, path);
    }
    // Otherwise a real file exists again — an add/change event already
    // re-indexed it (or will shortly); nothing to do here.
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

// Fast path for the same symlink-replacement case confirmAndRemove guards
// against as a fallback (see its comment): on platforms where chokidar
// never emits an add/change event for it, waiting out the full
// deleteGraceMs to notice is needlessly slow when a short settle window
// is enough to tell a symlink apart from a file that's still mid-write.
// `cancelPendingDelete` is passed in (rather than closed over) because
// this function is defined outside startFileWatcher, same as
// confirmAndRemove.
async function checkForSymlinkReplacement(
  db: Db,
  path: string,
  settleMs: number,
  cancelPendingDelete: (path: string) => void,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  try {
    const s = await lstat(path);
    if (!s.isSymbolicLink()) return; // real file — let add/change handle it normally
  } catch {
    return; // still gone — let the deleteGraceMs timer run its course
  }
  cancelPendingDelete(path);
  await removeStaleRow(db, path);
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
    void checkForSymlinkReplacement(db, path, stabilityThresholdMs, cancelPendingDelete);
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
