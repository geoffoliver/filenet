import { hashFile } from './hash';

// One of a small pool of these (see server/hash-pool.ts) that
// server/scan-worker.ts dispatches individual file hashes to, so hashing
// many files during a bulk scan runs concurrently across cores instead of
// one at a time. Deliberately depends on nothing but server/hash.ts (no
// drizzle-orm, no metadata parsing) so its bundle stays small and each
// worker in the pool spins up fast.

export interface HashWorkerRequest {
  id: number;
  path: string;
}

export type HashWorkerResponse =
  | { id: number; sha256: string }
  // `code` preserves e.g. ENOENT/EACCES/ENOTDIR across the postMessage
  // boundary — without it, performScan's per-file error handling
  // (server/indexer.ts) can't tell "file became unreadable, skip it" from
  // a genuinely unexpected error that should abort the whole scan, since
  // both would otherwise arrive as a plain message string.
  | { id: number; error: string; code?: string };

self.onmessage = async (event: MessageEvent<HashWorkerRequest>) => {
  const { id, path } = event.data;
  try {
    const sha256 = await hashFile(path);
    const response: HashWorkerResponse = { id, sha256 };
    postMessage(response);
  } catch (err) {
    const response: HashWorkerResponse = {
      id,
      error: err instanceof Error ? err.message : String(err),
      code: (err as NodeJS.ErrnoException).code,
    };
    postMessage(response);
  }
};
