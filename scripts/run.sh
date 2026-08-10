#!/usr/bin/env bash

set -euo pipefail

script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd "${script_directory}/.." && pwd)
# shellcheck source=env.sh
source "${script_directory}/env.sh"
cd "$repository_root"

install_node() {
  scripts/install-node.sh
}

install_node_dependencies() {
  npm ci --prefix native/desktop
}

check_release_metadata() {
  scripts/release.sh verify
  test "$(scripts/release.sh debian-version 1.2.3-alpha.1)" \
    = "1.2.3~alpha.1-1"
  test "$(scripts/release.sh debian-version 1.2.3)" = "1.2.3-1"
  node --test scripts/select-update-releases.test.mjs
  check_updater_manifest_contract
}

check_updater_manifest_contract() (
  local version staging asset
  version=$(scripts/release.sh version)
  staging=$(mktemp -d)
  trap 'rm -rf "$staging"' EXIT
  printf 'Release notes.\n' > "$staging/notes.md"
  for asset in \
    "Viewda_${version}_amd64.AppImage" \
    "Viewda_${version}_arm64.app.tar.gz" \
    "Viewda_${version}_x64.app.tar.gz" \
    "Viewda_${version}_x64-setup.exe"; do
    : > "$staging/$asset"
    printf 'signed-%s\n' "$asset" > "$staging/$asset.sig"
  done

  scripts/release.sh updater-manifest \
    "$version" \
    "$staging/notes.md" \
    "$staging" \
    "$staging/updater.json"
  node - "$version" "$staging/updater.json" <<'NODE'
const fs = require("node:fs");

const [version, path] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
const expected = {
  "linux-x86_64": `Viewda_${version}_amd64.AppImage`,
  "darwin-aarch64": `Viewda_${version}_arm64.app.tar.gz`,
  "darwin-x86_64": `Viewda_${version}_x64.app.tar.gz`,
  "windows-x86_64": `Viewda_${version}_x64-setup.exe`,
};

if (manifest.version !== version || manifest.notes !== "Release notes.") {
  throw new Error("updater manifest metadata drift");
}
if (JSON.stringify(Object.keys(manifest.platforms)) !== JSON.stringify(Object.keys(expected))) {
  throw new Error("updater manifest platform drift");
}
for (const [platform, asset] of Object.entries(expected)) {
  const entry = manifest.platforms[platform];
  if (!entry.url.endsWith(`/releases/download/v${version}/${asset}`)) {
    throw new Error(`${platform} updater URL drift`);
  }
  if (entry.signature !== `signed-${asset}`) {
    throw new Error(`${platform} updater signature drift`);
  }
}
NODE
)

install_duckdb() {
  scripts/install-duckdb.sh "$DUCKDB_LIB_DIR"
}

require_duckdb() {
  local library
  local -a libraries
  case "$(uname -s)" in
    Linux) libraries=(libduckdb.so) ;;
    Darwin) libraries=(libduckdb.dylib) ;;
    MINGW*_NT-* | MSYS_NT-* | CYGWIN_NT-*)
      libraries=(duckdb.dll duckdb.lib)
      ;;
    *) return ;;
  esac

  for library in "${libraries[@]}"; do
    if [[ ! -f "${DUCKDB_LIB_DIR}/${library}" ]]; then
      printf 'DuckDB is unavailable. Fix: run `scripts/run.sh setup`.\n' >&2
      exit 1
    fi
  done
}

check_environment() {
  scripts/doctor.sh
}

check_environment_contract() {
  scripts/doctor.sh selftest
}

run_rust_tests() (
  cd native
  cargo test --workspace --locked
)

run_frontend_tests() {
  npm run test --prefix native/desktop
}

run_tests() {
  run_rust_tests
  run_frontend_tests
}

run_native_checks() {
  (
    cd native
    cargo clippy --workspace --all-targets --locked -- -D warnings
  )
  run_rust_tests
}

provision_checked_environment() {
  install_node
  check_release_metadata
  install_node_dependencies
  check_environment
  install_duckdb
  check_environment_contract
}

cmd_setup() {
  install_node
  check_release_metadata
  install_node_dependencies
  install_duckdb
  check_environment
}

# The canonical check sequence, shared verbatim with CI. `--locked` is used on
# every dependency-resolving Cargo call: a machine that drifted from Cargo.lock
# must fail rather than quietly rewrite it. `cargo fmt` resolves no dependencies.
cmd_check() {
  provision_checked_environment
  (
    cd native
    cargo fmt --all --check
  )
  run_native_checks
  npm run format:check --prefix native/desktop
  npm run lint --prefix native/desktop
  run_frontend_tests
  npm run build --prefix native/desktop
}

cmd_check_native() {
  provision_checked_environment
  run_native_checks
}

cmd_test() {
  provision_checked_environment
  run_tests
}

cmd_fmt() {
  install_node
  install_node_dependencies
  check_environment
  (cd native && cargo fmt --all)
  npm run format --prefix native/desktop
}

cmd_dev() {
  install_node
  install_node_dependencies
  check_environment
  install_duckdb
  npm run tauri --prefix native/desktop -- dev
}

run_tauri_build() {
  local bundles=$1
  local updater_artifacts=$2

  if [[ "$updater_artifacts" == disabled ]]; then
    npm run tauri --prefix native/desktop -- build \
      --bundles "$bundles" \
      --config '{"bundle":{"createUpdaterArtifacts":false}}'
  else
    npm run tauri --prefix native/desktop -- build --bundles "$bundles"
  fi
}

cmd_bundle() {
  local -a packages

  check_environment
  require_duckdb
  # macOS still ships Bash 3.2, where expanding an empty array under `set -u`
  # fails. Keep this optional command state scalar across every platform.
  local updater_artifacts=enabled
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" \
    && -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]]; then
    if [[ ! -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]]; then
      printf 'Updater signing key not found: %s\n' \
        "$TAURI_SIGNING_PRIVATE_KEY_PATH" >&2
      exit 1
    fi
    # The standalone signer accepts a path, but the Tauri bundler reads the
    # key content variable. Keep local keys out of shell profiles while
    # presenting the one input the bundler actually consumes.
    TAURI_SIGNING_PRIVATE_KEY=$(< "$TAURI_SIGNING_PRIVATE_KEY_PATH")
    export TAURI_SIGNING_PRIVATE_KEY
  fi
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    # Contributors can build native installers without possessing the release
    # signing key. CI sets the key and exercises the updater artifacts.
    updater_artifacts=disabled
  elif [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD+x}" ]]; then
    # Viewda's updater key is passwordless so CI can sign non-interactively.
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  fi
  # Cargo caches retain generated bundles from earlier builds. Remove only the
  # current platform output so callers cannot publish stale package versions.
  case "$(uname -s)" in
    Linux)
      rm -rf -- \
        native/target/release/bundle/appimage \
        native/target/release/bundle/deb
      run_tauri_build deb,appimage "$updater_artifacts"
      mapfile -d '' -t packages < <(
        find native/target/release/bundle/deb \
          -maxdepth 1 -type f -name '*.deb' -print0
      )
      if (( ${#packages[@]} != 1 )); then
        printf 'Expected one Tauri Debian package, found %s.\n' \
          "${#packages[@]}" >&2
        exit 1
      fi
      scripts/release.sh repack-deb "${packages[0]}"
      ;;
    Darwin)
      rm -rf -- \
        native/target/release/bundle/dmg \
        native/target/release/bundle/macos
      run_tauri_build app,dmg "$updater_artifacts"
      ;;
    MINGW*_NT-* | MSYS_NT-* | CYGWIN_NT-*)
      rm -rf -- native/target/release/bundle/nsis
      run_tauri_build nsis "$updater_artifacts"
      ;;
    *)
      printf 'Bundling is unsupported on %s.\n' "$(uname -s)" >&2
      exit 1
      ;;
  esac
}

cmd_doctor() {
  exec scripts/doctor.sh
}

usage() {
  printf 'Usage: scripts/run.sh <setup|check|check-native|test|fmt|dev|bundle|doctor>\n' >&2
}

if (( $# != 1 )); then
  usage
  exit 2
fi

case "$1" in
  setup) cmd_setup ;;
  check) cmd_check ;;
  check-native) cmd_check_native ;;
  test) cmd_test ;;
  fmt) cmd_fmt ;;
  dev) cmd_dev ;;
  bundle) cmd_bundle ;;
  doctor) cmd_doctor ;;
  *)
    usage
    exit 2
    ;;
esac
