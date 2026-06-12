'use client';

import { useEffect, useRef, useState } from 'react';

import type { EnvConfig, PostDownloadScript, Settings } from '../../lib/api';
import {
  addScript,
  getEnvConfig,
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

function FilesSection({ initial, envConfig }: { initial: Settings; envConfig: EnvConfig }) {
  const foldersLocked = envConfig.sharedFolders.length > 0;
  const downloadLocked = envConfig.downloadFolder !== null;

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
      ...(!foldersLocked && { sharedFolders: folders }),
      ...(!downloadLocked && { downloadFolder: downloadFolder.trim() || null }),
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
          {foldersLocked ? (
            <>
              <ul className={styles.folderList}>
                {initial.sharedFolders.map((f) => (
                  <li key={f} className={styles.folderItem}>
                    <span className={styles.folderPath}>{f}</span>
                  </li>
                ))}
              </ul>
              <p className={styles.hint}>
                Set via <code>SHARED_FOLDERS</code> environment variable. To change, update your
                deployment configuration and restart.
              </p>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>

        <div className={styles.field}>
          <span className={styles.label}>Download folder</span>
          {downloadLocked ? (
            <>
              <p className={styles.folderPath}>{initial.downloadFolder}</p>
              <p className={styles.hint}>
                Set via <code>DOWNLOAD_FOLDER</code> environment variable. To change, update your
                deployment configuration and restart.
              </p>
            </>
          ) : (
            <input
              className="input"
              type="text"
              value={downloadFolder}
              onChange={(e) => setDownloadFolder(e.target.value)}
              placeholder="/path/to/downloads"
            />
          )}
        </div>

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
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load scripts'));
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
    setError('');
    try {
      setScripts(await reorderScript(id, direction));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reorder script');
    }
  }

  async function handleRemove(id: string) {
    setError('');
    try {
      await removeScript(id);
      setScripts((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove script');
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
                    aria-label={`Move ${s.path} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handleReorder(s.id, 'down')}
                    disabled={i === scripts.length - 1}
                    aria-label={`Move ${s.path} down`}
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

// ── Networking section ────────────────────────────────────────────────────────

function NetworkingSection({ initial }: { initial: Settings }) {
  const [port, setPort] = useState(String(initial.listenPort));
  const [savedPort, setSavedPort] = useState(initial.listenPort);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const parsedPort = Number(port);
  const displayPort =
    Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
      ? String(parsedPort)
      : String(savedPort);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      setError('Port must be a number between 1 and 65535.');
      return;
    }
    setSaving(true);
    setError('');
    setSaved(false);
    patchSettings({ listenPort: parsed })
      .then((updated) => {
        setSavedPort(updated.listenPort);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <Section title="Networking">
      <form className={styles.form} onSubmit={handleSubmit}>
        <label className={styles.field}>
          <span className={styles.label}>Listening port</span>
          <div className={styles.intervalRow}>
            <input
              className={`input ${styles.intervalInput}`}
              type="number"
              min="1"
              max="65535"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
        </label>
        <p className={styles.hint}>
          <strong>Restart required</strong> — port changes take effect the next time the server
          starts.
        </p>

        <div className={styles.portForwarding}>
          <p className={styles.label}>Port forwarding</p>
          <p className={styles.hint}>
            For friends outside your local network to connect, forward this port on your router:
          </p>
          <ol className={styles.forwardingSteps}>
            <li>
              Find your local IP address — run <code>hostname -I</code> (Linux/Mac) or{' '}
              <code>ipconfig</code> (Windows) and look for your network adapter&apos;s IPv4 address.
            </li>
            <li>
              Open your router&apos;s admin panel (usually <code>http://192.168.1.1</code> or{' '}
              <code>http://192.168.0.1</code>).
            </li>
            <li>
              Find the <strong>Port Forwarding</strong> section (may be labeled &ldquo;Virtual
              Servers&rdquo;, &ldquo;NAT&rdquo;, or &ldquo;Applications &amp; Gaming&rdquo;).
            </li>
            <li>
              Add a rule: external port <strong>{displayPort}</strong>, internal IP{' '}
              <em>your local IP</em>, internal port <strong>{displayPort}</strong>, protocol{' '}
              <strong>TCP</strong>.
            </li>
            <li>Save and apply.</li>
          </ol>
        </div>

        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.formFooter}>
          <SaveButton saving={saving} saved={saved} />
        </div>
      </form>
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
  const [envConfig, setEnvConfig] = useState<EnvConfig>({
    sharedFolders: [],
    downloadFolder: null,
  });
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([getSettings(), getEnvConfig()])
      .then(([s, env]) => {
        if (active) {
          setSettings(s);
          setEnvConfig(env);
        }
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
      <FilesSection initial={settings} envConfig={envConfig} />
      <NetworkingSection initial={settings} />
      <ScriptsSection />
      <MaintenanceSection />
    </div>
  );
}
