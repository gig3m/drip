#!/usr/bin/env sh
set -eu
OUT="${1:-/out/dl}"
# Default server URL compiled into the binaries (DRIP_BASE_URL overrides at runtime).
# Empty means the binaries require DRIP_BASE_URL.
BASE="${DRIP_BAKED_BASE_URL:-}"
VER="${DRIP_VERSION:-dev}"
mkdir -p "$OUT"
for t in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
  echo "building drip-$t (base=$BASE version=$VER)…"
  bun build --compile --minify \
    --define "process.env.DRIP_BAKED_BASE_URL=\"$BASE\"" \
    --define "process.env.DRIP_VERSION=\"$VER\"" \
    --target="bun-$t" \
    packages/cli/src/index.ts \
    --outfile "$OUT/drip-$t"
done
cd "$OUT" && sha256sum drip-* > SHA256SUMS
echo "built:"; ls -la "$OUT"
