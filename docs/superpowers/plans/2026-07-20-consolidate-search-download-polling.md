# Consolidate Search-Results Download Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-row `getTransfers()` polling loop in the search results table with a single shared poll owned by `SearchView`, so bulk-downloading N files fires one `GET /api/transfers` request per tick instead of N.

**Architecture:** Move all download state (`starting`/`id`/`state`/`progress`/`error`) from `ResultRow` up into `SearchView`, keyed by `sha256` in a `downloads: Map<string, RowDownload>`. `SearchView` owns one `useEffect` polling loop, gated on whether any row is non-terminal, that fetches `getTransfers()` and indexes results by transfer `id`. `ResultRow` becomes a pure presentational component driven by a `download` prop and an `onStartDownload` callback.

**Tech Stack:** Next.js 16 (client components, `'use client'`), React state/effects, Bun, Playwright for e2e coverage.

## Global Constraints

- No backend/API changes — `/api/transfers` and its 2s-appropriate poll cadence are unchanged.
- No behavior change visible to the user: identical button labels, disabled logic, and error text to today.
- Key the shared transfer lookup by transfer `id`, not `sha256` (a `sha256` isn't a unique key for transfers — see spec's rationale). The `downloads` map itself stays keyed by `sha256` (the table's row key).
- Remove the now-unnecessary `downloadTriggers` ref / `registerDownloadTrigger` / `onRegisterDownload` indirection in `SearchView.tsx` once `SearchView` owns download state directly.
- Spec: `docs/superpowers/specs/2026-07-20-consolidate-search-download-polling-design.md`

---

## Task 1: Shared types and constants

**Files:**

- Modify: `app/lib/api.ts` (add exported `TRANSFER_TERMINAL_STATES` near the existing `TransferState`/`Transfer` types, currently at `app/lib/api.ts:238-261`)
- Modify: `app/lib/searchResults.ts` (add exported `RowDownload` type)

**Interfaces:**

- Produces: `TRANSFER_TERMINAL_STATES: Set<TransferState>` from `app/lib/api.ts`, containing `'COMPLETED' | 'FAILED' | 'CANCELLED'`.
- Produces: `RowDownload` type from `app/lib/searchResults.ts`:
  ```ts
  export type RowDownload = {
    starting: boolean;
    id: string | null;
    state: TransferState | null;
    progress: number;
    error: string;
  };
  ```

This task is purely additive — no existing behavior changes, so there's no new runtime test. Verification is the TypeScript build.

- [ ] **Step 1: Add `TRANSFER_TERMINAL_STATES` to `app/lib/api.ts`**

  Insert right after the `Transfer` type definition (after line 261, before `export async function getTransfers()`):

  ```ts
  export const TRANSFER_TERMINAL_STATES = new Set<TransferState>([
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ]);
  ```

- [ ] **Step 2: Add `RowDownload` to `app/lib/searchResults.ts`**

  Add the import and type. At the top of the file, change:

  ```ts
  import type { LocalFile, NetworkFile } from './api';
  ```

  to:

  ```ts
  import type { LocalFile, NetworkFile, TransferState } from './api';
  ```

  Then add this type anywhere after the `SearchHit` type definition (e.g. right after it, before `ParsedMeta`):

  ```ts
  export type RowDownload = {
    starting: boolean;
    id: string | null;
    state: TransferState | null;
    progress: number;
    error: string;
  };
  ```

- [ ] **Step 3: Verify the build still passes**

  Run: `bun --bun next build`
  Expected: build succeeds (these are unused exports at this point, which is fine — they're consumed in Task 3).

- [ ] **Step 4: Commit**

  ```bash
  git add app/lib/api.ts app/lib/searchResults.ts
  git commit -m "refactor: add shared RowDownload type and TRANSFER_TERMINAL_STATES export"
  ```

---

## Task 2: Add the failing regression test for consolidated polling

**Files:**

- Modify: `e2e/search.spec.ts` (insert a new test after the existing `'Download All fires a download for every selected row'` test, which ends at line 322)

**Interfaces:**

- Consumes: `mockSearch`, `mockBaseApp` from `./helpers` (already imported at the top of the file); `NETWORK_FILE` (line 5) and `NETWORK_FILE_2` (line 278) fixtures already defined in this file.

This test is written and run **before** the refactor, against the current per-row-polling implementation, specifically to prove it currently fails (i.e. that today's code really does fire one poll per active row). It will pass once Task 3's refactor lands.

- [ ] **Step 1: Write the test**

  Insert this test in `e2e/search.spec.ts` immediately after the `'Download All fires a download for every selected row'` test (i.e. right before the `'the select-all header checkbox selects every selectable row'` test, which currently starts at line 324):

  ```ts
  test('starting multiple downloads shares a single transfers poll instead of one per row', async ({
    page,
  }) => {
    await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE, NETWORK_FILE_2] });
    let getCount = 0;
    let postCount = 0;
    await page.route('/api/transfers', (route) => {
      if (route.request().method() === 'POST') {
        postCount += 1;
        return route.fulfill({ json: { id: `dl-${postCount}` } });
      }
      if (route.request().method() === 'GET') {
        getCount += 1;
        // Empty list: neither row's transfer id ever matches, so both stay
        // PENDING (non-terminal) and polling keeps running for the whole
        // wait below regardless of which implementation is under test.
        return route.fulfill({ json: [] });
      }
      return route.continue();
    });

    await page.goto('/search?q=song&type=all');
    await page.getByRole('checkbox', { name: 'Select awesome-song.mp3' }).check();
    await page.getByRole('checkbox', { name: 'Select another-song.mp3' }).check();
    await page.getByRole('button', { name: 'Download All' }).click();

    // ~2 poll cycles at the 2s cadence. A single shared poll produces ~2
    // GET requests in this window; one poll per active row produces ~4
    // (2 rows x 2 ticks). The threshold of 3 sits strictly between them.
    await page.waitForTimeout(4500);
    expect(getCount).toBeLessThanOrEqual(3);
  });
  ```

- [ ] **Step 2: Run it and confirm it FAILS against today's per-row-polling code**

  Run: `bunx playwright test e2e/search.spec.ts -g "shares a single transfers poll"`
  Expected: FAIL — `getCount` is 4 (or close to it), which is greater than the asserted `3`. This confirms the test actually detects per-row polling before you fix it.

  If it unexpectedly passes, stop and re-check the wait duration / assertion — don't proceed to Task 3 without seeing this go red first.

- [ ] **Step 3: Commit**

  ```bash
  git add e2e/search.spec.ts
  git commit -m "test: add failing regression test for per-row transfer polling"
  ```

---

## Task 3: Refactor `SearchView` and `ResultRow` to share one poll

**Files:**

- Modify: `app/(shell)/search/SearchView.tsx` (full file currently at `app/(shell)/search/SearchView.tsx:1-286`)
- Modify: `app/(shell)/search/ResultRow.tsx` (full file currently at `app/(shell)/search/ResultRow.tsx:1-159`)

**Interfaces:**

- Consumes: `TRANSFER_TERMINAL_STATES`, `Transfer`, `TransferState`, `getTransfers`, `startDownload` from `../../lib/api` (Task 1); `RowDownload`, `SearchHit`, `directSources` from `../../lib/searchResults` (Task 1).
- Produces: `ResultRow` props change to `{ hit, selected, onToggleSelect, onOpenInfo, download, onStartDownload }` — this is a breaking change to `ResultRow`'s prop signature, so both files must change together in this one task (an intermediate state with only one file updated will not compile).

- [ ] **Step 1: Rewrite `app/(shell)/search/SearchView.tsx`**

  Replace the whole file with:

  ```tsx
  'use client';

  import { useEffect, useRef, useState } from 'react';
  import { useRouter, useSearchParams } from 'next/navigation';

  import {
    DEFAULT_SORT,
    type RowDownload,
    type SearchHit,
    type SortColumn,
    type SortDirection,
    defaultDirectionFor,
    directSources,
    mergeResults,
    sortHits,
  } from '../../lib/searchResults';
  import type { FileType, LocalFile, NetworkFile, TransferState } from '../../lib/api';
  import {
    TRANSFER_TERMINAL_STATES,
    getTransfers,
    startDownload,
    streamSearch,
  } from '../../lib/api';

  import ResultInfoDrawer from './ResultInfoDrawer';
  import ResultRow from './ResultRow';
  import styles from './search.module.css';

  const FILE_TYPES: { value: FileType; label: string }[] = [
    { value: 'all', label: 'All types' },
    { value: 'audio', label: 'Audio' },
    { value: 'video', label: 'Video' },
    { value: 'image', label: 'Image' },
    { value: 'document', label: 'Document' },
    { value: 'ebook', label: 'Ebook' },
  ];

  const VALID_FILE_TYPES = new Set<string>(FILE_TYPES.map((t) => t.value));

  // Guards against a stale bookmark/shared link carrying an unrecognized
  // ?type= value (e.g. from a since-removed file type) reaching streamSearch().
  function parseFileType(raw: string | null): FileType {
    return raw && VALID_FILE_TYPES.has(raw) ? (raw as FileType) : 'all';
  }

  function SortableHeader({
    column,
    label,
    sort,
    onSort,
  }: {
    column: SortColumn;
    label: string;
    sort: { column: SortColumn; direction: SortDirection };
    onSort: (column: SortColumn) => void;
  }) {
    const active = sort.column === column;
    const ariaSort = active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
    return (
      <th aria-sort={ariaSort} scope="col">
        <button type="button" className={styles.sortButton} onClick={() => onSort(column)}>
          {label}
          {active && (
            <span className={styles.sortIndicator}>{sort.direction === 'asc' ? '▲' : '▼'}</span>
          )}
        </button>
      </th>
    );
  }

  function isRowActive(d: RowDownload | undefined): boolean {
    return !!d?.id && !TRANSFER_TERMINAL_STATES.has(d.state as TransferState);
  }

  // SearchView is remounted by its parent whenever search params change,
  // so we only need a mount effect — no URL-watching effect required.
  export default function SearchView() {
    const router = useRouter();
    const params = useSearchParams();

    const initialQ = params.get('q') ?? '';
    const initialType = parseFileType(params.get('type'));

    const [query, setQuery] = useState(initialQ);
    const [fileType, setFileType] = useState<FileType>(initialType);
    const [hits, setHits] = useState<SearchHit[]>([]);
    // loading starts true when there's an initial query to auto-run
    const [loading, setLoading] = useState(!!initialQ.trim());
    const [error, setError] = useState('');
    const [hasSearched, setHasSearched] = useState(false);
    const [sort, setSort] = useState<{ column: SortColumn; direction: SortDirection }>(
      DEFAULT_SORT,
    );
    const [infoHit, setInfoHit] = useState<SearchHit | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [downloads, setDownloads] = useState<Map<string, RowDownload>>(new Map());

    // Auto-run search on mount when there's an initial query (e.g. from navbar).
    // This effect has empty deps because the component remounts on param changes.
    useEffect(() => {
      if (!initialQ.trim()) return;
      let localFiles: LocalFile[] = [];
      let networkResults: NetworkFile[] = [];
      const es = streamSearch(
        { q: initialQ, type: initialType },
        {
          onLocal: (data) => {
            localFiles = data.files;
            setHits(mergeResults(localFiles, networkResults));
            setSelected(new Set());
          },
          onNetworkBatch: (batch) => {
            networkResults = [...networkResults, ...batch];
            setHits(mergeResults(localFiles, networkResults));
          },
          onDone: () => {
            setHasSearched(true);
            setLoading(false);
          },
          onError: () => {
            setError('Search failed. Is the server running?');
            setHasSearched(true);
            setLoading(false);
          },
        },
      );
      return () => es.close();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // intentionally empty — component remounts when params change

    function handleSubmit(e: React.FormEvent) {
      e.preventDefault();
      const q = query.trim();
      if (!q) return;
      router.replace(`/search?${new URLSearchParams({ q, type: fileType })}`);
      // Navigation triggers a remount of this component via the key in SearchPage
    }

    function handleSort(column: SortColumn) {
      setSort((prev) =>
        prev.column === column
          ? { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
          : { column, direction: defaultDirectionFor(column) },
      );
    }

    function startRowDownload(hit: SearchHit) {
      const current = downloads.get(hit.sha256);
      const busy =
        current?.starting ||
        (!!current?.id && current.state !== 'FAILED' && current.state !== 'CANCELLED');
      const sources = directSources(hit);
      if (busy || sources.length === 0) return;

      setDownloads((prev) => {
        const next = new Map(prev);
        next.set(hit.sha256, { starting: true, id: null, state: null, progress: 0, error: '' });
        return next;
      });

      startDownload({
        sha256: hit.sha256,
        filename: hit.filename,
        size: hit.size,
        mimeType: hit.mimeType ?? undefined,
        sources: sources.map((n) => n.nodeId),
      })
        .then(({ id }) => {
          setDownloads((prev) => {
            const cur = prev.get(hit.sha256);
            if (!cur) return prev;
            const next = new Map(prev);
            next.set(hit.sha256, { ...cur, id, state: 'PENDING' });
            return next;
          });
        })
        .catch((err: Error) => {
          setDownloads((prev) => {
            const cur = prev.get(hit.sha256);
            if (!cur) return prev;
            const next = new Map(prev);
            next.set(hit.sha256, { ...cur, error: err.message });
            return next;
          });
        })
        .finally(() => {
          setDownloads((prev) => {
            const cur = prev.get(hit.sha256);
            if (!cur) return prev;
            const next = new Map(prev);
            next.set(hit.sha256, { ...cur, starting: false });
            return next;
          });
        });
    }

    const sortedHits = sortHits(hits, sort.column, sort.direction);
    const selectableShas = new Set(
      sortedHits.filter((h) => directSources(h).length > 0).map((h) => h.sha256),
    );
    const allSelected =
      selectableShas.size > 0 && [...selectableShas].every((sha) => selected.has(sha));
    const someSelected = selected.size > 0 && !allSelected;
    const anyDownloadActive = [...downloads.values()].some(isRowActive);

    const headerCheckboxRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
      if (headerCheckboxRef.current) headerCheckboxRef.current.indeterminate = someSelected;
    }, [someSelected]);

    // Single shared poll for all active downloads in the table. Gated on
    // anyDownloadActive (not on `downloads` itself) so it doesn't tear down
    // and restart on every progress tick — only when polling needs to start
    // or can stop entirely.
    useEffect(() => {
      if (!anyDownloadActive) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout>;

      async function tick() {
        try {
          const transfers = await getTransfers();
          if (cancelled) return;
          const byId = new Map(transfers.map((t) => [t.id, t]));
          setDownloads((prev) => {
            let changed = false;
            const next = new Map(prev);
            for (const [sha, d] of prev) {
              if (!isRowActive(d) || !d.id) continue;
              const t = byId.get(d.id);
              if (t && (t.state !== d.state || t.progress !== d.progress)) {
                next.set(sha, { ...d, state: t.state, progress: t.progress });
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        } catch {
          // ignore, retry next tick
        } finally {
          if (!cancelled) timer = setTimeout(tick, 2000);
        }
      }

      timer = setTimeout(tick, 2000);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }, [anyDownloadActive]);

    function toggleSelectOne(sha256: string) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(sha256)) next.delete(sha256);
        else next.add(sha256);
        return next;
      });
    }

    function toggleSelectAll() {
      setSelected(allSelected ? new Set() : new Set(selectableShas));
    }

    function handleDownloadAll() {
      for (const sha256 of selected) {
        const hit = hits.find((h) => h.sha256 === sha256);
        if (hit) startRowDownload(hit);
      }
      setSelected(new Set());
    }

    return (
      <div className={styles.page}>
        <form className={styles.searchForm} onSubmit={handleSubmit}>
          <input
            className={`input ${styles.searchInput}`}
            type="search"
            placeholder="Search files…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <select
            className={`input ${styles.typeSelect}`}
            value={fileType}
            onChange={(e) => setFileType(e.target.value as FileType)}
            aria-label="File type"
          >
            {FILE_TYPES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </form>

        {error && <p className={styles.error}>{error}</p>}

        {loading && !error && (
          <div className={styles.searching} role="status">
            <span className={styles.searchingSpinner} aria-hidden="true" />
            Searching network…
          </div>
        )}

        {hasSearched && !loading && !error && (
          <div className={styles.resultsHeader}>
            {hits.length === 0 ? (
              <p className={styles.empty}>No results found.</p>
            ) : (
              <p className={styles.resultCount}>
                {hits.length} result{hits.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>
        )}

        {selected.size > 0 && (
          <div className={styles.toolbar}>
            <span className={styles.toolbarCount}>{selected.size} selected</span>
            <button type="button" className="btn btn-primary" onClick={handleDownloadAll}>
              Download All
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        )}

        {hits.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.thCheckbox} scope="col">
                    <input
                      ref={headerCheckboxRef}
                      type="checkbox"
                      aria-label="Select all results"
                      checked={allSelected}
                      disabled={selectableShas.size === 0}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <SortableHeader column="name" label="Name" sort={sort} onSort={handleSort} />
                  <SortableHeader column="type" label="Type" sort={sort} onSort={handleSort} />
                  <SortableHeader column="size" label="Size" sort={sort} onSort={handleSort} />
                  <SortableHeader
                    column="sources"
                    label="Sources"
                    sort={sort}
                    onSort={handleSort}
                  />
                  <th className={styles.thDetails} scope="col">
                    Details
                  </th>
                  <th className={styles.thDownload} scope="col">
                    <span className={styles.srOnly}>Download</span>
                  </th>
                  <th className={styles.thInfo} scope="col">
                    <span className={styles.srOnly}>Info panel</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedHits.map((hit) => (
                  <ResultRow
                    key={hit.sha256}
                    hit={hit}
                    selected={selected.has(hit.sha256)}
                    onToggleSelect={toggleSelectOne}
                    onOpenInfo={setInfoHit}
                    download={downloads.get(hit.sha256)}
                    onStartDownload={startRowDownload}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ResultInfoDrawer hit={infoHit} onClose={() => setInfoHit(null)} />
      </div>
    );
  }
  ```

- [ ] **Step 2: Rewrite `app/(shell)/search/ResultRow.tsx`**

  Replace the whole file with:

  ```tsx
  'use client';

  import {
    type RowDownload,
    type SearchHit,
    detailColumnValue,
    directSources,
    mimeIcon,
    sourceCount,
  } from '../../lib/searchResults';
  import { formatBytes } from '../../lib/api';

  import styles from './search.module.css';

  export default function ResultRow({
    hit,
    selected,
    onToggleSelect,
    onOpenInfo,
    download,
    onStartDownload,
  }: {
    hit: SearchHit;
    selected: boolean;
    onToggleSelect: (sha256: string) => void;
    onOpenInfo: (hit: SearchHit) => void;
    download: RowDownload | undefined;
    onStartDownload: (hit: SearchHit) => void;
  }) {
    const sources = directSources(hit);
    const starting = download?.starting ?? false;
    const downloadId = download?.id ?? null;
    const downloadState = download?.state ?? null;
    const downloadProgress = download?.progress ?? 0;
    const downloadError = download?.error ?? '';

    const disabled =
      starting ||
      (!!downloadId && downloadState !== 'FAILED' && downloadState !== 'CANCELLED') ||
      sources.length === 0;

    const label = starting
      ? 'Starting…'
      : downloadState === 'COMPLETED'
        ? 'Done ✓'
        : downloadState === 'FAILED'
          ? 'Failed'
          : downloadState === 'CANCELLED'
            ? 'Cancelled'
            : downloadState === 'DOWNLOADING' || downloadState === 'PAUSED'
              ? `${Math.round(downloadProgress * 100)}%`
              : downloadId
                ? 'Queued'
                : 'Download';

    return (
      <tr className={styles.row}>
        <td className={styles.cellCheckbox}>
          <input
            type="checkbox"
            aria-label={`Select ${hit.filename}`}
            checked={selected}
            disabled={sources.length === 0}
            onChange={() => onToggleSelect(hit.sha256)}
          />
        </td>
        <td className={styles.cellName}>
          <span className={styles.resultIcon}>{mimeIcon(hit.mimeType)}</span>
          <span className={styles.resultName} title={hit.filename}>
            {hit.filename}
          </span>
          {hit.local && <span className={styles.localBadge}>on this node</span>}
        </td>
        <td className={styles.cellType}>{hit.mimeType?.split('/')[1] ?? hit.mimeType ?? '—'}</td>
        <td className={styles.cellSize}>{formatBytes(hit.size)}</td>
        <td className={styles.cellSources}>{sourceCount(hit)}</td>
        <td className={styles.cellDetails}>{detailColumnValue(hit)}</td>
        <td className={styles.cellDownload}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabled}
            onClick={() => onStartDownload(hit)}
          >
            {label}
          </button>
          {downloadError && <span className={styles.downloadError}>{downloadError}</span>}
        </td>
        <td className={styles.cellInfo}>
          <button
            type="button"
            className={styles.infoButton}
            aria-label={`Details for ${hit.filename}`}
            onClick={() => onOpenInfo(hit)}
          >
            ℹ️
          </button>
        </td>
      </tr>
    );
  }
  ```

- [ ] **Step 3: Run the full search e2e suite and confirm everything passes, including the Task 2 regression test**

  Run: `bunx playwright test e2e/search.spec.ts`
  Expected: PASS — all tests green, including `'starting multiple downloads shares a single transfers poll instead of one per row'` (now `getCount` should be ~2, well under the `≤ 3` threshold).

- [ ] **Step 4: Typecheck and lint**

  Run: `bun --bun next build && bunx eslint app/\(shell\)/search/SearchView.tsx app/\(shell\)/search/ResultRow.tsx app/lib/api.ts app/lib/searchResults.ts`
  Expected: build succeeds, no lint errors.

- [ ] **Step 5: Commit**

  ```bash
  git add app/\(shell\)/search/SearchView.tsx app/\(shell\)/search/ResultRow.tsx
  git commit -m "refactor: consolidate per-row download polling into one shared poll"
  ```

---

## Task 4: Changelog and TODO updates

**Files:**

- Modify: `CHANGELOG.md` (`[Unreleased]` section)
- Modify: `TODO.md:207` (check off the item)

- [ ] **Step 1: Update `CHANGELOG.md`**

  Read the current `[Unreleased]` section first (`Read CHANGELOG.md`) to match its existing heading style (e.g. `### Changed`), then add a line such as:

  ```markdown
  - Search results table now shares a single `GET /api/transfers` poll across all in-progress downloads instead of running one poll per row.
  ```

- [ ] **Step 2: Check off the TODO.md item**

  In `TODO.md`, change line 207 from:

  ```markdown
  - [ ] Search results: consolidate per-row download polling — each `ResultRow` runs its own independent `getTransfers()` poll every 2s while its download is active (pre-existing pattern, not new to the table rework), so bulk-downloading N files fires N concurrent identical `GET /api/transfers` requests every 2s. Flagged by Copilot review on PR #39. Not a real problem at this app's actual scale (self-hosted, single user), but worth hoisting into one shared poll in `SearchView` fanned out by `sha256` if it ever becomes one.
  ```

  to:

  ```markdown
  - [x] Search results: consolidate per-row download polling — each `ResultRow` runs its own independent `getTransfers()` poll every 2s while its download is active (pre-existing pattern, not new to the table rework), so bulk-downloading N files fires N concurrent identical `GET /api/transfers` requests every 2s. Flagged by Copilot review on PR #39. Not a real problem at this app's actual scale (self-hosted, single user), but worth hoisting into one shared poll in `SearchView` fanned out by `sha256` if it ever becomes one.
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add CHANGELOG.md TODO.md
  git commit -m "docs: note consolidated search download polling in changelog and TODO"
  ```

---

## Task 5: Open the PR

**Files:** none (git/GitHub operations only)

- [ ] **Step 1: Push the branch**

  ```bash
  git push -u origin feature/consolidate-download-polling
  ```

- [ ] **Step 2: Open the PR**

  ```bash
  gh pr create --title "Consolidate search results download polling" --body "$(cat <<'EOF'
  ## Summary
  - Search results table now shares a single `GET /api/transfers` poll across all in-progress downloads instead of one poll per row (each `ResultRow` used to run its own independent 2s poll).
  - `SearchView` now owns all download state; `ResultRow` is a pure presentational component driven by `download`/`onStartDownload` props. Removes the `downloadTriggers` ref indirection previously used for the "Download All" bulk action.
  - Addresses the TODO item flagged by Copilot review on PR #39.

  ## Test plan
  - [x] `bunx playwright test e2e/search.spec.ts` — full suite green, including a new regression test asserting the shared-poll request count stays low across multiple simultaneous downloads
  - [x] `bun --bun next build`
  - [x] `bunx eslint` on touched files
  EOF
  )"
  ```

  Report the PR URL back once created.

---

## Self-Review Notes

- **Spec coverage:** Task 1 covers the shared types section of the spec. Task 3 covers "State ownership moves to `SearchView`", "Starting a download", "The shared poll", and "`ResultRow` after the change". Task 2 covers the Testing section's new regression test; existing Playwright coverage is verified (not modified) in Task 3 Step 3. Task 4 covers the Workflow section's changelog/TODO requirements. Task 5 covers the Workflow section's PR requirement.
- **Placeholder scan:** No TBD/TODO markers; all steps contain complete, runnable code.
- **Type consistency:** `RowDownload` fields (`starting`, `id`, `state`, `progress`, `error`) are used identically in `SearchView.tsx` (Task 3 Step 1) and `ResultRow.tsx` (Task 3 Step 2). `TRANSFER_TERMINAL_STATES` and `isRowActive` are only defined/used in `SearchView.tsx`, matching the design (ResultRow's `disabled` check is its own separate boolean expression, as in the original code — it doesn't need the terminal-states set).
