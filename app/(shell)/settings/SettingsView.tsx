'use client';

import { useEffect, useRef, useState } from 'react';

import type { PostDownloadScript, Settings } from '../../lib/api';
import {
  addScript,
  getScripts,
  getSettings,
  patchSettings,
  removeScript,
  reorderScript,
  triggerRescan,
} from '../../lib/api';

import styles from './settings.module.css';

// ── sub-components ────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

function SaveButton({ saving, saved }: { saving: boolean; saved: boolean }) {
  return (
    <button type="submit" className="btn btn-primary" disabled={saving}>
      {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
    </button>
  );
}

// ── Profile section ───────────────────────────────────────────────────────────

function ProfileSection({ initial }: { initial: Settings }) {
  const [name, setName] = useState(initial.name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    patchSettings({ name: name.trim() })
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <Section title="Profile">
      <form className={styles.form} onSubmit={handleSubmit}>
        <label className={styles.field}>
          <span className={styles.label}>Display name</span>
          <input
            className="input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
          />
        </label>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.formFooter}>
          <SaveButton saving={saving} saved={saved} />
        </div>
      </form>
    </Section>
  );
}

// ── Privacy section ───────────────────────────────────────────────────────────

function PrivacySection({ initial }: { initial: Settings }) {
  const [fromAnyone, setFromAnyone] = useState(initial.autoAcceptFromAnyone);
  const [fromFriends, setFromFriends] = useState(initial.autoAcceptFromFriendsOfFriends);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [hasPassword, setHasPassword] = useState(initial.hasInvitePassword);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);

    const invitePassword = clearPassword ? null : password.trim() || undefined;

    patchSettings({
      autoAcceptFromAnyone: fromAnyone,
      autoAcceptFromFriendsOfFriends: fromFriends,
      invitePassword,
    })
      .then((updated) => {
        setHasPassword(updated.hasInvitePassword);
        setPassword('');
        setClearPassword(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <Section title="Friends &amp; Privacy">
      <form className={styles.form} onSubmit={handleSubmit}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={fromAnyone}
            onChange={(e) => setFromAnyone(e.target.checked)}
          />
          <span>Auto-accept friend requests from anyone</span>
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={fromFriends}
            onChange={(e) => setFromFriends(e.target.checked)}
          />
          <span>Auto-accept friend requests from friends of friends</span>
        </label>

        <div className={styles.passwordGroup}>
          <label className={styles.field}>
            <span className={styles.label}>
              Invite password
              {hasPassword && !clearPassword && <span className={styles.badge}>set</span>}
            </span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (clearPassword) setClearPassword(false);
              }}
              placeholder={
                hasPassword ? 'Enter new password to change' : 'Set a password (optional)'
              }
              disabled={clearPassword}
            />
          </label>
          {hasPassword && (
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={clearPassword}
                onChange={(e) => {
                  setClearPassword(e.target.checked);
                  if (e.target.checked) setPassword('');
                }}
              />
              <span className={styles.dangerText}>Remove invite password</span>
            </label>
          )}
        </div>

        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.formFooter}>
          <SaveButton saving={saving} saved={saved} />
        </div>
      </form>
    </Section>
  );
}

// ── Files section ─────────────────────────────────────────────────────────────

function FilesSection({ initial }: { initial: Settings }) {
  const [folders, setFolders] = useState<string[]>(initial.sharedFolders);
  const [newFolder, setNewFolder] = useState('');
  const [downloadFolder, setDownloadFolder] = useState(initial.downloadFolder ?? '');
  const [rescanInterval, setRescanInterval] = useState(String(initial.rescanIntervalMinutes));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const newFolderRef = useRef<HTMLInputElement>(null);

  function addFolder() {
    const trimmed = newFolder.trim();
    if (!trimmed || folders.includes(trimmed)) return;
    setFolders((prev) => [...prev, trimmed]);
    setNewFolder('');
    newFolderRef.current?.focus();
  }

  function removeFolder(path: string) {
    setFolders((prev) => prev.filter((f) => f !== path));
  }

  function handleNewFolderKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addFolder();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const interval = parseInt(rescanInterval, 10);
    if (isNaN(interval) || interval < 0) {
      setError('Rescan interval must be 0 (disabled) or a positive number of minutes.');
      return;
    }
    setSaving(true);
    setError('');
    setSaved(false);

    patchSettings({
      sharedFolders: folders,
      downloadFolder: downloadFolder.trim() || null,
      rescanIntervalMinutes: interval,
    })
      .then(() => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <Section title="Files">
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.field}>
          <span className={styles.label}>Shared folders</span>
          <ul className={styles.folderList}>
            {folders.length === 0 && (
              <li className={styles.folderEmpty}>No shared folders configured.</li>
            )}
            {folders.map((f) => (
              <li key={f} className={styles.folderItem}>
                <span className={styles.folderPath}>{f}</span>
                <button
                  type="button"
                  className={`btn btn-ghost ${styles.removeBtn}`}
                  onClick={() => removeFolder(f)}
                  aria-label={`Remove ${f}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className={styles.addFolderRow}>
            <input
              ref={newFolderRef}
              className="input"
              type="text"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={handleNewFolderKey}
              placeholder="/path/to/folder"
            />
            <button type="button" className="btn btn-ghost" onClick={addFolder}>
              Add
            </button>
          </div>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>Download folder</span>
          <input
            className="input"
            type="text"
            value={downloadFolder}
            onChange={(e) => setDownloadFolder(e.target.value)}
            placeholder="/path/to/downloads"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Rescan interval</span>
          <div className={styles.intervalRow}>
            <input
              className={`input ${styles.intervalInput}`}
              type="number"
              min="0"
              max="35791"
              value={rescanInterval}
              onChange={(e) => setRescanInterval(e.target.value)}
            />
            <span className={styles.intervalUnit}>minutes (0 = disabled)</span>
          </div>
        </label>

        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.formFooter}>
          <SaveButton saving={saving} saved={saved} />
        </div>
      </form>
    </Section>
  );
}

// ── Scripts section ───────────────────────────────────────────────────────────

function ScriptsSection() {
  const [scripts, setScripts] = useState<PostDownloadScript[]>([]);
  const [newPath, setNewPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getScripts()
      .then(setScripts)
      .catch(() => {});
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const path = newPath.trim();
    if (!path) return;
    setAdding(true);
    setError('');
    try {
      const script = await addScript(path);
      setScripts((prev) => [...prev, script]);
      setNewPath('');
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add script');
    } finally {
      setAdding(false);
    }
  }

  async function handleReorder(id: string, direction: 'up' | 'down') {
    try {
      const updated = await reorderScript(id, direction);
      if (updated.length > 0) setScripts(updated);
    } catch {
      // ignore transient errors
    }
  }

  async function handleRemove(id: string) {
    try {
      await removeScript(id);
      setScripts((prev) => prev.filter((s) => s.id !== id));
    } catch {
      // ignore transient errors
    }
  }

  return (
    <Section title="Post-download scripts">
      <div className={styles.form}>
        <p className={styles.hint}>
          Scripts run in order after each download completes. Each script must be a <code>.ts</code>{' '}
          or <code>.js</code> file with a default-exported async function:
        </p>
        <pre
          className={styles.codeHint}
        >{`export default async function({ file, stats }) {\n  // file: BunFile — the downloaded file\n  // stats: TransferStats — download metadata\n  // return a BunFile to update the file reference for subsequent scripts\n  // return false to stop subsequent scripts from running\n}`}</pre>

        {scripts.length > 0 && (
          <ul className={styles.folderList}>
            {scripts.map((s, i) => (
              <li key={s.id} className={styles.folderItem}>
                <span className={styles.folderPath}>{s.path}</span>
                <div className={styles.scriptActions}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handleReorder(s.id, 'up')}
                    disabled={i === 0}
                    aria-label="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handleReorder(s.id, 'down')}
                    disabled={i === scripts.length - 1}
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={`btn btn-ghost ${styles.removeBtn}`}
                    onClick={() => handleRemove(s.id)}
                    aria-label={`Remove ${s.path}`}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleAdd} className={styles.addFolderRow}>
          <input
            ref={inputRef}
            className="input"
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="/path/to/script.ts"
            disabled={adding}
          />
          <button type="submit" className="btn btn-ghost" disabled={adding || !newPath.trim()}>
            {adding ? 'Adding…' : 'Add'}
          </button>
        </form>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    </Section>
  );
}

// ── Maintenance section ───────────────────────────────────────────────────────

function MaintenanceSection() {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<{ indexed: number; removed: number } | null>(null);
  const [error, setError] = useState('');

  function handleRescan() {
    setScanning(true);
    setResult(null);
    setError('');
    triggerRescan()
      .then((r) => setResult(r))
      .catch((err: Error) => setError(err.message))
      .finally(() => setScanning(false));
  }

  return (
    <Section title="Maintenance">
      <div className={styles.form}>
        <p className={styles.hint}>
          Trigger an immediate rescan of your shared folders to pick up new or changed files.
        </p>
        <div className={styles.formFooter}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleRescan}
            disabled={scanning}
          >
            {scanning ? 'Scanning…' : 'Rescan now'}
          </button>
          {result && (
            <span className={styles.rescanResult}>
              Done — {result.indexed} file{result.indexed !== 1 ? 's' : ''} indexed,{' '}
              {result.removed} removed
            </span>
          )}
          {error && <span className={styles.error}>{error}</span>}
        </div>
      </div>
    </Section>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    getSettings()
      .then((s) => {
        if (active) setSettings(s);
      })
      .catch(() => {
        if (active) setLoadError('Could not load settings. Is the server running?');
      });
    return () => {
      active = false;
    };
  }, []);

  if (loadError) return <p className={styles.loadError}>{loadError}</p>;
  if (!settings) return <p className={styles.loading}>Loading…</p>;

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>Settings</h1>
      <ProfileSection initial={settings} />
      <PrivacySection initial={settings} />
      <FilesSection initial={settings} />
      <ScriptsSection />
      <MaintenanceSection />
    </div>
  );
}
