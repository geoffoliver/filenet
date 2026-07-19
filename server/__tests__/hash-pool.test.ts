import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { HashWorkerPool } from '../hash-pool';
import { hashFile } from '../hash';

// hash-worker.ts lives directly in server/, one level up from this test
// file — matching how server/indexer.ts resolves its own scan-worker via
// resolveWorkerPath(name, import.meta.dir) from a module that lives in
// server/ itself.
const SERVER_DIR = join(import.meta.dir, '..');

describe('HashWorkerPool', () => {
  let pool: HashWorkerPool | null = null;
  let tmpDir: string;

  afterEach(async () => {
    pool?.terminate();
    pool = null;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('hashes a file the same way as the plain in-thread hashFile', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'filenet-hash-pool-'));
    const path = join(tmpDir, 'a.txt');
    await writeFile(path, 'hello world');

    pool = new HashWorkerPool(2, SERVER_DIR);
    const pooled = await pool.hash(path);
    const direct = await hashFile(path);

    expect(pooled).toBe(direct);
  });

  it('hashes many files concurrently across the pool', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'filenet-hash-pool-'));
    const paths: string[] = [];
    for (let i = 0; i < 8; i++) {
      const path = join(tmpDir, `f${i}.txt`);
      await writeFile(path, `content ${i}`);
      paths.push(path);
    }

    pool = new HashWorkerPool(4, SERVER_DIR);
    const [pooledHashes, directHashes] = await Promise.all([
      Promise.all(paths.map((p) => pool!.hash(p))),
      Promise.all(paths.map((p) => hashFile(p))),
    ]);

    expect(pooledHashes).toEqual(directHashes);
  });

  it('rejects with the original error code (e.g. ENOENT) for a missing file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'filenet-hash-pool-'));
    pool = new HashWorkerPool(1, SERVER_DIR);

    await expect(pool.hash(join(tmpDir, 'does-not-exist.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('terminate() rejects any still-pending requests', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'filenet-hash-pool-'));
    // A largeish file so the hash is still in flight when we terminate.
    const path = join(tmpDir, 'big.bin');
    await writeFile(path, Buffer.alloc(20 * 1024 * 1024));

    pool = new HashWorkerPool(1, SERVER_DIR);
    const promise = pool.hash(path);
    pool.terminate();

    await expect(promise).rejects.toThrow();
  });

  it('rejects hash() calls made after terminate() instead of crashing', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'filenet-hash-pool-'));
    const path = join(tmpDir, 'a.txt');
    await writeFile(path, 'hello');

    pool = new HashWorkerPool(1, SERVER_DIR);
    pool.terminate();

    await expect(pool.hash(path)).rejects.toThrow(/no workers/i);
  });

  it('throws immediately for an invalid pool size instead of failing confusingly on first use', () => {
    expect(() => new HashWorkerPool(0, SERVER_DIR)).toThrow(/positive integer/i);
    expect(() => new HashWorkerPool(-1, SERVER_DIR)).toThrow(/positive integer/i);
    expect(() => new HashWorkerPool(1.5, SERVER_DIR)).toThrow(/positive integer/i);
  });

  it('rejects cleanly (rather than leaking a pending entry) when postMessage throws on a dead worker', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'filenet-hash-pool-'));
    const path = join(tmpDir, 'a.txt');
    await writeFile(path, 'hello');

    pool = new HashWorkerPool(1, SERVER_DIR);
    // Simulate a worker that crashed (hit onerror, which clears its
    // pending map but deliberately doesn't remove it from the pool — see
    // hash-pool.ts) without going through pool.terminate(), by terminating
    // the individual underlying worker directly. postMessage to it then
    // throws synchronously, same as a real crash would eventually cause.
    const internals = pool as unknown as { workers: Worker[] };
    internals.workers[0].terminate();
    await Bun.sleep(50);

    await expect(pool.hash(path)).rejects.toThrow(/terminated/i);

    // The leak this guards against: without the fix, the failed call's
    // pending entry stays in the map forever, so this worker keeps
    // looking "least busy" (0 real pending, but the map never reflects
    // that count changing) and every subsequent call keeps routing to it
    // and keeps failing the same way instead of surfacing a usable error
    // eventually. Prove that isn't happening by confirming a second call
    // also fails the same clean way rather than hanging.
    await expect(pool.hash(path)).rejects.toThrow(/terminated/i);
  });
});
