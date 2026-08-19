#!/bin/sh
# Install the Ziggy standalone executable from GitHub Releases.
# Usage:
#   curl -fsSL https://github.com/Yeshwanthyk/ziggy/releases/latest/download/install.sh | sh
set -eu

repo_download="${ZIGGY_DOWNLOAD_BASE:-https://github.com/Yeshwanthyk/ziggy/releases/latest/download}"
bin_dir="${ZIGGY_BIN_DIR:-$HOME/.local/bin}"
os=$(printf '%s' "${ZIGGY_OS:-$(uname -s)}" | tr '[:upper:]' '[:lower:]')
arch="${ZIGGY_ARCH:-$(uname -m)}"
case "$arch" in
arm64 | aarch64) arch="arm64" ;;
x86_64 | amd64) arch="x64" ;;
esac
target="${os}-${arch}"

if [ "$target" != "darwin-arm64" ]; then
  printf 'Ziggy 0.2.4 ships macOS Apple Silicon only (darwin-arm64). Detected %s.\n' "$target" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is required to install Ziggy.\n' >&2
  exit 1
fi

file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    printf 'shasum or sha256sum is required to verify Ziggy.\n' >&2
    exit 1
  fi
}

staging=$(mktemp -d)
cleanup() {
  rm -rf "$staging"
}
trap cleanup EXIT INT HUP TERM

asset="ziggy-${target}"
curl -fsSL --connect-timeout 10 --max-time 120 "${repo_download}/${asset}" -o "${staging}/ziggy"
curl -fsSL --connect-timeout 10 --max-time 120 "${repo_download}/${asset}.sha256" -o "${staging}/ziggy.sha256"
expected=$(awk '{print $1}' "${staging}/ziggy.sha256")
actual=$(file_sha256 "${staging}/ziggy")
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  printf 'Ziggy checksum mismatch.\n' >&2
  exit 1
fi

mkdir -p "$bin_dir"
destination="${bin_dir}/ziggy"
if [ -L "$destination" ]; then
  printf 'refusing to overwrite symlink %s\n' "$destination" >&2
  exit 1
fi
if [ -e "$destination" ] && [ ! -f "$destination" ]; then
  printf 'refusing to overwrite %s\n' "$destination" >&2
  exit 1
fi

chmod 755 "${staging}/ziggy"
if command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "${staging}/ziggy" 2>/dev/null || true
fi
mv "${staging}/ziggy" "$destination"

printf 'installed %s\n' "$destination"
printf 'run: ziggy version\n'
case ":${PATH}:" in
*":${bin_dir}:"*) ;;
*)
  printf 'add %s to PATH if ziggy is not found\n' "$bin_dir"
  ;;
esac
