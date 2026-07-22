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
