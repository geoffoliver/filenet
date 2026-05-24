import {
  afterAll, beforeAll, beforeEach, describe, expect, it,
} from 'bun:test';
import {
  deriveNodeId,
  generateIdentity,
  getOrCreateIdentity,
  loadIdentity,
  saveIdentity,
} from '../identity';
import type { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '../db';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';

const TEST_DB_URL = 'file:./data/test-identity.db';
let prisma: PrismaClient;

beforeAll(() => {
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
});

afterAll(async () => {
  await prisma.$disconnect();
  try { unlinkSync('./data/test-identity.db'); } catch {}
});

beforeEach(async () => {
  await prisma.identity.deleteMany();
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
    await saveIdentity(id, prisma);

    const loaded = await loadIdentity(prisma);
    expect(loaded).not.toBeNull();
    expect(loaded!.nodeId).toBe(id.nodeId);
    expect(loaded!.publicKey.toString('hex')).toBe(id.publicKey.toString('hex'));
    expect(loaded!.privateKey.toString('hex')).toBe(id.privateKey.toString('hex'));
  });

  it('returns null when no identity exists', async () => {
    const result = await loadIdentity(prisma);
    expect(result).toBeNull();
  });
});

describe('getOrCreateIdentity', () => {
  it('creates an identity if none exists', async () => {
    const id = await getOrCreateIdentity(prisma);
    expect(id.nodeId).toBeTypeOf('string');
    expect(id.nodeId.length).toBe(32);
  });

  it('returns the same identity on subsequent calls', async () => {
    const id = await getOrCreateIdentity(prisma);
    const id2 = await getOrCreateIdentity(prisma);
    expect(id2.nodeId).toBe(id.nodeId);
  });
});
