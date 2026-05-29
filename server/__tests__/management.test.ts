import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'fs';

import { createManagementFetch } from '../management';
import { createPrismaClient } from '../db';
import { generateIdentity } from '../identity';

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
});

// ---------------------------------------------------------------------------
// POST /api/friends
// ---------------------------------------------------------------------------

describe('POST /api/friends', () => {
  it('creates a friend and returns 201', async () => {
    const res = await makeHandler()(
      jsonReq('/api/friends', 'POST', { name: 'Bob', address: '10.0.0.2', port: 7734 }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe('Bob');
    expect(body.status).toBe('OUTGOING_PENDING');
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
// 404 fallback
// ---------------------------------------------------------------------------

describe('unknown routes', () => {
  it('returns 404 for unrecognised path', async () => {
    const res = await makeHandler()(req('/api/unknown'));
    expect(res.status).toBe(404);
  });
});
