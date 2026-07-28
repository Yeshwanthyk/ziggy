#!/usr/bin/env bash
set -euo pipefail

EXTENSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLISH_SCRIPT="$EXTENSION_DIR/skills/here-now/scripts/publish.sh"
DRIVE_SCRIPT="$EXTENSION_DIR/skills/here-now/scripts/drive.sh"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

PROFILE_DIR="$TEST_DIR/profile"
HOME_DIR="$TEST_DIR/home"
FAKE_BIN="$TEST_DIR/bin"
CURL_LOG="$TEST_DIR/curl.log"
mkdir -p "$PROFILE_DIR/.runtime/here-now" "$HOME_DIR/.herenow" "$FAKE_BIN"
printf '%s\n' "profile-api-key" > "$PROFILE_DIR/.runtime/here-now/credentials"
printf '%s\n' "home-api-key" > "$HOME_DIR/.herenow/credentials"
printf '%s\n' "<h1>Profile site</h1>" > "$PROFILE_DIR/index.html"

cat > "$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%q ' "$@" >> "$CURL_LOG"
printf '\n' >> "$CURL_LOG"

output_file=""
url=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "-o" ]]; then
    output_file="$argument"
  fi
  if [[ "$argument" == http://* || "$argument" == https://* ]]; then
    url="$argument"
  fi
  previous="$argument"
done

case "$url" in
  */api/v1/drives/default)
    response='{"drive":{"id":"drv_profile"}}'
    ;;
  */api/v1/publish)
    response='{"slug":"profile-site","siteUrl":"https://profile-site.here.now/","upload":{"versionId":"version-1","finalizeUrl":"https://upload.invalid/finalize","uploads":[],"skipped":[]}}'
    ;;
  https://upload.invalid/finalize)
    response='{}'
    ;;
  *)
    response='{}'
    ;;
esac

if [[ -n "$output_file" ]]; then
  printf '%s' "$response" > "$output_file"
  printf '200'
else
  printf '%s' "$response"
fi
EOF
chmod +x "$FAKE_BIN/curl"

export CURL_LOG
export HOME="$HOME_DIR"
export PATH="$FAKE_BIN:$PATH"
unset HERENOW_API_KEY HERENOW_DRIVE_TOKEN

(
  cd "$PROFILE_DIR"
  drive_id="$(bash "$DRIVE_SCRIPT" default | jq -r '.drive.id')"
  [[ "$drive_id" == "drv_profile" ]]

  bash "$PUBLISH_SCRIPT" index.html >/dev/null
  [[ -f ".runtime/here-now/state.json" ]]
  [[ ! -e ".herenow" ]]
  jq -e '.publishes["profile-site"].siteUrl == "https://profile-site.here.now/"' \
    ".runtime/here-now/state.json" >/dev/null
)

grep -q 'authorization:\\ Bearer\\ profile-api-key' "$CURL_LOG"
! grep -q 'home-api-key' "$CURL_LOG"
