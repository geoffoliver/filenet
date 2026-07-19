# Search Results Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the collapsible-card search results list with a sortable table (Name, Type, Size, Sources, smart Details column), per-row + bulk download via checkboxes, and a slide-in metadata drawer — closing both open items under "Improve search results UI" in TODO.md.

**Architecture:** Extract the existing pure helpers (`mergeResults`, `parseMeta`, `formatDuration`, `mimeIcon`) out of `SearchView.tsx` into a new `app/lib/searchResults.ts`, adding sort/detail-column/direct-sources logic alongside them so it's unit-testable with `bun test`. Split the UI into three components: `SearchView.tsx` (form, sort/selection state, table shell), `ResultRow.tsx` (one `<tr>`, owns its own download-polling state exactly as today's `MetaDetail` did, but registers an imperative download trigger so bulk download can fire it from outside), and `ResultInfoDrawer.tsx` (new slide-in panel for full metadata, replacing the old expand-to-see-metadata interaction).

**Tech Stack:** Next.js 16 (client component), Tailwind v4 via CSS Modules, Bun test runner for the new pure-logic unit tests, Playwright for e2e coverage.

## Global Constraints

- No backend/API changes — `searchFiles`, `startDownload`, `getTransfers` (`app/lib/api.ts`) are unchanged (spec: Goals/Non-goals).
- Sortable columns are Name, Type, Size, Sources only; Details is not sortable (spec: Sorting).
- Default sort on a fresh result set is Sources, descending; switching to a new column defaults to ascending for Name/Type, descending for Size/Sources (spec: Sorting).
- A row's checkbox is disabled under the same condition that already disables its Download button today: zero direct sources (`!n.viaNodeId || n.viaNodeId === n.nodeId`) (spec: Table columns, Selection & bulk download).
- Selection is keyed by `sha256`, not row index, so it survives re-sorting (spec: Selection & bulk download).
- The info drawer slides in from the right, dismissible via X, `Escape`, or backdrop click — same dialog contract (`role="dialog"`, `aria-modal="true"`) as `ChatView.tsx`'s `NewGroupModal` (spec: Info drawer).
- Work happens on the `feature/search-results-table` branch (already created, spec doc committed there) so the change goes through a Copilot PR review before merging to `master`.
- Pre-commit hooks run Prettier + ESLint via lint-staged/husky on staged files — every commit must pass them (existing repo convention).
- `bun run test` runs backend + `app/lib`/`app/hooks` unit tests; `bun run test:e2e` runs Playwright. Both must stay green.

---

## File Structure

- `app/lib/searchResults.ts` — **new.** Pure helpers: `SearchHit`, `ParsedMeta` types; `mergeResults`, `parseMeta`, `formatDuration`, `mimeIcon` (moved verbatim from `SearchView.tsx`); `sourceCount`, `directSources`, `detailColumnValue` (new); `SortColumn`, `SortDirection`, `DEFAULT_SORT`, `defaultDirectionFor`, `sortHits` (new).
- `app/lib/__tests__/searchResults.test.ts` — **new.** Bun unit tests for everything above.
- `app/(shell)/search/SearchView.tsx` — **modified.** Drops `MetaDetail`, `expandedSha`/`toggleExpand`, and the local copies of the helpers now living in `app/lib/searchResults.ts`. Gains sort state, selection state, drawer-open state, a `SortableHeader` sub-component, the bulk-action toolbar, and renders `<ResultRow>`/`<ResultInfoDrawer>`.
- `app/(shell)/search/ResultRow.tsx` — **new.** One table row: checkbox, name+icon+badge, type, size, sources, details, download button (download-polling state moved here from `MetaDetail`), info icon.
- `app/(shell)/search/ResultInfoDrawer.tsx` — **new.** Slide-in metadata panel.
- `app/(shell)/search/search.module.css` — **modified.** Replace `.results`/`.result`/`.resultMain`/`.detail*` rules with table, toolbar, and drawer rules; widen `.page` from `max-w-3xl` to `max-w-5xl` to fit the 8-column table (same move already made for the Settings page in commit `71aff73`).
- `e2e/search.spec.ts` — **modified.** Update selectors for the table markup; remove the now-obsolete "expands result detail on click" test; add sorting, selection/bulk-download, and drawer tests.
- `CHANGELOG.md` — **modified.** New `### Changed` bullet under `[Unreleased]`.
- `site/screenshots/search-light.png`, `site/screenshots/search-dark.png` — **modified.** Retaken against the new table UI.
- `site/docs.html` — **modified only if needed.** Check for copy describing the old card/expand layout.

---

### Task 1: Extract shared search-result helpers into `app/lib/searchResults.ts`

**Files:**

- Create: `app/lib/searchResults.ts`
- Create: `app/lib/__tests__/searchResults.test.ts`
- Modify: `app/(shell)/search/SearchView.tsx:1-101` (imports + delete the moved local definitions)

**Interfaces:**

- Produces (consumed by every later task):
  - `type SearchHit = { sha256: string; filename: string; size: string; mimeType: string | null; metadata: string | null; local: boolean; networkSources: NetworkFile[] }`
  - `type ParsedMeta = { title?: string; artist?: string; album?: string; year?: number | string; track?: string; duration?: number; bitrate?: number; genre?: string; width?: number; height?: number; pageCount?: number }`
  - `mergeResults(local: LocalFile[], network: NetworkFile[]): SearchHit[]`
  - `parseMeta(raw: string | null): ParsedMeta | null`
  - `formatDuration(seconds: number): string`
  - `mimeIcon(mimeType: string | null): string`
  - `sourceCount(hit: SearchHit): number`
  - `directSources(hit: SearchHit): NetworkFile[]`
  - `type SortColumn = 'name' | 'type' | 'size' | 'sources'`
  - `type SortDirection = 'asc' | 'desc'`
  - `DEFAULT_SORT: { column: SortColumn; direction: SortDirection }`
  - `defaultDirectionFor(column: SortColumn): SortDirection`
  - `sortHits(hits: SearchHit[], column: SortColumn, direction: SortDirection): SearchHit[]`
  - `detailColumnValue(hit: SearchHit): string`

This is a pure refactor (moved code, no behavior change) plus new pure functions — verified with `bun test` for the new pieces and the existing Playwright search suite for the moved ones.

- [ ] **Step 1: Write the failing unit tests**

Create `app/lib/__tests__/searchResults.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_SORT,
  defaultDirectionFor,
  detailColumnValue,
  directSources,
  formatDuration,
  mergeResults,
  mimeIcon,
  parseMeta,
  sortHits,
  sourceCount,
  type SearchHit,
} from '../searchResults';
import type { LocalFile, NetworkFile } from '../api';

function networkFile(overrides: Partial<NetworkFile> = {}): NetworkFile {
  return {
    filename: 'song.mp3',
    size: '1000',
    sha256: 'a'.repeat(64),
    mimeType: 'audio/mpeg',
    metadata: null,
    nodeId: 'node-a',
    ...overrides,
  };
}

function localFile(overrides: Partial<LocalFile> = {}): LocalFile {
  return {
    id: 'local-1',
    filename: 'song.mp3',
    size: '1000',
    sha256: 'a'.repeat(64),
    mimeType: 'audio/mpeg',
    metadata: null,
    fileModifiedAt: null,
    indexedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    sha256: 'a'.repeat(64),
    filename: 'song.mp3',
    size: '1000',
    mimeType: 'audio/mpeg',
    metadata: null,
    local: false,
    networkSources: [],
    ...overrides,
  };
}

describe('mergeResults', () => {
  test('merges a local file and a network file with the same sha256 into one hit', () => {
    const local = [localFile()];
    const network = [networkFile({ nodeId: 'node-b' })];
    const merged = mergeResults(local, network);
    expect(merged).toHaveLength(1);
    expect(merged[0].local).toBe(true);
    expect(merged[0].networkSources).toHaveLength(1);
  });

  test('keeps a network-only file as non-local', () => {
    const merged = mergeResults([], [networkFile({ sha256: 'b'.repeat(64) })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].local).toBe(false);
  });
});

describe('parseMeta', () => {
  test('returns null for null input', () => {
    expect(parseMeta(null)).toBeNull();
  });

  test('returns null for invalid JSON', () => {
    expect(parseMeta('{not json')).toBeNull();
  });

  test('parses valid JSON', () => {
    expect(parseMeta('{"artist":"Test"}')).toEqual({ artist: 'Test' });
  });
});

describe('formatDuration', () => {
  test('formats under an hour as m:ss', () => {
    expect(formatDuration(210)).toBe('3:30');
  });

  test('formats an hour or more as h:mm:ss', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
  });
});

describe('mimeIcon', () => {
  test('returns a music note for audio', () => {
    expect(mimeIcon('audio/mpeg')).toBe('🎵');
  });

  test('returns a generic document icon for null', () => {
    expect(mimeIcon(null)).toBe('📄');
  });
});

describe('sourceCount', () => {
  test('counts local plus network sources', () => {
    expect(sourceCount(hit({ local: true, networkSources: [networkFile(), networkFile()] }))).toBe(
      3,
    );
  });

  test('is zero for an empty, non-local hit', () => {
    expect(sourceCount(hit({ local: false, networkSources: [] }))).toBe(0);
  });
});

describe('directSources', () => {
  test('includes a source with no viaNodeId', () => {
    const n = networkFile({ nodeId: 'node-a', viaNodeId: undefined });
    expect(directSources(hit({ networkSources: [n] }))).toEqual([n]);
  });

  test('includes a source whose viaNodeId equals its own nodeId', () => {
    const n = networkFile({ nodeId: 'node-a', viaNodeId: 'node-a' });
    expect(directSources(hit({ networkSources: [n] }))).toEqual([n]);
  });

  test('excludes a relayed-only source (viaNodeId differs from nodeId)', () => {
    const n = networkFile({ nodeId: 'node-a', viaNodeId: 'node-relay' });
    expect(directSources(hit({ networkSources: [n] }))).toEqual([]);
  });
});

describe('defaultDirectionFor', () => {
  test('defaults text columns to ascending', () => {
    expect(defaultDirectionFor('name')).toBe('asc');
    expect(defaultDirectionFor('type')).toBe('asc');
  });

  test('defaults numeric columns to descending', () => {
    expect(defaultDirectionFor('size')).toBe('desc');
    expect(defaultDirectionFor('sources')).toBe('desc');
  });
});

describe('DEFAULT_SORT', () => {
  test('is Sources, descending', () => {
    expect(DEFAULT_SORT).toEqual({ column: 'sources', direction: 'desc' });
  });
});

describe('sortHits', () => {
  const hits = [
    hit({ sha256: 'a'.repeat(64), filename: 'banana.mp3', size: '300', networkSources: [] }),
    hit({
      sha256: 'b'.repeat(64),
      filename: 'apple.mp3',
      size: '100',
      local: true,
      networkSources: [networkFile({ nodeId: 'n1' }), networkFile({ nodeId: 'n2' })],
    }),
    hit({ sha256: 'c'.repeat(64), filename: 'cherry.mp3', size: '200', networkSources: [] }),
  ];

  test('sorts by name ascending', () => {
    const sorted = sortHits(hits, 'name', 'asc');
    expect(sorted.map((h) => h.filename)).toEqual(['apple.mp3', 'banana.mp3', 'cherry.mp3']);
  });

  test('sorts by name descending', () => {
    const sorted = sortHits(hits, 'name', 'desc');
    expect(sorted.map((h) => h.filename)).toEqual(['cherry.mp3', 'banana.mp3', 'apple.mp3']);
  });

  test('sorts by size ascending', () => {
    const sorted = sortHits(hits, 'size', 'asc');
    expect(sorted.map((h) => h.size)).toEqual(['100', '200', '300']);
  });

  test('sorts by sources descending (the default)', () => {
    const sorted = sortHits(hits, 'sources', 'desc');
    expect(sorted[0].filename).toBe('apple.mp3'); // 3 sources (local + 2 network)
  });

  test('does not mutate the input array', () => {
    const copy = [...hits];
    sortHits(hits, 'name', 'asc');
    expect(hits).toEqual(copy);
  });
});

describe('detailColumnValue', () => {
  test('shows duration for audio', () => {
    const h = hit({ mimeType: 'audio/mpeg', metadata: JSON.stringify({ duration: 125 }) });
    expect(detailColumnValue(h)).toBe('2:05');
  });

  test('shows dimensions for images', () => {
    const h = hit({
      mimeType: 'image/jpeg',
      metadata: JSON.stringify({ width: 1920, height: 1080 }),
    });
    expect(detailColumnValue(h)).toBe('1920×1080');
  });

  test('shows page count for PDFs', () => {
    const h = hit({ mimeType: 'application/pdf', metadata: JSON.stringify({ pageCount: 14 }) });
    expect(detailColumnValue(h)).toBe('14 pages');
  });

  test('falls back to an em dash when there is no relevant metadata', () => {
    const h = hit({ mimeType: 'application/zip', metadata: null });
    expect(detailColumnValue(h)).toBe('—');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail (the module doesn't exist yet)**

Run: `bun test app/lib/__tests__/searchResults.test.ts`
Expected: FAIL — `Cannot find module '../searchResults'` (or similar resolution error).

- [ ] **Step 3: Write `app/lib/searchResults.ts`**

```typescript
import type { LocalFile, NetworkFile } from './api';

export type SearchHit = {
  sha256: string;
  filename: string;
  size: string;
  mimeType: string | null;
  metadata: string | null;
  local: boolean;
  networkSources: NetworkFile[];
};

export type ParsedMeta = {
  title?: string;
  artist?: string;
  album?: string;
  year?: number | string;
  track?: string;
  duration?: number;
  bitrate?: number;
  genre?: string;
  width?: number;
  height?: number;
  pageCount?: number;
};

export function mergeResults(local: LocalFile[], network: NetworkFile[]): SearchHit[] {
  const map = new Map<string, SearchHit>();
  for (const f of local) {
    map.set(f.sha256, {
      sha256: f.sha256,
      filename: f.filename,
      size: f.size,
      mimeType: f.mimeType,
      metadata: f.metadata,
      local: true,
      networkSources: [],
    });
  }
  for (const n of network) {
    const existing = map.get(n.sha256);
    if (existing) {
      existing.networkSources.push(n);
    } else {
      map.set(n.sha256, {
        sha256: n.sha256,
        filename: n.filename,
        size: n.size,
        mimeType: n.mimeType,
        metadata: n.metadata,
        local: false,
        networkSources: [n],
      });
    }
  }
  return Array.from(map.values());
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function parseMeta(raw: string | null): ParsedMeta | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ParsedMeta;
  } catch {
    return null;
  }
}

export function mimeIcon(mimeType: string | null): string {
  if (!mimeType) return '📄';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('image/')) return '🖼';
  if (mimeType.includes('pdf')) return '📕';
  if (mimeType.includes('epub') || mimeType.includes('ebook')) return '📚';
  if (mimeType.includes('word') || mimeType.includes('document')) return '📝';
  return '📄';
}

export function sourceCount(hit: SearchHit): number {
  return (hit.local ? 1 : 0) + hit.networkSources.length;
}

// Relayed results carry the producer's nodeId but we only have a WebSocket
// to whoever forwarded it (viaNodeId), so only count/allow sources we can
// actually download from directly.
export function directSources(hit: SearchHit): NetworkFile[] {
  return hit.networkSources.filter((n) => !n.viaNodeId || n.viaNodeId === n.nodeId);
}

export type SortColumn = 'name' | 'type' | 'size' | 'sources';
export type SortDirection = 'asc' | 'desc';

export const DEFAULT_SORT: { column: SortColumn; direction: SortDirection } = {
  column: 'sources',
  direction: 'desc',
};

export function defaultDirectionFor(column: SortColumn): SortDirection {
  return column === 'name' || column === 'type' ? 'asc' : 'desc';
}

function typeLabel(hit: SearchHit): string {
  if (!hit.mimeType) return '';
  return hit.mimeType.split('/')[1] ?? hit.mimeType;
}

function compareBigIntStrings(a: string, b: string): number {
  let an: bigint;
  let bn: bigint;
  try {
    an = BigInt(a);
  } catch {
    an = 0n;
  }
  try {
    bn = BigInt(b);
  } catch {
    bn = 0n;
  }
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

function compareByColumn(column: SortColumn, a: SearchHit, b: SearchHit): number {
  switch (column) {
    case 'name':
      return a.filename.localeCompare(b.filename, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    case 'type':
      return typeLabel(a).localeCompare(typeLabel(b), undefined, { sensitivity: 'base' });
    case 'size':
      return compareBigIntStrings(a.size, b.size);
    case 'sources':
      return sourceCount(a) - sourceCount(b);
  }
}

export function sortHits(
  hits: SearchHit[],
  column: SortColumn,
  direction: SortDirection,
): SearchHit[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...hits].sort((a, b) => sign * compareByColumn(column, a, b));
}

export function detailColumnValue(hit: SearchHit): string {
  const meta = parseMeta(hit.metadata);
  if (!meta) return '—';
  const mime = hit.mimeType ?? '';
  if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    if (typeof meta.duration === 'number') return formatDuration(meta.duration);
  } else if (mime.startsWith('image/')) {
    if (meta.width && meta.height) return `${meta.width}×${meta.height}`;
  } else if (mime.includes('pdf')) {
    if (typeof meta.pageCount === 'number') return `${meta.pageCount} pages`;
  }
  return '—';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test app/lib/__tests__/searchResults.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Update `SearchView.tsx` to import from the new module instead of defining its own copies**

In `app/(shell)/search/SearchView.tsx`, delete the local `SearchHit`/`ParsedMeta` types and the local `mergeResults`, `formatDuration`, `parseMeta`, `mimeIcon` functions (lines 20-101 in the current file), and change the import block at the top to:

```typescript
import type { FileType, TransferState } from '../../lib/api';
import { formatBytes, getTransfers, searchFiles, startDownload } from '../../lib/api';
import { mergeResults, type SearchHit } from '../../lib/searchResults';
```

Leave the rest of the file (the `MetaDetail` component, `SearchView` component) unchanged for this step — this is purely swapping the source of the moved functions/types, not a UI change yet.

- [ ] **Step 6: Run the full existing e2e search suite to confirm no behavior changed**

Run: `bunx playwright test e2e/search.spec.ts`
Expected: PASS — all existing tests green (same as before this task).

- [ ] **Step 7: Run format/lint checks and commit**

```bash
bun run format
bun run lint
git add app/lib/searchResults.ts app/lib/__tests__/searchResults.test.ts app/\(shell\)/search/SearchView.tsx
git commit -m "refactor: extract search-result helpers into app/lib/searchResults.ts"
```

---

### Task 2: Sortable table skeleton + `ResultRow` (drop the card/expand UI)

**Files:**

- Create: `app/(shell)/search/ResultRow.tsx`
- Modify: `app/(shell)/search/SearchView.tsx`
- Modify: `app/(shell)/search/search.module.css`
- Modify: `e2e/search.spec.ts`

**Interfaces:**

- Consumes: `SearchHit`, `mergeResults`, `sourceCount`, `directSources`, `detailColumnValue`, `mimeIcon`, `SortColumn`, `SortDirection`, `DEFAULT_SORT`, `defaultDirectionFor`, `sortHits` from `app/lib/searchResults.ts` (Task 1).
- Produces (consumed by Task 3 and Task 4):
  - `ResultRow` props: `{ hit: SearchHit; selected: boolean; onToggleSelect: (sha256: string) => void; onOpenInfo: (hit: SearchHit) => void; onRegisterDownload: (sha256: string, trigger: (() => void) | undefined) => void }`
  - `SearchView`'s internal `sort` state shape `{ column: SortColumn; direction: SortDirection }` and `handleSort(column: SortColumn)` handler — Task 4 reuses the same state, does not change it.

This task does not add checkboxes' selection behavior or the info drawer yet — the checkbox renders but is inert (calls a no-op), and the info button renders but is inert. Wiring them up is Tasks 3 and 4. This keeps the task reviewable on its own: "does the table render, sort, and download correctly?"

- [ ] **Step 1: Update `e2e/search.spec.ts` for the table markup (write these before the implementation exists — they should fail against the current card UI)**

Replace the `'expands result detail on click'` test and the two download tests (they currently click the row to expand, then find the button) with table-aware versions. Replace this whole block:

```typescript
test('expands result detail on click', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');
  await page.getByText('awesome-song.mp3').click();
  await expect(page.getByText('Test Artist')).toBeVisible();
  await expect(page.getByText('Test Album')).toBeVisible();
  await expect(page.getByText('3:30')).toBeVisible(); // 210s duration
});

test('shows source count in result row', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');
  await expect(page.getByText(/1 source/i)).toBeVisible();
});
```

with:

```typescript
test('renders results as a table with core columns', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');
  await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Type' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Size' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Sources' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Details' })).toBeVisible();
});

test('shows source count and details column in the row', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');
  const row = page.getByRole('row', { name: /awesome-song.mp3/ });
  await expect(row.getByRole('cell').nth(4)).toHaveText('1'); // Sources column
  await expect(row.getByRole('cell').nth(5)).toHaveText('3:30'); // Details: 210s duration
});
```

And update the two download tests to click the row's Download button directly instead of expanding first — change:

```typescript
await page.goto('/search?q=song&type=all');
await page.getByText('awesome-song.mp3').click();
await page.getByRole('button', { name: 'Download' }).click();
```

to (in both `'download button shows progress while downloading'` and `'download button shows Done after completion'`):

```typescript
await page.goto('/search?q=song&type=all');
await page.getByRole('button', { name: 'Download' }).click();
```

- [ ] **Step 2: Run the updated spec to verify the new/changed tests fail**

Run: `bunx playwright test e2e/search.spec.ts`
Expected: FAIL on the new/changed tests — no `columnheader` roles exist yet, the download button is still gated behind the click-to-expand card.

- [ ] **Step 3: Write `app/(shell)/search/ResultRow.tsx`**

```typescript
'use client';

import { useCallback, useEffect, useState } from 'react';

import type { TransferState } from '../../lib/api';
import { formatBytes, getTransfers, startDownload } from '../../lib/api';
import { detailColumnValue, directSources, mimeIcon, sourceCount, type SearchHit } from '../../lib/searchResults';

import styles from './search.module.css';

const TERMINAL_STATES = new Set<TransferState>(['COMPLETED', 'FAILED', 'CANCELLED']);

export default function ResultRow({
  hit,
  selected,
  onToggleSelect,
  onOpenInfo,
  onRegisterDownload,
}: {
  hit: SearchHit;
  selected: boolean;
  onToggleSelect: (sha256: string) => void;
  onOpenInfo: (hit: SearchHit) => void;
  onRegisterDownload: (sha256: string, trigger: (() => void) | undefined) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [downloadState, setDownloadState] = useState<TransferState | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState('');

  const sources = directSources(hit);
  const disabled =
    starting ||
    (!!downloadId && downloadState !== 'FAILED' && downloadState !== 'CANCELLED') ||
    sources.length === 0;

  const beginDownload = useCallback(() => {
    if (disabled) return;
    setDownloadId(null);
    setDownloadState(null);
    setDownloadProgress(0);
    setStarting(true);
    setDownloadError('');
    startDownload({
      sha256: hit.sha256,
      filename: hit.filename,
      size: hit.size,
      mimeType: hit.mimeType ?? undefined,
      sources: directSources(hit).map((n) => n.nodeId),
    })
      .then(({ id }) => {
        setDownloadId(id);
        setDownloadState('PENDING');
      })
      .catch((err: Error) => setDownloadError(err.message))
      .finally(() => setStarting(false));
  }, [disabled, hit]);

  useEffect(() => {
    onRegisterDownload(hit.sha256, beginDownload);
    return () => onRegisterDownload(hit.sha256, undefined);
  }, [hit.sha256, beginDownload, onRegisterDownload]);

  useEffect(() => {
    if (!downloadId || (downloadState && TERMINAL_STATES.has(downloadState))) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      try {
        const transfers = await getTransfers();
        if (cancelled) return;
        const t = transfers.find((x) => x.id === downloadId);
        if (t) {
          setDownloadState(t.state);
          setDownloadProgress(t.progress);
          if (!TERMINAL_STATES.has(t.state)) timer = setTimeout(tick, 2000);
        } else {
          timer = setTimeout(tick, 2000);
        }
      } catch {
        if (!cancelled) timer = setTimeout(tick, 2000);
      }
    }

    timer = setTimeout(tick, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [downloadId, downloadState]);

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
          onClick={beginDownload}
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

- [ ] **Step 4: Rewrite `app/(shell)/search/SearchView.tsx`**

Replace the entire file with:

```typescript
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import type { FileType } from '../../lib/api';
import { searchFiles } from '../../lib/api';
import {
  DEFAULT_SORT,
  defaultDirectionFor,
  mergeResults,
  sortHits,
  type SearchHit,
  type SortColumn,
  type SortDirection,
} from '../../lib/searchResults';

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

// SearchView is remounted by its parent whenever search params change,
// so we only need a mount effect — no URL-watching effect required.
export default function SearchView() {
  const router = useRouter();
  const params = useSearchParams();

  const initialQ = params.get('q') ?? '';
  const initialType = (params.get('type') as FileType) ?? 'all';

  const [query, setQuery] = useState(initialQ);
  const [fileType, setFileType] = useState<FileType>(initialType);
  const [hits, setHits] = useState<SearchHit[]>([]);
  // loading starts true when there's an initial query to auto-run
  const [loading, setLoading] = useState(!!initialQ.trim());
  const [error, setError] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [sort, setSort] = useState<{ column: SortColumn; direction: SortDirection }>(DEFAULT_SORT);
  const downloadTriggers = useRef(new Map<string, () => void>());

  // Auto-run search on mount when there's an initial query (e.g. from navbar).
  // This effect has empty deps because the component remounts on param changes.
  useEffect(() => {
    if (!initialQ.trim()) return;
    const controller = new AbortController();
    searchFiles({ q: initialQ, type: initialType, network: true }, controller.signal)
      .then((res) => {
        setHits(mergeResults(res.files, res.network ?? []));
        setHasSearched(true);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError('Search failed. Is the server running?');
        setHasSearched(true);
        setLoading(false);
      });
    return () => controller.abort();
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

  const registerDownloadTrigger = useCallback(
    (sha256: string, trigger: (() => void) | undefined) => {
      if (trigger) downloadTriggers.current.set(sha256, trigger);
      else downloadTriggers.current.delete(sha256);
    },
    [],
  );

  const sortedHits = sortHits(hits, sort.column, sort.direction);

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

      {hits.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.thCheckbox} scope="col">
                  <span className={styles.srOnly}>Select</span>
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
                  <span className={styles.srOnly}>Details panel</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedHits.map((hit) => (
                <ResultRow
                  key={hit.sha256}
                  hit={hit}
                  selected={false}
                  onToggleSelect={() => {}}
                  onOpenInfo={() => {}}
                  onRegisterDownload={registerDownloadTrigger}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Update `search.module.css`**

Replace the `.results` through `.downloadError` block (everything from `/* ── Results list ─...` to the end of the file) with:

```css
/* ── Results table ────────────────────────────────────────────────────────── */

.tableWrap {
  @apply w-full overflow-x-auto;
}

.table {
  @apply w-full
    border-collapse
    text-sm;
}

.table thead th {
  @apply text-left
    text-xs
    font-medium
    text-[var(--text-muted)]
    border-b
    border-[var(--border)]
    py-2
    px-3
    whitespace-nowrap;
}

.sortButton {
  @apply inline-flex
    items-center
    gap-1
    bg-transparent
    border-0
    p-0
    cursor-pointer
    text-xs
    font-medium
    text-[var(--text-muted)]
    hover:text-[var(--text-primary)];
}

.sortIndicator {
  @apply text-[10px];
}

.thCheckbox,
.thDownload,
.thInfo {
  @apply w-10;
}

.thDetails {
  @apply w-32;
}

.row {
  @apply border-b
    border-[var(--border)]
    last:border-b-0;
}

.row:hover {
  @apply bg-[var(--bg-elevated)];
}

.cellCheckbox,
.cellSources,
.cellDownload,
.cellInfo {
  @apply px-3
    py-2
    align-middle
    whitespace-nowrap;
}

.cellName {
  @apply px-3
    py-2
    align-middle
    flex
    items-center
    gap-2
    min-w-0;
}

.cellType,
.cellSize,
.cellDetails {
  @apply px-3
    py-2
    align-middle
    whitespace-nowrap
    text-[var(--text-muted)];
}

.resultIcon {
  @apply text-base
    flex-shrink-0;
}

.resultName {
  @apply text-sm
    font-medium
    text-[var(--text-primary)]
    truncate;
}

.localBadge {
  @apply inline-block
    px-1.5
    py-0.5
    rounded
    text-xs
    font-medium
    bg-[var(--color-primary)]
    text-white
    flex-shrink-0;
}

.downloadError {
  @apply block
    text-xs
    text-[var(--color-danger)]
    mt-1;
}

.infoButton {
  @apply bg-transparent
    border-0
    cursor-pointer
    text-base
    leading-none
    p-1
    rounded
    hover:bg-[var(--bg-elevated)];
}

.srOnly {
  @apply sr-only;
}
```

Also widen `.page` in the same file:

```css
.page {
  @apply w-full
    max-w-5xl
    mx-auto
    px-8
    py-10;
}
```

- [ ] **Step 6: Run the e2e search suite to verify it passes**

Run: `bunx playwright test e2e/search.spec.ts`
Expected: PASS — all tests green, including the two rewritten in Step 1.

- [ ] **Step 7: Run format/lint checks and commit**

```bash
bun run format
bun run lint
git add app/\(shell\)/search/ResultRow.tsx app/\(shell\)/search/SearchView.tsx app/\(shell\)/search/search.module.css e2e/search.spec.ts
git commit -m "feat: replace search results cards with a sortable table"
```

---

### Task 3: Info drawer

**Files:**

- Create: `app/(shell)/search/ResultInfoDrawer.tsx`
- Modify: `app/(shell)/search/SearchView.tsx`
- Modify: `app/(shell)/search/search.module.css`
- Modify: `e2e/search.spec.ts`

**Interfaces:**

- Consumes: `SearchHit`, `parseMeta`, `formatDuration` from `app/lib/searchResults.ts` (Task 1); `onOpenInfo` prop already present on `ResultRow` (Task 2).
- Produces: `ResultInfoDrawer` props `{ hit: SearchHit | null; onClose: () => void }`; `SearchView`'s `infoHit` state, wired to `ResultRow`'s `onOpenInfo`.

- [ ] **Step 1: Add failing e2e tests for the drawer**

Append to `e2e/search.spec.ts`:

```typescript
test('info icon opens a drawer with full metadata', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');
  await page.getByRole('button', { name: /details for awesome-song.mp3/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Test Artist')).toBeVisible();
  await expect(dialog.getByText('Test Album')).toBeVisible();
  await expect(dialog.getByText('3:30')).toBeVisible(); // 210s duration
});

test('drawer closes on Escape, X button, and backdrop click', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE] });
  await page.goto('/search?q=song&type=all');

  await page.getByRole('button', { name: /details for awesome-song.mp3/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();

  await page.getByRole('button', { name: /details for awesome-song.mp3/i }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();

  await page.getByRole('button', { name: /details for awesome-song.mp3/i }).click();
  // Click outside the drawer panel itself (top-left corner of the backdrop)
  await page.mouse.click(5, 5);
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `bunx playwright test e2e/search.spec.ts -g "drawer"`
Expected: FAIL — no `dialog` role exists yet, the info button is currently a no-op (Task 2 wired it to `() => {}`).

- [ ] **Step 3: Write `app/(shell)/search/ResultInfoDrawer.tsx`**

```typescript
'use client';

import { useEffect, useState } from 'react';

import { formatDuration, parseMeta, type SearchHit } from '../../lib/searchResults';

import styles from './search.module.css';

export default function ResultInfoDrawer({
  hit,
  onClose,
}: {
  hit: SearchHit | null;
  onClose: () => void;
}) {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!hit) {
      setEntered(false);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [hit]);

  useEffect(() => {
    if (!hit) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hit, onClose]);

  if (!hit) return null;

  const meta = parseMeta(hit.metadata);
  const rows: { label: string; value: string }[] = [];
  if (meta) {
    if (meta.title) rows.push({ label: 'Title', value: String(meta.title) });
    if (meta.artist) rows.push({ label: 'Artist', value: String(meta.artist) });
    if (meta.album) rows.push({ label: 'Album', value: String(meta.album) });
    if (meta.year) rows.push({ label: 'Year', value: String(meta.year) });
    if (meta.track) rows.push({ label: 'Track', value: String(meta.track) });
    if (meta.genre) rows.push({ label: 'Genre', value: String(meta.genre) });
    if (typeof meta.duration === 'number')
      rows.push({ label: 'Duration', value: formatDuration(meta.duration) });
    if (typeof meta.bitrate === 'number')
      rows.push({ label: 'Bitrate', value: `${meta.bitrate} kbps` });
    if (meta.width && meta.height)
      rows.push({ label: 'Dimensions', value: `${meta.width}×${meta.height}` });
    if (typeof meta.pageCount === 'number')
      rows.push({ label: 'Pages', value: String(meta.pageCount) });
  }

  return (
    <div className={styles.drawerBackdrop} onClick={onClose}>
      <div
        className={`${styles.drawer} ${entered ? styles.drawerOpen : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="result-info-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.drawerHeader}>
          <span id="result-info-title" className={styles.drawerTitle} title={hit.filename}>
            {hit.filename}
          </span>
          <button
            type="button"
            className={styles.drawerClose}
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {hit.local && <span className={styles.localBadge}>on this node</span>}
        <div className={styles.drawerMeta}>
          <div className={styles.drawerRow}>
            <span className={styles.detailLabel}>Hash</span>
            <span className={styles.detailValue}>{hit.sha256}</span>
          </div>
          {rows.map(({ label, value }) => (
            <div key={label} className={styles.drawerRow}>
              <span className={styles.detailLabel}>{label}</span>
              <span className={styles.detailValue}>{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire the drawer into `SearchView.tsx`**

Add the import:

```typescript
import ResultInfoDrawer from './ResultInfoDrawer';
```

Add state (alongside the existing `sort` state):

```typescript
const [infoHit, setInfoHit] = useState<SearchHit | null>(null);
```

Change each `ResultRow`'s `onOpenInfo={() => {}}` to `onOpenInfo={setInfoHit}`.

Add the drawer just before the closing `</div>` of the root `<div className={styles.page}>`:

```typescript
      <ResultInfoDrawer hit={infoHit} onClose={() => setInfoHit(null)} />
    </div>
  );
}
```

- [ ] **Step 5: Add drawer styles to `search.module.css`**

Append:

```css
/* ── Info drawer ──────────────────────────────────────────────────────────── */

.drawerBackdrop {
  @apply fixed
    inset-0
    z-50;
  background: rgba(0, 0, 0, 0.3);
}

.drawer {
  @apply fixed
    top-0
    right-0
    bottom-0
    w-96
    max-w-full
    bg-[var(--bg-surface)]
    border-l
    border-[var(--border)]
    shadow-[var(--shadow-md)]
    p-6
    overflow-y-auto
    flex
    flex-col
    gap-4;
  transform: translateX(100%);
  transition: transform 180ms ease-out;
}

.drawerOpen {
  transform: translateX(0);
}

.drawerHeader {
  @apply flex
    items-start
    justify-between
    gap-3;
}

.drawerTitle {
  @apply text-sm
    font-semibold
    text-[var(--text-primary)]
    break-words;
}

.drawerClose {
  @apply bg-transparent
    border-0
    cursor-pointer
    text-base
    leading-none
    text-[var(--text-muted)]
    hover:text-[var(--text-primary)]
    flex-shrink-0;
}

.drawerMeta {
  @apply flex
    flex-col
    gap-2;
}

.drawerRow {
  @apply flex
    items-baseline
    gap-2
    border-b
    border-[var(--border)]
    pb-2;
}

.detailLabel {
  @apply text-xs
    text-[var(--text-muted)]
    flex-shrink-0;
}

.detailValue {
  @apply text-xs
    text-[var(--text-primary)]
    break-all;
}
```

- [ ] **Step 6: Run the e2e search suite to verify it passes**

Run: `bunx playwright test e2e/search.spec.ts`
Expected: PASS — all tests green.

- [ ] **Step 7: Run format/lint checks and commit**

```bash
bun run format
bun run lint
git add app/\(shell\)/search/ResultInfoDrawer.tsx app/\(shell\)/search/SearchView.tsx app/\(shell\)/search/search.module.css e2e/search.spec.ts
git commit -m "feat: add slide-in metadata drawer to search results"
```

---

### Task 4: Checkbox multi-select + bulk download toolbar

**Files:**

- Modify: `app/(shell)/search/SearchView.tsx`
- Modify: `app/(shell)/search/search.module.css`
- Modify: `e2e/search.spec.ts`

**Interfaces:**

- Consumes: `directSources` from `app/lib/searchResults.ts` (Task 1); `ResultRow`'s existing `selected`/`onToggleSelect`/`onRegisterDownload` props (Task 2, previously fed inert values).
- Produces: no new exports — this is the last piece wiring `SearchView`'s internal state together.

- [ ] **Step 1: Add failing e2e tests for selection + bulk download**

Append to the end of `e2e/search.spec.ts`:

```typescript
const NETWORK_FILE_2 = {
  sha256: 'b'.repeat(64),
  filename: 'another-song.mp3',
  size: '2097152',
  mimeType: 'audio/mpeg',
  metadata: JSON.stringify({ duration: 90 }),
  nodeId: 'node-bob',
  viaNodeId: null,
};

test('selecting rows shows a bulk-action toolbar with the right count', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE, NETWORK_FILE_2] });
  await page.goto('/search?q=song&type=all');

  await page.getByRole('checkbox', { name: 'Select awesome-song.mp3' }).check();
  await expect(page.getByText('1 selected')).toBeVisible();

  await page.getByRole('checkbox', { name: 'Select another-song.mp3' }).check();
  await expect(page.getByText('2 selected')).toBeVisible();

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByText(/selected/)).not.toBeVisible();
});

test('Download All fires a download for every selected row', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE, NETWORK_FILE_2] });
  const startedIds: string[] = [];
  await page.route('/api/transfers', (route) => {
    if (route.request().method() === 'POST') {
      const id = `dl-${startedIds.length + 1}`;
      startedIds.push(id);
      return route.fulfill({ json: { id } });
    }
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    return route.continue();
  });

  await page.goto('/search?q=song&type=all');
  await page.getByRole('checkbox', { name: 'Select awesome-song.mp3' }).check();
  await page.getByRole('checkbox', { name: 'Select another-song.mp3' }).check();
  await page.getByRole('button', { name: 'Download All' }).click();

  await expect(page.getByText(/selected/)).not.toBeVisible(); // selection clears
  await expect.poll(() => startedIds.length).toBe(2);
});

test('the select-all header checkbox selects every selectable row', async ({ page }) => {
  await mockSearch(page, { files: [], total: 0, network: [NETWORK_FILE, NETWORK_FILE_2] });
  await page.goto('/search?q=song&type=all');
  await page.getByRole('checkbox', { name: 'Select all results' }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `bunx playwright test e2e/search.spec.ts -g "selected|Download All|select-all"`
Expected: FAIL — no checkboxes are wired up yet (Task 2 left `selected={false}` and `onToggleSelect={() => {}}` as placeholders), no toolbar exists.

- [ ] **Step 3: Wire selection state into `SearchView.tsx`**

Add the import:

```typescript
import { /* existing imports, */ directSources } from '../../lib/searchResults';
```

(merge into the existing `import { ... } from '../../lib/searchResults';` line rather than adding a second one)

Add state (alongside `sort` and `infoHit`):

```typescript
const [selected, setSelected] = useState<Set<string>>(new Set());
```

Directly below the existing `const sortedHits = sortHits(hits, sort.column, sort.direction);` line (added in Task 2, still just above the `return`), add these handlers and derived values:

```typescript
const selectableShas = new Set(
  sortedHits.filter((h) => directSources(h).length > 0).map((h) => h.sha256),
);
const allSelected =
  selectableShas.size > 0 && [...selectableShas].every((sha) => selected.has(sha));

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
    downloadTriggers.current.get(sha256)?.();
  }
  setSelected(new Set());
}
```

Replace the header checkbox cell:

```typescript
                <th className={styles.thCheckbox} scope="col">
                  <span className={styles.srOnly}>Select</span>
                </th>
```

with:

```typescript
                <th className={styles.thCheckbox} scope="col">
                  <input
                    type="checkbox"
                    aria-label="Select all results"
                    checked={allSelected}
                    disabled={selectableShas.size === 0}
                    onChange={toggleSelectAll}
                  />
                </th>
```

Replace each `ResultRow`'s placeholder selection props:

```typescript
                  selected={false}
                  onToggleSelect={() => {}}
```

with:

```typescript
                  selected={selected.has(hit.sha256)}
                  onToggleSelect={toggleSelectOne}
```

Add the toolbar as a new sibling JSX block, directly before the existing `{hits.length > 0 && (` block (it's self-gated by `selected.size > 0`, so it doesn't need to be nested inside that condition):

```typescript
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

```

Finally, clear stale selection whenever a fresh search result set arrives — in the mount effect's `.then()` callback, add `setSelected(new Set());` right after `setHits(mergeResults(res.files, res.network ?? []));`.

- [ ] **Step 4: Add toolbar styles to `search.module.css`**

Append:

```css
/* ── Bulk-action toolbar ──────────────────────────────────────────────────── */

.toolbar {
  @apply flex
    items-center
    gap-3
    mb-3
    px-3
    py-2
    rounded-[var(--radius-md)]
    bg-[var(--bg-elevated)]
    border
    border-[var(--border)];
}

.toolbarCount {
  @apply text-sm
    font-medium
    text-[var(--text-primary)]
    mr-auto;
}
```

- [ ] **Step 5: Run the e2e search suite to verify it passes**

Run: `bunx playwright test e2e/search.spec.ts`
Expected: PASS — all tests green, including the three new ones from Step 1.

- [ ] **Step 6: Run format/lint checks and commit**

```bash
bun run format
bun run lint
git add app/\(shell\)/search/SearchView.tsx app/\(shell\)/search/search.module.css e2e/search.spec.ts
git commit -m "feat: add checkbox multi-select and bulk download to search results"
```

---

### Task 5: Changelog, docs screenshots

**Files:**

- Modify: `CHANGELOG.md`
- Create (throwaway, deleted at end of task): `scripts/tmp-seed-search-demo.ts`
- Create (throwaway, deleted at end of task): `scripts/tmp-capture-search-screenshot.ts`
- Modify: `site/screenshots/search-light.png`, `site/screenshots/search-dark.png`
- Modify (only if it references the old card/expand layout): `site/docs.html`

**Interfaces:**

- Produces: updated `search-light.png`/`search-dark.png` at 1440×900, matching the filenames `site/index.html`/`site/docs.html` already reference — no HTML changes needed unless Step 6 finds stale copy.

This reuses the throwaway seed/capture script convention established in `docs/superpowers/plans/2026-07-18-github-pages-site.md` (Task 4 there), scoped down to just the Search view.

- [ ] **Step 1: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]`, add a `### Changed` section (or a new bullet if one already exists there from other work) above or alongside the existing `### Fixed` section:

```markdown
### Changed

- **Search results are now a sortable table** — replaced the click-to-expand card list with a table (Name, Type, Size, Sources, and a type-aware Details column showing duration/dimensions/page-count). Column headers sort ascending/descending; checkboxes support multi-select with a "Download All" bulk action; full metadata moved to a slide-in info drawer (`ResultInfoDrawer`) opened via a per-row info icon.
```

- [ ] **Step 2: Build the app, then boot it once against a fresh demo database**

```bash
cd /Users/geoff/Work/Websites/filez
bun run build
DATABASE_URL=./data/search-demo.db bun run server
```

Wait for the "listening" log line, then `Ctrl+C`. Confirm `http://localhost:3000` renders the app (not a 404).

- [ ] **Step 3: Write `scripts/tmp-seed-search-demo.ts`**

```typescript
import { randomUUID, createHash } from 'node:crypto';

import { applyMigrations, createDb } from '../server/db';
import { settings, sharedFiles } from '../server/schema';

function fakeSha256(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

const db = createDb('./data/search-demo.db');
applyMigrations(db);

await db
  .insert(settings)
  .values({ id: 'singleton', name: 'Riley' })
  .onConflictDoUpdate({ target: settings.id, set: { name: 'Riley' } });

const now = Date.now();

const demoFiles = [
  {
    filename: 'Boards of Canada - Music Has the Right to Children/05 Roygbiv.flac',
    size: 24_700_000,
    mimeType: 'audio/flac',
    metadata: {
      artist: 'Boards of Canada',
      album: 'Music Has the Right to Children',
      duration: 235,
    },
  },
  {
    filename: 'The Expanse Season 1/S01E01 Dulcinea.mkv',
    size: 1_800_000_000,
    mimeType: 'video/x-matroska',
    metadata: { duration: 2640, codec: 'H264' },
  },
  {
    filename: 'The Pragmatic Programmer.epub',
    size: 4_200_000,
    mimeType: 'application/epub+zip',
    metadata: { title: 'The Pragmatic Programmer', author: 'David Thomas' },
  },
  {
    filename: 'home-network-diagram.pdf',
    size: 540_000,
    mimeType: 'application/pdf',
    metadata: { title: 'Home Network Diagram', pageCount: 2 },
  },
  {
    filename: 'vacation-photos/IMG_4902.jpg',
    size: 7_200_000,
    mimeType: 'image/jpeg',
    metadata: { width: 6000, height: 4000 },
  },
];

for (const f of demoFiles) {
  await db.insert(sharedFiles).values({
    id: randomUUID(),
    path: `/home/riley/shared/${f.filename}`,
    filename: f.filename.split('/').pop()!,
    size: BigInt(f.size),
    sha256: fakeSha256(`${f.filename}:${f.size}`),
    mimeType: f.mimeType,
    metadata: JSON.stringify(f.metadata),
    fileModifiedAt: now - Math.floor(Math.random() * 60) * 86_400_000,
    lastSeenAt: now,
    indexedAt: now,
    updatedAt: now,
  });
}

console.log('Search demo data seeded into data/search-demo.db');
```

- [ ] **Step 4: Run the seed script, then start the server against it**

```bash
DATABASE_URL=./data/search-demo.db bun run scripts/tmp-seed-search-demo.ts
DATABASE_URL=./data/search-demo.db bun run server
```

Leave the server running. Confirm `http://localhost:3000/search?q=the&type=all` shows the seeded files (filenames containing "the": Expanse, Pragmatic Programmer) with the new table.

- [ ] **Step 5: Write and run `scripts/tmp-capture-search-screenshot.ts` (in a second terminal)**

```typescript
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE_URL = process.env.FILENET_URL ?? 'http://localhost:3000';
const OUT_DIR = 'site/screenshots';
mkdirSync(OUT_DIR, { recursive: true });

for (const scheme of ['light', 'dark'] as const) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/search`, { waitUntil: 'networkidle' });
  const input = page.getByRole('textbox').first();
  await input.fill('the');
  await input.press('Enter');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT_DIR}/search-${scheme}.png` });
  console.log(`captured search-${scheme}.png`);
  await browser.close();
}
```

```bash
bun run scripts/tmp-capture-search-screenshot.ts
```

Expected: two `captured search-<scheme>.png` lines.

- [ ] **Step 6: Stop the server, clean up throwaway files, eyeball the screenshots**

```bash
rm scripts/tmp-seed-search-demo.ts scripts/tmp-capture-search-screenshot.ts
rm -f data/search-demo.db data/search-demo.db-shm data/search-demo.db-wal
open site/screenshots/search-light.png site/screenshots/search-dark.png
```

Confirm both show the new sortable table with the seeded files, correct light/dark theming, and no error states. Also check `site/docs.html` for any prose describing the old "click a result to expand" interaction (search `grep -n "expand" site/docs.html`) and update it to describe the table/sort/checkbox/info-icon interaction if found.

- [ ] **Step 7: Commit**

```bash
git add CHANGELOG.md site/screenshots/search-light.png site/screenshots/search-dark.png
# only if Step 6 found and fixed stale copy:
git add site/docs.html
git commit -m "docs: changelog entry and refreshed search screenshots for the new results table"
```

---

### Task 6: Final verification and PR

**Files:** none (verification + branch push only)

- [ ] **Step 1: Run the full backend/unit test suite**

Run: `bun run test`
Expected: PASS — all backend and `app/lib`/`app/hooks` tests green, including the new `searchResults.test.ts`.

- [ ] **Step 2: Run the full Playwright suite (not just `search.spec.ts`)**

Run: `bun run test:e2e`
Expected: PASS — confirms nothing outside Search (e.g. shared layout/navbar) regressed.

- [ ] **Step 3: Run lint and format checks across the whole repo**

```bash
bun run lint
bun run format:check
```

Expected: both clean.

- [ ] **Step 4: Update TODO.md**

Mark both checklist items done under "Improve search results UI" in `TODO.md`, following the existing convention of a short note on what shipped, e.g.:

```markdown
- [x] Improve search results UI
  - [x] Sortable table of results (filename, filetype, filesize, total sources (etc?)) — `SearchView.tsx` now renders a `<table>`; Name/Type/Size/Sources columns sort ascending/descending on header click (default: Sources descending), plus a type-aware Details column (duration/dimensions/page count)
  - [x] Items can be downloaded individually (with a "Download" button/link) or multi-selected and bulk downloaded — per-row checkboxes (disabled when a result has no direct sources) plus a "Download All" bulk-action toolbar; full metadata moved to a new slide-in `ResultInfoDrawer`
```

Commit:

```bash
git add TODO.md
git commit -m "docs: mark search results UI TODO items done"
```

- [ ] **Step 5: Push the branch and open a PR**

```bash
git push -u origin feature/search-results-table
gh pr create --title "Sortable search results table with bulk download" --body "$(cat <<'EOF'
## Summary
- Replace the click-to-expand card list on the Search page with a sortable table (Name/Type/Size/Sources + a type-aware Details column).
- Add checkbox multi-select with a "Download All" bulk-action toolbar.
- Move full metadata display into a new slide-in info drawer, opened per row via an info icon.

## Test plan
- [x] `bun run test` (backend + lib/hooks unit tests, including new `app/lib/__tests__/searchResults.test.ts`)
- [x] `bun run test:e2e` (full Playwright suite)
- [x] `bun run lint` / `bun run format:check`
- [x] Manually verified `search-light.png`/`search-dark.png` against the new table

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Report the PR URL back to the user. This is the point where a Copilot review runs against the diff per project convention — do not merge until that's addressed.
