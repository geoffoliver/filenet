import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { TransferStats } from '../types';
import { createPrismaClient } from '../db';
import { runPostDownloadScripts } from '../scripts';

// Bun's dynamic import normalises paths via realpath. On macOS /var → /private/var,
// so we must write temp scripts to the canonical path or imports fail.
const REAL_TMPDIR = realpathSync(tmpdir());

const TEST_DB_URL = 'file:./data/test-scripts.db';
let prisma: PrismaClient;

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
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
});

afterAll(async () => {
  await prisma.$disconnect();
  try {
    unlinkSync('./data/test-scripts.db');
  } catch {}
});

beforeEach(async () => {
  await prisma.postDownloadScript.deleteMany();
});

describe('runPostDownloadScripts', () => {
  it('is a no-op when no scripts are configured', async () => {
    await expect(
      runPostDownloadScripts(prisma, '/some/file.mp3', testStats),
    ).resolves.toBeUndefined();
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

    await prisma.postDownloadScript.createMany({
      data: [
        { path: scriptA, order: 0 },
        { path: scriptB, order: 1 },
      ],
    });

    (globalThis as Record<string, unknown>).__scriptCalls = [];
    await runPostDownloadScripts(prisma, '/some/file.mp3', testStats);
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

    await prisma.postDownloadScript.create({ data: { path: scriptPath, order: 0 } });

    (globalThis as Record<string, unknown>).__scriptCtx = null;
    await runPostDownloadScripts(prisma, '/some/file.mp3', testStats);

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

    await prisma.postDownloadScript.createMany({
      data: [
        { path: crashScript, order: 0 },
        { path: okScript, order: 1 },
      ],
    });

    (globalThis as Record<string, unknown>).__okRan = false;
    await runPostDownloadScripts(prisma, '/some/file.mp3', testStats);
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

    await prisma.postDownloadScript.create({ data: { path: badScript, order: 0 } });

    await expect(
      runPostDownloadScripts(prisma, '/some/file.mp3', testStats),
    ).resolves.toBeUndefined();

    try {
      unlinkSync(badScript);
    } catch {}
  });

  it('handles missing script files gracefully', async () => {
    await prisma.postDownloadScript.create({
      data: { path: '/nonexistent/script.ts', order: 0 },
    });
    await expect(
      runPostDownloadScripts(prisma, '/some/file.mp3', testStats),
    ).resolves.toBeUndefined();
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

    await prisma.postDownloadScript.createMany({
      data: [
        { path: scriptA, order: 0 },
        { path: scriptB, order: 1 },
      ],
    });

    (globalThis as Record<string, unknown>).__threadedFilePath = null;
    await runPostDownloadScripts(prisma, '/some/original.mp3', testStats);
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

    await prisma.postDownloadScript.createMany({
      data: [
        { path: scriptA, order: 0 },
        { path: scriptB, order: 1 },
      ],
    });

    (globalThis as Record<string, unknown>).__ranAfterFalse = false;
    await runPostDownloadScripts(prisma, '/some/file.mp3', testStats);
    expect((globalThis as Record<string, unknown>).__ranAfterFalse).toBe(false);

    try {
      unlinkSync(scriptA);
    } catch {}
    try {
      unlinkSync(scriptB);
    } catch {}
  });
});
