import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { homedir, tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { join } from 'node:path';
import { unlinkSync } from 'fs';

import { type Db, applyMigrations, createDb } from '../db';
import type { DownloadState, FriendStatus } from '../schema';
import type { UpdateManager, UpdateState } from '../updater';
import {
  conversations,
  downloads,
  friends,
  messages,
  postDownloadScripts,
  settings,
  sharedFiles,
} from '../schema';
import { count, eq } from 'drizzle-orm';
import { isScanning, scanAndIndex } from '../indexer';
import { registerPeer, unregisterPeer } from '../connections';
import type { FileWatcherHandle } from '../watcher';
import { createManagementFetch } from '../management';
import { generateIdentity } from '../identity';
import { resetPendingForTesting } from '../transfer-protocol';

const TEST_DB_URL = 'file:./data/test-management.db';
let db: Db;
let tmpDir: string;

const identity = generateIdentity();
const neverConnect = async (): Promise<never> => {
  throw new Error('no real connections in tests');
};

function makeFakeUpdater(overrides: Partial<UpdateState> = {}): UpdateManager & {
  checkNowCalls: number;
  applyAndRestartCalls: number;
} {
  const state: UpdateState = {
    mode: 'binary',
    currentVersion: '0.1.0',
    phase: 'idle',
    latestVersion: null,
    releaseNotesUrl: null,
    error: null,
    lastCheckedAt: null,
    ...overrides,
  };
  const fake = {
    checkNowCalls: 0,
    applyAndRestartCalls: 0,
    getState: () => state,
    checkNow: async () => {
      fake.checkNowCalls++;
      return state;
    },
    startPeriodicChecks: () => () => {},
    applyAndRestart: async () => {
      fake.applyAndRestartCalls++;
      throw new Error('test double: applyAndRestart should not actually be awaited by the route');
    },
  };
  return fake;
}

function makeHandler(updater: UpdateManager = makeFakeUpdater()) {
  return createManagementFetch({ identity, db, connectPeer: neverConnect, updater });
}

function makeFakeWatcher(): FileWatcherHandle & { syncFoldersCalls: string[][] } {
  const syncFoldersCalls: string[][] = [];
  return {
    syncFoldersCalls,
    stop: () => {},
    syncFolders: (folders: string[]) => {
      syncFoldersCalls.push(folders);
    },
  };
}

function req(path: string, options?: RequestInit) {
  return new Request(`http://localhost${path}`, options);
}

function jsonReq(path: string, method: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function parseSseEvents(text: string): { event: string; data: unknown }[] {
  return text
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const eventLine = frame.split('\n').find((l) => l.startsWith('event: '))!;
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))!;
      return {
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)),
      };
    });
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await Bun.sleep(20);
  }
}

function sharedFileCount(): number {
  return db.select({ count: count() }).from(sharedFiles).get()!.count;
}

beforeAll(async () => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);

  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-mgmt-test-'));
});

afterAll(async () => {
  db.$client.close();
  await rm(tmpDir, { recursive: true, force: true });
  try {
    unlinkSync('./data/test-management.db');
  } catch {}
});

beforeEach(async () => {
  // A prior test's PATCH /api/settings or /api/rescan may have kicked off
  // a background scan (now a real worker thread — see server/scan-worker.ts
  // — so this can outlive the test that started it, unlike the old
  // same-thread fire-and-forget). Wait for it to finish before wiping
  // sharedFiles below, or its writes can land after the wipe and bleed
  // into the next test.
  await waitFor(() => !isScanning());
  db.delete(sharedFiles).run();
  db.delete(friends).run();
  db.delete(settings).run();
  db.delete(postDownloadScripts).run();
  resetPendingForTesting();
});

// ---------------------------------------------------------------------------
// GET /api/me
// ---------------------------------------------------------------------------

describe('GET /api/me', () => {
  it('returns the local nodeId', async () => {
    const res = await makeHandler()(req('/api/me'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodeId).toBe(identity.nodeId);
    expect(typeof body.nodeId).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// GET /api/friends
// ---------------------------------------------------------------------------

describe('GET /api/friends', () => {
  it('returns empty array when no friends', async () => {
    const res = await makeHandler()(req('/api/friends'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it('returns list of friends', async () => {
    db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Alice',
        address: '10.0.0.1',
        port: 7734,
        status: 'INCOMING_PENDING',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req('/api/friends'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBe(1);
    expect(body[0].name).toBe('Alice');
  });

  it('includes online boolean on each friend', async () => {
    db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Bob',
        address: '10.0.0.2',
        port: 7734,
        status: 'ACCEPTED',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req('/api/friends'));
    const body = await res.json();
    expect(typeof body[0].online).toBe('boolean');
    expect(body[0].online).toBe(false); // no peers connected in tests
  });

  it('does not expose remotePassword in the response', async () => {
    db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Zara',
        address: '10.0.0.99',
        port: 7734,
        status: 'OUTGOING_PENDING',
        remotePassword: 'supersecret',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req('/api/friends'));
    const body = await res.json();
    const zara = body.find((f: { name: string }) => f.name === 'Zara');
    expect(zara).toBeDefined();
    expect(zara.remotePassword).toBeUndefined();
  });

  it('includes zero download stats for a friend with no downloads', async () => {
    db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Carol',
        nodeId: 'node-carol',
        address: '10.0.0.3',
        port: 7734,
        status: 'ACCEPTED',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req('/api/friends'));
    const body = await res.json();
    expect(body[0].downloads.count).toBe(0);
    expect(body[0].downloads.totalSize).toBe('0');
    expect(body[0].uploads.count).toBe(0);
    expect(body[0].uploads.totalSize).toBe('0');
  });

  it('maps downloadCount/uploadCount and byte totals to the response shape', async () => {
    db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Dave',
        nodeId: 'node-dave',
        address: '10.0.0.4',
        port: 7734,
        status: 'ACCEPTED',
        downloadCount: 2,
        downloadTotalBytes: 3000n,
        uploadCount: 5,
        uploadTotalBytes: 8000n,
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req('/api/friends'));
    const body = await res.json();
    expect(body[0].downloads.count).toBe(2);
    expect(body[0].downloads.totalSize).toBe('3000');
    expect(body[0].uploads.count).toBe(5);
    expect(body[0].uploads.totalSize).toBe('8000');
  });

  it('pending and blocked friends always show zero download and upload stats', async () => {
    db.insert(friends)
      .values(
        [
          {
            name: 'Incoming Frank',
            nodeId: 'node-frank',
            address: '10.0.0.6',
            port: 7734,
            status: 'INCOMING_PENDING' as FriendStatus,
          },
          {
            name: 'Blocked Grace',
            nodeId: 'node-grace',
            address: '10.0.0.7',
            port: 7734,
            status: 'BLOCKED' as FriendStatus,
          },
        ].map((d) => ({ id: randomUUID(), addedAt: new Date(), updatedAt: new Date(), ...d })),
      )
      .run();
    const res = await makeHandler()(req('/api/friends'));
    const body = await res.json();
    const frank = body.find((f: { name: string }) => f.name === 'Incoming Frank');
    const grace = body.find((f: { name: string }) => f.name === 'Blocked Grace');
    expect(frank.downloads.count).toBe(0);
    expect(frank.uploads.count).toBe(0);
    expect(grace.downloads.count).toBe(0);
    expect(grace.uploads.count).toBe(0);
  });

  it('zeroes out download and upload stats when a previously-ACCEPTED friend is later blocked', async () => {
    db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Eve',
        nodeId: 'node-eve',
        address: '10.0.0.8',
        port: 7734,
        status: 'BLOCKED',
        downloadCount: 5,
        downloadTotalBytes: 9000n,
        uploadCount: 3,
        uploadTotalBytes: 4000n,
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req('/api/friends'));
    const body = await res.json();
    const eve = body.find((fr: { name: string }) => fr.name === 'Eve');
    expect(eve.downloads.count).toBe(0);
    expect(eve.downloads.totalSize).toBe('0');
    expect(eve.uploads.count).toBe(0);
    expect(eve.uploads.totalSize).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// POST /api/friends
// ---------------------------------------------------------------------------

describe('POST /api/friends', () => {
  it('returns 201 even when connectPeer throws synchronously', async () => {
    const syncThrow = (): Promise<never> => {
      throw new Error('sync throw'); // no Promise returned — throws before returning
    };
    const handler = createManagementFetch({
      identity,
      db,
      connectPeer: syncThrow,
      updater: makeFakeUpdater(),
    });
    const res = await handler(
      jsonReq('/api/friends', 'POST', { name: 'SyncFail', address: '10.0.0.99', port: 7734 }),
    );
    expect(res.status).toBe(201);
  });

  it('creates a friend and returns 201', async () => {
    const res = await makeHandler()(
      jsonReq('/api/friends', 'POST', { name: 'Bob', address: '10.0.0.2', port: 7734 }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe('Bob');
    expect(body.status).toBe('OUTGOING_PENDING');
  });

  it('response includes downloads and uploads zero stats so UI does not crash on optimistic insert', async () => {
    const res = await makeHandler()(
      jsonReq('/api/friends', 'POST', { name: 'Bob', address: '10.0.0.2', port: 7734 }),
    );
    const body = await res.json();
    expect(body.downloads.count).toBe(0);
    expect(body.downloads.totalSize).toBe('0');
    expect(body.uploads.count).toBe(0);
    expect(body.uploads.totalSize).toBe('0');
  });

  it('response includes online boolean to match GET /api/friends shape', async () => {
    const res = await makeHandler()(
      jsonReq('/api/friends', 'POST', { name: 'Bob', address: '10.0.0.2', port: 7734 }),
    );
    const body = await res.json();
    expect(body.online).toBe(false);
  });

  it('does not expose remotePassword in the response', async () => {
    const res = await makeHandler()(
      jsonReq('/api/friends', 'POST', {
        name: 'Bob',
        address: '10.0.0.2',
        port: 7734,
        password: 'topsecret',
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.remotePassword).toBeUndefined();
  });

  it('defaults port to 7734 when omitted', async () => {
    const res = await makeHandler()(
      jsonReq('/api/friends', 'POST', { name: 'Carol', address: '10.0.0.3' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.port).toBe(7734);
  });

  it('returns 409 when friend at that address:port already exists', async () => {
    await makeHandler()(jsonReq('/api/friends', 'POST', { name: 'Dan', address: '10.0.0.4' }));
    const res = await makeHandler()(
      jsonReq('/api/friends', 'POST', { name: 'Dan again', address: '10.0.0.4' }),
    );
    expect(res.status).toBe(409);
  });

  it('returns 400 for missing name', async () => {
    const res = await makeHandler()(jsonReq('/api/friends', 'POST', { address: '10.0.0.5' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing address', async () => {
    const res = await makeHandler()(jsonReq('/api/friends', 'POST', { name: 'Eve' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid port', async () => {
    const res = await makeHandler()(
      jsonReq('/api/friends', 'POST', { name: 'Frank', address: '10.0.0.6', port: 99999 }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await makeHandler()(
      new Request('http://localhost/api/friends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/friends/:id (accept / reject)
// ---------------------------------------------------------------------------

describe('PUT /api/friends/:id — accept', () => {
  it('accepts an INCOMING_PENDING friend and returns 200', async () => {
    const f = db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Grace',
        address: '10.0.0.10',
        port: 7734,
        status: 'INCOMING_PENDING',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'accept' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ACCEPTED');
  });

  it('does not expose remotePassword in the accept response', async () => {
    const f = db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'NoLeak',
        address: '10.0.0.17',
        port: 7734,
        status: 'INCOMING_PENDING',
        remotePassword: 'should-not-appear',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'accept' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.remotePassword).toBeUndefined();
  });

  it('response includes zero download and upload stats for a freshly created friend', async () => {
    const f = db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Grace2',
        address: '10.0.0.16',
        port: 7734,
        status: 'INCOMING_PENDING',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'accept' }));
    const body = await res.json();
    expect(body.downloads.count).toBe(0);
    expect(body.downloads.totalSize).toBe('0');
    expect(body.uploads.count).toBe(0);
    expect(body.uploads.totalSize).toBe('0');
  });

  it('response reflects actual DB download and upload counts from the accepted record', async () => {
    const f = db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Stats',
        address: '10.0.0.19',
        port: 7734,
        status: 'INCOMING_PENDING',
        downloadCount: 3,
        downloadTotalBytes: 5000n,
        uploadCount: 7,
        uploadTotalBytes: 12000n,
      })
      .returning()
      .get()!;
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'accept' }));
    const body = await res.json();
    expect(body.downloads.count).toBe(3);
    expect(body.downloads.totalSize).toBe('5000');
    expect(body.uploads.count).toBe(7);
    expect(body.uploads.totalSize).toBe('12000');
  });

  it('response includes online boolean to match GET /api/friends shape', async () => {
    const f = db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Grace3',
        address: '10.0.0.17',
        port: 7734,
        status: 'INCOMING_PENDING',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'accept' }));
    const body = await res.json();
    expect(body.online).toBe(false);
  });

  it('response reflects actual connection state: online true when peer is connected', async () => {
    const nodeId = 'node-connected-test';
    const f = db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Connected',
        nodeId,
        address: '10.0.0.18',
        port: 7734,
        status: 'INCOMING_PENDING',
      })
      .returning()
      .get()!;
    const fakePeer = registerPeer(
      { send: () => {}, close: () => {} },
      Buffer.alloc(32),
      nodeId,
      Buffer.alloc(32),
      '10.0.0.18',
      7734,
    );
    try {
      const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'accept' }));
      const body = await res.json();
      expect(body.online).toBe(true);
    } finally {
      unregisterPeer(nodeId);
      void fakePeer; // keep linter happy
    }
  });

  it('returns 409 when accepting a non-INCOMING_PENDING friend', async () => {
    const f = db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Hank',
        address: '10.0.0.11',
        port: 7734,
        status: 'OUTGOING_PENDING',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'accept' }));
    expect(res.status).toBe(409);
  });

  it('returns 404 for unknown friend id', async () => {
    const res = await makeHandler()(
      jsonReq('/api/friends/nonexistent', 'PUT', { action: 'accept' }),
    );
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/friends/:id — reject', () => {
  it('rejects an INCOMING_PENDING friend and returns 204', async () => {
    const f = db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Iris',
        address: '10.0.0.12',
        port: 7734,
        status: 'INCOMING_PENDING',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'reject' }));
    expect(res.status).toBe(204);
    const found = db.select().from(friends).where(eq(friends.id, f.id)).get() ?? null;
    expect(found).toBeNull();
  });

  it('returns 409 when rejecting an ACCEPTED friend', async () => {
    const f = db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Jack',
        address: '10.0.0.13',
        port: 7734,
        status: 'ACCEPTED',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'reject' }));
    expect(res.status).toBe(409);
  });

  it('returns 404 for unknown friend id', async () => {
    const res = await makeHandler()(
      jsonReq('/api/friends/nonexistent', 'PUT', { action: 'reject' }),
    );
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/friends/:id — validation', () => {
  it('returns 400 for invalid action', async () => {
    const f = db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Kim',
        address: '10.0.0.14',
        port: 7734,
        status: 'INCOMING_PENDING',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'delete' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing action', async () => {
    const f = db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Lee',
        address: '10.0.0.15',
        port: 7734,
        status: 'INCOMING_PENDING',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', {}));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid friend id (contains slash)', async () => {
    const res = await makeHandler()(jsonReq('/api/friends/foo/bar', 'PUT', { action: 'accept' }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/friends/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/friends/:id', () => {
  it('deletes a friend and returns 204', async () => {
    const f = db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Mike',
        address: '10.0.0.20',
        port: 7734,
        status: 'ACCEPTED',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req(`/api/friends/${f.id}`, { method: 'DELETE' }));
    expect(res.status).toBe(204);
    const found = db.select().from(friends).where(eq(friends.id, f.id)).get() ?? null;
    expect(found).toBeNull();
  });

  it('returns 404 for unknown friend', async () => {
    const res = await makeHandler()(req('/api/friends/nonexistent', { method: 'DELETE' }));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/settings
// ---------------------------------------------------------------------------

describe('GET /api/settings', () => {
  it('returns safe settings without invitePassword', async () => {
    db.insert(settings).values({ id: 'singleton', name: 'MyNode', invitePassword: 'secret' }).run();
    const res = await makeHandler()(req('/api/settings'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('MyNode');
    expect(body.hasInvitePassword).toBe(true);
    expect('invitePassword' in body).toBe(false);
  });

  it('creates default settings on first call', async () => {
    const res = await makeHandler()(req('/api/settings'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasInvitePassword).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/settings
// ---------------------------------------------------------------------------

describe('PATCH /api/settings', () => {
  it('updates settings and returns safe result', async () => {
    const res = await makeHandler()(
      jsonReq('/api/settings', 'PATCH', { name: 'UpdatedNode', autoAcceptFromAnyone: true }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('UpdatedNode');
    expect(body.autoAcceptFromAnyone).toBe(true);
    expect('invitePassword' in body).toBe(false);
  });

  it('trims and enforces max length on name', async () => {
    const res = await makeHandler()(jsonReq('/api/settings', 'PATCH', { name: '  trimmed  ' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('trimmed');
  });

  it('returns 400 for name exceeding 200 chars', async () => {
    const res = await makeHandler()(jsonReq('/api/settings', 'PATCH', { name: 'a'.repeat(201) }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for unknown keys', async () => {
    const res = await makeHandler()(jsonReq('/api/settings', 'PATCH', { unknown: true }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for wrong type on autoAcceptFromAnyone', async () => {
    const res = await makeHandler()(
      jsonReq('/api/settings', 'PATCH', { autoAcceptFromAnyone: 'yes' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await makeHandler()(
      new Request('http://localhost/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('stores and returns sharedFolders as an array', async () => {
    const res = await makeHandler()(
      jsonReq('/api/settings', 'PATCH', { sharedFolders: ['/music', '/videos'] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sharedFolders).toEqual(['/music', '/videos']);
  });

  it('stores and returns downloadFolder', async () => {
    const res = await makeHandler()(
      jsonReq('/api/settings', 'PATCH', { downloadFolder: '/downloads' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.downloadFolder).toBe('/downloads');
  });

  it('clears downloadFolder when set to null', async () => {
    await makeHandler()(jsonReq('/api/settings', 'PATCH', { downloadFolder: '/downloads' }));
    const res = await makeHandler()(jsonReq('/api/settings', 'PATCH', { downloadFolder: null }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.downloadFolder).toBeNull();
  });

  it('indexes shared folders in the background when they are patched, with no separate rescan call', async () => {
    const dir = join(tmpDir, 'settings-auto-scan');
    await mkdir(dir);
    await writeFile(join(dir, 'song.txt'), 'content');

    const start = Date.now();
    const res = await makeHandler()(jsonReq('/api/settings', 'PATCH', { sharedFolders: [dir] }));
    expect(res.status).toBe(200);
    // The response must not block on the scan — verifies the fix for the
    // wizard hanging on "Saving..." for large libraries.
    expect(Date.now() - start).toBeLessThan(500);

    await waitFor(() => !isScanning());
    const statsRes = await makeHandler()(req('/api/stats'));
    const stats = await statsRes.json();
    expect(stats.sharedFiles.count).toBe(1);
  });

  // Regression test for a real user-reported bug: adding a second shared
  // folder while the first one's scan was still running silently dropped
  // the second folder — scanAndIndex's mutex just discarded the request
  // instead of remembering it, so its pre-existing files never got
  // indexed (periodic rescan, the only other thing that would have picked
  // it up, is disabled by default).
  it('indexes a folder added while an earlier scan is still running', async () => {
    const dir1 = join(tmpDir, 'settings-queue-dir1');
    const dir2 = join(tmpDir, 'settings-queue-dir2');
    await mkdir(dir1);
    await mkdir(dir2);
    await writeFile(join(dir1, 'a.txt'), 'a');
    await writeFile(join(dir2, 'b.txt'), 'b');

    const res1 = await makeHandler()(jsonReq('/api/settings', 'PATCH', { sharedFolders: [dir1] }));
    expect(res1.status).toBe(200);
    expect(isScanning()).toBe(true); // scanAndIndex's mutex is set synchronously

    const res2 = await makeHandler()(
      jsonReq('/api/settings', 'PATCH', { sharedFolders: [dir1, dir2] }),
    );
    expect(res2.status).toBe(200);

    await waitFor(() => !isScanning());
    const statsRes = await makeHandler()(req('/api/stats'));
    const stats = await statsRes.json();
    expect(stats.sharedFiles.count).toBe(2);
  });

  it('syncs the file watcher when sharedFolders is patched', async () => {
    const dir = join(tmpDir, 'settings-watcher-sync');
    await mkdir(dir);
    const watcher = makeFakeWatcher();
    const handler = createManagementFetch({
      identity,
      db,
      connectPeer: neverConnect,
      updater: makeFakeUpdater(),
      watcher,
    });

    const res = await handler(jsonReq('/api/settings', 'PATCH', { sharedFolders: [dir] }));
    expect(res.status).toBe(200);
    expect(watcher.syncFoldersCalls).toEqual([[dir]]);
    await waitFor(() => !isScanning());
  });

  it('does not sync the file watcher when sharedFolders is not part of the patch', async () => {
    const watcher = makeFakeWatcher();
    const handler = createManagementFetch({
      identity,
      db,
      connectPeer: neverConnect,
      updater: makeFakeUpdater(),
      watcher,
    });

    await handler(jsonReq('/api/settings', 'PATCH', { name: 'Unrelated watcher test' }));
    expect(watcher.syncFoldersCalls).toEqual([]);
  });

  it('does not scan when sharedFolders is not part of the patch', async () => {
    const dir = join(tmpDir, 'settings-no-scan');
    await mkdir(dir);
    await writeFile(join(dir, 'song.txt'), 'content');
    await makeHandler()(jsonReq('/api/settings', 'PATCH', { sharedFolders: [dir] }));
    await waitFor(() => !isScanning());

    // A patch that omits sharedFolders shouldn't re-trigger a scan — add a
    // second file that a scan would pick up, then patch an unrelated field.
    await writeFile(join(dir, 'second.txt'), 'more content');
    await makeHandler()(jsonReq('/api/settings', 'PATCH', { name: 'Unrelated' }));

    const statsRes = await makeHandler()(req('/api/stats'));
    const stats = await statsRes.json();
    expect(stats.sharedFiles.count).toBe(1);
  });

  it('updates listenPort and returns it', async () => {
    const res = await makeHandler()(jsonReq('/api/settings', 'PATCH', { listenPort: 8080 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.listenPort).toBe(8080);
  });

  it('returns 400 for listenPort below 1', async () => {
    const res = await makeHandler()(jsonReq('/api/settings', 'PATCH', { listenPort: 0 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for listenPort above 65535', async () => {
    const res = await makeHandler()(jsonReq('/api/settings', 'PATCH', { listenPort: 65536 }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for non-integer listenPort', async () => {
    const res = await makeHandler()(jsonReq('/api/settings', 'PATCH', { listenPort: 80.5 }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/rescan
// ---------------------------------------------------------------------------

describe('POST /api/rescan', () => {
  it('returns 202 immediately without waiting for the scan to finish', async () => {
    const dir = join(tmpDir, 'rescan-basic');
    await mkdir(dir);
    await writeFile(join(dir, 'song.txt'), 'content');
    await makeHandler()(jsonReq('/api/settings', 'PATCH', { sharedFolders: [dir] }));
    await waitFor(() => !isScanning());
    db.delete(sharedFiles).run(); // undo the auto-scan from the PATCH above

    const start = Date.now();
    const res = await makeHandler()(req('/api/rescan', { method: 'POST' }));
    expect(res.status).toBe(202);
    expect(Date.now() - start).toBeLessThan(500);

    await waitFor(() => !isScanning());
    expect(sharedFileCount()).toBe(1);
  });

  it('removes stale entries in the background', async () => {
    const dir = join(tmpDir, 'rescan-stale');
    await mkdir(dir);
    const stalePath = join(dir, 'stale.txt');
    await writeFile(stalePath, 'stale');
    await makeHandler()(jsonReq('/api/settings', 'PATCH', { sharedFolders: [dir] }));
    await waitFor(() => !isScanning());

    await rm(stalePath);
    await makeHandler()(req('/api/rescan', { method: 'POST' }));
    await waitFor(() => !isScanning());
    expect(sharedFileCount()).toBe(0);
  });

  it('returns 409 when a scan is already in progress', async () => {
    const dir = join(tmpDir, 'rescan-in-progress');
    await mkdir(dir);
    await writeFile(join(dir, 'song.txt'), 'content');
    await makeHandler()(jsonReq('/api/settings', 'PATCH', { sharedFolders: [dir] }));
    await waitFor(() => !isScanning());

    const inFlight = scanAndIndex(db, [dir]);
    expect(isScanning()).toBe(true);
    const res = await makeHandler()(req('/api/rescan', { method: 'POST' }));
    expect(res.status).toBe(409);
    await inFlight;
  });
});

// ---------------------------------------------------------------------------
// GET /api/stats
// ---------------------------------------------------------------------------

describe('GET /api/stats', () => {
  beforeEach(async () => {
    db.delete(downloads).run();
    db.delete(sharedFiles).run();
    db.delete(friends).run();
  });

  it('returns zero counts when nothing is indexed', async () => {
    const res = await makeHandler()(req('/api/stats'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sharedFiles.count).toBe(0);
    expect(body.sharedFiles.totalSize).toBe('0');
    expect(body.friends.total).toBe(0);
    expect(body.friends.online).toBe(0);
    expect(body.downloads.count).toBe(0);
    expect(body.downloads.totalSize).toBe('0');
  });

  it('counts indexed files and sums their sizes', async () => {
    db.insert(sharedFiles)
      .values(
        [
          { path: '/a.mp3', filename: 'a.mp3', size: 1000n, sha256: 'aa'.repeat(32) },
          { path: '/b.mp3', filename: 'b.mp3', size: 2500n, sha256: 'bb'.repeat(32) },
        ].map((d) => ({
          id: randomUUID(),
          lastSeenAt: new Date(),
          indexedAt: new Date(),
          updatedAt: new Date(),
          ...d,
        })),
      )
      .run();
    const res = await makeHandler()(req('/api/stats'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sharedFiles.count).toBe(2);
    expect(body.sharedFiles.totalSize).toBe('3500');
  });

  it('counts only ACCEPTED friends', async () => {
    db.insert(friends)
      .values(
        [
          { name: 'Alice', address: '1.1.1.1', port: 7734, status: 'ACCEPTED' as FriendStatus },
          { name: 'Bob', address: '2.2.2.2', port: 7734, status: 'ACCEPTED' as FriendStatus },
          {
            name: 'Carol',
            address: '3.3.3.3',
            port: 7734,
            status: 'OUTGOING_PENDING' as FriendStatus,
          },
          {
            name: 'Dave',
            address: '4.4.4.4',
            port: 7734,
            status: 'INCOMING_PENDING' as FriendStatus,
          },
        ].map((d) => ({ id: randomUUID(), addedAt: new Date(), updatedAt: new Date(), ...d })),
      )
      .run();
    const res = await makeHandler()(req('/api/stats'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.friends.total).toBe(2);
    expect(body.friends.online).toBe(0);
  });

  it('counts only COMPLETED downloads', async () => {
    db.insert(downloads)
      .values(
        [
          {
            sha256: 'a'.repeat(64),
            filename: 'done.mp3',
            size: 1000n,
            state: 'COMPLETED' as DownloadState,
            sources: '[]',
          },
          {
            sha256: 'b'.repeat(64),
            filename: 'fail.mp3',
            size: 2000n,
            state: 'FAILED' as DownloadState,
            sources: '[]',
          },
          {
            sha256: 'c'.repeat(64),
            filename: 'dl.mp3',
            size: 3000n,
            state: 'DOWNLOADING' as DownloadState,
            sources: '[]',
          },
        ].map((d) => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...d })),
      )
      .run();
    const res = await makeHandler()(req('/api/stats'));
    const body = await res.json();
    expect(body.downloads.count).toBe(1);
    expect(body.downloads.totalSize).toBe('1000');
  });

  it('sums sizes across multiple completed downloads', async () => {
    db.insert(downloads)
      .values(
        [
          {
            sha256: 'a'.repeat(64),
            filename: 'a.mp3',
            size: 500n,
            state: 'COMPLETED' as DownloadState,
            sources: '[]',
          },
          {
            sha256: 'b'.repeat(64),
            filename: 'b.mp3',
            size: 1500n,
            state: 'COMPLETED' as DownloadState,
            sources: '[]',
          },
        ].map((d) => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...d })),
      )
      .run();
    const res = await makeHandler()(req('/api/stats'));
    const body = await res.json();
    expect(body.downloads.count).toBe(2);
    expect(body.downloads.totalSize).toBe('2000');
  });
});

// ---------------------------------------------------------------------------
// GET /api/search
// ---------------------------------------------------------------------------

describe('GET /api/search', () => {
  beforeEach(async () => {
    db.insert(sharedFiles)
      .values(
        [
          {
            path: '/music/song.mp3',
            filename: 'song.mp3',
            size: 1000n,
            sha256: 'a'.repeat(64),
            mimeType: 'audio/mpeg',
            metadata: null,
          },
          {
            path: '/docs/readme.txt',
            filename: 'readme.txt',
            size: 500n,
            sha256: 'b'.repeat(64),
            mimeType: 'text/plain',
            metadata: null,
          },
        ].map((d) => ({
          id: randomUUID(),
          lastSeenAt: new Date(),
          indexedAt: new Date(),
          updatedAt: new Date(),
          ...d,
        })),
      )
      .run();
  });

  it('returns all files with empty query', async () => {
    const res = await makeHandler()(req('/api/search'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.files).toHaveLength(2);
  });

  it('serializes size as a string', async () => {
    const res = await makeHandler()(req('/api/search'));
    const body = await res.json();
    // files ordered by filename asc: readme.txt (500), song.mp3 (1000)
    expect(body.files[0].filename).toBe('readme.txt');
    expect(body.files[0].size).toBe('500');
    expect(typeof body.files[0].size).toBe('string');
  });

  it('filters by query string', async () => {
    const res = await makeHandler()(req('/api/search?q=song'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.files[0].filename).toBe('song.mp3');
  });

  it('filters by type', async () => {
    const res = await makeHandler()(req('/api/search?type=audio'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.files[0].filename).toBe('song.mp3');
  });

  it('respects limit and offset', async () => {
    const res = await makeHandler()(req('/api/search?limit=1&offset=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toHaveLength(1);
    expect(body.total).toBe(2);
  });

  it('returns 400 for invalid type', async () => {
    const res = await makeHandler()(req('/api/search?type=unknown'));
    expect(res.status).toBe(400);
  });

  it('returns 400 for limit below 1', async () => {
    const res = await makeHandler()(req('/api/search?limit=0'));
    expect(res.status).toBe(400);
  });

  it('returns 400 for negative offset', async () => {
    const res = await makeHandler()(req('/api/search?offset=-1'));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/search/stream', () => {
  beforeEach(async () => {
    db.insert(sharedFiles)
      .values(
        [
          {
            path: '/music/song.mp3',
            filename: 'song.mp3',
            size: 1000n,
            sha256: 'a'.repeat(64),
            mimeType: 'audio/mpeg',
            metadata: null,
          },
        ].map((d) => ({
          id: randomUUID(),
          lastSeenAt: new Date(),
          indexedAt: new Date(),
          updatedAt: new Date(),
          ...d,
        })),
      )
      .run();
  });

  it('sends local results immediately, then done, when there are no connected peers', async () => {
    const res = await makeHandler()(req('/api/search/stream?q=song'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const events = parseSseEvents(await res.text());
    expect(events.map((e) => e.event)).toEqual(['local', 'done']);
    const localData = events[0].data as { files: { filename: string }[]; total: number };
    expect(localData.files).toHaveLength(1);
    expect(localData.files[0].filename).toBe('song.mp3');
  });

  it('streams a network batch between local and done when a peer is connected', async () => {
    const nodeId = 'alice-node';
    db.insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Alice',
        address: '10.0.0.99',
        port: 7734,
        nodeId,
        status: 'ACCEPTED',
      })
      .run();
    registerPeer(
      { send: () => {}, close: () => {} },
      Buffer.alloc(32),
      nodeId,
      Buffer.alloc(32),
      '10.0.0.99',
      7734,
    );
    try {
      const fakeNetworkResult = {
        filename: 'remote.mp3',
        size: '9999',
        sha256: 'b'.repeat(64),
        mimeType: 'audio/mpeg',
        metadata: null,
        nodeId,
      };
      const handler = createManagementFetch({
        identity,
        db,
        connectPeer: neverConnect,
        updater: makeFakeUpdater(),
        networkSearch: async (_id, _peers, _params, _t, _s, _st, onBatch) => {
          onBatch?.([fakeNetworkResult]);
          return [fakeNetworkResult];
        },
      });

      const res = await handler(req('/api/search/stream?q=song'));
      const events = parseSseEvents(await res.text());
      expect(events.map((e) => e.event)).toEqual(['local', 'network', 'done']);
      expect((events[1].data as unknown[])[0]).toMatchObject({ filename: 'remote.mp3' });
    } finally {
      unregisterPeer(nodeId);
    }
  });

  it('returns 400 for invalid type', async () => {
    const res = await makeHandler()(req('/api/search/stream?type=unknown'));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/transfers  /  POST /api/transfers  /  PATCH  /  DELETE
// ---------------------------------------------------------------------------

describe('GET /api/transfers', () => {
  beforeEach(async () => {
    db.delete(downloads).run();
  });

  it('returns an empty array when no transfers exist', async () => {
    const res = await makeHandler()(req('/api/transfers'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns existing download records', async () => {
    db
      .insert(downloads)
      .values({
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        sha256: 'a'.repeat(64),
        filename: 'test.mp3',
        size: 1000n,
        sources: '["node1"]',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req('/api/transfers'));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].filename).toBe('test.mp3');
    expect(typeof body[0].progress).toBe('number');
  });
});

describe('POST /api/transfers', () => {
  beforeEach(async () => {
    db.delete(downloads).run();
    await makeHandler()(jsonReq('/api/settings', 'PATCH', { downloadFolder: tmpDir }));
  });

  it('returns 422 when download folder is not configured', async () => {
    await makeHandler()(jsonReq('/api/settings', 'PATCH', { downloadFolder: null }));
    const res = await makeHandler()(
      jsonReq('/api/transfers', 'POST', {
        sha256: 'b'.repeat(64),
        filename: 'file.txt',
        size: '100',
        sources: ['a'.repeat(32)],
      }),
    );
    expect(res.status).toBe(422);
  });

  it('returns 400 for missing/invalid fields', async () => {
    const res = await makeHandler()(
      jsonReq('/api/transfers', 'POST', { sha256: 'bad', filename: '', size: 'x', sources: [] }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when sources array exceeds 100 entries', async () => {
    const res = await makeHandler()(
      jsonReq('/api/transfers', 'POST', {
        sha256: 'a'.repeat(64),
        filename: 'big.mp3',
        size: '1000',
        sources: Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(32, '0')),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when a source entry exceeds 200 characters', async () => {
    const res = await makeHandler()(
      jsonReq('/api/transfers', 'POST', {
        sha256: 'a'.repeat(64),
        filename: 'big.mp3',
        size: '1000',
        sources: ['x'.repeat(201)],
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when a source nodeId is not a 32-character lowercase hex string', async () => {
    for (const badId of [
      'not-a-node-id',
      'A'.repeat(32), // uppercase hex
      'a'.repeat(31), // too short
      'a'.repeat(33), // too long
      'a'.repeat(31) + 'Z', // invalid char
    ]) {
      const res = await makeHandler()(
        jsonReq('/api/transfers', 'POST', {
          sha256: 'a'.repeat(64),
          filename: 'song.mp3',
          size: '1000',
          sources: [badId],
        }),
      );
      expect(res.status).toBe(400);
    }
  });

  it('truncates filenames longer than 200 characters to prevent ENAMETOOLONG', async () => {
    const longFilename = 'a'.repeat(300) + '.txt';
    const res = await makeHandler()(
      jsonReq('/api/transfers', 'POST', {
        sha256: 'd'.repeat(64),
        filename: longFilename,
        size: '100',
        sources: ['a'.repeat(32)],
      }),
    );
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const dl = db.select().from(downloads).where(eq(downloads.id, id)).get()!;
    expect(dl.filename.length).toBeLessThanOrEqual(200);
  });

  it('trims whitespace from source nodeIds so they match stored Friend.nodeId values', async () => {
    const nodeA = 'a'.repeat(32);
    const nodeB = 'b'.repeat(32);
    const res = await makeHandler()(
      jsonReq('/api/transfers', 'POST', {
        sha256: 'b'.repeat(64),
        filename: 'trim.mp3',
        size: '500',
        sources: [`  ${nodeA}  `, `${nodeB}  `],
      }),
    );
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const dl = db.select().from(downloads).where(eq(downloads.id, id)).get()!;
    expect(JSON.parse(dl.sources)).toEqual([nodeA, nodeB]);
  });

  it('creates a download and returns 201 with the id', async () => {
    const res = await makeHandler()(
      jsonReq('/api/transfers', 'POST', {
        sha256: 'c'.repeat(64),
        filename: 'song.mp3',
        size: '12345',
        mimeType: 'audio/mpeg',
        sources: ['c'.repeat(32)],
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe('string');
  });
});

describe('PATCH /api/transfers/:id', () => {
  beforeEach(async () => {
    db.delete(downloads).run();
  });

  it('returns 400 for an unknown action', async () => {
    const dl = db
      .insert(downloads)
      .values({
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        sha256: 'd'.repeat(64),
        filename: 'a.txt',
        size: 100n,
        state: 'DOWNLOADING',
        sources: '[]',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(jsonReq(`/api/transfers/${dl.id}`, 'PATCH', { action: 'fly' }));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/transfers/:id', () => {
  beforeEach(async () => {
    db.delete(downloads).run();
  });

  it('deletes a completed download', async () => {
    const dl = db
      .insert(downloads)
      .values({
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        sha256: 'e'.repeat(64),
        filename: 'done.txt',
        size: 100n,
        state: 'COMPLETED',
        sources: '[]',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req(`/api/transfers/${dl.id}`, { method: 'DELETE' }));
    expect(res.status).toBe(204);
    expect(db.select().from(downloads).where(eq(downloads.id, dl.id)).get() ?? null).toBeNull();
  });

  it('refuses to delete an active download', async () => {
    const dl = db
      .insert(downloads)
      .values({
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        sha256: 'f'.repeat(64),
        filename: 'active.txt',
        size: 100n,
        state: 'DOWNLOADING',
        sources: '[]',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req(`/api/transfers/${dl.id}`, { method: 'DELETE' }));
    expect(res.status).toBe(409);
  });

  it('returns 404 for unknown id', async () => {
    const res = await makeHandler()(req('/api/transfers/nonexistent', { method: 'DELETE' }));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/uploads
// ---------------------------------------------------------------------------

describe('GET /api/uploads', () => {
  it('returns an empty array when no uploads are active', async () => {
    const res = await makeHandler()(req('/api/uploads'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns 405 for non-GET requests', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await makeHandler()(req('/api/uploads', { method }));
      expect(res.status).toBe(405);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/conversations
// ---------------------------------------------------------------------------

describe('GET /api/conversations', () => {
  beforeEach(async () => {
    db.delete(messages).run();
    db.delete(conversations).run();
  });

  it('returns empty array when no conversations', async () => {
    const res = await makeHandler()(req('/api/conversations'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns conversations with latest message included', async () => {
    db.insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:abc',
        type: 'GROUP',
        name: 'Test',
      })
      .run();
    db
      .insert(messages)
      .values({
        id: randomUUID(),
        conversationId: 'group:abc',
        fromNodeId: 'node-a',
        body: 'Hello',
        sentAt: new Date(),
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req('/api/conversations'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('group:abc');
    expect(body[0].messages).toHaveLength(1);
    expect(body[0].messages[0].body).toBe('Hello');
  });

  it('orders conversations by updatedAt desc', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        id: 'group:first',
        type: 'GROUP',
        name: 'First',
        updatedAt: new Date('2025-01-01'),
      })
      .returning()
      .get()!;
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        id: 'group:second',
        type: 'GROUP',
        name: 'Second',
        updatedAt: new Date('2025-06-01'),
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req('/api/conversations'));
    const body = await res.json();
    expect(body[0].id).toBe('group:second');
    expect(body[1].id).toBe('group:first');
  });
});

// ---------------------------------------------------------------------------
// POST /api/conversations
// ---------------------------------------------------------------------------

describe('POST /api/conversations — DM', () => {
  beforeEach(async () => {
    db.delete(messages).run();
    db.delete(conversations).run();
    db.delete(friends).run();
  });

  it('creates a DM conversation and returns 200', async () => {
    db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Peer',
        address: '10.0.0.1',
        port: 7734,
        nodeId: 'peer-node-1',
        status: 'ACCEPTED',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(
      jsonReq('/api/conversations', 'POST', { peerNodeId: 'peer-node-1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe('DM');
    expect(body.id).toMatch(/^dm:/);
  });

  it('response includes messages array', async () => {
    db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Peer4',
        address: '10.0.0.4',
        port: 7734,
        nodeId: 'peer-node-4',
        status: 'ACCEPTED',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(
      jsonReq('/api/conversations', 'POST', { peerNodeId: 'peer-node-4' }),
    );
    const body = await res.json();
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('returns 403 when peerNodeId is not an accepted friend', async () => {
    const res = await makeHandler()(
      jsonReq('/api/conversations', 'POST', { peerNodeId: 'unknown-node' }),
    );
    expect(res.status).toBe(403);
  });

  it('is idempotent — opening the same DM twice returns same id', async () => {
    db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Peer2',
        address: '10.0.0.2',
        port: 7734,
        nodeId: 'peer-node-2',
        status: 'ACCEPTED',
      })
      .returning()
      .get()!;
    const res1 = await makeHandler()(
      jsonReq('/api/conversations', 'POST', { peerNodeId: 'peer-node-2' }),
    );
    const res2 = await makeHandler()(
      jsonReq('/api/conversations', 'POST', { peerNodeId: 'peer-node-2' }),
    );
    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.id).toBe(body2.id);
  });

  it('trims peerNodeId whitespace', async () => {
    db
      .insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Peer3',
        address: '10.0.0.3',
        port: 7734,
        nodeId: 'peer-node-3',
        status: 'ACCEPTED',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(
      jsonReq('/api/conversations', 'POST', { peerNodeId: '  peer-node-3  ' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).not.toContain('  ');
  });
});

describe('POST /api/conversations — group', () => {
  beforeEach(async () => {
    db.delete(messages).run();
    db.delete(conversations).run();
  });

  it('creates a group conversation and returns 201', async () => {
    const res = await makeHandler()(jsonReq('/api/conversations', 'POST', { name: 'Dev Chat' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe('GROUP');
    expect(body.name).toBe('Dev Chat');
    expect(body.id).toMatch(/^group:/);
  });

  it('trims group name', async () => {
    const res = await makeHandler()(jsonReq('/api/conversations', 'POST', { name: '  Trimmed  ' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe('Trimmed');
  });

  it('truncates group name to 200 chars', async () => {
    const res = await makeHandler()(
      jsonReq('/api/conversations', 'POST', { name: 'a'.repeat(300) }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name!.length).toBe(200);
  });

  it('returns 400 when name is empty string', async () => {
    const res = await makeHandler()(jsonReq('/api/conversations', 'POST', { name: '   ' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when neither name nor peerNodeId is provided', async () => {
    const res = await makeHandler()(jsonReq('/api/conversations', 'POST', {}));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('either peerNodeId or name is required');
  });

  it('broadcasts a group-create message to connected accepted peers so the room appears immediately, without waiting for a first chat message', async () => {
    const nodeId = 'group-create-broadcast-peer';
    db.insert(friends)
      .values({
        id: randomUUID(),
        addedAt: new Date(),
        updatedAt: new Date(),
        name: 'Peer',
        nodeId,
        address: '10.0.0.30',
        port: 7734,
        status: 'ACCEPTED',
      })
      .run();
    const sends: Buffer[] = [];
    const fakePeer = registerPeer(
      {
        send: (d: string | Uint8Array) => sends.push(Buffer.from(d as Uint8Array)),
        close: () => {},
      },
      Buffer.alloc(32),
      nodeId,
      Buffer.alloc(32),
      '10.0.0.30',
      7734,
    );
    try {
      const res = await makeHandler()(jsonReq('/api/conversations', 'POST', { name: 'Dev Chat' }));
      expect(res.status).toBe(201);
      expect(sends.length).toBe(1);
    } finally {
      unregisterPeer(nodeId);
      void fakePeer;
    }
  });

  it('response includes messages array', async () => {
    const res = await makeHandler()(
      jsonReq('/api/conversations', 'POST', { name: 'With Messages' }),
    );
    const body = await res.json();
    expect(Array.isArray(body.messages)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/conversations/:id/messages
// ---------------------------------------------------------------------------

describe('GET /api/conversations/:id/messages', () => {
  beforeEach(async () => {
    db.delete(messages).run();
    db.delete(conversations).run();
  });

  it('returns empty array when conversation has no messages', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:empty',
        type: 'GROUP',
        name: 'Empty',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req('/api/conversations/group:empty/messages'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns messages ordered by sentAt asc', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:ordered',
        type: 'GROUP',
        name: 'Ordered',
      })
      .returning()
      .get()!;
    db
      .insert(messages)
      .values({
        id: randomUUID(),
        conversationId: 'group:ordered',
        fromNodeId: 'n',
        body: 'First',
        sentAt: new Date('2025-01-01'),
      })
      .returning()
      .get()!;
    db
      .insert(messages)
      .values({
        id: randomUUID(),
        conversationId: 'group:ordered',
        fromNodeId: 'n',
        body: 'Second',
        sentAt: new Date('2025-06-01'),
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req('/api/conversations/group:ordered/messages'));
    const body = await res.json();
    expect(body[0].body).toBe('First');
    expect(body[1].body).toBe('Second');
  });

  it('respects the limit query param', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:limited',
        type: 'GROUP',
        name: 'Limited',
      })
      .returning()
      .get()!;
    for (let i = 0; i < 5; i++) {
      db
        .insert(messages)
        .values({
          id: randomUUID(),
          conversationId: 'group:limited',
          fromNodeId: 'n',
          body: `msg${i}`,
          sentAt: new Date(2025, 0, i + 1),
        })
        .returning()
        .get()!;
    }
    const res = await makeHandler()(req('/api/conversations/group:limited/messages?limit=3'));
    const body = await res.json();
    expect(body).toHaveLength(3);
  });

  it('returns the newest messages when count exceeds limit', async () => {
    db.insert(conversations)
      .values({
        id: 'group:newest',
        createdAt: new Date(),
        updatedAt: new Date(),
        type: 'GROUP',
        name: 'Newest',
      })
      .run();
    db.insert(messages)
      .values(
        Array.from({ length: 10 }, (_, i) => ({
          id: randomUUID(),
          conversationId: 'group:newest',
          fromNodeId: 'n',
          body: `msg${i}`,
          sentAt: new Date(2025, 0, i + 1),
        })),
      )
      .run();
    const res = await makeHandler()(req('/api/conversations/group:newest/messages?limit=3'));
    const body = await res.json();
    // Should return the 3 newest in chronological order: msg7, msg8, msg9
    expect(body).toHaveLength(3);
    expect(body[0].body).toBe('msg7');
    expect(body[2].body).toBe('msg9');
  });

  it('caps limit at 200 — returns exactly 200 messages even when more exist', async () => {
    db.insert(conversations)
      .values({
        id: 'group:cap',
        createdAt: new Date(),
        updatedAt: new Date(),
        type: 'GROUP',
        name: 'Cap',
      })
      .run();
    db.insert(messages)
      .values(
        Array.from({ length: 201 }, (_, i) => ({
          id: randomUUID(),
          conversationId: 'group:cap',
          fromNodeId: 'n',
          body: `msg${i}`,
          sentAt: new Date(2025, 0, i + 1),
        })),
      )
      .run();
    const res = await makeHandler()(req('/api/conversations/group:cap/messages?limit=9999'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(200);
  });

  it('returns 400 for an invalid before date', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:before-bad',
        type: 'GROUP',
        name: 'B',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(
      req('/api/conversations/group:before-bad/messages?before=not-a-date'),
    );
    expect(res.status).toBe(400);
  });

  it('clamps negative limit to 1', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:neg',
        type: 'GROUP',
        name: 'Neg',
      })
      .returning()
      .get()!;
    db
      .insert(messages)
      .values({
        id: randomUUID(),
        conversationId: 'group:neg',
        fromNodeId: 'n',
        body: 'hi',
        sentAt: new Date(),
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req('/api/conversations/group:neg/messages?limit=-5'));
    expect(res.status).toBe(200);
    // With a clamped limit of 1 we still get a valid (non-reversed) response
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('returns 400 for invalid conversation id containing slash', async () => {
    const res = await makeHandler()(req('/api/conversations/foo/bar/messages'));
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown conversation', async () => {
    const res = await makeHandler()(req('/api/conversations/group:nope/messages'));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/conversations/:id/messages
// ---------------------------------------------------------------------------

describe('POST /api/conversations/:id/messages', () => {
  beforeEach(async () => {
    db.delete(messages).run();
    db.delete(conversations).run();
  });

  it('creates a message and returns 201', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:send',
        type: 'GROUP',
        name: 'Send',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(
      jsonReq('/api/conversations/group:send/messages', 'POST', { body: 'Hello world' }),
    );
    expect(res.status).toBe(201);
    const msg = await res.json();
    expect(msg.body).toBe('Hello world');
    expect(msg.fromNodeId).toBe(identity.nodeId);
  });

  it('trims message body', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:trim',
        type: 'GROUP',
        name: 'Trim',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(
      jsonReq('/api/conversations/group:trim/messages', 'POST', { body: '  trimmed  ' }),
    );
    expect(res.status).toBe(201);
    const msg = await res.json();
    expect(msg.body).toBe('trimmed');
  });

  it('returns 404 for unknown conversation', async () => {
    const res = await makeHandler()(
      jsonReq('/api/conversations/group:nope/messages', 'POST', { body: 'hi' }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for empty body', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:empty-body',
        type: 'GROUP',
        name: 'E',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(
      jsonReq('/api/conversations/group:empty-body/messages', 'POST', { body: '   ' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing body field', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:no-body',
        type: 'GROUP',
        name: 'N',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(
      jsonReq('/api/conversations/group:no-body/messages', 'POST', {}),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for body exceeding 10000 chars', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:long-body',
        type: 'GROUP',
        name: 'L',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(
      jsonReq('/api/conversations/group:long-body/messages', 'POST', { body: 'a'.repeat(10_001) }),
    );
    expect(res.status).toBe(400);
  });

  it('always sets fromNodeId to identity.nodeId', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:identity',
        type: 'GROUP',
        name: 'I',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(
      jsonReq('/api/conversations/group:identity/messages', 'POST', {
        body: 'Test',
        fromNodeId: 'SPOOFED',
      }),
    );
    const msg = await res.json();
    expect(msg.fromNodeId).toBe(identity.nodeId);
  });

  it('returns 403 when sending to a DM whose partner is no longer an accepted friend', async () => {
    const convId = `dm:${[identity.nodeId, 'ex-friend-node'].sort().join(':')}`;
    db
      .insert(conversations)
      .values({ createdAt: new Date(), updatedAt: new Date(), id: convId, type: 'DM' })
      .returning()
      .get()!;
    // no friend row seeded — partner is not accepted
    const res = await makeHandler()(
      jsonReq(`/api/conversations/${convId}/messages`, 'POST', { body: 'Hello' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 for a DM conversation whose id does not include the local node', async () => {
    // A DM between two other nodes — local node is not a participant
    const convId = `dm:${['other-node-a', 'other-node-b'].sort().join(':')}`;
    db
      .insert(conversations)
      .values({ createdAt: new Date(), updatedAt: new Date(), id: convId, type: 'DM' })
      .returning()
      .get()!;
    const res = await makeHandler()(
      jsonReq(`/api/conversations/${convId}/messages`, 'POST', { body: 'Sneaky' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for a DM conversation with a malformed id (wrong prefix)', async () => {
    // type=DM but id doesn't start with dm: — malformed data
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:malformed-as-dm',
        type: 'DM',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(
      jsonReq(`/api/conversations/group:malformed-as-dm/messages`, 'POST', { body: 'Bad' }),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/conversations/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/conversations/:id', () => {
  beforeEach(async () => {
    db.delete(messages).run();
    db.delete(conversations).run();
  });

  it('deletes the conversation and returns 204', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:del',
        type: 'GROUP',
        name: 'Del',
      })
      .returning()
      .get()!;
    const res = await makeHandler()(req('/api/conversations/group:del', { method: 'DELETE' }));
    expect(res.status).toBe(204);
    expect(
      db.select().from(conversations).where(eq(conversations.id, 'group:del')).get() ?? null,
    ).toBeNull();
  });

  it('cascades delete to messages', async () => {
    db
      .insert(conversations)
      .values({
        createdAt: new Date(),
        updatedAt: new Date(),
        id: 'group:cascade',
        type: 'GROUP',
        name: 'Cascade',
      })
      .returning()
      .get()!;
    const msgId = randomUUID();
    db
      .insert(messages)
      .values({
        id: msgId,
        conversationId: 'group:cascade',
        fromNodeId: 'n',
        body: 'Bye',
        sentAt: new Date(),
      })
      .returning()
      .get()!;
    await makeHandler()(req('/api/conversations/group:cascade', { method: 'DELETE' }));
    expect(db.select().from(messages).where(eq(messages.id, msgId)).get() ?? null).toBeNull();
  });

  it('returns 404 for unknown conversation', async () => {
    const res = await makeHandler()(req('/api/conversations/group:nope', { method: 'DELETE' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid conversation id containing slash', async () => {
    const res = await makeHandler()(req('/api/conversations/foo/bar', { method: 'DELETE' }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST/GET/PATCH/DELETE /api/scripts
// ---------------------------------------------------------------------------

describe('scripts API', () => {
  beforeEach(async () => {
    db.delete(postDownloadScripts).run();
  });

  describe('GET /api/scripts', () => {
    it('returns empty array when no scripts', async () => {
      const res = await makeHandler()(req('/api/scripts'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it('returns scripts ordered by order field', async () => {
      db.insert(postDownloadScripts)
        .values(
          [
            { path: '/b.ts', order: 1 },
            { path: '/a.ts', order: 0 },
          ].map((d) => ({ id: randomUUID(), createdAt: new Date(), ...d })),
        )
        .run();
      const res = await makeHandler()(req('/api/scripts'));
      const body = await res.json();
      expect(body[0].path).toBe('/a.ts');
      expect(body[1].path).toBe('/b.ts');
    });
  });

  describe('POST /api/scripts', () => {
    it('creates a new script and returns 201', async () => {
      const res = await makeHandler()(jsonReq('/api/scripts', 'POST', { path: '/my/script.ts' }));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.path).toBe('/my/script.ts');
      expect(typeof body.id).toBe('string');
      expect(typeof body.order).toBe('number');
    });

    it('assigns incrementing order values', async () => {
      await makeHandler()(jsonReq('/api/scripts', 'POST', { path: '/first.ts' }));
      const res = await makeHandler()(jsonReq('/api/scripts', 'POST', { path: '/second.ts' }));
      const body = await res.json();
      const first =
        db
          .select()
          .from(postDownloadScripts)
          .where(eq(postDownloadScripts.path, '/first.ts'))
          .get() ?? null;
      expect(body.order).toBe((first?.order ?? -1) + 1);
    });

    it('returns 409 when path already exists', async () => {
      db
        .insert(postDownloadScripts)
        .values({ id: randomUUID(), createdAt: new Date(), path: '/dup.ts', order: 0 })
        .returning()
        .get()!;
      const res = await makeHandler()(jsonReq('/api/scripts', 'POST', { path: '/dup.ts' }));
      expect(res.status).toBe(409);
    });

    it('returns 400 for missing path', async () => {
      const res = await makeHandler()(jsonReq('/api/scripts', 'POST', {}));
      expect(res.status).toBe(400);
    });

    it('returns 400 for path longer than 1000 characters', async () => {
      const res = await makeHandler()(jsonReq('/api/scripts', 'POST', { path: 'x'.repeat(1001) }));
      expect(res.status).toBe(400);
    });

    it('returns 400 for path without .ts or .js extension', async () => {
      for (const path of ['/my/script.py', '/my/script.sh', '/my/script', '/my/script.tsx']) {
        const res = await makeHandler()(jsonReq('/api/scripts', 'POST', { path }));
        expect(res.status).toBe(400);
      }
    });
  });

  describe('PATCH /api/scripts/:id (reorder)', () => {
    it('swaps orders when moving down', async () => {
      const [a, _b] = [
        db
          .insert(postDownloadScripts)
          .values({ id: randomUUID(), path: '/a.ts', order: 0, createdAt: new Date() })
          .returning()
          .get()!,
        db
          .insert(postDownloadScripts)
          .values({ id: randomUUID(), path: '/b.ts', order: 1, createdAt: new Date() })
          .returning()
          .get()!,
      ];
      const res = await makeHandler()(
        jsonReq(`/api/scripts/${a.id}`, 'PATCH', { direction: 'down' }),
      );
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated[0].path).toBe('/b.ts');
      expect(updated[1].path).toBe('/a.ts');
    });

    it('swaps orders when moving up', async () => {
      const [_a, b] = [
        db
          .insert(postDownloadScripts)
          .values({ id: randomUUID(), path: '/a.ts', order: 0, createdAt: new Date() })
          .returning()
          .get()!,
        db
          .insert(postDownloadScripts)
          .values({ id: randomUUID(), path: '/b.ts', order: 1, createdAt: new Date() })
          .returning()
          .get()!,
      ];
      const res = await makeHandler()(
        jsonReq(`/api/scripts/${b.id}`, 'PATCH', { direction: 'up' }),
      );
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated[0].path).toBe('/b.ts');
      expect(updated[1].path).toBe('/a.ts');
    });

    it('returns 204 when already at the boundary', async () => {
      const s = db
        .insert(postDownloadScripts)
        .values({ id: randomUUID(), createdAt: new Date(), path: '/only.ts', order: 0 })
        .returning()
        .get()!;
      const res = await makeHandler()(
        jsonReq(`/api/scripts/${s.id}`, 'PATCH', { direction: 'up' }),
      );
      expect(res.status).toBe(204);
    });

    it('returns 404 for unknown script id', async () => {
      const res = await makeHandler()(jsonReq('/api/scripts/nope', 'PATCH', { direction: 'up' }));
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid direction', async () => {
      const s = db
        .insert(postDownloadScripts)
        .values({ id: randomUUID(), createdAt: new Date(), path: '/x.ts', order: 0 })
        .returning()
        .get()!;
      const res = await makeHandler()(
        jsonReq(`/api/scripts/${s.id}`, 'PATCH', { direction: 'sideways' }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/scripts/:id', () => {
    it('deletes the script and returns 204', async () => {
      const s = db
        .insert(postDownloadScripts)
        .values({ id: randomUUID(), createdAt: new Date(), path: '/del.ts', order: 0 })
        .returning()
        .get()!;
      const res = await makeHandler()(req(`/api/scripts/${s.id}`, { method: 'DELETE' }));
      expect(res.status).toBe(204);
      expect(
        db.select().from(postDownloadScripts).where(eq(postDownloadScripts.id, s.id)).get() ?? null,
      ).toBeNull();
    });

    it('returns 404 for unknown script id', async () => {
      const res = await makeHandler()(req('/api/scripts/nope', { method: 'DELETE' }));
      expect(res.status).toBe(404);
    });

    it('returns 400 for id containing slash', async () => {
      const res = await makeHandler()(req('/api/scripts/a/b', { method: 'DELETE' }));
      expect(res.status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/fs
// ---------------------------------------------------------------------------

describe('GET /api/fs', () => {
  let fsRoot: string;

  beforeAll(async () => {
    fsRoot = await mkdtemp(join(tmpdir(), 'filenet-fs-test-'));
    await mkdir(join(fsRoot, 'Music'));
    await mkdir(join(fsRoot, 'Movies'));
    await mkdir(join(fsRoot, '.hidden'));
    await writeFile(join(fsRoot, 'readme.txt'), 'hello');
  });

  afterAll(async () => {
    await rm(fsRoot, { recursive: true, force: true });
  });

  it('lists subdirectories at a given path', async () => {
    const res = await makeHandler()(req(`/api/fs?path=${encodeURIComponent(fsRoot)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe(fsRoot);
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toContain('Movies');
    expect(names).toContain('Music');
  });

  it('excludes hidden directories and files', async () => {
    const res = await makeHandler()(req(`/api/fs?path=${encodeURIComponent(fsRoot)}`));
    const body = await res.json();
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).not.toContain('.hidden');
    expect(names).not.toContain('readme.txt');
  });

  it('includes parent path (null at filesystem root)', async () => {
    const res = await makeHandler()(req(`/api/fs?path=${encodeURIComponent(fsRoot)}`));
    const body = await res.json();
    expect(body.parent).not.toBeNull();

    const rootRes = await makeHandler()(req('/api/fs?path=/'));
    const rootBody = await rootRes.json();
    expect(rootBody.parent).toBeNull();
  });

  it('includes home directory in response', async () => {
    const res = await makeHandler()(req(`/api/fs?path=${encodeURIComponent(fsRoot)}`));
    const body = await res.json();
    expect(body.home).toBe(homedir());
  });

  it('defaults to the home directory when no path is given', async () => {
    const res = await makeHandler()(req('/api/fs'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe(homedir());
  });

  it('rejects relative paths', async () => {
    const res = await makeHandler()(req(`/api/fs?path=${encodeURIComponent('../somewhere')}`));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Path must be absolute');
  });

  it('normalizes trailing slashes and dot segments', async () => {
    const messy = `${fsRoot}/Music/../Music/`;
    const res = await makeHandler()(req(`/api/fs?path=${encodeURIComponent(messy)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe(join(fsRoot, 'Music'));
  });

  it('returns entries sorted alphabetically', async () => {
    const res = await makeHandler()(req(`/api/fs?path=${encodeURIComponent(fsRoot)}`));
    const body = await res.json();
    const names = body.entries.map((e: { name: string }) => e.name);
    expect(names).toEqual(
      [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    );
  });

  it('returns 400 for a non-existent path', async () => {
    const res = await makeHandler()(req('/api/fs?path=/this/does/not/exist/xyz123'));
    expect(res.status).toBe(400);
  });

  it('returns 400 for a path that is a file, not a directory', async () => {
    const filePath = join(fsRoot, 'readme.txt');
    const res = await makeHandler()(req(`/api/fs?path=${encodeURIComponent(filePath)}`));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------

describe('unknown routes', () => {
  it('returns 404 for unrecognised path', async () => {
    const res = await makeHandler()(req('/api/unknown'));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Update endpoints
// ---------------------------------------------------------------------------

describe('update endpoints', () => {
  it('GET /api/update-status returns the current state', async () => {
    const updater = makeFakeUpdater({ phase: 'ready', latestVersion: '0.2.0' });
    const res = await makeHandler(updater)(req('/api/update-status'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.phase).toBe('ready');
    expect(body.latestVersion).toBe('0.2.0');
  });

  it('POST /api/update-check triggers an immediate check', async () => {
    const updater = makeFakeUpdater();
    const res = await makeHandler(updater)(req('/api/update-check', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(updater.checkNowCalls).toBe(1);
  });

  it('POST /api/update-restart returns 409 when no update is ready', async () => {
    const updater = makeFakeUpdater({ phase: 'idle' });
    const res = await makeHandler(updater)(req('/api/update-restart', { method: 'POST' }));
    expect(res.status).toBe(409);
    expect(updater.applyAndRestartCalls).toBe(0);
  });

  it('POST /api/update-restart returns 409 in source mode even if phase is ready', async () => {
    const updater = makeFakeUpdater({ phase: 'ready', mode: 'source', latestVersion: '0.2.0' });
    const res = await makeHandler(updater)(req('/api/update-restart', { method: 'POST' }));
    expect(res.status).toBe(409);
  });

  it('POST /api/update-restart returns 200 immediately and schedules the restart when ready', async () => {
    const updater = makeFakeUpdater({ phase: 'ready', latestVersion: '0.2.0' });
    const res = await makeHandler(updater)(req('/api/update-restart', { method: 'POST' }));
    expect(res.status).toBe(200);
    // applyAndRestart is deliberately scheduled via setTimeout (not awaited
    // inline) so the HTTP response below can flush before the process
    // exits — see the route implementation. Give it a moment, then confirm
    // it was in fact triggered.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(updater.applyAndRestartCalls).toBe(1);
  });
});
