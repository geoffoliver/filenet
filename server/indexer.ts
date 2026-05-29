import { basename, extname, join, sep } from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import type { PrismaClient, SharedFile } from '@prisma/client';
import { parseFile } from 'music-metadata';

const AUDIO_EXTENSIONS = new Set([
  '.aac',
  '.aif',
  '.aiff',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
]);

const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm', '.wmv']);

export async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function extractMetadata(path: string): Promise<Record<string, unknown> | null> {
  const ext = extname(path).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext)) return null;

  try {
    const { common, format } = await parseFile(path);
    const meta: Record<string, unknown> = {};
    if (common.title) meta.title = common.title;
    if (common.artist) meta.artist = common.artist;
    if (common.album) meta.album = common.album;
    if (common.albumartist) meta.albumArtist = common.albumartist;
    if (common.year) meta.year = common.year;
    if (common.track?.no) meta.trackNumber = common.track.no;
    if (common.track?.of) meta.trackTotal = common.track.of;
    if (common.disk?.no) meta.discNumber = common.disk.no;
    if (common.genre?.[0]) meta.genre = common.genre[0];
    if (format.duration) meta.duration = format.duration;
    if (format.bitrate) meta.bitrate = Math.round(format.bitrate / 1000);
    if (format.sampleRate) meta.sampleRate = format.sampleRate;
    if (format.numberOfChannels) meta.channels = format.numberOfChannels;
    return Object.keys(meta).length > 0 ? meta : null;
  } catch {
    return null;
  }
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
        // Can't read metadata — protect both this path and any descendants it may have
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
  prisma: PrismaClient,
  path: string,
  lastSeenAt: Date = new Date(),
): Promise<SharedFile> {
  const s = await lstat(path, { bigint: true });
  if (!s.isFile()) {
    // Path is no longer a regular file (e.g. replaced by a symlink) — treat as gone
    const err = new Error(`not a regular file: ${path}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }
  const size = s.size;
  const fileModifiedAt = new Date(Number(s.mtimeMs));

  // Fast path: if size and mtime match, touch lastSeenAt without re-hashing
  const hit = await prisma.sharedFile.updateMany({
    where: { path, size, fileModifiedAt },
    data: { lastSeenAt },
  });
  if (hit.count > 0) {
    return prisma.sharedFile.findUniqueOrThrow({ where: { path } });
  }

  // File is new or content changed — full re-index
  const sha256 = await hashFile(path);
  const mimeType = Bun.file(path).type || null;
  const metaObj = await extractMetadata(path);
  const metadata = metaObj ? JSON.stringify(metaObj) : null;
  const filename = basename(path);

  return prisma.sharedFile.upsert({
    where: { path },
    create: { path, filename, size, sha256, mimeType, metadata, fileModifiedAt, lastSeenAt },
    update: {
      filename,
      size,
      sha256,
      mimeType,
      metadata,
      fileModifiedAt,
      lastSeenAt,
      indexedAt: new Date(),
    },
  });
}

export async function removeStaleEntries(
  prisma: PrismaClient,
  scanStart: Date,
  protectedRoots: string[] = [],
): Promise<number> {
  const { count } = await prisma.sharedFile.deleteMany({
    where:
      protectedRoots.length === 0
        ? { lastSeenAt: { lt: scanStart } }
        : {
            lastSeenAt: { lt: scanStart },
            NOT: {
              OR: protectedRoots.flatMap((root) => {
                const normalized = root.endsWith(sep) ? root.slice(0, -1) : root;
                return [{ path: normalized }, { path: { startsWith: normalized + sep } }];
              }),
            },
          },
  });
  return count;
}

// 35791 * 60_000 ms = 2_147_460_000 ms, just under setTimeout's 32-bit signed limit (2_147_483_647)
const MAX_RESCAN_INTERVAL_MINUTES = 35791;

let scanning = false;

export async function scanAndIndex(
  prisma: PrismaClient,
  folders: string[],
): Promise<{ indexed: number; removed: number; skipped: boolean }> {
  if (scanning) return { indexed: 0, removed: 0, skipped: true };
  scanning = true;
  try {
    const scanStart = new Date();
    const seen = new Set<string>();
    let indexed = 0;
    const inaccessibleRoots: string[] = [];

    for (const folder of folders) {
      try {
        const folderStat = await lstat(folder);
        if (!folderStat.isDirectory()) {
          // Regular file, symlink, or other non-directory — preserve its entries
          inaccessibleRoots.push(folder);
          continue;
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
          // Folder is unavailable — preserve its indexed entries
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
            await indexFile(prisma, path, scanStart);
            indexed++;
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              // File vanished between discovery and indexing — treat as stale
            } else if (code === 'EACCES' || code === 'ENOTDIR') {
              // Temporarily unreadable — preserve the existing record
              inaccessibleRoots.push(path);
            } else {
              throw err;
            }
          }
        }
        // Protect files in subdirectories that became unreadable during the scan
        for (const dir of inaccessibleSubDirs) {
          inaccessibleRoots.push(dir);
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
          // Root became unreadable after lstat passed — preserve its indexed entries
          inaccessibleRoots.push(folder);
        } else {
          throw err;
        }
      }
    }

    const removed = await removeStaleEntries(prisma, scanStart, inaccessibleRoots);
    return { indexed, removed, skipped: false };
  } finally {
    scanning = false;
  }
}

export function startPeriodicRescan(
  prisma: PrismaClient,
  getFolders: () => Promise<string[]>,
  getIntervalMinutes: () => Promise<number>,
): () => void {
  let stopped = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  async function tick() {
    if (stopped) return;
    try {
      const folders = await getFolders();
      await scanAndIndex(prisma, folders);
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
      // Fall through with intervalMinutes = 0, scheduling a retry below
    }
    if (stopped) return;
    if (
      !Number.isFinite(intervalMinutes) ||
      intervalMinutes <= 0 ||
      intervalMinutes > MAX_RESCAN_INTERVAL_MINUTES
    ) {
      // Disabled, invalid, or would overflow setTimeout's 32-bit ms limit — re-check in 1 minute
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
