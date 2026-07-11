import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { hashFile } from './indexer';

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

// Explicit whitelist of valid (platform, arch) → targetName mappings
// These are the only 5 targets built by scripts/build-binaries.sh
const VALID_TARGETS: Record<string, string> = {
  'darwin:x64': 'bun-darwin-x64',
  'darwin:arm64': 'bun-darwin-arm64',
  'linux:x64': 'bun-linux-x64',
  'linux:arm64': 'bun-linux-arm64',
  'win32:x64': 'bun-windows-x64',
};

export function targetName(platform: string, arch: string): string {
  const key = `${platform}:${arch}`;
  const target = VALID_TARGETS[key];
  if (!target) throw new Error(`Unsupported platform/arch for auto-update: ${platform}/${arch}`);
  return target;
}

export type ReleaseAsset = { name: string; url: string };
export type ReleaseInfo = { version: string; notesUrl: string; assets: ReleaseAsset[] };

export async function fetchLatestRelease(
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReleaseInfo | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'filenet-updater' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error checking for updates: ${res.status}`);

  const data = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    assets?: { name: string; browser_download_url: string }[];
  };
  if (!data.tag_name) throw new Error('Malformed GitHub release response: missing tag_name');

  return {
    version: data.tag_name.replace(/^v/, ''),
    notesUrl: data.html_url ?? '',
    assets: (data.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url })),
  };
}

export async function verifySha256(
  filePath: string,
  checksumsText: string,
  assetName: string,
): Promise<boolean> {
  const line = checksumsText
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.endsWith(assetName));
  if (!line) return false;
  const expected = line.split(/\s+/)[0]?.toLowerCase();
  if (!expected) return false;
  const actual = await hashFile(filePath);
  return actual === expected;
}

export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const JSZip = (await import('jszip')).default;
  const data = await Bun.file(zipPath).arrayBuffer();
  const zip = await JSZip.loadAsync(data);

  for (const [relPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const outPath = join(destDir, relPath);
    mkdirSync(dirname(outPath), { recursive: true });
    const buf = await entry.async('nodebuffer');
    await Bun.write(outPath, buf);
  }

  const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';
  const binaryPath = join(destDir, binaryName);
  if (process.platform !== 'win32' && existsSync(binaryPath)) {
    chmodSync(binaryPath, 0o755);
  }
}

async function downloadToFile(
  url: string,
  destPath: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = await res.arrayBuffer();
  await Bun.write(destPath, buf);
}

export async function downloadAndStage(
  release: ReleaseInfo,
  stagingRoot: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const target = targetName(process.platform, process.arch);
  const assetName = `filenet-${target}.zip`;
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) throw new Error(`Release ${release.version} has no asset named ${assetName}`);
  const checksumsAsset = release.assets.find((a) => a.name === 'SHA256SUMS.txt');
  if (!checksumsAsset) throw new Error(`Release ${release.version} is missing SHA256SUMS.txt`);

  const versionDir = join(stagingRoot, release.version);
  rmSync(versionDir, { recursive: true, force: true });
  mkdirSync(versionDir, { recursive: true });

  try {
    const zipPath = join(versionDir, assetName);
    await downloadToFile(asset.url, zipPath, fetchImpl);

    const checksumsRes = await fetchImpl(checksumsAsset.url);
    if (!checksumsRes.ok) {
      throw new Error(`Failed to download SHA256SUMS.txt: ${checksumsRes.status}`);
    }
    const checksumsText = await checksumsRes.text();

    const ok = await verifySha256(zipPath, checksumsText, assetName);
    if (!ok) throw new Error(`Checksum verification failed for ${assetName}`);

    await extractZip(zipPath, versionDir);
    rmSync(zipPath, { force: true });
  } catch (err) {
    rmSync(versionDir, { recursive: true, force: true });
    throw err;
  }

  for (const entry of readdirSync(stagingRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== release.version) {
      rmSync(join(stagingRoot, entry.name), { recursive: true, force: true });
    }
  }

  return versionDir;
}

const SWAPPED_ENTRIES = ['out', join('drizzle', 'migrations')];

export function applyUpdateSwap(stagingDir: string, installDir: string): void {
  const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';
  const entries = [binaryName, ...SWAPPED_ENTRIES];
  const oldPaths: string[] = [];

  for (const name of entries) {
    const live = join(installDir, name);
    const staged = join(stagingDir, name);
    if (!existsSync(staged)) continue; // e.g. migrations unchanged in this release

    const old = `${live}.old`;
    rmSync(old, { recursive: true, force: true });
    if (existsSync(live)) {
      renameSync(live, old);
      oldPaths.push(old);
    }
    renameSync(staged, live);
  }

  // Only remove the .old backups (and the now-empty staging dir) after every
  // entry has swapped successfully — if a rename above throws, the .old
  // siblings from entries that already succeeded are deliberately left in
  // place so a human can recover manually rather than being left with a
  // half-updated, possibly non-functional install.
  for (const old of oldPaths) rmSync(old, { recursive: true, force: true });
  rmSync(stagingDir, { recursive: true, force: true });
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export async function waitForPidExit(
  pid: number,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const pollMs = opts.pollMs ?? 200;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const start = Date.now();
  while (isProcessRunning(pid)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for process ${pid} to exit`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export function parseFinishUpdateArgs(
  argv: string[],
): { oldPid: number; stagingDir: string; installDir: string } | null {
  const idx = argv.indexOf('--finish-update');
  if (idx === -1) return null;
  const oldPid = Number(argv[idx + 1]);
  const stagingDir = argv[idx + 2];
  const installDir = argv[idx + 3];
  if (!Number.isInteger(oldPid) || !stagingDir || !installDir) {
    throw new Error('Malformed --finish-update arguments');
  }
  return { oldPid, stagingDir, installDir };
}

export type FinishUpdateDeps = {
  waitForExit?: typeof waitForPidExit;
  applySwap?: typeof applyUpdateSwap;
  spawnImpl?: typeof Bun.spawn;
  exitImpl?: (code: number) => void;
};

export async function runFinishUpdate(
  oldPid: number,
  stagingDir: string,
  installDir: string,
  deps: FinishUpdateDeps = {},
): Promise<void> {
  const {
    waitForExit = waitForPidExit,
    applySwap = applyUpdateSwap,
    spawnImpl = Bun.spawn,
    exitImpl = process.exit,
  } = deps;

  await waitForExit(oldPid);
  applySwap(stagingDir, installDir);

  const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';
  const child = spawnImpl({
    cmd: [join(installDir, binaryName)],
    cwd: installDir,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  exitImpl(0);
}
