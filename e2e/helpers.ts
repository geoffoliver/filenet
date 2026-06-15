import type { Page } from '@playwright/test';

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
};

export const STATS = {
  sharedFiles: { count: 42, totalSize: '1073741824' },
  friends: { total: 3, online: 2 },
  downloads: { count: 7, totalSize: '536870912' },
};

export const FRIENDS = [
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
    nodeId: null,
    address: '10.0.0.4',
    port: 7734,
    status: 'INCOMING_PENDING',
    addedAt: '2024-03-01T00:00:00.000Z',
    acceptedAt: null,
    updatedAt: '2024-03-01T00:00:00.000Z',
    online: false,
    downloads: { count: 0, totalSize: '0' },
    uploads: { count: 0, totalSize: '0' },
  },
];

export const TRANSFERS = [
  {
    id: 'transfer-1',
    sha256: 'a'.repeat(64),
    filename: 'movie.mp4',
    size: '1073741824',
    mimeType: 'video/mp4',
    state: 'DOWNLOADING',
    bytesReceived: '536870912',
    progress: 50,
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
    progress: 100,
    speedBps: 0,
    etaSeconds: null,
    sources: 1,
    error: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    completedAt: '2024-01-01T01:00:00.000Z',
  },
];

export const CONVERSATIONS = [
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
        senderNodeId: 'self',
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
    senderNodeId: 'node-alice',
    body: 'Hey there!',
    sentAt: '2024-01-01T12:00:00.000Z',
  },
  {
    id: 'msg-2',
    conversationId: 'dm:node-alice:self',
    senderNodeId: 'self',
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

export async function mockSearch(
  page: Page,
  results: { files: object[]; total: number; network?: object[] } = {
    files: [],
    total: 0,
    network: [],
  },
) {
  await page.route('/api/search**', (route) => route.fulfill({ json: results }));
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

export async function mockEnvConfig(page: Page) {
  await page.route('/api/settings/env', (route) =>
    route.fulfill({ json: { sharedFolders: [], downloadFolder: null } }),
  );
}

export async function mockMe(page: Page) {
  await page.route('/api/me', (route) => route.fulfill({ json: { nodeId: 'self' } }));
}

/** Apply the standard "logged-in, everything loaded" mocks used by most tests. */
export async function mockBaseApp(page: Page) {
  await mockSettingsConfigured(page);
  await mockStats(page);
  await mockFriends(page);
  await mockTransfers(page);
  await mockConversations(page);
  await mockEnvConfig(page);
  await mockMe(page);
}
