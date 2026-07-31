#!/usr/bin/env bash
#
# Rebuild the mutable stable/latest endpoints from published GitHub Releases.
# Each release owns an immutable signed updater manifest; Pages only selects
# which one each channel exposes.

set -euo pipefail

script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd "${script_directory}/.." && pwd)
# shellcheck source=env.sh
source "${script_directory}/env.sh"
cd "$repository_root"

if (( $# != 1 )); then
  printf 'Usage: scripts/publish-update-channels.sh OUTPUT_DIRECTORY\n' >&2
  exit 2
fi

output_directory=$1
repository=${GITHUB_REPOSITORY:-MeisQuietude/Viewda}
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
mkdir -p "$output_directory/updates"

releases_file="$staging/releases.json"
gh api --paginate --slurp \
  "repos/${repository}/releases?per_page=100" > "$releases_file"

select_release_tag() {
  node scripts/select-update-releases.mjs "$1" < "$releases_file"
}

download_manifest() {
  local channel=$1 tag=$2 version manifest
  version=${tag#v}
  manifest="Viewda_${version}_updater.json"
  mkdir -p "$staging/$channel"
  gh release download "$tag" \
    --repo "$repository" \
    --pattern "$manifest" \
    --dir "$staging/$channel"
  cp "$staging/$channel/$manifest" "$output_directory/updates/$channel.json"
}

latest_tag=$(
  select_release_tag latest
)
if [[ -z "$latest_tag" ]]; then
  printf 'No published release with an updater manifest exists for latest.\n' >&2
  exit 1
fi
download_manifest latest "$latest_tag"

stable_tag=$(select_release_tag stable)
if [[ -n "$stable_tag" ]]; then
  download_manifest stable "$stable_tag"
fi

cat > "$output_directory/index.html" <<'HTML'
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Viewda updates</title></head>
  <body><p>Signed update manifests for Viewda.</p></body>
</html>
HTML

printf '[updates] latest=%s\n' "$latest_tag"
if [[ -n "${stable_tag:-}" ]]; then
  printf '[updates] stable=%s\n' "$stable_tag"
else
  printf '[updates] stable=unpublished\n'
fi
