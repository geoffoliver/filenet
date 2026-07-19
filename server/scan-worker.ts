import { type ScanWorkerRequest, type ScanWorkerResponse, performScan } from './indexer';
import { createDb } from './db';

// Runs the actual scanAndIndex work (see server/indexer.ts) on a thread
// separate from the one serving the HTTP/UI, so a scan over a large shared
// library — hashing every file, one at a time — no longer makes the whole
// app unresponsive while it runs.

const PROGRESS_LOG_INTERVAL = 500;
// Inherited from the parent process by default (see WorkerOptions.env);
// set SCAN_LOG=1 when starting the server to see scan progress in the logs.
const scanLogEnabled = !!process.env.SCAN_LOG;

self.onmessage = async (event: MessageEvent<ScanWorkerRequest>) => {
  const { dbPath, folders, scanStartMs } = event.data;
  const scanStart = new Date(scanStartMs);
  const db = createDb(dbPath);
  const startedAt = Date.now();
  try {
    if (scanLogEnabled) {
      console.log(`[scan] starting: ${folders.length} folder(s)`);
    }
    const { indexed, removed } = await performScan(db, folders, scanStart, (count) => {
      if (scanLogEnabled && count % PROGRESS_LOG_INTERVAL === 0) {
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[scan] ${count} files indexed so far (${elapsedSec}s elapsed)`);
      }
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
