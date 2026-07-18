import { eq } from 'drizzle-orm';

import { type Settings, settings } from './schema';
import type { Db } from './db';

const SETTINGS_ID = 'singleton';

export type SettingsPatch = {
  name?: string;
  invitePassword?: string | null;
  autoAcceptFromAnyone?: boolean;
  autoAcceptFromFriendsOfFriends?: boolean;
  sharedFolders?: string[];
  downloadFolder?: string | null;
  rescanIntervalMinutes?: number;
  listenPort?: number;
  updateRepo?: string;
  updateCheckIntervalMinutes?: number;
  autoOpenBrowser?: boolean;
};

export type SafeSettings = Omit<Settings, 'invitePassword' | 'sharedFolders'> & {
  hasInvitePassword: boolean;
  sharedFolders: string[];
};

export function sanitizeSettings(s: Settings): SafeSettings {
  const { invitePassword, sharedFolders, ...rest } = s;
  return {
    ...rest,
    hasInvitePassword: invitePassword !== null,
    sharedFolders: parseSharedFolders(sharedFolders),
  };
}

export function parseSharedFolders(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const x of parsed) {
      if (typeof x !== 'string') continue;
      const trimmed = x.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) continue;
      seen.add(trimmed);
      result.push(trimmed);
    }
    return result;
  } catch {
    return [];
  }
}

export async function getSettings(db: Db): Promise<Settings | null> {
  return db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).get() ?? null;
}

export async function getOrCreateSettings(db: Db): Promise<Settings> {
  const row = db
    .insert(settings)
    .values({ id: SETTINGS_ID })
    .onConflictDoNothing()
    .returning()
    .get();
  if (row) return row;
  return db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).get()!;
}

export async function updateSettings(db: Db, patch: SettingsPatch): Promise<Settings> {
  const { sharedFolders, ...rest } = patch;
  const data: Partial<Settings> = { ...rest };
  if (sharedFolders !== undefined) {
    data.sharedFolders = JSON.stringify([...new Set(sharedFolders)]);
  }
  const row = db
    .insert(settings)
    .values({ id: SETTINGS_ID, ...data })
    .onConflictDoUpdate({ target: settings.id, set: data })
    .returning()
    .get();
  return row!;
}
