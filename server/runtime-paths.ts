import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Resolves the on-disk location of an asset (Drizzle migrations, the
 * exported static UI, etc.) that lives at the repo root.
 *
 * Two shapes are supported:
 * - Running from source (`bun server/index.ts`, e.g. in dev): the asset
 *   sits at `<repo root>/<repoRootRelativePath>`, found relative to the
 *   calling module's directory.
 * - Running as a `bun build --compile` executable: `import.meta.dir`
 *   resolves to a synthetic path inside the binary, not a real directory,
 *   so the source-relative candidate won't exist. In that case the asset
 *   ships in a folder next to the compiled executable instead.
 */
export function resolveAssetPath(
  repoRootRelativePath: string,
  callerDir: string,
  execPath: string = process.execPath,
): string {
  const sourceCandidate = join(callerDir, '..', repoRootRelativePath);
  if (existsSync(sourceCandidate)) return sourceCandidate;
  return join(dirname(execPath), repoRootRelativePath);
}

/**
 * True when running as a `bun build --compile` executable rather than from
 * source. `package.json` sits at the repo root in every source-mode shape
 * (e.g. dev) and is deliberately never packaged into a compiled binary's
 * dist directory by scripts/build-binaries.sh, so its absence is a
 * reliable signal.
 */
export function isCompiledBinary(callerDir: string): boolean {
  return !existsSync(join(callerDir, '..', 'package.json'));
}

/**
 * Resolves the file handed to `new Worker(...)` for one of this app's
 * background worker scripts (server/scan-worker.ts, server/watcher-worker.ts).
 *
 * Unlike resolveAssetPath, the two shapes need different filenames, not
 * just different directories:
 * - Running from source: `server/<name>.ts` next to this module runs
 *   directly, importing indexer/db/schema/etc. as regular TS modules
 *   backed by a real node_modules.
 * - Running as a `bun build --compile` executable: `new Worker` can't load
 *   a bundled entry point by its virtual bunfs path (verified empirically
 *   against Bun 1.3.14 — a second `--compile` entry point silently fails
 *   to resolve at runtime), and there's no node_modules on an end user's
 *   machine for an unbundled .ts file to import from. scripts/build-binaries.sh
 *   instead pre-bundles each worker into a dependency-free
 *   server/<name>.js shipped next to the executable, which this resolves
 *   to as the fallback.
 */
export function resolveWorkerPath(
  name: string,
  callerDir: string,
  execPath: string = process.execPath,
): string {
  const sourceCandidate = join(callerDir, `${name}.ts`);
  if (existsSync(sourceCandidate)) return sourceCandidate;
  return join(dirname(execPath), 'server', `${name}.js`);
}
