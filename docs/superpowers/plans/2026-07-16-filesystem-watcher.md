# Filesystem Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reactively index shared-folder changes (add/change/delete) via a chokidar-based filesystem watcher, so the search index updates within seconds instead of waiting for the next periodic/manual rescan — without replacing that rescan, which stays as the fallback safety net.

**Architecture:** A new `server/watcher.ts` module owns one chokidar `FSWatcher` per running app. Adds/changes call the existing `indexFile()` directly; deletes are debounced behind a grace period via a small new `removeIndexedFile()`. The watcher is wired into `server/index.ts` at boot and into `server/management.ts`'s existing `PATCH /api/settings` handler so folder reconfiguration updates the watched set live, with no restart.

**Tech Stack:** Bun, `bun:test`, Drizzle/SQLite, chokidar (new dependency).

**Design doc:** `docs/superpowers/specs/2026-07-16-filesystem-watcher-design.md`

## Global Constraints

- The periodic/manual scan (`scanAndIndex`, `startPeriodicRescan`) is untouched — this feature is purely additive.
- No new Settings fields, no new UI. The watcher is always on.
- Watcher exclusions must match `scanDirectory`'s existing behavior exactly: symlinks are never indexed, dotfiles/dot-directories are never indexed.
- Delete grace period default: 30,000ms (`DEFAULT_DELETE_GRACE_MS`), overridable via an options object (not hardcoded) so tests can use short values.
- `awaitWriteFinish` stability threshold default: 2000ms, also overridable via the same options object for the same reason.
- Errors from a single bad folder, a single bad event, or a watcher-level `error` event must be logged (`console.error`) and must never crash the process or stop watching other folders.

---

### Task 1: `server/watcher.ts` — add/change indexing

**Files:**

- Create: `server/watcher.ts`
- Test: `server/__tests__/watcher.test.ts`
- Modify: `package.json` (add `chokidar` dependency)

**Interfaces:**

- Produces: `export interface FileWatcherOptions { deleteGraceMs?: number; stabilityThresholdMs?: number }`
- Produces: `export interface FileWatcherHandle { stop: () => void; syncFolders: (folders: string[]) => void }`
- Produces: `export function startFileWatcher(db: Db, folders: string[], options?: FileWatcherOptions): FileWatcherHandle`
- Produces: `export const DEFAULT_DELETE_GRACE_MS = 30_000`
- Consumes: `indexFile(db, path)` from `server/indexer.ts` (existing, unchanged)

This task implements `add`/`change` handling only. `unlink` handling is a no-op stub (`watcher.on('unlink', () => {})`) until Task 2. `syncFolders`/`stop` get minimal implementations here (`stop` closes the watcher; `syncFolders` is a stub that does nothing) — both are filled in for real in Task 3. This keeps Task 1 focused on proving chokidar works under Bun and that indexing reacts to real filesystem events, which is the risk-reduction step called out in the design doc.

- [ ] **Step 1: Add the chokidar dependency**

Run: `bun add chokidar`

This resolves and installs the current stable chokidar release (v4+) with its bundled TypeScript types — no separate `@types/chokidar` needed.

- [ ] **Step 2: Write the failing tests**

Create `server/__tests__/watcher.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'fs';

import { type Db, applyMigrations, createDb } from '../db';
import { sharedFiles } from '../schema';
import { type FileWatcherHandle, startFileWatcher } from '../watcher';

const TEST_DB_URL = 'file:./data/test-watcher.db';
let db: Db;
let tmpDir: string;
let handle: FileWatcherHandle | null = null;

// Test-only tuning: fast enough to keep the suite quick, still exercises
// the real debounce/grace-period code paths.
const FAST_OPTIONS = { deleteGraceMs: 50, stabilityThresholdMs: 20 };

function findFile(path: string) {
  return db.select().from(sharedFiles).where(eq(sharedFiles.path, path)).get() ?? null;
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await Bun.sleep(20);
  }
}

beforeAll(async () => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-watcher-test-'));
});

afterAll(async () => {
  db.$client.close();
  await rm(tmpDir, { recursive: true, force: true });
  try {
    unlinkSync('./data/test-watcher.db');
  } catch {}
});

beforeEach(() => {
  db.delete(sharedFiles).run();
});

afterEach(() => {
  handle?.stop();
  handle = null;
});

describe('startFileWatcher — add/change', () => {
  it('indexes a file added after the watcher starts', async () => {
    const dir = join(tmpDir, 'watch-add');
    await mkdir(dir);
    handle = startFileWatcher(db, [dir], FAST_OPTIONS);

    const path = join(dir, 'new.txt');
    await writeFile(path, 'new content');

    await waitFor(() => findFile(path) !== null);
    expect(findFile(path)?.sha256).toHaveLength(64);
  });

  it('re-indexes a file after it changes', async () => {
    const dir = join(tmpDir, 'watch-change');
    await mkdir(dir);
    const path = join(dir, 'existing.txt');
    await writeFile(path, 'original');
    handle = startFileWatcher(db, [dir], FAST_OPTIONS);

    // ignoreInitial: true means the pre-existing file above is not indexed
    // by the watcher itself — confirm that, then prove a real change is seen.
    await Bun.sleep(100);
    expect(findFile(path)).toBeNull();

    await writeFile(path, 'changed content');
    await waitFor(() => findFile(path)?.sha256 !== undefined && findFile(path)!.sha256 !== null);
    const record = findFile(path);
    expect(record).not.toBeNull();
  });

  it('does not index a symlink', async () => {
    const dir = join(tmpDir, 'watch-symlink');
    await mkdir(dir);
    const target = join(dir, 'target.txt');
    await writeFile(target, 'target content');
    handle = startFileWatcher(db, [dir], FAST_OPTIONS);
    await waitFor(() => findFile(target) !== null);

    const link = join(dir, 'link.txt');
    await symlink(target, link);
    await Bun.sleep(150);

    expect(findFile(link)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test server/__tests__/watcher.test.ts`
Expected: FAIL — `server/watcher.ts` does not exist yet (module not found).

- [ ] **Step 4: Implement `server/watcher.ts`**

```ts
import { lstat } from 'node:fs/promises';

import { type FSWatcher, watch } from 'chokidar';

import type { Db } from './db';
import { indexFile } from './indexer';

export const DEFAULT_DELETE_GRACE_MS = 30_000;
export const DEFAULT_STABILITY_THRESHOLD_MS = 2000;

const DOTFILE_SEGMENT = /(^|[/\\])\../;

export interface FileWatcherOptions {
  deleteGraceMs?: number;
  stabilityThresholdMs?: number;
}

export interface FileWatcherHandle {
  stop: () => void;
  syncFolders: (folders: string[]) => void;
}

async function handleAddOrChange(db: Db, path: string): Promise<void> {
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink()) return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    console.error(`File watcher: failed to stat ${path}:`, err);
    return;
  }
  try {
    await indexFile(db, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    console.error(`File watcher: failed to index ${path}:`, err);
  }
}

export function startFileWatcher(
  db: Db,
  folders: string[],
  options: FileWatcherOptions = {},
): FileWatcherHandle {
  const { stabilityThresholdMs = DEFAULT_STABILITY_THRESHOLD_MS } = options;

  const watcher: FSWatcher = watch([...folders], {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (path: string) => DOTFILE_SEGMENT.test(path),
    awaitWriteFinish: { stabilityThreshold: stabilityThresholdMs, pollInterval: 20 },
  });

  watcher.on('add', (path) => {
    void handleAddOrChange(db, path);
  });
  watcher.on('change', (path) => {
    void handleAddOrChange(db, path);
  });
  watcher.on('unlink', () => {
    // Implemented in Task 2.
  });
  watcher.on('error', (err) => {
    console.error('File watcher error:', err);
  });

  return {
    stop: () => {
      void watcher.close();
    },
    syncFolders: () => {
      // Implemented in Task 3.
    },
  };
}
```

Note: `options.deleteGraceMs` isn't read yet in this task (no-op `unlink` handler) — it's wired up in Task 2. `FileWatcherOptions` keeps the field now since the type is part of this task's public interface; the code above deliberately does **not** destructure `deleteGraceMs` (only `stabilityThresholdMs`) to avoid an unused-variable lint failure — Task 2 adds the destructuring at the same time it starts using the value.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test server/__tests__/watcher.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Run the full backend suite to check for regressions**

Run: `bun run test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock server/watcher.ts server/__tests__/watcher.test.ts
git commit -m "feat: add chokidar-based file watcher (add/change indexing)"
```

---

### Task 2: Delete handling with grace period

**Files:**

- Modify: `server/indexer.ts` (add `removeIndexedFile`)
- Modify: `server/watcher.ts` (implement `unlink` handling)
- Test: `server/__tests__/indexer.test.ts` (add `removeIndexedFile` coverage)
- Test: `server/__tests__/watcher.test.ts` (add delete coverage)

**Interfaces:**

- Produces: `export async function removeIndexedFile(db: Db, path: string): Promise<void>` in `server/indexer.ts`
- Consumes: `FileWatcherOptions.deleteGraceMs` (already on the type from Task 1)

- [ ] **Step 1: Write the failing test for `removeIndexedFile`**

Add to `server/__tests__/indexer.test.ts`, inside a new `describe` block placed after the existing `describe('removeStaleEntries', ...)` block (update the import at the top of the file to include `removeIndexedFile`):

```ts
describe('removeIndexedFile', () => {
  it('removes the record for the given path', async () => {
    const path = join(tmpDir, 'remove-indexed.txt');
    await writeFile(path, 'content');
    await indexFile(db, path);
    expect(findFile(path)).not.toBeNull();

    await removeIndexedFile(db, path);
    expect(findFile(path)).toBeNull();
  });

  it('is a no-op when no record exists for the path', async () => {
    const path = join(tmpDir, 'remove-indexed-missing.txt');
    await removeIndexedFile(db, path);
    expect(findFile(path)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test server/__tests__/indexer.test.ts`
Expected: FAIL — `removeIndexedFile` is not exported from `../indexer`.

- [ ] **Step 3: Implement `removeIndexedFile`**

In `server/indexer.ts`, add directly after the closing brace of `removeStaleEntries` (after line 163, before the `MAX_RESCAN_INTERVAL_MINUTES` comment on line 165):

```ts
export async function removeIndexedFile(db: Db, path: string): Promise<void> {
  db.delete(sharedFiles).where(eq(sharedFiles.path, path)).run();
}
```

No new imports needed — `eq` and `sharedFiles` are already imported at the top of `server/indexer.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test server/__tests__/indexer.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing watcher delete tests**

Add to `server/__tests__/watcher.test.ts`, in a new `describe` block after `describe('startFileWatcher — add/change', ...)`:

```ts
describe('startFileWatcher — delete', () => {
  it('does not remove the record immediately on delete', async () => {
    const dir = join(tmpDir, 'watch-delete-immediate');
    await mkdir(dir);
    const path = join(dir, 'gone.txt');
    await writeFile(path, 'content');
    handle = startFileWatcher(db, [dir], FAST_OPTIONS);
    await waitFor(() => findFile(path) !== null);

    await rm(path);
    // Grace period is 50ms (FAST_OPTIONS) — check well before it elapses.
    await Bun.sleep(10);
    expect(findFile(path)).not.toBeNull();
  });

  it('removes the record after the grace period elapses', async () => {
    const dir = join(tmpDir, 'watch-delete-grace');
    await mkdir(dir);
    const path = join(dir, 'gone.txt');
    await writeFile(path, 'content');
    handle = startFileWatcher(db, [dir], FAST_OPTIONS);
    await waitFor(() => findFile(path) !== null);

    await rm(path);
    await waitFor(() => findFile(path) === null, 2000);
  });

  it('keeps the record if the file is recreated within the grace period', async () => {
    const dir = join(tmpDir, 'watch-delete-recreate');
    await mkdir(dir);
    const path = join(dir, 'flicker.txt');
    await writeFile(path, 'content');
    // Longer grace period here so the recreate below reliably lands inside the window.
    handle = startFileWatcher(db, [dir], { deleteGraceMs: 300, stabilityThresholdMs: 20 });
    await waitFor(() => findFile(path) !== null);

    await rm(path);
    await Bun.sleep(50);
    await writeFile(path, 'content again');

    // Wait past the original grace window; the record must have survived.
    await Bun.sleep(400);
    expect(findFile(path)).not.toBeNull();
  });
});
```

- [ ] **Step 6: Run to verify the new tests fail**

Run: `bun test server/__tests__/watcher.test.ts`
Expected: The "immediate" test passes trivially (nothing removes anything yet), but "removes the record after the grace period elapses" FAILS (record never removed, since `unlink` is still a no-op).

- [ ] **Step 7: Implement `unlink` handling in `server/watcher.ts`**

Replace the full contents of `server/watcher.ts` with:

```ts
import { lstat } from 'node:fs/promises';

import { type FSWatcher, watch } from 'chokidar';

import type { Db } from './db';
import { indexFile, removeIndexedFile } from './indexer';

export const DEFAULT_DELETE_GRACE_MS = 30_000;
export const DEFAULT_STABILITY_THRESHOLD_MS = 2000;

const DOTFILE_SEGMENT = /(^|[/\\])\../;

export interface FileWatcherOptions {
  deleteGraceMs?: number;
  stabilityThresholdMs?: number;
}

export interface FileWatcherHandle {
  stop: () => void;
  syncFolders: (folders: string[]) => void;
}

async function handleAddOrChange(db: Db, path: string): Promise<void> {
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink()) return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    console.error(`File watcher: failed to stat ${path}:`, err);
    return;
  }
  try {
    await indexFile(db, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    console.error(`File watcher: failed to index ${path}:`, err);
  }
}

async function confirmAndRemove(db: Db, path: string): Promise<void> {
  try {
    await lstat(path);
    // File exists again — an add/change event already re-indexed it (or
    // will shortly); nothing to do here.
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      await removeIndexedFile(db, path);
    } else {
      console.error(`File watcher: failed to confirm deletion of ${path}:`, err);
    }
  }
}

export function startFileWatcher(
  db: Db,
  folders: string[],
  options: FileWatcherOptions = {},
): FileWatcherHandle {
  const {
    deleteGraceMs = DEFAULT_DELETE_GRACE_MS,
    stabilityThresholdMs = DEFAULT_STABILITY_THRESHOLD_MS,
  } = options;

  const watched = new Set(folders);
  const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelPendingDelete(path: string) {
    const timer = pendingDeletes.get(path);
    if (timer !== undefined) {
      clearTimeout(timer);
      pendingDeletes.delete(path);
    }
  }

  const watcher: FSWatcher = watch([...watched], {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (path: string) => DOTFILE_SEGMENT.test(path),
    awaitWriteFinish: { stabilityThreshold: stabilityThresholdMs, pollInterval: 20 },
  });

  watcher.on('add', (path) => {
    cancelPendingDelete(path);
    void handleAddOrChange(db, path);
  });
  watcher.on('change', (path) => {
    cancelPendingDelete(path);
    void handleAddOrChange(db, path);
  });
  watcher.on('unlink', (path) => {
    cancelPendingDelete(path);
    const timer = setTimeout(() => {
      pendingDeletes.delete(path);
      void confirmAndRemove(db, path);
    }, deleteGraceMs);
    pendingDeletes.set(path, timer);
  });
  watcher.on('error', (err) => {
    console.error('File watcher error:', err);
  });

  return {
    stop: () => {
      for (const timer of pendingDeletes.values()) clearTimeout(timer);
      pendingDeletes.clear();
      void watcher.close();
    },
    syncFolders: () => {
      // Implemented in Task 3.
    },
  };
}
```

- [ ] **Step 8: Run to verify the tests pass**

Run: `bun test server/__tests__/watcher.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 9: Run the full backend suite**

Run: `bun run test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add server/indexer.ts server/watcher.ts server/__tests__/indexer.test.ts server/__tests__/watcher.test.ts
git commit -m "feat: remove deleted files from the index after a grace period"
```

---

### Task 3: Live folder reconfiguration (`syncFolders`) and `stop`

**Files:**

- Modify: `server/watcher.ts` (implement `syncFolders`)
- Test: `server/__tests__/watcher.test.ts` (add coverage)

**Interfaces:**

- Produces (implemented for real): `FileWatcherHandle.syncFolders(folders: string[]): void`
- No other public interface changes — `syncFolders`/`stop` signatures were already fixed in Task 1.

- [ ] **Step 1: Write the failing tests**

Add to `server/__tests__/watcher.test.ts`, in a new `describe` block after `describe('startFileWatcher — delete', ...)`:

```ts
describe('startFileWatcher — syncFolders', () => {
  it('starts watching a newly added folder', async () => {
    const dir1 = join(tmpDir, 'sync-add-1');
    const dir2 = join(tmpDir, 'sync-add-2');
    await mkdir(dir1);
    await mkdir(dir2);
    handle = startFileWatcher(db, [dir1], FAST_OPTIONS);

    handle.syncFolders([dir1, dir2]);

    const path = join(dir2, 'new-folder-file.txt');
    await writeFile(path, 'content');
    await waitFor(() => findFile(path) !== null);
  });

  it('stops watching a removed folder', async () => {
    const dir1 = join(tmpDir, 'sync-remove-1');
    const dir2 = join(tmpDir, 'sync-remove-2');
    await mkdir(dir1);
    await mkdir(dir2);
    handle = startFileWatcher(db, [dir1, dir2], FAST_OPTIONS);

    handle.syncFolders([dir1]);

    const path = join(dir2, 'removed-folder-file.txt');
    await writeFile(path, 'content');
    await Bun.sleep(150);
    expect(findFile(path)).toBeNull();
  });
});

describe('startFileWatcher — stop', () => {
  it('stops indexing after stop() is called', async () => {
    const dir = join(tmpDir, 'stop-basic');
    await mkdir(dir);
    const localHandle = startFileWatcher(db, [dir], FAST_OPTIONS);
    localHandle.stop();

    const path = join(dir, 'after-stop.txt');
    await writeFile(path, 'content');
    await Bun.sleep(150);
    expect(findFile(path)).toBeNull();
  });

  it('cancels pending deletes on stop() without throwing', async () => {
    const dir = join(tmpDir, 'stop-pending-delete');
    await mkdir(dir);
    const path = join(dir, 'pending.txt');
    await writeFile(path, 'content');
    const localHandle = startFileWatcher(db, [dir], {
      deleteGraceMs: 500,
      stabilityThresholdMs: 20,
    });
    await waitFor(() => findFile(path) !== null, 2000);

    await rm(path);
    await Bun.sleep(20); // let the unlink event register a pending timer
    expect(() => localHandle.stop()).not.toThrow();

    // Wait past what would have been the grace period — record must survive
    // since stop() cancelled the pending delete.
    await Bun.sleep(600);
    expect(findFile(path)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify the `syncFolders` tests fail**

Run: `bun test server/__tests__/watcher.test.ts`
Expected: The two `syncFolders` tests FAIL (no-op implementation means the added folder is never watched, and the removed folder is still watched). The `stop` tests should already PASS, since `stop()` was fully implemented in Task 2.

- [ ] **Step 3: Implement `syncFolders`**

In `server/watcher.ts`, replace the `syncFolders: () => { ... }` stub inside the returned object with:

```ts
    syncFolders: (folders: string[]) => {
      const next = new Set(folders);
      for (const folder of next) {
        if (!watched.has(folder)) {
          watched.add(folder);
          watcher.add(folder);
        }
      }
      for (const folder of [...watched]) {
        if (!next.has(folder)) {
          watched.delete(folder);
          void watcher.unwatch(folder);
        }
      }
    },
```

(`watched` is the `Set<string>` already created near the top of `startFileWatcher` in Task 2's implementation.)

- [ ] **Step 4: Run to verify all watcher tests pass**

Run: `bun test server/__tests__/watcher.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Run the full backend suite**

Run: `bun run test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/watcher.ts server/__tests__/watcher.test.ts
git commit -m "feat: support live shared-folder reconfiguration in the file watcher"
```

---

### Task 4: Wire the watcher into the running app

**Files:**

- Modify: `server/management.ts` (`ManagementDeps`, `createManagementFetch`, `PATCH /api/settings` handler)
- Modify: `server/index.ts` (start the watcher at boot, pass it through, stop it on shutdown)
- Test: `server/__tests__/management.test.ts` (add coverage for the new wiring)

**Interfaces:**

- Consumes: `FileWatcherHandle`, `startFileWatcher` from `server/watcher.ts` (Tasks 1–3)
- Consumes: `parseSharedFolders` from `server/config.ts` (existing)
- Produces: `ManagementDeps.watcher?: FileWatcherHandle` (optional, matching the existing optional-dependency pattern used by `ManagementDeps.networkSearch`)

- [ ] **Step 1: Write the failing management tests**

Add to `server/__tests__/management.test.ts`. First, add the import (alongside the existing `import type { UpdateManager, UpdateState } from '../updater';` line):

```ts
import type { FileWatcherHandle } from '../watcher';
```

Then add this helper near `makeFakeUpdater` (after its closing brace):

```ts
function makeFakeWatcher(): FileWatcherHandle & { syncFoldersCalls: string[][] } {
  const syncFoldersCalls: string[][] = [];
  return {
    syncFoldersCalls,
    stop: () => {},
    syncFolders: (folders: string[]) => {
      syncFoldersCalls.push(folders);
    },
  };
}
```

Then add these two tests inside the existing `describe` block that contains the `'indexes shared folders immediately when they are patched...'` test (i.e. right after it, in `server/__tests__/management.test.ts`):

```ts
it('syncs the file watcher when sharedFolders is patched', async () => {
  const dir = join(tmpDir, 'settings-watcher-sync');
  await mkdir(dir);
  const watcher = makeFakeWatcher();
  const handler = createManagementFetch({
    identity,
    db,
    connectPeer: neverConnect,
    updater: makeFakeUpdater(),
    watcher,
  });

  const res = await handler(jsonReq('/api/settings', 'PATCH', { sharedFolders: [dir] }));
  expect(res.status).toBe(200);
  expect(watcher.syncFoldersCalls).toEqual([[dir]]);
});

it('does not sync the file watcher when sharedFolders is not part of the patch', async () => {
  const watcher = makeFakeWatcher();
  const handler = createManagementFetch({
    identity,
    db,
    connectPeer: neverConnect,
    updater: makeFakeUpdater(),
    watcher,
  });

  await handler(jsonReq('/api/settings', 'PATCH', { name: 'Unrelated watcher test' }));
  expect(watcher.syncFoldersCalls).toEqual([]);
});
```

- [ ] **Step 2: Run to verify the tests fail**

Run: `bun test server/__tests__/management.test.ts`
Expected: FAIL — `watcher` is not an assignable property of `ManagementDeps` (type error) / `createManagementFetch` doesn't read it yet.

- [ ] **Step 3: Add `watcher` to `ManagementDeps` and destructure it**

In `server/management.ts`, add the import near the other type-only imports at the top of the file (alongside `import type { UpdateManager } from './updater';`):

```ts
import type { FileWatcherHandle } from './watcher';
```

Change the `ManagementDeps` type (currently lines 103–109):

```ts
export type ManagementDeps = {
  identity: Identity;
  db: Db;
  connectPeer: ConnectPeerFn;
  updater: UpdateManager;
  networkSearch?: typeof initiateNetworkSearch;
  watcher?: FileWatcherHandle;
};
```

Change the destructuring line in `createManagementFetch` (currently line 112):

```ts
const { identity, db, connectPeer, updater, networkSearch = initiateNetworkSearch, watcher } = deps;
```

- [ ] **Step 4: Call `watcher.syncFolders` from the `PATCH /api/settings` handler**

In `server/management.ts`, inside the `PATCH` branch of the `/api/settings` route (currently lines 319–328), the block reads:

```ts
const updated = await updateSettings(db, result.data);
if (result.data.sharedFolders !== undefined) {
  // Shared folders were just (re)configured — scan them now rather
  // than waiting for the user to notice nothing is indexed and
  // find the manual "Force rescan" button. Matches the existing
  // blocking-with-spinner UX of that button; both the setup
  // wizard and Settings already show a saving/spinner state while
  // this request is in flight, so no client changes are needed.
  await scanAndIndex(db, parseSharedFolders(updated.sharedFolders));
}
return Response.json(sanitizeSettings(updated));
```

Change it to also sync the watcher's folder set right after the scan:

```ts
const updated = await updateSettings(db, result.data);
if (result.data.sharedFolders !== undefined) {
  // Shared folders were just (re)configured — scan them now rather
  // than waiting for the user to notice nothing is indexed and
  // find the manual "Force rescan" button. Matches the existing
  // blocking-with-spinner UX of that button; both the setup
  // wizard and Settings already show a saving/spinner state while
  // this request is in flight, so no client changes are needed.
  const folders = parseSharedFolders(updated.sharedFolders);
  await scanAndIndex(db, folders);
  watcher?.syncFolders(folders);
}
return Response.json(sanitizeSettings(updated));
```

- [ ] **Step 5: Run to verify the management tests pass**

Run: `bun test server/__tests__/management.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full backend suite**

Run: `bun run test`
Expected: PASS

- [ ] **Step 7: Start the watcher at boot in `server/index.ts`**

In `server/index.ts`, add the import alongside the existing `import { startPeriodicRescan } from './indexer';` line:

```ts
import { startFileWatcher } from './watcher';
```

After the existing `stopRescan` block (currently lines 98–108):

```ts
const stopRescan = startPeriodicRescan(
  db,
  async () => {
    const s = await getOrCreateSettings(db);
    return parseSharedFolders(s.sharedFolders);
  },
  async () => {
    const s = await getOrCreateSettings(db);
    return s.rescanIntervalMinutes;
  },
);
```

add:

```ts
const fileWatcher = startFileWatcher(db, parseSharedFolders(startupSettings.sharedFolders));
```

(`startupSettings` and `parseSharedFolders` are already in scope at this point in the file — see lines 17 and 41.)

- [ ] **Step 8: Include the watcher in shutdown and pass it into the UI server**

Change the `shutdown` function (currently lines 125–132):

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

to:

```ts
const shutdown = () => {
  stopRescan();
  stopReconnect();
  stopUpdateChecks();
  fileWatcher.stop();
  pauseAllActiveDownloads(db)
    .catch(() => {})
    .finally(() => process.exit(0));
};
```

Change the `Bun.serve` call that creates the UI server (currently lines 136–145):

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

to:

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
```

- [ ] **Step 9: Type-check and manually smoke-test the wiring**

`server/index.ts` is the app's entrypoint and isn't covered by the unit-test suite (same as the existing `startPeriodicRescan`/`startReconnectLoop` wiring in this file) — verify it manually:

Run: `bunx tsc --noEmit` — expect no errors.

Then boot the app and confirm no startup errors and that a file dropped into a shared folder gets indexed:

```bash
mkdir -p /tmp/filenet-watcher-smoke
SHARED_FOLDERS=/tmp/filenet-watcher-smoke PORT=3099 P2P_PORT=3098 bun server/index.ts
```

In another terminal, once it's running:

```bash
echo "hello" > /tmp/filenet-watcher-smoke/hello.txt
sleep 3
curl -s "http://localhost:3099/api/search?q=hello" | grep -o '"filename":"hello.txt"'
```

Expected: the `grep` finds a match, confirming the watcher indexed the new file without a manual rescan. Stop the server (`Ctrl-C`) and confirm it exits cleanly (no hang, no unhandled rejection printed). Clean up: `rm -rf /tmp/filenet-watcher-smoke`.

- [ ] **Step 10: Run lint and format checks**

Run: `bun run lint`
Expected: no errors

Run: `bunx prettier --check server/watcher.ts server/management.ts server/index.ts server/__tests__/watcher.test.ts server/__tests__/management.test.ts server/__tests__/indexer.test.ts`
Expected: no formatting issues (if any are reported, run `bun run format` and re-check)

- [ ] **Step 11: Update the TODO**

In `TODO.md`, check off the filesystem watcher line (currently line 45):

```markdown
- [x] Filesystem watcher (inotify/FSEvents/ReadDirectoryChangesW via `fs.watch`) to detect changes reactively instead of relying on the periodic poll — recursive watching isn't reliable on Linux (inotify has no native recursive mode, so subdirectories would need to be watched individually and re-added as new ones appear), needs debouncing, and still needs an initial full scan on first configure; periodic/manual scanning should stay as a fallback safety net rather than being fully replaced
```

- [ ] **Step 12: Update the CHANGELOG**

Add an entry under the `[Unreleased]` section of `CHANGELOG.md` (check the file's existing heading structure — e.g. an `### Added` subsection under `[Unreleased]`) noting: reactive filesystem watching for shared folders (chokidar-based), indexing changes within seconds instead of waiting for the periodic rescan; periodic/manual rescanning is unchanged and still runs as a fallback.

- [ ] **Step 13: Commit**

```bash
git add server/management.ts server/index.ts server/__tests__/management.test.ts TODO.md CHANGELOG.md
git commit -m "feat: wire the file watcher into the running app and settings updates"
```
