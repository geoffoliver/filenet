import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';

import { createManagementFetch } from '../management';
import { createPrismaClient } from '../db';
import { generateIdentity } from '../identity';

const TEST_DB_URL = 'file:./data/test-management.db';
let prisma: PrismaClient;

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

beforeAll(() => {
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
});

afterAll(async () => {
  await prisma.$disconnect();
  try {
    unlinkSync('./data/test-management.db');
  } catch {}
});

beforeEach(async () => {
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
