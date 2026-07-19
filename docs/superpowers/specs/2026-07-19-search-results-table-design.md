# Search Results Table — Design

## Context

TODO.md's "Improve search results UI" asked for two things:

1. A sortable table of results (filename, filetype, filesize, total sources, etc.)
2. Individual per-item download plus multi-select + bulk download.

The current implementation (`app/(shell)/search/SearchView.tsx`) renders results as a
list of collapsible cards (`MetaDetail`): clicking a card expands it to reveal metadata,
a hash preview, an "on this node" badge, and the download button with live progress
polling. There's no sorting and no multi-select.

## Goals

- Sortable table layout, modeled on the classic Napster file-list UI.
- Core columns always present regardless of file type mix; a single "smart" column
  surfaces the most relevant type-specific detail (duration / dimensions / page count).
- Per-row download (unchanged behavior/polling) always visible, not gated behind expand.
- Checkbox-based multi-select with a bulk "Download All" action.
- Full metadata (everything currently in `MetaDetail`'s detail rows) moves to a
  slide-in info drawer, opened via a per-row info icon.

## Non-goals

- No backend/API changes. `searchFiles`, `startDownload`, `getTransfers` are unchanged.
- No pagination/virtualization — out of scope unless result volume becomes a problem.
- No persistence of sort/selection across navigation — state resets on new search
  (matches current no-persistence behavior for expand state).

## Table columns

| ☐   | Name | Type | Size | Sources | Details | (download) | (info) |
| --- | ---- | ---- | ---- | ------- | ------- | ---------- | ------ |

- **☐** — row checkbox; disabled when the row has zero direct sources (same condition
  that currently disables the Download button — relayed-only results with no direct
  WebSocket connection). Header checkbox selects/clears all currently selectable rows.
- **Name** — file-type icon (existing `mimeIcon`) + filename; an inline "on this node"
  badge when `hit.local` is true (replaces the badge currently shown only in the
  expanded detail).
- **Type** — mime subtype, e.g. `mp3`, `pdf` (existing `hit.mimeType.split('/')[1]` logic).
- **Size** — `formatBytes(hit.size)`.
- **Sources** — `(hit.local ? 1 : 0) + hit.networkSources.length`.
- **Details** — smart column, computed from parsed metadata + mime type:
  - audio/video → formatted duration (`formatDuration`), if present
  - image → `${width}×${height}`, if present
  - document/ebook → page count, if present in metadata
  - otherwise → `—`
- **Download** — same button/state machine as today (`starting` → `Queued` →
  `X%` → `Done ✓` / `Failed` / `Cancelled`), just rendered directly in the row instead
  of inside an expanded card. Each row owns its own polling state exactly as
  `MetaDetail` does today (lifted as-is into a new `ResultRow` component).
- **Info** — ℹ️ icon button; opens the info drawer for that row.

## Sorting

- Sortable columns: Name, Type, Size, Sources.
- Clicking a header sorts by that column; clicking the active column's header again
  flips direction.
- Default direction when switching to a new column: ascending for Name/Type (text),
  descending for Size/Sources (numeric).
- Initial sort on a fresh result set: **Sources, descending**.
- Sort state lives in `SearchView` (`{ column, direction }`), applied to `hits` before
  render. Not persisted in the URL — resets per search, consistent with current
  no-persistence behavior for other UI state (expand, selection).

## Selection & bulk download

- Selection state: `Set<string>` of `sha256`, lifted to `SearchView`.
- Selecting survives re-sorting (keyed by `sha256`, not row index).
- When `selection.size > 0`, a toolbar appears above the table:
  `"N selected · Download All · Clear"`.
- "Download All" iterates the selected rows and calls `startDownload` for each
  (identical per-row logic/direct-sources filter as the existing single-row download),
  then clears the selection. No new batch-tracking state — each row's existing
  polling effect picks up its own transfer once `downloadId` is set.
- Rows with zero direct sources can't be checked in the first place, so bulk download
  never needs to skip/report skipped items.

## Info drawer

- New component, e.g. `app/(shell)/search/ResultInfoDrawer.tsx`.
- Slides in from the right edge; table content stays visible/dimmed underneath.
- Contents: everything currently in `MetaDetail`'s `detailMeta` block — hash (full,
  not truncated, since there's room), title/artist/album/year/track/genre/duration/
  bitrate/dimensions — minus the download button/area, which no longer lives here.
- Dismissal: X button, `Escape` key, or backdrop click. Same dialog contract as the
  existing "New Group Chat" modal in `ChatView.tsx` (`role="dialog"`, `aria-modal="true"`,
  `Escape` listener) adapted to a slide-in instead of centered position.

## Code impact

- `app/(shell)/search/SearchView.tsx`:
  - Replace the `<ul>` card list with a `<table>`.
  - Extract `ResultRow` (owns download-polling state, currently in `MetaDetail`) and
    `ResultInfoDrawer` (new) as separate components/files alongside `SearchView.tsx`.
  - Add sort state + a small header-cell component that renders sort direction
    indicators and handles click-to-sort/click-to-flip.
  - Add selection state + the bulk-action toolbar.
  - Remove `expandedSha`/`toggleExpand`/`MetaDetail` (superseded by the row + drawer).
- `app/(shell)/search/search.module.css`: replace `.results`/`.result`/`.resultMain`/
  `.detail*` styles with table, row, toolbar, and drawer styles.
- No changes to `app/lib/api.ts` or the server.

## Workflow

- Build on a feature branch (not directly on `master`) so the change goes through a
  Copilot PR review before merging, per project convention.
- Update `CHANGELOG.md`'s `[Unreleased]` section per project convention.
- After the UI change lands, retake the GitHub Pages doc screenshots for the Search
  view (`site/screenshots/search-light.png` and `search-dark.png`) so the docs site
  reflects the new table UI, and update `site/docs.html` if any surrounding copy
  describes the old card layout.

## Testing

- Update existing Playwright search tests (`e2e/search.spec.ts`) for the new table
  markup/selectors.
- Add new Playwright coverage:
  - Header click sorts ascending; second click flips to descending; clicking a
    different header switches columns with the correct default direction.
  - Selecting 2+ rows shows the toolbar with the right count; "Download All" fires
    one `startDownload` call per selected row (mock `page.route()` as today); "Clear"
    empties the selection and hides the toolbar.
  - Row checkbox is disabled/unselectable when a result has zero direct sources.
  - Info icon opens the drawer with the row's metadata; closes via X, Escape, and
    backdrop click.
