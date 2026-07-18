'use client';

import { getSettings, patchSettings } from '../lib/api';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import FolderPicker from '../components/FolderPicker/FolderPicker';

import styles from './setup.module.css';

type WizardState = {
  name: string;
  sharedFolders: string[];
  downloadFolder: string;
  listenPort: string;
  autoAcceptFromAnyone: boolean;
  autoAcceptFromFriendsOfFriends: boolean;
  invitePassword: string;
};

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [folderInput, setFolderInput] = useState('');

  const [state, setState] = useState<WizardState>({
    name: '',
    sharedFolders: [],
    downloadFolder: '',
    listenPort: '7734',
    autoAcceptFromAnyone: false,
    autoAcceptFromFriendsOfFriends: false,
    invitePassword: '',
  });

  useEffect(() => {
    getSettings()
      .catch(() => null)
      .then((settings) => {
        if (settings) {
          setState((s) => ({
            ...s,
            sharedFolders: settings.sharedFolders,
            downloadFolder: settings.downloadFolder ?? '',
            listenPort: String(settings.listenPort),
          }));
        }
      });
  }, []);

  const activeSteps = [1, 2, 3, 4, 5, 6];

  const stepIndex = activeSteps.indexOf(step);
  const isLastStep = stepIndex === activeSteps.length - 1;

  function set<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  function addFolder(pathOverride?: string) {
    const path = (pathOverride ?? folderInput).trim();
    if (!path || state.sharedFolders.includes(path)) return;
    set('sharedFolders', [...state.sharedFolders, path]);
    setFolderInput('');
  }

  function removeFolder(path: string) {
    set(
      'sharedFolders',
      state.sharedFolders.filter((f) => f !== path),
    );
  }

  function canAdvance(): boolean {
    if (step === 2 && !state.name.trim()) return false;
    if (step === 5) {
      const p = Number(state.listenPort);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return false;
    }
    return true;
  }

  function goNext() {
    if (!canAdvance()) return;
    setError('');
    if (isLastStep) {
      finish();
    } else {
      setStep(activeSteps[stepIndex + 1]);
    }
  }

  function goBack() {
    setError('');
    setStep(activeSteps[stepIndex - 1]);
  }

  function skipStep() {
    setStep(activeSteps[stepIndex + 1]);
  }

  async function finish() {
    setSaving(true);
    setError('');
    try {
      await patchSettings({
        name: state.name.trim(),
        sharedFolders: state.sharedFolders,
        downloadFolder: state.downloadFolder.trim() || null,
        listenPort: (() => {
          const p = Number(state.listenPort);
          return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : 7734;
        })(),
        autoAcceptFromAnyone: state.autoAcceptFromAnyone,
        autoAcceptFromFriendsOfFriends: state.autoAcceptFromFriendsOfFriends,
        invitePassword: state.invitePassword.trim() || null,
      });
      router.push('/home');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setSaving(false);
    }
  }

  // Progress and label are based on position in activeSteps, not raw step number.
  const progress = (stepIndex / (activeSteps.length - 1)) * 100;
  const visibleStepNum = stepIndex + 1;
  const visibleTotal = activeSteps.length - 1;

  const portPreviewNum = Number(state.listenPort);
  const portPreview =
    Number.isInteger(portPreviewNum) && portPreviewNum >= 1 && portPreviewNum <= 65535
      ? String(portPreviewNum)
      : '7734';

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.progress}>
          <div className={styles.progressFill} style={{ width: `${progress}%` }} />
        </div>

        <div className={styles.body}>
          {!isLastStep && (
            <p className={styles.stepLabel}>
              Step {visibleStepNum} of {visibleTotal}
            </p>
          )}

          {/* ── Step 1: Welcome ─────────────────────────────────────────── */}
          {step === 1 && (
            <>
              <h1 className={styles.title}>Welcome to Filenet</h1>
              <p className={styles.description}>
                Filenet is a self-hosted P2P application for sharing files and chatting with friends
                — no central server, no accounts, no tracking. Everything stays between you and the
                people you choose to connect with.
                <br />
                <br />
                This wizard will walk you through the basic setup. It only takes a minute.
              </p>
            </>
          )}

          {/* ── Step 2: Your name ───────────────────────────────────────── */}
          {step === 2 && (
            <>
              <h1 className={styles.title}>What should we call you?</h1>
              <p className={styles.description}>
                This name is shown to your friends when you connect with them. You can change it any
                time in Settings.
              </p>
              <div className="field">
                <label className="label" htmlFor="name">
                  Display name
                </label>
                <input
                  id="name"
                  className="input"
                  type="text"
                  placeholder="e.g. Alice"
                  value={state.name}
                  onChange={(e) => set('name', e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && goNext()}
                  autoFocus
                  maxLength={200}
                />
              </div>
            </>
          )}

          {/* ── Step 3: Shared folders ──────────────────────────────────── */}
          {step === 3 && (
            <>
              <h1 className={styles.title}>Which folders do you want to share?</h1>
              <p className={styles.description}>
                Files in these folders will be indexed and made searchable by your friends. You can
                add or remove folders at any time from Settings.
              </p>

              {state.sharedFolders.length > 0 && (
                <ul className={styles.folderList}>
                  {state.sharedFolders.map((f) => (
                    <li key={f} className={styles.folderItem}>
                      <span className={styles.folderPath}>{f}</span>
                      <button
                        type="button"
                        className={styles.folderRemove}
                        onClick={() => removeFolder(f)}
                        aria-label={`Remove ${f}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className={styles.addFolderRow}>
                <FolderPicker
                  value={folderInput}
                  onChange={setFolderInput}
                  onSelect={(p) => addFolder(p)}
                  onKeyDown={(e) => e.key === 'Enter' && addFolder()}
                  placeholder="/home/alice/Music"
                />
                <button type="button" className="btn btn-ghost" onClick={() => addFolder()}>
                  Add
                </button>
              </div>
              <p className="field-hint" style={{ marginTop: 8 }}>
                You can skip this and add folders later.
              </p>
            </>
          )}

          {/* ── Step 4: Download folder ─────────────────────────────────── */}
          {step === 4 && (
            <>
              <h1 className={styles.title}>Where should downloads go?</h1>
              <p className={styles.description}>
                Files you download from friends will be saved here. Leave blank to choose a location
                per download.
              </p>
              <div className="field">
                <label className="label" htmlFor="dlFolder">
                  Download folder
                </label>
                <FolderPicker
                  id="dlFolder"
                  value={state.downloadFolder}
                  onChange={(p) => set('downloadFolder', p)}
                  placeholder="/home/alice/Downloads"
                />
                <span className="field-hint">Optional — you can set this later in Settings.</span>
              </div>
            </>
          )}

          {/* ── Step 5: Listening port ──────────────────────────────────── */}
          {step === 5 && (
            <>
              <h1 className={styles.title}>Which port should Filenet listen on?</h1>
              <p className={styles.description}>
                Filenet needs an open port to receive connections from friends. The default is{' '}
                <strong>7734</strong>. You&rsquo;ll need to forward this port on your router for
                friends outside your local network to reach you.
              </p>
              <p className={styles.description} style={{ marginTop: -16 }}>
                <strong>Restart required</strong> — Filenet reads the port once at startup, so this
                setting takes effect the next time the server starts.
              </p>
              <div className="field">
                <label className="label" htmlFor="listenPort">
                  Listening port
                </label>
                <input
                  id="listenPort"
                  className="input"
                  type="number"
                  min="1"
                  max="65535"
                  value={state.listenPort}
                  onChange={(e) => set('listenPort', e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && goNext()}
                  style={{ width: 120 }}
                />
              </div>
              <div className={styles.forwardingBox}>
                <p className={styles.forwardingTitle}>How to forward a port on your router</p>
                <ol className={styles.forwardingSteps}>
                  <li>
                    Find your local IP — run <code>hostname -I</code> (Linux/Mac) or{' '}
                    <code>ipconfig</code> (Windows).
                  </li>
                  <li>
                    Open your router&apos;s admin panel (typically <code>http://192.168.1.1</code>{' '}
                    or <code>http://192.168.0.1</code>).
                  </li>
                  <li>
                    Locate the <strong>Port Forwarding</strong> section (may appear as
                    &ldquo;Virtual Servers&rdquo;, &ldquo;NAT&rdquo;, or &ldquo;Applications &amp;
                    Gaming&rdquo;).
                  </li>
                  <li>
                    Add a rule: external port <strong>{portPreview}</strong>, internal IP{' '}
                    <em>your local IP</em>, internal port <strong>{portPreview}</strong>, protocol{' '}
                    <strong>TCP</strong>.
                  </li>
                  <li>Save and apply.</li>
                </ol>
              </div>
            </>
          )}

          {/* ── Step 6: Preferences ─────────────────────────────────────── */}
          {step === 6 && (
            <>
              <h1 className={styles.title}>A few preferences</h1>
              <p className={styles.description}>
                These control how Filenet handles incoming friend requests. You can change them any
                time.
              </p>

              <div>
                <div className={styles.toggleRow}>
                  <div className={styles.toggleInfo}>
                    <div className={styles.toggleTitle}>Auto-accept from anyone</div>
                    <div className={styles.toggleHint}>
                      Automatically accept friend requests from unknown nodes.
                    </div>
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={state.autoAcceptFromAnyone}
                      onChange={(e) => set('autoAcceptFromAnyone', e.target.checked)}
                    />
                    <span className="toggle-track" />
                  </label>
                </div>

                <div className={styles.toggleRow}>
                  <div className={styles.toggleInfo}>
                    <div className={styles.toggleTitle}>Auto-accept friends of friends</div>
                    <div className={styles.toggleHint}>
                      Automatically accept requests from nodes your friends are connected to.
                    </div>
                  </div>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={state.autoAcceptFromFriendsOfFriends}
                      onChange={(e) => set('autoAcceptFromFriendsOfFriends', e.target.checked)}
                    />
                    <span className="toggle-track" />
                  </label>
                </div>

                <div className={styles.toggleRow}>
                  <div className={styles.toggleInfo}>
                    <div className={styles.toggleTitle}>Invite password</div>
                    <div className={styles.toggleHint}>
                      Friends who know this password can connect without manual approval.
                    </div>
                  </div>
                </div>
                <div className="field" style={{ marginTop: 8 }}>
                  <input
                    className="input"
                    type="password"
                    placeholder="Leave blank to disable"
                    value={state.invitePassword}
                    onChange={(e) => set('invitePassword', e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
              </div>
            </>
          )}

          {error && <p className={styles.errorMsg}>{error}</p>}
        </div>

        <div className={styles.footer}>
          <div>
            {stepIndex > 0 && (
              <button type="button" className="btn btn-ghost" onClick={goBack} disabled={saving}>
                Back
              </button>
            )}
          </div>
          <div className={styles.footerRight}>
            {step === 1 && (
              <button type="button" className="btn btn-primary" onClick={goNext}>
                Get started
              </button>
            )}
            {stepIndex > 0 && !isLastStep && (
              <>
                <button type="button" className="btn btn-ghost" onClick={skipStep}>
                  Skip
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={goNext}
                  disabled={!canAdvance()}
                >
                  Next
                </button>
              </>
            )}
            {isLastStep && step !== 1 && (
              <button type="button" className="btn btn-primary" onClick={finish} disabled={saving}>
                {saving ? 'Saving…' : 'Finish setup'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
