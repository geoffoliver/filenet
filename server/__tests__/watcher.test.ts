import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'fs';

import { type Db, applyMigrations, createDb } from '../db';
import {
  type FileWatcherHandle,
  type FileWatcherOptions,
  isIgnoredPath,
  startFileWatcher,
} from '../watcher';
import { sharedFiles } from '../schema';

const TEST_DB_URL = 'file:./data/test-watcher.db';
let db: Db;
let tmpDir: string;
let handle: FileWatcherHandle | null = null;

// Test-only tuning: fast enough to keep the suite quick, still exercises
// the real debounce/grace-period code paths.
const FAST_OPTIONS = { deleteGraceMs: 50, stabilityThresholdMs: 20 };

// chokidar's initial readdir must finish before `ignoreInitial: true` stops
// treating a newly-written file as part of the "initial" state. A file
// created before this settles (or before the watcher is even started) will
// never fire `add` — it's silently treated as pre-existing. This margin is
// generous relative to that readdir, which is near-instant for the tiny
// temp directories these tests use.
const WARMUP_MS = 200;

// Separately: starting a watcher immediately after writing a file can make
// macOS FSEvents replay that very-recent write as a live event once the
// watcher attaches, bypassing ignoreInitial entirely (independently
// verified — a longer WARMUP_MS *after* starting does not help; only a gap
// *before* starting does, and 500ms+ eliminates it). Use this wherever a
// test deliberately writes a file before starting the watcher.
const PRE_EXISTING_SETTLE_MS = 600;

function findFile(path: string) {
  return db.select().from(sharedFiles).where(eq(sharedFiles.path, path)).get() ?? null;
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await Bun.sleep(20);
  }
}

// Starts the watcher and waits out WARMUP_MS before returning, so callers
// can immediately write files that are guaranteed to be seen as new (not
// swallowed by ignoreInitial). Always start the watcher on an empty/already-
// stable directory when using this helper — anything written to `folders`
// before this resolves is still at risk of being treated as pre-existing.
async function startWatcher(
  folders: string[],
  options: FileWatcherOptions = FAST_OPTIONS,
): Promise<FileWatcherHandle> {
  const h = startFileWatcher(db, folders, options);
  await Bun.sleep(WARMUP_MS);
  return h;
}

beforeAll(async () => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-watcher-test-'));
});

afterAll(async () => {
  db.$client.close();
  await rm(tmpDir, { recursive: true, force: true });
  try {
    unlinkSync('./data/test-watcher.db');
  } catch {}
});

beforeEach(() => {
  db.delete(sharedFiles).run();
});

afterEach(() => {
  handle?.stop();
  handle = null;
});

describe('isIgnoredPath', () => {
  // Pure-logic tests, deterministic on any OS: chokidar always hands
  // `ignored` a forward-slash-normalized path (even on Windows), while a
  // configured folder can still be backslash-based if the app is running
  // on Windows. These exercise that exact mismatch without needing an
  // actual Windows machine.
  it('does not ignore the watched root itself, given a Windows-style backslash folder', () => {
    expect(isIgnoredPath('C:/Users/geoff/Movies', ['C:\\Users\\geoff\\Movies'])).toBe(false);
  });

  it('does not ignore a normal file below a Windows-style watched root', () => {
    expect(isIgnoredPath('C:/Users/geoff/Movies/song.mp3', ['C:\\Users\\geoff\\Movies'])).toBe(
      false,
    );
  });

  it('ignores a dotfile below a Windows-style watched root', () => {
    expect(isIgnoredPath('C:/Users/geoff/Movies/.hidden.txt', ['C:\\Users\\geoff\\Movies'])).toBe(
      true,
    );
  });

  it('does not ignore a watched root living under a dotted ancestor', () => {
    expect(isIgnoredPath('/tmp/.dotted-root/nested', ['/tmp/.dotted-root/nested'])).toBe(false);
    expect(
      isIgnoredPath('/tmp/.dotted-root/nested/visible.txt', ['/tmp/.dotted-root/nested']),
    ).toBe(false);
  });

  it('ignores a path under no currently-watched folder', () => {
    expect(isIgnoredPath('/somewhere/else/file.txt', ['/tmp/watched'])).toBe(true);
  });
});

describe('startFileWatcher — add/change', () => {
  it('indexes a file added after the watcher starts', async () => {
    const dir = join(tmpDir, 'watch-add');
    await mkdir(dir);
    handle = await startWatcher([dir]);

    const path = join(dir, 'new.txt');
    await writeFile(path, 'new content');

    await waitFor(() => findFile(path) !== null);
    expect(findFile(path)?.sha256).toHaveLength(64);
  });

  it('re-indexes a file after it changes', async () => {
    const dir = join(tmpDir, 'watch-change');
    await mkdir(dir);
    const path = join(dir, 'existing.txt');
    await writeFile(path, 'original');
    // Let the write settle before starting the watcher (see
    // PRE_EXISTING_SETTLE_MS above) so the OS doesn't replay it as a live
    // event once chokidar attaches.
    await Bun.sleep(PRE_EXISTING_SETTLE_MS);
    handle = startFileWatcher(db, [dir], FAST_OPTIONS);

    // ignoreInitial: true means the pre-existing file above is not indexed
    // by the watcher itself — confirm that. This wait also serves as the
    // watcher's warm-up: only after it elapses is a *new* write guaranteed
    // to be seen as a real change rather than folded into the initial scan.
    await Bun.sleep(WARMUP_MS);
    expect(findFile(path)).toBeNull();

    await writeFile(path, 'changed content');
    await waitFor(() => findFile(path)?.sha256 !== undefined && findFile(path)!.sha256 !== null);
    const record = findFile(path);
    expect(record).not.toBeNull();
  });

  it('does not index a symlink', async () => {
    const dir = join(tmpDir, 'watch-symlink');
    await mkdir(dir);
    handle = await startWatcher([dir]);

    const target = join(dir, 'target.txt');
    await writeFile(target, 'target content');
    await waitFor(() => findFile(target) !== null);

    const link = join(dir, 'link.txt');
    await symlink(target, link);
    await Bun.sleep(150);

    expect(findFile(link)).toBeNull();
  });

  it('removes the stale row when a deleted file is replaced by a symlink before the grace period elapses', async () => {
    const dir = join(tmpDir, 'watch-delete-then-symlink');
    await mkdir(dir);
    handle = await startWatcher([dir], { deleteGraceMs: 8000, stabilityThresholdMs: 20 });

    const target = join(dir, 'target.txt');
    await writeFile(target, 'target content');
    await waitFor(() => findFile(target) !== null);

    const path = join(dir, 'flip.txt');
    await writeFile(path, 'content');
    await waitFor(() => findFile(path) !== null);

    await rm(path);
    await symlink(target, path);

    // Replacing a file with a symlink at the same path fires chokidar's
    // 'change' event here (not 'add' — verified empirically: 20/20 local
    // trials), which cancels the pending delete before its grace period
    // fires. Asserting well before the grace period proves
    // handleAddOrChange's own stale-row cleanup ran, not just eventual
    // grace-period cleanup.
    //
    // The margin here (5000ms, vs. 500ms originally) is deliberately
    // generous rather than tightly calibrated: this test flaked twice in CI
    // (never locally, including full-suite runs under load) with smaller
    // margins (500ms, then 1500ms). The watcher logic itself is correct —
    // confirmed via isolated repro — so the flake is purely GitHub Actions
    // shared-runner scheduling variance delaying chokidar's internal
    // awaitWriteFinish polling, which can't be reproduced or calibrated
    // locally. If this still flakes with this margin, that's new evidence
    // the cause isn't scheduling variance and needs fresh investigation
    // rather than another timeout bump.
    await waitFor(() => findFile(path) === null, 5000);
  });

  it('does not index a dotfile', async () => {
    const dir = join(tmpDir, 'watch-dotfile');
    await mkdir(dir);
    handle = await startWatcher([dir]);

    const path = join(dir, '.hidden.txt');
    await writeFile(path, 'hidden content');
    await Bun.sleep(150);

    expect(findFile(path)).toBeNull();
  });

  it('indexes files under a watched folder whose own path has a dotted segment', async () => {
    // A shared folder living under a dotted ancestor (e.g. ~/.Movies) must
    // not have its own contents excluded — only entries *within* it that
    // themselves start with a dot should be skipped, matching scanDirectory.
    const dottedRoot = join(tmpDir, '.dotted-root');
    const dir = join(dottedRoot, 'nested');
    await mkdir(dir, { recursive: true });
    handle = await startWatcher([dir]);

    const path = join(dir, 'visible.txt');
    await writeFile(path, 'visible content');

    await waitFor(() => findFile(path) !== null);
    expect(findFile(path)?.sha256).toHaveLength(64);
  });
});

describe('startFileWatcher — delete', () => {
  it('does not remove the record immediately on delete', async () => {
    const dir = join(tmpDir, 'watch-delete-immediate');
    await mkdir(dir);
    handle = await startWatcher([dir]);
    const path = join(dir, 'gone.txt');
    await writeFile(path, 'content');
    await waitFor(() => findFile(path) !== null);

    await rm(path);
    // Grace period is 50ms (FAST_OPTIONS) — check well before it elapses.
    await Bun.sleep(10);
    expect(findFile(path)).not.toBeNull();
  });

  it('removes the record after the grace period elapses', async () => {
    const dir = join(tmpDir, 'watch-delete-grace');
    await mkdir(dir);
    handle = await startWatcher([dir]);
    const path = join(dir, 'gone.txt');
    await writeFile(path, 'content');
    await waitFor(() => findFile(path) !== null);

    await rm(path);
    await waitFor(() => findFile(path) === null, 2000);
  });

  it('keeps the record if the file is recreated within the grace period', async () => {
    const dir = join(tmpDir, 'watch-delete-recreate');
    await mkdir(dir);
    // Longer grace period here so the recreate below reliably lands inside the window.
    handle = await startWatcher([dir], { deleteGraceMs: 300, stabilityThresholdMs: 20 });
    const path = join(dir, 'flicker.txt');
    await writeFile(path, 'content');
    await waitFor(() => findFile(path) !== null);

    await rm(path);
    await Bun.sleep(50);
    await writeFile(path, 'content again');

    // Wait past the original grace window; the record must have survived.
    await Bun.sleep(400);
    expect(findFile(path)).not.toBeNull();
  });

  it('logs and does not crash if removing the DB record fails during grace-period confirmation', async () => {
    const dir = join(tmpDir, 'watch-delete-db-error');
    await mkdir(dir);
    const path = join(dir, 'gone.txt');
    await writeFile(path, 'content');
    await Bun.sleep(PRE_EXISTING_SETTLE_MS);

    // A separate watcher instance backed by an already-closed DB connection
    // guarantees removeIndexedFile throws when the grace-period timer
    // fires. Reaching the final assertion below — rather than the process
    // dying from an unhandled rejection — is the proof confirmAndRemove
    // guards that call.
    const brokenDb = createDb('file::memory:');
    applyMigrations(brokenDb);
    brokenDb.$client.close();

    const brokenHandle = startFileWatcher(brokenDb, [dir], {
      deleteGraceMs: 50,
      stabilityThresholdMs: 20,
    });
    await Bun.sleep(WARMUP_MS);

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    await rm(path);
    await Bun.sleep(300);

    brokenHandle.stop();

    expect(errorSpy).toHaveBeenCalled();
    const loggedFailedRemoval = errorSpy.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes('failed to remove deleted file'),
    );
    expect(loggedFailedRemoval).toBe(true);

    errorSpy.mockRestore();
  });
});

describe('startFileWatcher — syncFolders', () => {
  it('starts watching a newly added folder', async () => {
    const dir1 = join(tmpDir, 'sync-add-1');
    const dir2 = join(tmpDir, 'sync-add-2');
    await mkdir(dir1);
    await mkdir(dir2);
    handle = await startWatcher([dir1]);

    handle.syncFolders([dir1, dir2]);
    // chokidar's readdir for the newly-added folder needs the same
    // warm-up as a fresh startFileWatcher() call before writes to it are
    // guaranteed to be seen as new.
    await Bun.sleep(WARMUP_MS);

    const path = join(dir2, 'new-folder-file.txt');
    await writeFile(path, 'content');
    await waitFor(() => findFile(path) !== null);
  });

  it('stops watching a removed folder', async () => {
    const dir1 = join(tmpDir, 'sync-remove-1');
    const dir2 = join(tmpDir, 'sync-remove-2');
    await mkdir(dir1);
    await mkdir(dir2);
    handle = await startWatcher([dir1, dir2]);

    handle.syncFolders([dir1]);
    // Give unwatch() a moment to take effect before proving dir2 is ignored.
    await Bun.sleep(WARMUP_MS);

    const path = join(dir2, 'removed-folder-file.txt');
    await writeFile(path, 'content');
    await Bun.sleep(150);
    expect(findFile(path)).toBeNull();
  });
});

describe('startFileWatcher — stop', () => {
  it('stops indexing after stop() is called', async () => {
    const dir = join(tmpDir, 'stop-basic');
    await mkdir(dir);
    const localHandle = await startWatcher([dir]);
    localHandle.stop();

    const path = join(dir, 'after-stop.txt');
    await writeFile(path, 'content');
    await Bun.sleep(150);
    expect(findFile(path)).toBeNull();
  });

  it('cancels pending deletes on stop() without throwing', async () => {
    const dir = join(tmpDir, 'stop-pending-delete');
    await mkdir(dir);
    const localHandle = await startWatcher([dir], { deleteGraceMs: 500, stabilityThresholdMs: 20 });
    const path = join(dir, 'pending.txt');
    await writeFile(path, 'content');
    await waitFor(() => findFile(path) !== null, 2000);

    await rm(path);
    await Bun.sleep(20); // let the unlink event register a pending timer
    expect(() => localHandle.stop()).not.toThrow();

    // Wait past what would have been the grace period — record must survive
    // since stop() cancelled the pending delete.
    await Bun.sleep(600);
    expect(findFile(path)).not.toBeNull();
  });
});
