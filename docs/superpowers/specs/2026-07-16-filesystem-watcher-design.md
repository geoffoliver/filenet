# Filesystem Watcher — Design

## Goal

From the TODO: "Filesystem watcher (inotify/FSEvents/ReadDirectoryChangesW
via `fs.watch`) to detect changes reactively instead of relying on the
periodic poll... periodic/manual scanning should stay as a fallback safety
net rather than being fully replaced." Give shared-folder changes (new
file, edited file, deleted file) near-instant visibility in the index,
instead of waiting for the next periodic rescan tick or a manual "Force
rescan" click.

## Current state

- `server/indexer.ts` already has everything a reactive layer needs to
  reuse rather than reinvent:
  - `indexFile(db, path, lastSeenAt?)` — hashes a single file (with a fast
    path that skips re-hashing when size+mtime match an existing row),
    extracts metadata, and upserts it into `sharedFiles`. Used internally
    by `scanAndIndex`, and exactly what an add/change handler needs.
  - `scanDirectory(dir, ...)` — the full-tree walker. Skips symlinks
    (`s.isSymbolicLink()`) and dotfiles (`entry.startsWith('.')`).
  - `removeStaleEntries(db, scanStart, protectedRoots)` — used by full
    scans; not reused directly by the watcher (see "Deletes" below).
  - `startPeriodicRescan(db, getFolders, getIntervalMinutes)` — the
    existing polling loop. Untouched by this design; keeps running exactly
    as it does today, as the fallback safety net the TODO calls for.
- `server/index.ts` wires up `startPeriodicRescan` and `startReconnectLoop`
  at boot, both returning a `stop()` cleanup function collected into a
  single `shutdown()` handler for `SIGTERM`/`SIGINT`.
- `server/management.ts`'s `PATCH /api/settings` handler already calls
  `scanAndIndex(db, parseSharedFolders(updated.sharedFolders))`
  immediately whenever `sharedFolders` is part of the patch — i.e.
  whenever the user (re)configures shared folders via Settings or the
  setup wizard (`server/management.ts:319-328`).
- No filesystem-watching dependency exists in `package.json` yet.

## Scope

**In scope:** a reactive watcher that indexes new/changed files and
removes deleted ones shortly after they happen, for all currently
configured shared folders, staying in sync as folders are added/removed
via Settings — without an app restart.

**Explicitly out of scope:**

- Replacing the periodic/manual scan. Both keep running unchanged; the
  watcher is purely additive, per the TODO's own framing.
- Any new Settings field or UI. The watcher is always on, with no toggle —
  there's no scenario in this single-user, self-hosted app where reactive
  indexing should be user-disabled while the app is running.
- A configurable delete grace period. It's a fixed internal constant (see
  "Deletes" below), not exposed as a setting — it exists purely to absorb
  transient blips (e.g. a flaky network mount), not as a tunable.

## Architecture

A new `server/watcher.ts` module, following the same "start function
returns a stop function" shape as `startPeriodicRescan`:

```ts
export interface FileWatcherHandle {
  stop: () => void;
  syncFolders: (folders: string[]) => void;
}

export function startFileWatcher(
  db: Db,
  folders: string[],
  deleteGraceMs: number = DEFAULT_DELETE_GRACE_MS,
): FileWatcherHandle;
```

Unlike `startPeriodicRescan`, this isn't a polling loop reading
`getFolders()` on a timer — it's push-based, so there's no natural "tick"
to re-read settings on. Instead, the caller explicitly calls
`syncFolders(folders)` whenever the configured folder list changes (see
"Live reconfiguration" below).

Internally, `startFileWatcher` creates one `chokidar.FSWatcher` (new
dependency: `chokidar`) watching all `folders` recursively, configured to
match `scanDirectory`'s existing exclusions exactly so the watcher and the
periodic scan never disagree about what's indexable:

- `ignoreInitial: true` — chokidar's own startup walk would otherwise
  re-report every existing file as `add`, duplicating the scan that
  already runs on boot (`startPeriodicRescan`'s immediate first tick) and
  on folder reconfiguration. The watcher only reacts to changes that
  happen _after_ it's attached.
- `followSymlinks: false` — matches `scanDirectory`'s `isSymbolicLink()`
  skip.
- `ignored: /(^|[/\\])\../` — matches `scanDirectory`'s
  `entry.startsWith('.')` skip (dotfiles/dot-directories anywhere in the
  path).
- `awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }` —
  chokidar's built-in debounce: waits until a file's size stops changing
  for 2s before emitting `add`/`change`. This is what keeps a large file
  copy from being hashed mid-write, and replaces any need for a hand-rolled
  debounce timer.

### Add / change

Both events call `indexFile(db, path)` directly, with two guards to match
`scanDirectory`'s existing per-file behavior exactly:

- Before calling `indexFile`, `lstat` the path and skip silently if
  `isSymbolicLink()` — chokidar's `followSymlinks: false` stops it from
  _traversing into_ a symlinked directory, but it still emits `add` for a
  symlink entry itself. `scanDirectory` never yields symlinks at all, so
  without this check the watcher would repeatedly try to index one and
  fail (see below), where the full scan silently skips it once. This
  keeps both paths in agreement: symlinks are never indexed, and never
  logged as errors.
- The `indexFile` call itself is wrapped in a try/catch mirroring
  `scanAndIndex`'s per-file handling (`server/indexer.ts:212-224`): an
  `ENOENT` (file vanished between the event firing and the read — e.g.
  deleted immediately after being written) is swallowed, anything else is
  logged via `console.error` rather than thrown, so one bad event can't
  take down the watcher.

No other new logic is needed — `indexFile` already upserts and already
has the fast path for unchanged files.

### Deletes

On `unlink`, the watcher does **not** delete the row immediately. It
schedules a check after `deleteGraceMs` (default: `30_000`, i.e. 30s):

- A `Map<string, ReturnType<typeof setTimeout>>` tracks one pending-delete
  timer per path.
- If `add`/`change` fires for the same path before the timer fires (file
  came back), the pending timer is cancelled — no DB change.
- When the timer fires, it re-checks with `lstat` whether the file still
  doesn't exist (belt-and-suspenders against event-ordering races, in
  addition to the cancellation above) and, if so, deletes the row.

This needs one small addition to `server/indexer.ts`:

```ts
export async function removeIndexedFile(db: Db, path: string): Promise<void> {
  db.delete(sharedFiles).where(eq(sharedFiles.path, path)).run();
}
```

`removeStaleEntries` (bulk, scan-timestamp-based) isn't reused here — it's
designed for "everything not seen in this full scan," which doesn't fit a
single-path delete.

### Live reconfiguration

`server/index.ts` passes the watcher handle's `syncFolders` into the same
code path in `management.ts` that already triggers an immediate scan on
reconfigure (`server/management.ts:319-328`), right alongside the
`scanAndIndex` call. `syncFolders(folders)` diffs the new list against
what chokidar currently has watched and calls `.add()`/`.unwatch()` for
the difference — no watcher restart, no app restart.

## Integration points

- `server/index.ts`: call `startFileWatcher(db, parseSharedFolders(startupSettings.sharedFolders))`
  alongside `startPeriodicRescan`/`startReconnectLoop`; collect its
  `stop()` into the existing `shutdown()` function.
- `server/management.ts`: the `PATCH /api/settings` handler gets a
  reference to the watcher handle (passed into `createUiServer`'s deps,
  same way `db`/`connectPeer`/`updater` already are) and calls
  `watcher.syncFolders(parseSharedFolders(updated.sharedFolders))` right
  after the existing `scanAndIndex` call.

## Error handling

- A watched folder becoming inaccessible (unmounted drive, permissions
  revoked mid-session): chokidar emits an `error` event on the watcher.
  Logged via `console.error` (matching the convention in
  `startPeriodicRescan`'s catch blocks) — the watcher keeps running for
  the other folders. Actual stale-row cleanup for a gone folder is left to
  the existing `removeStaleEntries` path in the periodic/manual scan; the
  watcher doesn't duplicate that logic.
- One bad folder at `startFileWatcher`/`syncFolders` time (bad path, no
  permission) is added independently of the others — a failure adding one
  folder is logged and skipped, not thrown, so it can't prevent watching
  the rest.
- Consistent with the TODO's own framing: anything the watcher can't
  handle cleanly just falls through to the periodic/manual scan on its
  next run, which is the safety net.

## Testing

Following this project's TDD convention and the existing real-temp-dir
style already used in `server/__tests__/indexer.test.ts` (no mocking the
filesystem):

- Add a file to a watched temp dir → assert a row appears in `sharedFiles`
  within a short wait.
- Modify a file → assert the row's `sha256` changes.
- Delete a file → assert the row is **not** removed immediately, and
  **is** removed once the grace period elapses. `deleteGraceMs` is a
  constructor parameter specifically so tests can pass a short value
  (e.g. `50`) instead of waiting out the real 30s default.
- Delete then recreate a file within the grace period → assert the row
  survives untouched (the pending-delete timer gets cancelled).
- Call `syncFolders` with a folder added → assert a new file dropped into
  that folder gets indexed. Call it again with that folder removed →
  assert a subsequent change there is _not_ picked up.
- Create a symlink inside a watched dir → assert no row is created for it
  and no error is logged.
- One risk-reduction step before writing the above: a small standalone
  smoke test confirming chokidar's `add`/`change`/`unlink` events fire
  correctly under Bun's runtime (it's a new dependency from the
  Node-ecosystem, not yet used anywhere in this codebase). If it doesn't
  behave as expected under Bun, that's a blocking finding to resolve
  before building the rest of this design on top of it.
