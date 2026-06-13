import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { homedir, tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { join } from 'node:path';
import { unlinkSync } from 'fs';

import { registerPeer, unregisterPeer } from '../connections';
import { createManagementFetch } from '../management';
import { createPrismaClient } from '../db';
import { generateIdentity } from '../identity';
import { resetPendingForTesting } from '../transfer-protocol';

const TEST_DB_URL = 'file:./data/test-management.db';
let prisma: PrismaClient;
let tmpDir: string;

const identity = generateIdentity();
const neverConnect = async (): Promise<never> => {
  throw new Error('no real connections in tests');
};

function makeHandler() {
  return createManagementFetch({ identity, prisma, connectPeer: neverConnect });
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

beforeAll(async () => {
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
  tmpDir = await mkdtemp(join(tmpdir(), 'filenet-mgmt-test-'));
});

afterAll(async () => {
  await prisma.$disconnect();
  await rm(tmpDir, { recursive: true, force: true });
  try {
    unlinkSync('./data/test-management.db');
  } catch {}
});

beforeEach(async () => {
  await prisma.sharedFile.deleteMany();
  await prisma.friend.deleteMany();
  await prisma.settings.deleteMany();
  await prisma.postDownloadScript.deleteMany();
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
    await prisma.friend.create({
      data: { name: 'Alice', address: '10.0.0.1', port: 7734, status: 'INCOMING_PENDING' },
    });
    const res = await makeHandler()(req('/api/friends'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBe(1);
    expect(body[0].name).toBe('Alice');
  });

  it('includes online boolean on each friend', async () => {
    await prisma.friend.create({
      data: { name: 'Bob', address: '10.0.0.2', port: 7734, status: 'ACCEPTED' },
    });
    const res = await makeHandler()(req('/api/friends'));
    const body = await res.json();
    expect(typeof body[0].online).toBe('boolean');
    expect(body[0].online).toBe(false); // no peers connected in tests
  });

  it('does not expose remotePassword in the response', async () => {
    await prisma.friend.create({
      data: {
        name: 'Zara',
        address: '10.0.0.99',
        port: 7734,
        status: 'OUTGOING_PENDING',
        remotePassword: 'supersecret',
      },
    });
    const res = await makeHandler()(req('/api/friends'));
    const body = await res.json();
    const zara = body.find((f: { name: string }) => f.name === 'Zara');
    expect(zara).toBeDefined();
    expect(zara.remotePassword).toBeUndefined();
  });

  it('includes zero download stats for a friend with no downloads', async () => {
    await prisma.friend.create({
      data: {
        name: 'Carol',
        nodeId: 'node-carol',
        address: '10.0.0.3',
        port: 7734,
        status: 'ACCEPTED',
      },
    });
    const res = await makeHandler()(req('/api/friends'));
    const body = await res.json();
    expect(body[0].downloads.count).toBe(0);
    expect(body[0].downloads.totalSize).toBe('0');
    expect(body[0].uploads.count).toBe(0);
    expect(body[0].uploads.totalSize).toBe('0');
  });

  it('maps downloadCount/uploadCount and byte totals to the response shape', async () => {
    await prisma.friend.create({
      data: {
        name: 'Dave',
        nodeId: 'node-dave',
        address: '10.0.0.4',
        port: 7734,
        status: 'ACCEPTED',
        downloadCount: 2,
        downloadTotalBytes: 3000n,
        uploadCount: 5,
        uploadTotalBytes: 8000n,
      },
    });
    const res = await makeHandler()(req('/api/friends'));
    const body = await res.json();
    expect(body[0].downloads.count).toBe(2);
    expect(body[0].downloads.totalSize).toBe('3000');
    expect(body[0].uploads.count).toBe(5);
    expect(body[0].uploads.totalSize).toBe('8000');
  });

  it('pending and blocked friends always show zero download and upload stats', async () => {
    await prisma.friend.createMany({
      data: [
        {
          name: 'Incoming Frank',
          nodeId: 'node-frank',
          address: '10.0.0.6',
          port: 7734,
          status: 'INCOMING_PENDING',
        },
        {
          name: 'Blocked Grace',
          nodeId: 'node-grace',
          address: '10.0.0.7',
          port: 7734,
          status: 'BLOCKED',
        },
      ],
    });
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
    const f = await prisma.friend.create({
      data: {
        name: 'Eve',
        nodeId: 'node-eve',
        address: '10.0.0.8',
        port: 7734,
        status: 'BLOCKED',
        downloadCount: 5,
        downloadTotalBytes: 9000n,
        uploadCount: 3,
        uploadTotalBytes: 4000n,
      },
    });
    const res = await makeHandler()(req('/api/friends'));
    const body = await res.json();
    const eve = body.find((fr: { name: string }) => fr.name === f.name);
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
    const handler = createManagementFetch({ identity, prisma, connectPeer: syncThrow });
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
    const f = await prisma.friend.create({
      data: { name: 'Grace', address: '10.0.0.10', port: 7734, status: 'INCOMING_PENDING' },
    });
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'accept' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ACCEPTED');
  });

  it('does not expose remotePassword in the accept response', async () => {
    const f = await prisma.friend.create({
      data: {
        name: 'NoLeak',
        address: '10.0.0.17',
        port: 7734,
        status: 'INCOMING_PENDING',
        remotePassword: 'should-not-appear',
      },
    });
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'accept' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.remotePassword).toBeUndefined();
  });

  it('response includes zero download and upload stats for a freshly created friend', async () => {
    const f = await prisma.friend.create({
      data: { name: 'Grace2', address: '10.0.0.16', port: 7734, status: 'INCOMING_PENDING' },
    });
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'accept' }));
    const body = await res.json();
    expect(body.downloads.count).toBe(0);
    expect(body.downloads.totalSize).toBe('0');
    expect(body.uploads.count).toBe(0);
    expect(body.uploads.totalSize).toBe('0');
  });

  it('response reflects actual DB download and upload counts from the accepted record', async () => {
    const f = await prisma.friend.create({
      data: {
        name: 'Stats',
        address: '10.0.0.19',
        port: 7734,
        status: 'INCOMING_PENDING',
        downloadCount: 3,
        downloadTotalBytes: 5000n,
        uploadCount: 7,
        uploadTotalBytes: 12000n,
      },
    });
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'accept' }));
    const body = await res.json();
    expect(body.downloads.count).toBe(3);
    expect(body.downloads.totalSize).toBe('5000');
    expect(body.uploads.count).toBe(7);
    expect(body.uploads.totalSize).toBe('12000');
  });

  it('response includes online boolean to match GET /api/friends shape', async () => {
    const f = await prisma.friend.create({
      data: { name: 'Grace3', address: '10.0.0.17', port: 7734, status: 'INCOMING_PENDING' },
    });
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'accept' }));
    const body = await res.json();
    expect(body.online).toBe(false);
  });

  it('response reflects actual connection state: online true when peer is connected', async () => {
    const nodeId = 'node-connected-test';
    const f = await prisma.friend.create({
      data: {
        name: 'Connected',
        nodeId,
        address: '10.0.0.18',
        port: 7734,
        status: 'INCOMING_PENDING',
      },
    });
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
    const f = await prisma.friend.create({
      data: { name: 'Hank', address: '10.0.0.11', port: 7734, status: 'OUTGOING_PENDING' },
    });
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
    const f = await prisma.friend.create({
      data: { name: 'Iris', address: '10.0.0.12', port: 7734, status: 'INCOMING_PENDING' },
    });
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'reject' }));
    expect(res.status).toBe(204);
    const found = await prisma.friend.findUnique({ where: { id: f.id } });
    expect(found).toBeNull();
  });

  it('returns 409 when rejecting an ACCEPTED friend', async () => {
    const f = await prisma.friend.create({
      data: { name: 'Jack', address: '10.0.0.13', port: 7734, status: 'ACCEPTED' },
    });
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
    const f = await prisma.friend.create({
      data: { name: 'Kim', address: '10.0.0.14', port: 7734, status: 'INCOMING_PENDING' },
    });
    const res = await makeHandler()(jsonReq(`/api/friends/${f.id}`, 'PUT', { action: 'delete' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing action', async () => {
    const f = await prisma.friend.create({
      data: { name: 'Lee', address: '10.0.0.15', port: 7734, status: 'INCOMING_PENDING' },
    });
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
    const f = await prisma.friend.create({
      data: { name: 'Mike', address: '10.0.0.20', port: 7734, status: 'ACCEPTED' },
    });
    const res = await makeHandler()(req(`/api/friends/${f.id}`, { method: 'DELETE' }));
    expect(res.status).toBe(204);
    const found = await prisma.friend.findUnique({ where: { id: f.id } });
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
    await prisma.settings.create({
      data: { id: 'singleton', name: 'MyNode', invitePassword: 'secret' },
    });
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

  describe('env-controlled fields', () => {
    // Capture before any test mutates, restore after each — unconditionally
    // deleting would clobber a developer's real environment.
    const savedSharedFolders = process.env.SHARED_FOLDERS;
    const savedDownloadFolder = process.env.DOWNLOAD_FOLDER;

    afterEach(() => {
      if (savedSharedFolders === undefined) delete process.env.SHARED_FOLDERS;
      else process.env.SHARED_FOLDERS = savedSharedFolders;
      if (savedDownloadFolder === undefined) delete process.env.DOWNLOAD_FOLDER;
      else process.env.DOWNLOAD_FOLDER = savedDownloadFolder;
    });

    it('rejects sharedFolders when SHARED_FOLDERS env var is set', async () => {
      process.env.SHARED_FOLDERS = '/shared';
      const res = await makeHandler()(
        jsonReq('/api/settings', 'PATCH', { sharedFolders: ['/evil'] }),
      );
      expect(res.status).toBe(409);
      expect(await res.text()).toContain('SHARED_FOLDERS');
    });

    it('rejects downloadFolder when DOWNLOAD_FOLDER env var is set', async () => {
      process.env.DOWNLOAD_FOLDER = '/downloads';
      const res = await makeHandler()(
        jsonReq('/api/settings', 'PATCH', { downloadFolder: '/evil' }),
      );
      expect(res.status).toBe(409);
      expect(await res.text()).toContain('DOWNLOAD_FOLDER');
    });

    it('still allows unrelated fields when env vars are set', async () => {
      process.env.SHARED_FOLDERS = '/shared';
      process.env.DOWNLOAD_FOLDER = '/downloads';
      const res = await makeHandler()(jsonReq('/api/settings', 'PATCH', { name: 'EnvLocked' }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('EnvLocked');
    });

    it('allows sharedFolders patch when only DOWNLOAD_FOLDER is set', async () => {
      process.env.DOWNLOAD_FOLDER = '/downloads';
      const res = await makeHandler()(
        jsonReq('/api/settings', 'PATCH', { sharedFolders: ['/music'] }),
      );
      expect(res.status).toBe(200);
    });
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
  it('returns indexed and removed counts', async () => {
    const dir = join(tmpDir, 'rescan-basic');
    await mkdir(dir);
    await writeFile(join(dir, 'song.txt'), 'content');
    await makeHandler()(jsonReq('/api/settings', 'PATCH', { sharedFolders: [dir] }));

    const res = await makeHandler()(req('/api/rescan', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.indexed).toBe(1);
    expect(body.removed).toBe(0);
  });

  it('indexes zero files when no shared folders are configured', async () => {
    const res = await makeHandler()(req('/api/rescan', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.indexed).toBe(0);
    expect(body.removed).toBe(0);
  });

  it('reports removed count for stale entries', async () => {
    const dir = join(tmpDir, 'rescan-stale');
    await mkdir(dir);
    const stalePath = join(dir, 'stale.txt');
    await writeFile(stalePath, 'stale');
    await makeHandler()(jsonReq('/api/settings', 'PATCH', { sharedFolders: [dir] }));
    await makeHandler()(req('/api/rescan', { method: 'POST' }));
    await rm(stalePath);
    const res = await makeHandler()(req('/api/rescan', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/stats
// ---------------------------------------------------------------------------

describe('GET /api/stats', () => {
  beforeEach(async () => {
    await prisma.download.deleteMany();
    await prisma.sharedFile.deleteMany();
    await prisma.friend.deleteMany();
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
    await prisma.sharedFile.createMany({
      data: [
        { path: '/a.mp3', filename: 'a.mp3', size: 1000n, sha256: 'aa'.repeat(32) },
        { path: '/b.mp3', filename: 'b.mp3', size: 2500n, sha256: 'bb'.repeat(32) },
      ],
    });
    const res = await makeHandler()(req('/api/stats'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sharedFiles.count).toBe(2);
    expect(body.sharedFiles.totalSize).toBe('3500');
  });

  it('counts only ACCEPTED friends', async () => {
    await prisma.friend.createMany({
      data: [
        { name: 'Alice', address: '1.1.1.1', port: 7734, status: 'ACCEPTED' },
        { name: 'Bob', address: '2.2.2.2', port: 7734, status: 'ACCEPTED' },
        { name: 'Carol', address: '3.3.3.3', port: 7734, status: 'OUTGOING_PENDING' },
        { name: 'Dave', address: '4.4.4.4', port: 7734, status: 'INCOMING_PENDING' },
      ],
    });
    const res = await makeHandler()(req('/api/stats'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.friends.total).toBe(2);
    expect(body.friends.online).toBe(0);
  });

  it('counts only COMPLETED downloads', async () => {
    await prisma.download.createMany({
      data: [
        {
          sha256: 'a'.repeat(64),
          filename: 'done.mp3',
          size: 1000n,
          state: 'COMPLETED',
          sources: '[]',
        },
        {
          sha256: 'b'.repeat(64),
          filename: 'fail.mp3',
          size: 2000n,
          state: 'FAILED',
          sources: '[]',
        },
        {
          sha256: 'c'.repeat(64),
          filename: 'dl.mp3',
          size: 3000n,
          state: 'DOWNLOADING',
          sources: '[]',
        },
      ],
    });
    const res = await makeHandler()(req('/api/stats'));
    const body = await res.json();
    expect(body.downloads.count).toBe(1);
    expect(body.downloads.totalSize).toBe('1000');
  });

  it('sums sizes across multiple completed downloads', async () => {
    await prisma.download.createMany({
      data: [
        {
          sha256: 'a'.repeat(64),
          filename: 'a.mp3',
          size: 500n,
          state: 'COMPLETED',
          sources: '[]',
        },
        {
          sha256: 'b'.repeat(64),
          filename: 'b.mp3',
          size: 1500n,
          state: 'COMPLETED',
          sources: '[]',
        },
      ],
    });
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
    await prisma.sharedFile.createMany({
      data: [
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
      ],
    });
  });

  it('returns all files with empty query', async () => {
    const res = await makeHandler()(req('/api/search'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.files).toHaveLength(2);
  });

  it('omits network field when network param is not set', async () => {
    const res = await makeHandler()(req('/api/search'));
    const body = await res.json();
    expect('network' in body).toBe(false);
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

  it('network=true returns empty network array when accepted friends are not connected', async () => {
    await prisma.friend.create({
      data: {
        name: 'Bob',
        address: '127.0.0.1',
        port: 7734,
        nodeId: 'bob-node',
        status: 'ACCEPTED',
      },
    });
    const res = await makeHandler()(req('/api/search?network=true'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.network)).toBe(true);
    expect(body.network).toHaveLength(0);
  });

  it('network=true does not fan out to pending friends', async () => {
    await prisma.friend.create({
      data: {
        name: 'Pending',
        address: '127.0.0.1',
        port: 7734,
        nodeId: 'pending-node',
        status: 'INCOMING_PENDING',
      },
    });
    const res = await makeHandler()(req('/api/search?network=true'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.network).toHaveLength(0);
  });

  it('network=true includes results from connected peers alongside local results', async () => {
    await prisma.friend.create({
      data: {
        name: 'Alice',
        address: '10.0.0.99',
        port: 7734,
        nodeId: 'alice-node',
        status: 'ACCEPTED',
      },
    });
    const fakeNetworkResult = {
      filename: 'remote.mp3',
      size: '9999',
      sha256: 'a'.repeat(64),
      mimeType: 'audio/mpeg',
      metadata: null,
      nodeId: 'alice-node',
    };
    const handler = createManagementFetch({
      identity,
      prisma,
      connectPeer: neverConnect,
      networkSearch: async () => [fakeNetworkResult],
    });

    const res = await handler(req('/api/search?network=true'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.network)).toBe(true);
    expect(body.network).toHaveLength(1);
    expect(body.network[0].filename).toBe('remote.mp3');
    expect(body.network[0].nodeId).toBe('alice-node');
    // Local results still present
    expect(Array.isArray(body.files)).toBe(true);
    expect(typeof body.total).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// GET /api/transfers  /  POST /api/transfers  /  PATCH  /  DELETE
// ---------------------------------------------------------------------------

describe('GET /api/transfers', () => {
  beforeEach(async () => {
    await prisma.download.deleteMany();
  });

  it('returns an empty array when no transfers exist', async () => {
    const res = await makeHandler()(req('/api/transfers'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns existing download records', async () => {
    await prisma.download.create({
      data: { sha256: 'a'.repeat(64), filename: 'test.mp3', size: 1000n, sources: '["node1"]' },
    });
    const res = await makeHandler()(req('/api/transfers'));
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].filename).toBe('test.mp3');
    expect(typeof body[0].progress).toBe('number');
  });
});

describe('POST /api/transfers', () => {
  beforeEach(async () => {
    await prisma.download.deleteMany();
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
    const dl = await prisma.download.findUniqueOrThrow({ where: { id } });
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
    const dl = await prisma.download.findUniqueOrThrow({ where: { id } });
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
    await prisma.download.deleteMany();
  });

  it('returns 400 for an unknown action', async () => {
    const dl = await prisma.download.create({
      data: {
        sha256: 'd'.repeat(64),
        filename: 'a.txt',
        size: 100n,
        state: 'DOWNLOADING',
        sources: '[]',
      },
    });
    const res = await makeHandler()(jsonReq(`/api/transfers/${dl.id}`, 'PATCH', { action: 'fly' }));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/transfers/:id', () => {
  beforeEach(async () => {
    await prisma.download.deleteMany();
  });

  it('deletes a completed download', async () => {
    const dl = await prisma.download.create({
      data: {
        sha256: 'e'.repeat(64),
        filename: 'done.txt',
        size: 100n,
        state: 'COMPLETED',
        sources: '[]',
      },
    });
    const res = await makeHandler()(req(`/api/transfers/${dl.id}`, { method: 'DELETE' }));
    expect(res.status).toBe(204);
    expect(await prisma.download.findUnique({ where: { id: dl.id } })).toBeNull();
  });

  it('refuses to delete an active download', async () => {
    const dl = await prisma.download.create({
      data: {
        sha256: 'f'.repeat(64),
        filename: 'active.txt',
        size: 100n,
        state: 'DOWNLOADING',
        sources: '[]',
      },
    });
    const res = await makeHandler()(req(`/api/transfers/${dl.id}`, { method: 'DELETE' }));
    expect(res.status).toBe(409);
  });

  it('returns 404 for unknown id', async () => {
    const res = await makeHandler()(req('/api/transfers/nonexistent', { method: 'DELETE' }));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/conversations
// ---------------------------------------------------------------------------

describe('GET /api/conversations', () => {
  beforeEach(async () => {
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
  });

  it('returns empty array when no conversations', async () => {
    const res = await makeHandler()(req('/api/conversations'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns conversations with latest message included', async () => {
    const conv = await prisma.conversation.create({
      data: { id: 'group:abc', type: 'GROUP', name: 'Test' },
    });
    await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId: conv.id,
        fromNodeId: 'node-a',
        body: 'Hello',
        sentAt: new Date(),
      },
    });
    const res = await makeHandler()(req('/api/conversations'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('group:abc');
    expect(body[0].messages).toHaveLength(1);
    expect(body[0].messages[0].body).toBe('Hello');
  });

  it('orders conversations by updatedAt desc', async () => {
    await prisma.conversation.create({
      data: { id: 'group:first', type: 'GROUP', name: 'First', updatedAt: new Date('2025-01-01') },
    });
    await prisma.conversation.create({
      data: {
        id: 'group:second',
        type: 'GROUP',
        name: 'Second',
        updatedAt: new Date('2025-06-01'),
      },
    });
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
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
    await prisma.friend.deleteMany();
  });

  it('creates a DM conversation and returns 200', async () => {
    await prisma.friend.create({
      data: {
        name: 'Peer',
        address: '10.0.0.1',
        port: 7734,
        nodeId: 'peer-node-1',
        status: 'ACCEPTED',
      },
    });
    const res = await makeHandler()(
      jsonReq('/api/conversations', 'POST', { peerNodeId: 'peer-node-1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe('DM');
    expect(body.id).toMatch(/^dm:/);
  });

  it('response includes messages array', async () => {
    await prisma.friend.create({
      data: {
        name: 'Peer4',
        address: '10.0.0.4',
        port: 7734,
        nodeId: 'peer-node-4',
        status: 'ACCEPTED',
      },
    });
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
    await prisma.friend.create({
      data: {
        name: 'Peer2',
        address: '10.0.0.2',
        port: 7734,
        nodeId: 'peer-node-2',
        status: 'ACCEPTED',
      },
    });
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
    await prisma.friend.create({
      data: {
        name: 'Peer3',
        address: '10.0.0.3',
        port: 7734,
        nodeId: 'peer-node-3',
        status: 'ACCEPTED',
      },
    });
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
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
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
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
  });

  it('returns empty array when conversation has no messages', async () => {
    await prisma.conversation.create({ data: { id: 'group:empty', type: 'GROUP', name: 'Empty' } });
    const res = await makeHandler()(req('/api/conversations/group:empty/messages'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns messages ordered by sentAt asc', async () => {
    await prisma.conversation.create({
      data: { id: 'group:ordered', type: 'GROUP', name: 'Ordered' },
    });
    await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId: 'group:ordered',
        fromNodeId: 'n',
        body: 'First',
        sentAt: new Date('2025-01-01'),
      },
    });
    await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId: 'group:ordered',
        fromNodeId: 'n',
        body: 'Second',
        sentAt: new Date('2025-06-01'),
      },
    });
    const res = await makeHandler()(req('/api/conversations/group:ordered/messages'));
    const body = await res.json();
    expect(body[0].body).toBe('First');
    expect(body[1].body).toBe('Second');
  });

  it('respects the limit query param', async () => {
    await prisma.conversation.create({
      data: { id: 'group:limited', type: 'GROUP', name: 'Limited' },
    });
    for (let i = 0; i < 5; i++) {
      await prisma.message.create({
        data: {
          id: randomUUID(),
          conversationId: 'group:limited',
          fromNodeId: 'n',
          body: `msg${i}`,
          sentAt: new Date(2025, 0, i + 1),
        },
      });
    }
    const res = await makeHandler()(req('/api/conversations/group:limited/messages?limit=3'));
    const body = await res.json();
    expect(body).toHaveLength(3);
  });

  it('returns the newest messages when count exceeds limit', async () => {
    await prisma.conversation.create({
      data: { id: 'group:newest', type: 'GROUP', name: 'Newest' },
    });
    await prisma.message.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        id: randomUUID(),
        conversationId: 'group:newest',
        fromNodeId: 'n',
        body: `msg${i}`,
        sentAt: new Date(2025, 0, i + 1),
      })),
    });
    const res = await makeHandler()(req('/api/conversations/group:newest/messages?limit=3'));
    const body = await res.json();
    // Should return the 3 newest in chronological order: msg7, msg8, msg9
    expect(body).toHaveLength(3);
    expect(body[0].body).toBe('msg7');
    expect(body[2].body).toBe('msg9');
  });

  it('caps limit at 200 — returns exactly 200 messages even when more exist', async () => {
    await prisma.conversation.create({ data: { id: 'group:cap', type: 'GROUP', name: 'Cap' } });
    await prisma.message.createMany({
      data: Array.from({ length: 201 }, (_, i) => ({
        id: randomUUID(),
        conversationId: 'group:cap',
        fromNodeId: 'n',
        body: `msg${i}`,
        sentAt: new Date(2025, 0, i + 1),
      })),
    });
    const res = await makeHandler()(req('/api/conversations/group:cap/messages?limit=9999'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(200);
  });

  it('returns 400 for an invalid before date', async () => {
    await prisma.conversation.create({
      data: { id: 'group:before-bad', type: 'GROUP', name: 'B' },
    });
    const res = await makeHandler()(
      req('/api/conversations/group:before-bad/messages?before=not-a-date'),
    );
    expect(res.status).toBe(400);
  });

  it('clamps negative limit to 1 — does not pass a negative take to Prisma', async () => {
    await prisma.conversation.create({ data: { id: 'group:neg', type: 'GROUP', name: 'Neg' } });
    await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId: 'group:neg',
        fromNodeId: 'n',
        body: 'hi',
        sentAt: new Date(),
      },
    });
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
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
  });

  it('creates a message and returns 201', async () => {
    await prisma.conversation.create({ data: { id: 'group:send', type: 'GROUP', name: 'Send' } });
    const res = await makeHandler()(
      jsonReq('/api/conversations/group:send/messages', 'POST', { body: 'Hello world' }),
    );
    expect(res.status).toBe(201);
    const msg = await res.json();
    expect(msg.body).toBe('Hello world');
    expect(msg.fromNodeId).toBe(identity.nodeId);
  });

  it('trims message body', async () => {
    await prisma.conversation.create({ data: { id: 'group:trim', type: 'GROUP', name: 'Trim' } });
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
    await prisma.conversation.create({
      data: { id: 'group:empty-body', type: 'GROUP', name: 'E' },
    });
    const res = await makeHandler()(
      jsonReq('/api/conversations/group:empty-body/messages', 'POST', { body: '   ' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for missing body field', async () => {
    await prisma.conversation.create({ data: { id: 'group:no-body', type: 'GROUP', name: 'N' } });
    const res = await makeHandler()(
      jsonReq('/api/conversations/group:no-body/messages', 'POST', {}),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for body exceeding 10000 chars', async () => {
    await prisma.conversation.create({ data: { id: 'group:long-body', type: 'GROUP', name: 'L' } });
    const res = await makeHandler()(
      jsonReq('/api/conversations/group:long-body/messages', 'POST', { body: 'a'.repeat(10_001) }),
    );
    expect(res.status).toBe(400);
  });

  it('always sets fromNodeId to identity.nodeId', async () => {
    await prisma.conversation.create({ data: { id: 'group:identity', type: 'GROUP', name: 'I' } });
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
    await prisma.conversation.create({ data: { id: convId, type: 'DM' } });
    // no friend row seeded — partner is not accepted
    const res = await makeHandler()(
      jsonReq(`/api/conversations/${convId}/messages`, 'POST', { body: 'Hello' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 for a DM conversation whose id does not include the local node', async () => {
    // A DM between two other nodes — local node is not a participant
    const convId = `dm:${['other-node-a', 'other-node-b'].sort().join(':')}`;
    await prisma.conversation.create({ data: { id: convId, type: 'DM' } });
    const res = await makeHandler()(
      jsonReq(`/api/conversations/${convId}/messages`, 'POST', { body: 'Sneaky' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for a DM conversation with a malformed id (wrong prefix)', async () => {
    // type=DM but id doesn't start with dm: — malformed data
    await prisma.conversation.create({ data: { id: 'group:malformed-as-dm', type: 'DM' } });
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
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
  });

  it('deletes the conversation and returns 204', async () => {
    await prisma.conversation.create({ data: { id: 'group:del', type: 'GROUP', name: 'Del' } });
    const res = await makeHandler()(req('/api/conversations/group:del', { method: 'DELETE' }));
    expect(res.status).toBe(204);
    expect(await prisma.conversation.findUnique({ where: { id: 'group:del' } })).toBeNull();
  });

  it('cascades delete to messages', async () => {
    await prisma.conversation.create({
      data: { id: 'group:cascade', type: 'GROUP', name: 'Cascade' },
    });
    const msgId = randomUUID();
    await prisma.message.create({
      data: {
        id: msgId,
        conversationId: 'group:cascade',
        fromNodeId: 'n',
        body: 'Bye',
        sentAt: new Date(),
      },
    });
    await makeHandler()(req('/api/conversations/group:cascade', { method: 'DELETE' }));
    expect(await prisma.message.findUnique({ where: { id: msgId } })).toBeNull();
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
    await prisma.postDownloadScript.deleteMany();
  });

  describe('GET /api/scripts', () => {
    it('returns empty array when no scripts', async () => {
      const res = await makeHandler()(req('/api/scripts'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it('returns scripts ordered by order field', async () => {
      await prisma.postDownloadScript.createMany({
        data: [
          { path: '/b.ts', order: 1 },
          { path: '/a.ts', order: 0 },
        ],
      });
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
      const first = await prisma.postDownloadScript.findUnique({ where: { path: '/first.ts' } });
      expect(body.order).toBe((first?.order ?? -1) + 1);
    });

    it('returns 409 when path already exists', async () => {
      await prisma.postDownloadScript.create({ data: { path: '/dup.ts', order: 0 } });
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
      const [a, _b] = await Promise.all([
        prisma.postDownloadScript.create({ data: { path: '/a.ts', order: 0 } }),
        prisma.postDownloadScript.create({ data: { path: '/b.ts', order: 1 } }),
      ]);
      const res = await makeHandler()(
        jsonReq(`/api/scripts/${a.id}`, 'PATCH', { direction: 'down' }),
      );
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated[0].path).toBe('/b.ts');
      expect(updated[1].path).toBe('/a.ts');
    });

    it('swaps orders when moving up', async () => {
      const [_a, b] = await Promise.all([
        prisma.postDownloadScript.create({ data: { path: '/a.ts', order: 0 } }),
        prisma.postDownloadScript.create({ data: { path: '/b.ts', order: 1 } }),
      ]);
      const res = await makeHandler()(
        jsonReq(`/api/scripts/${b.id}`, 'PATCH', { direction: 'up' }),
      );
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated[0].path).toBe('/b.ts');
      expect(updated[1].path).toBe('/a.ts');
    });

    it('returns 204 when already at the boundary', async () => {
      const s = await prisma.postDownloadScript.create({ data: { path: '/only.ts', order: 0 } });
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
      const s = await prisma.postDownloadScript.create({ data: { path: '/x.ts', order: 0 } });
      const res = await makeHandler()(
        jsonReq(`/api/scripts/${s.id}`, 'PATCH', { direction: 'sideways' }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/scripts/:id', () => {
    it('deletes the script and returns 204', async () => {
      const s = await prisma.postDownloadScript.create({ data: { path: '/del.ts', order: 0 } });
      const res = await makeHandler()(req(`/api/scripts/${s.id}`, { method: 'DELETE' }));
      expect(res.status).toBe(204);
      expect(await prisma.postDownloadScript.findUnique({ where: { id: s.id } })).toBeNull();
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
