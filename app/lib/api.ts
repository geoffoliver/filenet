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
