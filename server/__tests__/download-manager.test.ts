import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, unlinkSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execSync } from 'child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  cancelDownload,
  getTransfers,
  pauseDownload,
  resumeDownload,
  startDownload,
} from '../download-manager';
import type { PrismaClient } from '@prisma/client';
import type { RequestChunkFn } from '../download-manager';
import { createPrismaClient } from '../db';

const TEST_DB_URL = 'file:./data/test-download-manager.db';
let prisma: PrismaClient;
let tmpDir: string;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// Build a mock requestChunkFn that serves chunks from a Buffer
function makeChunkServer(content: Buffer): RequestChunkFn {
  return async (_nodeId, _sha256, offset, length) => {
    return content.subarray(offset, offset + length);
  };
}

// Build a mock requestChunkFn that introduces a per-chunk delay
function makeSlowChunkServer(content: Buffer, delayMs: number): RequestChunkFn {
  return async (_nodeId, _sha256, offset, length) => {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return content.subarray(offset, offset + length);
  };
}

// Build a mock requestChunkFn that always fails
function makeFailingChunkServer(reason = 'peer error'): RequestChunkFn {
  return async () => {
    throw new Error(reason);
  };
}

beforeAll(async () => {
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-dl-mgr-'));
});

afterAll(async () => {
  await prisma.$disconnect();
  await rm(tmpDir, { recursive: true, force: true });
  try {
    unlinkSync('./data/test-download-manager.db');
  } catch {}
});

beforeEach(async () => {
  await prisma.download.deleteMany();
  await prisma.friend.deleteMany();
});

// ---------------------------------------------------------------------------
// startDownload
// ---------------------------------------------------------------------------

describe('startDownload', () => {
  it('creates a Download record and completes when all chunks are served', async () => {
    const content = Buffer.from('the quick brown fox jumps over the lazy dog');
    const hash = sha256(content);
    const downloadFolder = join(tmpDir, 'dl-basic');
    await mkdir(downloadFolder, { recursive: true });

    const id = await startDownload(
      prisma,
      {
        sha256: hash,
        filename: 'fox.txt',
        size: BigInt(content.length),
        mimeType: 'text/plain',
        sources: ['fake-node'],
        downloadFolder,
      },
      makeChunkServer(content),
    );

    expect(typeof id).toBe('string');

    // Wait for completion (polling, max 2s)
    let dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    for (let i = 0; i < 40 && dl.state !== 'COMPLETED' && dl.state !== 'FAILED'; i++) {
      await Bun.sleep(50);
      dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    }

    expect(dl.state).toBe('COMPLETED');
    expect(dl.finalPath).toBeTruthy();
    expect(existsSync(dl.finalPath!)).toBe(true);
    const written = await readFile(dl.finalPath!);
    expect(written.toString()).toBe(content.toString());
  });

  it('verifies SHA-256 and marks FAILED if content is corrupted', async () => {
    const content = Buffer.from('real content');
    const wrongHash = 'f'.repeat(64);
    const downloadFolder = join(tmpDir, 'dl-corrupt');
    await mkdir(downloadFolder, { recursive: true });

    const id = await startDownload(
      prisma,
      {
        sha256: wrongHash,
        filename: 'bad.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder,
      },
      makeChunkServer(content),
    );

    let dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    for (let i = 0; i < 40 && dl.state !== 'COMPLETED' && dl.state !== 'FAILED'; i++) {
      await Bun.sleep(50);
      dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    }

    expect(dl.state).toBe('FAILED');
    expect(dl.error).toMatch(/sha-256/i);
  });

  it('marks FAILED when no sources respond', async () => {
    const content = Buffer.from('whatever');
    const hash = sha256(content);
    const downloadFolder = join(tmpDir, 'dl-nosource');
    await mkdir(downloadFolder, { recursive: true });

    const id = await startDownload(
      prisma,
      {
        sha256: hash,
        filename: 'fail.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder,
      },
      makeFailingChunkServer('connection refused'),
    );

    let dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    for (let i = 0; i < 40 && dl.state !== 'COMPLETED' && dl.state !== 'FAILED'; i++) {
      await Bun.sleep(50);
      dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    }

    expect(dl.state).toBe('FAILED');
  });

  it('deduplicates the final filename if a file already exists', async () => {
    const content = Buffer.from('duplicate file content');
    const hash = sha256(content);
    const downloadFolder = join(tmpDir, 'dl-dedup');
    await mkdir(downloadFolder, { recursive: true });
    // Pre-create a file with the same name
    await writeFile(join(downloadFolder, 'dupe.txt'), 'existing');

    const id = await startDownload(
      prisma,
      {
        sha256: hash,
        filename: 'dupe.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder,
      },
      makeChunkServer(content),
    );

    let dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    for (let i = 0; i < 40 && dl.state !== 'COMPLETED' && dl.state !== 'FAILED'; i++) {
      await Bun.sleep(50);
      dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    }

    expect(dl.state).toBe('COMPLETED');
    expect(dl.finalPath).not.toBe(join(downloadFolder, 'dupe.txt'));
    expect(existsSync(dl.finalPath!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cancelDownload
// ---------------------------------------------------------------------------

describe('cancelDownload', () => {
  it('marks the download as CANCELLED', async () => {
    const content = Buffer.alloc(1024 * 1024 * 3, 0x42); // 3 MB — slow enough to cancel
    const hash = sha256(content);
    const downloadFolder = join(tmpDir, 'dl-cancel');
    await mkdir(downloadFolder, { recursive: true });

    // Slow chunk server so we can cancel mid-flight
    let cancelledOk = false;
    const slowServer: RequestChunkFn = async (_p, _s, offset, length) => {
      await Bun.sleep(200);
      return content.subarray(offset, offset + length);
    };

    const id = await startDownload(
      prisma,
      {
        sha256: hash,
        filename: 'big.bin',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder,
      },
      slowServer,
    );

    // Give it a moment to start, then cancel
    await Bun.sleep(50);
    cancelledOk = await cancelDownload(prisma, id);
    expect(cancelledOk).toBe(true);

    const dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    expect(dl.state).toBe('CANCELLED');
    // Temp file should be gone
    if (dl.tmpPath) {
      expect(existsSync(dl.tmpPath)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// pauseDownload / resumeDownload
// ---------------------------------------------------------------------------

describe('pauseDownload / resumeDownload', () => {
  it('returns false when trying to resume a cancelled download (TOCTOU guard)', async () => {
    // Simulate: download is PAUSED in DB but a concurrent cancel just flipped it to CANCELLED.
    // resumeDownload must not re-open the download in that case.
    // Use a slow chunk server (200ms delay) so the pump is guaranteed to still be
    // in-flight when pauseDownload runs, making the PAUSED state deterministic.
    const content = Buffer.from('toctou test content here for resume cancel race');
    const hash = sha256(content);
    const folder = join(tmpDir, 'dl-toctou');
    await mkdir(folder, { recursive: true });

    const id = await startDownload(
      prisma,
      {
        sha256: hash,
        filename: 'toctou.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder: folder,
      },
      makeSlowChunkServer(content, 200),
    );

    // Pause while the pump is blocked waiting for the slow chunk server
    await pauseDownload(prisma, id);
    const afterPause = await prisma.download.findUniqueOrThrow({ where: { id } });
    expect(afterPause.state).toBe('PAUSED');

    // Manually flip to CANCELLED in the DB to simulate a concurrent cancel
    await prisma.download.update({ where: { id }, data: { state: 'CANCELLED' } });

    const result = await resumeDownload(prisma, id);
    expect(result).toBe(false);

    // Confirm state stays CANCELLED
    const record = await prisma.download.findUniqueOrThrow({ where: { id } });
    expect(record.state).toBe('CANCELLED');
  });

  it('can pause and then resume to completion', async () => {
    const content = Buffer.from('pause and resume content here');
    const hash = sha256(content);
    const downloadFolder = join(tmpDir, 'dl-pause');
    await mkdir(downloadFolder, { recursive: true });

    const id = await startDownload(
      prisma,
      {
        sha256: hash,
        filename: 'pause.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder,
      },
      makeChunkServer(content),
    );

    // Pause immediately (download may already be done for tiny files)
    await pauseDownload(prisma, id);
    const paused = await prisma.download.findUniqueOrThrow({ where: { id } });
    // Either PAUSED or COMPLETED (tiny file may finish before pause)
    expect(['PAUSED', 'COMPLETED']).toContain(paused.state);

    if (paused.state === 'PAUSED') {
      await resumeDownload(prisma, id, makeChunkServer(content));
      let dl = await prisma.download.findUniqueOrThrow({ where: { id } });
      for (let i = 0; i < 40 && dl.state !== 'COMPLETED' && dl.state !== 'FAILED'; i++) {
        await Bun.sleep(50);
        dl = await prisma.download.findUniqueOrThrow({ where: { id } });
      }
      expect(dl.state).toBe('COMPLETED');
    }
  });
});

// ---------------------------------------------------------------------------
// getTransfers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Friend download counters
// ---------------------------------------------------------------------------

describe('friend download counters', () => {
  it('increments downloadCount and downloadTotalBytes for ACCEPTED friends in sources', async () => {
    const friend = await prisma.friend.create({
      data: {
        name: 'Alice',
        nodeId: 'counter-alice',
        address: '10.0.1.1',
        port: 7734,
        status: 'ACCEPTED',
      },
    });

    const content = Buffer.from('hello counter');
    const hash = sha256(content);
    const folder = join(tmpDir, 'counter-basic');
    await mkdir(folder, { recursive: true });

    const id = await startDownload(
      prisma,
      {
        sha256: hash,
        filename: 'counter.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['counter-alice'],
        downloadFolder: folder,
      },
      makeChunkServer(content),
    );

    let dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    for (let i = 0; i < 40 && dl.state !== 'COMPLETED' && dl.state !== 'FAILED'; i++) {
      await Bun.sleep(50);
      dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    }
    expect(dl.state).toBe('COMPLETED');

    const updated = await prisma.friend.findUniqueOrThrow({ where: { id: friend.id } });
    expect(updated.downloadCount).toBe(1);
    expect(updated.downloadTotalBytes).toBe(BigInt(content.length));
  });

  it('credits a friend only once even if their nodeId appears twice in sources', async () => {
    const friend = await prisma.friend.create({
      data: {
        name: 'Bob',
        nodeId: 'counter-bob',
        address: '10.0.1.2',
        port: 7734,
        status: 'ACCEPTED',
      },
    });

    const content = Buffer.from('dedup test');
    const hash = sha256(content);
    const folder = join(tmpDir, 'counter-dedup');
    await mkdir(folder, { recursive: true });

    const id = await startDownload(
      prisma,
      {
        sha256: hash,
        filename: 'dedup.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['counter-bob', 'counter-bob'], // duplicate
        downloadFolder: folder,
      },
      makeChunkServer(content),
    );

    let dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    for (let i = 0; i < 40 && dl.state !== 'COMPLETED' && dl.state !== 'FAILED'; i++) {
      await Bun.sleep(50);
      dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    }
    expect(dl.state).toBe('COMPLETED');

    const updated = await prisma.friend.findUniqueOrThrow({ where: { id: friend.id } });
    expect(updated.downloadCount).toBe(1);
  });

  it('does not increment counters for non-ACCEPTED friends', async () => {
    const pending = await prisma.friend.create({
      data: {
        name: 'Pending Carol',
        nodeId: 'counter-carol',
        address: '10.0.1.3',
        port: 7734,
        status: 'INCOMING_PENDING',
      },
    });

    const content = Buffer.from('pending test');
    const hash = sha256(content);
    const folder = join(tmpDir, 'counter-pending');
    await mkdir(folder, { recursive: true });

    const id = await startDownload(
      prisma,
      {
        sha256: hash,
        filename: 'pending.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['counter-carol'],
        downloadFolder: folder,
      },
      makeChunkServer(content),
    );

    let dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    for (let i = 0; i < 40 && dl.state !== 'COMPLETED' && dl.state !== 'FAILED'; i++) {
      await Bun.sleep(50);
      dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    }
    expect(dl.state).toBe('COMPLETED');

    const notUpdated = await prisma.friend.findUniqueOrThrow({ where: { id: pending.id } });
    expect(notUpdated.downloadCount).toBe(0);
  });

  it('does not increment counters when download fails', async () => {
    const friend = await prisma.friend.create({
      data: {
        name: 'Dave',
        nodeId: 'counter-dave',
        address: '10.0.1.4',
        port: 7734,
        status: 'ACCEPTED',
      },
    });

    const content = Buffer.from('fail test');
    const realHash = sha256(content);
    const wrongHash = 'f'.repeat(64);
    const folder = join(tmpDir, 'counter-fail');
    await mkdir(folder, { recursive: true });

    const id = await startDownload(
      prisma,
      {
        sha256: wrongHash, // wrong hash → FAILED after download
        filename: 'fail.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['counter-dave'],
        downloadFolder: folder,
      },
      makeChunkServer(content),
    );

    let dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    for (let i = 0; i < 40 && dl.state !== 'COMPLETED' && dl.state !== 'FAILED'; i++) {
      await Bun.sleep(50);
      dl = await prisma.download.findUniqueOrThrow({ where: { id } });
    }
    expect(dl.state).toBe('FAILED');
    void realHash; // used for documentation

    const notUpdated = await prisma.friend.findUniqueOrThrow({ where: { id: friend.id } });
    expect(notUpdated.downloadCount).toBe(0);
  });
});

describe('getTransfers', () => {
  it('returns all downloads with progress info', async () => {
    const content = Buffer.from('stats test');
    const hash = sha256(content);
    const downloadFolder = join(tmpDir, 'dl-stats');
    await mkdir(downloadFolder, { recursive: true });

    await startDownload(
      prisma,
      {
        sha256: hash,
        filename: 'stats.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder,
      },
      makeChunkServer(content),
    );

    const transfers = await getTransfers(prisma);
    expect(transfers.length).toBeGreaterThanOrEqual(1);
    const t = transfers[0];
    expect(t.sha256).toBe(hash);
    expect(t.filename).toBe('stats.txt');
    expect(typeof t.progress).toBe('number');
    expect(t.progress).toBeGreaterThanOrEqual(0);
    expect(t.progress).toBeLessThanOrEqual(1);
  });
});
