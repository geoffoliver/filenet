import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { unlinkSync } from 'fs';

import { type Db, applyMigrations, createDb } from '../db';
import {
  getOrCreateSettings,
  getSettings,
  parseSharedFolders,
  sanitizeSettings,
  updateSettings,
} from '../config';
import { count } from 'drizzle-orm';
import { settings } from '../schema';

const TEST_DB_URL = 'file:./data/test-config.db';
let db: Db;

beforeAll(() => {
  db = createDb(TEST_DB_URL);
  applyMigrations(db);
});

afterAll(() => {
  db.$client.close();
  try {
    unlinkSync('./data/test-config.db');
  } catch {}
});

beforeEach(() => {
  db.delete(settings).run();
});

describe('getSettings', () => {
  it('returns null when no settings exist', async () => {
    const result = await getSettings(db);
    expect(result).toBeNull();
  });
});

describe('getOrCreateSettings', () => {
  it('creates settings with defaults when none exist', async () => {
    const s = await getOrCreateSettings(db);
    expect(s.name).toBe('');
    expect(s.invitePassword).toBeNull();
    expect(s.autoAcceptFromAnyone).toBe(false);
    expect(s.autoAcceptFromFriendsOfFriends).toBe(false);
  });

  it('returns the same settings on subsequent calls', async () => {
    const first = await getOrCreateSettings(db);
    const second = await getOrCreateSettings(db);
    expect(second.id).toBe(first.id);
  });

  it('returns the same id across concurrent calls (singleton)', async () => {
    const [a, b, c] = await Promise.all([
      getOrCreateSettings(db),
      getOrCreateSettings(db),
      getOrCreateSettings(db),
    ]);
    expect(a.id).toBe(b.id);
    expect(b.id).toBe(c.id);
    const row = db.select({ total: count() }).from(settings).get();
    expect(row?.total).toBe(1);
  });

  it('defaults updateRepo and updateCheckIntervalMinutes', async () => {
    const s = await getOrCreateSettings(db);
    expect(s.updateRepo).toBe('geoffoliver/filenet');
    expect(s.updateCheckIntervalMinutes).toBe(1440);
  });

  it('defaults autoOpenBrowser to true', async () => {
    const s = await getOrCreateSettings(db);
    expect(s.autoOpenBrowser).toBe(true);
  });

  it('defaults enableFileWatcher to true', async () => {
    const s = await getOrCreateSettings(db);
    expect(s.enableFileWatcher).toBe(true);
  });
});

describe('updateSettings', () => {
  it('updates specific fields without touching others', async () => {
    await getOrCreateSettings(db);
    const updated = await updateSettings(db, { name: 'Alice', autoAcceptFromAnyone: true });
    expect(updated.name).toBe('Alice');
    expect(updated.autoAcceptFromAnyone).toBe(true);
    expect(updated.autoAcceptFromFriendsOfFriends).toBe(false);
  });

  it('stores and retrieves invite password', async () => {
    await getOrCreateSettings(db);
    const updated = await updateSettings(db, { invitePassword: 'secret123' });
    expect(updated.invitePassword).toBe('secret123');
  });

  it('clears invite password when set to null', async () => {
    await getOrCreateSettings(db);
    await updateSettings(db, { invitePassword: 'secret123' });
    const cleared = await updateSettings(db, { invitePassword: null });
    expect(cleared.invitePassword).toBeNull();
  });

  it('updates autoOpenBrowser', async () => {
    await getOrCreateSettings(db);
    const updated = await updateSettings(db, { autoOpenBrowser: false });
    expect(updated.autoOpenBrowser).toBe(false);
  });

  it('updates enableFileWatcher', async () => {
    await getOrCreateSettings(db);
    const updated = await updateSettings(db, { enableFileWatcher: false });
    expect(updated.enableFileWatcher).toBe(false);
  });
});

describe('sanitizeSettings', () => {
  it('omits invitePassword and adds hasInvitePassword: false when not set', async () => {
    const s = await getOrCreateSettings(db);
    const safe = sanitizeSettings(s);
    expect('invitePassword' in safe).toBe(false);
    expect(safe.hasInvitePassword).toBe(false);
  });

  it('reports hasInvitePassword: true when a password is set', async () => {
    const s = await updateSettings(db, { invitePassword: 'secret' });
    const safe = sanitizeSettings(s);
    expect('invitePassword' in safe).toBe(false);
    expect(safe.hasInvitePassword).toBe(true);
  });

  it('exposes sharedFolders as a string array', async () => {
    const s = await updateSettings(db, { sharedFolders: ['/a', '/b'] });
    const safe = sanitizeSettings(s);
    expect(safe.sharedFolders).toEqual(['/a', '/b']);
  });

  it('defaults sharedFolders to empty array', async () => {
    const s = await getOrCreateSettings(db);
    const safe = sanitizeSettings(s);
    expect(safe.sharedFolders).toEqual([]);
  });
});

describe('updateSettings — sharedFolders and downloadFolder', () => {
  it('stores and retrieves sharedFolders as a string array', async () => {
    const updated = await updateSettings(db, { sharedFolders: ['/music', '/videos'] });
    const safe = sanitizeSettings(updated);
    expect(safe.sharedFolders).toEqual(['/music', '/videos']);
  });

  it('deduplicates sharedFolders on write', async () => {
    const updated = await updateSettings(db, {
      sharedFolders: ['/music', '/videos', '/music'],
    });
    const safe = sanitizeSettings(updated);
    expect(safe.sharedFolders).toEqual(['/music', '/videos']);
  });

  it('stores and retrieves downloadFolder', async () => {
    const updated = await updateSettings(db, { downloadFolder: '/downloads' });
    expect(updated.downloadFolder).toBe('/downloads');
  });

  it('clears downloadFolder when set to null', async () => {
    await updateSettings(db, { downloadFolder: '/downloads' });
    const cleared = await updateSettings(db, { downloadFolder: null });
    expect(cleared.downloadFolder).toBeNull();
  });
});

describe('updateSettings — rescanIntervalMinutes', () => {
  it('defaults to 0', async () => {
    const s = await getOrCreateSettings(db);
    expect(s.rescanIntervalMinutes).toBe(0);
  });

  it('stores and retrieves a positive interval', async () => {
    const updated = await updateSettings(db, { rescanIntervalMinutes: 60 });
    expect(updated.rescanIntervalMinutes).toBe(60);
  });

  it('resets to 0 to disable periodic rescan', async () => {
    await updateSettings(db, { rescanIntervalMinutes: 30 });
    const cleared = await updateSettings(db, { rescanIntervalMinutes: 0 });
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
