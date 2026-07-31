# Source this file; executing it cannot affect the caller's environment.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "Source scripts/env.sh instead of executing it." >&2
  exit 1
fi

viewda_repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# Toolchain paths are established here, not in shell profiles: commands must
# see the pinned tools from interactive shells, CI and non-interactive agent
# sessions alike. Activation performed only by interactive shell hooks is
# invisible to the latter. These DuckDB paths serve the dev loop; packaged
# artifact probes deliberately replace or remove them.
# VIEWDA_NODE_DIR is a doctor selftest seam; setup always installs to the default.
VIEWDA_NODE_DIR=${VIEWDA_NODE_DIR:-"${viewda_repository_root}/native/.toolchain/node"}
export VIEWDA_NODE_DIR
export PATH="${VIEWDA_NODE_DIR}/bin:${PATH:-}"
viewda_duckdb_dir="${viewda_repository_root}/native/.duckdb"
export DUCKDB_LIB_DIR="$viewda_duckdb_dir"
case "$(uname -s)" in
  Linux)
    export LD_LIBRARY_PATH="$DUCKDB_LIB_DIR"
    ;;
  Darwin)
    export DYLD_FALLBACK_LIBRARY_PATH="$DUCKDB_LIB_DIR"
    ;;
  MINGW*_NT-* | MSYS_NT-* | CYGWIN_NT-*)
    # Native Rust tools need a Windows path for link search, while Git Bash
    # needs the POSIX spelling in PATH to resolve duckdb.dll at runtime.
    export DUCKDB_LIB_DIR="$(cygpath -m "$viewda_duckdb_dir")"
    export PATH="$viewda_duckdb_dir:$PATH"
    ;;
esac

unset viewda_duckdb_dir viewda_repository_root
