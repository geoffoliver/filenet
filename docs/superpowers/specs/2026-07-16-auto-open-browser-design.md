# Auto-Open Browser On Start — Design

## Goal

From the TODO: "Auto-open browser on app start (setting, defaults to
true)." When the unified server starts, open the UI in the user's default
browser automatically, so a desktop/laptop user doesn't have to manually
navigate to `http://localhost:<port>` every time they launch the app —
matching the "just double-click and go" experience of apps like
Sonarr/Radarr, which this project's single-binary distribution already
aims to resemble.

## Current state

- `server/index.ts` is the single entrypoint used in every run mode:
  dev/local (`bun run server`), Docker (`docker-entrypoint.sh` runs the
  same `exec bun server/index.ts`), and the compiled binary. It starts two
  `Bun.serve()` listeners — one for the UI+management API (`UI_PORT`,
  default `3000`), one for the P2P protocol (`P2P_PORT`) — and there is no
  existing distinction in this file between "Docker" and "bare metal";
  both are `runtime-paths.ts`'s "source mode".
- `server/config.ts` / `server/schema.ts` hold the `Settings` singleton row
  and the `SettingsPatch` type consumed by `PATCH /api/settings`. New
  settings fields follow the existing pattern (e.g.
  `rescanIntervalMinutes`, `updateCheckIntervalMinutes`).
- `server/updater.ts` establishes the pattern for shelling out to external
  processes in a testable way: functions take an optional `spawnImpl`
  parameter defaulting to `Bun.spawn`, so tests inject a mock instead of
  actually spawning anything.
- `app/(shell)/settings/SettingsView.tsx` is a stack of small
  self-contained `<Section>` components (Profile, Friends & Privacy,
  Files, Networking, Scripts, Maintenance, Updates, Notifications), each
  with its own local state, a `patchSettings()` call, and a `SaveButton`.
  Boolean toggles use a `styles.toggle` checkbox `<label>` (see
  `PrivacySection`'s `autoAcceptFromAnyone` checkbox).
- No process-launching / "open external URL" code exists anywhere in the
  codebase today.

## Scope

**In scope:** a `autoOpenBrowser` setting (default `true`), a
cross-platform best-effort browser launch on every server start when the
setting is on, and a Settings UI toggle to control it.

**Explicitly out of scope:**

- Detecting Docker/headless environments to suppress the attempt. Per
  discussion, the same code path runs everywhere; a failed launch attempt
  (no browser binary available, e.g. minimal Linux container) is caught
  and logged, never thrown. This keeps the feature to one code path and
  avoids an undocumented exception carved out of the setting.
- Opening anything other than the local UI's root URL. No deep-linking to
  `/setup` — the existing first-launch redirect in the frontend already
  handles sending an unconfigured install to `/setup`.
- Re-opening the browser on later events (e.g. after Settings changes the
  listen port, or after an auto-update restart). This only fires once, at
  process start, same as every other startup-time action in
  `server/index.ts`.

## Architecture

### New module: `server/browser-opener.ts`

```ts
export type OpenBrowserOptions = {
  spawnImpl?: typeof Bun.spawn;
  platform?: NodeJS.Platform; // defaults to process.platform
};

export function openBrowser(url: string, opts: OpenBrowserOptions = {}): void;
```

- Maps platform to a command, same three-way switch the project already
  uses for target platforms elsewhere (`updater.ts`'s `targetName`):
  - `darwin` → `open <url>`
  - `win32` → `cmd /c start "" <url>` (the empty `""` title arg is
    required — `start` treats the first quoted argument as a window
    title, not the URL)
  - anything else (`linux`, etc.) → `xdg-open <url>`
- Calls `spawnImpl` (defaults to `Bun.spawn`) wrapped in `try/catch`. Both
  a synchronous throw (command not found on some platforms) and an
  asynchronous spawn failure are handled: the process handle's `exited`
  promise is checked and a non-zero/rejected result is logged the same
  way as a synchronous throw. Every failure path does the same thing —
  `console.warn` with the URL and error, then return. Never throws out of
  `openBrowser`, and never blocks server startup (fire-and-forget, no
  `await` at the call site).
- Deliberately dumb: no retry, no waiting for the UI server to be ready
  before firing (it starts _after_ `Bun.serve` for the UI port has
  already returned, so the listener is already accepting connections by
  the time the browser command runs).

### `server/schema.ts` / migration

New `Settings` column:

- `autoOpenBrowser` (integer/boolean mode, default `true`).

Generated via `bun run db:generate` (Drizzle migration), not hand-written
SQL, matching how every prior `Settings` column was added.

### `server/config.ts`

- Add `autoOpenBrowser?: boolean` to `SettingsPatch`.

### `server/schemas.ts`

- Add `autoOpenBrowser: z.boolean().optional()` to the `PATCH
/api/settings` body schema, alongside `autoAcceptFromAnyone`.

### `server/index.ts`

Immediately after the UI `Bun.serve({ ... })` call returns:

```ts
if (startupSettings.autoOpenBrowser) {
  openBrowser(`http://localhost:${UI_PORT}`);
}
```

Uses the already-fetched `startupSettings` (same object `sharedFolders`
and `listenPort` are read from at boot) rather than re-querying — a
setting changed via the API mid-session doesn't retroactively affect a
launch that already happened, and every other startup-time-only setting
in this file follows the same "read once at boot" convention.

### Settings UI (`app/(shell)/settings/SettingsView.tsx`)

New `StartupSection`, inserted after `NetworkingSection` in the render
list:

```tsx
<Section title="Startup">
  <form className={styles.form} onSubmit={handleSubmit}>
    <label className={styles.toggle}>
      <input type="checkbox" checked={autoOpen} onChange={...} />
      <span>Automatically open the app in your browser on start</span>
    </label>
    ...SaveButton...
  </form>
</Section>
```

Follows the exact local-state/save/error pattern already used by every
other section (see `PrivacySection` for the closest analog: a bare
checkbox + `patchSettings()` + `SaveButton`).

### Frontend types / fixtures

- `app/lib/api.ts`: add `autoOpenBrowser: boolean` to the `Settings` type
  used by the frontend.
- `e2e/helpers.ts`: add `autoOpenBrowser: true` to the mock settings
  fixture used by Playwright tests, matching the DB default.

## Error handling

- `openBrowser` never throws and never rejects the caller — a missing
  browser opener binary (headless Docker, minimal Linux) is indistinguishable
  from any other spawn failure and is handled identically: log a warning,
  move on. Server startup is unaffected either way.
- Invalid/missing setting value: same as every other boolean setting —
  Drizzle's `notNull().default(true)` guarantees the column is always a
  real boolean; no runtime validation needed beyond the existing Zod PATCH
  schema.

## Testing

- **Backend (`bun:test`, `server/__tests__/browser-opener.test.ts`)**:
  - Command mapping for `darwin` (`open`), `win32` (`cmd /c start ""`),
    and a non-darwin/win32 platform (`xdg-open`), asserted via the
    injected `spawnImpl` mock's recorded arguments.
  - A `spawnImpl` that throws synchronously is caught, logged, and does
    not propagate.
  - A `spawnImpl` that resolves with a non-zero exit code is logged and
    does not propagate.
- Extend `server/__tests__/config.test.ts` and `schemas.test.ts` for the
  new `autoOpenBrowser` field (round-trips through `sanitizeSettings` /
  Zod PATCH validation).
- Extend `e2e/settings.spec.ts`: the new Startup toggle renders, can be
  checked/unchecked, and calls `PATCH /api/settings` with the expected
  body (mocked, same pattern as the existing Privacy-section toggle
  test).
- Not unit-testable: whether a real OS actually opens a real browser
  window. This is verified manually (`bun run server` locally on at least
  macOS, since that's the actual dev machine available) before calling
  the feature done, per this project's UI/feature-verification
  convention — same caveat this project's other OS-dependent features
  (auto-update's binary swap, desktop notifications) already carry.
