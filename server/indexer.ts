import { basename, extname, join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
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

export async function scanDirectory(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const fullPath = join(current, entry);
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        await walk(fullPath);
      } else {
        results.push(fullPath);
      }
    }
  }

  await walk(dir);
  return results;
}

export async function indexFile(prisma: PrismaClient, path: string): Promise<SharedFile> {
  const s = await stat(path);
  const size = s.size;
  const fileModifiedAt = new Date(Math.round(s.mtimeMs));

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
  const all = await prisma.sharedFile.findMany({ select: { id: true, path: true } });
  const toDelete = all.filter((f) => !activePaths.has(f.path)).map((f) => f.id);
  if (toDelete.length === 0) return 0;
  const { count } = await prisma.sharedFile.deleteMany({ where: { id: { in: toDelete } } });
  return count;
}

export async function scanAndIndex(
  prisma: PrismaClient,
  folders: string[],
): Promise<{ indexed: number; removed: number }> {
  const allPaths: string[] = [];
  for (const folder of folders) {
    const files = await scanDirectory(folder);
    allPaths.push(...files);
  }

  for (const path of allPaths) {
    try {
      await indexFile(prisma, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  const removed = await removeStaleEntries(prisma, new Set(allPaths));
  return { indexed: allPaths.length, removed };
}

export function startPeriodicRescan(
  prisma: PrismaClient,
  getFolders: () => Promise<string[]>,
  intervalMinutes: number,
): () => void {
  if (intervalMinutes <= 0) return () => {};
  const id = setInterval(() => {
    getFolders()
      .then((folders) => scanAndIndex(prisma, folders))
      .catch((err) => console.error('Periodic rescan failed:', err));
  }, intervalMinutes * 60_000);
  return () => clearInterval(id);
}
