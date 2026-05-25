import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';

import {
  getOrCreateSettings,
  getSettings,
  parseSharedFolders,
  sanitizeSettings,
  updateSettings,
} from '../config';
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

  it('exposes sharedFolders as a string array', async () => {
    const settings = await updateSettings(prisma, { sharedFolders: ['/a', '/b'] });
    const safe = sanitizeSettings(settings);
    expect(safe.sharedFolders).toEqual(['/a', '/b']);
  });

  it('defaults sharedFolders to empty array', async () => {
    const settings = await getOrCreateSettings(prisma);
    const safe = sanitizeSettings(settings);
    expect(safe.sharedFolders).toEqual([]);
  });
});

describe('updateSettings — sharedFolders and downloadFolder', () => {
  it('stores and retrieves sharedFolders as a string array', async () => {
    const updated = await updateSettings(prisma, { sharedFolders: ['/music', '/videos'] });
    const safe = sanitizeSettings(updated);
    expect(safe.sharedFolders).toEqual(['/music', '/videos']);
  });

  it('deduplicates sharedFolders on write', async () => {
    const updated = await updateSettings(prisma, {
      sharedFolders: ['/music', '/videos', '/music'],
    });
    const safe = sanitizeSettings(updated);
    expect(safe.sharedFolders).toEqual(['/music', '/videos']);
  });

  it('stores and retrieves downloadFolder', async () => {
    const updated = await updateSettings(prisma, { downloadFolder: '/downloads' });
    expect(updated.downloadFolder).toBe('/downloads');
  });

  it('clears downloadFolder when set to null', async () => {
    await updateSettings(prisma, { downloadFolder: '/downloads' });
    const cleared = await updateSettings(prisma, { downloadFolder: null });
    expect(cleared.downloadFolder).toBeNull();
  });
});

describe('updateSettings — rescanIntervalMinutes', () => {
  it('defaults to 0', async () => {
    const settings = await getOrCreateSettings(prisma);
    expect(settings.rescanIntervalMinutes).toBe(0);
  });

  it('stores and retrieves a positive interval', async () => {
    const updated = await updateSettings(prisma, { rescanIntervalMinutes: 60 });
    expect(updated.rescanIntervalMinutes).toBe(60);
  });

  it('resets to 0 to disable periodic rescan', async () => {
    await updateSettings(prisma, { rescanIntervalMinutes: 30 });
    const cleared = await updateSettings(prisma, { rescanIntervalMinutes: 0 });
    expect(cleared.rescanIntervalMinutes).toBe(0);
  });
});

describe('parseSharedFolders', () => {
  it('parses a valid JSON array of strings', () => {
    expect(parseSharedFolders('["a","b"]')).toEqual(['a', 'b']);
  });

  it('returns empty array for empty JSON array', () => {
    expect(parseSharedFolders('[]')).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseSharedFolders('not json')).toEqual([]);
  });

  it('filters out non-string values', () => {
    expect(parseSharedFolders('["/a", 42, null, "/b"]')).toEqual(['/a', '/b']);
  });

  it('trims whitespace from folder paths', () => {
    expect(parseSharedFolders('[" /music ", "/videos"]')).toEqual(['/music', '/videos']);
  });

  it('filters out blank strings after trimming', () => {
    expect(parseSharedFolders('["/music", "   ", "/videos"]')).toEqual(['/music', '/videos']);
  });

  it('deduplicates identical paths', () => {
    expect(parseSharedFolders('["/music", "/music", "/videos"]')).toEqual(['/music', '/videos']);
  });

  it('deduplicates paths that are identical after trimming', () => {
    expect(parseSharedFolders('["/music", " /music ", "/videos"]')).toEqual(['/music', '/videos']);
  });
});
