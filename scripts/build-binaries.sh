#!/bin/bash
set -euo pipefail

TARGETS=(bun-linux-x64 bun-linux-arm64 bun-darwin-x64 bun-darwin-arm64 bun-windows-x64)

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
  bun build --compile --target="$target" --outfile "${outdir}/${binary_name}" server/index.ts

  cp -r out "${outdir}/out"
  mkdir -p "${outdir}/drizzle"
  cp -r drizzle/migrations "${outdir}/drizzle/migrations"

  if [[ "$target" == *windows* ]]; then
    (cd dist && zip -r "filenet-${target}.zip" "${target}")
  else
    tar -czf "dist/filenet-${target}.tar.gz" -C dist "${target}"
  fi

  echo "Packaged dist/filenet-${target}.*"
done
