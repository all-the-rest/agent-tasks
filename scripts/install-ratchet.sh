#!/bin/sh
# Install the ratchet version pinned in .ratchet-version (checksum-verified).
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(tr -d '[:space:]' < "$root/.ratchet-version")
[ -n "$version" ] || { echo "empty .ratchet-version" >&2; exit 1; }

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  linux) os=linux ;;
  darwin) os=macos ;;
  *) echo "unsupported OS: $os" >&2; exit 1 ;;
esac
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

asset="ratchet-${version}-${os}-${arch}.tar.gz"
base="https://github.com/all-the-rest/ratchet-cli/releases/download/v${version}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/$asset" "$base/$asset"
curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/checksums.txt" "$base/checksums.txt"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp" && grep " $asset\$" checksums.txt | sha256sum --check --strict -)
else
  (cd "$tmp" && grep " $asset\$" checksums.txt | shasum -a 256 --check --strict -)
fi
tar -xzf "$tmp/$asset" -C "$tmp" ratchet

dest=${RATCHET_INSTALL_DIR:-$HOME/.local/bin}
mkdir -p "$dest"
install -m 0755 "$tmp/ratchet" "$dest/ratchet"
"$dest/ratchet" --version
echo "installed ratchet $version to $dest/ratchet; ensure $dest is on PATH"
