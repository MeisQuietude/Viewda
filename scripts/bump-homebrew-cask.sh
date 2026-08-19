#!/usr/bin/env bash
#
# Point Casks/viewda.rb at the release Homebrew should serve: the highest
# stable release, or the highest prerelease while no stable exists. GitHub's
# release asset digests are the checksum source, so nothing is downloaded.
# Prints the selected tag on success.

set -euo pipefail

script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd "${script_directory}/.." && pwd)
# shellcheck source=env.sh
source "${script_directory}/env.sh"
cd "$repository_root"

if (( $# != 0 )); then
  printf 'Usage: scripts/bump-homebrew-cask.sh\n' >&2
  exit 2
fi

repository=${GITHUB_REPOSITORY:-MeisQuietude/Viewda}
cask=Casks/viewda.rb

releases=$(gh api --paginate --slurp "repos/${repository}/releases?per_page=100")

select_release_tag() {
  node scripts/select-update-releases.mjs "$1" <<< "$releases"
}

tag=$(select_release_tag stable)
if [[ -z "$tag" ]]; then
  tag=$(select_release_tag latest)
fi
if [[ -z "$tag" ]]; then
  printf 'No published release is eligible for the cask.\n' >&2
  exit 1
fi
version=${tag#v}

asset_sha256() {
  local name="Viewda_${version}_$1.dmg" digest
  digest=$(jq -r --arg tag "$tag" --arg name "$name" \
    'flatten(1) | .[] | select(.tag_name == $tag) | .assets[] | select(.name == $name) | .digest' \
    <<< "$releases")
  if [[ "$digest" != sha256:* ]]; then
    printf 'Release %s has no sha256 digest for %s.\n' "$tag" "$name" >&2
    exit 1
  fi
  printf '%s\n' "${digest#sha256:}"
}

arm_sha256=$(asset_sha256 arm64)
intel_sha256=$(asset_sha256 x64)

rewritten=$(mktemp)
trap 'rm -f "$rewritten"' EXIT
sed \
  -e "s|^  version \".*\"\$|  version \"${version}\"|" \
  -e "s|^  sha256 arm:   \".*\",\$|  sha256 arm:   \"${arm_sha256}\",|" \
  -e "s|^         intel: \".*\"\$|         intel: \"${intel_sha256}\"|" \
  "$cask" > "$rewritten"
mv "$rewritten" "$cask"

# sed substitutions fail silently on pattern drift; prove each landed.
grep -Fq "version \"${version}\"" "$cask"
grep -Fq "\"${arm_sha256}\"" "$cask"
grep -Fq "\"${intel_sha256}\"" "$cask"

printf '%s\n' "$tag"
