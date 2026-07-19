'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import {
  DEFAULT_SORT,
  type SearchHit,
  type SortColumn,
  type SortDirection,
  defaultDirectionFor,
  directSources,
  mergeResults,
  sortHits,
} from '../../lib/searchResults';
import type { FileType } from '../../lib/api';
import { searchFiles } from '../../lib/api';

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
// ?type= value (e.g. from a since-removed file type) reaching searchFiles().
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
  const [sort, setSort] = useState<{ column: SortColumn; direction: SortDirection }>(DEFAULT_SORT);
  const [infoHit, setInfoHit] = useState<SearchHit | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const downloadTriggers = useRef(new Map<string, () => void>());

  // Auto-run search on mount when there's an initial query (e.g. from navbar).
  // This effect has empty deps because the component remounts on param changes.
  useEffect(() => {
    if (!initialQ.trim()) return;
    const controller = new AbortController();
    searchFiles({ q: initialQ, type: initialType, network: true }, controller.signal)
      .then((res) => {
        setHits(mergeResults(res.files, res.network ?? []));
        setSelected(new Set());
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
                <SortableHeader column="sources" label="Sources" sort={sort} onSort={handleSort} />
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
                  onRegisterDownload={registerDownloadTrigger}
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
