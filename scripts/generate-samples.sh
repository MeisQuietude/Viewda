#!/usr/bin/env bash
#
# Generate deterministic ZSTD-compressed Parquet samples for local performance
# spikes. Presets: rows (100M mixed-type rows), size (10 GB target), and wide
# (10,000 mixed-type columns). Override defaults after OUTPUT_FILE; for example:
#   scripts/generate-samples.sh rows /tmp/viewda-rows.parquet --rows 2000000
#   scripts/generate-samples.sh size /Volumes/samples/viewda-10gb.parquet --target-size 10GB
# The output path is mandatory and existing files are never overwritten. The
# target filesystem needs room for the complete output; Cargo also needs room
# for release artifacts under native/target. The only tool prerequisite is
# rustup; native/rust-toolchain.toml selects the repository toolchain.
# ArrowWriter buffers one row group: size peaks near 170 MB by default; lower --row-group-rows to reduce it.

set -euo pipefail

script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd "${script_directory}/.." && pwd)
cd "${repository_root}/native"

cargo run \
  --release \
  --no-default-features \
  --package viewda-data-engine \
  --example generate_samples \
  -- "$@"
