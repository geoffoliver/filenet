import type { PrismaClient, Settings } from '@prisma/client';

export async function getSettings(prisma: PrismaClient): Promise<Settings | null> {
  return prisma.settings.findFirst();
}

export async function getOrCreateSettings(prisma: PrismaClient): Promise<Settings> {
  const existing = await getSettings(prisma);
  if (existing) return existing;
  return prisma.settings.create({ data: {} });
}

export async function updateSettings(
  prisma: PrismaClient,
  patch: Partial<Omit<Settings, 'id'>>,
): Promise<Settings> {
  const existing = await getOrCreateSettings(prisma);
  return prisma.settings.update({
    where: { id: existing.id },
    data: patch,
  });
}
