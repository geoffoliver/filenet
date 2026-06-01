export type Settings = {
  id: string;
  name: string;
  hasInvitePassword: boolean;
  autoAcceptFromAnyone: boolean;
  autoAcceptFromFriendsOfFriends: boolean;
  sharedFolders: string[];
  downloadFolder: string | null;
  rescanIntervalMinutes: number;
};

export type SettingsPatch = {
  name?: string;
  invitePassword?: string | null;
  autoAcceptFromAnyone?: boolean;
  autoAcceptFromFriendsOfFriends?: boolean;
  sharedFolders?: string[];
  downloadFolder?: string | null;
  rescanIntervalMinutes?: number;
};

export async function getMyInfo(): Promise<{ nodeId: string }> {
  const res = await fetch('/api/me');
  if (!res.ok) throw new Error('Failed to load identity');
  return res.json();
}

export async function getSettings(): Promise<Settings> {
  const res = await fetch('/api/settings');
  if (!res.ok) throw new Error('Failed to load settings');
  return res.json();
}

export async function patchSettings(patch: SettingsPatch): Promise<Settings> {
  const res = await fetch('/api/settings', {
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
};

export type AddFriendParams = {
  name: string;
  address: string;
  port: number;
  password?: string;
};

export async function getFriends(): Promise<Friend[]> {
  const res = await fetch('/api/friends');
  if (!res.ok) throw new Error('Failed to load friends');
  return res.json();
}

export async function addFriend(params: AddFriendParams): Promise<Friend> {
  const res = await fetch('/api/friends', {
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
  const res = await fetch(`/api/friends/${id}`, {
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
  const res = await fetch(`/api/friends/${id}`, {
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
  const res = await fetch(`/api/friends/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to remove friend');
  }
}

export type Stats = {
  sharedFiles: { count: number; totalSize: string };
  friends: { total: number; online: number };
};

export async function getStats(): Promise<Stats> {
  const res = await fetch('/api/stats');
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

export async function getTransfers(): Promise<Transfer[]> {
  const res = await fetch('/api/transfers');
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
  const res = await fetch('/api/transfers', {
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
  const res = await fetch(`/api/transfers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || `Failed to ${action} transfer`);
  }
}

export async function dismissTransfer(id: string): Promise<void> {
  const res = await fetch(`/api/transfers/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to dismiss transfer');
  }
}

export async function triggerRescan(): Promise<{ indexed: number; removed: number }> {
  const res = await fetch('/api/rescan', { method: 'POST' });
  if (!res.ok) throw new Error('Rescan failed');
  return res.json();
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

export type SearchResponse = {
  files: LocalFile[];
  total: number;
  network?: NetworkFile[];
};

export type SearchParams = {
  q: string;
  type?: FileType;
  limit?: number;
  offset?: number;
  network?: boolean;
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
  const res = await fetch('/api/conversations');
  if (!res.ok) throw new Error('Failed to load conversations');
  return res.json();
}

export async function openDmConversation(peerNodeId: string): Promise<Conversation> {
  const res = await fetch('/api/conversations', {
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
  const res = await fetch('/api/conversations', {
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
  const res = await fetch(`/api/conversations/${convId}/messages?${qs}`);
  if (!res.ok) throw new Error('Failed to load messages');
  return res.json();
}

export async function sendMessage(convId: string, body: string): Promise<Message> {
  const res = await fetch(`/api/conversations/${convId}/messages`, {
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
  const res = await fetch(`/api/conversations/${convId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg || 'Failed to delete conversation');
  }
}

export async function searchFiles(params: SearchParams): Promise<SearchResponse> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.type && params.type !== 'all') qs.set('type', params.type);
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  if (params.network) qs.set('network', 'true');
  const res = await fetch(`/api/search?${qs}`);
  if (!res.ok) throw new Error('Search failed');
  return res.json();
}
