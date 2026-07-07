# Release Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a manual `workflow_dispatch` GitHub Actions workflow that bumps `package.json`'s version, cuts `CHANGELOG.md`'s `[Unreleased]` section into a versioned one, tags and pushes the commit, builds all 5 platform binaries, and publishes a GitHub Release with those binaries attached.

**Architecture:** A small, independently-tested Bun/TypeScript script (`scripts/cut-release.ts`) owns the version-bump and changelog-cutting logic as pure, unit-tested functions plus a thin file-I/O wrapper. The GitHub Actions workflow (`.github/workflows/release.yml`) is pure orchestration glue: guard rails, pre-flight CI checks, invoke the script, commit/tag/push, build binaries, publish the release. Logic that can be unit-tested lives in the script; things that can only be verified by actually running the workflow live in the YAML.

**Tech Stack:** Bun, TypeScript, `bun:test`, GitHub Actions, `gh` CLI (preinstalled on GitHub-hosted runners), `jq` (preinstalled on GitHub-hosted runners).

## Global Constraints

- Bun version for any CI step: pin to `1.3.14`, matching `.github/workflows/ci.yml`'s existing `oven-sh/setup-bun@v2` config.
- Version strings are strict `x.y.z` (no prerelease/build metadata) — matches the current `package.json` version `0.1.0`. `bumpVersion` should throw on anything else rather than guessing.
- `CHANGELOG.md` follows Keep a Changelog style with a `## [Unreleased]` header and no compare-link footer — don't add one.
- Never bypass git hooks (`--no-verify`) to make a commit succeed. `.husky/pre-commit` runs `bunx lint-staged`, which for `*.{json,md}` files runs `prettier --check` (not `--write`). Any script-generated `package.json`/`CHANGELOG.md` content must be run through `bunx prettier --write` before being staged, so the commit passes the hook honestly.
- TDD: every pure function gets a failing test before implementation, per this project's conventions (see `server/__tests__/*` for the established style — temp-dir-based I/O tests, `bun:test`'s `describe`/`test`/`expect`).
- The release workflow must never run tag/build/publish steps if lint, format check, or the test suite fail — pre-flight checks gate everything after them.

---

### Task 1: `bumpVersion` and `cutChangelog` — pure logic

**Files:**

- Create: `scripts/cut-release.ts`
- Test: `scripts/__tests__/cut-release.test.ts`

**Interfaces:**

- Produces: `export type Bump = 'patch' | 'minor' | 'major';`
- Produces: `export function bumpVersion(current: string, bump: Bump): string` — throws `Error` on a non-`x.y.z` input.
- Produces: `export function cutChangelog(changelog: string, version: string, date: string): { updatedChangelog: string; releaseNotes: string }` — throws `Error` if there's no `## [Unreleased]` header, or if that section's body is empty/whitespace-only.

- [ ] **Step 1: Write the failing tests**

Create `scripts/__tests__/cut-release.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';

import { bumpVersion, cutChangelog } from '../cut-release';

describe('bumpVersion', () => {
  test('bumps patch', () => {
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
  });

  test('bumps minor and resets patch', () => {
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
  });

  test('bumps major and resets minor and patch', () => {
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
  });

  test('throws on a non-semver version string', () => {
    expect(() => bumpVersion('1.2', 'patch')).toThrow('Invalid semver version');
  });

  test('throws on a version string with a prerelease suffix', () => {
    expect(() => bumpVersion('1.2.3-beta.1', 'patch')).toThrow('Invalid semver version');
  });
});

describe('cutChangelog', () => {
  test('throws when there is no Unreleased section', () => {
    expect(() => cutChangelog('# Changelog\n\nno sections here\n', '1.0.0', '2026-01-01')).toThrow(
      'no "## [Unreleased]" section',
    );
  });

  test('throws when the Unreleased section is empty', () => {
    const changelog = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2025-01-01\n\nold stuff\n';
    expect(() => cutChangelog(changelog, '0.2.0', '2026-01-01')).toThrow('nothing to release');
  });

  test('cuts Unreleased into a versioned section when it is the last section in the file', () => {
    const changelog = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- new thing\n';
    const { updatedChangelog, releaseNotes } = cutChangelog(changelog, '0.2.0', '2026-07-07');

    expect(releaseNotes).toContain('- new thing');
    expect(updatedChangelog).toContain('## [Unreleased]');
    expect(updatedChangelog).toContain('## [0.2.0] - 2026-07-07');
    expect(updatedChangelog.indexOf('## [Unreleased]')).toBeLessThan(
      updatedChangelog.indexOf('## [0.2.0] - 2026-07-07'),
    );
    expect(updatedChangelog).toContain('- new thing');
  });

  test('stops at the next version section and leaves it untouched', () => {
    const changelog =
      '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- new thing\n\n## [0.1.0] - 2025-01-01\n\n- old thing\n';
    const { updatedChangelog, releaseNotes } = cutChangelog(changelog, '0.2.0', '2026-07-07');

    expect(releaseNotes).toContain('- new thing');
    expect(releaseNotes).not.toContain('- old thing');
    expect(updatedChangelog).toContain('## [0.1.0] - 2025-01-01');
    expect(updatedChangelog).toContain('- old thing');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test scripts/__tests__/cut-release.test.ts`
Expected: FAIL — `error: Cannot find module '../cut-release'` (the file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/cut-release.ts`:

```typescript
export type Bump = 'patch' | 'minor' | 'major';

export function bumpVersion(current: string, bump: Bump): string {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid semver version: "${current}"`);

  let [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];

  if (bump === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

export function cutChangelog(
  changelog: string,
  version: string,
  date: string,
): { updatedChangelog: string; releaseNotes: string } {
  const unreleasedHeader = '## [Unreleased]';
  const startIdx = changelog.indexOf(unreleasedHeader);
  if (startIdx === -1) {
    throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  }

  const afterHeaderIdx = startIdx + unreleasedHeader.length;
  const rest = changelog.slice(afterHeaderIdx);
  const nextHeaderMatch = rest.match(/\n## /);
  const bodyEnd = nextHeaderMatch ? afterHeaderIdx + nextHeaderMatch.index! : changelog.length;

  const body = changelog.slice(afterHeaderIdx, bodyEnd).trim();
  if (!body) {
    throw new Error('CHANGELOG.md "## [Unreleased]" section is empty — nothing to release');
  }

  const before = changelog.slice(0, startIdx);
  const after = changelog.slice(bodyEnd);
  const updatedChangelog = `${before}## [Unreleased]\n\n## [${version}] - ${date}\n\n${body}\n${after}`;

  return { updatedChangelog, releaseNotes: body };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test scripts/__tests__/cut-release.test.ts`
Expected: PASS — 9 tests, 0 fail.

- [ ] **Step 5: Lint, format, and commit**

Run: `bunx eslint --max-warnings=0 scripts/cut-release.ts scripts/__tests__/cut-release.test.ts && bunx prettier --check scripts/cut-release.ts scripts/__tests__/cut-release.test.ts`
Expected: no errors. If Prettier complains, run `bunx prettier --write scripts/cut-release.ts scripts/__tests__/cut-release.test.ts` and re-check. If ESLint complains about `sort-imports` (multi-specifier import declarations must sort before single-specifier ones, alphabetically by first named import), `eslint --fix` will _not_ fix it — reorder the import lines by hand until it's clean.

```bash
git add scripts/cut-release.ts scripts/__tests__/cut-release.test.ts
git commit -m "feat(release): add bumpVersion and cutChangelog pure functions"
```

---

### Task 2: `runCutRelease` file-I/O wrapper, CLI entry point, and test wiring

**Files:**

- Modify: `scripts/cut-release.ts` (add `runCutRelease` + CLI shim)
- Modify: `scripts/__tests__/cut-release.test.ts` (add `runCutRelease` tests)
- Modify: `package.json` (`"test"` script)
- Modify: `.github/workflows/ci.yml` (`Test` step)

**Interfaces:**

- Consumes: `bumpVersion`, `cutChangelog` from Task 1 (same file, same signatures).
- Produces: `export type CutReleaseOptions = { packageJsonPath: string; changelogPath: string; notesOutPath: string; bump: Bump; date: string };`
- Produces: `export async function runCutRelease(opts: CutReleaseOptions): Promise<{ version: string }>` — reads `packageJsonPath` and `changelogPath` from disk, calls `bumpVersion`/`cutChangelog`, writes the updated `package.json` (JSON, 2-space indent, trailing newline), the updated `changelogPath`, and the release notes to `notesOutPath`.

- [ ] **Step 1: Write the failing test**

Add to `scripts/__tests__/cut-release.test.ts` (new imports and a new `describe` block):

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bumpVersion, cutChangelog, runCutRelease } from '../cut-release';
```

(Replace the existing `import { describe, expect, test } from 'bun:test';` line and the existing `import { bumpVersion, cutChangelog } from '../cut-release';` line with the two import blocks above.)

Then append:

```typescript
describe('runCutRelease', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cut-release-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('updates package.json, cuts CHANGELOG.md, and writes release notes to the given path', async () => {
    const packageJsonPath = join(dir, 'package.json');
    const changelogPath = join(dir, 'CHANGELOG.md');
    const notesOutPath = join(dir, 'notes.md');

    await writeFile(
      packageJsonPath,
      JSON.stringify({ name: 'filenet', version: '0.1.0' }, null, 2),
    );
    await writeFile(changelogPath, '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- new thing\n');

    const result = await runCutRelease({
      packageJsonPath,
      changelogPath,
      notesOutPath,
      bump: 'minor',
      date: '2026-07-07',
    });

    expect(result.version).toBe('0.2.0');

    const updatedPkg = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    expect(updatedPkg.version).toBe('0.2.0');
    expect(updatedPkg.name).toBe('filenet');

    const updatedChangelog = await readFile(changelogPath, 'utf8');
    expect(updatedChangelog).toContain('## [0.2.0] - 2026-07-07');

    const notes = await readFile(notesOutPath, 'utf8');
    expect(notes).toContain('- new thing');
  });

  test('rejects an empty Unreleased section without writing any files', async () => {
    const packageJsonPath = join(dir, 'package.json');
    const changelogPath = join(dir, 'CHANGELOG.md');
    const notesOutPath = join(dir, 'notes.md');

    await writeFile(
      packageJsonPath,
      JSON.stringify({ name: 'filenet', version: '0.1.0' }, null, 2),
    );
    await writeFile(
      changelogPath,
      '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2025-01-01\n\nold\n',
    );

    await expect(
      runCutRelease({
        packageJsonPath,
        changelogPath,
        notesOutPath,
        bump: 'patch',
        date: '2026-07-07',
      }),
    ).rejects.toThrow('nothing to release');

    const pkgAfter = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    expect(pkgAfter.version).toBe('0.1.0');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/__tests__/cut-release.test.ts`
Expected: FAIL — `error: export named 'runCutRelease' not found in module '../cut-release'`.

- [ ] **Step 3: Write the minimal implementation**

Add to `scripts/cut-release.ts` (below the existing `cutChangelog` function):

```typescript
import { readFile, writeFile } from 'node:fs/promises';

export type CutReleaseOptions = {
  packageJsonPath: string;
  changelogPath: string;
  notesOutPath: string;
  bump: Bump;
  date: string;
};

export async function runCutRelease(opts: CutReleaseOptions): Promise<{ version: string }> {
  const packageJsonText = await readFile(opts.packageJsonPath, 'utf8');
  const pkg = JSON.parse(packageJsonText) as { version: string; [key: string]: unknown };

  const newVersion = bumpVersion(pkg.version, opts.bump);

  const changelogText = await readFile(opts.changelogPath, 'utf8');
  const { updatedChangelog, releaseNotes } = cutChangelog(changelogText, newVersion, opts.date);

  pkg.version = newVersion;
  await writeFile(opts.packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
  await writeFile(opts.changelogPath, updatedChangelog);
  await writeFile(opts.notesOutPath, releaseNotes);

  return { version: newVersion };
}

if (import.meta.main) {
  const bump = process.argv[2];
  const notesOutPath = process.argv[3];

  if (bump !== 'patch' && bump !== 'minor' && bump !== 'major') {
    console.error('Usage: bun scripts/cut-release.ts <patch|minor|major> <notes-out-path>');
    process.exit(1);
  }
  if (!notesOutPath) {
    console.error('Usage: bun scripts/cut-release.ts <patch|minor|major> <notes-out-path>');
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10);
  const { version } = await runCutRelease({
    packageJsonPath: 'package.json',
    changelogPath: 'CHANGELOG.md',
    notesOutPath,
    bump,
    date,
  });
  console.log(`Bumped to v${version}`);
}
```

Move the `import { readFile, writeFile } from 'node:fs/promises';` line to the top of the file, alongside no other existing imports (this is the file's first import).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test scripts/__tests__/cut-release.test.ts`
Expected: PASS — 11 tests, 0 fail.

- [ ] **Step 5: Wire the new test directory into the test command and CI**

Modify `package.json` — change:

```json
    "test": "bun test server/__tests__",
```

to:

```json
    "test": "bun test server/__tests__ scripts/__tests__",
```

Modify `.github/workflows/ci.yml` — change the `Test` step's `run:` line from:

```yaml
- name: Test
  run: bun test server/__tests__
```

to:

```yaml
- name: Test
  run: bun test server/__tests__ scripts/__tests__
```

- [ ] **Step 6: Run the full test suite to confirm nothing else broke**

Run: `bun run test`
Expected: PASS — all `server/__tests__` tests plus the new `scripts/__tests__` tests, 0 fail.

- [ ] **Step 7: Lint, format, and commit**

Run: `bunx eslint --max-warnings=0 scripts/cut-release.ts scripts/__tests__/cut-release.test.ts && bunx prettier --check scripts/cut-release.ts scripts/__tests__/cut-release.test.ts package.json .github/workflows/ci.yml`
Expected: no errors. If Prettier complains, run `bunx prettier --write <the failing paths>` and re-check. If ESLint complains about `sort-imports` on the new import lines added in Step 1, fix the ordering by hand (`eslint --fix` doesn't reliably fix this rule for multi-specifier imports).

```bash
git add scripts/cut-release.ts scripts/__tests__/cut-release.test.ts package.json .github/workflows/ci.yml
git commit -m "feat(release): add runCutRelease + CLI entry, wire scripts/__tests__ into test runs"
```

---

### Task 3: `.github/workflows/release.yml`

**Files:**

- Create: `.github/workflows/release.yml`

**Interfaces:**

- Consumes: `bun scripts/cut-release.ts <patch|minor|major> <notes-out-path>` CLI from Task 2 — on success it updates `package.json` and `CHANGELOG.md` in place and writes the release notes body to `<notes-out-path>`, then exits 0. On failure (bad bump arg, missing notes path, or `runCutRelease` throwing — e.g. an empty Unreleased section) it prints an error and exits 1, leaving `package.json`/`CHANGELOG.md` untouched.
- Consumes: `bun run build:binaries` (existing, unchanged) — produces `dist/filenet-<target>.tar.gz`/`.zip` for all 5 targets.

This task has no automated test — it's a workflow file, verified by actually running it. Follow the steps below exactly; there's no red/green cycle for YAML.

- [ ] **Step 1: Write the workflow file**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      bump:
        description: 'Version bump type'
        required: true
        type: choice
        options:
          - patch
          - minor
          - major

permissions:
  contents: write

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest

    steps:
      - name: Ensure this only runs from master
        run: |
          if [ "${{ github.ref }}" != "refs/heads/master" ]; then
            echo "This workflow must be run from master (got ${{ github.ref }})."
            exit 1
          fi

      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: '1.3.14'

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Lint
        run: bunx eslint --max-warnings=0

      - name: Format check
        run: bunx prettier --check .

      - name: Test
        run: bun test server/__tests__ scripts/__tests__

      - name: Cut release (bump version + changelog)
        run: bun scripts/cut-release.ts ${{ inputs.bump }} /tmp/release-notes.md

      - name: Format cut files
        run: bunx prettier --write package.json CHANGELOG.md

      - name: Read new version
        id: version
        run: echo "version=$(jq -r .version package.json)" >> "$GITHUB_OUTPUT"

      - name: Commit, tag, and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add package.json CHANGELOG.md
          git commit -m "chore: release v${{ steps.version.outputs.version }}"
          git tag -a "v${{ steps.version.outputs.version }}" -m "v${{ steps.version.outputs.version }}"
          git push origin master --follow-tags

      - name: Build binaries
        run: bun run build:binaries

      - name: Publish GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "v${{ steps.version.outputs.version }}" \
            dist/*.tar.gz dist/*.zip \
            --title "v${{ steps.version.outputs.version }}" \
            --notes-file /tmp/release-notes.md
```

- [ ] **Step 2: Validate YAML syntax locally**

Run: `bunx yaml-lint .github/workflows/release.yml 2>/dev/null || node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/release.yml', 'utf8'))" 2>/dev/null || python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"`
Expected: no output / no error (whichever of the three fallback commands is available on your machine — this just checks the file parses as valid YAML before pushing it; GitHub will also validate it server-side, but catching a typo locally is faster).

- [ ] **Step 3: Lint, format, and commit**

Run: `bunx prettier --check .github/workflows/release.yml`
Expected: no errors. If Prettier complains, run `bunx prettier --write .github/workflows/release.yml` and re-check.

```bash
git add .github/workflows/release.yml
git commit -m "feat(release): add release workflow (version bump, tag, build, publish)"
```

- [ ] **Step 4: Push and do a real dry run**

```bash
git push origin master
```

Then, from the GitHub UI (Actions tab → "Release" workflow → "Run workflow"), or via `gh workflow run release.yml -f bump=patch`, trigger a real run with `bump: patch`. Confirm, in order:

1. The pre-flight lint/format/test steps pass.
2. `package.json`'s version and `CHANGELOG.md` are updated correctly on `master` (check via `git pull` locally afterward).
3. A new tag `v0.1.1` (or whatever the bumped version is) exists and points at that commit: `git fetch --tags && git log -1 v0.1.1`.
4. The GitHub Release page shows the correct title, the CHANGELOG section content as notes, and all 5 binary archives attached.
5. Download one archive locally and confirm it extracts and runs (matches the existing single-binary-distribution verification bar).

If any step fails, fix the workflow file and re-run — don't consider this task done until a real end-to-end dispatch succeeds and produces a correct Release.

---

## Self-Review Notes

- **Spec coverage:** trigger + guard rails (Task 3 Step 1), pre-flight gate (Task 3 Step 1's lint/format/test steps), version+changelog cutting with empty-section failure (Task 1 + Task 2), commit/tag/push to master (Task 3 Step 1), build all 5 binaries (Task 3 Step 1, reuses existing `build:binaries`), publish with CHANGELOG-verbatim notes (Task 3 Step 1) — all spec sections have a corresponding task.
- **Placeholder scan:** no TBD/TODO markers; every step has complete, runnable code or an exact command.
- **Type consistency:** `Bump`, `bumpVersion`, `cutChangelog`, `CutReleaseOptions`, `runCutRelease` are defined once in Task 1/2 and referenced identically (same names, same signatures) in Task 3's CLI invocation.
