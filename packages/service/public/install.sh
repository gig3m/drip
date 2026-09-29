#!/usr/bin/env sh
set -eu

# The drip server fills in the default below when it serves this script.
BASE="${DRIP_INSTALL_BASE:-__DRIP_BASE_URL__}"
case "$BASE" in
  http://*|https://*) ;;
  *) echo "drip-install: set DRIP_INSTALL_BASE to your drip server URL (e.g. https://drip.example.com)" >&2; exit 1 ;;
esac
BINDIR="${DRIP_BIN_DIR:-$HOME/.local/bin}"

os=$(uname -s)
case "$os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) echo "drip-install: unsupported OS: $os" >&2; exit 1 ;;
esac

arch=$(uname -m)
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) echo "drip-install: unsupported arch: $arch" >&2; exit 1 ;;
esac

asset="drip-$os-$arch"
case "$asset" in
  drip-darwin-arm64|drip-darwin-x64|drip-linux-x64|drip-linux-arm64) ;;
  *) echo "drip-install: no binary for $asset (supported: mac arm64/x64, linux x64/arm64)" >&2; exit 1 ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "drip-install: downloading ${asset}..." >&2
curl -fsSL "$BASE/dl/$asset" -o "$tmp/drip"
curl -fsSL "$BASE/dl/SHA256SUMS" -o "$tmp/SHA256SUMS"

expected=$(grep " $asset\$" "$tmp/SHA256SUMS" | awk '{print $1}')
if [ -z "$expected" ]; then echo "drip-install: $asset missing from SHA256SUMS" >&2; exit 1; fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/drip" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp/drip" | awk '{print $1}')
fi
if [ "$expected" != "$actual" ]; then
  echo "drip-install: checksum mismatch (expected $expected, got $actual)" >&2; exit 1
fi

mkdir -p "$BINDIR"
mv "$tmp/drip" "$BINDIR/drip"
chmod +x "$BINDIR/drip"
echo "drip-install: installed to $BINDIR/drip" >&2

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *)
    echo "drip-install: $BINDIR is not on your PATH. Add it:" >&2
    case "${SHELL:-}" in
      *zsh)  echo "  echo 'export PATH=\"$BINDIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" >&2 ;;
      *bash) echo "  echo 'export PATH=\"$BINDIR:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" >&2 ;;
      *)     echo "  export PATH=\"$BINDIR:\$PATH\"" >&2 ;;
    esac
    ;;
esac

echo "drip-install: done. Try: drip ~/some/file.png" >&2
