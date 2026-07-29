#!/usr/bin/env bash
#
# The repository provisions its own Node into an ignored directory, and
# scripts/env.sh prepends it to PATH for every project command. The version
# comes from .node-version only; the SHA table below must be extended by hand
# on every bump — that loud friction is intended.

set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
version=$(tr -d '[:space:]' < "${repository_root}/.node-version")
destination="${repository_root}/native/.toolchain/node"
release_base="https://nodejs.org/dist/v${version}"
system=$(uname -s)
machine=$(uname -m)

case "${system}:${machine}" in
  Linux:x86_64)
    platform="linux-x64"
    archive_format="tar.gz"
    ;;
  Darwin:arm64)
    platform="darwin-arm64"
    archive_format="tar.gz"
    ;;
  Darwin:x86_64)
    platform="darwin-x64"
    archive_format="tar.gz"
    ;;
  MINGW*_NT-*:x86_64 | MSYS_NT-*:x86_64 | CYGWIN_NT-*:x86_64)
    platform="win-x64"
    archive_format="zip"
    ;;
  *)
    echo "Unsupported Node.js host: ${system}-${machine}" >&2
    exit 1
    ;;
esac

case "${version}:${platform}" in
  26.5.0:linux-x64)
    expected_sha256="22b5f47ad6ae78837e4c2b846019965ce1a06ba143de176102294a1bf44fc677"
    ;;
  26.5.0:darwin-arm64)
    expected_sha256="ee920559aaa2391569cff4d737e3b83963430e3a14dedd91bfe0ff53171b5af9"
    ;;
  26.5.0:darwin-x64)
    expected_sha256="98293394c945a24e64e00b4177bf075ec963ea70b34d1d2e24bd4a71716d334f"
    ;;
  26.5.0:win-x64)
    expected_sha256="d3b2277dbcccfdf24ef6302928f64f484cff1d77a6d3caa3a28f4d20ce9158f6"
    ;;
  *)
    echo "No SHA-256 is pinned for Node.js ${version} on ${platform}." >&2
    echo "Add the official nodejs.org hash to scripts/install-node.sh." >&2
    exit 1
    ;;
esac

if [[ "$platform" = win-x64 ]]; then
  installed_node="${destination}/bin/node.exe"
  installed_npm="${destination}/bin/npm.cmd"
else
  installed_node="${destination}/bin/node"
  installed_npm="${destination}/bin/npm"
fi

version_marker="${destination}/.version"
if [[ -x "$installed_node" ]] \
  && [[ -f "$installed_npm" ]] \
  && [[ -f "$version_marker" ]] \
  && [[ "$(<"$version_marker")" = "$version" ]] \
  && [[ "$("$installed_node" --version)" = "v${version}" ]]; then
  echo "Node.js ${version} is already installed in ${destination}"
  exit 0
fi

archive="node-v${version}-${platform}.${archive_format}"
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
if [[ "$archive_format" = zip ]]; then
  extracted="${temporary_directory}/extracted"
  mkdir "$extracted"
  # Git Bash ships GNU tar, which cannot read zip archives. PowerShell is part
  # of every supported Windows host and receives explicit native paths.
  MSYS2_ARG_CONV_EXCL='*' \
    VIEWDA_ARCHIVE_PATH="$(cygpath -w "$download")" \
    VIEWDA_DESTINATION_PATH="$(cygpath -w "$extracted")" \
    powershell.exe -NoLogo -NoProfile -NonInteractive -Command \
    'Expand-Archive -LiteralPath $env:VIEWDA_ARCHIVE_PATH -DestinationPath $env:VIEWDA_DESTINATION_PATH -Force'
  mv "${extracted}/node-v${version}-${platform}" "${staged_install}/bin"
  staged_node="${staged_install}/bin/node.exe"
  staged_npm="${staged_install}/bin/npm.cmd"
else
  tar --extract --gzip --file "$download" \
    --directory "$staged_install" \
    --strip-components=1
  staged_node="${staged_install}/bin/node"
  staged_npm="${staged_install}/bin/npm"
fi
test "$("$staged_node" --version)" = "v${version}"
test -f "$staged_npm"
printf '%s\n' "$version" > "${staged_install}/.version"

mkdir -p "$(dirname "$destination")"
rm -rf -- "$destination"
mv "$staged_install" "$destination"

echo "Installed Node.js ${version} in ${destination}"
