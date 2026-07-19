import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// Kept in its own module (no drizzle-orm/metadata-parsing dependencies) so
// server/hash-worker.ts's bundle stays small and fast to spin up — it only
// ever needs this one function, not the rest of indexer.ts's dependency
// graph.
export async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
