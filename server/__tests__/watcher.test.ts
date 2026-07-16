import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'fs';

import { type Db, applyMigrations, createDb } from '../db';
import { type FileWatcherHandle, type FileWatcherOptions, startFileWatcher } from '../watcher';
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
