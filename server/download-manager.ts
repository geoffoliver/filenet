import { basename, extname, join } from 'node:path';
import { copyFile, open, rename, rm, truncate } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';

import { CHUNK_SIZE, requestChunk } from './transfer-protocol';
import { downloads, friends } from './schema';
import type { Db } from './db';
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
  let safe = basename(filename);
  if (safe === '' || safe === '.' || safe === '..') safe = 'download';

  const tryReserve = async (p: string): Promise<boolean> => {
    try {
      const fh = await open(p, 'wx');
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
  db: Db,
  dl: ActiveDownload,
  chunkIndex: number,
  requestChunkFn: RequestChunkFn,
): Promise<void> {
  const offset = chunkIndex * dl.chunkSize;
  const length = Math.min(dl.chunkSize, Number(dl.size) - offset);

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
      db.update(downloads)
        .set({
          bytesReceived: BigInt(bytesReceived),
          completedChunks: JSON.stringify([...dl.completedChunks]),
          updatedAt: new Date(),
        })
        .where(eq(downloads.id, dl.id))
        .run();
      return;
    } catch {
      if (dl.stopped || dl.paused) {
        dl.inFlight.delete(chunkIndex);
        return;
      }
      continue;
    }
  }

  dl.inFlight.delete(chunkIndex);
  if (!dl.stopped && !dl.paused) {
    await failDownload(db, dl, 'All sources failed to serve chunk');
  }
}

async function pump(db: Db, dl: ActiveDownload, requestChunkFn: RequestChunkFn): Promise<void> {
  if (dl.paused || dl.stopped) return;

  const pending: number[] = [];
  for (let i = 0; i < dl.totalChunks; i++) {
    if (!dl.completedChunks.has(i) && !dl.inFlight.has(i)) {
      pending.push(i);
    }
  }

  if (pending.length === 0 && dl.inFlight.size === 0) {
    await finalizeDownload(db, dl);
    return;
  }

  const slots = MAX_CONCURRENT_CHUNKS - dl.inFlight.size;
  const toStart = pending.slice(0, slots);

  for (const chunkIndex of toStart) {
    dl.inFlight.add(chunkIndex);
    downloadChunk(db, dl, chunkIndex, requestChunkFn)
      .then(() => pump(db, dl, requestChunkFn))
      .catch((err: unknown) => console.error('Chunk error:', err));
  }
}

// ---------------------------------------------------------------------------
// Finalize / fail
// ---------------------------------------------------------------------------

async function finalizeDownload(db: Db, dl: ActiveDownload): Promise<void> {
  dl.stopped = true;

  if (dl.fileHandle) {
    try {
      await dl.fileHandle.close();
    } catch {}
    dl.fileHandle = null;
  }

  let actualHash: string;
  try {
    actualHash = await hashFile(dl.tmpPath);
  } catch {
    await failDownload(db, dl, 'Could not read temp file for verification');
    return;
  }

  if (actualHash !== dl.sha256) {
    try {
      await rm(dl.tmpPath, { force: true });
    } catch {}
    db.update(downloads)
      .set({ state: 'FAILED', error: 'SHA-256 verification failed', updatedAt: new Date() })
      .where(eq(downloads.id, dl.id))
      .run();
    activeDownloads.delete(dl.id);
    return;
  }

  const record = db.select().from(downloads).where(eq(downloads.id, dl.id)).get();
  if (!record) throw new Error(`Download ${dl.id} not found`);
  const downloadFolder = activeDownloadFolders.get(dl.id) ?? record.downloadFolder ?? tmpdir();
  let finalPath: string;
  try {
    finalPath = await uniqueFilePath(downloadFolder, record.filename);
  } catch {
    await failDownload(db, dl, 'Could not create file in download folder');
    return;
  }

  try {
    await rename(dl.tmpPath, finalPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      try {
        await copyFile(dl.tmpPath, finalPath);
        await rm(dl.tmpPath, { force: true });
      } catch {
        try {
          await rm(finalPath, { force: true });
        } catch {}
        await failDownload(db, dl, 'Could not move file to download folder');
        return;
      }
    } else {
      try {
        await rm(finalPath, { force: true });
      } catch {}
      await failDownload(db, dl, 'Could not move file to download folder');
      return;
    }
  }

  const completedAt = new Date();
  db.update(downloads)
    .set({
      state: 'COMPLETED',
      finalPath,
      completedAt,
      bytesReceived: dl.size,
      tmpPath: null,
      updatedAt: completedAt,
    })
    .where(eq(downloads.id, dl.id))
    .run();
  activeDownloads.delete(dl.id);
  activeDownloadFolders.delete(dl.id);

  // Increment per-friend download counters (non-fatal).
  const uniqueSources = [...new Set(dl.sources)];
  if (uniqueSources.length > 0) {
    try {
      db.update(friends)
        .set({
          downloadCount: sql`${friends.downloadCount} + 1`,
          downloadTotalBytes: sql`${friends.downloadTotalBytes} + ${dl.size}`,
          updatedAt: new Date(),
        })
        .where(and(inArray(friends.nodeId, uniqueSources), eq(friends.status, 'ACCEPTED')))
        .run();
    } catch (err: unknown) {
      console.error('Failed to update friend download counters:', err);
    }
  }

  runPostDownloadScripts(db, finalPath, {
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

async function failDownload(db: Db, dl: ActiveDownload, error: string): Promise<void> {
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
  db.update(downloads)
    .set({ state: 'FAILED', error, updatedAt: new Date() })
    .where(eq(downloads.id, dl.id))
    .run();
  activeDownloads.delete(dl.id);
  activeDownloadFolders.delete(dl.id);
}

const activeDownloadFolders = new Map<string, string>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startDownload(
  db: Db,
  opts: StartDownloadOpts,
  requestChunkFn: RequestChunkFn = defaultRequestChunk,
): Promise<string> {
  const { sha256, filename, size, mimeType, sources, downloadFolder } = opts;
  const chunkSize = CHUNK_SIZE;
  const totalChunks = Math.ceil(Number(size) / chunkSize);
  const tmpPath = join(tmpdir(), `.filenet-dl-${randomUUID()}.tmp`);

  let fileHandle: FileHandle | null = null;
  let record: typeof downloads.$inferSelect;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      if (Number(size) > 0) await truncate(tmpPath, Number(size));
    } finally {
      await fh.close();
    }
    fileHandle = await open(tmpPath, 'r+');

    const now = new Date();
    const inserted = db
      .insert(downloads)
      .values({
        id: randomUUID(),
        sha256,
        filename,
        size,
        mimeType: mimeType ?? null,
        state: 'DOWNLOADING',
        chunkSize,
        sources: JSON.stringify(sources),
        tmpPath,
        downloadFolder,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    record = inserted!;
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
    startedAt: record.createdAt!,
  };

  activeDownloads.set(record.id, dl);
  activeDownloadFolders.set(record.id, downloadFolder);

  pump(db, dl, requestChunkFn).catch((err: unknown) => console.error('Download pump error:', err));

  return record.id;
}

export async function pauseDownload(db: Db, id: string): Promise<boolean> {
  const dl = activeDownloads.get(id);
  if (!dl || dl.stopped) return false;
  db.update(downloads)
    .set({ state: 'PAUSED', updatedAt: new Date() })
    .where(eq(downloads.id, id))
    .run();
  dl.paused = true;
  return true;
}

export async function resumeDownload(
  db: Db,
  id: string,
  requestChunkFn: RequestChunkFn = defaultRequestChunk,
): Promise<boolean> {
  const record = db.select().from(downloads).where(eq(downloads.id, id)).get();
  if (!record || record.state !== 'PAUSED') return false;

  let dl = activeDownloads.get(id);

  if (!dl) {
    const completedChunks: number[] = JSON.parse(record.completedChunks);
    const sources: string[] = JSON.parse(record.sources);
    const chunkSize = record.chunkSize;
    const totalChunks = Math.ceil(Number(record.size) / chunkSize);
    const tmpPath = record.tmpPath ?? join(tmpdir(), `.filenet-dl-${id}.tmp`);

    let fileHandle: FileHandle;
    try {
      fileHandle = await open(tmpPath, 'r+');
    } catch {
      completedChunks.splice(0);
      db.update(downloads)
        .set({ completedChunks: '[]', bytesReceived: 0n, updatedAt: new Date() })
        .where(eq(downloads.id, id))
        .run();
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

    const concurrent = activeDownloads.get(id);
    if (concurrent) {
      try {
        await fileHandle.close();
      } catch {}
      dl = concurrent;
    } else {
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
        startedAt: record.createdAt!,
      };
      activeDownloads.set(id, dl);
    }
  }

  const activeDl = dl!;
  const matched = db
    .update(downloads)
    .set({ state: 'DOWNLOADING', tmpPath: activeDl.tmpPath, updatedAt: new Date() })
    .where(and(eq(downloads.id, id), eq(downloads.state, 'PAUSED')))
    .returning({ id: downloads.id })
    .all();
  if (matched.length === 0) {
    const current = db.select().from(downloads).where(eq(downloads.id, id)).get();
    if (
      !current ||
      current.state === 'CANCELLED' ||
      current.state === 'FAILED' ||
      current.state === 'COMPLETED'
    ) {
      activeDl.stopped = true;
      if (activeDl.fileHandle) {
        try {
          await activeDl.fileHandle.close();
        } catch {}
      }
      activeDownloads.delete(id);
      activeDownloadFolders.delete(id);
    }
    return false;
  }
  activeDl.paused = false;

  pump(db, activeDl, requestChunkFn).catch((err: unknown) =>
    console.error('Resume pump error:', err),
  );
  return true;
}

export async function cancelDownload(db: Db, id: string): Promise<boolean> {
  const dl = activeDownloads.get(id);
  const record = db.select().from(downloads).where(eq(downloads.id, id)).get();
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

  db.update(downloads)
    .set({ state: 'CANCELLED', tmpPath: null, updatedAt: new Date() })
    .where(and(eq(downloads.id, id), notInArray(downloads.state, ['COMPLETED', 'CANCELLED'])))
    .run();
  return true;
}

export async function getTransfers(db: Db): Promise<TransferDto[]> {
  const records = db.select().from(downloads).orderBy(desc(downloads.createdAt)).all();
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
      createdAt: r.createdAt!.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    };
  });
}

export async function pauseAllActiveDownloads(db: Db): Promise<void> {
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
      try {
        db.update(downloads)
          .set({ state: 'PAUSED', updatedAt: new Date() })
          .where(eq(downloads.id, id))
          .run();
      } catch {}
    }),
  );
}
