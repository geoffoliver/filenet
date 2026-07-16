import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Resolves the on-disk location of an asset (Drizzle migrations, the
 * exported static UI, etc.) that lives at the repo root.
 *
 * Two shapes are supported:
 * - Running from source (`bun server/index.ts`, dev or Docker): the asset
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
 * (dev, Docker — see Dockerfile's `COPY --from=builder /app/package.json`)
 * and is deliberately never packaged into a compiled binary's dist
 * directory by scripts/build-binaries.sh, so its absence is a reliable
 * signal.
 */
export function isCompiledBinary(callerDir: string): boolean {
  return !existsSync(join(callerDir, '..', 'package.json'));
}
