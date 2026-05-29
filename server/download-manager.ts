import { basename, extname, join } from 'node:path';
import { open, rename, rm, truncate } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import type { PrismaClient } from '@prisma/client';

import { CHUNK_SIZE, requestChunk } from './transfer-protocol';
import { getConnectedPeer } from './connections';
import { hashFile } from './indexer';

export type RequestChunkFn = (
  nodeId: string,
  sha256: string,
  offset: number,
  length: number,
) => Promise<Buffer>;

const defaultRequestChunk: RequestChunkFn = (nodeId, sha256, offset, length) => {
  const peer = getConnectedPeer(nodeId);
  if (!peer) throw new Error(`Peer ${nodeId} not connected`);
  return requestChunk(peer, sha256, offset, length);
};

export type StartDownloadOpts = {
  sha256: string;
  filename: string;
  size: bigint;
  mimeType: string | null | undefined;
  sources: string[]; // nodeIds
  downloadFolder: string;
};

export type TransferDto = {
  id: string;
  sha256: string;
  filename: string;
  size: string;
  mimeType: string | null;
  state: string;
  bytesReceived: string;
  progress: number;
  speedBps: number;
  etaSeconds: number | null;
  sources: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

const MAX_CONCURRENT_CHUNKS = 4;
const SPEED_WINDOW_MS = 5_000;

// ---------------------------------------------------------------------------
// In-memory active download state
// ---------------------------------------------------------------------------

type SpeedSample = { time: number; bytes: number };

type ActiveDownload = {
  id: string;
  sha256: string;
  size: bigint;
  chunkSize: number;
  totalChunks: number;
  completedChunks: Set<number>;
  inFlight: Set<number>;
  sources: string[];
  fileHandle: FileHandle | null;
  tmpPath: string;
  paused: boolean;
  stopped: boolean;
  speedSamples: SpeedSample[];
};

const activeDownloads = new Map<string, ActiveDownload>();

// ---------------------------------------------------------------------------
// Speed / ETA helpers
// ---------------------------------------------------------------------------

function recordBytes(dl: ActiveDownload, bytes: number): void {
  const now = Date.now();
  dl.speedSamples.push({ time: now, bytes });
  const cutoff = now - SPEED_WINDOW_MS;
  while (dl.speedSamples.length > 0 && dl.speedSamples[0].time < cutoff) {
    dl.speedSamples.shift();
  }
}

function calcSpeed(dl: ActiveDownload): number {
  if (dl.speedSamples.length === 0) return 0;
  const windowMs = Date.now() - dl.speedSamples[0].time;
  if (windowMs < 100) return 0;
  const totalBytes = dl.speedSamples.reduce((s, r) => s + r.bytes, 0);
  return Math.round((totalBytes / windowMs) * 1000);
}

// ---------------------------------------------------------------------------
// Unique filename resolution
// ---------------------------------------------------------------------------

async function uniqueFilePath(folder: string, filename: string): Promise<string> {
  const candidate = join(folder, filename);
  if (!existsSync(candidate)) return candidate;

  const ext = extname(filename);
  const base = basename(filename, ext);
  for (let i = 1; i < 10_000; i++) {
    const next = join(folder, `${base} (${i})${ext}`);
    if (!existsSync(next)) return next;
  }
  return join(folder, `${base}-${randomUUID()}${ext}`);
}

// ---------------------------------------------------------------------------
// Core pump loop
// ---------------------------------------------------------------------------

async function downloadChunk(
  prisma: PrismaClient,
  dl: ActiveDownload,
  chunkIndex: number,
  requestChunkFn: RequestChunkFn,
): Promise<void> {
  const offset = chunkIndex * dl.chunkSize;
  const length = Math.min(dl.chunkSize, Number(dl.size) - offset);

  // Try each source in order until one succeeds
  for (const nodeId of dl.sources) {
    if (dl.stopped || dl.paused) return;

    try {
      const data = await requestChunkFn(nodeId, dl.sha256, offset, length);

      if (dl.stopped) return;

      // Write chunk at the correct offset
      if (dl.fileHandle) {
        await dl.fileHandle.write(data, 0, data.length, offset);
      }

      dl.completedChunks.add(chunkIndex);
      dl.inFlight.delete(chunkIndex);
      recordBytes(dl, data.length);

      await prisma.download.update({
        where: { id: dl.id },
        data: {
          bytesReceived: BigInt(dl.completedChunks.size * dl.chunkSize),
          completedChunks: JSON.stringify([...dl.completedChunks]),
        },
      });
      return;
    } catch {
      // Try next source
      continue;
    }
  }

  // All sources failed for this chunk
  dl.inFlight.delete(chunkIndex);
  if (!dl.stopped) {
    await failDownload(prisma, dl, 'All sources failed to serve chunk');
  }
}

async function pump(
  prisma: PrismaClient,
  dl: ActiveDownload,
  requestChunkFn: RequestChunkFn,
): Promise<void> {
  if (dl.paused || dl.stopped) return;

  // Collect chunks still needed
  const pending: number[] = [];
  for (let i = 0; i < dl.totalChunks; i++) {
    if (!dl.completedChunks.has(i) && !dl.inFlight.has(i)) {
      pending.push(i);
    }
  }

  if (pending.length === 0 && dl.inFlight.size === 0) {
    await finalizeDownload(prisma, dl);
    return;
  }

  const slots = MAX_CONCURRENT_CHUNKS - dl.inFlight.size;
  const toStart = pending.slice(0, slots);

  for (const chunkIndex of toStart) {
    dl.inFlight.add(chunkIndex);
    downloadChunk(prisma, dl, chunkIndex, requestChunkFn)
      .then(() => pump(prisma, dl, requestChunkFn))
      .catch((err: unknown) => console.error('Chunk error:', err));
  }
}

// ---------------------------------------------------------------------------
// Finalize / fail
// ---------------------------------------------------------------------------

async function finalizeDownload(prisma: PrismaClient, dl: ActiveDownload): Promise<void> {
  dl.stopped = true;

  if (dl.fileHandle) {
    try {
      await dl.fileHandle.close();
    } catch {}
    dl.fileHandle = null;
  }

  // SHA-256 verify
  let actualHash: string;
  try {
    actualHash = await hashFile(dl.tmpPath);
  } catch {
    await failDownload(prisma, dl, 'Could not read temp file for verification');
    return;
  }

  if (actualHash !== dl.sha256) {
    try {
      await rm(dl.tmpPath, { force: true });
    } catch {}
    await prisma.download.update({
      where: { id: dl.id },
      data: { state: 'FAILED', error: 'SHA-256 verification failed' },
    });
    activeDownloads.delete(dl.id);
    return;
  }

  // Find a non-colliding final path
  const record = await prisma.download.findUniqueOrThrow({ where: { id: dl.id } });
  const downloadFolder = activeDownloadFolders.get(dl.id) ?? tmpdir();
  const finalPath = await uniqueFilePath(downloadFolder, record.filename);

  try {
    await rename(dl.tmpPath, finalPath);
  } catch {
    await failDownload(prisma, dl, 'Could not move file to download folder');
    return;
  }

  await prisma.download.update({
    where: { id: dl.id },
    data: {
      state: 'COMPLETED',
      finalPath,
      completedAt: new Date(),
      bytesReceived: dl.size,
      tmpPath: null,
    },
  });
  activeDownloads.delete(dl.id);
  activeDownloadFolders.delete(dl.id);
}

async function failDownload(
  prisma: PrismaClient,
  dl: ActiveDownload,
  error: string,
): Promise<void> {
  dl.stopped = true;
  if (dl.fileHandle) {
    try {
      await dl.fileHandle.close();
    } catch {}
    dl.fileHandle = null;
  }
  try {
    await rm(dl.tmpPath, { force: true });
  } catch {}
  await prisma.download.update({
    where: { id: dl.id },
    data: { state: 'FAILED', error },
  });
  activeDownloads.delete(dl.id);
  activeDownloadFolders.delete(dl.id);
}

// Separate map to avoid storing downloadFolder inside the struct redundantly
const activeDownloadFolders = new Map<string, string>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startDownload(
  prisma: PrismaClient,
  opts: StartDownloadOpts,
  requestChunkFn: RequestChunkFn = defaultRequestChunk,
): Promise<string> {
  const { sha256, filename, size, mimeType, sources, downloadFolder } = opts;
  const chunkSize = CHUNK_SIZE;
  const totalChunks = Math.ceil(Number(size) / chunkSize);

  const tmpPath = join(tmpdir(), `.filenet-dl-${randomUUID()}.tmp`);

  const record = await prisma.download.create({
    data: {
      sha256,
      filename,
      size,
      mimeType: mimeType ?? null,
      state: 'DOWNLOADING',
      chunkSize,
      sources: JSON.stringify(sources),
      tmpPath,
    },
  });

  // Pre-allocate temp file
  const fh = await open(tmpPath, 'w');
  if (Number(size) > 0) {
    await truncate(tmpPath, Number(size));
  }
  // Re-open for random-access writing
  await fh.close();
  const fileHandle = await open(tmpPath, 'r+');

  const dl: ActiveDownload = {
    id: record.id,
    sha256,
    size,
    chunkSize,
    totalChunks,
    completedChunks: new Set(),
    inFlight: new Set(),
    sources,
    fileHandle,
    tmpPath,
    paused: false,
    stopped: false,
    speedSamples: [],
  };

  activeDownloads.set(record.id, dl);
  activeDownloadFolders.set(record.id, downloadFolder);

  // Start pumping asynchronously
  pump(prisma, dl, requestChunkFn).catch((err: unknown) =>
    console.error('Download pump error:', err),
  );

  return record.id;
}

export async function pauseDownload(prisma: PrismaClient, id: string): Promise<boolean> {
  const dl = activeDownloads.get(id);
  if (!dl || dl.stopped) return false;
  dl.paused = true;
  await prisma.download.update({ where: { id }, data: { state: 'PAUSED' } });
  return true;
}

export async function resumeDownload(
  prisma: PrismaClient,
  id: string,
  requestChunkFn: RequestChunkFn = defaultRequestChunk,
): Promise<boolean> {
  const record = await prisma.download.findUnique({ where: { id } });
  if (!record || record.state !== 'PAUSED') return false;

  let dl = activeDownloads.get(id);

  if (!dl) {
    // Rebuild in-memory state from DB record (e.g. after restart)
    const completedChunks: number[] = JSON.parse(record.completedChunks);
    const sources: string[] = JSON.parse(record.sources);
    const chunkSize = record.chunkSize;
    const totalChunks = Math.ceil(Number(record.size) / chunkSize);
    const tmpPath = record.tmpPath ?? join(tmpdir(), `.filenet-dl-${id}.tmp`);

    const fileHandle = await open(tmpPath, 'r+').catch(async () => {
      // Temp file gone — recreate it
      const fh2 = await open(tmpPath, 'w');
      await truncate(tmpPath, Number(record.size));
      await fh2.close();
      return open(tmpPath, 'r+');
    });

    dl = {
      id,
      sha256: record.sha256,
      size: record.size,
      chunkSize,
      totalChunks,
      completedChunks: new Set(completedChunks),
      inFlight: new Set(),
      sources,
      fileHandle,
      tmpPath,
      paused: false,
      stopped: false,
      speedSamples: [],
    };
    activeDownloads.set(id, dl);
  }

  dl.paused = false;
  await prisma.download.update({
    where: { id },
    data: { state: 'DOWNLOADING', tmpPath: dl.tmpPath },
  });

  pump(prisma, dl, requestChunkFn).catch((err: unknown) =>
    console.error('Resume pump error:', err),
  );
  return true;
}

export async function cancelDownload(prisma: PrismaClient, id: string): Promise<boolean> {
  const dl = activeDownloads.get(id);
  const record = await prisma.download.findUnique({ where: { id } });
  if (!record || record.state === 'COMPLETED') return false;

  if (dl) {
    dl.stopped = true;
    if (dl.fileHandle) {
      try {
        await dl.fileHandle.close();
      } catch {}
      dl.fileHandle = null;
    }
    try {
      await rm(dl.tmpPath, { force: true });
    } catch {}
    activeDownloads.delete(id);
    activeDownloadFolders.delete(id);
  } else if (record.tmpPath) {
    try {
      await rm(record.tmpPath, { force: true });
    } catch {}
  }

  await prisma.download.update({
    where: { id },
    data: { state: 'CANCELLED', tmpPath: null },
  });
  return true;
}

export async function getTransfers(prisma: PrismaClient): Promise<TransferDto[]> {
  const records = await prisma.download.findMany({ orderBy: { createdAt: 'desc' } });
  return records.map((r) => {
    const dl = activeDownloads.get(r.id);
    const speedBps = dl ? calcSpeed(dl) : 0;
    const bytesRemaining = Number(r.size) - Number(r.bytesReceived);
    const etaSeconds =
      speedBps > 0 && bytesRemaining > 0 ? Math.ceil(bytesRemaining / speedBps) : null;
    const progress = Number(r.size) > 0 ? Number(r.bytesReceived) / Number(r.size) : 0;

    return {
      id: r.id,
      sha256: r.sha256,
      filename: r.filename,
      size: String(r.size),
      mimeType: r.mimeType,
      state: r.state,
      bytesReceived: String(r.bytesReceived),
      progress,
      speedBps,
      etaSeconds,
      sources: dl ? dl.sources.length : 0,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    };
  });
}
