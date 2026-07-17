import { basename, join, sep } from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';

import type { Changes } from 'bun:sqlite';

import { SQL, and, eq, lt, or, sql } from 'drizzle-orm';

import type { Db } from './db';
import type { SharedFile } from './schema';
import { extractMetadata } from './metadata';
import { sharedFiles } from './schema';

export async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

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
  const sha256 = await hashFile(path);
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

export async function scanAndIndex(
  db: Db,
  folders: string[],
): Promise<{ indexed: number; removed: number; skipped: boolean }> {
  if (scanning) return { indexed: 0, removed: 0, skipped: true };
  scanning = true;
  try {
    const scanStart = nextScanStart();
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

      try {
        for await (const path of scanDirectory(folder, true, inaccessibleSubDirs)) {
          if (seen.has(path)) continue;
          seen.add(path);
          try {
            await indexFile(db, path, scanStart);
            indexed++;
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              // File vanished between discovery and indexing — treat as stale
            } else if (code === 'EACCES' || code === 'ENOTDIR') {
              inaccessibleRoots.push(path);
            } else {
              throw err;
            }
          }
        }
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
    return { indexed, removed, skipped: false };
  } finally {
    scanning = false;
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
