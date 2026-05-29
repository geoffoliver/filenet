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
