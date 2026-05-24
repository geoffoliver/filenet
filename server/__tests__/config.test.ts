import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';

import { getOrCreateSettings, getSettings, sanitizeSettings, updateSettings } from '../config';
import { createPrismaClient } from '../db';

const TEST_DB_URL = 'file:./data/test-config.db';
let prisma: PrismaClient;

beforeAll(() => {
  execSync(`bunx prisma db push --url "${TEST_DB_URL}"`, { stdio: 'pipe' });
  prisma = createPrismaClient(TEST_DB_URL);
});

afterAll(async () => {
  await prisma.$disconnect();
  try {
    unlinkSync('./data/test-config.db');
  } catch {}
});

beforeEach(async () => {
  await prisma.settings.deleteMany();
});

describe('getSettings', () => {
  it('returns null when no settings exist', async () => {
    const result = await getSettings(prisma);
    expect(result).toBeNull();
  });
});

describe('getOrCreateSettings', () => {
  it('creates settings with defaults when none exist', async () => {
    const settings = await getOrCreateSettings(prisma);
    expect(settings.name).toBe('');
    expect(settings.invitePassword).toBeNull();
    expect(settings.autoAcceptFromAnyone).toBe(false);
    expect(settings.autoAcceptFromFriendsOfFriends).toBe(false);
  });

  it('returns the same settings on subsequent calls', async () => {
    const first = await getOrCreateSettings(prisma);
    const second = await getOrCreateSettings(prisma);
    expect(second.id).toBe(first.id);
  });

  it('returns the same id across concurrent calls (singleton)', async () => {
    const [a, b, c] = await Promise.all([
      getOrCreateSettings(prisma),
      getOrCreateSettings(prisma),
      getOrCreateSettings(prisma),
    ]);
    expect(a.id).toBe(b.id);
    expect(b.id).toBe(c.id);
    const count = await prisma.settings.count();
    expect(count).toBe(1);
  });
});

describe('updateSettings', () => {
  it('updates specific fields without touching others', async () => {
    await getOrCreateSettings(prisma);
    const updated = await updateSettings(prisma, { name: 'Alice', autoAcceptFromAnyone: true });
    expect(updated.name).toBe('Alice');
    expect(updated.autoAcceptFromAnyone).toBe(true);
    expect(updated.autoAcceptFromFriendsOfFriends).toBe(false);
  });

  it('stores and retrieves invite password', async () => {
    await getOrCreateSettings(prisma);
    const updated = await updateSettings(prisma, { invitePassword: 'secret123' });
    expect(updated.invitePassword).toBe('secret123');
  });

  it('clears invite password when set to null', async () => {
    await getOrCreateSettings(prisma);
    await updateSettings(prisma, { invitePassword: 'secret123' });
    const cleared = await updateSettings(prisma, { invitePassword: null });
    expect(cleared.invitePassword).toBeNull();
  });
});

describe('sanitizeSettings', () => {
  it('omits invitePassword and adds hasInvitePassword: false when not set', async () => {
    const settings = await getOrCreateSettings(prisma);
    const safe = sanitizeSettings(settings);
    expect('invitePassword' in safe).toBe(false);
    expect(safe.hasInvitePassword).toBe(false);
  });

  it('reports hasInvitePassword: true when a password is set', async () => {
    const settings = await updateSettings(prisma, { invitePassword: 'secret' });
    const safe = sanitizeSettings(settings);
    expect('invitePassword' in safe).toBe(false);
    expect(safe.hasInvitePassword).toBe(true);
  });
});
