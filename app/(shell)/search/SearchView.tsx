'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import type { FileType, LocalFile, NetworkFile } from '../../lib/api';
import { searchFiles, startDownload } from '../../lib/api';

import styles from './search.module.css';

const FILE_TYPES: { value: FileType; label: string }[] = [
  { value: 'all', label: 'All types' },
  { value: 'audio', label: 'Audio' },
  { value: 'video', label: 'Video' },
  { value: 'image', label: 'Image' },
  { value: 'document', label: 'Document' },
  { value: 'ebook', label: 'Ebook' },
];

type SearchHit = {
  sha256: string;
  filename: string;
  size: string;
  mimeType: string | null;
  metadata: string | null;
  local: boolean;
  networkSources: NetworkFile[];
};

type ParsedMeta = {
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
};

function mergeResults(local: LocalFile[], network: NetworkFile[]): SearchHit[] {
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
    const hit = map.get(n.sha256);
    if (hit) {
      hit.networkSources.push(n);
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

function formatBytes(s: string): string {
  const n = parseInt(s, 10);
  if (isNaN(n)) return s;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parseMeta(raw: string | null): ParsedMeta | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ParsedMeta;
  } catch {
    return null;
  }
}

function mimeIcon(mimeType: string | null): string {
  if (!mimeType) return '📄';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('image/')) return '🖼';
  if (mimeType.includes('pdf')) return '📕';
  if (mimeType.includes('epub') || mimeType.includes('ebook')) return '📚';
  if (mimeType.includes('word') || mimeType.includes('document')) return '📝';
  return '📄';
}

function MetaDetail({ hit }: { hit: SearchHit }) {
  const meta = parseMeta(hit.metadata);
  // Only include sources we're directly connected to — relayed results carry the
  // producer's nodeId but we have no WebSocket to them, only to viaNodeId.
  const directSources = hit.networkSources.filter((n) => !n.viaNodeId || n.viaNodeId === n.nodeId);
  const sources = (hit.local ? 1 : 0) + hit.networkSources.length;
  const rows: { label: string; value: string }[] = [];
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [downloaded, setDownloaded] = useState(false);

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
      rows.push({ label: 'Bitrate', value: `${Math.round(meta.bitrate / 1000)} kbps` });
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
          disabled={downloading || downloaded || directSources.length === 0}
          onClick={() => {
            const allSources = directSources.map((n) => n.nodeId);
            setDownloading(true);
            setDownloadError('');
            startDownload({
              sha256: hit.sha256,
              filename: hit.filename,
              size: hit.size,
              mimeType: hit.mimeType ?? undefined,
              sources: allSources,
            })
              .then(() => setDownloaded(true))
              .catch((err: Error) => setDownloadError(err.message))
              .finally(() => setDownloading(false));
          }}
        >
          {downloading ? 'Starting…' : downloaded ? 'Queued' : 'Download'}
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
    let active = true;
    searchFiles({ q: initialQ, type: initialType, network: true })
      .then((res) => {
        if (!active) return;
        setHits(mergeResults(res.files, res.network ?? []));
        setHasSearched(true);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError('Search failed. Is the server running?');
        setHasSearched(true);
        setLoading(false);
      });
    return () => {
      active = false;
    };
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
