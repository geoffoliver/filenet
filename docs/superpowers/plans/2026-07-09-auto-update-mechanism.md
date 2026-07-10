# Auto-Update Mechanism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standalone-binary Filenet installs detect new GitHub releases, download and checksum-verify them in the background, and let the user apply the update with a single "Restart to update" click that self-relaunches onto the new version — no terminal, no service manager.

**Architecture:** A `server/updater.ts` state machine (`idle → checking → available → downloading → ready`, or `error`) polls the GitHub Releases API, stages a verified `.zip` under `<installDir>/.filenet-update/`, and — on user confirmation — spawns the _staged_ binary with a `--finish-update <oldPid> <stagingDir> <installDir>` flag. That child waits for the old process to exit, swaps `filenet(.exe)`/`out/`/`drizzle/migrations` into place, then re-execs itself as the normal app. Docker/dev deployments ("source mode") only ever reach `available` — no download/swap machinery runs there. The frontend polls a small status endpoint and reuses the existing toast/desktop-notification infrastructure.

**Tech Stack:** Bun (`bun build --compile`, `Bun.spawn`, `Bun.write`), Drizzle/SQLite, `jszip` (already a dependency) for zip extraction, `node:crypto`'s `createHash('sha256')` (already used by the indexer) for checksums, Next.js/React for the Settings UI, `bun:test` + Playwright for tests.

## Global Constraints

- Auto-update only runs when `isCompiledBinary()` is true (standalone executable). Docker and `bun run server` dev usage are "source mode": status is still reported, but no download/apply logic ever executes.
- Release archives are standardized on `.zip` for all 5 targets (`bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, `bun-windows-x64`) — no shelling out to `tar`/`unzip` at runtime.
- Every downloaded archive is SHA-256 verified against a `SHA256SUMS.txt` published alongside the release before it is extracted or applied.
- No download-progress UI (byte/percent) — status is coarse-grained (`idle`/`checking`/`available`/`downloading`/`ready`/`error`).
- Update state (`phase`, `latestVersion`, staged directory, etc.) lives in memory in the running process only — never persisted to the DB. A restart before the user applies an update just re-checks and re-stages.
- `updateRepo` setting defaults to `'geoffoliver/filenet'` and is validated as `owner/repo`.
- Follow this repo's existing patterns throughout: Drizzle schema/migration conventions (`server/schema.ts`), the `startPeriodicRescan` closure shape (`server/indexer.ts`) for the periodic-check loop, the `useFriendRequestNotifications`/`friendRequestDiff.ts` split (pure diff logic + polling hook) for notifications, and the `Section`/`SaveButton` component conventions in `app/(shell)/settings/SettingsView.tsx`.
- TDD throughout: write the failing test, watch it fail, implement, watch it pass, commit.
- Tasks 4–9 all append to the same two files, `server/updater.ts` and `server/__tests__/updater.test.ts`, and each step's shown code block includes the `import` lines it needs alongside the code. Whenever a step's snippet shows new `import` lines, add them (or merge their named imports into an existing `import { ... } from '<module>'` line) at the **top** of the file — not literally at the point in the file where the snippet is shown — and never leave two separate `import` statements for the same module in one file. This project's ESLint config (`eslint --max-warnings=0` in the pre-commit hook) flags duplicate imports from the same module, and imports mid-file are just bad style even though JS hoists them.

---

### Task 1: Settings schema — `updateRepo` / `updateCheckIntervalMinutes`

**Files:**

- Modify: `server/schema.ts` (the `settings` table, currently ending at `listenPort`)
- Create: `drizzle/migrations/000X_<generated-name>.sql` (via `drizzle-kit generate`, not hand-written)
- Test: `server/__tests__/config.test.ts`

**Interfaces:**

- Produces: `Settings.updateRepo: string` (default `'geoffoliver/filenet'`), `Settings.updateCheckIntervalMinutes: number` (default `1440`) — consumed by Tasks 2, 9, 11, 13.

- [ ] **Step 1: Write the failing test**

Add to `server/__tests__/config.test.ts`, inside the existing `describe('getOrCreateSettings', ...)` block:

```ts
it('defaults updateRepo and updateCheckIntervalMinutes', async () => {
  const s = await getOrCreateSettings(db);
  expect(s.updateRepo).toBe('geoffoliver/filenet');
  expect(s.updateCheckIntervalMinutes).toBe(1440);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/__tests__/config.test.ts`
Expected: FAIL — `s.updateRepo` is `undefined`, not `'geoffoliver/filenet'`.

- [ ] **Step 3: Add the columns to the schema**

In `server/schema.ts`, in the `settings` table definition, immediately after the `listenPort` line:

```ts
  listenPort: integer('listenPort').notNull().default(7734),
  updateRepo: text('updateRepo').notNull().default('geoffoliver/filenet'),
  updateCheckIntervalMinutes: integer('updateCheckIntervalMinutes').notNull().default(1440),
});
```

- [ ] **Step 4: Generate the migration**

Run: `bunx drizzle-kit generate`

Expected: a new file `drizzle/migrations/000X_<two-word-name>.sql` containing two `ALTER TABLE` statements, shaped like:

```sql
ALTER TABLE `Settings` ADD `updateRepo` text DEFAULT 'geoffoliver/filenet' NOT NULL;--> statement-breakpoint
ALTER TABLE `Settings` ADD `updateCheckIntervalMinutes` integer DEFAULT 1440 NOT NULL;
```

Read the generated file and confirm both `ADD` statements are present with these exact column names, types, and defaults (drizzle-kit picks the filename and may order the two statements either way — that's fine, don't hand-edit it).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test server/__tests__/config.test.ts`
Expected: PASS (the test DB at `./data/test-config.db` gets migrated fresh by `applyMigrations` in `beforeAll`, picking up the new migration file automatically).

- [ ] **Step 6: Format and commit**

```bash
bunx prettier --write server/schema.ts server/__tests__/config.test.ts
git add server/schema.ts server/__tests__/config.test.ts drizzle/migrations
git commit -m "feat: add updateRepo and updateCheckIntervalMinutes settings fields"
```

---

### Task 2: Settings validation and patch types

**Files:**

- Modify: `server/schemas.ts` (`PatchSettingsBodySchema`)
- Modify: `server/config.ts` (`SettingsPatch` type)
- Test: `server/__tests__/schemas.test.ts`

**Interfaces:**

- Consumes: `Settings.updateRepo`/`updateCheckIntervalMinutes` from Task 1.
- Produces: `PatchSettingsBodySchema` accepting `updateRepo`/`updateCheckIntervalMinutes`; `SettingsPatch.updateRepo?: string` / `SettingsPatch.updateCheckIntervalMinutes?: number` — consumed by Task 10's `PATCH /api/settings` handler (already generic over `SettingsPatch`, no handler change needed) and Task 15's Settings UI.

- [ ] **Step 1: Write the failing test**

Find the `describe('PatchSettingsBodySchema', ...)` block in `server/__tests__/schemas.test.ts` (or the nearest equivalent covering this schema) and add:

```ts
it('accepts a valid owner/repo updateRepo', () => {
  const result = PatchSettingsBodySchema.safeParse({ updateRepo: 'someone/fork' });
  expect(result.success).toBe(true);
});

it('rejects an updateRepo without a slash', () => {
  const result = PatchSettingsBodySchema.safeParse({ updateRepo: 'not-a-repo' });
  expect(result.success).toBe(false);
});

it('accepts a valid updateCheckIntervalMinutes', () => {
  const result = PatchSettingsBodySchema.safeParse({ updateCheckIntervalMinutes: 60 });
  expect(result.success).toBe(true);
});

it('rejects a negative updateCheckIntervalMinutes', () => {
  const result = PatchSettingsBodySchema.safeParse({ updateCheckIntervalMinutes: -1 });
  expect(result.success).toBe(false);
});
```

(If `server/__tests__/schemas.test.ts` doesn't already import `PatchSettingsBodySchema`, add it to the existing import from `../schemas`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/__tests__/schemas.test.ts`
Expected: FAIL — `.strict()` rejects the unknown keys `updateRepo`/`updateCheckIntervalMinutes`.

- [ ] **Step 3: Extend the schema**

In `server/schemas.ts`, inside `PatchSettingsBodySchema`'s object, immediately after `listenPort`:

```ts
    listenPort: z
      .int()
      .min(1, 'listenPort must be between 1 and 65535')
      .max(65535, 'listenPort must be between 1 and 65535')
      .optional(),
    updateRepo: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'updateRepo must be in the form owner/repo')
      .optional(),
    updateCheckIntervalMinutes: z.int().min(0).max(35791).optional(),
  })
  .strict();
```

- [ ] **Step 4: Extend the `SettingsPatch` type**

In `server/config.ts`:

```ts
export type SettingsPatch = {
  name?: string;
  invitePassword?: string | null;
  autoAcceptFromAnyone?: boolean;
  autoAcceptFromFriendsOfFriends?: boolean;
  sharedFolders?: string[];
  downloadFolder?: string | null;
  rescanIntervalMinutes?: number;
  listenPort?: number;
  updateRepo?: string;
  updateCheckIntervalMinutes?: number;
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test server/__tests__/schemas.test.ts`
Expected: PASS

- [ ] **Step 6: Format and commit**

```bash
bunx prettier --write server/schemas.ts server/config.ts server/__tests__/schemas.test.ts
git add server/schemas.ts server/config.ts server/__tests__/schemas.test.ts
git commit -m "feat: validate updateRepo/updateCheckIntervalMinutes in settings patch"
```

---

### Task 3: Runtime-mode detection — `isCompiledBinary`

**Files:**

- Modify: `server/runtime-paths.ts`
- Test: `server/__tests__/runtime-paths.test.ts`

**Interfaces:**

- Produces: `isCompiledBinary(callerDir: string): boolean` — consumed by Task 11 (`server/index.ts`, to set `UpdateManagerOptions.mode`).

- [ ] **Step 1: Write the failing test**

Append to `server/__tests__/runtime-paths.test.ts`:

```ts
import { isCompiledBinary, resolveAssetPath } from '../runtime-paths';
import { writeFileSync } from 'node:fs';

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
```

Note: `resolveAssetPath` is already imported at the top of this file — add `isCompiledBinary` to that same import line rather than a second one.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/__tests__/runtime-paths.test.ts`
Expected: FAIL — `isCompiledBinary` is not exported yet.

- [ ] **Step 3: Implement `isCompiledBinary`**

In `server/runtime-paths.ts`, after `resolveAssetPath`:

```ts
/**
 * True when running as a `bun build --compile` executable rather than from
 * source. `package.json` sits at the repo root in every source-mode shape
 * (dev, Docker — see Dockerfile's `COPY --from=builder /app/package.json`)
 * and is deliberately never packaged into a compiled binary's dist
 * directory by scripts/build-binaries.sh, so its absence is a reliable
 * signal.
 */
export function isCompiledBinary(callerDir: string): boolean {
  return !existsSync(join(callerDir, '..', 'package.json'));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test server/__tests__/runtime-paths.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bunx prettier --write server/runtime-paths.ts server/__tests__/runtime-paths.test.ts
git add server/runtime-paths.ts server/__tests__/runtime-paths.test.ts
git commit -m "feat: add isCompiledBinary runtime-mode detection"
```

---

### Task 4: Version comparison and target-name mapping

**Files:**

- Create: `server/updater.ts`
- Test: `server/__tests__/updater.test.ts`

**Interfaces:**

- Produces: `compareVersions(a: string, b: string): number`, `isNewerVersion(candidate: string, current: string): boolean`, `targetName(platform: string, arch: string): string` — consumed by Task 5 (release matching) and Task 6 (asset name).

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/updater.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';

import { compareVersions, isNewerVersion, targetName } from '../updater';

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/__tests__/updater.test.ts`
Expected: FAIL — `server/updater.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `server/updater.ts`:

```ts
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

const TARGET_OS: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
const TARGET_ARCH: Record<string, string> = { x64: 'x64', arm64: 'arm64' };

export function targetName(platform: string, arch: string): string {
  const os = TARGET_OS[platform];
  const a = TARGET_ARCH[arch];
  if (!os || !a) throw new Error(`Unsupported platform/arch for auto-update: ${platform}/${arch}`);
  return `bun-${os}-${a}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test server/__tests__/updater.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bunx prettier --write server/updater.ts server/__tests__/updater.test.ts
git add server/updater.ts server/__tests__/updater.test.ts
git commit -m "feat: add version comparison and build-target-name mapping"
```

---

### Task 5: Fetch the latest GitHub release

**Files:**

- Modify: `server/updater.ts`
- Test: `server/__tests__/updater.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `type ReleaseAsset = { name: string; url: string }`, `type ReleaseInfo = { version: string; notesUrl: string; assets: ReleaseAsset[] }`, `fetchLatestRelease(repo: string, fetchImpl?: typeof fetch): Promise<ReleaseInfo | null>` — consumed by Task 6 (`downloadAndStage`) and Task 9 (`checkNow`).

- [ ] **Step 1: Write the failing test**

Append to `server/__tests__/updater.test.ts`:

```ts
import { fetchLatestRelease } from '../updater';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/__tests__/updater.test.ts`
Expected: FAIL — `fetchLatestRelease` is not exported yet.

- [ ] **Step 3: Implement**

Append to `server/updater.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test server/__tests__/updater.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bunx prettier --write server/updater.ts server/__tests__/updater.test.ts
git add server/updater.ts server/__tests__/updater.test.ts
git commit -m "feat: fetch and parse the latest GitHub release"
```

---

### Task 6: Download, verify, and stage a release

**Files:**

- Modify: `server/updater.ts`
- Test: `server/__tests__/updater.test.ts`

**Interfaces:**

- Consumes: `ReleaseInfo`/`ReleaseAsset` (Task 5), `targetName` (Task 4), `hashFile` from `server/indexer.ts` (existing).
- Produces: `verifySha256(filePath: string, checksumsText: string, assetName: string): Promise<boolean>`, `extractZip(zipPath: string, destDir: string): Promise<void>`, `downloadAndStage(release: ReleaseInfo, stagingRoot: string, fetchImpl?: typeof fetch): Promise<string>` (returns the staged version directory) — consumed by Task 9 (`checkNow`).

- [ ] **Step 1: Write the failing tests**

Append to `server/__tests__/updater.test.ts`:

```ts
import { mkdtempSync, rmSync, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

import { verifySha256, extractZip, downloadAndStage } from '../updater';

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
    const hash = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde';
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/__tests__/updater.test.ts`
Expected: FAIL — `verifySha256`/`extractZip`/`downloadAndStage` are not exported yet.

- [ ] **Step 3: Implement**

Append to `server/updater.ts`:

```ts
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { hashFile } from './indexer';

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
  await Bun.write(destPath, res);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/__tests__/updater.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bunx prettier --write server/updater.ts server/__tests__/updater.test.ts
git add server/updater.ts server/__tests__/updater.test.ts
git commit -m "feat: download, checksum-verify, and stage release archives"
```

---

### Task 7: File swap logic

**Files:**

- Modify: `server/updater.ts`
- Test: `server/__tests__/updater.test.ts`

**Interfaces:**

- Produces: `applyUpdateSwap(stagingDir: string, installDir: string): void` — consumed by Task 8 (`runFinishUpdate`).

- [ ] **Step 1: Write the failing tests**

Append to `server/__tests__/updater.test.ts`:

```ts
import { writeFileSync, readFileSync } from 'node:fs';

import { applyUpdateSwap } from '../updater';

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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/__tests__/updater.test.ts`
Expected: FAIL — `applyUpdateSwap` is not exported yet.

- [ ] **Step 3: Implement**

Append to `server/updater.ts`:

```ts
import { renameSync } from 'node:fs';

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/__tests__/updater.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bunx prettier --write server/updater.ts server/__tests__/updater.test.ts
git add server/updater.ts server/__tests__/updater.test.ts
git commit -m "feat: swap staged files into the install directory"
```

---

### Task 8: Self-relaunch — PID wait and `--finish-update` handler

**Files:**

- Modify: `server/updater.ts`
- Test: `server/__tests__/updater.test.ts`

**Interfaces:**

- Consumes: `applyUpdateSwap` (Task 7).
- Produces: `isProcessRunning(pid: number): boolean`, `waitForPidExit(pid: number, opts?: { pollMs?: number; timeoutMs?: number }): Promise<void>`, `parseFinishUpdateArgs(argv: string[]): { oldPid: number; stagingDir: string; installDir: string } | null`, `runFinishUpdate(oldPid: number, stagingDir: string, installDir: string, deps?: FinishUpdateDeps): Promise<void>` — consumed by Task 11 (`server/index.ts` boot sequence) and Task 9 (`applyAndRestart` spawns a process that runs this).

- [ ] **Step 1: Write the failing tests**

Append to `server/__tests__/updater.test.ts`:

```ts
import {
  isProcessRunning,
  waitForPidExit,
  parseFinishUpdateArgs,
  runFinishUpdate,
} from '../updater';

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

  it('parses oldPid/stagingDir/installDir when present', () => {
    expect(
      parseFinishUpdateArgs(['filenet', '--finish-update', '1234', '/staging', '/install']),
    ).toEqual({ oldPid: 1234, stagingDir: '/staging', installDir: '/install' });
  });

  it('throws when arguments are missing', () => {
    expect(() => parseFinishUpdateArgs(['filenet', '--finish-update', '1234'])).toThrow();
  });
});

describe('runFinishUpdate', () => {
  it('waits for the old pid, swaps files, spawns the new binary, and exits', async () => {
    const calls: string[] = [];
    const fakeChild = { unref: () => calls.push('unref') };
    await runFinishUpdate(1234, '/staging', '/install', {
      waitForExit: async (pid) => {
        calls.push(`wait:${pid}`);
      },
      applySwap: (staging, install) => {
        calls.push(`swap:${staging}:${install}`);
      },
      spawnImpl: ((opts: { cmd: string[] }) => {
        calls.push(`spawn:${opts.cmd.join(',')}`);
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
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/__tests__/updater.test.ts`
Expected: FAIL — the four new exports don't exist yet.

- [ ] **Step 3: Implement**

Append to `server/updater.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/__tests__/updater.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bunx prettier --write server/updater.ts server/__tests__/updater.test.ts
git add server/updater.ts server/__tests__/updater.test.ts
git commit -m "feat: add self-relaunch PID-wait and --finish-update handler"
```

---

### Task 9: `UpdateManager` state machine

**Files:**

- Modify: `server/updater.ts`
- Test: `server/__tests__/updater.test.ts`

**Interfaces:**

- Consumes: `fetchLatestRelease`, `isNewerVersion`, `downloadAndStage` (Tasks 4–6).
- Produces: `type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'`, `type UpdateState = { mode: 'binary' | 'source'; currentVersion: string; phase: UpdatePhase; latestVersion: string | null; releaseNotesUrl: string | null; error: string | null; lastCheckedAt: string | null }`, `type UpdateManagerOptions`, `type UpdateManager = { getState(): UpdateState; checkNow(): Promise<UpdateState>; startPeriodicChecks(getIntervalMinutes: () => Promise<number>): () => void; applyAndRestart(): Promise<void> }`, `createUpdateManager(opts: UpdateManagerOptions): UpdateManager` — consumed by Task 10 (`ManagementDeps`) and Task 11 (`server/index.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `server/__tests__/updater.test.ts`:

```ts
import { createUpdateManager } from '../updater';

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
        if (url === 'https://example.com/asset.zip') return new Response(zipBuf, { status: 200 });
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
      const cmd = (spawnCalls[0] as { cmd: string[] }).cmd;
      expect(cmd[1]).toBe('--finish-update');
      expect(cmd[2]).toBe(String(process.pid));
      expect(exitCalls).toEqual([0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/__tests__/updater.test.ts`
Expected: FAIL — `createUpdateManager` is not exported yet.

- [ ] **Step 3: Implement**

Append to `server/updater.ts`:

```ts
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

  function getState(): UpdateState {
    return { ...state };
  }

  async function checkNow(): Promise<UpdateState> {
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
      if (
        !Number.isFinite(intervalMinutes) ||
        intervalMinutes <= 0 ||
        intervalMinutes > MAX_UPDATE_CHECK_INTERVAL_MINUTES
      ) {
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

    tick().catch((err) => console.error('Update check init failed:', err));

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
    const binaryName = process.platform === 'win32' ? 'filenet.exe' : 'filenet';
    const child = spawnImpl({
      cmd: [
        join(stagingDir, binaryName),
        '--finish-update',
        String(process.pid),
        stagingDir,
        opts.installDir,
      ],
      cwd: stagingDir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.unref();
    // exitImpl is process.exit by default, which terminates the process
    // here in production. Injected test doubles just record the call and
    // return normally instead.
    exitImpl(0);
  }

  return { getState, checkNow, startPeriodicChecks, applyAndRestart };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/__tests__/updater.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bunx prettier --write server/updater.ts server/__tests__/updater.test.ts
git add server/updater.ts server/__tests__/updater.test.ts
git commit -m "feat: add UpdateManager state machine with periodic checks"
```

---

### Task 10: Management API routes

**Files:**

- Modify: `server/management.ts`
- Test: `server/__tests__/management.test.ts`

**Interfaces:**

- Consumes: `UpdateManager`, `UpdateState` (Task 9).
- Produces: `ManagementDeps.updater: UpdateManager`; routes `GET /api/update-status`, `POST /api/update-check`, `POST /api/update-restart` — consumed by Task 11 (wiring) and Task 13 (frontend `api.ts`).

- [ ] **Step 1: Write the failing tests**

In `server/__tests__/management.test.ts`, extend `makeHandler()` to accept an injectable fake updater, and add a new `describe` block. First, change the helper:

```ts
import type { UpdateManager, UpdateState } from '../updater';

function makeFakeUpdater(overrides: Partial<UpdateState> = {}): UpdateManager & {
  checkNowCalls: number;
  applyAndRestartCalls: number;
} {
  const state: UpdateState = {
    mode: 'binary',
    currentVersion: '0.1.0',
    phase: 'idle',
    latestVersion: null,
    releaseNotesUrl: null,
    error: null,
    lastCheckedAt: null,
    ...overrides,
  };
  const fake = {
    checkNowCalls: 0,
    applyAndRestartCalls: 0,
    getState: () => state,
    checkNow: async () => {
      fake.checkNowCalls++;
      return state;
    },
    startPeriodicChecks: () => () => {},
    applyAndRestart: async () => {
      fake.applyAndRestartCalls++;
      throw new Error('test double: applyAndRestart should not actually be awaited by the route');
    },
  };
  return fake;
}

function makeHandler(updater: UpdateManager = makeFakeUpdater()) {
  return createManagementFetch({ identity, db, connectPeer: neverConnect, updater });
}
```

Then add:

```ts
describe('update endpoints', () => {
  it('GET /api/update-status returns the current state', async () => {
    const updater = makeFakeUpdater({ phase: 'ready', latestVersion: '0.2.0' });
    const res = await makeHandler(updater)(req('/api/update-status'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.phase).toBe('ready');
    expect(body.latestVersion).toBe('0.2.0');
  });

  it('POST /api/update-check triggers an immediate check', async () => {
    const updater = makeFakeUpdater();
    const res = await makeHandler(updater)(req('/api/update-check', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(updater.checkNowCalls).toBe(1);
  });

  it('POST /api/update-restart returns 409 when no update is ready', async () => {
    const updater = makeFakeUpdater({ phase: 'idle' });
    const res = await makeHandler(updater)(req('/api/update-restart', { method: 'POST' }));
    expect(res.status).toBe(409);
    expect(updater.applyAndRestartCalls).toBe(0);
  });

  it('POST /api/update-restart returns 409 in source mode even if phase is ready', async () => {
    const updater = makeFakeUpdater({ phase: 'ready', mode: 'source', latestVersion: '0.2.0' });
    const res = await makeHandler(updater)(req('/api/update-restart', { method: 'POST' }));
    expect(res.status).toBe(409);
  });

  it('POST /api/update-restart returns 200 immediately and schedules the restart when ready', async () => {
    const updater = makeFakeUpdater({ phase: 'ready', latestVersion: '0.2.0' });
    const res = await makeHandler(updater)(req('/api/update-restart', { method: 'POST' }));
    expect(res.status).toBe(200);
    // applyAndRestart is deliberately scheduled via setTimeout (not awaited
    // inline) so the HTTP response below can flush before the process
    // exits — see the route implementation. Give it a moment, then confirm
    // it was in fact triggered.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(updater.applyAndRestartCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/__tests__/management.test.ts`
Expected: FAIL — `createManagementFetch` doesn't accept `updater` yet, and the three routes don't exist (404/type errors).

- [ ] **Step 3: Implement**

In `server/management.ts`, add the import and extend `ManagementDeps`:

```ts
import type { UpdateManager } from './updater';
```

```ts
export type ManagementDeps = {
  identity: Identity;
  db: Db;
  connectPeer: ConnectPeerFn;
  updater: UpdateManager;
  networkSearch?: typeof initiateNetworkSearch;
};

export function createManagementFetch(deps: ManagementDeps): (req: Request) => Promise<Response> {
  const { identity, db, connectPeer, updater, networkSearch = initiateNetworkSearch } = deps;
```

Then add the three routes — a sensible spot is right after the existing `/api/rescan` block:

```ts
if (url.pathname === '/api/update-status' && req.method === 'GET') {
  return Response.json(updater.getState());
}

if (url.pathname === '/api/update-check' && req.method === 'POST') {
  const result = await updater.checkNow();
  return Response.json(result);
}

if (url.pathname === '/api/update-restart' && req.method === 'POST') {
  const current = updater.getState();
  if (current.phase !== 'ready' || current.mode !== 'binary') {
    return new Response('No update ready to apply', { status: 409 });
  }
  // Schedule rather than await: applyAndRestart spawns the new
  // process and calls process.exit() almost immediately, which would
  // otherwise race the HTTP response for *this* request being
  // flushed back to the client before the process dies.
  setTimeout(() => {
    updater.applyAndRestart().catch((err) => console.error('Failed to apply update:', err));
  }, 250);
  return Response.json({ ok: true });
}
```

- [ ] **Step 4: Update other `ManagementDeps`/`UiServerDeps` construction sites**

Run: `grep -rn "createManagementFetch(\|createUiServer(" server --include=*.ts`

For every call site found besides `server/management.ts` itself and the test helper just updated (this should surface `server/index.ts`, handled in Task 11, and `server/__tests__/ui-server.test.ts` if it constructs deps directly) — add a minimal fake `updater` matching the shape used in `makeFakeUpdater` above (or import/reuse it if the file already imports test helpers from `management.test.ts`; if not, inline an equivalent small object) so the build and existing tests keep compiling. Do not change `server/index.ts` here — that's Task 11's job.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test server/__tests__/management.test.ts server/__tests__/ui-server.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `bun --bun next build 2>&1 | head -50` is too heavy for a quick typecheck loop — instead run: `bunx tsc --noEmit`
Expected: no new errors (pre-existing unrelated errors, if any, are out of scope).

- [ ] **Step 7: Commit**

```bash
bunx prettier --write server/management.ts server/__tests__/management.test.ts server/__tests__/ui-server.test.ts
git add server/management.ts server/__tests__/management.test.ts server/__tests__/ui-server.test.ts
git commit -m "feat: add update-status/check/restart management API routes"
```

---

### Task 11: Wire the updater into `server/index.ts`

**Files:**

- Modify: `server/index.ts`

**Interfaces:**

- Consumes: `parseFinishUpdateArgs`, `runFinishUpdate`, `createUpdateManager` (`server/updater.ts`), `isCompiledBinary` (`server/runtime-paths.ts`), `Settings.updateRepo`/`updateCheckIntervalMinutes` (Task 1).
- Produces: the running server now checks for and can apply updates; `updater` passed into `createUiServer`.

This task has no isolated unit test of its own (it's wiring in the entrypoint, which already isn't unit-tested elsewhere in this codebase — `server/index.ts` has no `__tests__` file). Correctness is verified manually in Step 4 below, and by the full test suite not regressing.

- [ ] **Step 1: Handle `--finish-update` before anything else starts**

At the very top of `server/index.ts`, before the existing imports even run any side effects — add this as the first substantive lines, right after the import block (imports must stay at the top per ES module syntax, so add the new imports there too):

```ts
import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';

import { createUpdateManager, parseFinishUpdateArgs, runFinishUpdate } from './updater';
import { isCompiledBinary, resolveAssetPath } from './runtime-paths';
```

(`resolveAssetPath` is already imported in this file — merge into the existing import line instead of duplicating it. Same for `dirname`/`readFileSync` if anything already imports from those modules.)

Immediately after the import block, before `const db = createDb();`:

```ts
const finishUpdateArgs = parseFinishUpdateArgs(process.argv);
if (finishUpdateArgs) {
  await runFinishUpdate(
    finishUpdateArgs.oldPid,
    finishUpdateArgs.stagingDir,
    finishUpdateArgs.installDir,
  );
  // runFinishUpdate calls process.exit(0) on success; nothing below this
  // point should ever run when --finish-update was passed.
}
```

- [ ] **Step 2: Resolve the current version and construct the `UpdateManager`**

After `const startupSettings = await getOrCreateSettings(db);`, add:

```ts
function resolveCurrentVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const pkgPath = resolveAssetPath('package.json', import.meta.dir);
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}

const compiledBinary = isCompiledBinary(import.meta.dir);
const installDir = compiledBinary ? dirname(process.execPath) : process.cwd();

const updateManager = createUpdateManager({
  mode: compiledBinary ? 'binary' : 'source',
  currentVersion: resolveCurrentVersion(),
  installDir,
  getRepo: async () => {
    const s = await getOrCreateSettings(db);
    return s.updateRepo;
  },
});

const stopUpdateChecks = updateManager.startPeriodicChecks(async () => {
  const s = await getOrCreateSettings(db);
  return s.updateCheckIntervalMinutes;
});
```

- [ ] **Step 3: Pass the manager into the UI server, and stop it on shutdown**

Update the `createUiServer` call:

```ts
Bun.serve({
  port: UI_PORT,
  fetch: createUiServer({
    identity,
    db,
    connectPeer: connectPeerFn,
    updater: updateManager,
    outDir: resolveAssetPath('out', import.meta.dir),
  }),
});
```

And in the existing `shutdown` function, alongside `stopRescan()`/`stopReconnect()`:

```ts
const shutdown = () => {
  stopRescan();
  stopReconnect();
  stopUpdateChecks();
  pauseAllActiveDownloads(db)
    .catch(() => {})
    .finally(() => process.exit(0));
};
```

- [ ] **Step 4: Manually verify boot still works**

Run: `bun run server` (leave it running)
Expected: server starts normally, logs `Node ID:`/`P2P port:`/`UI port:` as before, and `curl -s http://localhost:3000/api/update-status` returns JSON with `"mode":"source"` (since `bun run server` isn't a compiled binary) and `"phase"` transitioning from `"checking"` to `"idle"` shortly after boot (it can't reach a real newer release for the real `geoffoliver/filenet` repo unless one genuinely exists, which is fine — either `idle` or `available` are both valid depending on what's actually published). Stop the server with Ctrl-C and confirm it still shuts down cleanly (no hang, no error).

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: PASS (no regressions from the wiring change)

- [ ] **Step 6: Commit**

```bash
bunx prettier --write server/index.ts
git add server/index.ts
git commit -m "feat: wire the update manager into server startup and shutdown"
```

---

### Task 12: Release workflow — flat all-platform zips, checksums, baked version

**Files:**

- Modify: `scripts/build-binaries.sh`
- Modify: `.github/workflows/release.yml`
- Modify: `README.md` (the "Running as a standalone executable" section)

**Interfaces:**

- Produces: release assets `filenet-bun-<os>-<arch>.zip` (flat contents: `filenet`/`filenet.exe`, `out/`, `drizzle/migrations/`) for all 5 targets, plus `SHA256SUMS.txt`; `APP_VERSION` baked into each compiled binary via `--define`. Consumed by `downloadAndStage`/`extractZip` (Task 6) at runtime, and by end users per the README.

- [ ] **Step 1: Rewrite `scripts/build-binaries.sh`**

Replace the file's contents with:

```bash
#!/bin/bash
set -euo pipefail

TARGETS=(bun-linux-x64 bun-linux-arm64 bun-darwin-x64 bun-darwin-arm64 bun-windows-x64)

VERSION=$(node -e "console.log(require('./package.json').version)")

rm -rf dist
bun run build

for target in "${TARGETS[@]}"; do
  outdir="dist/${target}"
  mkdir -p "$outdir"

  binary_name="filenet"
  if [[ "$target" == *windows* ]]; then
    binary_name="filenet.exe"
  fi

  echo "Compiling ${target}..."
  # --define bakes NODE_ENV and APP_VERSION into the compiled binary at
  # build time (bun build --compile does not set NODE_ENV at runtime on its
  # own), so dev-only behavior (e.g. permissive CORS in server/ui-server.ts)
  # can never be active in a shipped executable, and the auto-updater
  # (server/updater.ts) always knows its own version without needing
  # package.json shipped alongside it.
  bun build --compile --target="$target" \
    --define "process.env.NODE_ENV=\"production\"" \
    --define "process.env.APP_VERSION=\"${VERSION}\"" \
    --outfile "${outdir}/${binary_name}" server/index.ts

  cp -r out "${outdir}/out"
  mkdir -p "${outdir}/drizzle"
  cp -r drizzle/migrations "${outdir}/drizzle/migrations"

  echo "Zipping dist/filenet-${target}.zip..."
  # Zip the *contents* of outdir (not outdir itself) so the archive's
  # top-level entries are filenet(.exe)/out/drizzle directly — matching
  # what server/updater.ts's extractZip expects at update time, and what
  # end users expect per the README ("Extract it — you'll get filenet,
  # an out/ folder, and a drizzle/migrations folder").
  (cd "$outdir" && zip -rq "../filenet-${target}.zip" .)

  echo "Packaged dist/filenet-${target}.zip"
done

echo "Generating checksums..."
(cd dist && sha256sum filenet-*.zip > SHA256SUMS.txt)
```

- [ ] **Step 2: Update `.github/workflows/release.yml`**

Find the `gh release create` step and update its file list to include the checksums:

```yaml
- name: Publish GitHub Release
  env:
    GH_TOKEN: ${{ github.token }}
  run: |
    gh release create "v${{ steps.version.outputs.version }}" \
      dist/*.zip \
      dist/SHA256SUMS.txt \
      --title "v${{ steps.version.outputs.version }}" \
      --notes-file /tmp/release-notes.md
```

(This is the only change needed here — `bun run build:binaries`, run earlier in the same job, now produces `dist/SHA256SUMS.txt` alongside the zips as part of Step 1's script.)

- [ ] **Step 3: Update `README.md`**

In the "Running as a standalone executable" section, update step 1 to say `.zip` for every platform:

Find:

```
1. Download `filenet-<platform>.tar.gz` (or `.zip` for Windows) from the
   Releases page for your platform (`linux-x64`, `linux-arm64`,
   `darwin-x64`, `darwin-arm64`, `windows-x64`).
```

Replace with:

```
1. Download `filenet-bun-<platform>.zip` from the Releases page for your
   platform (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`,
   `windows-x64`).
```

And after the existing "To build these yourself" paragraph, add a new paragraph:

```
Filenet checks for new releases automatically (interval configurable in
Settings, default once every 24 hours — set to `0` to disable), downloads
and SHA-256-verifies them in the background, and shows a **Restart to
update** button in Settings once one is ready. Forks can point their users
at their own releases by setting the "Update repository" field in Settings
(`owner/repo`, default `geoffoliver/filenet`).
```

- [ ] **Step 4: Verify the build script runs locally**

Run: `bun run build:binaries`
Expected: `dist/` contains `filenet-bun-linux-x64.zip`, `filenet-bun-linux-arm64.zip`, `filenet-bun-darwin-x64.zip`, `filenet-bun-darwin-arm64.zip`, `filenet-bun-windows-x64.zip`, and `SHA256SUMS.txt` with 5 lines. Unzip one target for the current platform and confirm `filenet`/`filenet.exe`, `out/`, and `drizzle/migrations/` sit at the top level (not nested under a target-named folder):

```bash
unzip -l dist/filenet-bun-$(node -e "console.log(process.platform==='darwin'?'darwin':'linux')")-$(node -e "console.log(process.arch)").zip | head -20
```

Expected output shows entries like `filenet`, `out/index.html`, `drizzle/migrations/0000_....sql` with no leading directory prefix.

- [ ] **Step 5: Commit**

```bash
bunx prettier --write README.md
git add scripts/build-binaries.sh .github/workflows/release.yml README.md
git commit -m "feat: standardize release archives on zip and publish SHA256SUMS.txt"
```

---

### Task 13: Frontend API client

**Files:**

- Modify: `app/lib/api.ts`

**Interfaces:**

- Produces: `type UpdatePhase`, `type UpdateStatus`, `getUpdateStatus(): Promise<UpdateStatus>`, `checkForUpdate(): Promise<UpdateStatus>`, `restartToUpdate(): Promise<void>`; `Settings.updateRepo: string`, `Settings.updateCheckIntervalMinutes: number`, `SettingsPatch.updateRepo?: string`, `SettingsPatch.updateCheckIntervalMinutes?: number` — consumed by Task 14 (notification hook) and Task 15 (Settings UI).

No dedicated unit test for this task: `app/lib/api.ts`'s existing fetch wrappers (`getSettings`, `patchSettings`, `triggerRescan`, etc.) have no `bun:test` coverage today either — they're exercised through the Playwright e2e suite instead (Task 16 covers the new functions the same way). This keeps the pattern consistent with the rest of the file rather than introducing a new, one-off testing approach for just these three functions.

- [ ] **Step 1: Extend `Settings`/`SettingsPatch`**

In `app/lib/api.ts`:

```ts
export type Settings = {
  id: string;
  name: string;
  hasInvitePassword: boolean;
  autoAcceptFromAnyone: boolean;
  autoAcceptFromFriendsOfFriends: boolean;
  sharedFolders: string[];
  downloadFolder: string | null;
  rescanIntervalMinutes: number;
  listenPort: number;
  updateRepo: string;
  updateCheckIntervalMinutes: number;
};
```

```ts
export type SettingsPatch = {
  name?: string;
  invitePassword?: string | null;
  autoAcceptFromAnyone?: boolean;
  autoAcceptFromFriendsOfFriends?: boolean;
  sharedFolders?: string[];
  downloadFolder?: string | null;
  rescanIntervalMinutes?: number;
  listenPort?: number;
  updateRepo?: string;
  updateCheckIntervalMinutes?: number;
};
```

- [ ] **Step 2: Add update-status types and functions**

Add near the other settings-related functions in `app/lib/api.ts`:

```ts
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export type UpdateStatus = {
  mode: 'binary' | 'source';
  currentVersion: string;
  phase: UpdatePhase;
  latestVersion: string | null;
  releaseNotesUrl: string | null;
  error: string | null;
  lastCheckedAt: string | null;
};

export async function getUpdateStatus(): Promise<UpdateStatus> {
  const res = await fetch(apiUrl('/api/update-status'));
  if (!res.ok) throw new Error('Failed to load update status');
  return res.json();
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  const res = await fetch(apiUrl('/api/update-check'), { method: 'POST' });
  if (!res.ok) throw new Error('Failed to check for updates');
  return res.json();
}

export async function restartToUpdate(): Promise<void> {
  const res = await fetch(apiUrl('/api/update-restart'), { method: 'POST' });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to restart');
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
bunx prettier --write app/lib/api.ts
git add app/lib/api.ts
git commit -m "feat: add update-status API client functions"
```

---

### Task 14: Update-ready notification hook

**Files:**

- Create: `app/hooks/updateNotificationDiff.ts`
- Create: `app/hooks/__tests__/updateNotificationDiff.test.ts`
- Create: `app/hooks/useUpdateNotifications.ts`
- Modify: `app/(shell)/ShellContent.tsx`

**Interfaces:**

- Consumes: `getUpdateStatus`, `UpdateStatus`, `UpdatePhase` (Task 13); `showDesktopNotification` (`app/lib/notifications.ts`, existing); `useToast` (`app/components/Toast/ToastProvider.tsx`, existing).
- Produces: `shouldNotifyForUpdate(phase: UpdatePhase, latestVersion: string | null, notifiedVersions: Set<string>): string | null`; `useUpdateNotifications(): void`, mounted once in `ShellContent`.

- [ ] **Step 1: Write the failing test for the pure diff logic**

Create `app/hooks/__tests__/updateNotificationDiff.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { shouldNotifyForUpdate } from '../updateNotificationDiff';

describe('shouldNotifyForUpdate', () => {
  test('returns the version when ready and not yet notified', () => {
    expect(shouldNotifyForUpdate('ready', '0.2.0', new Set())).toBe('0.2.0');
  });

  test('returns null when already notified for this version', () => {
    expect(shouldNotifyForUpdate('ready', '0.2.0', new Set(['0.2.0']))).toBeNull();
  });

  test('returns null when not ready yet', () => {
    expect(shouldNotifyForUpdate('downloading', '0.2.0', new Set())).toBeNull();
    expect(shouldNotifyForUpdate('available', '0.2.0', new Set())).toBeNull();
    expect(shouldNotifyForUpdate('idle', null, new Set())).toBeNull();
  });

  test('returns null when ready but latestVersion is missing', () => {
    expect(shouldNotifyForUpdate('ready', null, new Set())).toBeNull();
  });

  test('notifies again if a newer version becomes ready after an earlier one was notified', () => {
    expect(shouldNotifyForUpdate('ready', '0.3.0', new Set(['0.2.0']))).toBe('0.3.0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test app/hooks/__tests__/updateNotificationDiff.test.ts`
Expected: FAIL — `app/hooks/updateNotificationDiff.ts` doesn't exist yet.

- [ ] **Step 3: Implement the pure diff function**

Create `app/hooks/updateNotificationDiff.ts`:

```ts
import type { UpdatePhase } from '../lib/api';

export function shouldNotifyForUpdate(
  phase: UpdatePhase,
  latestVersion: string | null,
  notifiedVersions: Set<string>,
): string | null {
  if (phase !== 'ready' || !latestVersion) return null;
  if (notifiedVersions.has(latestVersion)) return null;
  return latestVersion;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test app/hooks/__tests__/updateNotificationDiff.test.ts`
Expected: PASS

- [ ] **Step 5: Implement the polling hook**

Create `app/hooks/useUpdateNotifications.ts`:

```ts
'use client';

import { useCallback, useEffect, useRef } from 'react';

import { shouldNotifyForUpdate } from './updateNotificationDiff';
import { getUpdateStatus } from '../lib/api';
import { showDesktopNotification } from '../lib/notifications';
import { useToast } from '../components/Toast/ToastProvider';

const POLL_MS = 60_000;
const STORAGE_KEY = 'filenet:notifiedUpdateVersions';

function loadNotifiedVersions(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

function saveNotifiedVersions(versions: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...versions]));
  } catch {
    // ignore — a failed write just means we might re-notify once next session
  }
}

export function useUpdateNotifications(): void {
  const toast = useToast();
  const mountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tick = useCallback(async () => {
    try {
      const status = await getUpdateStatus();
      if (!mountedRef.current) return;

      const newVersion = shouldNotifyForUpdate(
        status.phase,
        status.latestVersion,
        loadNotifiedVersions(),
      );
      if (newVersion) {
        const notifiedVersions = loadNotifiedVersions();
        const shown = showDesktopNotification(
          'Filenet update ready',
          `v${newVersion} is ready to install`,
          () => {
            window.focus();
            window.location.href = '/settings';
          },
        );
        if (!shown) toast.show(`Filenet v${newVersion} is ready to install`);
        notifiedVersions.add(newVersion);
        saveNotifiedVersions(notifiedVersions);
      }
    } catch {
      // silent retry, matches useFriendRequestNotifications' poll-failure convention
    }
  }, [toast]);

  useEffect(() => {
    mountedRef.current = true;

    async function loop() {
      if (!mountedRef.current) return;
      await tick();
      if (mountedRef.current) pollRef.current = setTimeout(loop, POLL_MS);
    }

    loop();
    return () => {
      mountedRef.current = false;
      if (pollRef.current !== null) clearTimeout(pollRef.current);
    };
  }, [tick]);
}
```

- [ ] **Step 6: Mount the hook in the shell**

Modify `app/(shell)/ShellContent.tsx`:

```tsx
'use client';

import Navbar from '../components/Navbar/Navbar';
import styles from './layout.module.css';
import { useFriendRequestNotifications } from '../hooks/useFriendRequestNotifications';
import { useUpdateNotifications } from '../hooks/useUpdateNotifications';

export function ShellContent({ children }: { children: React.ReactNode }) {
  const pendingRequestCount = useFriendRequestNotifications();
  useUpdateNotifications();
  return (
    <div className={styles.shell}>
      <Navbar pendingRequestCount={pendingRequestCount} />
      <main className={styles.main}>{children}</main>
    </div>
  );
}
```

- [ ] **Step 7: Run the full frontend unit test suite**

Run: `bun test app/lib/__tests__ app/hooks/__tests__`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
bunx prettier --write app/hooks/updateNotificationDiff.ts app/hooks/__tests__/updateNotificationDiff.test.ts app/hooks/useUpdateNotifications.ts "app/(shell)/ShellContent.tsx"
git add app/hooks/updateNotificationDiff.ts app/hooks/__tests__/updateNotificationDiff.test.ts app/hooks/useUpdateNotifications.ts "app/(shell)/ShellContent.tsx"
git commit -m "feat: notify once when an update becomes ready to install"
```

---

### Task 15: Settings UI — Updates section

**Files:**

- Modify: `app/(shell)/settings/SettingsView.tsx`

**Interfaces:**

- Consumes: `getUpdateStatus`, `checkForUpdate`, `restartToUpdate`, `UpdateStatus`, `UpdatePhase` (Task 13); `getSettings`/`patchSettings` (existing); `Section`/`SaveButton` (existing, same file).

This task is UI-only and covered by the e2e tests in Task 16 rather than a `bun:test` unit test, matching how every other section of this file (`ProfileSection`, `FilesSection`, etc.) is tested.

- [ ] **Step 1: Add imports**

In `app/(shell)/settings/SettingsView.tsx`, extend the existing `../../lib/api` import:

```ts
import {
  type EnvConfig,
  type PostDownloadScript,
  type Settings,
  type UpdatePhase,
  type UpdateStatus,
  addScript,
  checkForUpdate,
  getEnvConfig,
  getScripts,
  getSettings,
  getUpdateStatus,
  patchSettings,
  removeScript,
  reorderScript,
  restartToUpdate,
  triggerRescan,
} from '../../lib/api';
```

- [ ] **Step 2: Add the `UpdatesSection` component**

Add after `MaintenanceSection` (before the `NotificationsSection` comment block):

```tsx
// ── Updates section ───────────────────────────────────────────────────────

const PHASE_LABEL: Record<UpdatePhase, (status: UpdateStatus) => string> = {
  idle: () => 'Up to date',
  checking: () => 'Checking…',
  available: (s) =>
    s.mode === 'source' ? `Update available: v${s.latestVersion}` : 'Update available…',
  downloading: () => 'Downloading…',
  ready: (s) => `Update ready: v${s.latestVersion}`,
  error: (s) => `Error: ${s.error ?? 'unknown error'}`,
};

function UpdatesSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [repo, setRepo] = useState('');
  const [interval, setIntervalMinutes] = useState('');
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([getUpdateStatus(), getSettings()])
      .then(([s, settingsRow]) => {
        if (!active) return;
        setStatus(s);
        setRepo(settingsRow.updateRepo);
        setIntervalMinutes(String(settingsRow.updateCheckIntervalMinutes));
      })
      .catch(() => {
        if (active) setError('Could not load update status.');
      });
    return () => {
      active = false;
    };
  }, []);

  function handleCheck() {
    setChecking(true);
    setError('');
    checkForUpdate()
      .then(setStatus)
      .catch((err: Error) => setError(err.message))
      .finally(() => setChecking(false));
  }

  function handleRestart() {
    if (
      !window.confirm(
        'Filenet will briefly go offline while it restarts on the new version. Continue?',
      )
    ) {
      return;
    }
    setRestarting(true);
    setError('');
    // The server process exits right after accepting this request — leave
    // `restarting` true rather than clearing it in a .finally(); the page
    // will need a manual reload once the new version is back up.
    restartToUpdate().catch((err: Error) => {
      setError(err.message);
      setRestarting(false);
    });
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    const parsedInterval = parseInt(interval, 10);
    if (isNaN(parsedInterval) || parsedInterval < 0) {
      setError('Check interval must be 0 (disabled) or a positive number of minutes.');
      return;
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim())) {
      setError('Repository must be in the form owner/repo.');
      return;
    }
    setSaving(true);
    setError('');
    setSaved(false);
    patchSettings({ updateRepo: repo.trim(), updateCheckIntervalMinutes: parsedInterval })
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }

  if (!status) return null;

  return (
    <Section title="Updates">
      <div className={styles.form}>
        <p className={styles.hint}>
          Running <strong>v{status.currentVersion}</strong> — {PHASE_LABEL[status.phase](status)}
        </p>

        {status.mode === 'source' ? (
          <p className={styles.hint}>
            Running from source — update by pulling the latest image or code.
          </p>
        ) : (
          <div className={styles.formFooter}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleCheck}
              disabled={checking}
            >
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
            {status.phase === 'ready' && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleRestart}
                disabled={restarting}
              >
                {restarting ? 'Restarting…' : `Restart to update v${status.latestVersion}`}
              </button>
            )}
          </div>
        )}

        <form className={styles.form} onSubmit={handleSaveSettings}>
          <label className={styles.field}>
            <span className={styles.label}>Update repository</span>
            <input
              className="input"
              type="text"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/repo"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Check interval</span>
            <div className={styles.intervalRow}>
              <input
                className={`input ${styles.intervalInput}`}
                type="number"
                min="0"
                max="35791"
                value={interval}
                onChange={(e) => setIntervalMinutes(e.target.value)}
              />
              <span className={styles.intervalUnit}>minutes (0 = disabled)</span>
            </div>
          </label>
          {error && <p className={styles.error}>{error}</p>}
          <div className={styles.formFooter}>
            <SaveButton saving={saving} saved={saved} />
          </div>
        </form>
      </div>
    </Section>
  );
}
```

- [ ] **Step 3: Mount it in the root component**

In `SettingsView`'s return block, add `<UpdatesSection />` after `<MaintenanceSection />`:

```tsx
      <ScriptsSection />
      <MaintenanceSection />
      <UpdatesSection />
      <NotificationsSection />
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Manually verify in a browser**

Run: `bun run server` and, in another terminal, `bun run dev`, then open `http://localhost:3001/settings`.
Expected: a new "Updates" section appears showing "Running vX.Y.Z — …", a "Check for updates" button, and the repository/interval fields pre-filled from Settings. Click "Check for updates" and confirm the status line updates without a page reload.

- [ ] **Step 6: Commit**

```bash
bunx prettier --write "app/(shell)/settings/SettingsView.tsx"
git add "app/(shell)/settings/SettingsView.tsx"
git commit -m "feat: add Updates section to Settings"
```

---

### Task 16: End-to-end tests

**Files:**

- Modify: `e2e/helpers.ts`
- Create: `e2e/updates.spec.ts`

**Interfaces:**

- Consumes: `SETTINGS` fixture, `mockBaseApp`, `mockSettingsConfigured` (existing, `e2e/helpers.ts`).
- Produces: `UPDATE_STATUS_*` fixtures, `mockUpdateStatus(page, status?)` helper, registered into `mockBaseApp` — consumed by every existing e2e test transitively (via `mockBaseApp`), and directly by the new `e2e/updates.spec.ts`.

- [ ] **Step 1: Extend the `SETTINGS` fixture and add update-status fixtures/helper**

In `e2e/helpers.ts`, update the `SETTINGS` object:

```ts
export const SETTINGS = {
  id: 'settings-1',
  name: 'Test User',
  hasInvitePassword: false,
  autoAcceptFromAnyone: false,
  autoAcceptFromFriendsOfFriends: false,
  sharedFolders: ['/shared'],
  downloadFolder: '/downloads',
  rescanIntervalMinutes: 60,
  listenPort: 7734,
  updateRepo: 'geoffoliver/filenet',
  updateCheckIntervalMinutes: 1440,
};
```

Add fixtures near the other exported constants:

```ts
export const UPDATE_STATUS_IDLE = {
  mode: 'binary' as const,
  currentVersion: '0.1.1',
  phase: 'idle' as const,
  latestVersion: null,
  releaseNotesUrl: null,
  error: null,
  lastCheckedAt: '2024-01-01T00:00:00.000Z',
};

export const UPDATE_STATUS_READY = {
  ...UPDATE_STATUS_IDLE,
  phase: 'ready' as const,
  latestVersion: '0.2.0',
  releaseNotesUrl: 'https://github.com/geoffoliver/filenet/releases/tag/v0.2.0',
};

export const UPDATE_STATUS_SOURCE_MODE = {
  ...UPDATE_STATUS_IDLE,
  mode: 'source' as const,
};
```

Add the mock helper next to `mockEnvConfig`:

```ts
export async function mockUpdateStatus(page: Page, status = UPDATE_STATUS_IDLE) {
  await page.route('/api/update-status', (route) => route.fulfill({ json: status }));
  await page.route('/api/update-check', (route) => route.fulfill({ json: status }));
}
```

Register it in `mockBaseApp` so every existing e2e test (which doesn't care about updates) gets a harmless default and isn't left making an unmocked request:

```ts
export async function mockBaseApp(page: Page) {
  await mockSettingsConfigured(page);
  await mockStats(page);
  await mockFriends(page);
  await mockTransfers(page);
  await mockUploads(page);
  await mockConversations(page);
  await mockEnvConfig(page);
  await mockMe(page);
  await mockUpdateStatus(page);
}
```

- [ ] **Step 2: Write `e2e/updates.spec.ts`**

Create `e2e/updates.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

import {
  UPDATE_STATUS_READY,
  UPDATE_STATUS_SOURCE_MODE,
  mockBaseApp,
  mockUpdateStatus,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await mockBaseApp(page);
});

test('shows up-to-date status and no restart button by default', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByText(/Up to date/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /restart to update/i })).toHaveCount(0);
});

test('shows a restart button and version when an update is ready', async ({ page }) => {
  await mockUpdateStatus(page, UPDATE_STATUS_READY);
  await page.goto('/settings');
  await expect(page.getByText(/Update ready: v0\.2\.0/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /restart to update v0\.2\.0/i })).toBeVisible();
});

test('source mode shows a passive message instead of check/restart controls', async ({ page }) => {
  await mockUpdateStatus(page, UPDATE_STATUS_SOURCE_MODE);
  await page.goto('/settings');
  await expect(page.getByText(/running from source/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /check for updates/i })).toHaveCount(0);
});

test('shows a toast when an update becomes ready to install', async ({ page }) => {
  await mockUpdateStatus(page, UPDATE_STATUS_READY);
  // Navigate to a page that has nothing to do with Settings, to prove the
  // notification hook works globally, matching notifications.spec.ts's
  // pattern for the equivalent friend-request test.
  await page.goto('/home');
  await expect(page.getByText(/v0\.2\.0 is ready to install/i)).toBeVisible();
});
```

- [ ] **Step 3: Run the e2e suite**

Run: `bun run test:e2e`
Expected: PASS, including the full pre-existing suite (confirming `mockUpdateStatus` in `mockBaseApp` didn't break anything that was passing before).

- [ ] **Step 4: Commit**

```bash
bunx prettier --write e2e/helpers.ts e2e/updates.spec.ts
git add e2e/helpers.ts e2e/updates.spec.ts
git commit -m "test: add e2e coverage for the Updates settings section and notification"
```

---

### Task 17: Docs

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `TODO.md`

- [ ] **Step 1: Add a CHANGELOG entry**

Under the `## [Unreleased]` header in `CHANGELOG.md`, add (matching the existing entries' style — check a couple of recent entries for exact heading/bullet conventions before writing this):

```markdown
### Added

- Auto-update mechanism: the standalone binary checks GitHub for new releases (configurable repo, default `geoffoliver/filenet`), downloads and SHA-256-verifies them in the background, and self-relaunches onto the new version from a "Restart to update" button in Settings. Desktop notification (with toast fallback) fires once a new version is ready to install.
```

- [ ] **Step 2: Check off the TODO item**

In `TODO.md`, change:

```
- [ ] Auto-update mechanism (detect new release on Github (configurable repo URL in case someone wants to fork it), download, prompt user to restart)
```

to:

```
- [x] Auto-update mechanism (detect new release on Github (configurable repo URL in case someone wants to fork it), download, prompt user to restart)
```

Also update the now-unblocked notifications sub-item:

```
  - [ ] When updates are available/ready to install — blocked on the auto-update mechanism below; will reuse the same notify()/toast infrastructure
```

to:

```
  - [x] When updates are available/ready to install — desktop notification with toast fallback, fires once per version reaching "ready" (`app/hooks/useUpdateNotifications.ts`)
```

- [ ] **Step 3: Commit**

```bash
bunx prettier --write CHANGELOG.md TODO.md
git add CHANGELOG.md TODO.md
git commit -m "docs: record the auto-update mechanism in the changelog and TODO"
```

---

## Self-Review Notes

- **Spec coverage:** version check (Tasks 4–5, 9), configurable repo (Tasks 1–2, 15), download (Task 6), checksum verification (Task 6, spec's integrity-check decision), restart prompt (Task 15), self-relaunch (Tasks 7–9, 11), Docker/source-mode passive notice (Task 9's `mode` branch, Task 15's UI branch), notification reuse (Task 14), release workflow changes (Task 12) — every section of the approved design doc has a corresponding task.
- **Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" — every step has literal code or an exact command.
- **Type consistency:** `UpdatePhase`/`UpdateState`/`UpdateManager`/`ReleaseInfo`/`FinishUpdateDeps` are defined once (Tasks 4–9) and reused verbatim by name in Tasks 10, 11, 13, 14, 15 — cross-checked field names (`latestVersion`, `releaseNotesUrl`, `lastCheckedAt`, `mode`, `phase`) match across `server/updater.ts`, `server/management.ts`, `app/lib/api.ts`, and the two frontend hooks/components that consume them.
- One deliberate refinement beyond the brainstorming spec: an `'available'` phase was added (spec's phase list was `checking`/`downloading`/`ready`/`error` plus implicit "idle" for up-to-date) so source-mode installs have a real terminal state to display ("a newer version exists, but we're not downloading it") rather than overloading `idle` or `ready`. This doesn't change any user-facing behavior described in the spec — it's a state-machine detail needed to implement the already-approved source-mode passive-notice behavior correctly.
