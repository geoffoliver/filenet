import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

import * as schema from './schema';

export type Db = ReturnType<typeof createDb>;

export function createDb(path?: string): ReturnType<typeof drizzle<typeof schema>> {
  const raw = path ?? process.env.DATABASE_URL ?? './data/filenet.db';
  const dbPath = raw.startsWith('file:') ? raw.slice(5) : raw;
  const sqlite = new Database(dbPath, { create: true });
  sqlite.exec('PRAGMA journal_mode=WAL;');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  return drizzle(sqlite, { schema });
}

export function applyMigrations(db: Db): void {
  migrate(db, { migrationsFolder: join(import.meta.dir, '../drizzle/migrations') });
}
