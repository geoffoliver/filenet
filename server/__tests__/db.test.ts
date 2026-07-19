import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDb } from '../db';

describe('createDb', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('creates missing parent directories for the database path', () => {
    const root = mkdtempSync(join(tmpdir(), 'filenet-db-'));
    tmpDirs.push(root);
    const dbPath = join(root, 'nested', 'deep', 'filenet.db');

    const db = createDb(dbPath);
    db.$client.close();

    expect(existsSync(dbPath)).toBe(true);
  });

  it('sets a non-zero busy_timeout', () => {
    const root = mkdtempSync(join(tmpdir(), 'filenet-db-'));
    tmpDirs.push(root);
    const db = createDb(join(root, 'filenet.db'));

    const { timeout } = db.$client.query('PRAGMA busy_timeout;').get() as { timeout: number };
    db.$client.close();

    expect(timeout).toBeGreaterThan(0);
  });

  // Regression test for a real production failure: scanning a large library
  // (server/scan-worker.ts) holds the write lock on its own connection to
  // this file for the duration of each file's write; the main thread's
  // periodic reconnect tick (server/reconnect.ts) reads from a *different*
  // connection to the same file and got SQLiteError: database is locked
  // (SQLITE_BUSY) immediately -- SQLite's default busy_timeout is 0, so any
  // momentary lock contention between separate connections fails instantly
  // instead of briefly waiting. Verified against a real background thread
  // (not same-thread timing tricks, which can't reproduce this: a
  // synchronous busy-wait on one thread blocks the whole process, so a
  // same-thread "writer" releasing its lock on a timer never gets a chance
  // to run while the "reader" is blocked waiting on it).
  it('waits out a write lock held by another connection instead of failing immediately', async () => {
    const root = mkdtempSync(join(tmpdir(), 'filenet-db-'));
    tmpDirs.push(root);
    const dbPath = join(root, 'filenet.db');

    const worker = new Worker(join(import.meta.dir, 'busy-writer-worker.ts'));
    try {
      const holdMs = 1500;
      await new Promise<void>((resolve) => {
        worker.onmessage = (event) => {
          if (event.data === 'locked') resolve();
        };
        worker.postMessage({ path: dbPath, holdMs });
      });
      // Give the writer a moment to be genuinely holding the lock before
      // this connection even opens.
      await Bun.sleep(100);

      const reader = createDb(dbPath);
      const t0 = Date.now();
      reader.$client.exec("INSERT INTO busy_test (v) VALUES ('from reader')"); // succeeds only if it waited
      const elapsedMs = Date.now() - t0;
      reader.$client.close();

      // Proves it actually waited for the writer (~1500ms), rather than
      // the table just not existing yet or some other pass-through.
      expect(elapsedMs).toBeGreaterThan(holdMs - 200);
    } finally {
      worker.terminate();
    }
  });
});
