import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const results: string[] = [];
  for await (const f of gen) results.push(f);
  return results;
}

describe('scanDirectory', () => {
  it('yields no paths for an empty directory', async () => {
    const dir = join(tmpDir, 'scan-empty');
    await mkdir(dir);
    expect(await collect(scanDirectory(dir))).toEqual([]);
  });

  it('yields files in a flat directory', async () => {
    const dir = join(tmpDir, 'scan-flat');
    await mkdir(dir);
    await writeFile(join(dir, 'a.txt'), 'a');
    await writeFile(join(dir, 'b.txt'), 'b');
    const files = await collect(scanDirectory(dir));
    expect(files.sort()).toEqual([join(dir, 'a.txt'), join(dir, 'b.txt')]);
  });

  it('recurses into subdirectories', async () => {
    const dir = join(tmpDir, 'scan-recursive');
    await mkdir(dir);
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'root.txt'), 'r');
    await writeFile(join(dir, 'sub', 'nested.txt'), 'n');
    const files = await collect(scanDirectory(dir));
    expect(files.sort()).toEqual([join(dir, 'root.txt'), join(dir, 'sub', 'nested.txt')]);
  });

  it('ignores hidden files and directories', async () => {
    const dir = join(tmpDir, 'scan-hidden');
    await mkdir(dir);
    await mkdir(join(dir, '.hidden-dir'));
    await writeFile(join(dir, 'visible.txt'), 'v');
    await writeFile(join(dir, '.hidden.txt'), 'h');
    await writeFile(join(dir, '.hidden-dir', 'inside.txt'), 'i');
    const files = await collect(scanDirectory(dir));
    expect(files).toEqual([join(dir, 'visible.txt')]);
  });

  it('yields nothing for a nonexistent directory', async () => {
    expect(await collect(scanDirectory(join(tmpDir, 'does-not-exist')))).toEqual([]);
  });

  it('ignores symlinks', async () => {
    const dir = join(tmpDir, 'scan-symlinks');
    await mkdir(dir);
    await writeFile(join(dir, 'real.txt'), 'real');
    await symlink(join(dir, 'real.txt'), join(dir, 'link.txt'));
    const files = await collect(scanDirectory(dir));
    expect(files).toEqual([join(dir, 'real.txt')]);
  });

  it('yields nothing when path points to a file instead of a directory (ENOTDIR)', async () => {
    const filePath = join(tmpDir, 'not-a-dir.txt');
    await writeFile(filePath, 'I am a file');
    expect(await collect(scanDirectory(filePath))).toEqual([]);
  });

  it('reports entries whose lstat fails as inaccessible', async () => {
    // Remove execute permission on parent so lstat of children fails with EACCES
    const dir = join(tmpDir, 'scan-lstat-eacces');
    const subDir = join(dir, 'sub');
    await mkdir(dir);
    await mkdir(subDir);
    await writeFile(join(subDir, 'file.txt'), 'content');
    const inaccessibleDirs = new Set<string>();
    await chmod(dir, 0o400); // readable but not executable — lstat on children fails
    try {
      await collect(scanDirectory(dir, false, inaccessibleDirs));
      expect(inaccessibleDirs.has(subDir)).toBe(true);
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it('reports inaccessible subdirectories via inaccessibleDirs set', async () => {
    const dir = join(tmpDir, 'scan-report-inaccessible');
    const subDir = join(dir, 'locked-sub');
    await mkdir(dir);
    await mkdir(subDir);
    await writeFile(join(subDir, 'hidden.txt'), 'content');
    const inaccessibleDirs = new Set<string>();
    await chmod(subDir, 0o000);
    try {
      const files = await collect(scanDirectory(dir, false, inaccessibleDirs));
      expect(files).toEqual([]);
      expect(inaccessibleDirs.has(subDir)).toBe(true);
    } finally {
      await chmod(subDir, 0o755);
    }
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

  it('updates indexedAt when file content changes', async () => {
    const path = join(tmpDir, 'index-indexedat.txt');
    await writeFile(path, 'original');
    const first = await indexFile(prisma, path);
    await Bun.sleep(5);
    await writeFile(path, 'changed content');
    const second = await indexFile(prisma, path);
    expect(second.indexedAt.getTime()).toBeGreaterThan(first.indexedAt.getTime());
  });

  it('does not update indexedAt on cache hit', async () => {
    const path = join(tmpDir, 'index-indexedat-noop.txt');
    await writeFile(path, 'stable');
    const first = await indexFile(prisma, path);
    const second = await indexFile(prisma, path);
    expect(second.indexedAt.getTime()).toBe(first.indexedAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// removeStaleEntries
// ---------------------------------------------------------------------------

describe('removeStaleEntries', () => {
  it('removes records with lastSeenAt before scanStart', async () => {
    const path = join(tmpDir, 'stale-remove.txt');
    await writeFile(path, 'stale');
    // Index with an old timestamp to simulate a prior scan
    await indexFile(prisma, path, new Date(1000));
    const removed = await removeStaleEntries(prisma, new Date());
    expect(removed).toBe(1);
    expect(await prisma.sharedFile.findFirst({ where: { path } })).toBeNull();
  });

  it('keeps records with lastSeenAt equal to scanStart', async () => {
    const scanStart = new Date();
    const path = join(tmpDir, 'active-keep.txt');
    await writeFile(path, 'active');
    await indexFile(prisma, path, scanStart);
    const removed = await removeStaleEntries(prisma, scanStart);
    expect(removed).toBe(0);
    expect(await prisma.sharedFile.findFirst({ where: { path } })).not.toBeNull();
  });

  it('removes only stale records when active and stale records coexist', async () => {
    const scanStart = new Date();
    const activePath = join(tmpDir, 'coexist-active.txt');
    const stalePath = join(tmpDir, 'coexist-stale.txt');
    await writeFile(activePath, 'active');
    await writeFile(stalePath, 'stale');
    await indexFile(prisma, activePath, scanStart);
    await indexFile(prisma, stalePath, new Date(1000)); // old scan
    const removed = await removeStaleEntries(prisma, scanStart);
    expect(removed).toBe(1);
    expect(await prisma.sharedFile.count()).toBe(1);
  });

  it('preserves stale records under protected roots', async () => {
    const protectedDir = join(tmpDir, 'protected-root');
    await mkdir(protectedDir);
    const protectedPath = join(protectedDir, 'protected.txt');
    await writeFile(protectedPath, 'keep me');
    await indexFile(prisma, protectedPath, new Date(1000));
    const removed = await removeStaleEntries(prisma, new Date(), [protectedDir]);
    expect(removed).toBe(0);
    expect(await prisma.sharedFile.findFirst({ where: { path: protectedPath } })).not.toBeNull();
  });

  it('removes stale records outside protected roots', async () => {
    const protectedDir = join(tmpDir, 'protected-root2');
    await mkdir(protectedDir);
    const protectedPath = join(protectedDir, 'keep.txt');
    const stalePath = join(tmpDir, 'not-protected-stale.txt');
    await writeFile(protectedPath, 'keep');
    await writeFile(stalePath, 'stale');
    await indexFile(prisma, protectedPath, new Date(1000));
    await indexFile(prisma, stalePath, new Date(1000));
    const removed = await removeStaleEntries(prisma, new Date(), [protectedDir]);
    expect(removed).toBe(1);
    expect(await prisma.sharedFile.findFirst({ where: { path: protectedPath } })).not.toBeNull();
    expect(await prisma.sharedFile.findFirst({ where: { path: stalePath } })).toBeNull();
  });

  it('preserves a stale record whose path exactly equals the protected root', async () => {
    const filePath = join(tmpDir, 'exact-root-match.txt');
    await writeFile(filePath, 'exact');
    await indexFile(prisma, filePath, new Date(1000));
    // Protect the file's own path (as if it were a non-directory "shared folder")
    const removed = await removeStaleEntries(prisma, new Date(), [filePath]);
    expect(removed).toBe(0);
    expect(await prisma.sharedFile.findFirst({ where: { path: filePath } })).not.toBeNull();
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
    expect(result.skipped).toBe(false);
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

  it('returns skipped: true when a scan is already in progress', async () => {
    const dir = join(tmpDir, 'scan-concurrent');
    await mkdir(dir);
    await writeFile(join(dir, 'file.txt'), 'data');
    const [first, second] = await Promise.all([
      scanAndIndex(prisma, [dir]),
      scanAndIndex(prisma, [dir]),
    ]);
    // Exactly one ran, the other was skipped
    const skippedOne = [first, second].find((r) => r.skipped);
    const ranOne = [first, second].find((r) => !r.skipped);
    expect(skippedOne).toBeDefined();
    expect(ranOne).toBeDefined();
    expect(skippedOne!.indexed).toBe(0);
    expect(skippedOne!.removed).toBe(0);
    expect(ranOne!.indexed).toBeGreaterThanOrEqual(1);
  });

  it('treats a regular file configured as a shared folder as inaccessible', async () => {
    const filePath = join(tmpDir, 'shared-folder-is-file.txt');
    await writeFile(filePath, 'I am a file, not a folder');
    const result = await scanAndIndex(prisma, [filePath]);
    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(false);
  });

  it('treats a symlink configured as a shared folder as inaccessible', async () => {
    const realDir = join(tmpDir, 'symlink-target-dir');
    await mkdir(realDir);
    await writeFile(join(realDir, 'inner.txt'), 'content');
    const linkPath = join(tmpDir, 'symlink-shared-folder');
    await symlink(realDir, linkPath);
    const result = await scanAndIndex(prisma, [linkPath]);
    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(false);
  });

  it('preserves indexed files when their shared folder is temporarily inaccessible', async () => {
    const dir = join(tmpDir, 'inaccessible-folder');
    await mkdir(dir);
    const filePath = join(dir, 'important.txt');
    await writeFile(filePath, 'important');
    // Initial scan indexes the file
    await scanAndIndex(prisma, [dir]);
    expect(await prisma.sharedFile.count()).toBe(1);
    // Simulate folder disappearing (e.g. external drive unplugged)
    await rm(dir, { recursive: true });
    // Re-scan with the same folder list — folder is now inaccessible
    const result = await scanAndIndex(prisma, [dir]);
    expect(result.removed).toBe(0);
    expect(await prisma.sharedFile.count()).toBe(1);
  });

  it('preserves indexed files when root folder loses readability after lstat passes', async () => {
    const dir = join(tmpDir, 'perms-gone-readdir');
    await mkdir(dir);
    const filePath = join(dir, 'locked.txt');
    await writeFile(filePath, 'keep me');
    await scanAndIndex(prisma, [dir]);
    expect(await prisma.sharedFile.count()).toBe(1);

    // lstat still sees a directory, but readdir fails with EACCES
    await chmod(dir, 0o000);
    try {
      const result = await scanAndIndex(prisma, [dir]);
      expect(result.removed).toBe(0);
      expect(await prisma.sharedFile.count()).toBe(1);
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it('preserves indexed files when a subdirectory becomes unreadable mid-scan', async () => {
    const dir = join(tmpDir, 'inaccessible-subdir');
    const subDir = join(dir, 'sub');
    await mkdir(dir);
    await mkdir(subDir);
    const filePath = join(subDir, 'nested.txt');
    await writeFile(filePath, 'keep me');
    await scanAndIndex(prisma, [dir]);
    expect(await prisma.sharedFile.count()).toBe(1);

    // Subdir becomes unreadable — lstat on parent succeeds, readdir on subdir fails
    await chmod(subDir, 0o000);
    try {
      const result = await scanAndIndex(prisma, [dir]);
      expect(result.removed).toBe(0);
      expect(await prisma.sharedFile.count()).toBe(1);
    } finally {
      await chmod(subDir, 0o755);
    }
  });

  it('preserves indexed record when a file becomes unreadable during re-indexing', async () => {
    const dir = join(tmpDir, 'file-unreadable-reindex');
    await mkdir(dir);
    const filePath = join(dir, 'secret.txt');
    await writeFile(filePath, 'initial content');
    await scanAndIndex(prisma, [dir]);
    expect(await prisma.sharedFile.count()).toBe(1);

    // Update content (changes mtime/size), then lock the file so hashing fails with EACCES
    await writeFile(filePath, 'changed content that cannot be read back');
    await chmod(filePath, 0o000);
    try {
      const result = await scanAndIndex(prisma, [dir]);
      expect(result.removed).toBe(0);
      expect(await prisma.sharedFile.count()).toBe(1);
    } finally {
      await chmod(filePath, 0o644);
    }
  });

  it('removes stale files from accessible folders even when another folder is inaccessible', async () => {
    const goodDir = join(tmpDir, 'good-folder');
    const badDir = join(tmpDir, 'bad-folder');
    await mkdir(goodDir);
    await mkdir(badDir);
    const goodFile = join(goodDir, 'good.txt');
    const badFile = join(badDir, 'bad.txt');
    await writeFile(goodFile, 'good');
    await writeFile(badFile, 'bad');
    await scanAndIndex(prisma, [goodDir, badDir]);
    expect(await prisma.sharedFile.count()).toBe(2);
    // Remove the file from goodDir and the entire badDir
    await rm(goodFile);
    await rm(badDir, { recursive: true });
    const result = await scanAndIndex(prisma, [goodDir, badDir]);
    // goodFile is stale (folder is accessible but file is gone) → removed
    // badFile is under inaccessible badDir → preserved
    expect(result.removed).toBe(1);
    expect(await prisma.sharedFile.count()).toBe(1);
    expect(await prisma.sharedFile.findFirst({ where: { path: badFile } })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startPeriodicRescan
// ---------------------------------------------------------------------------

describe('startPeriodicRescan', () => {
  it('returns a no-op stop function when intervalMinutes is 0', () => {
    const stop = startPeriodicRescan(
      prisma,
      async () => [],
      async () => 0,
    );
    expect(typeof stop).toBe('function');
    stop();
  });

  it('returns a stop function when interval is positive', () => {
    const stop = startPeriodicRescan(
      prisma,
      async () => [],
      async () => 60,
    );
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
    const stop = startPeriodicRescan(prisma, getFolders, async () => intervalMs / 60_000);
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
    const stop = startPeriodicRescan(prisma, getFolders, async () => 30 / 60_000);
    stop();
    await Bun.sleep(60);
    expect(calls).toBe(0);
  });

  it('picks up an updated interval on the next tick', async () => {
    let calls = 0;
    let intervalMs = 200; // starts slow
    const getFolders = async () => {
      calls++;
      intervalMs = 20; // speed up after first call
      return [];
    };
    const stop = startPeriodicRescan(prisma, getFolders, async () => intervalMs / 60_000);
    await Bun.sleep(250); // first tick fires at ~200ms
    stop();
    // after the first call, interval drops to 20ms — we may get more calls
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('reschedules after getFolders throws', async () => {
    let calls = 0;
    let shouldThrow = true;
    const getFolders = async () => {
      calls++;
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('transient getFolders error');
      }
      return [];
    };
    const stop = startPeriodicRescan(prisma, getFolders, async () => 25 / 60_000);
    await Bun.sleep(100);
    stop();
    // First call throws, but rescan is rescheduled and fires again
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('does not fire immediately when getIntervalMinutes returns NaN', async () => {
    let calls = 0;
    const getFolders = async () => {
      calls++;
      return [];
    };
    const stop = startPeriodicRescan(prisma, getFolders, async () => NaN);
    await Bun.sleep(50);
    stop();
    // NaN → treated as disabled → 60-second fallback, not an immediate fire
    expect(calls).toBe(0);
  });
});
