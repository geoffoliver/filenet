'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { controlTransfer, dismissTransfer, getTransfers } from '../../lib/api';
import type { Transfer } from '../../lib/api';

import styles from './transfers.module.css';

const POLL_MS = 1500;

// ── formatting helpers ────────────────────────────────────────────────────────

function formatBytes(s: string | number): string {
  const n = typeof s === 'string' ? parseInt(s, 10) : s;
  if (isNaN(n) || n === 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatSpeed(bps: number): string {
  if (bps === 0) return '–';
  return `${formatBytes(bps)}/s`;
}

function formatEta(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '–';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const ACTIVE_STATES = new Set(['PENDING', 'DOWNLOADING', 'PAUSED']);

// ── Download row ──────────────────────────────────────────────────────────────

function DownloadRow({ transfer, onAction }: { transfer: Transfer; onAction: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  async function doAction(action: 'pause' | 'resume' | 'cancel') {
    setWorking(true);
    setError('');
    setConfirming(false);
    controlTransfer(transfer.id, action)
      .then(() => onAction())
      .catch((err: Error) => setError(err.message))
      .finally(() => setWorking(false));
  }

  async function doDismiss() {
    setWorking(true);
    setError('');
    dismissTransfer(transfer.id)
      .then(() => onAction())
      .catch((err: Error) => setError(err.message))
      .finally(() => setWorking(false));
  }

  const pct = Math.round(transfer.progress * 100);
  const active = ACTIVE_STATES.has(transfer.state);

  return (
    <li className={styles.row}>
      <div className={styles.rowTop}>
        <span className={styles.rowName}>{transfer.filename}</span>
        <span className={`${styles.stateBadge} ${styles[`state${transfer.state}`]}`}>
          {transfer.state.toLowerCase()}
        </span>
      </div>

      {active && (
        <div className={styles.progressBar}>
          <div className={styles.progressFill} style={{ width: `${pct}%` }} />
        </div>
      )}

      <div className={styles.rowMeta}>
        <span>
          {formatBytes(transfer.bytesReceived)} / {formatBytes(transfer.size)}
        </span>
        {active && (
          <>
            <span>{formatSpeed(transfer.speedBps)}</span>
            <span>ETA {formatEta(transfer.etaSeconds)}</span>
            {transfer.sources > 0 && (
              <span>
                {transfer.sources} source{transfer.sources !== 1 ? 's' : ''}
              </span>
            )}
          </>
        )}
        {transfer.error && <span className={styles.rowError}>{transfer.error}</span>}
      </div>

      <div className={styles.rowActions}>
        {transfer.state === 'DOWNLOADING' && (
          <button className="btn btn-ghost" onClick={() => doAction('pause')} disabled={working}>
            Pause
          </button>
        )}
        {transfer.state === 'PAUSED' && (
          <button className="btn btn-ghost" onClick={() => doAction('resume')} disabled={working}>
            Resume
          </button>
        )}
        {active && !confirming && (
          <button className="btn btn-ghost" onClick={() => setConfirming(true)} disabled={working}>
            Cancel
          </button>
        )}
        {active && confirming && (
          <>
            <span className={styles.confirmText}>Cancel download?</span>
            <button className="btn btn-ghost" onClick={() => doAction('cancel')} disabled={working}>
              Yes
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setConfirming(false)}
              disabled={working}
            >
              No
            </button>
          </>
        )}
        {!active && (
          <button className="btn btn-ghost" onClick={doDismiss} disabled={working}>
            Dismiss
          </button>
        )}
      </div>

      {error && <p className={styles.rowError}>{error}</p>}
    </li>
  );
}

// ── Root view ─────────────────────────────────────────────────────────────────

export default function TransfersView() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loadError, setLoadError] = useState('');
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    getTransfers()
      .then((data) => {
        setTransfers(data);
        setLoadError('');
      })
      .catch(() => setLoadError('Could not load transfers. Is the server running?'));
  }, []);

  useEffect(() => {
    load();
    function schedule() {
      pollRef.current = setTimeout(() => {
        load();
        schedule();
      }, POLL_MS);
    }
    schedule();
    return () => {
      if (pollRef.current !== null) clearTimeout(pollRef.current);
    };
  }, [load]);

  const downloads = transfers;

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>Transfers</h1>

      {loadError && <p className={styles.loadError}>{loadError}</p>}

      <section className={styles.pane}>
        <h2 className={styles.paneTitle}>Downloads</h2>
        {downloads.length === 0 ? (
          <p className={styles.empty}>No downloads yet.</p>
        ) : (
          <ul className={styles.list}>
            {downloads.map((t) => (
              <DownloadRow key={t.id} transfer={t} onAction={load} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
