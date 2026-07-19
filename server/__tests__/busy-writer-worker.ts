import { Database } from 'bun:sqlite';

// Test-only helper for db.test.ts: opens its own connection to the given
// database file (mirroring how server/scan-worker.ts and
// server/watcher-worker.ts each open their own connection to the same file
// as the main thread) and holds a write transaction open for a fixed
// duration, so a test on another thread can observe how a concurrent
// reader/writer behaves against a real, currently-locked SQLite file.
self.onmessage = (event: MessageEvent<{ path: string; holdMs: number }>) => {
  const { path, holdMs } = event.data;
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('CREATE TABLE IF NOT EXISTS busy_test (id INTEGER PRIMARY KEY, v TEXT)');
  db.exec('BEGIN IMMEDIATE;');
  db.exec("INSERT INTO busy_test (v) VALUES ('held')");
  postMessage('locked');

  const start = Date.now();
  while (Date.now() - start < holdMs) {
    // Busy-hold the write lock synchronously, simulating a worker thread
    // mid-way through a scan's sustained write volume.
  }
  db.exec('COMMIT;');
  db.close();
  postMessage('released');
};
