import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, unlinkSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { type Db, applyMigrations, createDb } from '../db';
import {
  cancelDownload,
  getTransfers,
  pauseDownload,
  resumeDownload,
  startDownload,
} from '../download-manager';
import { downloads, friends } from '../schema';
import type { RequestChunkFn } from '../download-manager';

const TEST_DB_URL = 'file:./data/test-download-manager.db';
let db: Db;
let tmpDir: string;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function makeChunkServer(content: Buffer): RequestChunkFn {
  return async (_nodeId, _sha256, offset, length) => content.subarray(offset, offset + length);
}

function makeSlowChunkServer(content: Buffer, delayMs: number): RequestChunkFn {
  return async (_nodeId, _sha256, offset, length) => {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return content.subarray(offset, offset + length);
  };
}

function makeFailingChunkServer(reason = 'peer error'): RequestChunkFn {
  return async () => {
    throw new Error(reason);
  };
}

async function waitForState(dlId: string, maxMs = 2000) {
  let dl = db.select().from(downloads).where(eq(downloads.id, dlId)).get()!;
  const start = Date.now();
  while (
    dl.state !== 'COMPLETED' &&
    dl.state !== 'FAILED' &&
    dl.state !== 'CANCELLED' &&
    Date.now() - start < maxMs
  ) {
    await Bun.sleep(50);
    dl = db.select().from(downloads).where(eq(downloads.id, dlId)).get()!;
  }
  return dl;
}

beforeAll(async () => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-dl-mgr-'));
});

afterAll(async () => {
  db.$client.close();
  await rm(tmpDir, { recursive: true, force: true });
  try {
    unlinkSync('./data/test-download-manager.db');
  } catch {}
});

beforeEach(() => {
  db.delete(downloads).run();
  db.delete(friends).run();
});

describe('startDownload', () => {
  it('creates a Download record and completes when all chunks are served', async () => {
    const content = Buffer.from('the quick brown fox jumps over the lazy dog');
    const hash = sha256(content);
    const downloadFolder = join(tmpDir, 'dl-basic');
    await mkdir(downloadFolder, { recursive: true });

    const id = await startDownload(
      db,
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

    const dl = await waitForState(id);
    expect(dl.state).toBe('COMPLETED');
    expect(dl.finalPath).toBeTruthy();
    expect(existsSync(dl.finalPath!)).toBe(true);
    const written = await readFile(dl.finalPath!);
    expect(written.toString()).toBe(content.toString());
  });

  it('verifies SHA-256 and marks FAILED if content is corrupted', async () => {
    const content = Buffer.from('real content');
    const downloadFolder = join(tmpDir, 'dl-corrupt');
    await mkdir(downloadFolder, { recursive: true });

    const id = await startDownload(
      db,
      {
        sha256: 'f'.repeat(64),
        filename: 'bad.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder,
      },
      makeChunkServer(content),
    );
    const dl = await waitForState(id);
    expect(dl.state).toBe('FAILED');
    expect(dl.error).toMatch(/sha-256/i);
  });

  it('marks FAILED when no sources respond', async () => {
    const content = Buffer.from('whatever');
    const downloadFolder = join(tmpDir, 'dl-nosource');
    await mkdir(downloadFolder, { recursive: true });

    const id = await startDownload(
      db,
      {
        sha256: sha256(content),
        filename: 'fail.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder,
      },
      makeFailingChunkServer('connection refused'),
    );
    const dl = await waitForState(id);
    expect(dl.state).toBe('FAILED');
  });

  it('deduplicates the final filename if a file already exists', async () => {
    const content = Buffer.from('duplicate file content');
    const downloadFolder = join(tmpDir, 'dl-dedup');
    await mkdir(downloadFolder, { recursive: true });
    await writeFile(join(downloadFolder, 'dupe.txt'), 'existing');

    const id = await startDownload(
      db,
      {
        sha256: sha256(content),
        filename: 'dupe.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder,
      },
      makeChunkServer(content),
    );
    const dl = await waitForState(id);
    expect(dl.state).toBe('COMPLETED');
    expect(dl.finalPath).not.toBe(join(downloadFolder, 'dupe.txt'));
    expect(existsSync(dl.finalPath!)).toBe(true);
  });
});

describe('cancelDownload', () => {
  it('marks the download as CANCELLED', async () => {
    const content = Buffer.alloc(1024 * 1024 * 3, 0x42);
    const downloadFolder = join(tmpDir, 'dl-cancel');
    await mkdir(downloadFolder, { recursive: true });

    const id = await startDownload(
      db,
      {
        sha256: sha256(content),
        filename: 'big.bin',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder,
      },
      makeSlowChunkServer(content, 200),
    );

    await Bun.sleep(50);
    const cancelledOk = await cancelDownload(db, id);
    expect(cancelledOk).toBe(true);

    const dl = db.select().from(downloads).where(eq(downloads.id, id)).get()!;
    expect(dl.state).toBe('CANCELLED');
    if (dl.tmpPath) expect(existsSync(dl.tmpPath)).toBe(false);
  });
});

describe('pauseDownload / resumeDownload', () => {
  it('returns false without modifying state when record is already CANCELLED', async () => {
    const content = Buffer.from('toctou test content here for resume cancel race');
    const folder = join(tmpDir, 'dl-toctou');
    await mkdir(folder, { recursive: true });

    const id = await startDownload(
      db,
      {
        sha256: sha256(content),
        filename: 'toctou.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder: folder,
      },
      makeSlowChunkServer(content, 200),
    );

    await pauseDownload(db, id);
    const afterPause = db.select().from(downloads).where(eq(downloads.id, id)).get()!;
    expect(afterPause.state).toBe('PAUSED');

    db.update(downloads)
      .set({ state: 'CANCELLED', updatedAt: new Date() })
      .where(eq(downloads.id, id))
      .run();

    const result = await resumeDownload(db, id);
    expect(result).toBe(false);

    const record = db.select().from(downloads).where(eq(downloads.id, id)).get()!;
    expect(record.state).toBe('CANCELLED');
  });

  it('can pause and then resume to completion', async () => {
    const content = Buffer.from('pause and resume content here');
    const downloadFolder = join(tmpDir, 'dl-pause');
    await mkdir(downloadFolder, { recursive: true });

    const id = await startDownload(
      db,
      {
        sha256: sha256(content),
        filename: 'pause.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder,
      },
      makeChunkServer(content),
    );

    await pauseDownload(db, id);
    const paused = db.select().from(downloads).where(eq(downloads.id, id)).get()!;
    expect(['PAUSED', 'COMPLETED']).toContain(paused.state);

    if (paused.state === 'PAUSED') {
      await resumeDownload(db, id, makeChunkServer(content));
      const dl = await waitForState(id);
      expect(dl.state).toBe('COMPLETED');
    }
  });
});

describe('friend download counters', () => {
  function insertFriend(nodeId: string, status: string) {
    const now = new Date();
    return db
      .insert(friends)
      .values({
        id: randomUUID(),
        name: nodeId,
        nodeId,
        address: `10.0.1.${Math.floor(Math.random() * 200) + 10}`,
        port: 7734,
        status: status as any,
        addedAt: now,
        updatedAt: now,
      })
      .returning()
      .get()!;
  }

  it('increments downloadCount and downloadTotalBytes for ACCEPTED friends in sources', async () => {
    const friend = insertFriend('counter-alice', 'ACCEPTED');
    const content = Buffer.from('hello counter');
    const folder = join(tmpDir, 'counter-basic');
    await mkdir(folder, { recursive: true });

    const id = await startDownload(
      db,
      {
        sha256: sha256(content),
        filename: 'counter.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['counter-alice'],
        downloadFolder: folder,
      },
      makeChunkServer(content),
    );
    const dl = await waitForState(id);
    expect(dl.state).toBe('COMPLETED');

    const updated = db.select().from(friends).where(eq(friends.id, friend.id)).get()!;
    expect(updated.downloadCount).toBe(1);
    expect(updated.downloadTotalBytes).toBe(BigInt(content.length));
  });

  it('credits a friend only once even if their nodeId appears twice in sources', async () => {
    const friend = insertFriend('counter-bob', 'ACCEPTED');
    const content = Buffer.from('dedup test');
    const folder = join(tmpDir, 'counter-dedup');
    await mkdir(folder, { recursive: true });

    const id = await startDownload(
      db,
      {
        sha256: sha256(content),
        filename: 'dedup.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['counter-bob', 'counter-bob'],
        downloadFolder: folder,
      },
      makeChunkServer(content),
    );
    const dl = await waitForState(id);
    expect(dl.state).toBe('COMPLETED');

    const updated = db.select().from(friends).where(eq(friends.id, friend.id)).get()!;
    expect(updated.downloadCount).toBe(1);
  });

  it('does not increment counters for non-ACCEPTED friends', async () => {
    const pending = insertFriend('counter-carol', 'INCOMING_PENDING');
    const content = Buffer.from('pending test');
    const folder = join(tmpDir, 'counter-pending');
    await mkdir(folder, { recursive: true });

    const id = await startDownload(
      db,
      {
        sha256: sha256(content),
        filename: 'pending.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['counter-carol'],
        downloadFolder: folder,
      },
      makeChunkServer(content),
    );
    const dl = await waitForState(id);
    expect(dl.state).toBe('COMPLETED');

    const notUpdated = db.select().from(friends).where(eq(friends.id, pending.id)).get()!;
    expect(notUpdated.downloadCount).toBe(0);
  });

  it('does not increment counters when download fails', async () => {
    const friend = insertFriend('counter-dave', 'ACCEPTED');
    const content = Buffer.from('fail test');
    const folder = join(tmpDir, 'counter-fail');
    await mkdir(folder, { recursive: true });

    const id = await startDownload(
      db,
      {
        sha256: 'f'.repeat(64),
        filename: 'fail.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['counter-dave'],
        downloadFolder: folder,
      },
      makeChunkServer(content),
    );
    const dl = await waitForState(id);
    expect(dl.state).toBe('FAILED');

    const notUpdated = db.select().from(friends).where(eq(friends.id, friend.id)).get()!;
    expect(notUpdated.downloadCount).toBe(0);
  });
});

describe('getTransfers', () => {
  it('returns all downloads with progress info', async () => {
    const content = Buffer.from('stats test');
    const downloadFolder = join(tmpDir, 'dl-stats');
    await mkdir(downloadFolder, { recursive: true });

    await startDownload(
      db,
      {
        sha256: sha256(content),
        filename: 'stats.txt',
        size: BigInt(content.length),
        mimeType: null,
        sources: ['fake-node'],
        downloadFolder,
      },
      makeChunkServer(content),
    );

    const transfers = await getTransfers(db);
    expect(transfers.length).toBeGreaterThanOrEqual(1);
    const t = transfers[0];
    expect(t.sha256).toBe(sha256(content));
    expect(t.filename).toBe('stats.txt');
    expect(typeof t.progress).toBe('number');
    expect(t.progress).toBeGreaterThanOrEqual(0);
    expect(t.progress).toBeLessThanOrEqual(1);
  });
});
