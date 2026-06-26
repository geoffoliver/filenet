import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';

import type { BunFile } from 'bun';
import { asc } from 'drizzle-orm';

import type { Db } from './db';
import type { TransferStats } from './types';
import { postDownloadScripts } from './schema';

export async function runPostDownloadScripts(
  db: Db,
  finalPath: string,
  stats: TransferStats,
): Promise<void> {
  const scripts = db
    .select()
    .from(postDownloadScripts)
    .orderBy(asc(postDownloadScripts.order), asc(postDownloadScripts.id))
    .all();
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
