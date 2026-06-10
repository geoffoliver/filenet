import { basename, extname, join } from 'node:path';
import { copyFile, open, rename, rm, truncate } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import type { PrismaClient } from '@prisma/client';

import { CHUNK_SIZE, requestChunk } from './transfer-protocol';
import { getConnectedPeer } from './connections';
import { hashFile } from './indexer';
import { runPostDownloadScripts } from './scripts';

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
  startedAt: Date;
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
  let safe = basename(filename); // strip directory components to prevent path traversal
  // basename returns '.' or '..' for those inputs and '' for an empty/root path —
  // all resolve outside the download folder via join(), so fall back to a safe name.
  if (safe === '' || safe === '.' || safe === '..') safe = 'download';

  const tryReserve = async (p: string): Promise<boolean> => {
    try {
      const fh = await open(p, 'wx'); // exclusive create — fails with EEXIST if taken
      await fh.close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  };

  const candidate = join(folder, safe);
  if (await tryReserve(candidate)) return candidate;

  const ext = extname(safe);
  const base = basename(safe, ext);
  for (let i = 1; i < 10_000; i++) {
    const next = join(folder, `${base} (${i})${ext}`);
    if (await tryReserve(next)) return next;
  }
  const fallback = join(folder, `${base}-${randomUUID()}${ext}`);
  const fh = await open(fallback, 'wx');
  await fh.close();
  return fallback;
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
    if (dl.stopped || dl.paused) {
      dl.inFlight.delete(chunkIndex);
      return;
    }

    try {
      const data = await requestChunkFn(nodeId, dl.sha256, offset, length);

      if (data.length !== length) {
        throw new Error(`Unexpected chunk size: expected ${length}, got ${data.length}`);
      }

      if (dl.stopped || dl.paused) {
        dl.inFlight.delete(chunkIndex);
        return;
      }

      // Write chunk at the correct offset
      if (dl.fileHandle) {
        await dl.fileHandle.write(data, 0, data.length, offset);
      }

      dl.completedChunks.add(chunkIndex);
      dl.inFlight.delete(chunkIndex);
      recordBytes(dl, data.length);

      const lastIdx = dl.totalChunks - 1;
      const lastChunkActualSize = Number(dl.size) - lastIdx * dl.chunkSize;
      const bytesReceived =
        dl.completedChunks.size * dl.chunkSize -
        (dl.completedChunks.has(lastIdx) ? dl.chunkSize - lastChunkActualSize : 0);
      await prisma.download.update({
        where: { id: dl.id },
        data: {
          bytesReceived: BigInt(bytesReceived),
          completedChunks: JSON.stringify([...dl.completedChunks]),
        },
      });
      return;
    } catch {
      if (dl.stopped || dl.paused) {
        dl.inFlight.delete(chunkIndex);
        return;
      }
      // Try next source
      continue;
    }
  }

  // All sources failed for this chunk
  dl.inFlight.delete(chunkIndex);
  if (!dl.stopped && !dl.paused) {
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
  const downloadFolder = activeDownloadFolders.get(dl.id) ?? record.downloadFolder ?? tmpdir();
  let finalPath: string;
  try {
    finalPath = await uniqueFilePath(downloadFolder, record.filename);
  } catch {
    await failDownload(prisma, dl, 'Could not create file in download folder');
    return;
  }

  try {
    await rename(dl.tmpPath, finalPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      // Cross-device move: copy over the reserved placeholder, then remove the temp file.
      try {
        await copyFile(dl.tmpPath, finalPath);
        await rm(dl.tmpPath, { force: true });
      } catch {
        try {
          await rm(finalPath, { force: true });
        } catch {}
        await failDownload(prisma, dl, 'Could not move file to download folder');
        return;
      }
    } else {
      // rename failed for another reason — remove the placeholder we reserved.
      try {
        await rm(finalPath, { force: true });
      } catch {}
      await failDownload(prisma, dl, 'Could not move file to download folder');
      return;
    }
  }

  const completedAt = new Date();
  await prisma.download.update({
    where: { id: dl.id },
    data: {
      state: 'COMPLETED',
      finalPath,
      completedAt,
      bytesReceived: dl.size,
      tmpPath: null,
    },
  });
  activeDownloads.delete(dl.id);
  activeDownloadFolders.delete(dl.id);

  // Increment per-friend download counters. Failures here are non-fatal —
  // a transient DB error must not prevent post-download scripts from running.
  const uniqueSources = [...new Set(dl.sources)];
  if (uniqueSources.length > 0) {
    await prisma.friend
      .updateMany({
        where: { nodeId: { in: uniqueSources }, status: 'ACCEPTED' },
        data: { downloadCount: { increment: 1 }, downloadTotalBytes: { increment: dl.size } },
      })
      .catch((err: unknown) => console.error('Failed to update friend download counters:', err));
  }

  runPostDownloadScripts(prisma, finalPath, {
    downloadId: dl.id,
    filename: record.filename,
    sha256: dl.sha256,
    size: dl.size,
    mimeType: record.mimeType,
    durationMs: completedAt.getTime() - dl.startedAt.getTime(),
    bytesReceived: dl.size,
    maxSources: dl.sources.length,
    startedAt: dl.startedAt,
    completedAt,
  }).catch((err: unknown) => console.error('Post-download scripts error:', err));
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

  let fileHandle: FileHandle | null = null;
  let record: Awaited<ReturnType<typeof prisma.download.create>>;
  try {
    // Pre-allocate temp file before creating the DB record so a disk/permission
    // error here never leaves a stranded DOWNLOADING row.
    const fh = await open(tmpPath, 'w');
    try {
      if (Number(size) > 0) {
        await truncate(tmpPath, Number(size));
      }
    } finally {
      await fh.close();
    }
    fileHandle = await open(tmpPath, 'r+');

    record = await prisma.download.create({
      data: {
        sha256,
        filename,
        size,
        mimeType: mimeType ?? null,
        state: 'DOWNLOADING',
        chunkSize,
        sources: JSON.stringify(sources),
        tmpPath,
        downloadFolder,
      },
    });
  } catch (err) {
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch {}
    }
    try {
      await rm(tmpPath, { force: true });
    } catch {}
    throw err;
  }

  const dl: ActiveDownload = {
    id: record.id,
    sha256,
    size,
    chunkSize,
    totalChunks,
    completedChunks: new Set(),
    inFlight: new Set(),
    sources,
    fileHandle: fileHandle!,
    tmpPath,
    paused: false,
    stopped: false,
    speedSamples: [],
    startedAt: record.createdAt,
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
  await prisma.download.update({ where: { id }, data: { state: 'PAUSED' } });
  dl.paused = true;
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

    let fileHandle: FileHandle;
    try {
      fileHandle = await open(tmpPath, 'r+');
    } catch {
      // Temp file gone — recreate it and restart all chunks to avoid zero-fill corruption
      completedChunks.splice(0);
      await prisma.download.update({
        where: { id },
        data: { completedChunks: '[]', bytesReceived: 0n },
      });
      const fh2 = await open(tmpPath, 'w');
      try {
        await truncate(tmpPath, Number(record.size));
      } finally {
        await fh2.close();
      }
      fileHandle = await open(tmpPath, 'r+');
    }

    if (record.downloadFolder) {
      activeDownloadFolders.set(id, record.downloadFolder);
    }

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
      startedAt: record.createdAt,
    };
    activeDownloads.set(id, dl);
  }

  // Conditional update: only flip to DOWNLOADING if the record is still PAUSED.
  // This guards against two races:
  //   1. A concurrent cancel changed state to CANCELLED — temp file may be gone.
  //   2. A concurrent resumeDownload already flipped state to DOWNLOADING — the
  //      pump is already running and we must not tear it down.
  const updated = await prisma.download.updateMany({
    where: { id, state: 'PAUSED' },
    data: { state: 'DOWNLOADING', tmpPath: dl.tmpPath },
  });
  if (updated.count === 0) {
    // Only clean up the in-memory state we just rebuilt when the record is
    // truly gone or in a terminal state (CANCELLED/FAILED). If another resume
    // already started the pump (state=DOWNLOADING), leave that pump running.
    const current = await prisma.download.findUnique({ where: { id } });
    if (!current || current.state === 'CANCELLED' || current.state === 'FAILED') {
      dl.stopped = true;
      if (dl.fileHandle) {
        try {
          await dl.fileHandle.close();
        } catch {}
      }
      activeDownloads.delete(id);
      activeDownloadFolders.delete(id);
    }
    return false;
  }
  dl.paused = false;

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

  // Conditional update: do not overwrite a COMPLETED or already-CANCELLED record that
  // raced us to the finish line between our initial DB read and now.
  await prisma.download.updateMany({
    where: { id, state: { notIn: ['COMPLETED', 'CANCELLED'] } },
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
      sources: dl
        ? dl.sources.length
        : (() => {
            try {
              return (JSON.parse(r.sources) as string[]).length;
            } catch {
              return 0;
            }
          })(),
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    };
  });
}

export async function pauseAllActiveDownloads(prisma: PrismaClient): Promise<void> {
  const ids = [...activeDownloads.keys()];
  await Promise.all(
    ids.map(async (id) => {
      const dl = activeDownloads.get(id);
      if (!dl) return;
      dl.stopped = true;
      if (dl.fileHandle) {
        try {
          await dl.fileHandle.close();
        } catch {}
        dl.fileHandle = null;
      }
      activeDownloads.delete(id);
      activeDownloadFolders.delete(id);
      await prisma.download.update({ where: { id }, data: { state: 'PAUSED' } }).catch(() => {});
    }),
  );
}
