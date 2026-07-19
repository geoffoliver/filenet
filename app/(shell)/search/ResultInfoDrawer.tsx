'use client';

import { useEffect, useRef, useState } from 'react';

import { type SearchHit, formatDuration, parseMeta } from '../../lib/searchResults';

import styles from './search.module.css';

export default function ResultInfoDrawer({
  hit,
  onClose,
}: {
  hit: SearchHit | null;
  onClose: () => void;
}) {
  const [entered, setEntered] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!hit) return;
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => {
      cancelAnimationFrame(raf);
      setEntered(false);
    };
  }, [hit]);

  useEffect(() => {
    if (!hit) return;
    closeButtonRef.current?.focus();
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
            ref={closeButtonRef}
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
