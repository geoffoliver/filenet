#!/bin/bash
set -euo pipefail

TARGETS=(bun-linux-x64 bun-linux-arm64 bun-darwin-x64 bun-darwin-arm64 bun-windows-x64)

VERSION=$(node -e "console.log(require('./package.json').version)")

rm -rf dist
bun run build

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

  echo "Zipping dist/filenet-${target}.zip..."
  # Zip the *contents* of outdir (not outdir itself) so the archive's
  # top-level entries are filenet(.exe)/out/drizzle directly — matching
  # what server/updater.ts's extractZip expects at update time, and what
  # end users expect per the README ("Extract it — you'll get filenet,
  # an out/ folder, and a drizzle/migrations folder").
  (cd "$outdir" && zip -rq "../filenet-${target}.zip" .)

  echo "Packaged dist/filenet-${target}.zip"
done

echo "Generating checksums..."
(cd dist && sha256sum filenet-*.zip > SHA256SUMS.txt)
