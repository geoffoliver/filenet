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
  // Every scan/watcher worker (server/scan-worker.ts, server/watcher-worker.ts)
  // opens its own connection to this same file, alongside the main thread's —
  // WAL mode allows concurrent readers, but still only one writer at a time.
  // Without this, a connection that loses that race gets SQLITE_BUSY
  // immediately (SQLite's default busy_timeout is 0) instead of briefly
  // waiting for the lock to clear, which is a real failure observed in
  // production: a large library scan holding the write lock caused the main
  // thread's periodic reconnect tick's read to fail instantly. 5s comfortably
  // covers a single write transaction (each is one file's worth of work).
  sqlite.exec('PRAGMA busy_timeout=5000;');
  return drizzle(sqlite, { schema });
}

export function applyMigrations(db: Db): void {
  migrate(db, { migrationsFolder: resolveAssetPath('drizzle/migrations', import.meta.dir) });
}
