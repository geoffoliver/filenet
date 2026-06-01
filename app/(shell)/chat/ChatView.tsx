'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Conversation, Message } from '../../lib/api';
import {
  createGroupConversation,
  deleteConversation,
  getConversations,
  getMessages,
  getMyInfo,
  sendMessage,
} from '../../lib/api';
import styles from './chat.module.css';

const POLL_MS = 500;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function convLabel(conv: Conversation): string {
  if (conv.type === 'GROUP') return conv.name ?? 'Unnamed group';
  // DM: show the peer's node id (the half that isn't ours)
  return conv.id.slice(3); // strip "dm:" prefix for display
}

function lastPreview(conv: Conversation): string {
  const msg = conv.messages[0];
  if (!msg) return 'No messages yet';
  return msg.body.length > 60 ? msg.body.slice(0, 57) + '…' : msg.body;
}

// ── New Group Modal ──────────────────────────────────────────────────────────

function NewGroupModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (conv: Conversation) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const conv = await createGroupConversation(name.trim());
      onCreate(conv);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group');
    }
  }

  return (
    <div className={styles.modal} onClick={onClose}>
      <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalTitle}>New group chat</div>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            className={styles.modalInput}
            placeholder="Group name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
          />
          {error && (
            <p style={{ color: 'var(--color-danger)', fontSize: 12, marginTop: 4 }}>{error}</p>
          )}
          <div className={styles.modalActions} style={{ marginTop: 16 }}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={styles.sendBtn} disabled={!name.trim()}>
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main ChatView ────────────────────────────────────────────────────────────

export default function ChatView() {
  const [localNodeId, setLocalNodeId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);

  useEffect(() => {
    getMyInfo()
      .then((info) => setLocalNodeId(info.nodeId))
      .catch(() => {});
  }, []);

  const mountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeConvIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeConvIdRef.current = activeConvId;
  }, [activeConvId]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const convs = await getConversations();
      if (!mountedRef.current) return;
      setConversations(convs);
    } catch {
      // silently retry next poll
    }
  }, []);

  const loadMessages = useCallback(async (convId: string) => {
    try {
      const msgs = await getMessages(convId, { limit: 100 });
      if (!mountedRef.current || activeConvIdRef.current !== convId) return;
      setMessages(msgs);
    } catch {
      // silently retry next poll
    }
  }, []);

  // Poll loop — refreshes both conversation list and active messages
  useEffect(() => {
    mountedRef.current = true;

    async function runPoll() {
      while (mountedRef.current) {
        await loadConversations();
        const convId = activeConvIdRef.current;
        if (convId) await loadMessages(convId);
        if (!mountedRef.current) break;
        await new Promise<void>((resolve) => {
          pollRef.current = setTimeout(resolve, POLL_MS);
        });
      }
    }

    runPoll();
    return () => {
      mountedRef.current = false;
      if (pollRef.current !== null) clearTimeout(pollRef.current);
    };
  }, [loadConversations, loadMessages]);

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  function selectConv(convId: string) {
    if (convId === activeConvId) return;
    activeConvIdRef.current = convId; // sync update so loadMessages guard doesn't race
    setActiveConvId(convId);
    setMessages([]);
    loadMessages(convId);
  }

  async function handleSend() {
    if (!draft.trim() || !activeConvId || sending) return;
    const text = draft.trim();
    setDraft('');
    setSending(true);
    try {
      await sendMessage(activeConvId, text);
      await loadMessages(activeConvId);
    } catch {
      setDraft(text); // restore on failure
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleDelete() {
    if (!activeConvId) return;
    if (!window.confirm('Delete this conversation and all its messages?')) return;
    try {
      await deleteConversation(activeConvId);
      setActiveConvId(null);
      setMessages([]);
      await loadConversations();
    } catch {
      // ignore
    }
  }

  const dmConvs = conversations.filter((c) => c.type === 'DM');
  const groupConvs = conversations.filter((c) => c.type === 'GROUP');
  const activeConv = conversations.find((c) => c.id === activeConvId) ?? null;

  return (
    <div className={styles.root}>
      {/* ── Sidebar ── */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span className={styles.sidebarTitle}>Chat</span>
          <button className={styles.newGroupBtn} onClick={() => setShowNewGroup(true)}>
            + New group
          </button>
        </div>
        <div className={styles.sidebarScroll}>
          {dmConvs.length > 0 && (
            <>
              <div className={styles.sidebarSection}>Direct Messages</div>
              {dmConvs.map((conv) => (
                <div
                  key={conv.id}
                  className={`${styles.convItem} ${conv.id === activeConvId ? styles.convItemActive : ''}`}
                  onClick={() => selectConv(conv.id)}
                >
                  <span className={styles.convName}>{convLabel(conv)}</span>
                  <span className={styles.convPreview}>{lastPreview(conv)}</span>
                </div>
              ))}
            </>
          )}
          {groupConvs.length > 0 && (
            <>
              <div className={styles.sidebarSection}>Groups</div>
              {groupConvs.map((conv) => (
                <div
                  key={conv.id}
                  className={`${styles.convItem} ${conv.id === activeConvId ? styles.convItemActive : ''}`}
                  onClick={() => selectConv(conv.id)}
                >
                  <span className={styles.convName}>{convLabel(conv)}</span>
                  <span className={styles.convPreview}>{lastPreview(conv)}</span>
                </div>
              ))}
            </>
          )}
          {conversations.length === 0 && (
            <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: 13 }}>
              No conversations yet. Create a group or send a DM from a friend&apos;s profile.
            </div>
          )}
        </div>
      </aside>

      {/* ── Main panel ── */}
      <div className={styles.main}>
        {activeConv ? (
          <>
            <div className={styles.mainHeader}>
              <span className={styles.mainTitle}>{convLabel(activeConv)}</span>
              <button className={styles.deleteBtn} onClick={handleDelete}>
                Delete
              </button>
            </div>

            <div className={styles.messages}>
              {messages.length === 0 && (
                <div className={styles.empty}>No messages yet. Say something!</div>
              )}
              {messages.map((msg) => {
                const isOwn = localNodeId !== null && msg.fromNodeId === localNodeId;
                return (
                  <div
                    key={msg.id}
                    className={`${styles.bubble} ${isOwn ? styles.bubbleOwn : styles.bubblePeer}`}
                  >
                    {!isOwn && <span className={styles.bubbleMeta}>{msg.fromNodeId}</span>}
                    <div
                      className={`${styles.bubbleBody} ${isOwn ? styles.bubbleBodyOwn : styles.bubbleBodyPeer}`}
                    >
                      {msg.body}
                    </div>
                    <span className={styles.bubbleMeta}>{formatTime(msg.sentAt)}</span>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <div className={styles.inputBar}>
              <textarea
                className={styles.textarea}
                rows={1}
                placeholder="Message…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={sending}
              />
              <button
                className={styles.sendBtn}
                onClick={handleSend}
                disabled={!draft.trim() || sending}
              >
                Send
              </button>
            </div>
          </>
        ) : (
          <div className={styles.noConv}>Select a conversation to start chatting.</div>
        )}
      </div>

      {showNewGroup && (
        <NewGroupModal
          onClose={() => setShowNewGroup(false)}
          onCreate={(conv) => {
            setShowNewGroup(false);
            setConversations((prev) => [conv, ...prev]);
            selectConv(conv.id);
          }}
        />
      )}
    </div>
  );
}
