import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type {
  ChunkErrorMessage,
  ChunkRequestMessage,
  ChunkResponseMessage,
  InnerMessage,
} from './types';
import {
  ChunkErrorMessageSchema,
  ChunkRequestMessageSchema,
  ChunkResponseMessageSchema,
} from './schemas';
import { getConnectedPeer, sendToPeer } from './connections';
import type { ConnectedPeer } from './connections';

export const CHUNK_SIZE = 1024 * 1024; // 1 MB
const CHUNK_TIMEOUT_MS = 30_000;

// Tracks (friendId:sha256) pairs already counted for uploadCount so each unique
// file served to each peer is counted exactly once. Bounded with FIFO eviction.
const servedFiles = new Set<string>();
const MAX_SERVED_FILES = 100_000;

// Per-friend upload stat accumulators — flushed to DB on a throttle timer so
// sustained chunk serving doesn't create a write per chunk in SQLite.
interface UploadAccumulator {
  bytes: bigint;
  newFileCount: number; // distinct (friendId, sha256) pairs seen since last flush
}
const pendingUploads = new Map<string, UploadAccumulator>();
const pendingUploadTimers = new Map<string, ReturnType<typeof setTimeout>>();
const UPLOAD_FLUSH_MS = 2_000;

function scheduleUploadFlush(friendId: string, prisma: PrismaClient): void {
  // Throttle: only schedule if no timer is already pending for this friend.
  // Unlike debounce, this guarantees the flush fires within UPLOAD_FLUSH_MS
  // even under sustained chunk traffic.
  if (pendingUploadTimers.has(friendId)) return;
  pendingUploadTimers.set(
    friendId,
    setTimeout(() => {
      pendingUploadTimers.delete(friendId);
      const pending = pendingUploads.get(friendId);
      if (!pending) return;
      pendingUploads.delete(friendId);
      prisma.friend
        .update({
          where: { id: friendId },
          data: {
            uploadTotalBytes: { increment: pending.bytes },
            ...(pending.newFileCount > 0
              ? { uploadCount: { increment: pending.newFileCount } }
              : {}),
          },
        })
        .catch((err: unknown) => console.error('Failed to flush upload stats:', err));
    }, UPLOAD_FLUSH_MS),
  );
}

// ---------------------------------------------------------------------------
// Live upload session tracking — in-memory, shown in the Transfers UI
// ---------------------------------------------------------------------------

const UPLOAD_SPEED_WINDOW_MS = 5_000;
export const UPLOAD_SESSION_IDLE_MS = 30_000;

const SPEED_BUCKET_MS = 500; // coalesce samples into fixed-width buckets

interface SpeedSample {
  time: number; // bucket start (floored to SPEED_BUCKET_MS)
  bytes: number;
}

interface ActiveUploadSession {
  sha256: string;
  filename: string;
  size: bigint;
  friendId: string;
  peerNodeId: string;
  bytesServed: bigint;
  startedAt: number;
  lastActivityAt: number;
  speedSamples: SpeedSample[];
}

const activeUploadSessions = new Map<string, ActiveUploadSession>();

function pruneIdleUploadSessions(): void {
  const now = Date.now();
  for (const [id, s] of activeUploadSessions) {
    if (now - s.lastActivityAt >= UPLOAD_SESSION_IDLE_MS) {
      activeUploadSessions.delete(id);
    }
  }
}

// Prune idle sessions on a background timer so expiry fires even when
// /api/uploads is never polled (headless servers won't have a UI polling it).
setInterval(pruneIdleUploadSessions, Math.round(UPLOAD_SESSION_IDLE_MS / 2)).unref();

function recordUploadBytes(session: ActiveUploadSession, bytes: number): void {
  const now = Date.now();
  const bucket = Math.floor(now / SPEED_BUCKET_MS) * SPEED_BUCKET_MS;
  const last = session.speedSamples[session.speedSamples.length - 1];
  if (last && last.time === bucket) {
    last.bytes += bytes;
  } else {
    session.speedSamples.push({ time: bucket, bytes });
  }
  const cutoff = now - UPLOAD_SPEED_WINDOW_MS;
  const firstValid = session.speedSamples.findIndex((s) => s.time >= cutoff);
  if (firstValid === -1) session.speedSamples = [];
  else if (firstValid > 0) session.speedSamples.splice(0, firstValid);
}

function calcUploadSpeed(session: ActiveUploadSession): number {
  if (session.speedSamples.length === 0) return 0;
  const windowMs = Date.now() - session.speedSamples[0].time;
  if (windowMs < 100) return 0;
  const totalBytes = session.speedSamples.reduce((sum, r) => sum + r.bytes, 0);
  return Math.round((totalBytes / windowMs) * 1000);
}

export type ActiveUploadInfo = {
  id: string;
  sha256: string;
  filename: string;
  size: string;
  peerNodeId: string;
  bytesServed: string;
  speedBps: number;
};

export function getActiveUploadSessions(): ActiveUploadInfo[] {
  pruneIdleUploadSessions();
  const results: ActiveUploadInfo[] = [];
  for (const [id, s] of activeUploadSessions) {
    results.push({
      id,
      sha256: s.sha256,
      filename: s.filename,
      size: String(s.size),
      peerNodeId: s.peerNodeId,
      bytesServed: String(s.bytesServed),
      speedBps: calcUploadSpeed(s),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------

// Pending download-side chunk callbacks keyed by transferId
const pendingChunks = new Map<
  string,
  { resolve: (data: Buffer) => void; reject: (err: Error) => void }
>();

// Last registered transferId — for use by tests only
let lastTransferId = '';

// ---------------------------------------------------------------------------
// Upload side — serve chunks to requesting peers
// ---------------------------------------------------------------------------

export async function handleChunkRequest(
  msg: ChunkRequestMessage,
  senderNodeId: string,
  prisma: PrismaClient,
  sendResponse: (msg: InnerMessage) => void,
): Promise<void> {
  const friend = await prisma.friend.findFirst({
    where: { nodeId: senderNodeId, status: 'ACCEPTED' },
  });
  if (!friend) return; // not an accepted friend — drop

  const file = await prisma.sharedFile.findFirst({ where: { sha256: msg.sha256 } });
  if (!file) {
    sendResponse({
      type: 'chunk-error',
      transferId: msg.transferId,
      sha256: msg.sha256,
      offset: msg.offset,
      reason: 'File not found',
    });
    return;
  }

  if (BigInt(msg.offset) + BigInt(msg.length) > file.size) {
    sendResponse({
      type: 'chunk-error',
      transferId: msg.transferId,
      sha256: msg.sha256,
      offset: msg.offset,
      reason: 'Chunk out of bounds',
    });
    return;
  }

  try {
    const fh = await open(file.path, 'r');
    try {
      const buf = Buffer.alloc(msg.length);
      const { bytesRead } = await fh.read(buf, 0, msg.length, msg.offset);
      if (bytesRead !== msg.length) {
        // File was modified or truncated after indexing — the DB size is stale.
        sendResponse({
          type: 'chunk-error',
          transferId: msg.transferId,
          sha256: msg.sha256,
          offset: msg.offset,
          reason: 'File modified — stale index',
        });
        return;
      }
      sendResponse({
        type: 'chunk-response',
        transferId: msg.transferId,
        sha256: msg.sha256,
        offset: msg.offset,
        data: buf.subarray(0, bytesRead).toString('base64'),
      });
      // Accumulate upload stats — flushed to DB on a throttle timer (non-critical).
      if (bytesRead > 0) {
        const dedupKey = `${friend.id}:${msg.sha256}`;
        const isFirstChunk = !servedFiles.has(dedupKey);
        if (isFirstChunk) {
          // FIFO evict oldest entry when at cap so counting continues for new pairs.
          if (servedFiles.size >= MAX_SERVED_FILES) {
            servedFiles.delete(servedFiles.values().next().value!);
          }
          servedFiles.add(dedupKey);
        }
        const acc = pendingUploads.get(friend.id) ?? { bytes: 0n, newFileCount: 0 };
        acc.bytes += BigInt(bytesRead);
        if (isFirstChunk) acc.newFileCount++;
        pendingUploads.set(friend.id, acc);
        scheduleUploadFlush(friend.id, prisma);

        // Update live upload session for Transfers UI
        const now = Date.now();
        const existing = activeUploadSessions.get(dedupKey);
        if (existing) {
          existing.bytesServed += BigInt(bytesRead);
          existing.lastActivityAt = now;
          recordUploadBytes(existing, bytesRead);
        } else {
          activeUploadSessions.set(dedupKey, {
            sha256: msg.sha256,
            filename: file.filename,
            size: file.size,
            friendId: friend.id,
            peerNodeId: senderNodeId,
            bytesServed: BigInt(bytesRead),
            startedAt: now,
            lastActivityAt: now,
            speedSamples: [{ time: now, bytes: bytesRead }],
          });
        }
      }
    } finally {
      await fh.close();
    }
  } catch {
    sendResponse({
      type: 'chunk-error',
      transferId: msg.transferId,
      sha256: msg.sha256,
      offset: msg.offset,
      reason: 'Read error',
    });
  }
}

// ---------------------------------------------------------------------------
// Download side — request chunks from peers, resolve pending promises
// ---------------------------------------------------------------------------

export function requestChunk(
  peer: ConnectedPeer,
  sha256: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  const transferId = randomUUID();
  lastTransferId = transferId;

  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingChunks.delete(transferId);
      reject(new Error(`Chunk request timed out (sha256=${sha256} offset=${offset})`));
    }, CHUNK_TIMEOUT_MS);

    pendingChunks.set(transferId, {
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    try {
      sendToPeer(peer, { type: 'chunk-request', transferId, sha256, offset, length });
    } catch (err: unknown) {
      clearTimeout(timer);
      pendingChunks.delete(transferId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function handleChunkResponse(msg: ChunkResponseMessage): void {
  const pending = pendingChunks.get(msg.transferId);
  if (!pending) return;
  pendingChunks.delete(msg.transferId);
  pending.resolve(Buffer.from(msg.data, 'base64'));
}

export function handleChunkError(msg: ChunkErrorMessage): void {
  const pending = pendingChunks.get(msg.transferId);
  if (!pending) return;
  pendingChunks.delete(msg.transferId);
  pending.reject(new Error(msg.reason));
}

// ---------------------------------------------------------------------------
// Dispatcher — called from peer.ts (inbound) and index.ts onMessage (outbound)
// ---------------------------------------------------------------------------

export async function dispatchTransferMessage(
  msg: InnerMessage,
  senderNodeId: string,
  prisma: PrismaClient,
): Promise<void> {
  if (msg.type === 'chunk-request') {
    const result = ChunkRequestMessageSchema.safeParse(msg);
    if (!result.success) return;
    const peer = getConnectedPeer(senderNodeId);
    if (!peer) return;
    await handleChunkRequest(result.data, senderNodeId, prisma, (response) =>
      sendToPeer(peer, response),
    );
  } else if (msg.type === 'chunk-response') {
    const result = ChunkResponseMessageSchema.safeParse(msg);
    if (!result.success) return;
    handleChunkResponse(result.data);
  } else if (msg.type === 'chunk-error') {
    const result = ChunkErrorMessageSchema.safeParse(msg);
    if (!result.success) return;
    handleChunkError(result.data);
  }
}

// ---------------------------------------------------------------------------
// Friend lifecycle helpers
// ---------------------------------------------------------------------------

export function clearActiveUploadSessionsForPeer(peerNodeId: string): void {
  for (const [key, session] of activeUploadSessions) {
    if (session.peerNodeId === peerNodeId) activeUploadSessions.delete(key);
  }
}

export function cancelUploadFlushForFriend(friendId: string): void {
  const timer = pendingUploadTimers.get(friendId);
  if (timer) {
    clearTimeout(timer);
    pendingUploadTimers.delete(friendId);
  }
  pendingUploads.delete(friendId);
  for (const key of activeUploadSessions.keys()) {
    if (key.startsWith(`${friendId}:`)) activeUploadSessions.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetPendingForTesting(): void {
  pendingChunks.clear();
  servedFiles.clear();
  pendingUploads.clear();
  pendingUploadTimers.forEach((t) => clearTimeout(t));
  pendingUploadTimers.clear();
  activeUploadSessions.clear();
  lastTransferId = '';
}

export async function flushUploadStatsForTesting(
  friendId: string,
  prisma: PrismaClient,
): Promise<void> {
  const timer = pendingUploadTimers.get(friendId);
  if (timer) {
    clearTimeout(timer);
    pendingUploadTimers.delete(friendId);
  }
  const pending = pendingUploads.get(friendId);
  if (!pending) return;
  pendingUploads.delete(friendId);
  await prisma.friend.update({
    where: { id: friendId },
    data: {
      uploadTotalBytes: { increment: pending.bytes },
      ...(pending.newFileCount > 0 ? { uploadCount: { increment: pending.newFileCount } } : {}),
    },
  });
}

export function getLastTransferIdForTesting(): string {
  return lastTransferId;
}
