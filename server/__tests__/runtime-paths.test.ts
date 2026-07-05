import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveAssetPath } from '../runtime-paths';

describe('resolveAssetPath', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves relative to the repo root when running from source', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'filenet-paths-'));
    tmpDirs.push(repoRoot);
    const serverDir = join(repoRoot, 'server');
    mkdirSync(serverDir, { recursive: true });
    mkdirSync(join(repoRoot, 'drizzle', 'migrations'), { recursive: true });

    const resolved = resolveAssetPath('drizzle/migrations', serverDir, '/unused/exec');

    expect(resolved).toBe(join(repoRoot, 'drizzle', 'migrations'));
  });

  it('falls back to the executable directory when the source-relative path does not exist', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'filenet-paths-'));
    tmpDirs.push(repoRoot);
    const serverDir = join(repoRoot, 'server');
    mkdirSync(serverDir, { recursive: true });
    // No drizzle/migrations created here — simulates the compiled-binary
    // case where import.meta.dir is a synthetic path with nothing on disk.

    const execDir = mkdtempSync(join(tmpdir(), 'filenet-exec-'));
    tmpDirs.push(execDir);
    const execPath = join(execDir, 'filenet');

    const resolved = resolveAssetPath('drizzle/migrations', serverDir, execPath);

    expect(resolved).toBe(join(execDir, 'drizzle', 'migrations'));
  });
});
