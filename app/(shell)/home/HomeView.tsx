'use client';

import { useEffect, useState } from 'react';

import { type Stats, formatBytes, getStats } from '../../lib/api';

import styles from './home.module.css';

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

export default function HomeView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getStats()
      .then((s) => {
        if (active) setStats(s);
      })
      .catch(() => {
        if (active) setError('Could not load stats. Is the server running?');
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>Home</h1>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.grid}>
        <StatCard
          label="Shared files"
          value={stats ? String(stats.sharedFiles.count) : '–'}
          sub={stats ? formatBytes(stats.sharedFiles.totalSize) : undefined}
        />
        <StatCard
          label="Friends online"
          value={stats ? `${stats.friends.online} / ${stats.friends.total}` : '–'}
          sub={stats && stats.friends.total === 0 ? 'No friends yet' : undefined}
        />
        <StatCard
          label="Files downloaded"
          value={stats ? String(stats.downloads.count) : '–'}
          sub={stats ? formatBytes(stats.downloads.totalSize) : undefined}
        />
        <StatCard
          label="Data downloaded"
          value={stats ? formatBytes(stats.downloads.totalSize) : '–'}
        />
      </div>
    </div>
  );
}
