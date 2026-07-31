# Viewda

A free, fully offline, cross-platform Apache Parquet viewer. Double-click a
file bigger than your RAM — it opens in under a second, in an interface that
belongs on your desktop.

> **Status: early alpha.** Published builds are available under
> [GitHub Releases](https://github.com/MeisQuietude/Viewda/releases).

## Why

A Parquet file is made for machines: columnar, compressed, binary. Superb
to compute on, mute to look at — you can't open it the way you open text,
so between you and your own data there is always a layer of code.

The questions haven't changed and won't: what's the schema? how many rows?
what do they look like? where are the nulls? None of them should cost an
environment, a query, or somebody else's server. Viewda makes the glance
free: double-click, look, close — whether Parquet is your daily currency or
a file someone just handed you.

## Principles

1. **Speed comes first.** A glance that waits is a failure; when a feature
   would cost responsiveness, the feature loses.
2. **Your data never leaves your machine.** Viewda has no telemetry and never
   uploads data. Its only network request is an identifier-free update check,
   attempted automatically at most once per 24 hours and available on demand;
   automatic checks can be disabled.
3. **The basics are free forever.** Viewing, SQL, export, metadata — never
   behind a paywall. Apache License 2.0, in the open.

## What it does today

- Opens a local Parquet file and shows its size, row counts and schema.

## What it will do

- **Open and read everything**: any size, local or over SSH; the data and
  the file's anatomy — schema, statistics, metadata down to row groups.
- **Sort, filter and search** without writing code — and full SQL with
  history when you want it.
- **Take the data with you**: copy or export the selection, the filtered
  view or the whole file — CSV, JSON, Markdown or Parquet.
- **Withstand broken files** and help debug them: everything readable
  opens, the damage gets named.

## Installation

Download the latest build from
[GitHub Releases](https://github.com/MeisQuietude/Viewda/releases):

- **macOS:** choose Apple silicon for an M-series Mac, Intel for an older Intel
  Mac, or Universal if unsure. Open the DMG and drag Viewda to Applications.
  Prereleases are ad hoc signed, not notarized; if macOS blocks the first
  launch, choose System Settings → Privacy & Security → Open Anyway.
- **Windows x64:** download and run the Windows x64 `.exe`. It is not
  code-signed yet, so SmartScreen may require **More info → Run anyway**.
- **Linux x64:** download the AppImage, run
  `chmod +x Viewda_*.AppImage`, then open it. The AppImage is recommended
  because it supports in-app updates. The `.deb` package is a manual-update
  fallback and is not recommended for most users.

## Under the hood

A Rust core owns the data — windowed reads, metadata, SQL (DuckDB,
arrow-rs) — and streams Arrow columns to a thin React UI on a canvas grid,
in a Tauri shell. Between them sits one transport-agnostic engine protocol:
shell, engine and UI can each be swapped without rewriting the rest.

## Development

Install [rustup](https://rustup.rs/). On Linux, install the native dependencies
first:

```sh
scripts/install-tauri-deps.sh # Linux only
scripts/run.sh setup
scripts/run.sh check
```

Windows development uses Git Bash and requires the
[Microsoft C++ Build Tools and WebView2](https://v2.tauri.app/start/prerequisites/#windows).

`scripts/run.sh check` is the canonical local and CI gate. Other commands are
`test`, `fmt`, `dev`, `bundle` and `doctor`; an optional Justfile exposes the
same names. The scripts provision pinned Node.js and DuckDB dependencies, while
rustup reads the pinned toolchain from `native/rust-toolchain.toml`.

CI verifies native Linux x64 AppImage and Debian packages, macOS Apple silicon
and Intel installers, Universal macOS, and Windows x64. Each directly
installable format has its own Actions archive with the full commit SHA.
Updater companions are archived only for release tags; release files use the
release version instead.

## Releasing

Prepare and verify the version on a branch:

```sh
scripts/release.sh prepare 0.1.0-alpha.1
# Move Unreleased entries under a dated version heading.
scripts/run.sh check
```

Commit the version and changelog together. After that commit reaches `main`,
create and push a signed annotated tag:

```sh
git tag --sign --annotate v0.1.0-alpha.1 --message "Viewda 0.1.0-alpha.1"
git push origin v0.1.0-alpha.1
```

The tag workflow requires a GitHub-verified tag on `main` and the
`TAURI_SIGNING_PRIVATE_KEY` repository secret. It builds and verifies every
installer, embeds update signatures in the updater manifest, and creates a
draft release. Smoke-test its assets on physical target machines before
publishing it. Publishing refreshes the Stable and Latest update channels on
GitHub Pages.

## License

[Apache License 2.0](LICENSE)
