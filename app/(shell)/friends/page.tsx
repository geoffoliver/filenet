'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AddFriendParams, Friend } from '../../lib/api';
import {
  acceptFriend,
  addFriend,
  formatBytes,
  getFriends,
  rejectFriend,
  removeFriend,
} from '../../lib/api';

import styles from './friends.module.css';

type FormState = {
  name: string;
  address: string;
  port: string;
  password: string;
};

const DEFAULT_FORM: FormState = { name: '', address: '', port: '7734', password: '' };
const POLL_MS = 5_000;

function initials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);
  if (minutes < 1) return 'just now';
  if (hours < 1) return `${minutes}m ago`;
  if (days < 1) return `${hours}h ago`;
  if (weeks < 1) return `${days}d ago`;
  if (months < 1) return `${weeks}w ago`;
  if (years < 1) return `${months}mo ago`;
  return `${years}y ago`;
}

export default function FriendsPage() {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoadedRef = useRef(false);

  const loadFriends = useCallback(async () => {
    try {
      const data = await getFriends();
      if (!mountedRef.current) return;
      hasLoadedRef.current = true;
      setFriends(data);
      setLoadError('');
    } catch {
      // Only surface the error on initial load failure — poll errors after
      // first success are silent so a transient blip doesn't blank the list.
      if (mountedRef.current && !hasLoadedRef.current) {
        setLoadError('Could not load friends.');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    async function tick() {
      if (!mountedRef.current) return;
      await loadFriends();
      if (mountedRef.current) pollRef.current = setTimeout(tick, POLL_MS);
    }

    tick();
    return () => {
      mountedRef.current = false;
      if (pollRef.current !== null) clearTimeout(pollRef.current);
    };
  }, [loadFriends]);

  function setField(key: keyof FormState, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const port = parseInt(form.port, 10);
    if (!form.name.trim()) return setFormError('Name is required.');
    if (!form.address.trim()) return setFormError('Address is required.');
    if (isNaN(port) || port < 1 || port > 65535) return setFormError('Port must be 1–65535.');
    setSubmitting(true);
    setFormError('');
    try {
      const params: AddFriendParams = {
        name: form.name.trim(),
        address: form.address.trim(),
        port,
        ...(form.password.trim() ? { password: form.password.trim() } : {}),
      };
      const created = await addFriend(params);
      setFriends((f) => [...f, created]);
      setShowAddForm(false);
      setForm(DEFAULT_FORM);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to add friend.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAccept(id: string) {
    setActionId(id);
    try {
      const updated = await acceptFriend(id);
      setFriends((f) => f.map((fr) => (fr.id === id ? updated : fr)));
    } catch {
      // leave unchanged
    } finally {
      setActionId(null);
    }
  }

  async function handleReject(id: string) {
    setActionId(id);
    try {
      await rejectFriend(id);
      setFriends((f) => f.filter((fr) => fr.id !== id));
    } catch {
      // leave unchanged
    } finally {
      setActionId(null);
    }
  }

  async function handleRemove(id: string) {
    setActionId(id);
    setConfirmRemoveId(null);
    try {
      await removeFriend(id);
      setFriends((f) => f.filter((fr) => fr.id !== id));
    } catch {
      // leave unchanged
    } finally {
      setActionId(null);
    }
  }

  const incoming = friends.filter((f) => f.status === 'INCOMING_PENDING');
  const accepted = friends.filter((f) => f.status === 'ACCEPTED');
  const outgoing = friends.filter((f) => f.status === 'OUTGOING_PENDING');

  if (loading) {
    return (
      <div className={styles.page}>
        <p className={styles.empty}>Loading…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={styles.page}>
        <p className={styles.empty}>{loadError}</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Friends</h1>
        {!showAddForm && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setShowAddForm(true);
              setFormError('');
            }}
          >
            + Add Friend
          </button>
        )}
      </div>

      {showAddForm && (
        <form className={styles.addForm} onSubmit={handleAdd} noValidate>
          <h2 className={styles.addFormTitle}>Add a Friend</h2>
          <div className={styles.formGrid}>
            <div className="field">
              <label className="label" htmlFor="f-name">
                Name
              </label>
              <input
                id="f-name"
                className="input"
                type="text"
                placeholder="Alice"
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                autoFocus
                maxLength={200}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="f-address">
                Address
              </label>
              <input
                id="f-address"
                className="input"
                type="text"
                placeholder="192.168.1.42 or alice.example.com"
                value={form.address}
                onChange={(e) => setField('address', e.target.value)}
                maxLength={500}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="f-port">
                Port
              </label>
              <input
                id="f-port"
                className="input"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => setField('port', e.target.value)}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="f-password">
                Invite password <span className={styles.optional}>(optional)</span>
              </label>
              <input
                id="f-password"
                className="input"
                type="password"
                placeholder="Leave blank if none"
                value={form.password}
                onChange={(e) => setField('password', e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          {formError && <p className={styles.formError}>{formError}</p>}
          <div className={styles.formActions}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setShowAddForm(false);
                setForm(DEFAULT_FORM);
                setFormError('');
              }}
              disabled={submitting}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Adding…' : 'Add Friend'}
            </button>
          </div>
        </form>
      )}

      {incoming.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Incoming requests</h2>
          <ul className={styles.list}>
            {incoming.map((f) => (
              <li key={f.id} className={styles.card}>
                <div className={styles.avatarWrapper}>
                  <div className={styles.avatar}>{initials(f.name)}</div>
                </div>
                <div className={styles.info}>
                  <div className={styles.name}>{f.name}</div>
                  <div className={styles.meta}>
                    {f.address}:{f.port} · requested {timeAgo(f.addedAt)}
                  </div>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => handleAccept(f.id)}
                    disabled={actionId === f.id}
                  >
                    {actionId === f.id ? '…' : 'Accept'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handleReject(f.id)}
                    disabled={actionId === f.id}
                  >
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {accepted.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Friends</h2>
          <ul className={styles.list}>
            {accepted.map((f) => (
              <li key={f.id} className={styles.card}>
                <div className={styles.avatarWrapper}>
                  <div className={styles.avatar}>{initials(f.name)}</div>
                  {f.online && <span className={styles.onlineDot} role="img" aria-label="Online" />}
                </div>
                <div className={styles.info}>
                  <div className={styles.name}>{f.name}</div>
                  <div className={styles.meta}>
                    {f.address}:{f.port}
                    {f.acceptedAt && ` · friends since ${timeAgo(f.acceptedAt)}`}
                    {f.downloads.count > 0 &&
                      ` · ${f.downloads.count} file${f.downloads.count !== 1 ? 's' : ''} downloaded (${formatBytes(f.downloads.totalSize)})`}
                    {f.uploads.count > 0 &&
                      ` · ${f.uploads.count} file${f.uploads.count !== 1 ? 's' : ''} uploaded (${formatBytes(f.uploads.totalSize)})`}
                  </div>
                </div>
                <div className={styles.actions}>
                  {confirmRemoveId === f.id ? (
                    <>
                      <span className={styles.confirmLabel}>Remove?</span>
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => handleRemove(f.id)}
                        disabled={actionId === f.id}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => setConfirmRemoveId(null)}
                      >
                        No
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setConfirmRemoveId(f.id)}
                      disabled={actionId === f.id}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {outgoing.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Waiting for response</h2>
          <ul className={styles.list}>
            {outgoing.map((f) => (
              <li key={f.id} className={styles.card}>
                <div className={styles.avatarWrapper}>
                  <div className={styles.avatar}>{initials(f.name)}</div>
                </div>
                <div className={styles.info}>
                  <div className={styles.name}>{f.name}</div>
                  <div className={styles.meta}>
                    {f.address}:{f.port} · sent {timeAgo(f.addedAt)}
                  </div>
                </div>
                <div className={styles.actions}>
                  {confirmRemoveId === f.id ? (
                    <>
                      <span className={styles.confirmLabel}>Cancel request?</span>
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => handleRemove(f.id)}
                        disabled={actionId === f.id}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => setConfirmRemoveId(null)}
                      >
                        No
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setConfirmRemoveId(f.id)}
                      disabled={actionId === f.id}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {friends.length === 0 && !showAddForm && (
        <p className={styles.empty}>
          No friends yet. Click <strong>+ Add Friend</strong> to get started.
        </p>
      )}
    </div>
  );
}
