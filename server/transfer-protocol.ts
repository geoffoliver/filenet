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

export function cancelUploadFlushForFriend(friendId: string): void {
  const timer = pendingUploadTimers.get(friendId);
  if (timer) {
    clearTimeout(timer);
    pendingUploadTimers.delete(friendId);
  }
  pendingUploads.delete(friendId);
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
