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
  createUpdateManager,
  downloadAndStage,
  extractZip,
  fetchLatestRelease,
  isNewerVersion,
  isProcessRunning,
  parseFinishUpdateArgs,
  runFinishUpdate,
  targetName,
  verifySha256,
  waitForPidExit,
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

  it('throws for a version string with a prerelease suffix', () => {
    expect(() => compareVersions('0.2.0-beta.1', '0.1.0')).toThrow(
      /Cannot compare non-semver version strings/,
    );
  });

  it('throws for a version string with a non-numeric prefix (e.g. a fork tag)', () => {
    expect(() => compareVersions('release-0.2.0', '0.1.0')).toThrow(
      /Cannot compare non-semver version strings/,
    );
  });

  it('throws for a version string with fewer than 3 numeric parts', () => {
    expect(() => compareVersions('1.2', '1.2.3')).toThrow(
      /Cannot compare non-semver version strings/,
    );
  });

  it('throws when the second argument is malformed, even if the first is valid', () => {
    expect(() => compareVersions('1.2.3', 'not-a-version')).toThrow(
      /Cannot compare non-semver version strings/,
    );
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

  it('refuses to extract an entry whose relative path escapes destDir (zip slip)', async () => {
    // NOTE: JSZip 3.10.1 already sanitizes '../' segments itself on load —
    // `zip.file('../../evil.txt', ...)`, round-tripped through a real
    // generateAsync()/loadAsync(), silently collapses to a safe key
    // ('evil.txt') before extractZip ever sees it (verified by hand: both
    // the writer and, independently, load.js's `utils.resolve()` on the
    // reader side strip leading '..' segments that would go above the
    // archive root). So a literal malicious entry built via JSZip's own
    // API can't reach our loop to exercise the guard. To test our guard on
    // its own merits — not JSZip's internal sanitization, which we don't
    // control long-term — mock the 'jszip' module (this file's established
    // mock.module pattern, used elsewhere for node:fs) to hand extractZip a
    // files map containing a traversal key directly.
    const dir = mkdtempSync(join(tmpdir(), 'filenet-zip-'));
    tmpDirs.push(dir);
    const zipPath = join(dir, 'release.zip');
    await Bun.write(zipPath, 'irrelevant-bytes'); // must exist; contents unused by the mock

    // Note: this deliberately does NOT use mock.module('jszip', ...) (the
    // pattern used below for node:fs). We verified with a standalone repro
    // that a full mock.module('jszip', factory) replacement leaks past
    // mock.restore() in this Bun version (1.3.14) — restore() only resets
    // mock *functions*, not module-registry replacements — which would
    // permanently break every other test in this file that does `new
    // JSZip()` via the top-level static import (a live binding to the same
    // registry entry). The node:fs mocks below dodge this because they
    // spread the real module (`...fs`) and only override one function, so
    // even an unrestored mock still behaves like real fs for everything
    // else. jszip's default export is a class, not a plain object, so the
    // equivalent-safe move is to monkey-patch the single static method we
    // need directly on the real (already-imported) class and restore it by
    // hand — same net effect, no leak.
    const originalLoadAsync = JSZip.loadAsync;
    (JSZip as unknown as { loadAsync: typeof JSZip.loadAsync }).loadAsync = (async () => ({
      files: {
        filenet: { dir: false, async: async () => Buffer.from('binary-contents') },
        '../evil.txt': { dir: false, async: async () => Buffer.from('pwned') },
      },
    })) as unknown as typeof JSZip.loadAsync;

    // destDir = dir/dest, so '../evil.txt' would land at dir/evil.txt if
    // unguarded — one level outside destDir, but still inside the per-test
    // sandbox `dir` (cleaned up by afterEach), so the assertion below can't
    // collide with anything left over elsewhere on the shared OS tmpdir.
    const destDir = join(dir, 'dest');
    let threw = false;
    try {
      await expect(extractZip(zipPath, destDir)).rejects.toThrow(/outside destination directory/);
      threw = true;
    } finally {
      (JSZip as unknown as { loadAsync: typeof JSZip.loadAsync }).loadAsync = originalLoadAsync;
    }

    expect(threw).toBe(true);
    expect(existsSync(join(dir, 'evil.txt'))).toBe(false);
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

  it('downloads a real release from a genuinely separate server process (regression test: a prior downloadToFile implementation hung indefinitely when the downloaded content was a REAL compiled Bun executable served from a genuinely separate OS process — reproduced 3/3 times under exactly these conditions during manual end-to-end testing of a real build. Neither payload size nor cross-process networking alone reproduces it: an in-process Bun.serve()+fetch() loopback never hangs regardless of size or content, and even genuine cross-process serving of a large SYNTHETIC buffer never hangs — only a real compiled-executable\'s actual byte content, served cross-process, does. This is exactly the combination every other test in this file — and the original "verification" of this exact bug two review rounds ago — used a weaker substitute for, which is how it slipped through 756 passing tests twice.)', async () => {
    const assetName = `filenet-${targetName(process.platform, process.arch)}.zip`;

    const dir = mkdtempSync(join(tmpdir(), 'filenet-realfetch-'));
    tmpDirs.push(dir);

    // Compile a genuinely real (tiny) Bun executable to get real
    // executable byte content — a synthetic buffer of the same or even
    // much larger size does not reproduce the hang; only real compiled
    // binary content does (see the test name for why this was verified,
    // not assumed).
    const trivialScriptPath = join(dir, 'trivial.ts');
    writeFileSync(trivialScriptPath, 'console.log("hi");');
    const realBinaryPath = join(dir, 'real-binary');
    const compileProc = Bun.spawn({
      cmd: ['bun', 'build', '--compile', '--outfile', realBinaryPath, trivialScriptPath],
      stdout: 'ignore',
      stderr: 'inherit',
    });
    await compileProc.exited;
    const realBinaryBytes = readFileSync(realBinaryPath);

    const zip = new JSZip();
    zip.file('filenet', realBinaryBytes);
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
    const hash = createHash('sha256').update(zipBuf).digest('hex');
    const sumsText = `${hash}  ${assetName}\n`;

    const zipOnDiskPath = join(dir, assetName);
    writeFileSync(zipOnDiskPath, zipBuf);
    const sumsOnDiskPath = join(dir, 'SHA256SUMS.txt');
    writeFileSync(sumsOnDiskPath, sumsText);

    // Serve from a genuinely separate `bun` process, not an in-process
    // Bun.serve() — real cross-process networking (as a real GitHub
    // download always is) is the other half of the reproduction
    // condition, alongside the real binary content above.
    const serverScriptPath = join(dir, 'server.ts');
    writeFileSync(
      serverScriptPath,
      [
        'const server = Bun.serve({',
        '  port: 0,',
        '  fetch(req) {',
        '    const url = new URL(req.url);',
        `    if (url.pathname === '/asset.zip') return new Response(Bun.file(process.env.ZIP_PATH!));`,
        `    if (url.pathname === '/sums.txt') return new Response(Bun.file(process.env.SUMS_PATH!));`,
        `    return new Response('not found', { status: 404 });`,
        '  },',
        '});',
        `console.log('LISTENING:' + server.port);`,
      ].join('\n'),
    );

    const serverProc = Bun.spawn({
      cmd: ['bun', serverScriptPath],
      env: { ...process.env, ZIP_PATH: zipOnDiskPath, SUMS_PATH: sumsOnDiskPath },
      stdout: 'pipe',
      stderr: 'inherit',
    });

    try {
      const reader = serverProc.stdout.getReader();
      let output = '';
      let port: number | null = null;
      const deadline = Date.now() + 5000;
      while (port === null) {
        if (Date.now() > deadline) throw new Error('server process did not start in time');
        const { value, done } = await reader.read();
        if (done) throw new Error('server process exited before reporting a port');
        output += new TextDecoder().decode(value);
        const match = output.match(/LISTENING:(\d+)/);
        if (match) port = Number(match[1]);
      }
      reader.releaseLock();

      const release = {
        version: '9.9.9',
        notesUrl: '',
        assets: [
          { name: assetName, url: `http://localhost:${port}/asset.zip` },
          { name: 'SHA256SUMS.txt', url: `http://localhost:${port}/sums.txt` },
        ],
      };

      const stagingRoot = mkdtempSync(join(tmpdir(), 'filenet-stage-'));
      tmpDirs.push(stagingRoot);

      // Deliberately omit the fetchImpl argument — real global fetch
      // against the real separate server process above, not a mocked
      // Response, which is the one thing every other test in this
      // describe block does not do.
      const stagingDir = await downloadAndStage(release, stagingRoot);

      expect(existsSync(join(stagingDir, 'filenet'))).toBe(true);
      expect(statSync(join(stagingDir, 'filenet')).size).toBe(realBinaryBytes.length);
    } finally {
      serverProc.kill();
    }
  }, 30_000); // includes a real `bun build --compile` invocation, not just I/O

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

  it('rejects a malicious release.version that would resolve outside stagingRoot (path traversal)', async () => {
    const stagingRoot = mkdtempSync(join(tmpdir(), 'filenet-stage-'));
    tmpDirs.push(stagingRoot);

    // Sentinel directory that a '../' traversal from stagingRoot would land
    // on — sits as a sibling of stagingRoot, directly in the OS tmpdir. If
    // downloadAndStage ever uses release.version as an unvalidated path
    // segment, its `rmSync(versionDir, { recursive: true, force: true })`
    // would delete this directory outright.
    const sentinelDir = join(tmpdir(), 'filenet-stage-traversal-sentinel');
    rmSync(sentinelDir, { recursive: true, force: true });
    mkdirSync(sentinelDir, { recursive: true });
    const sentinelFile = join(sentinelDir, 'do-not-delete.txt');
    writeFileSync(sentinelFile, 'sentinel');

    try {
      const target = targetName(process.platform, process.arch);
      const assetName = `filenet-${target}.zip`;
      const maliciousRelease = {
        version: '../filenet-stage-traversal-sentinel',
        notesUrl: '',
        assets: [
          { name: assetName, url: 'https://example.com/asset.zip' },
          { name: 'SHA256SUMS.txt', url: 'https://example.com/SHA256SUMS.txt' },
        ],
      };
      // A fetchImpl that fails fast — the point of this test is that the
      // function must never even reach the point of downloading, since the
      // version string should be rejected before any destructive path
      // operation runs.
      const fetchImpl = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;

      await expect(downloadAndStage(maliciousRelease, stagingRoot, fetchImpl)).rejects.toThrow();

      // The sentinel — which sits exactly where the traversal would land —
      // must survive completely untouched: not deleted, not recreated empty.
      expect(existsSync(sentinelFile)).toBe(true);
      expect(readFileSync(sentinelFile, 'utf8')).toBe('sentinel');
    } finally {
      rmSync(sentinelDir, { recursive: true, force: true });
    }
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

  it('completes successfully even when removing the staging dir fails (Windows-safe cleanup)', async () => {
    const installDir = mkdtempSync(join(tmpdir(), 'filenet-install-'));
    tmpDirs.push(installDir);
    const stagingDir = join(installDir, '.filenet-update', '0.2.0');
    const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';

    makeInstall(installDir, 'old-binary');
    makeStaging(stagingDir, 'new-binary');

    // Portable failure injection matching the pattern used above: mock
    // node:fs's rmSync so it throws specifically for the stagingDir path
    // (simulating e.g. Windows refusing to delete a process's own cwd),
    // while every other rmSync call (the .old backup cleanup) behaves
    // normally.
    const realRmSync = fs.rmSync;
    await mock.module('node:fs', () => ({
      ...fs,
      rmSync: (path: fs.PathLike, options?: fs.RmOptions) => {
        if (path === stagingDir) {
          throw new Error('simulated EBUSY: directory is the current working directory');
        }
        return realRmSync(path, options);
      },
    }));

    let threw = false;
    try {
      applyUpdateSwap(stagingDir, installDir);
    } catch {
      threw = true;
    } finally {
      mock.restore();
    }

    expect(threw).toBe(false);
    expect(readFileSync(join(installDir, binaryName), 'utf8')).toBe('new-binary');
    expect(readFileSync(join(installDir, 'out', 'index.html'), 'utf8')).toBe('new-ui');
    expect(existsSync(join(installDir, 'drizzle', 'migrations', '0001_y.sql'))).toBe(true);
    expect(existsSync(`${join(installDir, binaryName)}.old`)).toBe(false);
  });

  it('on win32, copies (not renames) the staged binary, since it may be the running --finish-update image, while directories still use renameSync', async () => {
    // Force the win32 code path on this (non-Windows) dev machine, restoring
    // the real value in `finally` no matter what.
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const installDir = mkdtempSync(join(tmpdir(), 'filenet-install-'));
    tmpDirs.push(installDir);
    const stagingDir = join(installDir, '.filenet-update', '0.2.0');
    const binaryName = 'filenet.exe'; // win32 binary name, matching the forced platform above

    try {
      makeInstall(installDir, 'old-binary');
      makeStaging(stagingDir, 'new-binary');
      const stagedBinaryPath = join(stagingDir, binaryName);
      const stagedOutPath = join(stagingDir, 'out');

      // Wrap renameSync and copyFileSync so we can record which one was
      // used for which path, while delegating to the real implementations
      // so the swap actually completes on disk — same established pattern
      // as the node:fs mocks above.
      const realRenameSync = fs.renameSync;
      const realCopyFileSync = fs.copyFileSync;
      const renameCalls: string[] = [];
      const copyCalls: string[] = [];
      await mock.module('node:fs', () => ({
        ...fs,
        renameSync: (...args: Parameters<typeof fs.renameSync>) => {
          renameCalls.push(String(args[0]));
          return realRenameSync(...args);
        },
        copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
          copyCalls.push(String(args[0]));
          return realCopyFileSync(...args);
        },
      }));

      try {
        applyUpdateSwap(stagingDir, installDir);
      } finally {
        mock.restore();
      }

      // (a) the live binary ends up with the staged content
      expect(readFileSync(join(installDir, binaryName), 'utf8')).toBe('new-binary');
      expect(readFileSync(join(installDir, 'out', 'index.html'), 'utf8')).toBe('new-ui');

      // (b) copyFileSync was called for the binary's staged path
      expect(copyCalls).toContain(stagedBinaryPath);

      // (c) renameSync was NOT called for the binary's staged path (but
      // directories, e.g. `out`, still use renameSync)
      expect(renameCalls).not.toContain(stagedBinaryPath);
      expect(renameCalls).toContain(stagedOutPath);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('throws and leaves the live install completely untouched when the staged binary is missing', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'filenet-install-'));
    tmpDirs.push(installDir);
    const stagingDir = join(installDir, '.filenet-update', '0.2.0');
    const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';

    makeInstall(installDir, 'old-binary');
    makeStaging(stagingDir, 'new-binary');
    // Simulate a mispackaged release: the staged binary is missing, even
    // though `out` and `drizzle/migrations` are present.
    rmSync(join(stagingDir, binaryName), { force: true });

    expect(() => applyUpdateSwap(stagingDir, installDir)).toThrow(
      /missing required entry.*filenet/i,
    );

    // The live install must be exactly as it was before the call: nothing
    // renamed, no .old backups created for any entry (not even `out`, which
    // WAS present in staging and would otherwise have been swapped first).
    expect(readFileSync(join(installDir, binaryName), 'utf8')).toBe('old-binary');
    expect(readFileSync(join(installDir, 'out', 'index.html'), 'utf8')).toBe('old-ui');
    expect(readFileSync(join(installDir, 'drizzle', 'migrations', '0000_x.sql'), 'utf8')).toBe(
      'old-migration',
    );
    expect(existsSync(`${join(installDir, binaryName)}.old`)).toBe(false);
    expect(existsSync(`${join(installDir, 'out')}.old`)).toBe(false);
    // Staging dir is untouched too — nothing was consumed from it.
    expect(existsSync(join(stagingDir, 'out', 'index.html'))).toBe(true);
  });

  it('throws and leaves the live install completely untouched when the staged out/ directory is missing', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'filenet-install-'));
    tmpDirs.push(installDir);
    const stagingDir = join(installDir, '.filenet-update', '0.2.0');
    const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';

    makeInstall(installDir, 'old-binary');
    makeStaging(stagingDir, 'new-binary');
    rmSync(join(stagingDir, 'out'), { recursive: true, force: true });

    expect(() => applyUpdateSwap(stagingDir, installDir)).toThrow(/missing required entry.*out/i);

    expect(readFileSync(join(installDir, binaryName), 'utf8')).toBe('old-binary');
    expect(readFileSync(join(installDir, 'out', 'index.html'), 'utf8')).toBe('old-ui');
    expect(existsSync(`${join(installDir, binaryName)}.old`)).toBe(false);
  });

  it("creates a nested entry's missing parent directory (e.g. installDir/drizzle) before swapping it in", () => {
    const installDir = mkdtempSync(join(tmpdir(), 'filenet-install-'));
    tmpDirs.push(installDir);
    const stagingDir = join(installDir, '.filenet-update', '0.2.0');
    const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';

    // Only the required top-level entries exist in the live install.
    // Deliberately do NOT create installDir/drizzle at all (not even
    // empty) — simulating a layout where that intermediate directory is
    // absent, so the nested drizzle/migrations swap has no parent to land
    // in.
    writeFileSync(join(installDir, binaryName), 'old-binary');
    mkdirSync(join(installDir, 'out'), { recursive: true });
    writeFileSync(join(installDir, 'out', 'index.html'), 'old-ui');

    makeStaging(stagingDir, 'new-binary'); // includes staged drizzle/migrations

    expect(() => applyUpdateSwap(stagingDir, installDir)).not.toThrow();

    expect(readFileSync(join(installDir, binaryName), 'utf8')).toBe('new-binary');
    expect(readFileSync(join(installDir, 'out', 'index.html'), 'utf8')).toBe('new-ui');
    expect(existsSync(join(installDir, 'drizzle', 'migrations', '0001_y.sql'))).toBe(true);
  });

  it('still swaps the required entries and leaves the live install alone for drizzle/migrations when it is legitimately absent from staging', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'filenet-install-'));
    tmpDirs.push(installDir);
    const stagingDir = join(installDir, '.filenet-update', '0.2.0');
    const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';

    makeInstall(installDir, 'old-binary');
    makeStaging(stagingDir, 'new-binary');
    // This release didn't touch migrations — staging legitimately omits them.
    rmSync(join(stagingDir, 'drizzle'), { recursive: true, force: true });

    expect(() => applyUpdateSwap(stagingDir, installDir)).not.toThrow();

    expect(readFileSync(join(installDir, binaryName), 'utf8')).toBe('new-binary');
    expect(readFileSync(join(installDir, 'out', 'index.html'), 'utf8')).toBe('new-ui');
    // Untouched, still has the pre-existing migration.
    expect(readFileSync(join(installDir, 'drizzle', 'migrations', '0000_x.sql'), 'utf8')).toBe(
      'old-migration',
    );
    expect(existsSync(stagingDir)).toBe(false);
  });
});

describe('isProcessRunning', () => {
  it('is true for the current process', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it('is false for a pid that does not exist', () => {
    // A pid astronomically unlikely to be in use; ESRCH is the reliable signal.
    expect(isProcessRunning(999999)).toBe(false);
  });
});

describe('waitForPidExit', () => {
  it('resolves once the process is no longer running', async () => {
    await waitForPidExit(999999, { pollMs: 5, timeoutMs: 1000 });
    // No assertion needed — resolving without throwing is the pass condition.
  });

  it('throws if the process never exits within the timeout', async () => {
    await expect(waitForPidExit(process.pid, { pollMs: 5, timeoutMs: 20 })).rejects.toThrow();
  });
});

describe('parseFinishUpdateArgs', () => {
  it('returns null when --finish-update is absent', () => {
    expect(parseFinishUpdateArgs(['bun', 'server/index.ts'])).toBeNull();
  });

  it('parses oldPid/stagingDir/installDir/launchCwd when present', () => {
    expect(
      parseFinishUpdateArgs([
        'filenet',
        '--finish-update',
        '1234',
        '/staging',
        '/install',
        '/launch/cwd',
      ]),
    ).toEqual({
      oldPid: 1234,
      stagingDir: '/staging',
      installDir: '/install',
      launchCwd: '/launch/cwd',
    });
  });

  it('throws when arguments are missing', () => {
    expect(() => parseFinishUpdateArgs(['filenet', '--finish-update', '1234'])).toThrow();
  });

  it('throws when launchCwd is missing', () => {
    expect(() =>
      parseFinishUpdateArgs(['filenet', '--finish-update', '1234', '/staging', '/install']),
    ).toThrow('Malformed --finish-update arguments');
  });
});

describe('runFinishUpdate', () => {
  it('waits for the old pid, swaps files, spawns the new binary with launchCwd, and exits', async () => {
    const calls: string[] = [];
    const spawnCwds: (string | undefined)[] = [];
    const fakeChild = { unref: () => calls.push('unref') };
    await runFinishUpdate(1234, '/staging', '/install', '/launch/cwd', {
      waitForExit: async (pid) => {
        calls.push(`wait:${pid}`);
      },
      applySwap: (staging, install) => {
        calls.push(`swap:${staging}:${install}`);
      },
      spawnImpl: ((opts: { cmd: string[]; cwd?: string }) => {
        calls.push(`spawn:${opts.cmd.join(',')}`);
        spawnCwds.push(opts.cwd);
        return fakeChild;
      }) as unknown as typeof Bun.spawn,
      exitImpl: (code) => calls.push(`exit:${code}`),
    });

    expect(calls).toEqual([
      'wait:1234',
      'swap:/staging:/install',
      process.platform === 'win32' ? 'spawn:/install/filenet.exe' : 'spawn:/install/filenet',
      'unref',
      'exit:0',
    ]);
    expect(spawnCwds).toEqual(['/launch/cwd']);
  });
});

describe('createUpdateManager', () => {
  function fakeFetch(version: string | null): typeof fetch {
    return (async () => {
      if (version === null) return new Response('', { status: 404 });
      return new Response(
        JSON.stringify({ tag_name: `v${version}`, html_url: 'https://example.com', assets: [] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
  }

  it('starts idle and reports currentVersion/mode', () => {
    const manager = createUpdateManager({
      mode: 'binary',
      currentVersion: '0.1.0',
      installDir: '/install',
      getRepo: async () => 'geoffoliver/filenet',
    });
    expect(manager.getState()).toMatchObject({
      mode: 'binary',
      currentVersion: '0.1.0',
      phase: 'idle',
      latestVersion: null,
    });
  });

  it('goes to idle when no newer release exists', async () => {
    const manager = createUpdateManager({
      mode: 'binary',
      currentVersion: '0.1.0',
      installDir: '/install',
      getRepo: async () => 'geoffoliver/filenet',
      fetchImpl: fakeFetch('0.1.0'),
    });
    const state = await manager.checkNow();
    expect(state.phase).toBe('idle');
    expect(state.lastCheckedAt).not.toBeNull();
  });

  it('in source mode, stops at "available" without downloading', async () => {
    const manager = createUpdateManager({
      mode: 'source',
      currentVersion: '0.1.0',
      installDir: '/install',
      getRepo: async () => 'geoffoliver/filenet',
      fetchImpl: fakeFetch('0.2.0'),
    });
    const state = await manager.checkNow();
    expect(state.phase).toBe('available');
    expect(state.latestVersion).toBe('0.2.0');
  });

  it('surfaces a failed check as phase "error"', async () => {
    const manager = createUpdateManager({
      mode: 'binary',
      currentVersion: '0.1.0',
      installDir: '/install',
      getRepo: async () => 'geoffoliver/filenet',
      fetchImpl: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    });
    const state = await manager.checkNow();
    expect(state.phase).toBe('error');
    expect(state.error).toContain('network down');
  });

  it('surfaces a malformed release version from the update repo as phase "error"', async () => {
    const manager = createUpdateManager({
      mode: 'binary',
      currentVersion: '0.1.0',
      installDir: '/install',
      getRepo: async () => 'geoffoliver/filenet',
      fetchImpl: fakeFetch('release-0.2.0'),
    });
    const state = await manager.checkNow();
    expect(state.phase).toBe('error');
    expect(state.error).toContain('Cannot compare non-semver version strings');
  });

  it('guards against overlapping checkNow() calls performing two download cycles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'filenet-mgr-'));
    try {
      const target = (await import('../updater')).targetName(process.platform, process.arch);
      const assetName = `filenet-${target}.zip`;
      const zip = new JSZip();
      zip.file('filenet', 'bin');
      const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
      const hash = createHash('sha256').update(zipBuf).digest('hex');

      let assetFetchCount = 0;
      const fetchImpl = (async (url: string) => {
        if (url.includes('/releases/latest')) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return new Response(
            JSON.stringify({
              tag_name: 'v0.2.0',
              html_url: 'https://example.com',
              assets: [
                { name: assetName, browser_download_url: 'https://example.com/asset.zip' },
                { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.com/sums.txt' },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === 'https://example.com/asset.zip') {
          assetFetchCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return new Response(new Uint8Array(zipBuf), { status: 200 });
        }
        if (url === 'https://example.com/sums.txt') {
          return new Response(`${hash}  ${assetName}\n`, { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as unknown as typeof fetch;

      const manager = createUpdateManager({
        mode: 'binary',
        currentVersion: '0.1.0',
        installDir: dir,
        getRepo: async () => 'geoffoliver/filenet',
        fetchImpl,
      });

      const [first, second] = await Promise.all([manager.checkNow(), manager.checkNow()]);

      // Only one call should have actually driven a download cycle; the
      // other must have short-circuited via the re-entrancy guard instead
      // of racing a second downloadAndStage against the first.
      expect(assetFetchCount).toBe(1);
      const phases = [first.phase, second.phase];
      expect(phases).toContain('ready');
      // The overlapping call bailed out early rather than completing its own
      // full check/download cycle.
      expect(phases.filter((p) => p === 'ready')).toHaveLength(1);
      expect(manager.getState().phase).toBe('ready');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not re-download when the latest version is already staged and ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'filenet-mgr-'));
    try {
      const target = (await import('../updater')).targetName(process.platform, process.arch);
      const assetName = `filenet-${target}.zip`;
      const zip = new JSZip();
      zip.file('filenet', 'bin');
      const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
      const hash = createHash('sha256').update(zipBuf).digest('hex');

      let assetFetchCount = 0;
      const fetchImpl = (async (url: string) => {
        if (url.includes('/releases/latest')) {
          return new Response(
            JSON.stringify({
              tag_name: 'v0.2.0',
              html_url: 'https://example.com',
              assets: [
                { name: assetName, browser_download_url: 'https://example.com/asset.zip' },
                { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.com/sums.txt' },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === 'https://example.com/asset.zip') {
          assetFetchCount += 1;
          return new Response(new Uint8Array(zipBuf), { status: 200 });
        }
        if (url === 'https://example.com/sums.txt') {
          return new Response(`${hash}  ${assetName}\n`, { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as unknown as typeof fetch;

      const manager = createUpdateManager({
        mode: 'binary',
        currentVersion: '0.1.0',
        installDir: dir,
        getRepo: async () => 'geoffoliver/filenet',
        fetchImpl,
      });

      const first = await manager.checkNow();
      expect(first.phase).toBe('ready');
      expect(assetFetchCount).toBe(1);

      const second = await manager.checkNow();
      expect(second.phase).toBe('ready');
      expect(second.latestVersion).toBe('0.2.0');
      expect(assetFetchCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps phase "ready" when a later check fails transiently after an update is already staged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'filenet-mgr-'));
    try {
      const target = (await import('../updater')).targetName(process.platform, process.arch);
      const assetName = `filenet-${target}.zip`;
      const zip = new JSZip();
      zip.file('filenet', 'bin');
      const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
      const hash = createHash('sha256').update(zipBuf).digest('hex');

      let fetchImpl: typeof fetch = (async (url: string) => {
        if (url.includes('/releases/latest')) {
          return new Response(
            JSON.stringify({
              tag_name: 'v0.2.0',
              html_url: 'https://example.com',
              assets: [
                { name: assetName, browser_download_url: 'https://example.com/asset.zip' },
                { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.com/sums.txt' },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === 'https://example.com/asset.zip')
          return new Response(new Uint8Array(zipBuf), { status: 200 });
        if (url === 'https://example.com/sums.txt') {
          return new Response(`${hash}  ${assetName}\n`, { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as unknown as typeof fetch;

      const manager = createUpdateManager({
        mode: 'binary',
        currentVersion: '0.1.0',
        installDir: dir,
        getRepo: async () => 'geoffoliver/filenet',
        fetchImpl: ((...args: Parameters<typeof fetch>) =>
          fetchImpl(...args)) as unknown as typeof fetch,
      });

      // First check: succeeds and lands on phase "ready" with a staged update.
      const first = await manager.checkNow();
      expect(first.phase).toBe('ready');
      expect(first.latestVersion).toBe('0.2.0');

      // Second check: simulate a transient failure (e.g. offline, GitHub
      // rate-limited) on a LATER check that runs after the update is already
      // staged. This must not clobber the still-valid staged update.
      fetchImpl = (async () => {
        throw new Error('network down (transient)');
      }) as unknown as typeof fetch;

      const second = await manager.checkNow();
      expect(second.phase).toBe('ready');
      expect(second.latestVersion).toBe('0.2.0');
      expect(second.error).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores the OLD staged version (not the newly-discovered one) when a newer release is found but downloadAndStage fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'filenet-mgr-'));
    try {
      const target = (await import('../updater')).targetName(process.platform, process.arch);
      const assetName = `filenet-${target}.zip`;
      const zip = new JSZip();
      zip.file('filenet', 'bin');
      const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
      const hash = createHash('sha256').update(zipBuf).digest('hex');

      // First check: stages 0.2.0 successfully via a working fetchImpl.
      let fetchImpl: typeof fetch = (async (url: string) => {
        if (url.includes('/releases/latest')) {
          return new Response(
            JSON.stringify({
              tag_name: 'v0.2.0',
              html_url: 'https://example.com/0.2.0',
              assets: [
                { name: assetName, browser_download_url: 'https://example.com/asset-0.2.0.zip' },
                {
                  name: 'SHA256SUMS.txt',
                  browser_download_url: 'https://example.com/sums-0.2.0.txt',
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === 'https://example.com/asset-0.2.0.zip')
          return new Response(new Uint8Array(zipBuf), { status: 200 });
        if (url === 'https://example.com/sums-0.2.0.txt') {
          return new Response(`${hash}  ${assetName}\n`, { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as unknown as typeof fetch;

      const manager = createUpdateManager({
        mode: 'binary',
        currentVersion: '0.1.0',
        installDir: dir,
        getRepo: async () => 'geoffoliver/filenet',
        fetchImpl: ((...args: Parameters<typeof fetch>) =>
          fetchImpl(...args)) as unknown as typeof fetch,
      });

      const first = await manager.checkNow();
      expect(first.phase).toBe('ready');
      expect(first.latestVersion).toBe('0.2.0');
      expect(first.releaseNotesUrl).toBe('https://example.com/0.2.0');

      // Second check: release metadata now reports a genuinely NEWER version
      // (0.3.0) — fetchLatestRelease succeeds — but the asset download that
      // downloadAndStage attempts afterward fails (simulating a checksum
      // mismatch/interrupted download/missing asset, all plausible transient
      // failures). The still-valid 0.2.0 staging dir on disk is untouched.
      fetchImpl = (async (url: string) => {
        if (url.includes('/releases/latest')) {
          return new Response(
            JSON.stringify({
              tag_name: 'v0.3.0',
              html_url: 'https://example.com/0.3.0',
              assets: [
                { name: assetName, browser_download_url: 'https://example.com/asset-0.3.0.zip' },
                {
                  name: 'SHA256SUMS.txt',
                  browser_download_url: 'https://example.com/sums-0.3.0.txt',
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === 'https://example.com/asset-0.3.0.zip')
          return new Response(new Uint8Array(zipBuf), { status: 200 });
        if (url === 'https://example.com/sums-0.3.0.txt') {
          // Checksum mismatch: an empty checksums file has no matching line,
          // so verifySha256 returns false and downloadAndStage throws.
          return new Response('', { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as unknown as typeof fetch;

      const second = await manager.checkNow();
      expect(second.phase).toBe('ready');
      // The bug: this used to be '0.3.0' (the never-actually-staged version
      // that fetchLatestRelease discovered), even though what's physically
      // staged on disk — and what applyAndRestart() would actually install —
      // is still 0.2.0.
      expect(second.latestVersion).toBe('0.2.0');
      expect(second.releaseNotesUrl).toBe('https://example.com/0.2.0');
      expect(second.error).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applyAndRestart throws when no update is ready', async () => {
    const manager = createUpdateManager({
      mode: 'binary',
      currentVersion: '0.1.0',
      installDir: '/install',
      getRepo: async () => 'geoffoliver/filenet',
    });
    await expect(manager.applyAndRestart()).rejects.toThrow();
  });

  it('applyAndRestart spawns the staged binary with --finish-update and exits, once ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'filenet-mgr-'));
    try {
      const target = (await import('../updater')).targetName(process.platform, process.arch);
      const assetName = `filenet-${target}.zip`;
      const zip = new JSZip();
      zip.file('filenet', 'bin');
      const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
      const hash = createHash('sha256').update(zipBuf).digest('hex');

      const fetchImpl = (async (url: string) => {
        if (url.includes('/releases/latest')) {
          return new Response(
            JSON.stringify({
              tag_name: 'v0.2.0',
              html_url: 'https://example.com',
              assets: [
                { name: assetName, browser_download_url: 'https://example.com/asset.zip' },
                { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.com/sums.txt' },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === 'https://example.com/asset.zip')
          return new Response(new Uint8Array(zipBuf), { status: 200 });
        if (url === 'https://example.com/sums.txt') {
          return new Response(`${hash}  ${assetName}\n`, { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as unknown as typeof fetch;

      const spawnCalls: unknown[] = [];
      const exitCalls: number[] = [];
      const manager = createUpdateManager({
        mode: 'binary',
        currentVersion: '0.1.0',
        installDir: dir,
        getRepo: async () => 'geoffoliver/filenet',
        fetchImpl,
        spawnImpl: ((opts: unknown) => {
          spawnCalls.push(opts);
          return { unref: () => {} };
        }) as unknown as typeof Bun.spawn,
        exitImpl: (code) => exitCalls.push(code),
      });

      const state = await manager.checkNow();
      expect(state.phase).toBe('ready');

      await manager.applyAndRestart();

      expect(spawnCalls).toHaveLength(1);
      const spawnOpts = spawnCalls[0] as { cmd: string[]; cwd?: string };
      const cmd = spawnOpts.cmd;
      expect(cmd[1]).toBe('--finish-update');
      expect(cmd[2]).toBe(String(process.pid));
      expect(cmd[5]).toBe(process.cwd());
      expect(spawnOpts.cwd).toBe(dir);
      expect(exitCalls).toEqual([0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('guards against overlapping applyAndRestart() calls spawning two finish-update processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'filenet-mgr-'));
    try {
      const target = (await import('../updater')).targetName(process.platform, process.arch);
      const assetName = `filenet-${target}.zip`;
      const zip = new JSZip();
      zip.file('filenet', 'bin');
      const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
      const hash = createHash('sha256').update(zipBuf).digest('hex');

      const fetchImpl = (async (url: string) => {
        if (url.includes('/releases/latest')) {
          return new Response(
            JSON.stringify({
              tag_name: 'v0.2.0',
              html_url: 'https://example.com',
              assets: [
                { name: assetName, browser_download_url: 'https://example.com/asset.zip' },
                { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.com/sums.txt' },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === 'https://example.com/asset.zip')
          return new Response(new Uint8Array(zipBuf), { status: 200 });
        if (url === 'https://example.com/sums.txt') {
          return new Response(`${hash}  ${assetName}\n`, { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as unknown as typeof fetch;

      const spawnCalls: unknown[] = [];
      const exitCalls: number[] = [];
      const manager = createUpdateManager({
        mode: 'binary',
        currentVersion: '0.1.0',
        installDir: dir,
        getRepo: async () => 'geoffoliver/filenet',
        fetchImpl,
        spawnImpl: ((opts: unknown) => {
          spawnCalls.push(opts);
          return { unref: () => {} };
        }) as unknown as typeof Bun.spawn,
        exitImpl: (code) => exitCalls.push(code),
      });

      const state = await manager.checkNow();
      expect(state.phase).toBe('ready');

      // Simulate two overlapping /api/update-restart requests (double-click,
      // two browser tabs) both firing applyAndRestart() while phase is still
      // 'ready' — only the first should actually spawn/exit; the second must
      // be a silent no-op, not a second --finish-update process.
      await Promise.all([manager.applyAndRestart(), manager.applyAndRestart()]);

      expect(spawnCalls).toHaveLength(1);
      expect(exitCalls).toEqual([0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resets the restarting guard after a failed spawn so a later retry can still succeed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'filenet-mgr-'));
    try {
      const target = (await import('../updater')).targetName(process.platform, process.arch);
      const assetName = `filenet-${target}.zip`;
      const zip = new JSZip();
      zip.file('filenet', 'bin');
      const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
      const hash = createHash('sha256').update(zipBuf).digest('hex');

      const fetchImpl = (async (url: string) => {
        if (url.includes('/releases/latest')) {
          return new Response(
            JSON.stringify({
              tag_name: 'v0.2.0',
              html_url: 'https://example.com',
              assets: [
                { name: assetName, browser_download_url: 'https://example.com/asset.zip' },
                { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.com/sums.txt' },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === 'https://example.com/asset.zip')
          return new Response(new Uint8Array(zipBuf), { status: 200 });
        if (url === 'https://example.com/sums.txt') {
          return new Response(`${hash}  ${assetName}\n`, { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }) as unknown as typeof fetch;

      const spawnCalls: unknown[] = [];
      const exitCalls: number[] = [];
      // First invocation throws synchronously — e.g. the staged binary is
      // missing or a permission error — every call after that succeeds.
      let shouldThrow = true;
      const manager = createUpdateManager({
        mode: 'binary',
        currentVersion: '0.1.0',
        installDir: dir,
        getRepo: async () => 'geoffoliver/filenet',
        fetchImpl,
        spawnImpl: ((opts: unknown) => {
          if (shouldThrow) throw new Error('spawn failed');
          spawnCalls.push(opts);
          return { unref: () => {} };
        }) as unknown as typeof Bun.spawn,
        exitImpl: (code) => exitCalls.push(code),
      });

      const state = await manager.checkNow();
      expect(state.phase).toBe('ready');

      // First attempt: spawnImpl throws synchronously. The call must reject
      // rather than swallow the error.
      await expect(manager.applyAndRestart()).rejects.toThrow('spawn failed');
      expect(spawnCalls).toHaveLength(0);
      expect(exitCalls).toHaveLength(0);

      // Fix the underlying problem and retry. If the `restarting` guard was
      // never reset after the failed attempt, this second call would
      // silently no-op instead of spawning — proving the flag is genuinely
      // reset, not just that the first call threw.
      shouldThrow = false;
      await manager.applyAndRestart();

      expect(spawnCalls).toHaveLength(1);
      expect(exitCalls).toEqual([0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createUpdateManager().startPeriodicChecks', () => {
  // Let any pending microtasks (the async init/tick/scheduleNext chain)
  // settle before asserting on fetch call counts.
  async function flushMicrotasks(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('does not hit the network on boot when the interval is 0 (disabled)', async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

    const manager = createUpdateManager({
      mode: 'binary',
      currentVersion: '0.1.0',
      installDir: '/install',
      getRepo: async () => 'geoffoliver/filenet',
      fetchImpl,
    });

    const stop = manager.startPeriodicChecks(async () => 0);
    try {
      await flushMicrotasks();
      expect(fetchCalls).toBe(0);
    } finally {
      stop();
    }
  });

  it('checks immediately on boot when the interval is a valid positive value', async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

    const manager = createUpdateManager({
      mode: 'binary',
      currentVersion: '0.1.0',
      installDir: '/install',
      getRepo: async () => 'geoffoliver/filenet',
      fetchImpl,
    });

    const stop = manager.startPeriodicChecks(async () => 60);
    try {
      await flushMicrotasks();
      expect(fetchCalls).toBe(1);
    } finally {
      stop();
    }
  });
});
