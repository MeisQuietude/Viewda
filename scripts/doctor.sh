#!/usr/bin/env bash

set -euo pipefail

script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd "${script_directory}/.." && pwd)
# shellcheck source=env.sh
source "${script_directory}/env.sh"
cd "$repository_root"

# Local-to-CI parity is pins, assertions and a diffable manifest rather than
# identical environments. Doctor rejects drift from repository pins and prints
# the system layer in a fixed order so local and CI logs can be compared
# line-by-line. Expected versions come from pin files, never this script.
run_doctor() {
  local missing command_name tauri_binary
  local expected_node expected_rust expected_tauri
  local actual_node actual_rust actual_cargo actual_tauri tauri_output
  local os glibc webkit clang
  local -a missing_commands=()

  for command_name in node npm rustc cargo; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      missing_commands+=("$command_name")
    fi
  done

  if (( ${#missing_commands[@]} > 0 )); then
    for command_name in "${missing_commands[@]}"; do
      printf '[doctor] Required command `%s` is unavailable.\n' \
        "$command_name" >&2
    done

    missing=" ${missing_commands[*]} "
    if [[ "$missing" = *" node "* || "$missing" = *" npm "* ]]; then
      printf '[doctor] Fix: run `scripts/run.sh setup`.\n' >&2
    fi
    if [[ "$missing" = *" rustc "* || "$missing" = *" cargo "* ]]; then
      printf '[doctor] Fix: install rustup and load its shell environment; native/rust-toolchain.toml selects the pinned toolchain.\n' >&2
    fi
    printf '[doctor] Environment is not ready. Apply the fixes above and run `scripts/doctor.sh` again.\n' >&2
    exit 1
  fi

  tauri_binary=native/desktop/node_modules/.bin/tauri
  if [[ ! -x "$tauri_binary" ]]; then
    printf '[doctor] The pinned Tauri CLI is unavailable.\n' >&2
    printf '[doctor] Fix: run `scripts/run.sh setup`.\n' >&2
    exit 1
  fi

  expected_node=$(tr -d '[:space:]' < .node-version)
  expected_rust=$(awk -F '"' '/^channel/ { print $2 }' native/rust-toolchain.toml)
  expected_tauri=$(node -p "require('./native/desktop/package.json').devDependencies['@tauri-apps/cli']")

  actual_node=$(node --version)
  actual_node=${actual_node#v}
  actual_rust=$(cd native && rustc --version | awk '{ print $2 }')
  actual_cargo=$(cd native && cargo --version | awk '{ print $2 }')
  if ! tauri_output=$(npm exec --prefix native/desktop -- tauri --version 2>/dev/null); then
    printf '[doctor] The pinned Tauri CLI could not run.\n' >&2
    printf '[doctor] Fix: run `scripts/run.sh setup`.\n' >&2
    exit 1
  fi
  actual_tauri=$(awk '{ print $2 }' <<< "$tauri_output")

  case "$(uname -s)" in
    Linux)
      # shellcheck disable=SC1091
      source /etc/os-release
      os=${PRETTY_NAME:-Linux}
      glibc=$(ldd --version 2>&1 | sed -n '1p')
      if command -v pkg-config >/dev/null 2>&1; then
        webkit=$(pkg-config --modversion webkit2gtk-4.1 2>/dev/null || printf unavailable)
      else
        webkit=unavailable
      fi
      clang=not-applicable
      ;;
    Darwin)
      os="$(sw_vers -productName) $(sw_vers -productVersion)"
      glibc=not-applicable
      webkit=not-applicable
      clang=$(clang --version | sed -n '1p')
      ;;
    MINGW*_NT-* | MSYS_NT-* | CYGWIN_NT-*)
      os=$(cmd.exe //c ver 2>/dev/null | tr -d '\r' | sed -n '/[^[:space:]]/p' | sed -n '1p')
      glibc=not-applicable
      webkit=not-applicable
      clang=not-applicable
      ;;
    *)
      os=$(uname -s)
      glibc=not-applicable
      webkit=not-applicable
      clang=not-applicable
      ;;
  esac

  printf '[doctor] os=%s\n' "$os"
  printf '[doctor] arch=%s\n' "$(uname -m)"
  printf '[doctor] glibc=%s\n' "$glibc"
  printf '[doctor] webkit2gtk-4.1=%s\n' "$webkit"
  printf '[doctor] clang=%s\n' "$clang"
  printf '[doctor] node=%s\n' "$actual_node"
  printf '[doctor] npm=%s\n' "$(npm --version)"
  printf '[doctor] rustc=%s\n' "$actual_rust"
  printf '[doctor] cargo=%s\n' "$actual_cargo"
  printf '[doctor] tauri-cli=%s\n' "$actual_tauri"

  assert_version() {
    local tool=$1 expected=$2 actual=$3
    if [[ "$actual" != "$expected" ]]; then
      printf '[doctor] %s drift: expected %s, got %s\n' \
        "$tool" "$expected" "$actual" >&2
      return 1
    fi
  }

  assert_version node "$expected_node" "$actual_node"
  assert_version rustc "$expected_rust" "$actual_rust"
  assert_version tauri-cli "$expected_tauri" "$actual_tauri"
  if [[ "$(uname -s)" = Linux && "$webkit" = unavailable ]]; then
    printf '[doctor] Tauri Linux system dependencies are unavailable.\n' >&2
    printf '[doctor] Fix: run `scripts/install-tauri-deps.sh`.\n' >&2
    printf '[doctor] Environment is not ready. Apply the fix above and run `scripts/doctor.sh` again.\n' >&2
    exit 1
  fi
  # DuckDB is runtime-gated at v1.5.5 by data-engine tests.
  printf '[doctor] Environment is ready.\n'
}

assert_no_raw_command_error() {
  local output=$1
  if grep -Fq 'command not found' "$output"; then
    printf 'Doctor exposed a shell command-not-found error.\n' >&2
    exit 1
  fi
}

assert_output_line() {
  local output=$1 expected=$2
  if ! grep -Fqx "$expected" "$output"; then
    printf 'Doctor selftest did not find the expected line:\n%s\n' \
      "$expected" >&2
    sed -n '1,200p' "$output" >&2
    exit 1
  fi
}

assert_output_contains() {
  local output=$1 expected=$2
  if ! grep -Fq "$expected" "$output"; then
    printf 'Doctor selftest did not find the expected text:\n%s\n' \
      "$expected" >&2
    sed -n '1,200p' "$output" >&2
    exit 1
  fi
}

selftest_path() {
  local test_bin=$1
  case "$(uname -s)" in
    MINGW*_NT-* | MSYS_NT-* | CYGWIN_NT-*)
      # A copied/symlinked bash.exe still loads msys-2.0.dll from its original
      # Git Bash directory. That directory contains neither Node nor Rust, so
      # the dependency omissions under test remain real.
      printf '%s:%s\n' "$test_bin" "$(dirname "$(command -v bash)")"
      ;;
    *)
      printf '%s\n' "$test_bin"
      ;;
  esac
}

# Doctor's failure guidance is a contract. Each scenario builds a PATH sandbox
# missing one dependency class and asserts the exact recovery message.
selftest_missing_node() (
  local temporary_directory test_bin test_path command_name command_path output
  temporary_directory=$(mktemp -d)
  trap 'rm -rf "$temporary_directory"' EXIT
  test_bin="${temporary_directory}/bin"
  mkdir "$test_bin"

  for command_name in \
    awk bash cargo clang dirname env ldd npm pkg-config rustc sed sh sw_vers tr uname; do
    if command_path=$(command -v "$command_name" 2>/dev/null); then
      ln -s "$command_path" "${test_bin}/${command_name}"
    fi
  done

  test_path=$(selftest_path "$test_bin")
  output="${temporary_directory}/doctor-output"
  if VIEWDA_NODE_DIR="${temporary_directory}/missing-node" PATH="$test_path" \
    "$script_directory/doctor.sh" >"$output" 2>&1; then
    printf 'Expected doctor to reject an environment without Node.js.\n' >&2
    exit 1
  fi

  assert_output_line "$output" \
    '[doctor] Required command `node` is unavailable.'
  assert_output_line "$output" \
    '[doctor] Fix: run `scripts/run.sh setup`.'
  assert_no_raw_command_error "$output"
)

selftest_missing_rust() (
  local temporary_directory test_bin test_path command_name command_path output
  temporary_directory=$(mktemp -d)
  trap 'rm -rf "$temporary_directory"' EXIT
  test_bin="${temporary_directory}/bin"
  mkdir "$test_bin"

  for command_name in \
    awk bash clang dirname env ldd pkg-config sed sh sw_vers tr uname; do
    if command_path=$(command -v "$command_name" 2>/dev/null); then
      ln -s "$command_path" "${test_bin}/${command_name}"
    fi
  done

  test_path=$(selftest_path "$test_bin")
  output="${temporary_directory}/doctor-output"
  if PATH="$test_path" "$script_directory/doctor.sh" >"$output" 2>&1; then
    printf 'Expected doctor to reject an environment without Rust.\n' >&2
    exit 1
  fi

  assert_output_line "$output" \
    '[doctor] Required command `rustc` is unavailable.'
  assert_output_line "$output" \
    '[doctor] Required command `cargo` is unavailable.'
  assert_output_contains "$output" \
    '[doctor] Fix: install rustup and load its shell environment'
  assert_no_raw_command_error "$output"
)

selftest_missing_linux_dependencies() (
  local temporary_directory test_bin command_name command_path output

  if [[ "$(uname -s)" != Linux ]]; then
    return
  fi

  temporary_directory=$(mktemp -d)
  trap 'rm -rf "$temporary_directory"' EXIT
  test_bin="${temporary_directory}/bin"
  mkdir "$test_bin"

  for command_name in \
    awk bash cargo clang dirname env ldd rustc sed sh sw_vers tr uname; do
    if command_path=$(command -v "$command_name" 2>/dev/null); then
      ln -s "$command_path" "${test_bin}/${command_name}"
    fi
  done

  output="${temporary_directory}/doctor-output"
  if PATH="$test_bin" "$script_directory/doctor.sh" >"$output" 2>&1; then
    printf 'Expected doctor to reject missing Tauri Linux dependencies.\n' >&2
    exit 1
  fi

  assert_output_line "$output" \
    '[doctor] webkit2gtk-4.1=unavailable'
  assert_output_line "$output" \
    '[doctor] Fix: run `scripts/install-tauri-deps.sh`.'
  assert_no_raw_command_error "$output"
)

run_selftest() {
  selftest_missing_node
  selftest_missing_rust
  selftest_missing_linux_dependencies
  printf '[doctor:selftest] All dependency scenarios passed.\n'
}

case "${1:-}" in
  "")
    run_doctor
    ;;
  selftest)
    if (( $# != 1 )); then
      printf 'Usage: scripts/doctor.sh [selftest]\n' >&2
      exit 2
    fi
    run_selftest
    ;;
  *)
    printf 'Usage: scripts/doctor.sh [selftest]\n' >&2
    exit 2
    ;;
esac
