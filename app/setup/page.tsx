'use client';

import { patchSettings } from '../lib/api';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import styles from './setup.module.css';

type WizardState = {
  name: string;
  sharedFolders: string[];
  downloadFolder: string;
  autoAcceptFromAnyone: boolean;
  autoAcceptFromFriendsOfFriends: boolean;
  invitePassword: string;
};

const TOTAL_STEPS = 5;

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
    autoAcceptFromAnyone: false,
    autoAcceptFromFriendsOfFriends: false,
    invitePassword: '',
  });

  function set<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  function addFolder() {
    const path = folderInput.trim();
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
    return true;
  }

  function next() {
    if (!canAdvance()) return;
    setError('');
    if (step < TOTAL_STEPS) {
      setStep((s) => s + 1);
    } else {
      finish();
    }
  }

  function back() {
    setError('');
    setStep((s) => s - 1);
  }

  async function finish() {
    setSaving(true);
    setError('');
    try {
      await patchSettings({
        name: state.name.trim(),
        sharedFolders: state.sharedFolders,
        downloadFolder: state.downloadFolder.trim() || null,
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

  const progress = ((step - 1) / (TOTAL_STEPS - 1)) * 100;

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.progress}>
          <div className={styles.progressFill} style={{ width: `${progress}%` }} />
        </div>

        <div className={styles.body}>
          {step < TOTAL_STEPS && (
            <p className={styles.stepLabel}>
              Step {step} of {TOTAL_STEPS - 1}
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
                  onKeyDown={(e) => e.key === 'Enter' && next()}
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
                <input
                  className="input"
                  type="text"
                  placeholder="/home/alice/Music"
                  value={folderInput}
                  onChange={(e) => setFolderInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addFolder()}
                />
                <button type="button" className="btn btn-ghost" onClick={addFolder}>
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
                <input
                  id="dlFolder"
                  className="input"
                  type="text"
                  placeholder="/home/alice/Downloads"
                  value={state.downloadFolder}
                  onChange={(e) => set('downloadFolder', e.target.value)}
                />
                <span className="field-hint">Optional — you can set this later in Settings.</span>
              </div>
            </>
          )}

          {/* ── Step 5: Preferences ─────────────────────────────────────── */}
          {step === 5 && (
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

          {/* ── Done ────────────────────────────────────────────────────── */}
          {step === TOTAL_STEPS + 1 && (
            <>
              <div className={styles.doneIcon}>✓</div>
              <h1 className={styles.title}>You&rsquo;re all set!</h1>
              <p className={styles.description}>
                Filenet is ready to go. You can find all of these settings under the Settings
                section at any time.
              </p>
            </>
          )}

          {error && <p className={styles.errorMsg}>{error}</p>}
        </div>

        <div className={styles.footer}>
          <div>
            {step > 1 && step <= TOTAL_STEPS && (
              <button type="button" className="btn btn-ghost" onClick={back} disabled={saving}>
                Back
              </button>
            )}
          </div>
          <div className={styles.footerRight}>
            {step === 1 && (
              <button type="button" className="btn btn-primary" onClick={next}>
                Get started
              </button>
            )}
            {step > 1 && step < TOTAL_STEPS && (
              <>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setStep((s) => s + 1)}
                >
                  Skip
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={next}
                  disabled={!canAdvance()}
                >
                  Next
                </button>
              </>
            )}
            {step === TOTAL_STEPS && (
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
