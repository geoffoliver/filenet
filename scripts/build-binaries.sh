#!/bin/bash
set -euo pipefail

TARGETS=(bun-linux-x64 bun-linux-arm64 bun-darwin-x64 bun-darwin-arm64 bun-windows-x64)

VERSION=$(bun -e "console.log(require('./package.json').version)")

rm -rf dist
bun run build

echo "Bundling background workers..."
# The scan, file-watcher, and hash workers (server/scan-worker.ts,
# server/watcher-worker.ts, server/hash-worker.ts — see indexer.ts's
# scanAndIndex, watcher.ts's startFileWatcher, and hash-pool.ts's
# HashWorkerPool) can't be embedded in the compiled binary itself — `new
# Worker()` can't load a second `bun build --compile` entry point by its
# virtual bunfs path (verified against Bun 1.3.14: it fails to resolve at
# runtime), and an end user's machine has no node_modules for an
# unbundled .ts worker file to import from. So each is bundled here into a
# standalone, dependency-free JS file instead and shipped as a real file
# next to the executable (server/runtime-paths.ts's resolveWorkerPath finds
# them there). These bundles are plain portable JS — bun:sqlite/node:*
# imports stay external, resolved at runtime by whichever platform's `bun`
# loads them — so unlike the compiled binary itself, one build covers every
# target.
mkdir -p dist/_shared/server
bun build --target=bun server/scan-worker.ts --outfile dist/_shared/server/scan-worker.js
bun build --target=bun server/watcher-worker.ts --outfile dist/_shared/server/watcher-worker.js
bun build --target=bun server/hash-worker.ts --outfile dist/_shared/server/hash-worker.js

for target in "${TARGETS[@]}"; do
  outdir="dist/${target}"
  mkdir -p "$outdir"

  binary_name="filenet"
  if [[ "$target" == *windows* ]]; then
    binary_name="filenet.exe"
  fi

  echo "Compiling ${target}..."
  # --define bakes NODE_ENV and APP_VERSION into the compiled binary at
  # build time (bun build --compile does not set NODE_ENV at runtime on its
  # own), so dev-only behavior (e.g. permissive CORS in server/ui-server.ts)
  # can never be active in a shipped executable, and the auto-updater
  # (server/updater.ts) always knows its own version without needing
  # package.json shipped alongside it.
  bun build --compile --target="$target" \
    --define "process.env.NODE_ENV=\"production\"" \
    --define "process.env.APP_VERSION=\"${VERSION}\"" \
    --outfile "${outdir}/${binary_name}" server/index.ts

  cp -r out "${outdir}/out"
  mkdir -p "${outdir}/drizzle"
  cp -r drizzle/migrations "${outdir}/drizzle/migrations"
  mkdir -p "${outdir}/server"
  cp dist/_shared/server/scan-worker.js "${outdir}/server/scan-worker.js"
  cp dist/_shared/server/watcher-worker.js "${outdir}/server/watcher-worker.js"
  cp dist/_shared/server/hash-worker.js "${outdir}/server/hash-worker.js"

  echo "Zipping dist/filenet-${target}.zip..."
  # Zip the *contents* of outdir (not outdir itself) so the archive's
  # top-level entries are filenet(.exe)/out/drizzle/server directly —
  # matching what server/updater.ts's extractZip expects at update time,
  # and what end users expect per the README ("Extract it — you'll get
  # filenet, an out/ folder, a drizzle/migrations folder, and a server
  # folder").
  (cd "$outdir" && zip -rq "../filenet-${target}.zip" .)

  echo "Packaged dist/filenet-${target}.zip"
done

rm -rf dist/_shared

echo "Generating checksums..."
# sha256sum is GNU coreutils and isn't on stock macOS; fall back to
# shasum -a 256 (Perl's Digest::SHA, ships with macOS), which produces the
# same "<hex>  <filename>" two-space-separated line format, so no
# reformatting is needed either way.
(
  cd dist
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum filenet-*.zip > SHA256SUMS.txt
  else
    shasum -a 256 filenet-*.zip > SHA256SUMS.txt
  fi
)
