import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';

import type { PrismaClient } from '@prisma/client';

import type { TransferStats } from './types';

export async function runPostDownloadScripts(
  prisma: PrismaClient,
  finalPath: string,
  stats: TransferStats,
): Promise<void> {
  const scripts = await prisma.postDownloadScript.findMany({
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
  });
  if (scripts.length === 0) return;

  let file: BunFile = Bun.file(finalPath);

  for (const script of scripts) {
    let result: unknown;
    try {
      const resolvedPath = resolve(script.path);
      const { mtimeMs: mtime } = await stat(resolvedPath);
      const mod = await import(`${pathToFileURL(resolvedPath).href}?mtime=${mtime}`);
      if (typeof mod.default !== 'function') {
        console.error(`Post-download script ${script.path}: default export is not a function`);
        continue;
      }
      result = await mod.default({ file, stats });
    } catch (err) {
      console.error(`Post-download script ${script.path} failed:`, err);
      continue;
    }

    if (result === false) {
      console.warn(`Post-download script ${script.path}: returned false, stopping chain`);
      break;
    }
    if (result instanceof Blob) {
      const name = (result as BunFile).name;
      if (typeof name === 'string' && name) {
        file = result as BunFile;
      } else {
        console.warn(
          `Post-download script ${script.path}: returned a Blob without a name, ignoring`,
        );
      }
    }
  }
}
