'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  type SearchHit,
  detailColumnValue,
  directSources,
  mimeIcon,
  sourceCount,
} from '../../lib/searchResults';
import { formatBytes, getTransfers, startDownload } from '../../lib/api';
import type { TransferState } from '../../lib/api';

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
