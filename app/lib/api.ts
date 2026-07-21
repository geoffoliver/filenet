// In production the UI and the API are served by the same Bun process on
// the same origin, so a plain relative path already reaches the API
// correctly no matter what host/IP the app was opened from. In dev
// (`bun run dev`), the Next.js dev server and the Bun API server run as two
// separate processes on different ports (see package.json's `dev` script
// and .env.development) — a relative path would hit the Next dev server,
// not the API. NEXT_PUBLIC_DEV_API_PORT (dev-only) opts into targeting the
// API server explicitly, but its *host* is resolved at runtime from
// window.location rather than baked in as a literal "localhost" at build
// time, so opening the dev server from another machine on the network
// (e.g. http://192.168.1.50:3001) still reaches that same machine's API
// port instead of trying to reach "localhost" on the visiting device.
export function apiUrl(path: string): string {
  const devApiPort = process.env.NEXT_PUBLIC_DEV_API_PORT;
  if (devApiPort && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:${devApiPort}${path}`;
  }
  return path;
}

export function formatSpeed(bps: number): string {
  if (bps === 0) return '–';
  return `${formatBytes(bps)}/s`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '–';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Fixed locale rather than the visitor's own: predictable output (matters
// for tests) and this app has no other i18n infrastructure to plug into —
// this is just thousands-separator grouping, not full localization.
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatBytes(s: string | number): string {
  let n: bigint;
  try {
    n = BigInt(typeof s === 'number' ? Math.trunc(s) : s);
  } catch {
    return '0 B';
  }
  if (n === 0n) return '0 B';
  const KB = 1024n;
  const MB = KB * 1024n;
  const GB = MB * 1024n;
  const TB = GB * 1024n;
  // For KB–GB, n is small enough that Number() is exact (all < 2^40 < MAX_SAFE_INTEGER).
  // For TB+, divide BigInt first so the Number() operand stays in safe-integer range.
  if (n < KB) return `${n} B`;
  if (n < MB) return `${(Number(n) / Number(KB)).toFixed(1)} KB`;
  if (n < GB) return `${(Number(n) / Number(MB)).toFixed(1)} MB`;
  if (n < TB) return `${(Number(n) / Number(GB)).toFixed(2)} GB`;
  return `${(Number(n / GB) / 1024).toFixed(2)} TB`;
}

export type Settings = {
  id: string;
  name: string;
  hasInvitePassword: boolean;
  autoAcceptFromAnyone: boolean;
  autoAcceptFromFriendsOfFriends: boolean;
  sharedFolders: string[];
  downloadFolder: string | null;
  rescanIntervalMinutes: number;
  listenPort: number;
  updateRepo: string;
  updateCheckIntervalMinutes: number;
  autoOpenBrowser: boolean;
};

export type SettingsPatch = {
  name?: string;
  invitePassword?: string | null;
  autoAcceptFromAnyone?: boolean;
  autoAcceptFromFriendsOfFriends?: boolean;
  sharedFolders?: string[];
  downloadFolder?: string | null;
  rescanIntervalMinutes?: number;
  listenPort?: number;
  updateRepo?: string;
  updateCheckIntervalMinutes?: number;
  autoOpenBrowser?: boolean;
};

export async function getMyInfo(): Promise<{ nodeId: string }> {
  const res = await fetch(apiUrl('/api/me'));
  if (!res.ok) throw new Error('Failed to load identity');
  return res.json();
}

export async function getSettings(): Promise<Settings> {
  const res = await fetch(apiUrl('/api/settings'));
  if (!res.ok) throw new Error('Failed to load settings');
  return res.json();
}

export async function patchSettings(patch: SettingsPatch): Promise<Settings> {
  const res = await fetch(apiUrl('/api/settings'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to save settings');
  }
  return res.json();
}

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export type UpdateStatus = {
  mode: 'binary' | 'source';
  currentVersion: string;
  phase: UpdatePhase;
  latestVersion: string | null;
  releaseNotesUrl: string | null;
  error: string | null;
  lastCheckedAt: string | null;
};

export async function getUpdateStatus(): Promise<UpdateStatus> {
  const res = await fetch(apiUrl('/api/update-status'));
  if (!res.ok) throw new Error('Failed to load update status');
  return res.json();
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  const res = await fetch(apiUrl('/api/update-check'), { method: 'POST' });
  if (!res.ok) throw new Error('Failed to check for updates');
  return res.json();
}

export async function restartToUpdate(): Promise<void> {
  const res = await fetch(apiUrl('/api/update-restart'), { method: 'POST' });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to restart');
  }
}

export type FriendStatus = 'OUTGOING_PENDING' | 'INCOMING_PENDING' | 'ACCEPTED' | 'BLOCKED';

export type Friend = {
  id: string;
  name: string;
  nodeId: string | null;
  address: string;
  port: number;
  status: FriendStatus;
  addedAt: string;
  acceptedAt: string | null;
  updatedAt: string;
  online: boolean;
  downloads: { count: number; totalSize: string };
  uploads: { count: number; totalSize: string };
};

export type AddFriendParams = {
  name: string;
  address: string;
  port: number;
  password?: string;
};

export async function getFriends(): Promise<Friend[]> {
  const res = await fetch(apiUrl('/api/friends'));
  if (!res.ok) throw new Error('Failed to load friends');
  return res.json();
}

export async function addFriend(params: AddFriendParams): Promise<Friend> {
  const res = await fetch(apiUrl('/api/friends'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to add friend');
  }
  return res.json();
}

export async function acceptFriend(id: string): Promise<Friend> {
  const res = await fetch(apiUrl(`/api/friends/${id}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'accept' }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to accept friend request');
  }
  return res.json();
}

export async function rejectFriend(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/friends/${id}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reject' }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to reject friend request');
  }
}

export async function removeFriend(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/friends/${id}`), { method: 'DELETE' });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to remove friend');
  }
}

export type Stats = {
  sharedFiles: { count: number; totalSize: string };
  friends: { total: number; online: number };
  downloads: { count: number; totalSize: string };
};

export async function getStats(): Promise<Stats> {
  const res = await fetch(apiUrl('/api/stats'));
  if (!res.ok) throw new Error('Failed to load stats');
  return res.json();
}

export type TransferState =
  | 'PENDING'
  | 'DOWNLOADING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type Transfer = {
  id: string;
  sha256: string;
  filename: string;
  size: string;
  mimeType: string | null;
  state: TransferState;
  bytesReceived: string;
  progress: number;
  speedBps: number;
  etaSeconds: number | null;
  sources: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

export const TRANSFER_TERMINAL_STATES = new Set<TransferState>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export async function getTransfers(): Promise<Transfer[]> {
  const res = await fetch(apiUrl('/api/transfers'));
  if (!res.ok) throw new Error('Failed to load transfers');
  return res.json();
}

export async function startDownload(params: {
  sha256: string;
  filename: string;
  size: string;
  mimeType?: string | null;
  sources: string[];
}): Promise<{ id: string }> {
  const res = await fetch(apiUrl('/api/transfers'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to start download');
  }
  return res.json();
}

export async function controlTransfer(
  id: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<void> {
  const res = await fetch(apiUrl(`/api/transfers/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || `Failed to ${action} transfer`);
  }
}

export type Upload = {
  id: string;
  sha256: string;
  filename: string;
  size: string;
  peerNodeId: string;
  bytesServed: string;
  speedBps: number;
};

export async function getUploads(): Promise<Upload[]> {
  const res = await fetch(apiUrl('/api/uploads'));
  if (!res.ok) throw new Error('Failed to load uploads');
  return res.json();
}

export async function dismissTransfer(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/transfers/${id}`), { method: 'DELETE' });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to dismiss transfer');
  }
}

export type PostDownloadScript = {
  id: string;
  path: string;
  order: number;
  createdAt: string;
};

export async function getScripts(): Promise<PostDownloadScript[]> {
  const res = await fetch(apiUrl('/api/scripts'));
  if (!res.ok) throw new Error('Failed to load scripts');
  return res.json();
}

export async function addScript(path: string): Promise<PostDownloadScript> {
  const res = await fetch(apiUrl('/api/scripts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to add script');
  }
  return res.json();
}

export async function reorderScript(
  id: string,
  direction: 'up' | 'down',
): Promise<PostDownloadScript[]> {
  const res = await fetch(apiUrl(`/api/scripts/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to reorder script');
  }
  if (res.status === 204) return getScripts();
  return res.json();
}

export async function removeScript(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/scripts/${id}`), { method: 'DELETE' });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to remove script');
  }
}

export type FsEntry = { name: string; path: string };

export type FsListing = {
  path: string;
  parent: string | null;
  home: string; // always present — the server falls back to homedir()
  entries: FsEntry[];
};

export async function listDirectory(path?: string, signal?: AbortSignal): Promise<FsListing> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  const res = await fetch(apiUrl(`/api/fs${qs}`), { signal });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Cannot read directory');
  }
  return res.json();
}

export async function triggerRescan(): Promise<void> {
  const res = await fetch(apiUrl('/api/rescan'), { method: 'POST' });
  if (res.status === 409) throw new Error('A scan is already in progress.');
  if (!res.ok) throw new Error('Rescan failed');
}

export type FileType = 'all' | 'audio' | 'video' | 'image' | 'document' | 'ebook';

export type LocalFile = {
  id: string;
  filename: string;
  size: string;
  sha256: string;
  mimeType: string | null;
  metadata: string | null;
  fileModifiedAt: string | null;
  indexedAt: string;
};

export type NetworkFile = {
  filename: string;
  size: string;
  sha256: string;
  mimeType: string | null;
  metadata: string | null;
  nodeId: string;
  viaNodeId?: string;
};

export type SearchStreamParams = {
  q: string;
  type?: FileType;
};

export type SearchStreamHandlers = {
  onLocal: (data: { files: LocalFile[]; total: number }) => void;
  onNetworkBatch: (batch: NetworkFile[]) => void;
  onDone: () => void;
  onError: () => void;
};

// ── Chat ──────────────────────────────────────────────────────────────────────

export type ConvType = 'DM' | 'GROUP';

export type Message = {
  id: string;
  conversationId: string;
  fromNodeId: string;
  body: string;
  sentAt: string;
};

export type Conversation = {
  id: string;
  type: ConvType;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
};

export async function getConversations(): Promise<Conversation[]> {
  const res = await fetch(apiUrl('/api/conversations'));
  if (!res.ok) throw new Error('Failed to load conversations');
  return res.json();
}

export async function openDmConversation(peerNodeId: string): Promise<Conversation> {
  const res = await fetch(apiUrl('/api/conversations'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerNodeId }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to open DM');
  }
  return res.json();
}

export async function createGroupConversation(name: string): Promise<Conversation> {
  const res = await fetch(apiUrl('/api/conversations'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to create group');
  }
  return res.json();
}

export async function getMessages(
  convId: string,
  opts?: { limit?: number; before?: string },
): Promise<Message[]> {
  const qs = new URLSearchParams();
  if (opts?.limit != null) qs.set('limit', String(opts.limit));
  if (opts?.before) qs.set('before', opts.before);
  const res = await fetch(apiUrl(`/api/conversations/${convId}/messages?${qs}`));
  if (!res.ok) throw new Error('Failed to load messages');
  return res.json();
}

export async function sendMessage(convId: string, body: string): Promise<Message> {
  const res = await fetch(apiUrl(`/api/conversations/${convId}/messages`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to send message');
  }
  return res.json();
}

export async function deleteConversation(convId: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/conversations/${convId}`), {
    method: 'DELETE',
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to delete conversation');
  }
}

export function streamSearch(
  params: SearchStreamParams,
  handlers: SearchStreamHandlers,
): EventSource {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.type && params.type !== 'all') qs.set('type', params.type);
  const es = new EventSource(apiUrl(`/api/search/stream?${qs}`));
  let finished = false;
  const fail = () => {
    if (finished) return;
    finished = true;
    handlers.onError();
    es.close();
  };
  es.addEventListener('local', (e) => {
    try {
      handlers.onLocal(JSON.parse((e as MessageEvent).data));
    } catch {
      fail();
    }
  });
  es.addEventListener('network', (e) => {
    try {
      handlers.onNetworkBatch(JSON.parse((e as MessageEvent).data));
    } catch {
      fail();
    }
  });
  es.addEventListener('done', () => {
    if (finished) return;
    finished = true;
    handlers.onDone();
    es.close();
  });
  es.onerror = fail;
  return es;
}
