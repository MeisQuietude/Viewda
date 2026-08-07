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

- **Opens local Parquet files**, from the app or straight from your file
  manager, and keeps recent ones a click away.
- **Shows the data**: every row of the file, values exactly as stored, any
  selection ready to copy as TSV.
- **Shows the structure**: size, row counts, row groups and the nested schema
  as the file really stores it.

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
  fallback and is not recommended for most users. AppImage file associations
  require integration through appimaged or AppImageLauncher.

## Under the hood

A Rust core owns the data — windowed reads, metadata, SQL (DuckDB,
arrow-rs) — and streams Arrow columns to a thin React UI on a canvas grid,
in a Tauri shell. Between them sits one transport-agnostic engine protocol:
shell, engine and UI can each be swapped without rewriting the rest.

## Contributing

Bug reports and ideas are welcome at any time; code once the change is agreed
in an issue. [CONTRIBUTING.md](.github/CONTRIBUTING.md) has the rest: the
toolchain, the one command that gates every change, and what a pull request is
expected to carry. Everyone taking part follows the
[Code of Conduct](.github/CODE_OF_CONDUCT.md).

Report a vulnerability privately, the way
[SECURITY.md](.github/SECURITY.md) describes, never in a public issue.

## License

[Apache License 2.0](LICENSE)
