#!/usr/bin/env bash
#
# The single source for Tauri's Linux system dependencies: CI jobs and
# contributor machines run this same script, so the two lists can never
# drift apart.

set -euo pipefail

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer supports Debian and Ubuntu hosts with apt-get." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  sudo_command=()
elif command -v sudo >/dev/null 2>&1; then
  sudo_command=(sudo)
else
  echo "Run this script as root or install sudo." >&2
  exit 1
fi

"${sudo_command[@]}" apt-get update
"${sudo_command[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install --yes \
  build-essential \
  ca-certificates \
  curl \
  file \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  libxdo-dev \
  patchelf \
  pkg-config \
  unzip \
  wget
