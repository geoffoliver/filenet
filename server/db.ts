import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

import * as schema from './schema';
import { resolveAssetPath } from './runtime-paths';

export type Db = ReturnType<typeof createDb>;

export function createDb(path?: string): ReturnType<typeof drizzle<typeof schema>> {
  const raw = path ?? process.env.DATABASE_URL ?? './data/filenet.db';
  const dbPath = raw.startsWith('file:') ? raw.slice(5) : raw;
  // `{ create: true }` below only creates the database file itself, not
  // missing parent directories — without this, a fresh standalone binary
  // (which ships with no data/ folder) fails with SQLITE_CANTOPEN on first
  // run.
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath, { create: true });
  sqlite.exec('PRAGMA journal_mode=WAL;');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  return drizzle(sqlite, { schema });
}

export function applyMigrations(db: Db): void {
  migrate(db, { migrationsFolder: resolveAssetPath('drizzle/migrations', import.meta.dir) });
}
