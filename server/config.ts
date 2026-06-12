import type { PrismaClient, Settings } from '@prisma/client';

const SETTINGS_ID = 'singleton';

// Colon-separated list of paths, e.g. SHARED_FOLDERS=/shared:/media
function envSharedFolders(): string[] {
  const raw = process.env.SHARED_FOLDERS;
  if (!raw) return [];
  return raw
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
}

function envDownloadFolder(): string | null {
  return process.env.DOWNLOAD_FOLDER?.trim() || null;
}

export type EnvConfig = {
  sharedFolders: string[]; // empty = no env override
  downloadFolder: string | null; // null = no env override
};

export function getEnvConfig(): EnvConfig {
  return {
    sharedFolders: envSharedFolders(),
    downloadFolder: envDownloadFolder(),
  };
}

export type SettingsPatch = {
  name?: string;
  invitePassword?: string | null;
  autoAcceptFromAnyone?: boolean;
  autoAcceptFromFriendsOfFriends?: boolean;
  sharedFolders?: string[];
  downloadFolder?: string | null;
  rescanIntervalMinutes?: number;
  listenPort?: number;
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

export async function getSettings(prisma: PrismaClient): Promise<Settings | null> {
  return prisma.settings.findUnique({ where: { id: SETTINGS_ID } });
}

export async function getOrCreateSettings(prisma: PrismaClient): Promise<Settings> {
  const envFolders = envSharedFolders();
  const envDownload = envDownloadFolder();
  return prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      ...(envFolders.length > 0 ? { sharedFolders: JSON.stringify(envFolders) } : {}),
      ...(envDownload ? { downloadFolder: envDownload } : {}),
    },
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
    data.sharedFolders = JSON.stringify([...new Set(sharedFolders)]);
  }
  return prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...data },
    update: data,
  });
}
