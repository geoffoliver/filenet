import { resolve } from 'node:path';

import type { PrismaClient } from '@prisma/client';

import type { TransferStats } from './types';

export async function runPostDownloadScripts(
  prisma: PrismaClient,
  finalPath: string,
  stats: TransferStats,
): Promise<void> {
  const scripts = await prisma.postDownloadScript.findMany({ orderBy: { order: 'asc' } });
  if (scripts.length === 0) return;

  const file = Bun.file(finalPath);

  for (const script of scripts) {
    try {
      const mod = await import(resolve(script.path));
      if (typeof mod.default !== 'function') {
        console.error(`Post-download script ${script.path}: default export is not a function`);
        continue;
      }
      await mod.default({ file, stats });
    } catch (err) {
      console.error(`Post-download script ${script.path} failed:`, err);
    }
  }
}
