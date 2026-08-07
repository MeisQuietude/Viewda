#!/usr/bin/env bash
#
# Package the derived Universal application without rebuilding either native
# slice. The native Tauri DMG is the layout template, so the Applications link
# and any Finder metadata stay identical across all macOS downloads.

set -euo pipefail

if (( $# != 3 )); then
  echo "Usage: create-macos-universal-dmg.sh TEMPLATE_DMG APP OUTPUT_DMG" >&2
  exit 2
fi

if [[ "$(uname -s)" != Darwin ]]; then
  echo "Creating a macOS DMG requires macOS." >&2
  exit 1
fi

template_dmg=$1
application=$2
output_dmg=$3

test -f "$template_dmg"
test -d "$application"
test -f "$application/Contents/MacOS/viewda"
test ! -e "$output_dmg"

output_directory=$(dirname "$output_dmg")
mkdir -p "$output_directory"
output_directory=$(cd "$output_directory" && pwd)
output_dmg="${output_directory}/$(basename "$output_dmg")"

temporary_directory=$(mktemp -d)
mount_point=

cleanup() {
  if [[ -n "$mount_point" ]]; then
    hdiutil detach "$mount_point" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

attach_output=$(
  hdiutil attach -readonly -nobrowse -noautoopen "$template_dmg"
)
mount_point=$(
  printf '%s\n' "$attach_output" \
    | awk -F '\t' '$3 ~ /^\// { print $3; exit }'
)
test -d "$mount_point"
test -L "$mount_point/Applications"
test "$(readlink "$mount_point/Applications")" = /Applications

volume_root="${temporary_directory}/volume"
ditto "$mount_point" "$volume_root"
hdiutil detach "$mount_point" >/dev/null
mount_point=

rm -rf -- "$volume_root/Viewda.app"
ditto "$application" "$volume_root/Viewda.app"

# LZFSE keeps native DMG support while compressing the Universal slices more
# tightly than zlib.
hdiutil create \
  -quiet \
  -ov \
  -volname Viewda \
  -srcfolder "$volume_root" \
  -format ULFO \
  "$output_dmg"
test -f "$output_dmg"
