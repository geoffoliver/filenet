'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import FolderPicker from '../../components/FolderPicker/FolderPicker';

import {
  type NotificationPermissionState,
  getNotificationPermission,
  requestNotificationPermission,
} from '../../lib/notifications';
import type { PostDownloadScript, Settings, UpdatePhase, UpdateStatus } from '../../lib/api';
import {
  addScript,
  checkForUpdate,
  getScripts,
  getSettings,
  getUpdateStatus,
  patchSettings,
  removeScript,
  reorderScript,
  restartToUpdate,
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

// Tabs hide (not unmount) a section, so a draft in a section the user isn't
// currently looking at is easy to forget about entirely — see the dot on
// its tab (SettingsView's dirtyTabs) and the leave-page warning
// (SettingsView's beforeunload effect), both driven by this. Every section
// with its own Save button reports its dirty state here; sections whose
// actions are all immediate (Scripts, Maintenance, Notifications — nothing
// to lose by switching tabs) don't call this at all.
function useReportDirty(isDirty: boolean, onDirtyChange: (dirty: boolean) => void) {
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);
}

// ── Profile section ───────────────────────────────────────────────────────────

function ProfileSection({
  initial,
  onDirtyChange,
}: {
  initial: Settings;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [savedName, setSavedName] = useState(initial.name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useReportDirty(name.trim() !== savedName, onDirtyChange);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    const trimmed = name.trim();
    patchSettings({ name: trimmed })
      .then(() => {
        setSavedName(trimmed);
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

function PrivacySection({
  initial,
  onDirtyChange,
}: {
  initial: Settings;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [fromAnyone, setFromAnyone] = useState(initial.autoAcceptFromAnyone);
  const [savedFromAnyone, setSavedFromAnyone] = useState(initial.autoAcceptFromAnyone);
  const [fromFriends, setFromFriends] = useState(initial.autoAcceptFromFriendsOfFriends);
  const [savedFromFriends, setSavedFromFriends] = useState(initial.autoAcceptFromFriendsOfFriends);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [hasPassword, setHasPassword] = useState(initial.hasInvitePassword);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useReportDirty(
    fromAnyone !== savedFromAnyone ||
      fromFriends !== savedFromFriends ||
      password.trim() !== '' ||
      clearPassword,
    onDirtyChange,
  );

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
        setSavedFromAnyone(fromAnyone);
        setSavedFromFriends(fromFriends);
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

function FilesSection({
  initial,
  onDirtyChange,
}: {
  initial: Settings;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [folders, setFolders] = useState<string[]>(initial.sharedFolders);
  const [savedFolders, setSavedFolders] = useState<string[]>(initial.sharedFolders);
  const [newFolder, setNewFolder] = useState('');
  const [downloadFolder, setDownloadFolder] = useState(initial.downloadFolder ?? '');
  const [savedDownloadFolder, setSavedDownloadFolder] = useState(initial.downloadFolder ?? '');
  const [rescanInterval, setRescanInterval] = useState(String(initial.rescanIntervalMinutes));
  const [savedRescanInterval, setSavedRescanInterval] = useState(
    String(initial.rescanIntervalMinutes),
  );
  const [fileWatcherEnabled, setFileWatcherEnabled] = useState(initial.enableFileWatcher);
  const [savedFileWatcherEnabled, setSavedFileWatcherEnabled] = useState(initial.enableFileWatcher);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const folderInputRef = useRef<HTMLInputElement>(null);

  useReportDirty(
    newFolder.trim() !== '' ||
      downloadFolder !== savedDownloadFolder ||
      rescanInterval !== savedRescanInterval ||
      fileWatcherEnabled !== savedFileWatcherEnabled ||
      folders.length !== savedFolders.length ||
      folders.some((f, i) => f !== savedFolders[i]),
    onDirtyChange,
  );

  function addFolder(pathOverride?: string) {
    const trimmed = (pathOverride ?? newFolder).trim();
    if (!trimmed || folders.includes(trimmed)) return;
    setFolders((prev) => [...prev, trimmed]);
    setNewFolder('');
    folderInputRef.current?.focus();
  }

  function removeFolder(path: string) {
    setFolders((prev) => prev.filter((f) => f !== path));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const interval = parseInt(rescanInterval, 10);
    if (isNaN(interval) || interval < 0 || interval > 35791) {
      setError('Rescan interval must be 0 (disabled) or a number of minutes up to 35791.');
      return;
    }
    setSaving(true);
    setError('');
    setSaved(false);

    patchSettings({
      sharedFolders: folders,
      downloadFolder: downloadFolder.trim() || null,
      rescanIntervalMinutes: interval,
      enableFileWatcher: fileWatcherEnabled,
    })
      .then(() => {
        setSavedFolders(folders);
        setSavedDownloadFolder(downloadFolder);
        setSavedRescanInterval(rescanInterval);
        setSavedFileWatcherEnabled(fileWatcherEnabled);
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
            <FolderPicker
              value={newFolder}
              onChange={setNewFolder}
              onSelect={(p) => addFolder(p)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addFolder();
                }
              }}
              inputRef={folderInputRef}
              placeholder="/path/to/folder"
            />
            <button type="button" className="btn btn-ghost" onClick={() => addFolder()}>
              Add
            </button>
          </div>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>Download folder</span>
          <FolderPicker
            value={downloadFolder}
            onChange={setDownloadFolder}
            placeholder="/path/to/downloads"
          />
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

        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={fileWatcherEnabled}
            onChange={(e) => setFileWatcherEnabled(e.target.checked)}
          />
          <span>React to file changes as they happen (file watcher)</span>
        </label>
        <p className={styles.hint}>
          <strong>Restart required</strong> — on some systems the native file watcher can misbehave
          (e.g. spinning CPU on Intel Macs). Turning this off falls back to periodic scans on the
          interval above (or the manual &ldquo;Rescan now&rdquo; button in Maintenance) and takes
          effect the next time the server starts.
        </p>

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

function NetworkingSection({
  initial,
  onDirtyChange,
}: {
  initial: Settings;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [port, setPort] = useState(String(initial.listenPort));
  const [savedPort, setSavedPort] = useState(initial.listenPort);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useReportDirty(port !== String(savedPort), onDirtyChange);

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

// ── Startup section ───────────────────────────────────────────────────────────

function StartupSection({
  initial,
  onDirtyChange,
}: {
  initial: Settings;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [autoOpen, setAutoOpen] = useState(initial.autoOpenBrowser);
  const [savedAutoOpen, setSavedAutoOpen] = useState(initial.autoOpenBrowser);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useReportDirty(autoOpen !== savedAutoOpen, onDirtyChange);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    patchSettings({ autoOpenBrowser: autoOpen })
      .then(() => {
        setSavedAutoOpen(autoOpen);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }

  return (
    <Section title="Startup">
      <form className={styles.form} onSubmit={handleSubmit}>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={autoOpen}
            onChange={(e) => setAutoOpen(e.target.checked)}
          />
          <span>Automatically open the app in your browser on start</span>
        </label>

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
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState('');

  function handleRescan() {
    setStarting(true);
    setStarted(false);
    setError('');
    triggerRescan()
      .then(() => setStarted(true))
      .catch((err: Error) => setError(err.message))
      .finally(() => setStarting(false));
  }

  return (
    <Section title="Maintenance">
      <div className={styles.form}>
        <p className={styles.hint}>
          Trigger an immediate rescan of your shared folders to pick up new or changed files. Scans
          run in the background — newly indexed files show up in Search and Home as they&apos;re
          found.
        </p>
        <div className={styles.formFooter}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleRescan}
            disabled={starting}
          >
            {starting ? 'Starting…' : 'Rescan now'}
          </button>
          {started && <span className={styles.rescanResult}>Scan started</span>}
          {error && <span className={styles.error}>{error}</span>}
        </div>
      </div>
    </Section>
  );
}

// ── Updates section ───────────────────────────────────────────────────────

const PHASE_LABEL: Record<UpdatePhase, (status: UpdateStatus) => string> = {
  idle: () => 'Up to date',
  checking: () => 'Checking…',
  available: (s) =>
    s.mode === 'source' ? `Update available: v${s.latestVersion}` : 'Update available…',
  downloading: () => 'Downloading…',
  ready: (s) => `Update ready: v${s.latestVersion}`,
  error: (s) => `Error: ${s.error ?? 'unknown error'}`,
};

function UpdatesSection({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [repo, setRepo] = useState('');
  const [savedRepo, setSavedRepo] = useState('');
  const [interval, setIntervalMinutes] = useState('');
  const [savedInterval, setSavedInterval] = useState('');
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Unlike the other sections, there's no `initial` prop to seed a baseline
  // from — this section loads its own settings asynchronously below, so the
  // baseline starts out just as empty as the live fields and both get set
  // together once that load resolves.
  useReportDirty(repo !== savedRepo || interval !== savedInterval, onDirtyChange);

  useEffect(() => {
    let active = true;
    Promise.all([getUpdateStatus(), getSettings()])
      .then(([s, settingsRow]) => {
        if (!active) return;
        setStatus(s);
        setRepo(settingsRow.updateRepo);
        setSavedRepo(settingsRow.updateRepo);
        setIntervalMinutes(String(settingsRow.updateCheckIntervalMinutes));
        setSavedInterval(String(settingsRow.updateCheckIntervalMinutes));
      })
      .catch(() => {
        if (active) setError('Could not load update status.');
      });
    return () => {
      active = false;
    };
  }, []);

  function handleCheck() {
    setChecking(true);
    setError('');
    checkForUpdate()
      .then(setStatus)
      .catch((err: Error) => setError(err.message))
      .finally(() => setChecking(false));
  }

  function handleRestart() {
    if (
      !window.confirm(
        'Filenet will briefly go offline while it restarts on the new version. Continue?',
      )
    ) {
      return;
    }
    setRestarting(true);
    setError('');
    // The server process exits right after accepting this request — leave
    // `restarting` true rather than clearing it in a .finally(); the page
    // will need a manual reload once the new version is back up.
    restartToUpdate().catch((err: Error) => {
      setError(err.message);
      setRestarting(false);
    });
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    const parsedInterval = parseInt(interval, 10);
    if (isNaN(parsedInterval) || parsedInterval < 0 || parsedInterval > 35791) {
      setError('Check interval must be 0 (disabled) or a number of minutes up to 35791.');
      return;
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim())) {
      setError('Repository must be in the form owner/repo.');
      return;
    }
    setSaving(true);
    setError('');
    setSaved(false);
    patchSettings({ updateRepo: repo.trim(), updateCheckIntervalMinutes: parsedInterval })
      .then(() => {
        setSavedRepo(repo);
        setSavedInterval(interval);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }

  if (error && !status) {
    return (
      <Section title="Updates">
        <p className={styles.error}>{error}</p>
      </Section>
    );
  }
  if (!status) return null;

  return (
    <Section title="Updates">
      <div className={styles.form}>
        <p className={styles.hint}>
          Running <strong>v{status.currentVersion}</strong> — {PHASE_LABEL[status.phase](status)}
        </p>

        {status.mode === 'source' ? (
          <p className={styles.hint}>
            Running from source — update by pulling the latest image or code.
          </p>
        ) : (
          <div className={styles.formFooter}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleCheck}
              disabled={checking}
            >
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
            {status.phase === 'ready' && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleRestart}
                disabled={restarting}
              >
                {restarting ? 'Restarting…' : `Restart to update v${status.latestVersion}`}
              </button>
            )}
          </div>
        )}

        <form className={styles.form} onSubmit={handleSaveSettings}>
          <label className={styles.field}>
            <span className={styles.label}>Update repository</span>
            <input
              className="input"
              type="text"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/repo"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Check interval</span>
            <div className={styles.intervalRow}>
              <input
                className={`input ${styles.intervalInput}`}
                type="number"
                min="0"
                max="35791"
                value={interval}
                onChange={(e) => setIntervalMinutes(e.target.value)}
              />
              <span className={styles.intervalUnit}>minutes (0 = disabled)</span>
            </div>
          </label>
          {error && <p className={styles.error}>{error}</p>}
          <div className={styles.formFooter}>
            <SaveButton saving={saving} saved={saved} />
          </div>
        </form>
      </div>
    </Section>
  );
}

// ── Notifications section ───────────────────────────────────────────────────

function NotificationsSection() {
  const [permission, setPermission] = useState<NotificationPermissionState | 'loading'>('loading');
  // Shared across the mount effect and handleEnable — either one's deferred
  // setPermission() must become a no-op once the section unmounts.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    // Deferred a microtask, not called synchronously: reading Notification
    // must stay client-only (the server always sees it as undefined, so a
    // direct read here would mismatch hydration), and a bare synchronous
    // setState in an effect body trips this project's
    // react-hooks/set-state-in-effect lint rule.
    Promise.resolve().then(() => {
      if (mountedRef.current) setPermission(getNotificationPermission());
    });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleEnable() {
    const result = await requestNotificationPermission();
    if (mountedRef.current) setPermission(result);
  }

  return (
    <Section title="Notifications">
      <div className={styles.form}>
        {/* 'loading' renders nothing — avoids briefly flashing an incorrect
            status (e.g. "not supported") before the client-only permission
            read resolves, one tick after mount. */}
        {permission === 'unsupported' && (
          <p className={styles.hint}>Desktop notifications are not supported in this browser.</p>
        )}
        {permission === 'granted' && (
          <p className={styles.hint}>Desktop notifications are enabled.</p>
        )}
        {permission === 'denied' && (
          <p className={styles.hint}>
            Desktop notifications are blocked. Check your browser&apos;s site settings to enable
            them.
          </p>
        )}
        {permission === 'default' && (
          <div className={styles.formFooter}>
            <button type="button" className="btn btn-primary" onClick={handleEnable}>
              Enable desktop notifications
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
// The settings page grew to nine sections, each a full form in its own
// right — showing them all stacked on one long page made the ones near the
// bottom easy to miss. Tabs give each section its own moment without
// touching any section's own internals.
//
// Every section stays mounted the whole time (hidden via the native
// `hidden` attribute, not conditionally rendered) specifically so switching
// tabs can never discard an in-progress edit in a section the user hasn't
// saved yet — each section already manages its own draft state
// independently and only submits on its own Save click.

const TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'privacy', label: 'Friends & Privacy' },
  { id: 'files', label: 'Files' },
  { id: 'networking', label: 'Networking' },
  { id: 'startup', label: 'Startup' },
  { id: 'scripts', label: 'Scripts' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'updates', label: 'Updates' },
  { id: 'notifications', label: 'Notifications' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function TabList({
  activeTab,
  onSelect,
  dirtyTabs,
}: {
  activeTab: TabId;
  onSelect: (id: TabId) => void;
  dirtyTabs: ReadonlySet<TabId>;
}) {
  // Roving tabindex + arrow-key navigation with automatic activation, per
  // the WAI-ARIA APG tabs pattern: only the active tab is in the regular
  // tab order, and Up/Down/Home/End move focus *and* select in one step.
  // (Up/Down, not Left/Right, since this is a vertical tab list —
  // aria-orientation="vertical" below sets the same expectation for AT.)
  function handleKeyDown(e: React.KeyboardEvent) {
    const currentIndex = TABS.findIndex((t) => t.id === activeTab);
    let nextIndex: number | null = null;
    if (e.key === 'ArrowDown') nextIndex = (currentIndex + 1) % TABS.length;
    else if (e.key === 'ArrowUp') nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    const next = TABS[nextIndex];
    onSelect(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  }

  return (
    <div
      className={styles.tabList}
      role="tablist"
      aria-label="Settings sections"
      aria-orientation="vertical"
    >
      {TABS.map((tab) => {
        const selected = tab.id === activeTab;
        const dirty = dirtyTabs.has(tab.id);
        return (
          <button
            key={tab.id}
            id={`settings-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`settings-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            className={`${styles.tab} ${selected ? styles.tabActive : ''}`}
            onClick={() => onSelect(tab.id)}
            onKeyDown={handleKeyDown}
          >
            {tab.label}
            {dirty && (
              <span
                className={styles.dirtyDot}
                aria-label="Unsaved changes"
                title="Unsaved changes"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function TabPanel({
  id,
  activeTab,
  children,
}: {
  id: TabId;
  activeTab: TabId;
  children: React.ReactNode;
}) {
  return (
    <div
      id={`settings-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`settings-tab-${id}`}
      hidden={activeTab !== id}
      className={styles.tabPanel}
    >
      {children}
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [activeTab, setActiveTab] = useState<TabId>('profile');
  const [dirtyTabs, setDirtyTabs] = useState<Set<TabId>>(new Set());

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

  const handleDirtyChange = useCallback((tabId: TabId, dirty: boolean) => {
    setDirtyTabs((prev) => {
      if (prev.has(tabId) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  }, []);

  // Tabs only hide a dirty section, they never discard it — but leaving the
  // page entirely (closing the tab, reloading, navigating elsewhere) would.
  // The dot on each tab is the primary signal; this is the backstop for
  // when the browser itself is about to throw the draft away.
  useEffect(() => {
    if (dirtyTabs.size === 0) return;
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      // Both are needed: Chrome (and older browsers generally) only
      // prompts if returnValue is set, while preventDefault() is the
      // current spec's documented way of triggering it.
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirtyTabs]);

  if (loadError) return <p className={styles.loadError}>{loadError}</p>;
  if (!settings) return <p className={styles.loading}>Loading…</p>;

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>Settings</h1>
      <div className={styles.settings}>
        <TabList activeTab={activeTab} onSelect={setActiveTab} dirtyTabs={dirtyTabs} />
        <TabPanel id="profile" activeTab={activeTab}>
          <ProfileSection
            initial={settings}
            onDirtyChange={(dirty) => handleDirtyChange('profile', dirty)}
          />
        </TabPanel>
        <TabPanel id="privacy" activeTab={activeTab}>
          <PrivacySection
            initial={settings}
            onDirtyChange={(dirty) => handleDirtyChange('privacy', dirty)}
          />
        </TabPanel>
        <TabPanel id="files" activeTab={activeTab}>
          <FilesSection
            initial={settings}
            onDirtyChange={(dirty) => handleDirtyChange('files', dirty)}
          />
        </TabPanel>
        <TabPanel id="networking" activeTab={activeTab}>
          <NetworkingSection
            initial={settings}
            onDirtyChange={(dirty) => handleDirtyChange('networking', dirty)}
          />
        </TabPanel>
        <TabPanel id="startup" activeTab={activeTab}>
          <StartupSection
            initial={settings}
            onDirtyChange={(dirty) => handleDirtyChange('startup', dirty)}
          />
        </TabPanel>
        <TabPanel id="scripts" activeTab={activeTab}>
          <ScriptsSection />
        </TabPanel>
        <TabPanel id="maintenance" activeTab={activeTab}>
          <MaintenanceSection />
        </TabPanel>
        <TabPanel id="updates" activeTab={activeTab}>
          <UpdatesSection onDirtyChange={(dirty) => handleDirtyChange('updates', dirty)} />
        </TabPanel>
        <TabPanel id="notifications" activeTab={activeTab}>
          <NotificationsSection />
        </TabPanel>
      </div>
    </div>
  );
}
