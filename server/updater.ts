import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

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
  const resolvedDestDir = resolve(destDir);

  for (const [relPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const outPath = join(destDir, relPath);
    // Defense-in-depth against zip slip: every archive we extract is our
    // own SHA-256-verified GitHub release, but reject any entry whose
    // resolved path would land outside destDir (via '../' segments or an
    // absolute path) rather than trusting the archive contents blindly.
    if (!resolve(outPath).startsWith(resolvedDestDir + sep)) {
      throw new Error(`Refusing to extract zip entry outside destination directory: ${relPath}`);
    }
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
  // Deliberately do NOT touch `res.body` here (not even a truthiness check)
  // before handing `res` to Bun.write. In this Bun version (1.3.14),
  // accessing the `.body` getter on a Response before passing that same
  // Response to Bun.write() poisons Bun.write's internal fast path and
  // causes it to hang indefinitely streaming the body — reproduced in
  // isolation against both a synthetic Buffer-backed Response and a real
  // network-backed Response, independent of the test runner. Checking
  // `res.ok` alone does not trigger it, and a bad/empty download is still
  // caught safely downstream by the SHA-256 checksum verification in
  // downloadAndStage, so no coverage is lost by dropping the `.body` check.
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  await Bun.write(destPath, res);
}

// `release.version` is derived from the configured repo's GitHub release
// tag_name (see fetchLatestRelease) and is about to be used as a filesystem
// path segment (joined into stagingRoot, then recursively rmSync'd and
// mkdirSync'd). `updateRepo` is a user-configurable Settings field — forks
// can point their users at their own releases — so a malicious or
// misconfigured fork could publish a release whose tag is crafted to escape
// stagingRoot via '../' segments (git tags can legally contain '/').
// Validate the format cheaply, then — mirroring extractZip's
// resolvedDestDir/startsWith zip-slip guard in this same file — resolve the
// final path and confirm it's still contained within stagingRoot before any
// destructive operation touches it.
function safeVersionDir(version: string, stagingRoot: string): string {
  if (!version || /[\\/]/.test(version) || version.includes('..')) {
    throw new Error(`Refusing to stage release with unsafe version string: ${version}`);
  }
  const resolvedStagingRoot = resolve(stagingRoot);
  const versionDir = join(stagingRoot, version);
  if (!resolve(versionDir).startsWith(resolvedStagingRoot + sep)) {
    throw new Error(`Refusing to stage release outside staging root: ${version}`);
  }
  return versionDir;
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

  const versionDir = safeVersionDir(release.version, stagingRoot);
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

// `out` and the binary are REQUIRED — per scripts/build-binaries.sh, every
// valid release always packages both, so a release missing either is
// mispackaged and must not be applied. `drizzle/migrations` stays OPTIONAL
// for forward-compatibility (a release with no migration changes may
// legitimately omit it), matching the original design intent, even though
// in practice today's build script always includes it too.
const OPTIONAL_ENTRIES = [join('drizzle', 'migrations')];

export function applyUpdateSwap(stagingDir: string, installDir: string): void {
  const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';
  const requiredEntries = [binaryName, 'out'];

  // Fail fast, before any file on the live install is touched, if a
  // required entry is missing from the staged release. This is safer than
  // swapping whatever entries ARE present and then discarding their .old
  // backups in the cleanup below — which would otherwise happen even though
  // the update as a whole never actually completed, leaving a
  // partially-updated install with no recovery path and no error raised.
  for (const name of requiredEntries) {
    if (!existsSync(join(stagingDir, name))) {
      throw new Error(`Staged update at ${stagingDir} is missing required entry: ${name}`);
    }
  }

  const entries = [...requiredEntries, ...OPTIONAL_ENTRIES];
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
    // Ensure the destination's parent directory exists before the
    // copy/rename below — renameSync/copyFileSync both require it. This
    // matters for nested entries (e.g. drizzle/migrations, whose parent is
    // installDir/drizzle) if that intermediate directory doesn't already
    // exist on the live install for any reason; it's a no-op for top-level
    // entries like the binary and `out`, since dirname(installDir/out) is
    // just installDir, which always exists by this point.
    mkdirSync(dirname(live), { recursive: true });
    // On Windows, the intermediate --finish-update process runs from the
    // staged binary itself (see applyAndRestart's spawn), so the binary
    // entry can't be renamed here — Windows locks a running executable's
    // file against rename/delete (though reading it is still fine), which
    // renameSync would need. Directories aren't subject to this lock.
    if (process.platform === 'win32' && name === binaryName) {
      copyFileSync(staged, live);
    } else {
      renameSync(staged, live);
    }
  }

  // Only remove the .old backups (and the now-empty staging dir) after every
  // entry has swapped successfully — if a rename above throws, the .old
  // siblings from entries that already succeeded are deliberately left in
  // place so a human can recover manually rather than being left with a
  // half-updated, possibly non-functional install.
  for (const old of oldPaths) rmSync(old, { recursive: true, force: true });

  // Best-effort only: on Windows a process cannot delete its own current
  // working directory (which is what stagingDir is, for the --finish-update
  // child that calls this function), so this can throw a sharing-violation
  // error even though the swap above fully succeeded. A leftover staging
  // dir is harmless: downloadAndStage's stale-version cleanup will remove it
  // whenever a future update check actually stages a newer version (that
  // cleanup doesn't run on every check — only when downloadAndStage itself
  // runs), so it may persist indefinitely if this is the last update ever
  // applied. A human can also delete .filenet-update/<version>/ by hand if
  // that ever matters. Either way, failing to remove it here must never
  // block the relaunch that already succeeded at swapping the real files.
  try {
    rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // ignore — see comment above
  }
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
): { oldPid: number; stagingDir: string; installDir: string; launchCwd: string } | null {
  const idx = argv.indexOf('--finish-update');
  if (idx === -1) return null;
  const oldPid = Number(argv[idx + 1]);
  const stagingDir = argv[idx + 2];
  const installDir = argv[idx + 3];
  const launchCwd = argv[idx + 4];
  if (!Number.isInteger(oldPid) || !stagingDir || !installDir || !launchCwd) {
    throw new Error('Malformed --finish-update arguments');
  }
  return { oldPid, stagingDir, installDir, launchCwd };
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
  launchCwd: string,
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
  // cwd is the ORIGINAL launch directory (not installDir) so relative paths
  // the app resolves at startup — e.g. the default DATABASE_URL in db.ts —
  // point at the same location they did before the update, even when the
  // app was launched from a directory other than the install dir.
  const child = spawnImpl({
    cmd: [join(installDir, binaryName)],
    cwd: launchCwd,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  exitImpl(0);
}

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export type UpdateState = {
  mode: 'binary' | 'source';
  currentVersion: string;
  phase: UpdatePhase;
  latestVersion: string | null;
  releaseNotesUrl: string | null;
  error: string | null;
  lastCheckedAt: string | null;
};

export type UpdateManagerOptions = {
  mode: 'binary' | 'source';
  currentVersion: string;
  installDir: string;
  getRepo: () => Promise<string>;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof Bun.spawn;
  exitImpl?: (code: number) => void;
};

export type UpdateManager = {
  getState(): UpdateState;
  checkNow(): Promise<UpdateState>;
  startPeriodicChecks(getIntervalMinutes: () => Promise<number>): () => void;
  applyAndRestart(): Promise<void>;
};

const MAX_UPDATE_CHECK_INTERVAL_MINUTES = 35791;

export function createUpdateManager(opts: UpdateManagerOptions): UpdateManager {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const spawnImpl = opts.spawnImpl ?? Bun.spawn;
  const exitImpl = opts.exitImpl ?? process.exit;

  let state: UpdateState = {
    mode: opts.mode,
    currentVersion: opts.currentVersion,
    phase: 'idle',
    latestVersion: null,
    releaseNotesUrl: null,
    error: null,
    lastCheckedAt: null,
  };
  let stagingDir: string | null = null;
  let restarting = false;

  function getState(): UpdateState {
    return { ...state };
  }

  async function checkNow(): Promise<UpdateState> {
    // Re-entrancy guard: a check is already in flight (manual POST and the
    // periodic scheduler can both call checkNow()). Overlapping calls would
    // both drive downloadAndStage against the same staging path — which
    // rmSync()s and re-extracts into it — so a second call while one is
    // already running is a no-op rather than starting a new cycle.
    if (state.phase === 'checking' || state.phase === 'downloading') {
      return getState();
    }
    const alreadyReadyVersion = state.phase === 'ready' ? state.latestVersion : null;

    state = { ...state, phase: 'checking', error: null };
    try {
      const repo = await opts.getRepo();
      const release = await fetchLatestRelease(repo, fetchImpl);
      const now = new Date().toISOString();

      if (!release || !isNewerVersion(release.version, opts.currentVersion)) {
        stagingDir = null;
        state = {
          ...state,
          phase: 'idle',
          latestVersion: null,
          releaseNotesUrl: null,
          lastCheckedAt: now,
        };
        return getState();
      }

      // Already staged and ready for this exact version — avoid re-staging
      // (and re-downloading) on every periodic tick; this also shrinks the
      // race window the guard above closes.
      if (alreadyReadyVersion === release.version) {
        state = { ...state, phase: 'ready', lastCheckedAt: now };
        return getState();
      }

      state = {
        ...state,
        phase: 'available',
        latestVersion: release.version,
        releaseNotesUrl: release.notesUrl,
        lastCheckedAt: now,
      };
      if (opts.mode !== 'binary') return getState();

      state = { ...state, phase: 'downloading' };
      stagingDir = await downloadAndStage(
        release,
        join(opts.installDir, '.filenet-update'),
        fetchImpl,
      );
      state = { ...state, phase: 'ready' };
      return getState();
    } catch (err) {
      state = { ...state, phase: 'error', error: err instanceof Error ? err.message : String(err) };
      return getState();
    }
  }

  function startPeriodicChecks(getIntervalMinutes: () => Promise<number>): () => void {
    let stopped = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    function isEnabledInterval(intervalMinutes: number): boolean {
      return (
        Number.isFinite(intervalMinutes) &&
        intervalMinutes > 0 &&
        intervalMinutes <= MAX_UPDATE_CHECK_INTERVAL_MINUTES
      );
    }

    async function tick() {
      if (stopped) return;
      await checkNow().catch((err) => console.error('Update check failed:', err));
      if (!stopped) scheduleNext();
    }

    async function scheduleNext() {
      if (stopped) return;
      let intervalMinutes = 0;
      try {
        intervalMinutes = await getIntervalMinutes();
      } catch (err) {
        console.error('Failed to read update check interval:', err);
      }
      if (stopped) return;
      if (!isEnabledInterval(intervalMinutes)) {
        timerId = setTimeout(
          () => scheduleNext().catch((err) => console.error('Update check schedule failed:', err)),
          60_000,
        );
        return;
      }
      timerId = setTimeout(
        () => tick().catch((err) => console.error('Update check tick failed:', err)),
        intervalMinutes * 60_000,
      );
    }

    async function init() {
      if (stopped) return;
      let intervalMinutes = 0;
      try {
        intervalMinutes = await getIntervalMinutes();
      } catch (err) {
        console.error('Failed to read update check interval:', err);
      }
      if (stopped) return;
      if (isEnabledInterval(intervalMinutes)) {
        // Valid, positive interval — preserve the existing behavior of
        // checking immediately on boot, then continuing on schedule.
        await tick();
      } else {
        // interval is 0/disabled (or invalid/out-of-range) — don't hit
        // GitHub on boot for a check the user explicitly turned off.
        // scheduleNext's own bounds check will just poll every 60s waiting
        // for a valid interval, exactly like it already does for the
        // "became disabled mid-run" case, so this never makes a network
        // call while disabled and picks the check back up promptly once
        // re-enabled.
        //
        // Deliberately different from startPeriodicRescan in
        // server/indexer.ts, which always ticks immediately on boot
        // regardless of its interval — that's fine there because rescanning
        // only walks the local filesystem into the local SQLite DB, with no
        // external network call, no rate limits, and no "user explicitly
        // disabled this" surprise factor. checkNow() here makes a real
        // outbound HTTPS call to api.github.com, which is exactly what a
        // user setting "0 = disabled" would expect to be fully suppressed,
        // including at boot. Do not "fix" this back to match indexer.ts.
        await scheduleNext();
      }
    }

    init().catch((err) => console.error('Update check init failed:', err));

    return () => {
      stopped = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    };
  }

  async function applyAndRestart(): Promise<void> {
    if (state.phase !== 'ready' || !stagingDir) {
      throw new Error('No update ready to apply');
    }
    // Re-entrancy guard: /api/update-restart can be hit more than once while
    // this process is still alive (double-click, two browser tabs) — each
    // request independently observes phase === 'ready' and schedules its own
    // applyAndRestart() call (see management.ts), since applyAndRestart is
    // deferred via setTimeout and doesn't itself change `phase`. Mirrors the
    // checkNow() re-entrancy guard above: the set happens synchronously,
    // before the function's first await, so a second call always observes
    // `restarting` already true and no-ops rather than spawning a second
    // --finish-update process racing the first against the same staging dir.
    if (restarting) return;
    restarting = true;
    try {
      // The currently-running (old) process's cwd — captured here, before it
      // exits, so the --finish-update child can pass it through to the final
      // relaunch and restore the original launch directory (see runFinishUpdate).
      const launchCwd = process.cwd();
      const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';
      const child = spawnImpl({
        cmd: [
          join(stagingDir, binaryName),
          '--finish-update',
          String(process.pid),
          stagingDir,
          opts.installDir,
          launchCwd,
        ],
        // installDir, not stagingDir: this --finish-update child later removes
        // stagingDir (see applyUpdateSwap) — on Windows a process cannot
        // delete its own cwd, so spawning with cwd inside the directory it
        // will delete would break that cleanup.
        cwd: opts.installDir,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.unref();
      // exitImpl is process.exit by default, which terminates the process
      // here in production. Injected test doubles just record the call and
      // return normally instead.
      exitImpl(0);
    } catch (err) {
      // If spawning the --finish-update child throws synchronously (staged
      // binary missing, permission error, etc.), don't leave `restarting`
      // stuck true forever — that would permanently disable every future
      // applyAndRestart() call, including legitimate retries after the
      // underlying problem is fixed, with no recovery short of restarting
      // this process. Reset the guard so the next call can try again.
      restarting = false;
      throw err;
    }
  }

  return { getState, checkNow, startPeriodicChecks, applyAndRestart };
}
