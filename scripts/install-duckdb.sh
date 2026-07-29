#!/usr/bin/env bash
#
# Installs the official prebuilt DuckDB library. Viewda never compiles
# DuckDB's C++: the crate's from-source `bundled` build reached the same
# integration check 25x slower (735 s vs 29.5 s measured). The library is
# pinned by version and SHA-256 and ships inside each platform bundle. Unix
# binaries use the matching RPATH from native/.cargo/config.toml; Windows
# places the DLL next to the executable.

set -euo pipefail

destination=${1:?Usage: install-duckdb.sh DESTINATION}
version=1.5.5
release_base="https://github.com/duckdb/duckdb/releases/download/v${version}"
system=$(uname -s)
machine=$(uname -m)

case "$destination" in
  / | . | .. | [A-Za-z]:/ | [A-Za-z]:\\)
    echo "Refusing unsafe DuckDB destination: ${destination}" >&2
    exit 1
    ;;
esac

case "${system}:${machine}" in
  Linux:x86_64)
    archive="libduckdb-linux-amd64.zip"
    expected_sha256="1fb8ce388157d84a25abe685a8a2520bf00c00321821968e4bb398fd766e7abb"
    libraries=(libduckdb.so)
    architecture="x86_64"
    signature_policy="not-applicable"
    thin_architecture=""
    ;;
  Darwin:arm64)
    archive="libduckdb-osx-universal.zip"
    expected_sha256="7b5b8915cc382d0708636fe6385c0cdad5a61c9ff8ba2638b3e2141640783155"
    libraries=(libduckdb.dylib)
    architecture="arm64"
    signature_policy="adhoc"
    thin_architecture="arm64"
    ;;
  Darwin:x86_64)
    archive="libduckdb-osx-universal.zip"
    expected_sha256="7b5b8915cc382d0708636fe6385c0cdad5a61c9ff8ba2638b3e2141640783155"
    libraries=(libduckdb.dylib)
    architecture="x86_64"
    signature_policy="adhoc"
    thin_architecture="x86_64"
    ;;
  MINGW*_NT-*:x86_64 | MSYS_NT-*:x86_64 | CYGWIN_NT-*:x86_64)
    archive="libduckdb-windows-amd64.zip"
    expected_sha256="8375eb1fcf2212e8a0817950354815d4dde9dd383c2d9fa7b8975b71e278c1bd"
    libraries=(duckdb.dll duckdb.lib)
    architecture="x86_64"
    signature_policy="not-applicable"
    thin_architecture=""
    ;;
  *)
    echo "Unsupported DuckDB host: ${system}-${machine}" >&2
    exit 1
    ;;
esac

# The policy marker exists because idempotency alone would preserve caches
# produced under an older signing policy forever; a policy change must force
# a reinstall.
version_marker="${destination}/.version"
signature_policy_marker="${destination}/.signature-policy"
architecture_marker="${destination}/.architecture"
libraries_present=true
for library in "${libraries[@]}"; do
  if [[ ! -f "${destination}/${library}" ]]; then
    libraries_present=false
  fi
done
if [[ "$libraries_present" = true ]] \
  && [[ -f "$version_marker" ]] \
  && [[ "$(<"$version_marker")" = "$version" ]] \
  && [[ -f "$signature_policy_marker" ]] \
  && [[ "$(<"$signature_policy_marker")" = "$signature_policy" ]] \
  && [[ -f "$architecture_marker" ]] \
  && [[ "$(<"$architecture_marker")" = "$architecture" ]]; then
  if [[ -z "$thin_architecture" ]] \
    || [[ "$(lipo -archs "${destination}/${libraries[0]}")" = "$thin_architecture" ]]; then
    echo "DuckDB ${version} is already installed in ${destination}"
    exit 0
  fi
fi

temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT
download="${temporary_directory}/${archive}"
staged_install="${temporary_directory}/install"

curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  --output "$download" \
  "${release_base}/${archive}"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256=$(sha256sum "$download" | awk '{ print $1 }')
else
  actual_sha256=$(shasum -a 256 "$download" | awk '{ print $1 }')
fi
test "$actual_sha256" = "$expected_sha256"

mkdir "$staged_install"
if [[ "$system" = MINGW*_NT-* || "$system" = MSYS_NT-* || "$system" = CYGWIN_NT-* ]]; then
  extracted="${temporary_directory}/extracted"
  mkdir "$extracted"
  MSYS2_ARG_CONV_EXCL='*' \
    VIEWDA_ARCHIVE_PATH="$(cygpath -w "$download")" \
    VIEWDA_DESTINATION_PATH="$(cygpath -w "$extracted")" \
    powershell.exe -NoLogo -NoProfile -NonInteractive -Command \
    'Expand-Archive -LiteralPath $env:VIEWDA_ARCHIVE_PATH -DestinationPath $env:VIEWDA_DESTINATION_PATH -Force'
  for library in "${libraries[@]}"; do
    mv "${extracted}/${library}" "$staged_install"
  done
else
  unzip -q "$download" "${libraries[@]}" -d "$staged_install"
fi
for library in "${libraries[@]}"; do
  test -f "${staged_install}/${library}"
done

if [[ -n "$thin_architecture" ]]; then
  # The upstream macOS archive is universal; the app targets one
  # architecture, so the dead slice is dropped — shipping it would roughly
  # double the packaged library and threaten the DMG size budget.
  library=${libraries[0]}
  thinned_library="${staged_install}/${library}.thin"
  lipo -thin "$thin_architecture" \
    "${staged_install}/${library}" \
    -output "$thinned_library"
  mv "$thinned_library" "${staged_install}/${library}"
  test "$(lipo -archs "${staged_install}/${library}")" = "$thin_architecture"

  # The app is ad hoc signed in CI. A vendor-signed nested library has a
  # different Team ID, so hardened runtime library validation rejects it.
  # Uniform ad hoc signatures alone are still not enough on macOS 26 — the
  # process side is handled by the disable-library-validation entitlement
  # (native/desktop/Entitlements.plist).
  codesign --force --sign - "${staged_install}/${library}"
  codesign --verify --strict "${staged_install}/${library}"
fi

printf '%s\n' "$version" > "${staged_install}/.version"
printf '%s\n' "$signature_policy" > "${staged_install}/.signature-policy"
printf '%s\n' "$architecture" > "${staged_install}/.architecture"
mkdir -p "$(dirname "$destination")"
rm -rf -- "$destination"
mv "$staged_install" "$destination"
for library in "${libraries[@]}"; do
  test -f "${destination}/${library}"
done

echo "Installed DuckDB ${version} in ${destination}"
