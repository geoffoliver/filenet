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

  try {
    const fh = await open(file.path, 'r');
    try {
      const buf = Buffer.alloc(msg.length);
      const { bytesRead } = await fh.read(buf, 0, msg.length, msg.offset);
      sendResponse({
        type: 'chunk-response',
        transferId: msg.transferId,
        sha256: msg.sha256,
        offset: msg.offset,
        data: buf.subarray(0, bytesRead).toString('base64'),
      });
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

    sendToPeer(peer, { type: 'chunk-request', transferId, sha256, offset, length });
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
// Test helpers
// ---------------------------------------------------------------------------

export function resetPendingForTesting(): void {
  pendingChunks.clear();
  lastTransferId = '';
}

export function getLastTransferIdForTesting(): string {
  return lastTransferId;
}
