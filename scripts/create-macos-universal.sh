#!/usr/bin/env bash
#
# Compose the universal bundle from the two architecture-specific bundles that
# CI already launched. This keeps the convenience artifact downstream of the
# native gates instead of performing a third application build.

set -euo pipefail

if (( $# != 3 )); then
  echo "Usage: create-macos-universal.sh ARM_APP INTEL_APP OUTPUT_APP" >&2
  exit 2
fi

arm_app=$1
intel_app=$2
output_app=$3

for app in "$arm_app" "$intel_app"; do
  test -d "$app"
  test -f "$app/Contents/MacOS/viewda"
  test -f "$app/Contents/Frameworks/libduckdb.dylib"
done
test ! -e "$output_app"

test "$(lipo -archs "$arm_app/Contents/MacOS/viewda")" = arm64
test "$(lipo -archs "$arm_app/Contents/Frameworks/libduckdb.dylib")" = arm64
test "$(lipo -archs "$intel_app/Contents/MacOS/viewda")" = x86_64
test "$(lipo -archs "$intel_app/Contents/Frameworks/libduckdb.dylib")" = x86_64

mkdir -p "$(dirname "$output_app")"
ditto "$arm_app" "$output_app"
rm -rf -- "$output_app/Contents/_CodeSignature"

lipo -create \
  "$arm_app/Contents/MacOS/viewda" \
  "$intel_app/Contents/MacOS/viewda" \
  -output "$output_app/Contents/MacOS/viewda"
lipo -create \
  "$arm_app/Contents/Frameworks/libduckdb.dylib" \
  "$intel_app/Contents/Frameworks/libduckdb.dylib" \
  -output "$output_app/Contents/Frameworks/libduckdb.dylib"

codesign --force --sign - "$output_app/Contents/Frameworks/libduckdb.dylib"
codesign --force --sign - \
  --options runtime \
  --entitlements native/desktop/Entitlements.plist \
  "$output_app"
codesign --verify --deep --strict "$output_app"
lipo "$output_app/Contents/MacOS/viewda" -verify_arch arm64 x86_64
lipo "$output_app/Contents/Frameworks/libduckdb.dylib" \
  -verify_arch arm64 x86_64
