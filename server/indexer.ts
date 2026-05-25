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

const STALE_DELETE_CHUNK = 500;

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

export async function scanDirectory(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const fullPath = join(current, entry);
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
        await walk(fullPath);
      } else if (s.isFile()) {
        results.push(fullPath);
      }
    }
  }

  await walk(dir);
  return results;
}

export async function indexFile(prisma: PrismaClient, path: string): Promise<SharedFile> {
  const s = await stat(path, { bigint: true });
  const size = s.size;
  const fileModifiedAt = new Date(Number(s.mtimeMs));

  const existing = await prisma.sharedFile.findUnique({ where: { path } });
  if (
    existing &&
    existing.size === size &&
    existing.fileModifiedAt?.getTime() === fileModifiedAt.getTime()
  ) {
    return existing;
  }

  const sha256 = await hashFile(path);
  const mimeType = Bun.file(path).type || null;
  const metaObj = await extractMetadata(path);
  const metadata = metaObj ? JSON.stringify(metaObj) : null;
  const filename = basename(path);

  return prisma.sharedFile.upsert({
    where: { path },
    create: { path, filename, size, sha256, mimeType, metadata, fileModifiedAt },
    update: { filename, size, sha256, mimeType, metadata, fileModifiedAt },
  });
}

export async function removeStaleEntries(
  prisma: PrismaClient,
  activePaths: Set<string>,
): Promise<number> {
  let removed = 0;
  let lastPath: string | undefined;

  for (;;) {
    const page = await prisma.sharedFile.findMany({
      select: { path: true },
      take: STALE_DELETE_CHUNK,
      where: lastPath !== undefined ? { path: { gt: lastPath } } : undefined,
      orderBy: { path: 'asc' },
    });

    if (page.length === 0) break;
    lastPath = page[page.length - 1].path;

    const stale = page.filter((f) => !activePaths.has(f.path)).map((f) => f.path);
    if (stale.length > 0) {
      const { count } = await prisma.sharedFile.deleteMany({
        where: { path: { in: stale } },
      });
      removed += count;
    }

    if (page.length < STALE_DELETE_CHUNK) break;
  }

  return removed;
}

export async function scanAndIndex(
  prisma: PrismaClient,
  folders: string[],
): Promise<{ indexed: number; removed: number }> {
  const activePaths = new Set<string>();
  for (const folder of folders) {
    for (const p of await scanDirectory(folder)) activePaths.add(p);
  }

  let indexed = 0;
  for (const path of activePaths) {
    try {
      await indexFile(prisma, path);
      indexed++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EACCES') throw err;
    }
  }

  const removed = await removeStaleEntries(prisma, activePaths);
  return { indexed, removed };
}

export function startPeriodicRescan(
  prisma: PrismaClient,
  getFolders: () => Promise<string[]>,
  intervalMinutes: number,
): () => void {
  if (intervalMinutes <= 0) return () => {};
  let running = false;
  const id = setInterval(() => {
    if (running) return;
    running = true;
    getFolders()
      .then((folders) => scanAndIndex(prisma, folders))
      .catch((err) => console.error('Periodic rescan failed:', err))
      .finally(() => {
        running = false;
      });
  }, intervalMinutes * 60_000);
  return () => clearInterval(id);
}
