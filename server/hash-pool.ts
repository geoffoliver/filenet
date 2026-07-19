import { type HashWorkerRequest, type HashWorkerResponse } from './hash-worker';
import { resolveWorkerPath } from './runtime-paths';

interface PendingEntry {
  resolve: (sha256: string) => void;
  reject: (err: Error) => void;
}

// A small pool of persistent hash-worker threads (server/hash-worker.ts)
// that server/scan-worker.ts dispatches file hashes to, so a bulk scan
// hashes multiple files concurrently across cores rather than one at a
// time on the scan worker's own single thread.
export class HashWorkerPool {
  private workers: Worker[] = [];
  private pendingByWorker: Map<number, PendingEntry>[] = [];
  private nextId = 0;

  constructor(size: number, callerDir: string) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(resolveWorkerPath('hash-worker', callerDir));
      const pending = new Map<number, PendingEntry>();

      worker.onmessage = (event: MessageEvent<HashWorkerResponse>) => {
        const msg = event.data;
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        if ('error' in msg) {
          const err = new Error(msg.error) as NodeJS.ErrnoException;
          if (msg.code) err.code = msg.code;
          entry.reject(err);
        } else {
          entry.resolve(msg.sha256);
        }
      };
      worker.onerror = (event: ErrorEvent) => {
        // This worker may be dead now — reject whatever it still owed us
        // rather than leaving those callers hanging forever. A later
        // hash() call will keep picking this (now-idle-looking) worker
        // since nothing here removes it from the pool; that's an accepted
        // tradeoff for staying simple, since a genuine crash here (as
        // opposed to a single file's hashFile() rejection, which already
        // resolves via the normal 'error' message path above and never
        // reaches onerror) should be rare.
        const err = new Error(event.message || 'Hash worker crashed');
        for (const entry of pending.values()) entry.reject(err);
        pending.clear();
      };

      this.workers.push(worker);
      this.pendingByWorker.push(pending);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  hash = (path: string): Promise<string> => {
    let idx = 0;
    for (let i = 1; i < this.workers.length; i++) {
      if (this.pendingByWorker[i].size < this.pendingByWorker[idx].size) idx = i;
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pendingByWorker[idx].set(id, { resolve, reject });
      const request: HashWorkerRequest = { id, path };
      this.workers[idx].postMessage(request);
    });
  };

  terminate(): void {
    for (const worker of this.workers) worker.terminate();
    for (const pending of this.pendingByWorker) {
      for (const entry of pending.values()) {
        entry.reject(new Error('Hash worker pool terminated'));
      }
      pending.clear();
    }
    this.workers = [];
    this.pendingByWorker = [];
  }
}
