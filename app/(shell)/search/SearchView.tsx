'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import type { FileType, TransferState } from '../../lib/api';
import { formatBytes, getTransfers, searchFiles, startDownload } from '../../lib/api';

import {
  type SearchHit,
  formatDuration,
  mergeResults,
  mimeIcon,
  parseMeta,
} from '../../lib/searchResults';

import styles from './search.module.css';

const FILE_TYPES: { value: FileType; label: string }[] = [
  { value: 'all', label: 'All types' },
  { value: 'audio', label: 'Audio' },
  { value: 'video', label: 'Video' },
  { value: 'image', label: 'Image' },
  { value: 'document', label: 'Document' },
  { value: 'ebook', label: 'Ebook' },
];

const TERMINAL_STATES = new Set<TransferState>(['COMPLETED', 'FAILED', 'CANCELLED']);

function MetaDetail({ hit }: { hit: SearchHit }) {
  const meta = parseMeta(hit.metadata);
  // Only include sources we're directly connected to — relayed results carry the
  // producer's nodeId but we have no WebSocket to them, only to viaNodeId.
  const directSources = hit.networkSources.filter((n) => !n.viaNodeId || n.viaNodeId === n.nodeId);
  const sources = (hit.local ? 1 : 0) + hit.networkSources.length;
  const rows: { label: string; value: string }[] = [];
  const [starting, setStarting] = useState(false);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [downloadState, setDownloadState] = useState<TransferState | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState('');

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
  }

  return (
    <div className={styles.detail}>
      <div className={styles.detailMeta}>
        <span className={styles.detailItem}>
          <span className={styles.detailLabel}>Hash</span>
          <span className={styles.detailValue} title={hit.sha256}>
            {hit.sha256.slice(0, 12)}…
          </span>
        </span>
        <span className={styles.detailItem}>
          <span className={styles.detailLabel}>Sources</span>
          <span className={styles.detailValue}>{sources}</span>
        </span>
        {hit.local && (
          <span className={styles.detailItem}>
            <span className={styles.localBadge}>on this node</span>
          </span>
        )}
        {rows.map(({ label, value }) => (
          <span key={label} className={styles.detailItem}>
            <span className={styles.detailLabel}>{label}</span>
            <span className={styles.detailValue}>{value}</span>
          </span>
        ))}
      </div>
      <div className={styles.downloadArea}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            starting ||
            (!!downloadId && downloadState !== 'FAILED' && downloadState !== 'CANCELLED') ||
            directSources.length === 0
          }
          onClick={() => {
            const allSources = directSources.map((n) => n.nodeId);
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
              sources: allSources,
            })
              .then(({ id }) => {
                setDownloadId(id);
                setDownloadState('PENDING');
              })
              .catch((err: Error) => setDownloadError(err.message))
              .finally(() => setStarting(false));
          }}
        >
          {starting
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
                      : 'Download'}
        </button>
        {downloadError && <span className={styles.downloadError}>{downloadError}</span>}
      </div>
    </div>
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
  const [expandedSha, setExpandedSha] = useState<string | null>(null);

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

  function toggleExpand(sha256: string) {
    setExpandedSha((prev) => (prev === sha256 ? null : sha256));
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

      {hits.length > 0 && (
        <ul className={styles.results}>
          {hits.map((hit) => {
            const sources = (hit.local ? 1 : 0) + hit.networkSources.length;
            const expanded = expandedSha === hit.sha256;
            return (
              <li key={hit.sha256} className={styles.result}>
                <button
                  type="button"
                  className={styles.resultMain}
                  onClick={() => toggleExpand(hit.sha256)}
                  aria-expanded={expanded}
                >
                  <div className={styles.resultIcon}>{mimeIcon(hit.mimeType)}</div>
                  <div className={styles.resultInfo}>
                    <span className={styles.resultName}>{hit.filename}</span>
                    <span className={styles.resultMeta}>
                      {formatBytes(hit.size)}
                      {hit.mimeType && (
                        <>
                          {' · '}
                          <span className={styles.mimeLabel}>
                            {hit.mimeType.split('/')[1] ?? hit.mimeType}
                          </span>
                        </>
                      )}
                      {' · '}
                      {sources} {sources === 1 ? 'source' : 'sources'}
                    </span>
                  </div>
                  <span className={styles.expandIcon}>{expanded ? '▲' : '▼'}</span>
                </button>
                {expanded && <MetaDetail hit={hit} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
