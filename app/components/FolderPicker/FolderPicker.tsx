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

type Crumb = { label: string; path: string };

// Builds clickable breadcrumb segments from a native server path. Handles
// POSIX ("/home/x"), Windows drive ("C:\Users"), and UNC ("\\server\share\x")
// forms. POSIX is detected by the "/" prefix — POSIX names may legally contain
// backslashes, so scanning for "\" would misclassify those.
function buildBreadcrumbs(fullPath: string): { crumbs: Crumb[]; sep: string; isPosix: boolean } {
  const isPosix = fullPath.startsWith('/');
  const sep = isPosix ? '/' : '\\';
  // On POSIX, split only on "/" so names containing "\" stay intact
  const segments = fullPath.split(isPosix ? '/' : /[\\/]/).filter(Boolean);
  const crumbs: Crumb[] = [];

  if (!isPosix && /^[\\/]{2}/.test(fullPath)) {
    // UNC path: "\\server\share" is the smallest navigable root — a bare
    // "\\server" is not listable, so the pair forms a single root crumb.
    const [server, share, ...rest] = segments;
    if (server) {
      const root = share ? `\\\\${server}\\${share}` : `\\\\${server}`;
      crumbs.push({ label: root, path: root });
      for (const seg of rest) {
        crumbs.push({ label: seg, path: crumbs[crumbs.length - 1].path + sep + seg });
      }
    }
    return { crumbs, sep, isPosix };
  }

  for (const seg of segments) {
    const prev = crumbs[crumbs.length - 1]?.path;
    // First segment: "/seg" on POSIX, "C:\" (the drive itself) on Windows
    const path =
      prev === undefined
        ? isPosix
          ? sep + seg
          : seg + sep
        : prev.endsWith(sep)
          ? prev + seg
          : prev + sep + seg;
    crumbs.push({ label: seg, path });
  }
  return { crumbs, sep, isPosix };
}

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

  // Abort any in-flight directory request on unmount so its .then can't fire
  // against an unmounted component.
  useEffect(() => () => abortRef.current?.abort(), []);

  const {
    crumbs: breadcrumbs,
    sep,
    isPosix,
  } = listing ? buildBreadcrumbs(listing.path) : { crumbs: [], sep: '/', isPosix: true };

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
              {/* On Windows the first crumb is the drive/UNC root, so no "/" button */}
              {isPosix && (
                <button
                  type="button"
                  className={styles.crumb}
                  onClick={() => navigate('/')}
                  title="/"
                >
                  /
                </button>
              )}
              {breadcrumbs.map((c, i) => (
                <span key={c.path}>
                  {(isPosix || i > 0) && <span className={styles.crumbSep}>{sep}</span>}
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
