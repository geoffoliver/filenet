import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execSync } from 'child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'fs';

import type { PrismaClient } from '@prisma/client';

import {
  extractMetadata,
  hashFile,
  indexFile,
  removeStaleEntries,
  scanAndIndex,
  scanDirectory,
  startPeriodicRescan,
} from '../indexer';
import { createPrismaClient } from '../db';

const TEST_DB_URL = 'file:./data/test-indexer.db';
let prisma: PrismaClient;
let tmpDir: string;

beforeAll(async () => {
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-test-'));
});

afterAll(async () => {
  await prisma.$disconnect();
  await rm(tmpDir, { recursive: true, force: true });
  try {
    unlinkSync('./data/test-indexer.db');
  } catch {}
});

beforeEach(async () => {
  await prisma.sharedFile.deleteMany();
});

// ---------------------------------------------------------------------------
// hashFile
// ---------------------------------------------------------------------------

describe('hashFile', () => {
  it('returns a 64-character lowercase hex string', async () => {
    const path = join(tmpDir, 'hash1.txt');
    await writeFile(path, 'test content');
    const hash = await hashFile(path);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same content', async () => {
    const p1 = join(tmpDir, 'hash-det1.txt');
    const p2 = join(tmpDir, 'hash-det2.txt');
    await writeFile(p1, 'same content');
    await writeFile(p2, 'same content');
    expect(await hashFile(p1)).toBe(await hashFile(p2));
  });

  it('differs for different content', async () => {
    const p1 = join(tmpDir, 'hash-diff1.txt');
    const p2 = join(tmpDir, 'hash-diff2.txt');
    await writeFile(p1, 'content A');
    await writeFile(p2, 'content B');
    expect(await hashFile(p1)).not.toBe(await hashFile(p2));
  });
});

// ---------------------------------------------------------------------------
// extractMetadata
// ---------------------------------------------------------------------------

describe('extractMetadata', () => {
  it('returns null for a plain text file', async () => {
    const path = join(tmpDir, 'meta-text.txt');
    await writeFile(path, 'hello world');
    expect(await extractMetadata(path)).toBeNull();
  });

  it('returns null for an unknown extension', async () => {
    const path = join(tmpDir, 'meta-unknown.xyz');
    await writeFile(path, 'data');
    expect(await extractMetadata(path)).toBeNull();
  });

  it('returns null for an audio extension with invalid content', async () => {
    const path = join(tmpDir, 'meta-bad.mp3');
    await writeFile(path, 'not real audio data');
    expect(await extractMetadata(path)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// scanDirectory
// ---------------------------------------------------------------------------

describe('scanDirectory', () => {
  it('returns empty array for an empty directory', async () => {
    const dir = join(tmpDir, 'scan-empty');
    await mkdir(dir);
    expect(await scanDirectory(dir)).toEqual([]);
  });

  it('returns files in a flat directory', async () => {
    const dir = join(tmpDir, 'scan-flat');
    await mkdir(dir);
    await writeFile(join(dir, 'a.txt'), 'a');
    await writeFile(join(dir, 'b.txt'), 'b');
    const files = await scanDirectory(dir);
    expect(files.sort()).toEqual([join(dir, 'a.txt'), join(dir, 'b.txt')]);
  });

  it('recurses into subdirectories', async () => {
    const dir = join(tmpDir, 'scan-recursive');
    await mkdir(dir);
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'root.txt'), 'r');
    await writeFile(join(dir, 'sub', 'nested.txt'), 'n');
    const files = await scanDirectory(dir);
    expect(files.sort()).toEqual([join(dir, 'root.txt'), join(dir, 'sub', 'nested.txt')]);
  });

  it('ignores hidden files and directories', async () => {
    const dir = join(tmpDir, 'scan-hidden');
    await mkdir(dir);
    await mkdir(join(dir, '.hidden-dir'));
    await writeFile(join(dir, 'visible.txt'), 'v');
    await writeFile(join(dir, '.hidden.txt'), 'h');
    await writeFile(join(dir, '.hidden-dir', 'inside.txt'), 'i');
    const files = await scanDirectory(dir);
    expect(files).toEqual([join(dir, 'visible.txt')]);
  });

  it('returns empty array for a nonexistent directory', async () => {
    const files = await scanDirectory(join(tmpDir, 'does-not-exist'));
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// indexFile
// ---------------------------------------------------------------------------

describe('indexFile', () => {
  it('creates a SharedFile record for a new file', async () => {
    const path = join(tmpDir, 'index-new.txt');
    await writeFile(path, 'new file content');
    const record = await indexFile(prisma, path);
    expect(record.path).toBe(path);
    expect(record.filename).toBe('index-new.txt');
    expect(record.sha256).toHaveLength(64);
    expect(record.size).toBeGreaterThan(0n);
    const count = await prisma.sharedFile.count();
    expect(count).toBe(1);
  });

  it('stores the correct size', async () => {
    const content = 'exactly this content';
    const path = join(tmpDir, 'index-size.txt');
    await writeFile(path, content);
    const record = await indexFile(prisma, path);
    expect(record.size).toBe(BigInt(Buffer.byteLength(content)));
  });

  it('returns the existing record without re-indexing when file is unchanged', async () => {
    const path = join(tmpDir, 'index-unchanged.txt');
    await writeFile(path, 'content');
    const first = await indexFile(prisma, path);
    const second = await indexFile(prisma, path);
    expect(second.id).toBe(first.id);
    expect(second.sha256).toBe(first.sha256);
    expect(await prisma.sharedFile.count()).toBe(1);
  });

  it('updates the record when the file content changes', async () => {
    const path = join(tmpDir, 'index-changed.txt');
    await writeFile(path, 'short');
    const first = await indexFile(prisma, path);
    await writeFile(path, 'much longer content here');
    const second = await indexFile(prisma, path);
    expect(second.id).toBe(first.id);
    expect(second.sha256).not.toBe(first.sha256);
    expect(second.size).toBeGreaterThan(first.size);
    expect(await prisma.sharedFile.count()).toBe(1);
  });

  it('stores mimeType based on extension', async () => {
    const path = join(tmpDir, 'index-mime.txt');
    await writeFile(path, 'text');
    const record = await indexFile(prisma, path);
    expect(record.mimeType).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// removeStaleEntries
// ---------------------------------------------------------------------------

describe('removeStaleEntries', () => {
  it('removes records whose paths are not in the active set', async () => {
    const path = join(tmpDir, 'stale-remove.txt');
    await writeFile(path, 'stale');
    await indexFile(prisma, path);
    const removed = await removeStaleEntries(prisma, new Set());
    expect(removed).toBe(1);
    expect(await prisma.sharedFile.findFirst({ where: { path } })).toBeNull();
  });

  it('keeps records whose paths are in the active set', async () => {
    const path = join(tmpDir, 'active-keep.txt');
    await writeFile(path, 'active');
    await indexFile(prisma, path);
    const removed = await removeStaleEntries(prisma, new Set([path]));
    expect(removed).toBe(0);
    expect(await prisma.sharedFile.findFirst({ where: { path } })).not.toBeNull();
  });

  it('removes only stale records when active and stale records coexist', async () => {
    const activePath = join(tmpDir, 'coexist-active.txt');
    const stalePath = join(tmpDir, 'coexist-stale.txt');
    await writeFile(activePath, 'active');
    await writeFile(stalePath, 'stale');
    await indexFile(prisma, activePath);
    await indexFile(prisma, stalePath);
    const removed = await removeStaleEntries(prisma, new Set([activePath]));
    expect(removed).toBe(1);
    expect(await prisma.sharedFile.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scanAndIndex
// ---------------------------------------------------------------------------

describe('scanAndIndex', () => {
  it('returns zero counts for empty folder list', async () => {
    const result = await scanAndIndex(prisma, []);
    expect(result.indexed).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('indexes all files in a directory and returns correct count', async () => {
    const dir = join(tmpDir, 'scan-and-index');
    await mkdir(dir);
    await writeFile(join(dir, 'one.txt'), 'one');
    await writeFile(join(dir, 'two.txt'), 'two');
    const result = await scanAndIndex(prisma, [dir]);
    expect(result.indexed).toBe(2);
    expect(result.removed).toBe(0);
    expect(await prisma.sharedFile.count()).toBe(2);
  });

  it('removes stale DB entries for files that no longer exist', async () => {
    const dir = join(tmpDir, 'scan-stale');
    await mkdir(dir);
    const stalePath = join(dir, 'stale.txt');
    await writeFile(stalePath, 'stale');
    await scanAndIndex(prisma, [dir]);
    await rm(stalePath);
    const result = await scanAndIndex(prisma, [dir]);
    expect(result.removed).toBe(1);
    expect(await prisma.sharedFile.count()).toBe(0);
  });

  it('scans multiple directories', async () => {
    const dir1 = join(tmpDir, 'multi-scan-1');
    const dir2 = join(tmpDir, 'multi-scan-2');
    await mkdir(dir1);
    await mkdir(dir2);
    await writeFile(join(dir1, 'file1.txt'), 'one');
    await writeFile(join(dir2, 'file2.txt'), 'two');
    const result = await scanAndIndex(prisma, [dir1, dir2]);
    expect(result.indexed).toBe(2);
    expect(await prisma.sharedFile.count()).toBe(2);
  });

  it('does not duplicate records on repeated scans', async () => {
    const dir = join(tmpDir, 'scan-repeat');
    await mkdir(dir);
    await writeFile(join(dir, 'stable.txt'), 'stable');
    await scanAndIndex(prisma, [dir]);
    await scanAndIndex(prisma, [dir]);
    expect(await prisma.sharedFile.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// startPeriodicRescan
// ---------------------------------------------------------------------------

describe('startPeriodicRescan', () => {
  it('returns a no-op stop function when intervalMinutes is 0', () => {
    const stop = startPeriodicRescan(prisma, async () => [], 0);
    expect(typeof stop).toBe('function');
    stop();
  });

  it('returns a stop function when interval is positive', () => {
    const stop = startPeriodicRescan(prisma, async () => [], 60);
    expect(typeof stop).toBe('function');
    stop();
  });

  it('calls getFolders after the interval fires', async () => {
    let calls = 0;
    const getFolders = async () => {
      calls++;
      return [];
    };
    const intervalMs = 40;
    const stop = startPeriodicRescan(prisma, getFolders, intervalMs / 60_000);
    await Bun.sleep(70);
    stop();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('stop function prevents further calls', async () => {
    let calls = 0;
    const getFolders = async () => {
      calls++;
      return [];
    };
    const stop = startPeriodicRescan(prisma, getFolders, 30 / 60_000);
    stop();
    await Bun.sleep(60);
    expect(calls).toBe(0);
  });
});
