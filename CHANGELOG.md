# Changelog

Newest first. `Unreleased` is what's already on `main` but not shipped; every other section matches a GitHub Release.

Within a version: Added · Changed · Fixed · Removed.

Backward-incompatible entries start with **Breaking:**.

## Unreleased

### Added

- The Data view now has a toggleable schema sidebar with the full nested field
  tree and cancellable, on-demand statistics for the selected column.

### Changed

- The app icon now uses a graphite plate with a gold mark and a subtle rim so
  it stays visible on dark backgrounds.
- Structure now uses stable, human-readable Parquet physical and logical type
  names.

### Fixed

- Long Parquet type labels in Structure now stay within their column.

## 0.1.0-alpha.2 — 2026-08-02

### Added

- The start screen now lists and reopens up to eight recent files.
- Viewda appears as an Open With option for Apache Parquet files without
  replacing the user's default application. Settings can make Viewda the
  default through the platform-supported user action.
- Local Parquet rows now open in a virtualized data grid with type-aware
  values, memory-bounded raw TSV copying, row selection, column resize, pin and
  hide controls, and a Data or Structure view switch.

### Fixed

- The macOS native title bar no longer draws the Viewda window name over the
  in-app header.
- Source errors restored after an update now show their specific recovery
  message instead of the generic unsupported-file error.

## 0.1.0-alpha.1 — 2026-08-01

### Added

- The initial Viewda desktop application shell and native installers for Linux
  x64 (recommended AppImage and manual-update Debian package), Apple silicon
  and Intel Macs (including a Universal DMG), and Windows x64.
- Local Parquet files can now be opened to inspect file information and schema.
- Signed in-app updates can follow either the Stable or Latest channel, limit
  automatic checks to once per 24 hours, expose native Settings and manual
  checks, install from a quiet titlebar indicator, link to the GitHub release
  after restarting Viewda, and restore the open file.
