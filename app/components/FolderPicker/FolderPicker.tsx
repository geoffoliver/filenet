'use client';

import { useEffect, useRef, useState } from 'react';

import type { FsListing } from '../../lib/api';
import { listDirectory } from '../../lib/api';

import styles from './FolderPicker.module.css';

type Props = {
  value: string;
  onChange: (path: string) => void;
  /** Called when the user confirms a selection via the modal (in addition to onChange). */
  onSelect?: (path: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  placeholder?: string;
  id?: string;
};

export default function FolderPicker({
  value,
  onChange,
  onSelect,
  onKeyDown,
  inputRef,
  placeholder,
  id,
}: Props) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  function navigate(path?: string) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError('');
    listDirectory(path, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setListing(result);
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted && err.name !== 'AbortError') setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  }

  function openPicker() {
    setOpen(true);
    navigate(value.trim() || undefined);
  }

  function select() {
    if (!listing) return;
    onChange(listing.path);
    onSelect?.(listing.path);
    setOpen(false);
  }

  function close() {
    abortRef.current?.abort();
    setOpen(false);
    setError('');
    setListing(null);
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const breadcrumbs = listing
    ? listing.path
        .split('/')
        .filter(Boolean)
        .reduce<{ label: string; path: string }[]>((acc, seg) => {
          const prev = acc[acc.length - 1]?.path ?? '';
          acc.push({ label: seg, path: `${prev}/${seg}` });
          return acc;
        }, [])
    : [];

  return (
    <>
      <div className={styles.inputRow}>
        <input
          ref={inputRef}
          id={id}
          className="input"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? '/path/to/folder'}
        />
        <button type="button" className="btn btn-ghost" onClick={openPicker}>
          Browse…
        </button>
      </div>

      {open && (
        <div className={styles.backdrop} onClick={close}>
          <div
            ref={dialogRef}
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label="Choose a folder"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.header}>
              <span className={styles.headerTitle}>Choose a folder</span>
              <button type="button" className={styles.closeBtn} onClick={close} aria-label="Close">
                ×
              </button>
            </div>

            <div className={styles.breadcrumb}>
              <button
                type="button"
                className={styles.crumb}
                onClick={() => navigate('/')}
                title="/"
              >
                /
              </button>
              {breadcrumbs.map((c, i) => (
                <span key={c.path}>
                  <span className={styles.crumbSep}>/</span>
                  <button
                    type="button"
                    className={styles.crumb}
                    onClick={() => navigate(c.path)}
                    aria-current={i === breadcrumbs.length - 1 ? 'page' : undefined}
                  >
                    {c.label}
                  </button>
                </span>
              ))}
            </div>

            <div className={styles.body}>
              {loading && <p className={styles.status}>Loading…</p>}
              {error && <p className={styles.statusError}>{error}</p>}

              {!loading && !error && listing && (
                <>
                  {listing.parent !== null && (
                    <button
                      type="button"
                      className={styles.entry}
                      onClick={() => navigate(listing.parent!)}
                    >
                      <span className={styles.icon}>📁</span>
                      <span className={styles.entryName}>..</span>
                    </button>
                  )}
                  {listing.entries.length === 0 && (
                    <p className={styles.status}>No subdirectories here.</p>
                  )}
                  {listing.entries.map((e) => (
                    <button
                      key={e.path}
                      type="button"
                      className={styles.entry}
                      onClick={() => navigate(e.path)}
                    >
                      <span className={styles.icon}>📁</span>
                      <span className={styles.entryName}>{e.name}</span>
                    </button>
                  ))}
                </>
              )}
            </div>

            {listing && !loading && (
              <div className={styles.footer}>
                <span className={styles.currentPath}>{listing.path}</span>
                <div className={styles.footerActions}>
                  <button type="button" className="btn btn-ghost" onClick={close}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-primary" onClick={select}>
                    Select this folder
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
