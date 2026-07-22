# Consolidate Search-Results Download Polling — Design

## Context

TODO.md flags a pre-existing pattern in the search results table:

> Search results: consolidate per-row download polling — each `ResultRow` runs its
> own independent `getTransfers()` poll every 2s while its download is active, so
> bulk-downloading N files fires N concurrent identical `GET /api/transfers` requests
> every 2s. Flagged by Copilot review on PR #39.

`ResultRow.tsx` (`app/(shell)/search/ResultRow.tsx`) currently owns all download
state locally: `starting`, `downloadId`, `downloadState`, `downloadProgress`,
`downloadError`, plus a `useEffect` that runs its own `setTimeout`-based poll loop
calling `getTransfers()` every 2s while its own download is active, matching the
result by `transfer.id === downloadId`.

`SearchView.tsx` currently only reaches into each row via a ref-based trigger
registry (`downloadTriggers`, `registerDownloadTrigger`/`onRegisterDownload`) so the
"Download All" bulk action can invoke each selected row's private `beginDownload`.

This is a frontend-only refactor with no backend/API changes.

## Goals

- One shared `GET /api/transfers` poll for the whole search results table, not one
  per actively-downloading row.
- No behavior change visible to the user: same button labels (`Download` /
  `Starting…` / `Queued` / `NN%` / `Done ✓` / `Failed` / `Cancelled`), same disabled
  logic, same inline error text, same retry-after-failure affordance.
- Simplify `SearchView` → `ResultRow` communication in the process: the existing
  `downloadTriggers` ref/registration indirection becomes unnecessary once
  `SearchView` owns download state directly, and is removed.

## Non-goals

- No app-wide polling consolidation (e.g. a shared hook/context used by Home,
  Transfers, and Search alike). TODO.md itself notes this isn't a real problem at
  this app's scale (self-hosted, single user) — scope stays limited to the search
  results table per the TODO item.
- No change to the `/api/transfers` endpoint or poll cadence (stays 2s).

## Design

### State ownership moves to `SearchView`

`ResultRow` becomes presentational: it renders from a `download` prop and calls
`onStartDownload(hit)` on click. It no longer imports `getTransfers`/`startDownload`
and has no internal `useState`/`useEffect` for download tracking.

`SearchView` gains:

```ts
downloads: Map<string, RowDownload>; // keyed by sha256
```

`RowDownload` (new type, added to `app/lib/searchResults.ts` next to `SearchHit`,
since that module is already the shared home for search-page types/utils):

```ts
export type RowDownload = {
  starting: boolean;
  id: string | null;
  state: TransferState | null;
  progress: number;
  error: string;
};
```

`TRANSFER_TERMINAL_STATES` (currently a private `TERMINAL_STATES` const in
`ResultRow.tsx`) moves to `app/lib/api.ts`, exported, next to the `TransferState`/
`Transfer` type definitions — both `SearchView` (polling gate) and the terminal-state
checks need it now.

### Starting a download

`SearchView.startRowDownload(hit: SearchHit)` replaces `ResultRow`'s
`beginDownload`:

1. Re-derive the same busy/disabled check `beginDownload` used to do internally
   (`starting || (id set && state not FAILED/CANCELLED) || no direct sources`),
   read synchronously off current `downloads` state. Bail out if busy — this is the
   direct replacement for the old `if (disabled) return;` guard, now needed because
   the click handler lives one level up from the button's own `disabled` attribute.
2. Set `downloads.set(sha256, { starting: true, id: null, state: null, progress: 0,
error: '' })` (fresh entry — matches `beginDownload`'s reset-on-retry behavior).
3. Call `startDownload(...)` (unchanged params/signature).
   - On success: store `id` + `state: 'PENDING'`.
   - On failure: store `error: err.message`.
   - `finally`: clear `starting`.

`handleDownloadAll` simplifies to iterating `selected` and calling
`startRowDownload(hit)` directly (looking `hit` up from `hits` by `sha256`). The
`downloadTriggers` ref, `registerDownloadTrigger` callback, and
`onRegisterDownload` prop are deleted — no longer needed now that `SearchView` can
just call its own function.

### The shared poll

A single `useEffect` in `SearchView`:

- Runs only while at least one row is "active" — has an `id` and a `state` that
  isn't in `TRANSFER_TERMINAL_STATES` (mirrors the old per-row gate:
  `if (!downloadId || (downloadState && TERMINAL_STATES.has(downloadState))) return;`).
- Depends on a single derived boolean (`anyActive`, computed at render time from
  `downloads`), not on `downloads` itself — so the effect doesn't tear down and
  restart on every progress tick, only when polling needs to start or can stop
  entirely.
- Each tick: `getTransfers()`, index results by `id` (**by transfer id, not
  sha256** — see rationale below), then update only the rows whose `state`/`progress`
  actually changed, via a functional `setDownloads` update (reads `prev` — the effect
  itself has no dependency on the live `downloads` value).
- A failed tick is swallowed and retried next tick (matches today's per-row
  `catch {}` behavior).
- Uses the same `cancelled` + `setTimeout` teardown pattern the old per-row effect
  used (not the `mountedRef`-driven `while` loop `TransfersView.tsx` uses elsewhere —
  that pattern polls unconditionally for the component's whole lifetime, which is
  wrong here since polling must stop when nothing is active).

**Why key by transfer `id`, not `sha256`, despite the TODO saying "fanned out by
sha256":** a `sha256` isn't a unique key for transfers — cancel-and-retry (or
downloading the same file twice) can leave a stale terminal transfer row sharing a
`sha256` with a fresh active one. Keying by `id` reproduces today's exact matching
logic (`transfers.find(t => t.id === downloadId)`) with zero semantic change; only
the fetch is centralized. The `downloads` map itself is still keyed by `sha256`
(that's the table's natural row key, and hits are already deduplicated by `sha256`
upstream in `mergeResults`), so "fanned out by sha256" is preserved at the
row-lookup level — just not as the poll's matching key.

### `ResultRow` after the change

Pure presentational component:

```ts
{
  hit: SearchHit;
  selected: boolean;
  onToggleSelect: (sha256: string) => void;
  onOpenInfo: (hit: SearchHit) => void;
  download: RowDownload | undefined;
  onStartDownload: (hit: SearchHit) => void;
}
```

`disabled` and `label` are computed the same way as today, just reading
`download?.starting`, `download?.id`, `download?.state`, `download?.progress`,
`download?.error` (defaulted) instead of local state.

## Error handling

Unchanged from today: a failed `startDownload()` POST surfaces a per-row error
string next to the button; a failed poll tick is silently retried next cycle rather
than surfaced as an error (avoids flashing a spurious error on a single dropped
request). No new error states introduced.

## Testing

Existing Playwright coverage (`e2e/search.spec.ts`) should keep passing unmodified:

- `download button shows progress while downloading`
- `download button shows Done after completion`
- `Download All fires a download for every selected row`

New test: start two simultaneous downloads (two rows, both mocked as
`DOWNLOADING`) and assert the `GET /api/transfers` request count stays low across
~2 poll cycles (e.g. `≤ 3` over ~4.5s) rather than growing with the number of active
rows — this is the regression test that actually proves consolidation happened,
since the existing single-row tests wouldn't catch a regression back to per-row
polling.

No backend/Jest changes — `/api/transfers` itself is untouched.

## Code impact

- `app/lib/api.ts`: export `TRANSFER_TERMINAL_STATES` (moved from `ResultRow.tsx`).
- `app/lib/searchResults.ts`: add `RowDownload` type.
- `app/(shell)/search/SearchView.tsx`: add `downloads` state, `startRowDownload`,
  the shared poll effect; simplify `handleDownloadAll`; remove `downloadTriggers`/
  `registerDownloadTrigger`.
- `app/(shell)/search/ResultRow.tsx`: remove all local download state/effects;
  become presentational, driven by `download`/`onStartDownload` props.
- `e2e/search.spec.ts`: add the multi-row polling regression test.

## Workflow

- Built on a feature branch (`feature/consolidate-download-polling`), per project
  convention (feature branch → PR → Copilot review → merge).
- Update `CHANGELOG.md`'s `[Unreleased]` section.
- Check off the corresponding TODO.md item.
