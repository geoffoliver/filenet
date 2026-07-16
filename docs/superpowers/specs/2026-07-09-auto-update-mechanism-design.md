# Auto-Update Mechanism — Design

## Goal

From the TODO: "Auto-update mechanism (detect new release on Github
(configurable repo URL in case someone wants to fork it), download, prompt
user to restart)." Give standalone-binary users a way to learn a new
version exists, have it downloaded and verified in the background, and
apply it with a single click — without needing a terminal, a service
manager, or Docker. This is also the blocked-on dependency for the
"when updates are ready to install" notification sub-item in the
Notifications TODO, which reuses this feature's status as its trigger.

## Current state

- The app ships two ways (see `README.md`): Docker (`docker compose up -d`,
  builds/runs from source inside the container) and a standalone
  `bun build --compile` executable for 5 targets (`linux-x64`,
  `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`), built by
  `scripts/build-binaries.sh` and published via `.github/workflows/release.yml`
  (`gh release create` with `dist/*.tar.gz`/`dist/*.zip` attached, tagged
  `v#.#.#`).
- `server/runtime-paths.ts`'s `resolveAssetPath()` already distinguishes
  "running from source" (dev, Docker) vs. "running as a compiled binary"
  by checking whether the source-relative asset path exists on disk. This
  is the same distinction the updater needs (only binary mode can
  self-update), so it's reused rather than reinvented.
- `server/config.ts` / `server/schema.ts` hold the `Settings` singleton row
  (Drizzle/SQLite) and the `SettingsPatch` type consumed by
  `PATCH /api/settings`. New settings fields follow this existing pattern
  (e.g. `rescanIntervalMinutes`).
- `app/lib/notifications.ts` provides `getNotificationPermission()`,
  `requestNotificationPermission()`, `showDesktopNotification()`.
  `app/hooks/useFriendRequestNotifications.ts` is the reference pattern for
  a polling hook that desktop-notifies once per new item (localStorage-deduped)
  with an in-app toast (`app/components/Toast/ToastProvider.tsx`) fallback.
  This feature follows the same pattern for "a new version is ready."
- `build-binaries.sh` currently zips only the Windows target and tars the
  rest. `NODE_ENV=production` is baked into the compiled binary via
  `bun build --compile --define`, since `bun build --compile` doesn't set
  it at runtime on its own — the same mechanism is reused to bake in
  `APP_VERSION`.
- No update-checking, download, or self-relaunch code exists anywhere in
  the codebase today.

## Scope

**In scope:** standalone-binary users get automatic checks, background
download + checksum verification, a Settings UI to review/trigger it, and
a one-click self-relaunch onto the new version.

**Explicitly out of scope:**

- Actually updating a Docker deployment. The app cannot replace its own
  container image from inside the container. In `mode: 'source'` (which
  covers both Docker and `bun run server` dev usage) the feature only
  _reports_ that a newer version exists; Settings shows a static pointer
  to `docker compose pull` instead of download/restart controls.
- Download progress (bytes/percent). Status is coarse
  (`checking`/`downloading`/`ready`/`error`) — release archives are tens
  of MB and this isn't a transfer the user needs to babysit the way P2P
  downloads are. Matches YAGNI; can be added later if it turns out to
  matter.
- Persisting update state across a server restart. If the process restarts
  mid-download or after staging but before the user clicks restart, it
  just re-checks and re-stages on next boot (see "State" below).
- Rollback / "undo an update" — the old binary is kept as `.old` only
  transiently during the swap (see Apply step) for crash-safety, not as a
  user-facing rollback feature.
- Any change to how Docker itself is updated/versioned (e.g. publishing a
  registry image) — unrelated to this TODO item.

## Architecture

### Runtime mode gate

Everything below only runs when `resolveAssetPath`'s binary-detection says
we're a compiled executable. In source mode (`bun run server`, Docker), the
update subsystem still answers `GET /api/update-status` (so the UI can show
current-vs-latest version as useful info) but reports `mode: 'source'` and
never downloads or stages anything.

### Version check

`server/updater.ts` exports `checkForUpdate(repo: string, currentVersion: string)`:

- `GET https://api.github.com/repos/{repo}/releases/latest`
- Compare `tag_name` (leading `v` stripped) against `currentVersion` via
  semver. Returns `{ version, notesUrl, assets }` if strictly newer, else
  `null`.
- `currentVersion` comes from `APP_VERSION`, baked into the binary at
  compile time the same way `NODE_ENV` is today (new `--define` in
  `build-binaries.sh`, sourced from `package.json`'s version, which is
  already bumped by `cut-release.ts` earlier in the release workflow). In
  source mode, read `package.json` directly instead (no bake step there).

### Download, verify, stage

`downloadAndStage(release)`:

- Map `process.platform`/`process.arch` to the matching `bun-<os>-<arch>`
  target name (same mapping `build-binaries.sh`'s `TARGETS` array encodes)
  to pick the right asset off the release.
- Download `filenet-<target>.zip` and `SHA256SUMS.txt` into
  `<installDir>/.filenet-update/<version>/`.
- Verify the downloaded zip's SHA-256 against its line in
  `SHA256SUMS.txt`. Mismatch → `phase: 'error'`, staged files discarded.
- Extract the zip in place using a pure-JS zip library bundled into the
  app (no shelling out to system `tar`/`unzip`/`Expand-Archive` — those
  aren't guaranteed present, especially on minimal Windows installs). This
  requires standardizing release packaging on `.zip` for all 5 targets
  (see "Release workflow changes" below), so extraction is one code path
  instead of two.
- A stale `.filenet-update/<oldVersion>/` staging dir from a previous
  check (superseded before the user restarted) is removed once a newer
  one is confirmed and staged.

### State

In-memory only, inside `server/updater.ts` — not persisted to the DB.
Rationale: this state describes what _this running process_ has already
done (checked, downloaded, verified); if the process restarts before the
user acts on it, re-checking and re-staging on next boot is cheap and
correct, and avoids a new table/columns for something transient.

```ts
type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
type UpdateState = {
  mode: 'binary' | 'source';
  currentVersion: string;
  phase: UpdatePhase;
  latestVersion?: string;
  releaseNotesUrl?: string;
  stagingDir?: string; // set once phase === 'ready'
  error?: string;
  lastCheckedAt?: string;
};
```

### Apply (self-relaunch)

Triggered only when `phase === 'ready'` and `mode === 'binary'`, via
`POST /api/update-restart`:

1. Current process spawns the **staged new binary** (not itself) with
   argv `--finish-update <ownPid> <stagingDir> <installDir>`, detached, then
   exits.
2. That child (already the new version) polls for the old PID to
   disappear (`process.kill(oldPid, 0)` throwing `ESRCH`) — this is what
   makes the swap safe on Windows, where the old executable's file is
   locked until its process fully exits.
3. Once the old process is gone, it renames the live
   `filenet`/`filenet.exe`, `out/`, and `drizzle/migrations` to `.old`
   siblings, moves the staged versions into their place, deletes the
   `.old` siblings, then re-execs itself **without** the `--finish-update`
   flag (`Bun.spawn` + exit) to become the normal running app.
4. If the swap fails partway (e.g. permission error moving `out/`), the
   `.old` siblings are left in place rather than deleted, so the app isn't
   left in a half-updated state — worst case a human restores from
   `.old` manually. This is a deliberately simple crash-safety measure,
   not a full transactional guarantee.

This embeds the "helper" logic in the app's own compiled binary (just a
different argv path) rather than writing out a separate shell/batch
script, which avoids needing bash on Windows (the project already avoids
that assumption elsewhere — `build-binaries.sh` itself requires WSL/Git
Bash on Windows, but that's a _build-time_ tool constraint, not something
we can push onto every end user's machine at _runtime_).

### Management API (`server/management.ts`)

- `GET /api/update-status` → current `UpdateState` (serialized)
- `POST /api/update-check` → runs `checkForUpdate` (+ `downloadAndStage` if
  newer) immediately, regardless of the periodic interval; returns the
  resulting state. Manual "Check for updates" button.
- `POST /api/update-restart` → begins the Apply flow above. Returns `409`
  if `phase !== 'ready'` or `mode !== 'binary'`.

### Settings additions

New `Settings` fields (Drizzle migration), following the existing
`rescanIntervalMinutes` pattern:

- `updateRepo` (text, default `'geoffoliver/filenet'`) — `owner/repo`
  shorthand, editable so forks can point at their own repo.
- `updateCheckIntervalMinutes` (integer, default `1440`) — `0` disables
  periodic checks; the manual button still works regardless.

### Scheduling

`server/index.ts` starts a periodic loop (same shape as
`startPeriodicRescan`): a check runs immediately on boot whenever
`updateCheckIntervalMinutes` is enabled (non-zero), in both binary and
source mode, then again every `updateCheckIntervalMinutes` thereafter. Only
the download/stage step is binary-mode-only — in source mode, `checkNow()`
stops at `phase: 'available'` without ever downloading or staging. If the
interval is `0` (disabled), no check runs on boot or on a timer; the manual
button still works regardless. Failures (network, GitHub rate-limit) are
silent and retried next tick — matches every other polling loop in this
codebase.

## Client-side UI

- `app/hooks/useUpdateNotifications.ts` — polls `GET /api/update-status`
  (interval matches the friend-request hook's pattern: a short, fixed
  client poll, independent of the server's own check interval — the
  client is just observing state, not triggering checks). Fires
  `showDesktopNotification` with toast fallback exactly once per distinct
  `latestVersion` reaching `phase: 'ready'`, deduped via a
  `localStorage` key (`filenet:notifiedUpdateVersions`), same shape as
  `filenet:notifiedFriendRequestIds`.
- Mounted once in `app/(shell)/layout.tsx`, alongside the existing
  friend-request hook. No nav badge — unlike a friend request, an update
  isn't actionable from arbitrary pages, and Settings is a fine, single,
  discoverable destination for it.
- `app/(shell)/settings/page.tsx` — new "Updates" section:
  - Current version, last-checked time, phase, rendered as text (`Up to
date` / `Checking…` / `Downloading…` / `Update ready: vX.Y.Z` / `Error: …`).
  - `updateRepo` field (validated client-side as `owner/repo` shape).
  - `updateCheckIntervalMinutes` field (same control as the rescan interval).
  - **Check for updates** button → `POST /api/update-check`.
  - **Restart to update vX.Y.Z** button, shown only when `phase ===
'ready'` and `mode === 'binary'` → confirmation dialog (explains this
    briefly takes the app offline) → `POST /api/update-restart`.
  - In `mode: 'source'`: buttons replaced with static text — _"Running
    from source — update by pulling the latest image or code."_ Version
    info still shown.

## Release workflow changes

- `scripts/build-binaries.sh`: zip all 5 targets instead of tar-ing 4 and
  zipping 1 — one packaging code path, and the runtime updater only needs
  one extraction code path (pure-JS zip, no `tar`/`unzip` dependency).
  Existing already-published `v0.1.1` assets are untouched; this only
  affects releases cut after this change ships.
- `.github/workflows/release.yml`: after `bun run build:binaries`, add
  `sha256sum dist/filenet-*.zip > dist/SHA256SUMS.txt` and include it in
  the `gh release create` file list. Verified by the updater before any
  downloaded archive is extracted or applied — protects against a
  corrupted/truncated download producing a broken swap, which matters
  more here than for a normal file download since the result briefly
  replaces the running executable.
- New `--define` in the compile step bakes `APP_VERSION` from
  `package.json` into the binary, same mechanism as the existing
  `NODE_ENV=production` bake.
- `README.md`: "Running as a standalone executable" section updated to
  say `.zip` for every platform, and a short new note that the app checks
  for and can self-apply updates (with a pointer to the Settings "Updates"
  section and the `updateRepo` setting for forks).

## Error handling

- Network failure / GitHub rate-limit during a check: silent, retried on
  the next scheduled tick — matches the rescan/reconnect loop convention.
  A manual "Check for updates" click surfaces the error in the Settings
  UI immediately (it's a direct user action, not a background tick), via
  `phase: 'error'` + `error` message.
- Checksum mismatch: `phase: 'error'`, staged files (if partially written)
  are deleted, nothing is applied.
- Install directory not writable (staging or swap step): `phase: 'error'`
  surfaced in Settings; the running app is unaffected either way since the
  swap only touches files, never in-memory state, until the very last step.
- `POST /api/update-restart` called when `phase !== 'ready'` or
  `mode !== 'binary'`: `409`, no-op.
- Swap fails partway through Apply: `.old` siblings are preserved (not
  deleted) so a human can recover manually; this is the one failure mode
  that can leave the app not running, since by this point the old process
  has already exited. Documented in the README as the manual-recovery path.

## Testing

- **Backend (`bun:test`, `server/__tests__`)**:
  - `checkForUpdate`: mocked fetch — newer/older/equal/malformed-response
    cases.
  - Checksum verification: matching/mismatched/missing `SHA256SUMS.txt`
    line.
  - Swap logic, run against a temp directory: asserts old files renamed
    and removed, new files land in place; a pre-existing `.old` leftover
    from a previously-failed attempt is handled (overwritten, not fatal).
  - PID-wait loop: mocked `process.kill` to simulate the old process
    exiting after N polls.
  - `GET/POST /api/update-*` route handlers: phase transitions, 409 on
    invalid restart requests.
- **Frontend (Playwright, mocked API, `e2e/`)**:
  - Settings "Updates" section rendering across all phases, including
    `mode: 'source'`.
  - Notification-on-ready fires once per version (dedup), verified via
    the toast fallback path (same limitation as the friend-request spec:
    the real desktop `Notification` API isn't exercised by headless
    Playwright; that path gets manual verification in a real browser
    before calling the feature done).
- The self-relaunch Apply flow (steps 1–4 under "Apply") is inherently
  process-lifecycle behavior that unit tests can only partially cover
  (the swap logic and PID-wait are tested in isolation above) — the full
  end-to-end "click restart, new binary comes up" path is verified
  manually against real compiled binaries for at least Linux and macOS
  before this ships, per this project's UI/feature-verification
  convention. Windows verification is best-effort (no Windows machine
  assumed available); if it can't be verified directly, that gap is
  called out explicitly rather than claimed as tested.
