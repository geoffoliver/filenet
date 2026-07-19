'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import Link from 'next/link';

import {
  type Stats,
  type Transfer,
  formatBytes,
  formatCount,
  formatEta,
  formatSpeed,
  getStats,
  getTransfers,
} from '../../lib/api';

import styles from './home.module.css';
import transferStyles from '../transfers/transfers.module.css';

const TRANSFERS_POLL_MS = 3000;
const ACTIVE_STATES = new Set(['PENDING', 'DOWNLOADING', 'PAUSED']);

type StatCardProps = {
  label: string;
  value: string;
  sub?: string;
  dim?: boolean;
};

function StatCard({ label, value, sub, dim }: StatCardProps) {
  return (
    <div className={`${styles.card} ${dim ? styles.cardDim : ''}`}>
      <span className={styles.cardLabel}>{label}</span>
      <span className={styles.cardValue}>{value}</span>
      {sub && <span className={styles.cardSub}>{sub}</span>}
    </div>
  );
}

function ActiveTransferRow({ transfer }: { transfer: Transfer }) {
  const pct = Math.min(100, Math.max(0, Math.round(transfer.progress * 100)));
  return (
    <li className={transferStyles.row}>
      <div className={transferStyles.rowTop}>
        <span className={transferStyles.rowName}>{transfer.filename}</span>
        <span
          className={`${transferStyles.stateBadge} ${transferStyles[`state${transfer.state}`]}`}
        >
          {transfer.state.toLowerCase()}
        </span>
      </div>
      <div
        className={transferStyles.progressBar}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${transfer.filename} download progress`}
      >
        <div className={transferStyles.progressFill} style={{ width: `${pct}%` }} />
      </div>
      <div className={transferStyles.rowMeta}>
        <span>
          {formatBytes(transfer.bytesReceived)} / {formatBytes(transfer.size)}
        </span>
        {transfer.state === 'DOWNLOADING' && (
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
      </div>
    </li>
  );
}

export default function HomeView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsError, setStatsError] = useState('');
  const [activeTransfers, setActiveTransfers] = useState<Transfer[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    let active = true;
    getStats()
      .then((s) => {
        if (active) setStats(s);
      })
      .catch(() => {
        if (active) setStatsError('Could not load stats. Is the server running?');
      });
    return () => {
      active = false;
    };
  }, []);

  const loadTransfers = useCallback(async () => {
    try {
      const data = await getTransfers();
      if (mountedRef.current) {
        setActiveTransfers(data.filter((t) => ACTIVE_STATES.has(t.state)));
      }
    } catch {
      // non-fatal — dashboard still shows stats if transfers fail
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    async function runPoll() {
      while (mountedRef.current) {
        await loadTransfers();
        if (!mountedRef.current) break;
        await new Promise<void>((resolve) => setTimeout(resolve, TRANSFERS_POLL_MS));
      }
    }

    runPoll();

    // Only flip the flag — do NOT cancel the pending setTimeout so the
    // Promise inside runPoll() resolves normally and the while-loop exits
    // cleanly rather than being stuck awaiting a cancelled timer forever.
    return () => {
      mountedRef.current = false;
    };
  }, [loadTransfers]);

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>Home</h1>

      {statsError && <p className={styles.error}>{statsError}</p>}

      <div className={styles.grid}>
        <StatCard
          label="Shared files"
          value={stats ? formatCount(stats.sharedFiles.count) : '–'}
          sub={stats ? formatBytes(stats.sharedFiles.totalSize) : undefined}
        />
        <StatCard
          label="Friends online"
          value={stats ? `${stats.friends.online} / ${stats.friends.total}` : '–'}
          sub={stats && stats.friends.total === 0 ? 'No friends yet' : undefined}
        />
        <StatCard
          label="Files downloaded"
          value={stats ? formatCount(stats.downloads.count) : '–'}
          sub={stats ? formatBytes(stats.downloads.totalSize) : undefined}
        />
        <StatCard
          label="Data downloaded"
          value={stats ? formatBytes(stats.downloads.totalSize) : '–'}
        />
      </div>

      <section className={styles.transfersSection}>
        <div className={styles.transfersHeader}>
          <h2 className={styles.transfersTitle}>Active Downloads</h2>
          <Link href="/transfers" className={styles.transfersLink}>
            View all
          </Link>
        </div>
        {activeTransfers.length === 0 ? (
          <p className={styles.transfersEmpty}>No active downloads.</p>
        ) : (
          <ul className={transferStyles.list}>
            {activeTransfers.map((t) => (
              <ActiveTransferRow key={t.id} transfer={t} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
