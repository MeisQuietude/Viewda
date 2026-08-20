# Changelog

Newest first. `Unreleased` is what's already on `main` but not shipped; every other section matches a GitHub Release. When a version leaves prerelease, its prerelease sections fold into the stable section; their original notes stay on the GitHub Releases.

Within a version: Added · Changed · Fixed · Removed.

Backward-incompatible entries start with **Breaking:**.

## Unreleased

### Added

- Open Parquet files by dropping them on the window.

## 0.1.0 — 2026-08-20

Viewda's first stable release: a free, fully offline viewer for local
Apache Parquet files on Linux, macOS, and Windows.

### Added

- Open local Parquet files from the app or straight from the file
  manager; recent files stay a click away.
- Data view: a virtualized grid with typed values, filters with value
  suggestions, multi-column sorting, and a searchable column picker
  with pin, hide, resize, and fit-width controls.
- Copy selections, or export the filtered and sorted view to CSV with
  progress and cancellation.
- Structure view: file information, row groups, the nested schema, and
  on-demand column statistics.
- System, Light, or Dark theme.
- Signed in-app updates on the Stable or Latest channel — the app's
  only network request, at most once per 24 hours, can be disabled.
- Installers: Linux x64 AppImage (recommended) and Debian package,
  macOS DMG or Homebrew cask, Windows x64.
