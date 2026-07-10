import * as fs from 'node:fs';

import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import JSZip from 'jszip';

import {
  applyUpdateSwap,
  compareVersions,
  downloadAndStage,
  extractZip,
  fetchLatestRelease,
  isNewerVersion,
  targetName,
  verifySha256,
} from '../updater';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns positive when the first version is newer', () => {
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('returns negative when the first version is older', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
  });
});

describe('isNewerVersion', () => {
  it('is true when the candidate is strictly greater', () => {
    expect(isNewerVersion('0.2.0', '0.1.1')).toBe(true);
  });

  it('is false when equal or older', () => {
    expect(isNewerVersion('0.1.1', '0.1.1')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(false);
  });
});

describe('targetName', () => {
  it('maps darwin/x64 to bun-darwin-x64', () => {
    expect(targetName('darwin', 'x64')).toBe('bun-darwin-x64');
  });

  it('maps darwin/arm64 to bun-darwin-arm64', () => {
    expect(targetName('darwin', 'arm64')).toBe('bun-darwin-arm64');
  });

  it('maps linux/x64 to bun-linux-x64', () => {
    expect(targetName('linux', 'x64')).toBe('bun-linux-x64');
  });

  it('maps linux/arm64 to bun-linux-arm64', () => {
    expect(targetName('linux', 'arm64')).toBe('bun-linux-arm64');
  });

  it('maps win32/x64 to bun-windows-x64', () => {
    expect(targetName('win32', 'x64')).toBe('bun-windows-x64');
  });

  it('throws on an unsupported platform', () => {
    expect(() => targetName('freebsd', 'x64')).toThrow();
  });

  it('throws on an unsupported architecture', () => {
    expect(() => targetName('linux', 'ia32')).toThrow();
  });

  it('throws on invalid platform/arch combination (win32/arm64)', () => {
    expect(() => targetName('win32', 'arm64')).toThrow(
      /Unsupported platform\/arch for auto-update: win32\/arm64/,
    );
  });
});

describe('fetchLatestRelease', () => {
  function fakeFetch(response: unknown, status = 200): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(response), { status })) as unknown as typeof fetch;
  }

  it('parses tag_name, html_url, and assets from a real-shaped response', async () => {
    const release = await fetchLatestRelease(
      'geoffoliver/filenet',
      fakeFetch({
        tag_name: 'v0.2.0',
        html_url: 'https://github.com/geoffoliver/filenet/releases/tag/v0.2.0',
        assets: [
          {
            name: 'filenet-bun-linux-x64.zip',
            browser_download_url: 'https://example.com/filenet-bun-linux-x64.zip',
          },
          { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.com/SHA256SUMS.txt' },
        ],
      }),
    );

    expect(release).toEqual({
      version: '0.2.0',
      notesUrl: 'https://github.com/geoffoliver/filenet/releases/tag/v0.2.0',
      assets: [
        { name: 'filenet-bun-linux-x64.zip', url: 'https://example.com/filenet-bun-linux-x64.zip' },
        { name: 'SHA256SUMS.txt', url: 'https://example.com/SHA256SUMS.txt' },
      ],
    });
  });

  it('returns null when the repo has no releases (404)', async () => {
    const release = await fetchLatestRelease('geoffoliver/filenet', fakeFetch({}, 404));
    expect(release).toBeNull();
  });

  it('throws on a non-404 error status', async () => {
    await expect(fetchLatestRelease('geoffoliver/filenet', fakeFetch({}, 500))).rejects.toThrow();
  });

  it('throws when the response has no tag_name', async () => {
    await expect(
      fetchLatestRelease('geoffoliver/filenet', fakeFetch({ assets: [] })),
    ).rejects.toThrow();
  });
});

describe('verifySha256', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('returns true when the hash matches the SHA256SUMS.txt line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'filenet-sha-'));
    tmpDirs.push(dir);
    const filePath = join(dir, 'asset.zip');
    await Bun.write(filePath, 'hello world');
    // sha256("hello world") — precomputed, stable for any test environment
    const hash = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
    const ok = await verifySha256(filePath, `${hash}  asset.zip\n`, 'asset.zip');
    expect(ok).toBe(true);
  });

  it('returns false when the hash does not match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'filenet-sha-'));
    tmpDirs.push(dir);
    const filePath = join(dir, 'asset.zip');
    await Bun.write(filePath, 'hello world');
    const ok = await verifySha256(filePath, `${'0'.repeat(64)}  asset.zip\n`, 'asset.zip');
    expect(ok).toBe(false);
  });

  it('returns false when the asset has no line in the checksums file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'filenet-sha-'));
    tmpDirs.push(dir);
    const filePath = join(dir, 'asset.zip');
    await Bun.write(filePath, 'hello world');
    const ok = await verifySha256(filePath, `${'a'.repeat(64)}  other.zip\n`, 'asset.zip');
    expect(ok).toBe(false);
  });
});

describe('extractZip', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('extracts nested files flat under destDir and marks the binary executable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'filenet-zip-'));
    tmpDirs.push(dir);
    const zip = new JSZip();
    zip.file('filenet', 'binary-contents');
    zip.file('out/index.html', '<html></html>');
    zip.file('drizzle/migrations/0000_x.sql', 'CREATE TABLE x;');
    const zipPath = join(dir, 'release.zip');
    await Bun.write(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));

    const destDir = join(dir, 'dest');
    await extractZip(zipPath, destDir);

    expect(existsSync(join(destDir, 'filenet'))).toBe(true);
    expect(existsSync(join(destDir, 'out', 'index.html'))).toBe(true);
    expect(existsSync(join(destDir, 'drizzle', 'migrations', '0000_x.sql'))).toBe(true);
    if (process.platform !== 'win32') {
      const mode = statSync(join(destDir, 'filenet')).mode;
      expect(mode & 0o111).not.toBe(0); // at least one executable bit set
    }
  });
});

describe('downloadAndStage', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function buildRelease(zipBytes: Uint8Array, sumsText: string) {
    const fetchImpl = (async (url: string) => {
      if (url === 'https://example.com/asset.zip') {
        return new Response(zipBytes, { status: 200 });
      }
      if (url === 'https://example.com/SHA256SUMS.txt') {
        return new Response(sumsText, { status: 200 });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    }) as unknown as typeof fetch;
    return fetchImpl;
  }

  it('downloads, verifies, and extracts a release into stagingRoot/<version>', async () => {
    const { targetName } = await import('../updater');
    const assetName = `filenet-${targetName(process.platform, process.arch)}.zip`;

    const zip = new JSZip();
    zip.file('filenet', 'binary-contents');
    zip.file('out/index.html', '<html></html>');
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });

    const hash = createHash('sha256').update(zipBuf).digest('hex');

    const release = {
      version: '0.2.0',
      notesUrl: 'https://example.com/notes',
      assets: [
        { name: assetName, url: 'https://example.com/asset.zip' },
        { name: 'SHA256SUMS.txt', url: 'https://example.com/SHA256SUMS.txt' },
      ],
    };

    const stagingRoot = mkdtempSync(join(tmpdir(), 'filenet-stage-'));
    tmpDirs.push(stagingRoot);

    const stagingDir = await downloadAndStage(
      release,
      stagingRoot,
      buildRelease(zipBuf, `${hash}  ${assetName}\n`),
    );

    expect(stagingDir).toBe(join(stagingRoot, '0.2.0'));
    expect(existsSync(join(stagingDir, 'filenet'))).toBe(true);
    expect(existsSync(join(stagingDir, 'out', 'index.html'))).toBe(true);
  });

  it('throws and cleans up when the checksum does not match', async () => {
    const { targetName } = await import('../updater');
    const assetName = `filenet-${targetName(process.platform, process.arch)}.zip`;
    const zip = new JSZip();
    zip.file('filenet', 'binary-contents');
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });

    const release = {
      version: '0.3.0',
      notesUrl: '',
      assets: [
        { name: assetName, url: 'https://example.com/asset.zip' },
        { name: 'SHA256SUMS.txt', url: 'https://example.com/SHA256SUMS.txt' },
      ],
    };

    const stagingRoot = mkdtempSync(join(tmpdir(), 'filenet-stage-'));
    tmpDirs.push(stagingRoot);

    await expect(
      downloadAndStage(
        release,
        stagingRoot,
        buildRelease(zipBuf, `${'0'.repeat(64)}  ${assetName}\n`),
      ),
    ).rejects.toThrow();
    expect(existsSync(join(stagingRoot, '0.3.0'))).toBe(false);
  });

  it('removes stale staged versions once a new one lands', async () => {
    const { targetName } = await import('../updater');
    const assetName = `filenet-${targetName(process.platform, process.arch)}.zip`;
    const zip = new JSZip();
    zip.file('filenet', 'binary-contents');
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
    const hash = createHash('sha256').update(zipBuf).digest('hex');

    const stagingRoot = mkdtempSync(join(tmpdir(), 'filenet-stage-'));
    tmpDirs.push(stagingRoot);
    mkdirSync(join(stagingRoot, '0.1.0'), { recursive: true });

    await downloadAndStage(
      {
        version: '0.2.0',
        notesUrl: '',
        assets: [
          { name: assetName, url: 'https://example.com/asset.zip' },
          { name: 'SHA256SUMS.txt', url: 'https://example.com/SHA256SUMS.txt' },
        ],
      },
      stagingRoot,
      buildRelease(zipBuf, `${hash}  ${assetName}\n`),
    );

    expect(existsSync(join(stagingRoot, '0.1.0'))).toBe(false);
    expect(existsSync(join(stagingRoot, '0.2.0'))).toBe(true);
  });
});

describe('applyUpdateSwap', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeInstall(dir: string, binaryContents: string) {
    const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';
    writeFileSync(join(dir, binaryName), binaryContents);
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, 'out', 'index.html'), 'old-ui');
    mkdirSync(join(dir, 'drizzle', 'migrations'), { recursive: true });
    writeFileSync(join(dir, 'drizzle', 'migrations', '0000_x.sql'), 'old-migration');
  }

  function makeStaging(dir: string, binaryContents: string) {
    const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, binaryName), binaryContents);
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, 'out', 'index.html'), 'new-ui');
    mkdirSync(join(dir, 'drizzle', 'migrations'), { recursive: true });
    writeFileSync(join(dir, 'drizzle', 'migrations', '0001_y.sql'), 'new-migration');
  }

  it('replaces the binary, out/, and drizzle/migrations, and removes the staging dir', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'filenet-install-'));
    tmpDirs.push(installDir);
    const stagingDir = join(installDir, '.filenet-update', '0.2.0');
    makeInstall(installDir, 'old-binary');
    makeStaging(stagingDir, 'new-binary');

    applyUpdateSwap(stagingDir, installDir);

    const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';
    expect(readFileSync(join(installDir, binaryName), 'utf8')).toBe('new-binary');
    expect(readFileSync(join(installDir, 'out', 'index.html'), 'utf8')).toBe('new-ui');
    expect(existsSync(join(installDir, 'drizzle', 'migrations', '0001_y.sql'))).toBe(true);
    expect(existsSync(stagingDir)).toBe(false);
    expect(existsSync(`${join(installDir, binaryName)}.old`)).toBe(false);
  });

  it('leaves the previous version usable if a prior failed swap left .old siblings', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'filenet-install-'));
    tmpDirs.push(installDir);
    const stagingDir = join(installDir, '.filenet-update', '0.2.0');
    makeInstall(installDir, 'old-binary');
    makeStaging(stagingDir, 'new-binary');
    const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';
    writeFileSync(join(installDir, `${binaryName}.old`), 'leftover-from-a-previous-failed-swap');

    applyUpdateSwap(stagingDir, installDir);

    expect(readFileSync(join(installDir, binaryName), 'utf8')).toBe('new-binary');
    expect(existsSync(join(installDir, `${binaryName}.old`))).toBe(false);
  });

  it("leaves the first entry's .old backup in place if a later entry's rename fails, and propagates the error", async () => {
    const installDir = mkdtempSync(join(tmpdir(), 'filenet-install-'));
    tmpDirs.push(installDir);
    const stagingDir = join(installDir, '.filenet-update', '0.2.0');
    const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';

    makeInstall(installDir, 'old-binary');
    makeStaging(stagingDir, 'new-binary');

    // Portable failure injection (works identically on Linux CI and macOS):
    // mock node:fs's renameSync so that the binary entry's two renames
    // (live -> .old, then staged -> live) go through untouched — exactly
    // mirroring the real crash-safety scenario where the first entry has
    // already fully committed — and the very next renameSync call (the
    // second entry's live -> .old rename, for `out`) throws. This leaves
    // `out` completely untouched on disk (never renamed away), which is
    // what lets us assert its original content survived.
    const realRenameSync = fs.renameSync;
    let renameCallCount = 0;
    await mock.module('node:fs', () => ({
      ...fs,
      renameSync: (...args: Parameters<typeof fs.renameSync>) => {
        renameCallCount += 1;
        if (renameCallCount === 3) {
          throw new Error('simulated rename failure for test');
        }
        return realRenameSync(...args);
      },
    }));

    let threwAsExpected = false;
    let thrownError: unknown;
    try {
      applyUpdateSwap(stagingDir, installDir);
    } catch (err) {
      threwAsExpected = true;
      thrownError = err;
    } finally {
      // Critical: undo the module mock immediately so it cannot leak into
      // any other test in this file (or the wider suite) that touches
      // node:fs — restore even if the assertions below throw.
      mock.restore();
    }

    expect(threwAsExpected).toBe(true);
    expect((thrownError as Error).message).toBe('simulated rename failure for test');

    // Verify the binary was successfully swapped before the failure
    expect(readFileSync(join(installDir, binaryName), 'utf8')).toBe('new-binary');
    expect(existsSync(join(installDir, `${binaryName}.old`))).toBe(true);
    expect(readFileSync(join(installDir, `${binaryName}.old`), 'utf8')).toBe('old-binary');

    // Verify out was NOT swapped (still has old content) because the rename failed before it was processed
    expect(readFileSync(join(installDir, 'out', 'index.html'), 'utf8')).toBe('old-ui');
  });
});
