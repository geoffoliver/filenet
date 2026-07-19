import { cpus } from 'node:os';

import { type ScanWorkerRequest, type ScanWorkerResponse, performScan } from './indexer';
import { HashWorkerPool } from './hash-pool';
import { createDb } from './db';

// Runs the actual scanAndIndex work (see server/indexer.ts) on a thread
// separate from the one serving the HTTP/UI, so a scan over a large shared
// library no longer makes the whole app unresponsive while it runs. File
// hashing — the part of a scan that dominates for large files — is further
// spread across a small pool of hash-worker threads (server/hash-pool.ts)
// so multiple files hash concurrently across cores instead of one at a
// time on this thread.

const PROGRESS_LOG_INTERVAL = 500;
// Inherited from the parent process by default (see WorkerOptions.env);
// set SCAN_LOG=1 when starting the server to see scan progress in the logs.
const scanLogEnabled = !!process.env.SCAN_LOG;

// Leaves at least one core for the main thread (HTTP/UI) and this worker's
// own directory-walk/metadata/DB-write orchestration. Capped rather than
// using every available core: I/O bandwidth to a single disk becomes the
// bottleneck well before very high hash-worker counts would help further,
// and each additional worker is a whole OS thread plus its own ~2 MB
// bundle load.
const HASH_POOL_SIZE = Math.max(1, Math.min(8, cpus().length - 1));

// Reused across scans for the same reason server/indexer.ts caches the
// scan worker itself: spinning up fresh worker threads on every scan
// carries a real one-time cost.
let hashPool: HashWorkerPool | null = null;
function getHashPool(): HashWorkerPool {
  if (!hashPool) {
    hashPool = new HashWorkerPool(HASH_POOL_SIZE, import.meta.dir);
  }
  return hashPool;
}

self.onmessage = async (event: MessageEvent<ScanWorkerRequest>) => {
  const { dbPath, folders, scanStartMs } = event.data;
  const scanStart = new Date(scanStartMs);
  const db = createDb(dbPath);
  const startedAt = Date.now();
  const pool = getHashPool();
  try {
    if (scanLogEnabled) {
      console.log(`[scan] starting: ${folders.length} folder(s), ${pool.size} hash worker(s)`);
    }
    const { indexed, removed } = await performScan(db, folders, scanStart, {
      hashFn: pool.hash,
      concurrency: pool.size,
      onProgress: (count) => {
        if (scanLogEnabled && count % PROGRESS_LOG_INTERVAL === 0) {
          const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
          console.log(`[scan] ${count} files indexed so far (${elapsedSec}s elapsed)`);
        }
      },
    });
    if (scanLogEnabled) {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[scan] done: ${indexed} indexed, ${removed} removed (${elapsedSec}s)`);
    }
    const response: ScanWorkerResponse = { type: 'done', indexed, removed };
    postMessage(response);
  } catch (err) {
    if (scanLogEnabled) {
      console.error('[scan] failed:', err);
    }
    const response: ScanWorkerResponse = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    postMessage(response);
  } finally {
    db.$client.close();
  }
};
