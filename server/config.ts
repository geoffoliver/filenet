import type { PrismaClient, Settings } from '@prisma/client';

const SETTINGS_ID = 'singleton';

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
  patch: Partial<Omit<Settings, 'id'>>,
): Promise<Settings> {
  return prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...patch },
    update: patch,
  });
}
