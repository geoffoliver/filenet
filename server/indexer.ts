import { basename, join, sep } from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import type { Changes } from 'bun:sqlite';

import { SQL, and, eq, lt, or, sql } from 'drizzle-orm';

import type { Db } from './db';
import type { SharedFile } from './schema';
import { extractMetadata } from './metadata';
import { hashFile } from './hash';
import { resolveWorkerPath } from './runtime-paths';
import { sharedFiles } from './schema';

export { hashFile } from './hash';

export async function* scanDirectory(
  dir: string,
  throwOnRootReaddir = false,
  inaccessibleDirs?: Set<string>,
): AsyncGenerator<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!throwOnRootReaddir && (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR')) {
      inaccessibleDirs?.add(dir);
      return;
    }
    throw err;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const fullPath = join(dir, entry);
    let s;
    try {
      s = await lstat(fullPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      if (code === 'EACCES' || code === 'ENOTDIR') {
        inaccessibleDirs?.add(fullPath);
        continue;
      }
      throw err;
    }
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) {
      yield* scanDirectory(fullPath, false, inaccessibleDirs);
    } else if (s.isFile()) {
      yield fullPath;
    }
  }
}

export async function indexFile(
  db: Db,
  path: string,
  lastSeenAt: Date = new Date(),
  // Lets performScan inject a hash-worker-pool-backed hasher (see
  // server/hash-pool.ts) so hashing many files during a bulk scan can run
  // concurrently across cores; defaults to the plain in-thread hashFile for
  // every other caller (the file watcher's single-file reactive path,
  // direct tests) where pooling overhead isn't worth it.
  hashFn: (path: string) => Promise<string> = hashFile,
): Promise<SharedFile> {
  const s = await lstat(path, { bigint: true });
  if (!s.isFile()) {
    const err = new Error(`not a regular file: ${path}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }
  const size = s.size;
  const fileModifiedAt = new Date(Number(s.mtimeMs));

  // Fast path: size + mtime match — just touch lastSeenAt without re-hashing
  const fastHit = db
    .update(sharedFiles)
    .set({ lastSeenAt, updatedAt: lastSeenAt })
    .where(
      and(
        eq(sharedFiles.path, path),
        eq(sharedFiles.size, size),
        eq(sharedFiles.fileModifiedAt, fileModifiedAt),
      ),
    )
    .returning()
    .all();
  if (fastHit.length > 0) {
    return fastHit[0];
  }

  // Full re-index
  const sha256 = await hashFn(path);
  const mimeType = Bun.file(path).type || null;
  const metaObj = await extractMetadata(path);
  const metadata = metaObj ? JSON.stringify(metaObj) : null;
  const filename = basename(path);
  const now = new Date();

  const row = db
    .insert(sharedFiles)
    .values({
      id: randomUUID(),
      path,
      filename,
      size,
      sha256,
      mimeType,
      metadata,
      fileModifiedAt,
      lastSeenAt,
      indexedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: sharedFiles.path,
      set: {
        filename,
        size,
        sha256,
        mimeType,
        metadata,
        fileModifiedAt,
        lastSeenAt,
        indexedAt: now,
        updatedAt: now,
      },
    })
    .returning()
    .get();
  return row!;
}

export async function removeStaleEntries(
  db: Db,
  scanStart: Date,
  protectedRoots: string[] = [],
): Promise<number> {
  // Build exclusion clauses for each protected root:
  // either exact match or path starts with root + separator.
  const exclusionClauses: SQL[] = protectedRoots.flatMap((root) => {
    const normalized = root.endsWith(sep) ? root.slice(0, -1) : root;
    const escaped = normalized.replace(/[%_\\]/g, (c) => `\\${c}`);
    const escapedSep = sep.replace(/[%_\\]/g, (c) => `\\${c}`);
    return [
      eq(sharedFiles.path, normalized),
      sql`${sharedFiles.path} LIKE ${escaped + escapedSep + '%'} ESCAPE '\\'`,
    ] as SQL[];
  });

  const where =
    exclusionClauses.length > 0
      ? and(lt(sharedFiles.lastSeenAt, scanStart), sql`NOT (${or(...exclusionClauses)})`)
      : lt(sharedFiles.lastSeenAt, scanStart);

  const result = db.delete(sharedFiles).where(where).run() as unknown as Changes;
  return result.changes;
}

export async function removeIndexedFile(db: Db, path: string): Promise<void> {
  db.delete(sharedFiles).where(eq(sharedFiles.path, path)).run();
}

// 35791 * 60_000 ms = 2_147_460_000 ms, just under setTimeout's 32-bit signed limit
const MAX_RESCAN_INTERVAL_MINUTES = 35791;

let scanning = false;
// Monotonically-increasing scan clock: ensures each scan's timestamp strictly
// exceeds any lastSeenAt written by a previous scan, even within the same ms.
let lastScanMs = 0;
function nextScanStart(): Date {
  const t = Math.max(Date.now(), lastScanMs + 1);
  lastScanMs = t;
  return new Date(t);
}

// Lets callers that fire scanAndIndex without awaiting it (see management.ts)
// still answer "is a scan running right now?" synchronously, e.g. to reject a
// second manual rescan request instead of silently discarding it.
export function isScanning(): boolean {
  return scanning;
}

// The actual walk-hash-index-cleanup work, factored out of scanAndIndex so
// it can run standalone inside the scan worker (server/scan-worker.ts) --
// scanAndIndex itself just dispatches to that worker so this CPU/IO-heavy
// loop never runs on the same thread as the HTTP server (see CHANGELOG: a
// scan over a large library used to make the whole app unresponsive for
// seconds at a time). Kept independently exported/tested from the worker
// dispatch itself, so the directory-walk/error-handling edge cases have
// fast, direct test coverage that doesn't pay real thread-spawn overhead.
export interface PerformScanOptions {
  onProgress?: (indexed: number) => void;
  // Injected by scan-worker.ts as a hash-worker-pool-backed hasher (see
  // server/hash-pool.ts) so hashing many large files runs concurrently
  // across cores instead of one at a time on this thread. Defaults to the
  // plain in-thread hashFile, matching the pre-pool behavior every existing
  // caller (including every test) already expects.
  hashFn?: (path: string) => Promise<string>;
  // How many indexFile calls (each starting with a hashFn call) may be in
  // flight at once. Should match the hash pool's size when hashFn is
  // pooled — concurrency beyond the pool size just queues extra requests
  // on already-busy workers with no added parallelism. Defaults to 1
  // (fully sequential), matching pre-concurrency behavior.
  concurrency?: number;
}

// The actual walk-hash-index-cleanup work, factored out of scanAndIndex so
// it can run standalone inside the scan worker (server/scan-worker.ts) --
// scanAndIndex itself just dispatches to that worker so this CPU/IO-heavy
// loop never runs on the same thread as the HTTP server (see CHANGELOG: a
// scan over a large library used to make the whole app unresponsive for
// seconds at a time). Kept independently exported/tested from the worker
// dispatch itself, so the directory-walk/error-handling edge cases have
// fast, direct test coverage that doesn't pay real thread-spawn overhead.
export async function performScan(
  db: Db,
  folders: string[],
  scanStart: Date,
  options: PerformScanOptions = {},
): Promise<{ indexed: number; removed: number }> {
  const { onProgress, hashFn = hashFile, concurrency = 1 } = options;
  const seen = new Set<string>();
  let indexed = 0;
  const inaccessibleRoots: string[] = [];

  for (const folder of folders) {
    try {
      const folderStat = await lstat(folder);
      if (!folderStat.isDirectory()) {
        inaccessibleRoots.push(folder);
        continue;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
        inaccessibleRoots.push(folder);
        continue;
      }
      throw err;
    }

    const inaccessibleSubDirs = new Set<string>();
    // Set by dispatch() below once an indexFile call throws something
    // unexpected. Checked between dispatches (not inside dispatch itself,
    // since nothing has had a chance to await/settle by then) so no new
    // work starts once known, while what's already in flight still drains
    // via the final Promise.all rather than being abandoned mid-hash.
    let fatalError: unknown = null;
    const inFlight = new Set<Promise<void>>();

    function dispatch(path: string): void {
      const task = indexFile(db, path, scanStart, hashFn)
        .then(() => {
          indexed++;
          onProgress?.(indexed);
        })
        .catch((err: unknown) => {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            // File vanished between discovery and indexing — treat as stale
          } else if (code === 'EACCES' || code === 'ENOTDIR') {
            inaccessibleRoots.push(path);
          } else if (fatalError === null) {
            fatalError = err;
          }
        });
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    }

    try {
      for await (const path of scanDirectory(folder, true, inaccessibleSubDirs)) {
        if (seen.has(path)) continue;
        seen.add(path);
        dispatch(path);
        if (inFlight.size >= concurrency) {
          await Promise.race(inFlight);
        }
        if (fatalError !== null) break;
      }
      await Promise.all(inFlight);
      if (fatalError !== null) throw fatalError;
      for (const dir of inaccessibleSubDirs) {
        inaccessibleRoots.push(dir);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
        inaccessibleRoots.push(folder);
      } else {
        throw err;
      }
    }
  }

  const removed = await removeStaleEntries(db, scanStart, inaccessibleRoots);
  return { indexed, removed };
}

// Message protocol between scanAndIndex (below) and server/scan-worker.ts.
export interface ScanWorkerRequest {
  type: 'scan';
  dbPath: string;
  folders: string[];
  scanStartMs: number;
}

export type ScanWorkerResponse =
  | { type: 'done'; indexed: number; removed: number }
  | { type: 'error'; message: string };

// Reused across scans rather than spawned fresh each time: spinning up a
// new OS thread and loading the worker's ~2 MB bundle turned out to carry a
// real one-time cost (tens of seconds, observed against a compiled binary)
// on whichever scan happens to be the first in the process. scanAndIndex's
// own mutex means only one scan ever runs at a time, so reusing a single
// worker across sequential scans is safe — there's no concurrent access to
// race against.
let cachedWorker: Worker | null = null;

function getScanWorker(): Worker {
  if (!cachedWorker) {
    cachedWorker = new Worker(resolveWorkerPath('scan-worker', import.meta.dir));
  }
  return cachedWorker;
}

// Exposed for a clean process shutdown (see server/index.ts) — an
// unterminated Worker can keep the event loop alive.
export function stopScanWorker(): void {
  cachedWorker?.terminate();
  cachedWorker = null;
}

async function runScanInWorker(
  db: Db,
  folders: string[],
  scanStart: Date,
): Promise<{ indexed: number; removed: number }> {
  const worker = getScanWorker();
  return await new Promise<{ indexed: number; removed: number }>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<ScanWorkerResponse>) => {
      const msg = event.data;
      if (msg.type === 'done') {
        resolve({ indexed: msg.indexed, removed: msg.removed });
      } else {
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      // The worker itself may now be dead (e.g. an uncaught exception
      // outside performScan's own try/catch) — drop the cached reference
      // so the next scan spawns a fresh one instead of reusing a broken
      // thread.
      cachedWorker = null;
      reject(new Error(event.message || 'Scan worker crashed'));
    };
    const request: ScanWorkerRequest = {
      type: 'scan',
      dbPath: db.$client.filename,
      folders,
      scanStartMs: scanStart.getTime(),
    };
    worker.postMessage(request);
  });
}

// Holds the most recent request that arrived while a scan was already
// running, so it isn't just dropped (see CHANGELOG: adding a second shared
// folder while an earlier one was still being scanned meant the second
// folder's existing files were never indexed until the next manual rescan
// or periodic tick — periodic rescan is off by default, so in practice
// this could mean "never"). Only the latest request is kept: once the
// in-flight scan finishes, a single follow-up scan with the newest folder
// list covers everything that came in while it was busy.
let queuedRequest: { db: Db; folders: string[] } | null = null;

export async function scanAndIndex(
  db: Db,
  folders: string[],
): Promise<{ indexed: number; removed: number; skipped: boolean }> {
  if (scanning) {
    queuedRequest = { db, folders };
    return { indexed: 0, removed: 0, skipped: true };
  }
  scanning = true;
  try {
    const scanStart = nextScanStart();
    const { indexed, removed } = await runScanInWorker(db, folders, scanStart);
    return { indexed, removed, skipped: false };
  } finally {
    scanning = false;
    if (queuedRequest) {
      const { db: queuedDb, folders: queuedFolders } = queuedRequest;
      queuedRequest = null;
      scanAndIndex(queuedDb, queuedFolders).catch((err) =>
        console.error('Queued rescan failed:', err),
      );
    }
  }
}

export function startPeriodicRescan(
  db: Db,
  getFolders: () => Promise<string[]>,
  getIntervalMinutes: () => Promise<number>,
): () => void {
  let stopped = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  async function tick() {
    if (stopped) return;
    try {
      const folders = await getFolders();
      await scanAndIndex(db, folders);
    } catch (err) {
      console.error('Periodic rescan failed:', err);
    }
    if (!stopped) scheduleNext();
  }

  async function scheduleNext() {
    if (stopped) return;
    let intervalMinutes = 0;
    try {
      intervalMinutes = await getIntervalMinutes();
    } catch (err) {
      console.error('Failed to read rescan interval:', err);
    }
    if (stopped) return;
    if (
      !Number.isFinite(intervalMinutes) ||
      intervalMinutes <= 0 ||
      intervalMinutes > MAX_RESCAN_INTERVAL_MINUTES
    ) {
      timerId = setTimeout(
        () => scheduleNext().catch((err) => console.error('Periodic rescan schedule failed:', err)),
        60_000,
      );
      return;
    }
    timerId = setTimeout(
      () => tick().catch((err) => console.error('Periodic rescan tick failed:', err)),
      intervalMinutes * 60_000,
    );
  }

  tick().catch((err) => console.error('Periodic rescan init failed:', err));

  return () => {
    stopped = true;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };
}
