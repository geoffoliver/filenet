import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { type Db, applyMigrations, createDb } from '../db';
import type { TransferStats } from '../types';
import { postDownloadScripts } from '../schema';
import { runPostDownloadScripts } from '../scripts';

const REAL_TMPDIR = realpathSync(tmpdir());

const TEST_DB_URL = 'file:./data/test-scripts.db';
let db: Db;

const testStats: TransferStats = {
  downloadId: 'test-id',
  filename: 'test.mp3',
  sha256: 'a'.repeat(64),
  size: 1024n,
  mimeType: 'audio/mpeg',
  durationMs: 500,
  bytesReceived: 1024n,
  maxSources: 2,
  startedAt: new Date('2026-01-01T00:00:00Z'),
  completedAt: new Date('2026-01-01T00:00:00.500Z'),
};

beforeAll(() => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
});

afterAll(() => {
  db.$client.close();
  try {
    unlinkSync('./data/test-scripts.db');
  } catch {}
});

beforeEach(() => {
  db.delete(postDownloadScripts).run();
});

describe('runPostDownloadScripts', () => {
  it('is a no-op when no scripts are configured', async () => {
    await expect(runPostDownloadScripts(db, '/some/file.mp3', testStats)).resolves.toBeUndefined();
  });

  it('calls the default export of each script in order', async () => {
    const scriptA = join(REAL_TMPDIR, `test-script-a-${Date.now()}.ts`);
    const scriptB = join(REAL_TMPDIR, `test-script-b-${Date.now()}.ts`);
    writeFileSync(
      scriptA,
      `export default function() { globalThis.__scriptCalls = globalThis.__scriptCalls ?? []; globalThis.__scriptCalls.push('a'); }`,
    );
    writeFileSync(
      scriptB,
      `export default function() { globalThis.__scriptCalls = globalThis.__scriptCalls ?? []; globalThis.__scriptCalls.push('b'); }`,
    );
    const now = new Date();
    db.insert(postDownloadScripts)
      .values([
        { id: randomUUID(), path: scriptA, order: 0, createdAt: now },
        { id: randomUUID(), path: scriptB, order: 1, createdAt: now },
      ])
      .run();
    (globalThis as Record<string, unknown>).__scriptCalls = [];
    await runPostDownloadScripts(db, '/some/file.mp3', testStats);
    const recorded = (globalThis as Record<string, unknown>).__scriptCalls as string[];
    expect(recorded).toEqual(['a', 'b']);
    try {
      unlinkSync(scriptA);
    } catch {}
    try {
      unlinkSync(scriptB);
    } catch {}
  });

  it('passes file and stats to the script', async () => {
    const scriptPath = join(REAL_TMPDIR, `test-script-ctx-${Date.now()}.ts`);
    writeFileSync(
      scriptPath,
      `export default function({ file, stats }) { globalThis.__scriptCtx = { file, stats }; }`,
    );
    db.insert(postDownloadScripts)
      .values({ id: randomUUID(), path: scriptPath, order: 0, createdAt: new Date() })
      .run();
    (globalThis as Record<string, unknown>).__scriptCtx = null;
    await runPostDownloadScripts(db, '/some/file.mp3', testStats);
    const ctx = (globalThis as Record<string, unknown>).__scriptCtx as {
      file: unknown;
      stats: unknown;
    };
    expect(ctx).not.toBeNull();
    expect(ctx.stats).toMatchObject({ filename: 'test.mp3', sha256: 'a'.repeat(64) });
    try {
      unlinkSync(scriptPath);
    } catch {}
  });

  it('continues running subsequent scripts if one throws', async () => {
    const crashScript = join(REAL_TMPDIR, `test-script-crash-${Date.now()}.ts`);
    const okScript = join(REAL_TMPDIR, `test-script-ok-${Date.now()}.ts`);
    writeFileSync(
      crashScript,
      `export default function() { throw new Error('intentional crash'); }`,
    );
    writeFileSync(okScript, `export default function() { globalThis.__okRan = true; }`);
    const now = new Date();
    db.insert(postDownloadScripts)
      .values([
        { id: randomUUID(), path: crashScript, order: 0, createdAt: now },
        { id: randomUUID(), path: okScript, order: 1, createdAt: now },
      ])
      .run();
    (globalThis as Record<string, unknown>).__okRan = false;
    await runPostDownloadScripts(db, '/some/file.mp3', testStats);
    expect((globalThis as Record<string, unknown>).__okRan).toBe(true);
    try {
      unlinkSync(crashScript);
    } catch {}
    try {
      unlinkSync(okScript);
    } catch {}
  });

  it('skips scripts whose default export is not a function', async () => {
    const badScript = join(REAL_TMPDIR, `test-script-bad-${Date.now()}.ts`);
    writeFileSync(badScript, `export default 'not a function';`);
    db.insert(postDownloadScripts)
      .values({ id: randomUUID(), path: badScript, order: 0, createdAt: new Date() })
      .run();
    await expect(runPostDownloadScripts(db, '/some/file.mp3', testStats)).resolves.toBeUndefined();
    try {
      unlinkSync(badScript);
    } catch {}
  });

  it('handles missing script files gracefully', async () => {
    db.insert(postDownloadScripts)
      .values({ id: randomUUID(), path: '/nonexistent/script.ts', order: 0, createdAt: new Date() })
      .run();
    await expect(runPostDownloadScripts(db, '/some/file.mp3', testStats)).resolves.toBeUndefined();
  });

  it('threads a returned BunFile to subsequent scripts as the file argument', async () => {
    const ts = Date.now();
    const scriptA = join(REAL_TMPDIR, `test-script-thread-a-${ts}.ts`);
    const scriptB = join(REAL_TMPDIR, `test-script-thread-b-${ts}.ts`);
    const movedPath = join(REAL_TMPDIR, `test-moved-${ts}.txt`);
    writeFileSync(movedPath, 'moved content');
    writeFileSync(
      scriptA,
      `export default function() { return Bun.file(${JSON.stringify(movedPath)}); }`,
    );
    writeFileSync(
      scriptB,
      `export default function({ file }) { globalThis.__threadedFilePath = file.name; }`,
    );
    const now = new Date();
    db.insert(postDownloadScripts)
      .values([
        { id: randomUUID(), path: scriptA, order: 0, createdAt: now },
        { id: randomUUID(), path: scriptB, order: 1, createdAt: now },
      ])
      .run();
    (globalThis as Record<string, unknown>).__threadedFilePath = null;
    await runPostDownloadScripts(db, '/some/original.mp3', testStats);
    expect((globalThis as Record<string, unknown>).__threadedFilePath).toBe(movedPath);
    try {
      unlinkSync(scriptA);
    } catch {}
    try {
      unlinkSync(scriptB);
    } catch {}
    try {
      unlinkSync(movedPath);
    } catch {}
  });

  it('stops the chain when a script returns false', async () => {
    const ts = Date.now();
    const scriptA = join(REAL_TMPDIR, `test-script-false-a-${ts}.ts`);
    const scriptB = join(REAL_TMPDIR, `test-script-false-b-${ts}.ts`);
    writeFileSync(scriptA, `export default function() { return false; }`);
    writeFileSync(scriptB, `export default function() { globalThis.__ranAfterFalse = true; }`);
    const now = new Date();
    db.insert(postDownloadScripts)
      .values([
        { id: randomUUID(), path: scriptA, order: 0, createdAt: now },
        { id: randomUUID(), path: scriptB, order: 1, createdAt: now },
      ])
      .run();
    (globalThis as Record<string, unknown>).__ranAfterFalse = false;
    await runPostDownloadScripts(db, '/some/file.mp3', testStats);
    expect((globalThis as Record<string, unknown>).__ranAfterFalse).toBe(false);
    try {
      unlinkSync(scriptA);
    } catch {}
    try {
      unlinkSync(scriptB);
    } catch {}
  });
});
