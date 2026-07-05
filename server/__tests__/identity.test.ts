import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { unlinkSync } from 'fs';

import { type Db, applyMigrations, createDb } from '../db';
import {
  deriveNodeId,
  generateIdentity,
  getOrCreateIdentity,
  loadIdentity,
  saveIdentity,
} from '../identity';
import { identity as identityTable } from '../schema';

const TEST_DB_URL = 'file:./data/test-identity.db';
let db: Db;

beforeAll(() => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
});

afterAll(() => {
  db.$client.close();
  try {
    unlinkSync('./data/test-identity.db');
  } catch {}
});

beforeEach(() => {
  db.delete(identityTable).run();
});

describe('generateIdentity', () => {
  it('returns a nodeId, publicKey, and privateKey', () => {
    const id = generateIdentity();
    expect(id.nodeId).toBeTypeOf('string');
    expect(id.nodeId.length).toBe(32);
    expect(id.publicKey).toBeInstanceOf(Buffer);
    expect(id.privateKey).toBeInstanceOf(Buffer);
  });

  it('produces unique identities', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(a.nodeId).not.toBe(b.nodeId);
    expect(a.publicKey.toString('hex')).not.toBe(b.publicKey.toString('hex'));
  });

  it('nodeId is derived from publicKey', () => {
    const id = generateIdentity();
    expect(id.nodeId).toBe(deriveNodeId(id.publicKey));
  });
});

describe('saveIdentity / loadIdentity', () => {
  it('saves and loads an identity', async () => {
    const id = generateIdentity();
    await saveIdentity(id, db);

    const loaded = await loadIdentity(db);
    expect(loaded).not.toBeNull();
    expect(loaded!.nodeId).toBe(id.nodeId);
    expect(loaded!.publicKey.toString('hex')).toBe(id.publicKey.toString('hex'));
    expect(loaded!.privateKey.toString('hex')).toBe(id.privateKey.toString('hex'));
  });

  it('returns null when no identity exists', async () => {
    const result = await loadIdentity(db);
    expect(result).toBeNull();
  });
});

describe('getOrCreateIdentity', () => {
  it('creates an identity if none exists', async () => {
    const id = await getOrCreateIdentity(db);
    expect(id.nodeId).toBeTypeOf('string');
    expect(id.nodeId.length).toBe(32);
  });

  it('returns the same identity on subsequent calls', async () => {
    const id = await getOrCreateIdentity(db);
    const id2 = await getOrCreateIdentity(db);
    expect(id2.nodeId).toBe(id.nodeId);
  });
});
