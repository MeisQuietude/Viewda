#!/usr/bin/env bash
#
# Keep native/Cargo.toml as the authored application version, verify its
# generated metadata, and turn the matching changelog section into release
# notes. Tag publication stays in CI so the released files are the same files
# that passed the native artifact gates.

set -euo pipefail

script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd "${script_directory}/.." && pwd)
# shellcheck source=env.sh
source "${script_directory}/env.sh"
cd "$repository_root"

usage() {
  printf 'Usage: scripts/release.sh <version|prepare VERSION|verify [VERSION_OR_TAG]|notes VERSION_OR_TAG OUTPUT|updater-manifest VERSION_OR_TAG NOTES ASSET_DIR OUTPUT|debian-version VERSION|repack-deb PACKAGE>\n' >&2
}

normalize_version() {
  local version=${1#v}
  if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
    printf 'Invalid semantic version: %s\n' "$1" >&2
    exit 2
  fi
  printf '%s\n' "$version"
}

application_version() {
  local version
  if ! version=$(
    awk '
      /^\[workspace\.package\]$/ {
        in_workspace_package = 1
        next
      }
      /^\[/ {
        in_workspace_package = 0
      }
      in_workspace_package && /^[[:space:]]*version[[:space:]]*=/ {
        value = $0
        sub(/^[^"]*"/, "", value)
        sub(/".*$/, "", value)
        print value
        count += 1
      }
      END {
        if (count != 1) {
          exit 1
        }
      }
    ' native/Cargo.toml
  ); then
    printf 'native/Cargo.toml must define one workspace package version.\n' >&2
    exit 1
  fi
  normalize_version "$version"
}

debian_version() {
  local version
  version=$(normalize_version "$1")
  # Debian sorts `~` before the corresponding stable version. The fixed
  # revision records that GitHub releases produce one Debian package build.
  if [[ "$version" == *-* ]]; then
    printf '%s~%s-1\n' "${version%%-*}" "${version#*-}"
  else
    printf '%s-1\n' "$version"
  fi
}

repack_debian_package() (
  local package application_version package_version architecture
  local filename product expected_filename target staging control

  if ! command -v dpkg-deb >/dev/null 2>&1; then
    printf 'dpkg-deb is required to normalize the Debian package version.\n' >&2
    exit 1
  fi

  package=$(realpath "$1")
  application_version=$(dpkg-deb --field "$package" Version)
  application_version=$(normalize_version "$application_version")
  package_version=$(debian_version "$application_version")
  architecture=$(dpkg-deb --field "$package" Architecture)
  filename=$(basename "$package")
  product=${filename%%_*}
  expected_filename="${product}_${application_version}_${architecture}.deb"
  if [[ "$filename" != "$expected_filename" ]]; then
    printf 'Unexpected Tauri Debian package name: %s (expected %s).\n' \
      "$filename" "$expected_filename" >&2
    exit 1
  fi

  target="$(dirname "$package")/${product}_${package_version}_${architecture}.deb"
  staging=$(mktemp -d)
  trap 'rm -rf "$staging"' EXIT
  mkdir "$staging/root"
  dpkg-deb --raw-extract "$package" "$staging/root"
  control="$staging/root/DEBIAN/control"
  awk -v version="$package_version" '
    /^Version: / {
      count += 1
      print "Version: " version
      next
    }
    { print }
    END {
      if (count != 1) {
        exit 1
      }
    }
  ' "$control" > "$staging/control"
  mv "$staging/control" "$control"

  dpkg-deb -Zgzip -z9 --root-owner-group --build "$staging/root" "$target"
  test "$(dpkg-deb --field "$target" Version)" = "$package_version"
  # Tauri signs the pre-normalized Debian package when updater artifacts are
  # enabled. Repacking changes its bytes, and `.deb` is deliberately outside
  # the self-update channel, so the now-invalid orphan signature must go too.
  rm -f -- "${package}.sig"
  rm -- "$package"
  printf '[release] debian-version=%s package=%s\n' \
    "$package_version" "$target"
)

ensure_node() {
  scripts/install-node.sh
  if ! command -v node >/dev/null 2>&1; then
    printf 'Repository Node is unavailable after installation.\n' >&2
    exit 1
  fi
}

verify_versions() {
  local canonical expected=${1:-}
  canonical=$(application_version)
  node - "$canonical" "$expected" <<'NODE'
const fs = require("node:fs");

const canonical = process.argv[2];
const expected = process.argv[3];
const values = [];

function add(source, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${source} has no version`);
  }
  values.push([source, value]);
}

function rejectVersion(source, object) {
  if (Object.hasOwn(object, "version")) {
    throw new Error(
      `${source} must not duplicate the application version from native/Cargo.toml`,
    );
  }
}

const packageJson = JSON.parse(
  fs.readFileSync("native/desktop/package.json", "utf8"),
);
const packageLock = JSON.parse(
  fs.readFileSync("native/desktop/package-lock.json", "utf8"),
);
const tauriConfig = JSON.parse(
  fs.readFileSync("native/desktop/tauri.conf.json", "utf8"),
);
rejectVersion("package.json", packageJson);
rejectVersion("package-lock.json", packageLock);
rejectVersion("package-lock.json root package", packageLock.packages[""]);
rejectVersion("tauri.conf.json", tauriConfig);

const cargoLock = fs.readFileSync("native/Cargo.lock", "utf8");
for (const name of ["viewda-data-engine", "viewda-desktop"]) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = cargoLock.match(
    new RegExp(
      String.raw`\[\[package\]\]\nname = "${escaped}"\nversion = "([^"]+)"`,
    ),
  );
  if (!match) {
    throw new Error(`native/Cargo.lock has no ${name} package version`);
  }
  add(`native/Cargo.lock ${name}`, match[1]);
}

for (const [source, value] of values) {
  if (value !== canonical) {
    throw new Error(
      `application version drift: ${source} has ${value}, expected ${canonical}`,
    );
  }
}
if (expected && canonical !== expected) {
  throw new Error(
    `tag/version drift: repository has ${canonical}, expected ${expected}`,
  );
}
process.stdout.write(`[release] version=${canonical}\n`);
NODE
}

prepare_version() {
  local version=$1
  verify_versions
  node - "$version" <<'NODE'
const fs = require("node:fs");

const version = process.argv[2];

const cargoTomlPath = "native/Cargo.toml";
let cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
let cargoTomlChanges = 0;
cargoToml = cargoToml.replace(
  /(\[workspace\.package\][\s\S]*?(?:^|\n)version = ")[^"]+(")/,
  (match, prefix, suffix) => {
    cargoTomlChanges += 1;
    return `${prefix}${version}${suffix}`;
  },
);
if (cargoTomlChanges !== 1) {
  throw new Error(
    `expected one workspace version, changed ${cargoTomlChanges}`,
  );
}
fs.writeFileSync(cargoTomlPath, cargoToml);

const cargoLockPath = "native/Cargo.lock";
let cargoLock = fs.readFileSync(cargoLockPath, "utf8");
let cargoLockChanges = 0;
for (const name of ["viewda-data-engine", "viewda-desktop"]) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    String.raw`(\[\[package\]\]\nname = "${escaped}"\nversion = ")[^"]+(")`,
  );
  cargoLock = cargoLock.replace(pattern, (match, prefix, suffix) => {
    cargoLockChanges += 1;
    return `${prefix}${version}${suffix}`;
  });
}
if (cargoLockChanges !== 2) {
  throw new Error(
    `expected two Viewda lockfile versions, changed ${cargoLockChanges}`,
  );
}
fs.writeFileSync(cargoLockPath, cargoLock);
NODE
  verify_versions "$version"
}

require_changelog_section() {
  local version=$1
  if ! awk -v heading="## ${version} — " \
    'index($0, heading) == 1 { found = 1 } END { exit !found }' \
    CHANGELOG.md; then
    printf 'CHANGELOG.md has no dated section for %s.\n' "$version" >&2
    exit 1
  fi
}

write_release_notes() {
  local version=$1 output=$2 changes
  require_changelog_section "$version"
  changes=$(
    awk -v heading="## ${version} — " '
      index($0, heading) == 1 { capture = 1; next }
      capture && /^## / { exit }
      capture { print }
    ' CHANGELOG.md
  )
  if [[ -z "${changes//[[:space:]]/}" ]]; then
    printf 'The changelog section for %s is empty.\n' "$version" >&2
    exit 1
  fi

  {
    if [[ "$version" == *-* ]]; then
      printf '> This is an alpha release. Expect incomplete features.\n\n'
    fi
    printf '## Installation notes\n\n'
    printf -- '- **macOS:** the app is ad hoc signed and not notarized. After the first rejected launch, use System Settings → Privacy & Security → Open Anyway.\n'
    printf -- '- **Windows:** the installer is not code-signed; SmartScreen may require More info → Run anyway.\n'
    printf -- '- **Linux:** use the AppImage for in-app updates. The `.deb` package is a manual-update fallback.\n\n'
    printf '## Changes\n%s\n' "$changes"
  } > "$output"
}

write_updater_manifest() {
  local version=$1 notes=$2 assets=$3 output=$4
  local base_url="https://github.com/MeisQuietude/Viewda/releases/download/v${version}"
  local -a files=(
    "Viewda_${version}_amd64.AppImage"
    "Viewda_${version}_arm64.app.tar.gz"
    "Viewda_${version}_x64.app.tar.gz"
    "Viewda_${version}_x64-setup.exe"
  )
  local file

  for file in "${files[@]}"; do
    test -f "${assets}/${file}"
    test -s "${assets}/${file}.sig"
  done
  test -f "$notes"

  node - "$version" "$notes" "$assets" "$base_url" "$output" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [version, notesPath, assets, baseUrl, output] = process.argv.slice(2);

function platform(asset) {
  return {
    signature: fs.readFileSync(path.join(assets, `${asset}.sig`), "utf8").trim(),
    url: `${baseUrl}/${asset}`,
  };
}

const manifest = {
  version,
  notes: fs.readFileSync(notesPath, "utf8").trim(),
  platforms: {
    "linux-x86_64": platform(`Viewda_${version}_amd64.AppImage`),
    "darwin-aarch64": platform(`Viewda_${version}_arm64.app.tar.gz`),
    "darwin-x86_64": platform(`Viewda_${version}_x64.app.tar.gz`),
    "windows-x86_64": platform(`Viewda_${version}_x64-setup.exe`),
  },
};

fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
}

if (( $# < 1 )); then
  usage
  exit 2
fi

command_name=$1
shift

case "$command_name" in
  version)
    if (( $# != 0 )); then
      usage
      exit 2
    fi
    application_version
    ;;
  prepare)
    if (( $# != 1 )); then
      usage
      exit 2
    fi
    ensure_node
    version=$(normalize_version "$1")
    prepare_version "$version"
    ;;
  verify)
    if (( $# > 1 )); then
      usage
      exit 2
    fi
    ensure_node
    if (( $# == 1 )); then
      version=$(normalize_version "$1")
      verify_versions "$version"
      require_changelog_section "$version"
    else
      verify_versions
    fi
    ;;
  notes)
    if (( $# != 2 )); then
      usage
      exit 2
    fi
    ensure_node
    version=$(normalize_version "$1")
    verify_versions "$version"
    write_release_notes "$version" "$2"
    ;;
  updater-manifest)
    if (( $# != 4 )); then
      usage
      exit 2
    fi
    ensure_node
    version=$(normalize_version "$1")
    verify_versions "$version"
    write_updater_manifest "$version" "$2" "$3" "$4"
    ;;
  debian-version)
    if (( $# != 1 )); then
      usage
      exit 2
    fi
    debian_version "$1"
    ;;
  repack-deb)
    if (( $# != 1 )); then
      usage
      exit 2
    fi
    repack_debian_package "$1"
    ;;
  *)
    usage
    exit 2
    ;;
esac
