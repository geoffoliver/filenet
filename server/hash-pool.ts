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
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`HashWorkerPool size must be a positive integer, got: ${size}`);
    }
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
        // This worker is dead now — reject whatever it still owed us
        // rather than leaving those callers hanging forever, then remove
        // it from the pool entirely. Leaving it in place would be worse
        // than doing nothing: pending.clear() below makes it look like
        // the *least busy* worker (0 pending, the minimum possible), so
        // hash()'s selection loop would keep preferring this dead slot
        // over every healthy-but-currently-busier worker, turning one
        // crash into "every future hash() call has a chance to fail"
        // instead of just shrinking the pool's capacity by one.
        // Looked up by reference (not the loop-captured `i`) since an
        // earlier crash may have already shifted indices via splice.
        const err = new Error(event.message || 'Hash worker crashed');
        for (const entry of pending.values()) entry.reject(err);
        pending.clear();

        const idx = this.workers.indexOf(worker);
        if (idx !== -1) {
          this.workers.splice(idx, 1);
          this.pendingByWorker.splice(idx, 1);
        }
      };

      this.workers.push(worker);
      this.pendingByWorker.push(pending);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  hash = (path: string): Promise<string> => {
    if (this.workers.length === 0) {
      return Promise.reject(new Error('HashWorkerPool has no workers (already terminated?)'));
    }
    let idx = 0;
    for (let i = 1; i < this.workers.length; i++) {
      if (this.pendingByWorker[i].size < this.pendingByWorker[idx].size) idx = i;
    }
    const id = this.nextId++;
    const pending = this.pendingByWorker[idx];
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const request: HashWorkerRequest = { id, path };
      try {
        this.workers[idx].postMessage(request);
      } catch (err) {
        // postMessage throws synchronously for an already-terminated
        // worker (verified against Bun). A crashed worker can no longer
        // cause this — onerror above now removes it from the pool
        // entirely, so hash() can never select it — but this.workers[idx]
        // could still individually end up terminated some other way (a
        // future bug reaching into it directly, as this file's own tests
        // do to simulate that case). Without this, the entry set on the
        // line above leaks forever: nothing else will ever remove it,
        // since no response can arrive for a message that was never sent,
        // and it keeps skewing this worker toward looking "least busy"
        // for every future hash() call.
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
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
