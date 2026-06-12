import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execSync } from 'child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'fs';

import {
  cancelUploadFlushForFriend,
  flushUploadStatsForTesting,
  getLastTransferIdForTesting,
  handleChunkError,
  handleChunkRequest,
  handleChunkResponse,
  requestChunk,
  resetPendingForTesting,
} from '../transfer-protocol';
import type { ConnectedPeer } from '../connections';
import type { InnerMessage } from '../types';
import type { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '../db';
import { indexFile } from '../indexer';

const TEST_DB_URL = 'file:./data/test-transfer-protocol.db';
let prisma: PrismaClient;
let tmpDir: string;

function makePeer(nodeId: string): ConnectedPeer {
  return {
    peerNodeId: nodeId,
    peerPublicKey: Buffer.alloc(32),
    address: '127.0.0.1',
    port: 7734,
    sessionKey: Buffer.alloc(32),
    ws: { send() {}, close() {} },
  };
}

beforeAll(async () => {
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-transfer-proto-'));
});

afterAll(async () => {
  await prisma.$disconnect();
  await rm(tmpDir, { recursive: true, force: true });
  try {
    unlinkSync('./data/test-transfer-protocol.db');
  } catch {}
});

beforeEach(async () => {
  await prisma.sharedFile.deleteMany();
  await prisma.friend.deleteMany();
  resetPendingForTesting();
});

// ---------------------------------------------------------------------------
// handleChunkRequest — upload (serve) side
// ---------------------------------------------------------------------------

describe('handleChunkRequest', () => {
  it('sends chunk-response with correct bytes for a known file', async () => {
    const content = Buffer.from('hello world this is test content');
    const filePath = join(tmpDir, 'serve-test.txt');
    await writeFile(filePath, content);
    await indexFile(prisma, filePath);
    const file = await prisma.sharedFile.findFirstOrThrow({ where: { path: filePath } });

    await prisma.friend.create({
      data: {
        name: 'Peer',
        address: '1.1.1.1',
        port: 7734,
        nodeId: 'a'.repeat(32),
        status: 'ACCEPTED',
      },
    });

    const received: InnerMessage[] = [];
    await handleChunkRequest(
      {
        type: 'chunk-request',
        transferId: 'tid-1',
        sha256: file.sha256,
        offset: 0,
        length: content.length,
      },
      'a'.repeat(32),
      prisma,
      (msg) => received.push(msg),
    );

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('chunk-response');
    if (received[0].type === 'chunk-response') {
      expect(received[0].transferId).toBe('tid-1');
      expect(received[0].offset).toBe(0);
      expect(Buffer.from(received[0].data, 'base64').toString()).toBe(content.toString());
    }
  });

  it('returns only the requested byte range', async () => {
    const content = Buffer.from('ABCDEFGHIJ');
    const filePath = join(tmpDir, 'range-test.bin');
    await writeFile(filePath, content);
    await indexFile(prisma, filePath);
    const file = await prisma.sharedFile.findFirstOrThrow({ where: { path: filePath } });

    await prisma.friend.create({
      data: {
        name: 'Peer',
        address: '2.2.2.2',
        port: 7734,
        nodeId: 'b'.repeat(32),
        status: 'ACCEPTED',
      },
    });

    const received: InnerMessage[] = [];
    await handleChunkRequest(
      { type: 'chunk-request', transferId: 'tid-range', sha256: file.sha256, offset: 3, length: 4 },
      'b'.repeat(32),
      prisma,
      (msg) => received.push(msg),
    );

    expect(received[0].type).toBe('chunk-response');
    if (received[0].type === 'chunk-response') {
      expect(Buffer.from(received[0].data, 'base64').toString()).toBe('DEFG');
    }
  });

  it('sends chunk-error for unknown sha256', async () => {
    await prisma.friend.create({
      data: {
        name: 'Peer',
        address: '3.3.3.3',
        port: 7734,
        nodeId: 'c'.repeat(32),
        status: 'ACCEPTED',
      },
    });

    const received: InnerMessage[] = [];
    await handleChunkRequest(
      {
        type: 'chunk-request',
        transferId: 'tid-2',
        sha256: 'a'.repeat(64),
        offset: 0,
        length: 100,
      },
      'c'.repeat(32),
      prisma,
      (msg) => received.push(msg),
    );

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('chunk-error');
    if (received[0].type === 'chunk-error') {
      expect(received[0].transferId).toBe('tid-2');
      expect(received[0].reason).toMatch(/not found/i);
    }
  });

  it('returns chunk-error when offset+length exceeds file size', async () => {
    const content = Buffer.from('short'); // 5 bytes
    const filePath = join(tmpDir, 'bounds-test.bin');
    await writeFile(filePath, content);
    await indexFile(prisma, filePath);
    const file = await prisma.sharedFile.findFirstOrThrow({ where: { path: filePath } });

    await prisma.friend.create({
      data: {
        name: 'Peer',
        address: '5.5.5.5',
        port: 7734,
        nodeId: 'd'.repeat(32),
        status: 'ACCEPTED',
      },
    });

    const received: InnerMessage[] = [];
    await handleChunkRequest(
      { type: 'chunk-request', transferId: 'tid-oob', sha256: file.sha256, offset: 3, length: 10 },
      'd'.repeat(32),
      prisma,
      (msg) => received.push(msg),
    );

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('chunk-error');
    if (received[0].type === 'chunk-error') {
      expect(received[0].reason).toMatch(/out of bounds/i);
    }
  });

  it('sends chunk-error when file is truncated after indexing (stale DB size)', async () => {
    const content = Buffer.from('original content here');
    const filePath = join(tmpDir, 'stale-index-test.txt');
    await writeFile(filePath, content);
    await indexFile(prisma, filePath);
    const file = await prisma.sharedFile.findFirstOrThrow({ where: { path: filePath } });

    await prisma.friend.create({
      data: {
        name: 'Peer',
        address: '9.9.9.9',
        port: 7734,
        nodeId: '1'.repeat(32),
        status: 'ACCEPTED',
      },
    });

    // Truncate the file on disk — DB still records the original size
    await writeFile(filePath, Buffer.alloc(0));

    const received: InnerMessage[] = [];
    await handleChunkRequest(
      {
        type: 'chunk-request',
        transferId: 'tid-stale',
        sha256: file.sha256,
        offset: 0,
        length: content.length,
      },
      '1'.repeat(32),
      prisma,
      (msg) => received.push(msg),
    );

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('chunk-error');
    if (received[0].type === 'chunk-error') {
      expect(received[0].reason).toMatch(/stale/i);
    }
  });

  it('cancelUploadFlushForFriend drops pending accumulator so no DB write occurs', async () => {
    const content = Buffer.from('cancel test content');
    const filePath = join(tmpDir, 'cancel-flush-test.txt');
    await writeFile(filePath, content);
    await indexFile(prisma, filePath);
    const file = await prisma.sharedFile.findFirstOrThrow({ where: { path: filePath } });

    const friend = await prisma.friend.create({
      data: {
        name: 'Peer',
        address: '2.2.2.2',
        port: 7734,
        nodeId: '2'.repeat(32),
        status: 'ACCEPTED',
      },
    });

    await handleChunkRequest(
      {
        type: 'chunk-request',
        transferId: 'tid-cancel',
        sha256: file.sha256,
        offset: 0,
        length: content.length,
      },
      '2'.repeat(32),
      prisma,
      () => {},
    );

    cancelUploadFlushForFriend(friend.id);

    // flushUploadStatsForTesting finds nothing pending and returns without writing
    await flushUploadStatsForTesting(friend.id, prisma);
    const updated = await prisma.friend.findUniqueOrThrow({ where: { id: friend.id } });
    expect(updated.uploadTotalBytes).toBe(0n);
    expect(updated.uploadCount).toBe(0);
  });

  it('increments uploadTotalBytes by the number of bytes served', async () => {
    const content = Buffer.from('upload tracking test');
    const filePath = join(tmpDir, 'upload-bytes-test.txt');
    await writeFile(filePath, content);
    await indexFile(prisma, filePath);
    const file = await prisma.sharedFile.findFirstOrThrow({ where: { path: filePath } });

    const friend = await prisma.friend.create({
      data: {
        name: 'Peer',
        address: '6.6.6.6',
        port: 7734,
        nodeId: 'e'.repeat(32),
        status: 'ACCEPTED',
      },
    });

    const received: InnerMessage[] = [];
    await handleChunkRequest(
      {
        type: 'chunk-request',
        transferId: 'tid-upload-bytes',
        sha256: file.sha256,
        offset: 0,
        length: content.length,
      },
      'e'.repeat(32),
      prisma,
      (msg) => received.push(msg),
    );

    await flushUploadStatsForTesting(friend.id, prisma);
    const updated = await prisma.friend.findUniqueOrThrow({ where: { id: friend.id } });
    expect(updated.uploadTotalBytes).toBe(BigInt(content.length));
    expect(updated.uploadCount).toBe(1);
  });

  it('increments uploadCount only once per unique sha256 per peer', async () => {
    const content = Buffer.from('ABCDEFGHIJ');
    const filePath = join(tmpDir, 'upload-count-test.bin');
    await writeFile(filePath, content);
    await indexFile(prisma, filePath);
    const file = await prisma.sharedFile.findFirstOrThrow({ where: { path: filePath } });

    const friend = await prisma.friend.create({
      data: {
        name: 'Peer',
        address: '7.7.7.7',
        port: 7734,
        nodeId: 'f'.repeat(32),
        status: 'ACCEPTED',
      },
    });

    // Serve two separate chunks of the same file to the same peer
    for (const offset of [0, 5]) {
      await handleChunkRequest(
        {
          type: 'chunk-request',
          transferId: `tid-count-${offset}`,
          sha256: file.sha256,
          offset,
          length: 5,
        },
        'f'.repeat(32),
        prisma,
        () => {},
      );
    }

    await flushUploadStatsForTesting(friend.id, prisma);
    const updated = await prisma.friend.findUniqueOrThrow({ where: { id: friend.id } });
    expect(updated.uploadCount).toBe(1);
    expect(updated.uploadTotalBytes).toBe(BigInt(10));
  });

  it('increments uploadCount by the number of distinct files served within one flush window', async () => {
    const contentA = Buffer.from('file-alpha-content');
    const contentB = Buffer.from('file-beta-content');
    const pathA = join(tmpDir, 'multi-file-a.bin');
    const pathB = join(tmpDir, 'multi-file-b.bin');
    await writeFile(pathA, contentA);
    await writeFile(pathB, contentB);
    await indexFile(prisma, pathA);
    await indexFile(prisma, pathB);
    const fileA = await prisma.sharedFile.findFirstOrThrow({ where: { path: pathA } });
    const fileB = await prisma.sharedFile.findFirstOrThrow({ where: { path: pathB } });

    const friend = await prisma.friend.create({
      data: {
        name: 'Peer',
        address: '8.8.8.8',
        port: 7734,
        nodeId: '0'.repeat(32),
        status: 'ACCEPTED',
      },
    });

    // Serve one chunk from each of two different files to the same peer
    for (const [sha256, content] of [
      [fileA.sha256, contentA],
      [fileB.sha256, contentB],
    ] as [string, Buffer][]) {
      await handleChunkRequest(
        {
          type: 'chunk-request',
          transferId: `tid-multi-${sha256.slice(0, 4)}`,
          sha256,
          offset: 0,
          length: content.length,
        },
        '0'.repeat(32),
        prisma,
        () => {},
      );
    }

    await flushUploadStatsForTesting(friend.id, prisma);
    const updated = await prisma.friend.findUniqueOrThrow({ where: { id: friend.id } });
    expect(updated.uploadCount).toBe(2);
    expect(updated.uploadTotalBytes).toBe(BigInt(contentA.length + contentB.length));
  });

  it('silently drops request from non-friend', async () => {
    const received: InnerMessage[] = [];
    await handleChunkRequest(
      {
        type: 'chunk-request',
        transferId: 'tid-3',
        sha256: 'b'.repeat(64),
        offset: 0,
        length: 100,
      },
      'unknown-node',
      prisma,
      (msg) => received.push(msg),
    );

    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// requestChunk / handleChunkResponse / handleChunkError — download (receive) side
// ---------------------------------------------------------------------------

describe('requestChunk + handleChunkResponse', () => {
  it('resolves with chunk data when a matching response arrives', async () => {
    const peer = makePeer('peer-resp');

    const chunkPromise = requestChunk(peer, 'c'.repeat(64), 0, 10);
    const transferId = getLastTransferIdForTesting();

    handleChunkResponse({
      type: 'chunk-response',
      transferId,
      sha256: 'c'.repeat(64),
      offset: 0,
      data: Buffer.from('helloworld').toString('base64'),
    });

    const result = await chunkPromise;
    expect(result.toString()).toBe('helloworld');
  });
});

describe('requestChunk + handleChunkError', () => {
  it('rejects when a matching error arrives', async () => {
    const peer = makePeer('peer-err');

    const chunkPromise = requestChunk(peer, 'd'.repeat(64), 0, 10);
    const transferId = getLastTransferIdForTesting();

    handleChunkError({
      type: 'chunk-error',
      transferId,
      sha256: 'd'.repeat(64),
      offset: 0,
      reason: 'File not found',
    });

    await expect(chunkPromise).rejects.toThrow('File not found');
  });

  it('is a no-op for an unknown transferId', () => {
    expect(() =>
      handleChunkError({
        type: 'chunk-error',
        transferId: '00000000-0000-0000-0000-000000000000',
        sha256: 'e'.repeat(64),
        offset: 0,
        reason: 'nope',
      }),
    ).not.toThrow();
  });
});
