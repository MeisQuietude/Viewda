# Changelog

Newest first. `Unreleased` is what's already on `main` but not shipped; every other section matches a GitHub Release.

Within a version: Added · Changed · Fixed · Removed.

Backward-incompatible entries start with **Breaking:**.

## Unreleased

### Added

- The start screen now lists and reopens up to eight recent files.

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
