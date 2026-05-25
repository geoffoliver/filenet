import type { PrismaClient, Settings } from '@prisma/client';

const SETTINGS_ID = 'singleton';

export type SettingsPatch = {
  name?: string;
  invitePassword?: string | null;
  autoAcceptFromAnyone?: boolean;
  autoAcceptFromFriendsOfFriends?: boolean;
  sharedFolders?: string[];
  downloadFolder?: string | null;
  rescanIntervalMinutes?: number;
};

export type SafeSettings = Omit<Settings, 'invitePassword' | 'sharedFolders'> & {
  hasInvitePassword: boolean;
  sharedFolders: string[];
};

export function sanitizeSettings(settings: Settings): SafeSettings {
  const { invitePassword, sharedFolders, ...rest } = settings;
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
    return parsed
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !seen.has(s) && seen.add(s) !== undefined);
  } catch {
    return [];
  }
}

export async function getSettings(prisma: PrismaClient): Promise<Settings | null> {
  return prisma.settings.findUnique({ where: { id: SETTINGS_ID } });
}

export async function getOrCreateSettings(prisma: PrismaClient): Promise<Settings> {
  return prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID },
    update: {},
  });
}

export async function updateSettings(
  prisma: PrismaClient,
  patch: SettingsPatch,
): Promise<Settings> {
  const { sharedFolders, ...rest } = patch;
  const data: Partial<Settings> = { ...rest };
  if (sharedFolders !== undefined) {
    data.sharedFolders = JSON.stringify(sharedFolders);
  }
  return prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...data },
    update: data,
  });
}
