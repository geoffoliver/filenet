import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isCompiledBinary, resolveAssetPath } from '../runtime-paths';

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

describe('isCompiledBinary', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when running from source (package.json present at repo root)', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'filenet-binmode-'));
    tmpDirs.push(repoRoot);
    const serverDir = join(repoRoot, 'server');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), '{}');

    expect(isCompiledBinary(serverDir)).toBe(false);
  });

  it('returns true when no package.json exists next to the caller (compiled binary)', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'filenet-binmode-'));
    tmpDirs.push(repoRoot);
    const serverDir = join(repoRoot, 'server');
    mkdirSync(serverDir, { recursive: true });
    // No package.json written — simulates the synthetic import.meta.dir
    // inside a `bun build --compile` binary.

    expect(isCompiledBinary(serverDir)).toBe(true);
  });
});
