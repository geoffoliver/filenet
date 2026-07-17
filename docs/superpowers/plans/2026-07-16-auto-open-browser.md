# Auto-Open Browser On Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the unified server starts, automatically open `http://localhost:<UI_PORT>` in the user's default browser, controlled by a new `autoOpenBrowser` Settings toggle that defaults to `true`.

**Architecture:** A new dependency-injectable `openBrowser()` helper (`server/browser-opener.ts`) maps `process.platform` to the right shell-out command (`open` / `cmd /c start ""` / `xdg-open`), fires it once at the end of `server/index.ts`'s startup sequence, and never throws — a failed launch (no browser available, e.g. headless Docker) is caught and logged, not treated as an error. The setting follows the exact same round-trip every other `Settings` boolean already takes: Drizzle schema column → `SettingsPatch`/Zod validation → `PATCH /api/settings` (already generic) → frontend `Settings` type → a new Settings UI section.

**Tech Stack:** Bun (`Bun.spawn`, `Bun.serve`), Drizzle ORM/SQLite, Zod, Next.js/React, `bun:test`, Playwright.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-auto-open-browser-design.md`.
- Same code path runs in every run mode (dev, Docker, compiled binary) — no environment detection to suppress the attempt.
- `openBrowser()` must never throw and must never block server startup (fire-and-forget, no `await` at the call site in `server/index.ts`).
- Only the local UI root URL is opened (`http://localhost:<UI_PORT>`) — no deep-linking to `/setup`.
- New DB migrations are generated with `bun run db:generate`, never hand-written SQL.
- Run `bunx prettier --write <file>` on any file the pre-commit hook flags before committing (this repo's husky pre-commit hook runs `prettier --check` and will reject unformatted commits).
- Follow TDD: write the failing test before the implementation for every task below.

---

### Task 1: `Settings.autoOpenBrowser` schema column + migration

**Files:**

- Modify: `server/schema.ts:77-93` (the `settings` sqliteTable definition)
- Create: a new file under `drizzle/migrations/` (auto-named by `drizzle-kit generate`)
- Test: `server/__tests__/config.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `Settings.autoOpenBrowser: boolean`, available to every later task via `getOrCreateSettings(db)` / `getSettings(db)`.

- [ ] **Step 1: Write the failing test**

Add to `server/__tests__/config.test.ts`, inside the existing `describe('getOrCreateSettings', ...)` block (after the `'defaults updateRepo and updateCheckIntervalMinutes'` test at line 72):

```ts
it('defaults autoOpenBrowser to true', async () => {
  const s = await getOrCreateSettings(db);
  expect(s.autoOpenBrowser).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test server/__tests__/config.test.ts -t "defaults autoOpenBrowser to true"`
Expected: FAIL — `s.autoOpenBrowser` is `undefined`, not `true` (the column doesn't exist yet, but Drizzle silently returns `undefined` for unknown properties on the inferred type at the TS level; at runtime the test assertion fails because the value isn't `true`).

- [ ] **Step 3: Add the column to the schema**

In `server/schema.ts`, inside the `settings` table definition, add a new field after `updateCheckIntervalMinutes` (line 92):

```ts
  updateCheckIntervalMinutes: integer('updateCheckIntervalMinutes').notNull().default(1440),
  autoOpenBrowser: integer('autoOpenBrowser', { mode: 'boolean' }).notNull().default(true),
});
```

- [ ] **Step 4: Generate the migration**

Run: `bun run db:generate`
Expected: a new file appears under `drizzle/migrations/` (e.g. `0003_<random-name>.sql`) containing an `ALTER TABLE 'Settings' ADD 'autoOpenBrowser' integer DEFAULT true NOT NULL;`-shaped statement, plus an updated `drizzle/migrations/meta/_journal.json`.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test server/__tests__/config.test.ts -t "defaults autoOpenBrowser to true"`
Expected: PASS

- [ ] **Step 6: Run the full backend test suite to check for regressions**

Run: `bun test server/__tests__/config.test.ts`
Expected: all tests in the file PASS (existing tests use a fresh test DB created via `applyMigrations(db)`, so the new migration is picked up automatically).

- [ ] **Step 7: Commit**

```bash
git add server/schema.ts drizzle/migrations server/__tests__/config.test.ts
git commit -m "feat: add autoOpenBrowser Settings column (default true)"
```

---

### Task 2: `SettingsPatch` + Zod validation

**Files:**

- Modify: `server/config.ts:34-43` (`SettingsPatch` type)
- Modify: `server/schemas.ts:26-47` (`PatchSettingsBodySchema`)
- Test: `server/__tests__/config.test.ts`, `server/__tests__/schemas.test.ts`

**Interfaces:**

- Consumes: `Settings.autoOpenBrowser` from Task 1.
- Produces: `SettingsPatch.autoOpenBrowser?: boolean` (server/config.ts), accepted by `updateSettings(db, patch)` (already generic — no changes needed there) and validated by `PatchSettingsBodySchema`.

- [ ] **Step 1: Write the failing tests**

Add to `server/__tests__/config.test.ts`, inside `describe('updateSettings', ...)` (after the test at line ~83, following the same shape as the existing `'updates specific fields without touching others'` test):

```ts
it('updates autoOpenBrowser', async () => {
  await getOrCreateSettings(db);
  const updated = await updateSettings(db, { autoOpenBrowser: false });
  expect(updated.autoOpenBrowser).toBe(false);
});
```

Add to `server/__tests__/schemas.test.ts`, inside `describe('PatchSettingsBodySchema', ...)` (after the `'rejects wrong type for autoAcceptFromAnyone'` test):

```ts
it('accepts autoOpenBrowser', () => {
  const r = PatchSettingsBodySchema.safeParse({ autoOpenBrowser: false });
  expect(r.success).toBe(true);
  if (!r.success) return;
  expect(r.data.autoOpenBrowser).toBe(false);
});

it('rejects wrong type for autoOpenBrowser', () => {
  expect(PatchSettingsBodySchema.safeParse({ autoOpenBrowser: 'yes' }).success).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/__tests__/config.test.ts server/__tests__/schemas.test.ts -t "autoOpenBrowser"`
Expected: FAIL — `PatchSettingsBodySchema` is `.strict()`, so `autoOpenBrowser` is currently an unrecognized key and `updateSettings` silently drops the field since it isn't in `SettingsPatch`'s type (the `updateSettings` test fails because `updated.autoOpenBrowser` is `undefined`, not `false`).

- [ ] **Step 3: Add the field to `SettingsPatch`**

In `server/config.ts`, add to the `SettingsPatch` type (after `updateCheckIntervalMinutes?: number;`):

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
  autoOpenBrowser?: boolean;
};
```

- [ ] **Step 4: Add the field to `PatchSettingsBodySchema`**

In `server/schemas.ts`, add to the schema object (after `updateCheckIntervalMinutes: z.int().min(0).max(35791).optional(),`):

```ts
    updateCheckIntervalMinutes: z.int().min(0).max(35791).optional(),
    autoOpenBrowser: z.boolean().optional(),
  })
  .strict();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test server/__tests__/config.test.ts server/__tests__/schemas.test.ts`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add server/config.ts server/schemas.ts server/__tests__/config.test.ts server/__tests__/schemas.test.ts
git commit -m "feat: accept autoOpenBrowser in PATCH /api/settings"
```

---

### Task 3: `server/browser-opener.ts` module

**Files:**

- Create: `server/browser-opener.ts`
- Test: Create `server/__tests__/browser-opener.test.ts`

**Interfaces:**

- Consumes: `Bun.spawn` (default), or an injected mock matching `typeof Bun.spawn`.
- Produces: `openBrowser(url: string, opts?: OpenBrowserOptions): void`, consumed by Task 4 (`server/index.ts`). `OpenBrowserOptions = { spawnImpl?: typeof Bun.spawn; platform?: NodeJS.Platform }`.

- [ ] **Step 1: Write the failing tests**

Create `server/__tests__/browser-opener.test.ts`:

```ts
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { openBrowser } from '../browser-opener';

type FakeSubprocess = { exited: Promise<number> };

function fakeSpawn(
  calls: unknown[],
  result: { exited: Promise<number> } | (() => never) = { exited: Promise.resolve(0) },
): typeof Bun.spawn {
  return ((opts: unknown) => {
    calls.push(opts);
    if (typeof result === 'function') return result();
    return result as FakeSubprocess;
  }) as unknown as typeof Bun.spawn;
}

describe('openBrowser', () => {
  afterEach(() => {
    // Nothing persists between tests (no module-level state in browser-opener.ts).
  });

  it('spawns "open <url>" on darwin', () => {
    const calls: unknown[] = [];
    openBrowser('http://localhost:3000', { platform: 'darwin', spawnImpl: fakeSpawn(calls) });
    expect(calls).toEqual([
      { cmd: ['open', 'http://localhost:3000'], stdio: ['ignore', 'ignore', 'ignore'] },
    ]);
  });

  it('spawns "cmd /c start \\"\\" <url>" on win32', () => {
    const calls: unknown[] = [];
    openBrowser('http://localhost:3000', { platform: 'win32', spawnImpl: fakeSpawn(calls) });
    expect(calls).toEqual([
      {
        cmd: ['cmd', '/c', 'start', '""', 'http://localhost:3000'],
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    ]);
  });

  it('spawns "xdg-open <url>" on linux', () => {
    const calls: unknown[] = [];
    openBrowser('http://localhost:3000', { platform: 'linux', spawnImpl: fakeSpawn(calls) });
    expect(calls).toEqual([
      { cmd: ['xdg-open', 'http://localhost:3000'], stdio: ['ignore', 'ignore', 'ignore'] },
    ]);
  });

  it('falls back to xdg-open on an unrecognized platform', () => {
    const calls: unknown[] = [];
    openBrowser('http://localhost:3000', {
      platform: 'freebsd' as NodeJS.Platform,
      spawnImpl: fakeSpawn(calls),
    });
    expect(calls).toEqual([
      { cmd: ['xdg-open', 'http://localhost:3000'], stdio: ['ignore', 'ignore', 'ignore'] },
    ]);
  });

  it('logs a warning and does not throw when spawnImpl throws synchronously', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const throwingSpawn = (() => {
      throw new Error('spawn xdg-open ENOENT');
    }) as unknown as typeof Bun.spawn;

    expect(() =>
      openBrowser('http://localhost:3000', { platform: 'linux', spawnImpl: throwingSpawn }),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs a warning when the spawned process exits non-zero', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const calls: unknown[] = [];
    openBrowser('http://localhost:3000', {
      platform: 'darwin',
      spawnImpl: fakeSpawn(calls, { exited: Promise.resolve(1) }),
    });

    // openBrowser is fire-and-forget: give the .exited promise a tick to resolve.
    await Bun.sleep(10);

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test server/__tests__/browser-opener.test.ts`
Expected: FAIL with `Cannot find module '../browser-opener'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `server/browser-opener.ts`:

```ts
export type OpenBrowserOptions = {
  spawnImpl?: typeof Bun.spawn;
  platform?: NodeJS.Platform;
};

function commandFor(platform: NodeJS.Platform, url: string): string[] {
  if (platform === 'darwin') return ['open', url];
  // The literal `""` argument is required: `start` treats the first quoted
  // argument as a window title, not the URL to open, so an empty title must
  // be supplied explicitly.
  if (platform === 'win32') return ['cmd', '/c', 'start', '""', url];
  return ['xdg-open', url];
}

/**
 * Best-effort: opens `url` in the OS default browser. Never throws and
 * never blocks the caller — a missing browser opener (e.g. no xdg-open in
 * a headless container) is logged and otherwise ignored.
 */
export function openBrowser(url: string, opts: OpenBrowserOptions = {}): void {
  const spawnImpl = opts.spawnImpl ?? Bun.spawn;
  const platform = opts.platform ?? process.platform;
  const cmd = commandFor(platform, url);

  try {
    const proc = spawnImpl({ cmd, stdio: ['ignore', 'ignore', 'ignore'] });
    proc.exited
      .then((code) => {
        if (code !== 0) {
          console.warn(
            `Failed to open browser at ${url}: "${cmd.join(' ')}" exited with code ${code}`,
          );
        }
      })
      .catch((err) => {
        console.warn(`Failed to open browser at ${url}: ${err}`);
      });
  } catch (err) {
    console.warn(`Failed to open browser at ${url}: ${err}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test server/__tests__/browser-opener.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add server/browser-opener.ts server/__tests__/browser-opener.test.ts
git commit -m "feat: add cross-platform openBrowser helper"
```

---

### Task 4: Wire `openBrowser` into `server/index.ts`

**Files:**

- Modify: `server/index.ts:1-24` (imports), `server/index.ts:140-150` (after the UI `Bun.serve` call)

**Interfaces:**

- Consumes: `openBrowser(url, opts?)` from Task 3; `startupSettings.autoOpenBrowser` from Task 1 (already in scope in this file via the existing `const startupSettings = await getOrCreateSettings(db);` at line 42).
- Produces: nothing consumed by later tasks — this is the final wiring point.

- [ ] **Step 1: Add the import**

In `server/index.ts`, add to the import block (after the `startFileWatcher` import at line 22):

```ts
import { startFileWatcher } from './watcher';
import { openBrowser } from './browser-opener';
```

- [ ] **Step 2: Call `openBrowser` after the UI server starts**

In `server/index.ts`, immediately after the first `Bun.serve({...})` call (the UI server, ending at line 150), add:

```ts
Bun.serve({
  port: UI_PORT,
  fetch: createUiServer({
    identity,
    db,
    connectPeer: connectPeerFn,
    updater: updateManager,
    watcher: fileWatcher,
    outDir: resolveAssetPath('out', import.meta.dir),
  }),
});

if (startupSettings.autoOpenBrowser) {
  openBrowser(`http://localhost:${UI_PORT}`);
}
```

- [ ] **Step 3: Manual verification (this file has no dedicated unit test — it's the entrypoint script that runs top-level on import, same as the rest of `server/index.ts`'s startup wiring)**

Run: `bun run server`
Expected: within a couple seconds, your default browser opens a new tab/window to `http://localhost:3000` showing the Filenet UI (or the `/setup` wizard on a fresh database). Confirm this on macOS (the available dev machine). Note in the task's completion report whether Linux/Windows were also checked, since neither can be verified from this environment — call the gap out explicitly rather than claiming it as tested.

- [ ] **Step 4: Run the full backend test suite to check for regressions**

Run: `bun test server/__tests__`
Expected: all PASS (no existing test imports or executes `server/index.ts` directly, so this change can't have broken anything covered by the suite — this step is a sanity check, not a targeted regression test).

- [ ] **Step 5: Commit**

```bash
git add server/index.ts
git commit -m "feat: auto-open browser on server start when enabled"
```

---

### Task 5: Frontend `Settings` type + Playwright fixture

**Files:**

- Modify: `app/lib/api.ts:43-73` (`Settings` and `SettingsPatch` types)
- Modify: `e2e/helpers.ts:9-21` (`SETTINGS` fixture)

**Interfaces:**

- Consumes: nothing new (this is a type-only change plus a test fixture update).
- Produces: `Settings.autoOpenBrowser: boolean` and `SettingsPatch.autoOpenBrowser?: boolean` in `app/lib/api.ts`, consumed by Task 6 (`SettingsView.tsx`) and Task 7 (`e2e/settings.spec.ts`, via the updated `SETTINGS` fixture).

- [ ] **Step 1: Add the field to both types in `app/lib/api.ts`**

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
  autoOpenBrowser: boolean;
};

export type EnvConfig = {
  sharedFolders: string[];
  downloadFolder: string | null;
};

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
  autoOpenBrowser?: boolean;
};
```

- [ ] **Step 2: Add the field to the `SETTINGS` fixture in `e2e/helpers.ts`**

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
  autoOpenBrowser: true,
};
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new type errors (this is a pure additive change to two object-literal types; nothing currently destructures `Settings` exhaustively in a way that would break).

- [ ] **Step 4: Commit**

```bash
git add app/lib/api.ts e2e/helpers.ts
git commit -m "feat: add autoOpenBrowser to frontend Settings type and test fixture"
```

---

### Task 6: Settings UI — new "Startup" section

**Files:**

- Modify: `app/(shell)/settings/SettingsView.tsx:564-565` (insert new section between `NetworkingSection` and `MaintenanceSection`), `app/(shell)/settings/SettingsView.tsx:873-874` (render list)
- Test: `e2e/settings.spec.ts`

**Interfaces:**

- Consumes: `Settings.autoOpenBrowser`, `SettingsPatch.autoOpenBrowser`, `patchSettings()` from `app/lib/api.ts` (Task 5); the `Section`/`SaveButton` helper components and `styles` module already defined at the top of `SettingsView.tsx`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing Playwright tests**

Add to `e2e/settings.spec.ts` (after the `'rescan interval field is rendered'` test at line 86):

```ts
test('startup toggle is rendered with the correct default', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByText('Automatically open the app in your browser on start')).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Automatically open the app in your browser on start' }),
  ).toBeChecked();
});

test('unchecking the startup toggle calls the API with autoOpenBrowser: false', async ({
  page,
}) => {
  let patched: unknown;
  await page.route('/api/settings', (route) => {
    if (route.request().method() === 'PATCH' || route.request().method() === 'PUT') {
      patched = route.request().postDataJSON();
      return route.fulfill({ json: { ...SETTINGS, autoOpenBrowser: false } });
    }
    return route.fulfill({ json: SETTINGS });
  });

  await page.goto('/settings');
  await page
    .getByRole('checkbox', { name: 'Automatically open the app in your browser on start' })
    .uncheck();
  const startupSection = page.locator('section', {
    has: page.getByText('Automatically open the app in your browser on start'),
  });
  await startupSection.getByRole('button', { name: /^save$/i }).click();

  expect(patched).toEqual({ autoOpenBrowser: false });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx playwright test e2e/settings.spec.ts -g "startup toggle"`
Expected: FAIL — the text "Automatically open the app in your browser on start" doesn't exist anywhere in the rendered page yet.

- [ ] **Step 3: Add the `StartupSection` component**

In `app/(shell)/settings/SettingsView.tsx`, insert a new section between the end of `NetworkingSection` (line 564) and the `// ── Maintenance section` comment (line 566):

```tsx
// ── Startup section ───────────────────────────────────────────────────────────

function StartupSection({ initial }: { initial: Settings }) {
  const [autoOpen, setAutoOpen] = useState(initial.autoOpenBrowser);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    patchSettings({ autoOpenBrowser: autoOpen })
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <Section title="Startup">
      <form className={styles.form} onSubmit={handleSubmit}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={autoOpen}
            onChange={(e) => setAutoOpen(e.target.checked)}
          />
          <span>Automatically open the app in your browser on start</span>
        </label>

        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.formFooter}>
          <SaveButton saving={saving} saved={saved} />
        </div>
      </form>
    </Section>
  );
}
```

- [ ] **Step 4: Add `StartupSection` to the render list**

In `app/(shell)/settings/SettingsView.tsx`, update the render list (around line 873-874):

```tsx
      <NetworkingSection initial={settings} />
      <StartupSection initial={settings} />
      <ScriptsSection />
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx playwright test e2e/settings.spec.ts`
Expected: all PASS

- [ ] **Step 6: Format and commit**

```bash
bunx prettier --write "app/(shell)/settings/SettingsView.tsx" e2e/settings.spec.ts
git add "app/(shell)/settings/SettingsView.tsx" e2e/settings.spec.ts
git commit -m "feat: add Startup section with auto-open-browser toggle to Settings UI"
```

---

### Task 7: Docs — README, CHANGELOG, TODO

**Files:**

- Modify: `README.md:106-116` (Configuration section)
- Modify: `CHANGELOG.md:8-11` (`[Unreleased]` → `Added`)
- Modify: `TODO.md:186` (check off the item)

**Interfaces:**

- Consumes: nothing (documentation only).
- Produces: nothing.

- [ ] **Step 1: Update README.md**

In `README.md`, add a new bullet to the Configuration list (after the `**Port**` bullet at line 116):

```markdown
- **Port** — the port peers connect to (default 7734); you must forward this port on your router
- **Auto-open browser** — automatically opens the app in your default browser when the server starts (default: on)
```

- [ ] **Step 2: Update CHANGELOG.md**

In `CHANGELOG.md`, add a bullet under `## [Unreleased]` → `### Added` (after the "Reactive filesystem watcher" line):

```markdown
- **Auto-open browser** — the server now opens the UI in your default browser on start (configurable in Settings, default on); safely no-ops with a logged warning if no browser is available (e.g. headless Docker).
```

- [ ] **Step 3: Update TODO.md**

In `TODO.md`, change line 186 from:

```markdown
- [ ] Auto-open browser on app start (setting, defaults to true)
```

to:

```markdown
- [x] Auto-open browser on app start (setting, defaults to true)
```

- [ ] **Step 4: Format and commit**

```bash
bunx prettier --write README.md CHANGELOG.md TODO.md
git add README.md CHANGELOG.md TODO.md
git commit -m "docs: document auto-open-browser setting"
```

---

### Task 8: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `bun test`
Expected: all PASS

- [ ] **Step 2: Run lint**

Run: `bun run lint`
Expected: no errors

- [ ] **Step 3: Run format check**

Run: `bun run format:check`
Expected: no issues

- [ ] **Step 4: Run the full Playwright suite**

Run: `bunx playwright test`
Expected: all PASS

- [ ] **Step 5: Manual smoke test**

Run: `bun run server`, confirm the browser opens automatically to the Filenet UI. Then go to Settings → Startup, uncheck the toggle, save, restart the server (`Ctrl+C` then `bun run server` again), and confirm the browser does **not** open this time. Re-check the toggle to restore the default before finishing.
