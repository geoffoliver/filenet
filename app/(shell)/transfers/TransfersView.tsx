'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Transfer, Upload } from '../../lib/api';
import {
  controlTransfer,
  dismissTransfer,
  formatBytes,
  formatEta,
  formatSpeed,
  getTransfers,
  getUploads,
} from '../../lib/api';

import styles from './transfers.module.css';

const POLL_MS = 1500;
const ACTIVE_STATES = new Set(['PENDING', 'DOWNLOADING', 'PAUSED']);

// ── Download row ──────────────────────────────────────────────────────────────

function DownloadRow({ transfer, onAction }: { transfer: Transfer; onAction: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  function doAction(action: 'pause' | 'resume' | 'cancel') {
    setWorking(true);
    setError('');
    setConfirming(false);
    controlTransfer(transfer.id, action)
      .then(() => onAction())
      .catch((err: Error) => setError(err.message))
      .finally(() => setWorking(false));
  }

  function doDismiss() {
    setWorking(true);
    setError('');
    dismissTransfer(transfer.id)
      .then(() => onAction())
      .catch((err: Error) => setError(err.message))
      .finally(() => setWorking(false));
  }

  const pct = Math.min(100, Math.max(0, Math.round(transfer.progress * 100)));
  const active = ACTIVE_STATES.has(transfer.state);

  return (
    <li className={`${styles.row} ${working ? styles.rowWorking : ''}`}>
      <span className={`${styles.stateBar} ${styles[`state${transfer.state}`]}`} />

      <span className={styles.rowName} title={transfer.filename}>
        {transfer.filename}
      </span>

      {active ? (
        <span className={styles.rowProgress}>
          <span
            className={styles.progressTrack}
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${transfer.filename} download progress`}
          >
            <span className={styles.progressFill} style={{ width: `${pct}%` }} />
          </span>
          <span className={styles.pct}>{pct}%</span>
        </span>
      ) : (
        <span className={styles.rowProgress} />
      )}

      <span className={styles.rowBytes}>
        {formatBytes(transfer.bytesReceived)} / {formatBytes(transfer.size)}
      </span>

      <span className={styles.rowSpeed}>{active ? formatSpeed(transfer.speedBps) : '–'}</span>

      <span className={styles.rowEta}>
        {active && transfer.etaSeconds != null ? formatEta(transfer.etaSeconds) : '–'}
      </span>

      {transfer.sources > 0 && active ? (
        <span className={styles.rowSources}>{transfer.sources} src</span>
      ) : (
        <span className={styles.rowSources} />
      )}

      <span className={styles.rowActions}>
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
            <span className={styles.confirmText}>Cancel?</span>
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
      </span>

      {error && <span className={styles.rowError}>{error}</span>}
    </li>
  );
}

// ── Upload row ────────────────────────────────────────────────────────────────

function UploadRow({ upload }: { upload: Upload }) {
  return (
    <li className={styles.row}>
      <span className={`${styles.stateBar} ${styles.stateUPLOADING}`} />
      <span className={styles.rowName} title={upload.filename}>
        {upload.filename}
      </span>
      <span className={styles.rowProgress} />
      <span className={styles.rowBytes}>
        {formatBytes(upload.bytesServed)} / {formatBytes(upload.size)}
      </span>
      <span className={styles.rowSpeed}>{formatSpeed(upload.speedBps)}</span>
      <span className={styles.rowEta}>–</span>
      <span className={styles.rowSources}>{upload.peerNodeId.slice(0, 8)}…</span>
      <span className={styles.rowActions} />
    </li>
  );
}

// ── Root view ─────────────────────────────────────────────────────────────────

export default function TransfersView() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [loadError, setLoadError] = useState('');
  const [clearError, setClearError] = useState('');
  const [clearing, setClearing] = useState(false);
  const [splitPct, setSplitPct] = useState(60);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const mountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const [tResult, uResult] = await Promise.allSettled([getTransfers(), getUploads()]);
    if (!mountedRef.current) return;
    if (tResult.status === 'fulfilled') {
      setTransfers(tResult.value);
      setLoadError('');
      setClearError('');
    } else {
      setLoadError('Could not load transfers. Is the server running?');
      setClearError('');
    }
    if (uResult.status === 'fulfilled') {
      setUploads(uResult.value);
    } else {
      setUploads([]);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    async function runPoll() {
      while (mountedRef.current) {
        await load();
        if (!mountedRef.current) break;
        await new Promise<void>((resolve) => {
          pollRef.current = setTimeout(resolve, POLL_MS);
        });
      }
    }

    runPoll();

    return () => {
      mountedRef.current = false;
      if (pollRef.current !== null) clearTimeout(pollRef.current);
    };
  }, [load]);

  // Resizable drag handle
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientY - rect.top) / rect.height) * 100;
      setSplitPct(Math.min(Math.max(pct, 20), 80));
    }
    function onMouseUp() {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  function onHandleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }

  async function clearFinished() {
    if (clearing) return;
    setClearing(true);
    setClearError('');
    try {
      const finished = transfers.filter((t) => !ACTIVE_STATES.has(t.state));
      const results = await Promise.allSettled(finished.map((t) => dismissTransfer(t.id)));
      const failCount = results.filter((r) => r.status === 'rejected').length;
      if (failCount > 0)
        setClearError(`Failed to dismiss ${failCount} transfer${failCount > 1 ? 's' : ''}`);
      await load();
    } finally {
      setClearing(false);
    }
  }

  const activeDownloads = transfers.filter((t) => ACTIVE_STATES.has(t.state));
  const concurrentUploads = uploads.length;

  return (
    <div className={styles.page} ref={containerRef}>
      {loadError && <p className={styles.loadError}>{loadError}</p>}

      {/* Downloads pane */}
      <div className={styles.pane} style={{ flex: `0 0 ${splitPct}%` }}>
        <div className={styles.paneHeader}>
          <h2 className={styles.paneTitle}>Downloads</h2>
          <span className={styles.paneHeaderRight}>
            {clearError && <span className={styles.clearError}>{clearError}</span>}
            <button
              className="btn btn-ghost"
              onClick={clearFinished}
              disabled={clearing || transfers.every((t) => ACTIVE_STATES.has(t.state))}
            >
              Clear Finished
            </button>
          </span>
        </div>

        {transfers.length === 0 ? (
          <p className={styles.empty}>No downloads yet.</p>
        ) : (
          <ul className={styles.list}>
            {transfers.map((t) => (
              <DownloadRow key={t.id} transfer={t} onAction={load} />
            ))}
          </ul>
        )}
      </div>

      {/* Drag handle */}
      <div
        className={styles.handle}
        role="separator"
        aria-orientation="horizontal"
        aria-valuenow={Math.round(splitPct)}
        aria-valuemin={20}
        aria-valuemax={80}
        aria-label="Resize downloads/uploads panes"
        tabIndex={0}
        onMouseDown={onHandleMouseDown}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const delta = e.shiftKey ? 10 : 2;
            setSplitPct((p) =>
              e.key === 'ArrowUp' ? Math.max(p - delta, 20) : Math.min(p + delta, 80),
            );
          }
        }}
      />

      {/* Uploads pane */}
      <div className={styles.pane} style={{ flex: 1 }}>
        <div className={styles.paneHeader}>
          <h2 className={styles.paneTitle}>Uploads</h2>
        </div>

        {uploads.length === 0 ? (
          <p className={styles.empty}>No active uploads.</p>
        ) : (
          <ul className={styles.list}>
            {uploads.map((u) => (
              <UploadRow key={u.id} upload={u} />
            ))}
          </ul>
        )}
      </div>

      {/* Status bar */}
      <div className={styles.statusBar}>
        <span>Concurrent Downloads: {activeDownloads.length}</span>
        <span className={styles.statusDivider}>|</span>
        <span>Concurrent Uploads: {concurrentUploads}</span>
      </div>
    </div>
  );
}
