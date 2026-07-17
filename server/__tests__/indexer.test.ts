import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { count, eq } from 'drizzle-orm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'fs';

import { type Db, applyMigrations, createDb } from '../db';
import {
  hashFile,
  indexFile,
  removeIndexedFile,
  removeStaleEntries,
  scanAndIndex,
  scanDirectory,
  startPeriodicRescan,
} from '../indexer';
import { sharedFiles } from '../schema';

const TEST_DB_URL = 'file:./data/test-indexer.db';
let db: Db;
let tmpDir: string;

function fileCount() {
  return db.select({ c: count() }).from(sharedFiles).get()?.c ?? 0;
}

function findFile(path: string) {
  return db.select().from(sharedFiles).where(eq(sharedFiles.path, path)).get() ?? null;
}

beforeAll(async () => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-test-'));
});

afterAll(async () => {
  db.$client.close();
  await rm(tmpDir, { recursive: true, force: true });
  try {
    unlinkSync('./data/test-indexer.db');
  } catch {}
});

beforeEach(() => {
  db.delete(sharedFiles).run();
});

async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const results: string[] = [];
  for await (const f of gen) results.push(f);
  return results;
}

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
    const dir = join(tmpDir, 'scan-lstat-eacces');
    const subDir = join(dir, 'sub');
    await mkdir(dir);
    await mkdir(subDir);
    await writeFile(join(subDir, 'file.txt'), 'content');
    const inaccessibleDirs = new Set<string>();
    await chmod(dir, 0o400);
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

describe('indexFile', () => {
  it('creates a SharedFile record for a new file', async () => {
    const path = join(tmpDir, 'index-new.txt');
    await writeFile(path, 'new file content');
    const record = await indexFile(db, path);
    expect(record.path).toBe(path);
    expect(record.filename).toBe('index-new.txt');
    expect(record.sha256).toHaveLength(64);
    expect(record.size).toBeGreaterThan(0n);
    expect(fileCount()).toBe(1);
  });

  it('stores the correct size', async () => {
    const content = 'exactly this content';
    const path = join(tmpDir, 'index-size.txt');
    await writeFile(path, content);
    const record = await indexFile(db, path);
    expect(record.size).toBe(BigInt(Buffer.byteLength(content)));
  });

  it('returns the existing record without re-indexing when file is unchanged', async () => {
    const path = join(tmpDir, 'index-unchanged.txt');
    await writeFile(path, 'content');
    const first = await indexFile(db, path);
    const second = await indexFile(db, path);
    expect(second.id).toBe(first.id);
    expect(second.sha256).toBe(first.sha256);
    expect(fileCount()).toBe(1);
  });

  it('updates the record when the file content changes', async () => {
    const path = join(tmpDir, 'index-changed.txt');
    await writeFile(path, 'short');
    const first = await indexFile(db, path);
    await writeFile(path, 'much longer content here');
    const second = await indexFile(db, path);
    expect(second.id).toBe(first.id);
    expect(second.sha256).not.toBe(first.sha256);
    expect(second.size).toBeGreaterThan(first.size);
    expect(fileCount()).toBe(1);
  });

  it('stores mimeType based on extension', async () => {
    const path = join(tmpDir, 'index-mime.txt');
    await writeFile(path, 'text');
    const record = await indexFile(db, path);
    expect(record.mimeType).toBeTruthy();
  });

  it('updates indexedAt when file content changes', async () => {
    const path = join(tmpDir, 'index-indexedat.txt');
    await writeFile(path, 'original');
    const first = await indexFile(db, path);
    await Bun.sleep(5);
    await writeFile(path, 'changed content');
    const second = await indexFile(db, path);
    expect(second.indexedAt!.getTime()).toBeGreaterThan(first.indexedAt!.getTime());
  });

  it('rejects a symlink — does not follow it (TOCTOU guard)', async () => {
    const target = join(tmpDir, 'symlink-target.txt');
    const link = join(tmpDir, 'symlink-link.txt');
    await writeFile(target, 'real content');
    await symlink(target, link);
    await expect(indexFile(db, link)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fileCount()).toBe(0);
  });

  it('rejects a directory path', async () => {
    const dir = join(tmpDir, 'index-dir-reject');
    await mkdir(dir);
    await expect(indexFile(db, dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not update indexedAt on cache hit', async () => {
    const path = join(tmpDir, 'index-indexedat-noop.txt');
    await writeFile(path, 'stable');
    const first = await indexFile(db, path);
    const second = await indexFile(db, path);
    expect(second.indexedAt!.getTime()).toBe(first.indexedAt!.getTime());
  });
});

describe('removeStaleEntries', () => {
  it('removes records with lastSeenAt before scanStart', async () => {
    const path = join(tmpDir, 'stale-remove.txt');
    await writeFile(path, 'stale');
    await indexFile(db, path, new Date(1000));
    const removed = await removeStaleEntries(db, new Date());
    expect(removed).toBe(1);
    expect(findFile(path)).toBeNull();
  });

  it('keeps records with lastSeenAt equal to scanStart', async () => {
    const scanStart = new Date();
    const path = join(tmpDir, 'active-keep.txt');
    await writeFile(path, 'active');
    await indexFile(db, path, scanStart);
    const removed = await removeStaleEntries(db, scanStart);
    expect(removed).toBe(0);
    expect(findFile(path)).not.toBeNull();
  });

  it('removes only stale records when active and stale records coexist', async () => {
    const scanStart = new Date();
    const activePath = join(tmpDir, 'coexist-active.txt');
    const stalePath = join(tmpDir, 'coexist-stale.txt');
    await writeFile(activePath, 'active');
    await writeFile(stalePath, 'stale');
    await indexFile(db, activePath, scanStart);
    await indexFile(db, stalePath, new Date(1000));
    const removed = await removeStaleEntries(db, scanStart);
    expect(removed).toBe(1);
    expect(fileCount()).toBe(1);
  });

  it('preserves stale records under protected roots', async () => {
    const protectedDir = join(tmpDir, 'protected-root');
    await mkdir(protectedDir);
    const protectedPath = join(protectedDir, 'protected.txt');
    await writeFile(protectedPath, 'keep me');
    await indexFile(db, protectedPath, new Date(1000));
    const removed = await removeStaleEntries(db, new Date(), [protectedDir]);
    expect(removed).toBe(0);
    expect(findFile(protectedPath)).not.toBeNull();
  });

  it('removes stale records outside protected roots', async () => {
    const protectedDir = join(tmpDir, 'protected-root2');
    await mkdir(protectedDir);
    const protectedPath = join(protectedDir, 'keep.txt');
    const stalePath = join(tmpDir, 'not-protected-stale.txt');
    await writeFile(protectedPath, 'keep');
    await writeFile(stalePath, 'stale');
    await indexFile(db, protectedPath, new Date(1000));
    await indexFile(db, stalePath, new Date(1000));
    const removed = await removeStaleEntries(db, new Date(), [protectedDir]);
    expect(removed).toBe(1);
    expect(findFile(protectedPath)).not.toBeNull();
    expect(findFile(stalePath)).toBeNull();
  });

  it('preserves a stale record whose path exactly equals the protected root', async () => {
    const filePath = join(tmpDir, 'exact-root-match.txt');
    await writeFile(filePath, 'exact');
    await indexFile(db, filePath, new Date(1000));
    const removed = await removeStaleEntries(db, new Date(), [filePath]);
    expect(removed).toBe(0);
    expect(findFile(filePath)).not.toBeNull();
  });

  it('treats % and _ in protected root paths as literal characters, not LIKE wildcards', async () => {
    // Directory whose name contains LIKE metacharacters
    const specialDir = join(tmpDir, '100%_music');
    await mkdir(specialDir);
    const protectedPath = join(specialDir, 'song.mp3');
    // A file in a different dir that would accidentally match if % were a wildcard
    const otherDir = join(tmpDir, '100x_music');
    await mkdir(otherDir);
    const otherPath = join(otherDir, 'song.mp3');
    await writeFile(protectedPath, 'keep');
    await writeFile(otherPath, 'stale');
    await indexFile(db, protectedPath, new Date(1000));
    await indexFile(db, otherPath, new Date(1000));
    const removed = await removeStaleEntries(db, new Date(), [specialDir]);
    expect(removed).toBe(1);
    expect(findFile(protectedPath)).not.toBeNull();
    expect(findFile(otherPath)).toBeNull();
  });
});

describe('removeIndexedFile', () => {
  it('removes the record for the given path', async () => {
    const path = join(tmpDir, 'remove-indexed.txt');
    await writeFile(path, 'content');
    await indexFile(db, path);
    expect(findFile(path)).not.toBeNull();

    await removeIndexedFile(db, path);
    expect(findFile(path)).toBeNull();
  });

  it('is a no-op when no record exists for the path', async () => {
    const path = join(tmpDir, 'remove-indexed-missing.txt');
    await removeIndexedFile(db, path);
    expect(findFile(path)).toBeNull();
  });
});

describe('scanAndIndex', () => {
  it('returns zero counts for empty folder list', async () => {
    const result = await scanAndIndex(db, []);
    expect(result.indexed).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.skipped).toBe(false);
  });

  it('indexes all files in a directory and returns correct count', async () => {
    const dir = join(tmpDir, 'scan-and-index');
    await mkdir(dir);
    await writeFile(join(dir, 'one.txt'), 'one');
    await writeFile(join(dir, 'two.txt'), 'two');
    const result = await scanAndIndex(db, [dir]);
    expect(result.indexed).toBe(2);
    expect(result.removed).toBe(0);
    expect(fileCount()).toBe(2);
  });

  it('removes stale DB entries for files that no longer exist', async () => {
    const dir = join(tmpDir, 'scan-stale');
    await mkdir(dir);
    const stalePath = join(dir, 'stale.txt');
    await writeFile(stalePath, 'stale');
    await scanAndIndex(db, [dir]);
    await rm(stalePath);
    const result = await scanAndIndex(db, [dir]);
    expect(result.removed).toBe(1);
    expect(fileCount()).toBe(0);
  });

  it('scans multiple directories', async () => {
    const dir1 = join(tmpDir, 'multi-scan-1');
    const dir2 = join(tmpDir, 'multi-scan-2');
    await mkdir(dir1);
    await mkdir(dir2);
    await writeFile(join(dir1, 'file1.txt'), 'one');
    await writeFile(join(dir2, 'file2.txt'), 'two');
    const result = await scanAndIndex(db, [dir1, dir2]);
    expect(result.indexed).toBe(2);
    expect(fileCount()).toBe(2);
  });

  it('does not duplicate records on repeated scans', async () => {
    const dir = join(tmpDir, 'scan-repeat');
    await mkdir(dir);
    await writeFile(join(dir, 'stable.txt'), 'stable');
    await scanAndIndex(db, [dir]);
    await scanAndIndex(db, [dir]);
    expect(fileCount()).toBe(1);
  });

  it('returns skipped: true when a scan is already in progress', async () => {
    const dir = join(tmpDir, 'scan-concurrent');
    await mkdir(dir);
    await writeFile(join(dir, 'file.txt'), 'data');
    const [first, second] = await Promise.all([scanAndIndex(db, [dir]), scanAndIndex(db, [dir])]);
    const skippedOne = [first, second].find((r) => r.skipped);
    const ranOne = [first, second].find((r) => !r.skipped);
    expect(skippedOne).toBeDefined();
    expect(ranOne).toBeDefined();
    expect(skippedOne!.indexed).toBe(0);
    expect(ranOne!.indexed).toBeGreaterThanOrEqual(1);
  });

  it('treats a regular file configured as a shared folder as inaccessible', async () => {
    const filePath = join(tmpDir, 'shared-folder-is-file.txt');
    await writeFile(filePath, 'I am a file, not a folder');
    const result = await scanAndIndex(db, [filePath]);
    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(false);
  });

  it('treats a symlink configured as a shared folder as inaccessible', async () => {
    const realDir = join(tmpDir, 'symlink-target-dir');
    await mkdir(realDir);
    await writeFile(join(realDir, 'inner.txt'), 'content');
    const linkPath = join(tmpDir, 'symlink-shared-folder');
    await symlink(realDir, linkPath);
    const result = await scanAndIndex(db, [linkPath]);
    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(false);
  });

  it('preserves indexed files when their shared folder is temporarily inaccessible', async () => {
    const dir = join(tmpDir, 'inaccessible-folder');
    await mkdir(dir);
    const filePath = join(dir, 'important.txt');
    await writeFile(filePath, 'important');
    await scanAndIndex(db, [dir]);
    expect(fileCount()).toBe(1);
    await rm(dir, { recursive: true });
    const result = await scanAndIndex(db, [dir]);
    expect(result.removed).toBe(0);
    expect(fileCount()).toBe(1);
  });

  it('preserves indexed files when root folder loses readability after lstat passes', async () => {
    const dir = join(tmpDir, 'perms-gone-readdir');
    await mkdir(dir);
    const filePath = join(dir, 'locked.txt');
    await writeFile(filePath, 'keep me');
    await scanAndIndex(db, [dir]);
    expect(fileCount()).toBe(1);
    await chmod(dir, 0o000);
    try {
      const result = await scanAndIndex(db, [dir]);
      expect(result.removed).toBe(0);
      expect(fileCount()).toBe(1);
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
    await scanAndIndex(db, [dir]);
    expect(fileCount()).toBe(1);
    await chmod(subDir, 0o000);
    try {
      const result = await scanAndIndex(db, [dir]);
      expect(result.removed).toBe(0);
      expect(fileCount()).toBe(1);
    } finally {
      await chmod(subDir, 0o755);
    }
  });

  it('preserves indexed record when a file becomes unreadable during re-indexing', async () => {
    const dir = join(tmpDir, 'file-unreadable-reindex');
    await mkdir(dir);
    const filePath = join(dir, 'secret.txt');
    await writeFile(filePath, 'initial content');
    await scanAndIndex(db, [dir]);
    expect(fileCount()).toBe(1);
    await writeFile(filePath, 'changed content that cannot be read back');
    await chmod(filePath, 0o000);
    try {
      const result = await scanAndIndex(db, [dir]);
      expect(result.removed).toBe(0);
      expect(fileCount()).toBe(1);
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
    await scanAndIndex(db, [goodDir, badDir]);
    expect(fileCount()).toBe(2);
    await rm(goodFile);
    await rm(badDir, { recursive: true });
    const result = await scanAndIndex(db, [goodDir, badDir]);
    expect(result.removed).toBe(1);
    expect(fileCount()).toBe(1);
    expect(findFile(badFile)).not.toBeNull();
  });
});

describe('startPeriodicRescan', () => {
  it('returns a no-op stop function when intervalMinutes is 0', () => {
    const stop = startPeriodicRescan(
      db,
      async () => [],
      async () => 0,
    );
    expect(typeof stop).toBe('function');
    stop();
  });

  it('returns a stop function when interval is positive', () => {
    const stop = startPeriodicRescan(
      db,
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
    const stop = startPeriodicRescan(db, getFolders, async () => 40 / 60_000);
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
    const stop = startPeriodicRescan(db, getFolders, async () => 30 / 60_000);
    stop();
    await Bun.sleep(60);
    expect(calls).toBe(1);
  });

  it('picks up an updated interval on the next tick', async () => {
    let calls = 0;
    let intervalMs = 200;
    const getFolders = async () => {
      calls++;
      intervalMs = 20;
      return [];
    };
    const stop = startPeriodicRescan(db, getFolders, async () => intervalMs / 60_000);
    await Bun.sleep(250);
    stop();
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
    const stop = startPeriodicRescan(db, getFolders, async () => 25 / 60_000);
    await Bun.sleep(100);
    stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('does not reschedule quickly when getIntervalMinutes returns a value that would overflow setTimeout', async () => {
    let calls = 0;
    const getFolders = async () => {
      calls++;
      return [];
    };
    const stop = startPeriodicRescan(db, getFolders, async () => 35792);
    await Bun.sleep(50);
    stop();
    expect(calls).toBe(1);
  });

  it('does not reschedule quickly when getIntervalMinutes returns NaN', async () => {
    let calls = 0;
    const getFolders = async () => {
      calls++;
      return [];
    };
    const stop = startPeriodicRescan(db, getFolders, async () => NaN);
    await Bun.sleep(50);
    stop();
    expect(calls).toBe(1);
  });
});
