import type { Page } from '@playwright/test';

import type { Friend } from '../app/lib/api';

// ---------------------------------------------------------------------------
// Canonical mock fixtures
// ---------------------------------------------------------------------------

export const SETTINGS = {
  id: 'settings-1',
  name: 'Test User',
  hasInvitePassword: false,
  autoAcceptFromAnyone: false,
  autoAcceptFromFriendsOfFriends: false,
  sharedFolders: ['/shared'],
  downloadFolder: '/downloads',
  rescanIntervalMinutes: 60,
  listenPort: 7734,
  updateRepo: 'geoffoliver/filenet',
  updateCheckIntervalMinutes: 1440,
  autoOpenBrowser: true,
  enableFileWatcher: true,
};

export const UPDATE_STATUS_IDLE = {
  mode: 'binary' as const,
  currentVersion: '0.1.1',
  phase: 'idle' as const,
  latestVersion: null,
  releaseNotesUrl: null,
  error: null,
  lastCheckedAt: '2024-01-01T00:00:00.000Z',
};

export const UPDATE_STATUS_READY = {
  ...UPDATE_STATUS_IDLE,
  phase: 'ready' as const,
  latestVersion: '0.2.0',
  releaseNotesUrl: 'https://github.com/geoffoliver/filenet/releases/tag/v0.2.0',
};

export const UPDATE_STATUS_SOURCE_MODE = {
  ...UPDATE_STATUS_IDLE,
  mode: 'source' as const,
};

export const STATS = {
  sharedFiles: { count: 42, totalSize: '1073741824' },
  friends: { total: 3, online: 2 },
  downloads: { count: 7, totalSize: '536870912' },
};

export const FRIENDS: Friend[] = [
  {
    id: 'friend-1',
    name: 'Alice',
    nodeId: 'node-alice',
    address: '10.0.0.2',
    port: 7734,
    status: 'ACCEPTED',
    addedAt: '2024-01-01T00:00:00.000Z',
    acceptedAt: '2024-01-01T01:00:00.000Z',
    updatedAt: '2024-01-01T01:00:00.000Z',
    online: true,
    downloads: { count: 3, totalSize: '104857600' },
    uploads: { count: 1, totalSize: '10485760' },
  },
  {
    id: 'friend-2',
    name: 'Bob',
    nodeId: 'node-bob',
    address: '10.0.0.3',
    port: 7734,
    status: 'ACCEPTED',
    addedAt: '2024-02-01T00:00:00.000Z',
    acceptedAt: '2024-02-01T01:00:00.000Z',
    updatedAt: '2024-02-01T01:00:00.000Z',
    online: false,
    downloads: { count: 0, totalSize: '0' },
    uploads: { count: 0, totalSize: '0' },
  },
  {
    id: 'friend-3',
    name: 'Carol',
    nodeId: 'node-carol',
    address: '10.0.0.4',
    port: 7734,
    status: 'ACCEPTED',
    addedAt: '2024-03-01T00:00:00.000Z',
    acceptedAt: '2024-03-01T01:00:00.000Z',
    updatedAt: '2024-03-01T01:00:00.000Z',
    online: false,
    downloads: { count: 0, totalSize: '0' },
    uploads: { count: 0, totalSize: '0' },
  },
];

// A variant of FRIENDS where Carol is an incoming pending request instead of
// an accepted friend — used only by tests that specifically exercise the
// incoming-request flow (friends.spec.ts) or the friend-request
// notification feature (notifications.spec.ts). Kept separate from the
// default FRIENDS fixture so the rest of the e2e suite (which uses
// mockBaseApp's default) doesn't incidentally trigger a friend-request
// notification/toast on every page.
export const FRIENDS_WITH_INCOMING_REQUEST = FRIENDS.map((f) =>
  f.id === 'friend-3'
    ? { ...f, nodeId: null, status: 'INCOMING_PENDING' as const, acceptedAt: null }
    : f,
);

export const TRANSFERS = [
  {
    id: 'transfer-1',
    sha256: 'a'.repeat(64),
    filename: 'movie.mp4',
    size: '1073741824',
    mimeType: 'video/mp4',
    state: 'DOWNLOADING',
    bytesReceived: '536870912',
    progress: 0.5,
    speedBps: 5242880,
    etaSeconds: 102,
    sources: 2,
    error: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    completedAt: null,
  },
  {
    id: 'transfer-2',
    sha256: 'b'.repeat(64),
    filename: 'song.mp3',
    size: '10485760',
    mimeType: 'audio/mpeg',
    state: 'COMPLETED',
    bytesReceived: '10485760',
    progress: 1,
    speedBps: 0,
    etaSeconds: null,
    sources: 1,
    error: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    completedAt: '2024-01-01T01:00:00.000Z',
  },
];

export const CONVERSATIONS: {
  id: string;
  type: 'DM' | 'GROUP';
  name: string | null;
  createdAt: string;
  updatedAt: string;
  messages: {
    id: string;
    conversationId: string;
    fromNodeId: string;
    body: string;
    sentAt: string;
  }[];
}[] = [
  {
    id: 'dm:node-alice:self',
    type: 'DM',
    name: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T12:01:00.000Z',
    messages: [
      {
        id: 'msg-2',
        conversationId: 'dm:node-alice:self',
        fromNodeId: 'self',
        body: 'Hi Alice!',
        sentAt: '2024-01-01T12:01:00.000Z',
      },
    ],
  },
];

export const MESSAGES = [
  {
    id: 'msg-1',
    conversationId: 'dm:node-alice:self',
    fromNodeId: 'node-alice',
    body: 'Hey there!',
    sentAt: '2024-01-01T12:00:00.000Z',
  },
  {
    id: 'msg-2',
    conversationId: 'dm:node-alice:self',
    fromNodeId: 'self',
    body: 'Hi Alice!',
    sentAt: '2024-01-01T12:01:00.000Z',
  },
];

// ---------------------------------------------------------------------------
// Route mock helpers
// ---------------------------------------------------------------------------

export async function mockSettingsConfigured(page: Page) {
  await page.route('/api/settings', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: SETTINGS });
    return route.continue();
  });
}

export async function mockSettingsUnconfigured(page: Page) {
  await page.route('/api/settings', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { ...SETTINGS, name: '' } });
    return route.continue();
  });
}

export async function mockStats(page: Page) {
  await page.route('/api/stats', (route) => route.fulfill({ json: STATS }));
}

export async function mockFriends(page: Page, friends = FRIENDS) {
  await page.route('/api/friends', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: friends });
    }
    return route.continue();
  });
}

export async function mockTransfers(page: Page, transfers = TRANSFERS) {
  await page.route('/api/transfers', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: transfers });
    return route.continue();
  });
}

export async function mockUploads(page: Page, uploads: object[] = []) {
  await page.route('/api/uploads', (route) => route.fulfill({ json: uploads }));
}

export async function mockSearch(
  page: Page,
  results: { files: object[]; total: number; network?: object[] } = {
    files: [],
    total: 0,
    network: [],
  },
) {
  const frames = [
    `event: local\ndata: ${JSON.stringify({ files: results.files, total: results.total })}\n\n`,
  ];
  if (results.network && results.network.length > 0) {
    frames.push(`event: network\ndata: ${JSON.stringify(results.network)}\n\n`);
  }
  frames.push(`event: done\ndata: {}\n\n`);
  await page.route('/api/search**', (route) =>
    route.fulfill({ contentType: 'text/event-stream', body: frames.join('') }),
  );
}

export async function mockConversations(page: Page, convs = CONVERSATIONS) {
  await page.route('/api/conversations', (route) => route.fulfill({ json: convs }));
}

export async function mockMessages(page: Page, convId: string, msgs = MESSAGES) {
  const escapedId = convId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.route(new RegExp(`/api/conversations/${escapedId}/messages`), (route) =>
    route.fulfill({ json: msgs }),
  );
}

export async function mockMe(page: Page) {
  await page.route('/api/me', (route) => route.fulfill({ json: { nodeId: 'self' } }));
}

export async function mockUpdateStatus(page: Page, status = UPDATE_STATUS_IDLE) {
  await page.route('/api/update-status', (route) => route.fulfill({ json: status }));
  await page.route('/api/update-check', (route) => route.fulfill({ json: status }));
}

/** Apply the standard "logged-in, everything loaded" mocks used by most tests. */
export async function mockBaseApp(page: Page) {
  await mockSettingsConfigured(page);
  await mockStats(page);
  await mockFriends(page);
  await mockTransfers(page);
  await mockUploads(page);
  await mockConversations(page);
  await mockMe(page);
  await mockUpdateStatus(page);
}
