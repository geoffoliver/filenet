import { basename, extname, join } from 'node:path';
import { lstat, readdir, stat } from 'node:fs/promises';
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

export async function* scanDirectory(dir: string): AsyncGenerator<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') return;
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
      if (code === 'ENOENT' || code === 'EACCES') continue;
      throw err;
    }
    if (s.isSymbolicLink()) continue;
    if (s.isDirectory()) {
      yield* scanDirectory(fullPath);
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
  const s = await stat(path, { bigint: true });
  const size = s.size;
  const fileModifiedAt = new Date(Number(s.mtimeMs));

  const existing = await prisma.sharedFile.findUnique({ where: { path } });
  if (
    existing &&
    existing.size === size &&
    existing.fileModifiedAt?.getTime() === fileModifiedAt.getTime()
  ) {
    return prisma.sharedFile.update({ where: { path }, data: { lastSeenAt } });
  }

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

export async function removeStaleEntries(prisma: PrismaClient, scanStart: Date): Promise<number> {
  const { count } = await prisma.sharedFile.deleteMany({
    where: { lastSeenAt: { lt: scanStart } },
  });
  return count;
}

let scanning = false;

export async function scanAndIndex(
  prisma: PrismaClient,
  folders: string[],
): Promise<{ indexed: number; removed: number }> {
  if (scanning) return { indexed: 0, removed: 0 };
  scanning = true;
  try {
    const scanStart = new Date();
    const seen = new Set<string>();
    let indexed = 0;

    for (const folder of folders) {
      for await (const path of scanDirectory(folder)) {
        if (seen.has(path)) continue;
        seen.add(path);
        try {
          await indexFile(prisma, path, scanStart);
          indexed++;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'EACCES') throw err;
        }
      }
    }

    const removed = await removeStaleEntries(prisma, scanStart);
    return { indexed, removed };
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
    const folders = await getFolders();
    try {
      await scanAndIndex(prisma, folders);
    } catch (err) {
      console.error('Periodic rescan failed:', err);
    }
    if (!stopped) scheduleNext();
  }

  async function scheduleNext() {
    if (stopped) return;
    try {
      const intervalMinutes = await getIntervalMinutes();
      if (intervalMinutes <= 0 || stopped) return;
      timerId = setTimeout(
        () => tick().catch((err) => console.error('Periodic rescan tick failed:', err)),
        intervalMinutes * 60_000,
      );
    } catch (err) {
      console.error('Failed to read rescan interval:', err);
    }
  }

  scheduleNext().catch((err) => console.error('Periodic rescan init failed:', err));

  return () => {
    stopped = true;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };
}
