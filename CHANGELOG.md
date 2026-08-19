# Changelog

Newest first. `Unreleased` is what's already on `main` but not shipped; every other section matches a GitHub Release. When a version leaves prerelease, its prerelease sections fold into the stable section; their original notes stay on the GitHub Releases.

Within a version: Added · Changed · Fixed · Removed.

Backward-incompatible entries start with **Breaking:**.

## Unreleased

## 0.1.0 — 2026-08-19

Viewda's first stable release: a free, fully offline viewer for local
Apache Parquet files on Linux, macOS, and Windows. This section describes
everything a fresh install can do.

### Added

- Opens local Parquet files from the app or from the file manager as an
  Open With option, without replacing the default application (Settings
  can make Viewda the default), and reopens up to eight recent files
  from the start screen.
- The Data view shows every row in a virtualized grid with type-aware
  values. Columns resize live while dragging, fit their loaded content
  one at a time or all at once, and can be pinned, hidden, or picked
  through a searchable column picker. Wide files stay fast: only
  visible or copied columns load.
- Typed column filters cover open-ended numeric and temporal
  comparisons, text matching — contains, does-not-contain, starts-with,
  ends-with, with a Match case toggle — and empty strings, and extend
  to UUID and JSON columns. The query bar offers structured condition
  editing, type-aware validation, a native date picker, cancellable
  value suggestions that highlight fragments across the whole column,
  and a cancellable exact match count.
- Multi-column sorting with a visible ORDER BY clause keeps current
  rows visible while changes prepare; Settings can raise the
  preparation memory limit.
- Copies grid selections as raw TSV with a memory bound, and exports a
  selection or the current filtered and sorted view to CSV through a
  native save dialog, with measured progress, cancellation, and a
  warning before closing during a running export.
- The Structure view shows file information, row groups, and the nested
  schema with stable, human-readable Parquet type names; the Data view
  adds a toggleable schema sidebar with on-demand statistics for the
  selected column.
- Settings follow the system theme or force Light or Dark across the
  app, data grid, and native window chrome without restarting.
- Signed in-app updates follow the Stable or Latest channel, check
  automatically at most once per 24 hours (automatic checks can be
  disabled), show download progress, and restore the open file after
  restarting.
- Native installers for Linux x64 (recommended AppImage with in-app
  updates, plus a manual-update Debian package), Apple silicon, Intel,
  and Universal macOS, and Windows x64.
- Viewda can be installed with Homebrew on macOS:
  `brew tap meisquietude/viewda https://github.com/MeisQuietude/Viewda`, then
  `brew install --cask viewda`. In-app updates keep working; `brew upgrade`
  leaves Viewda to update itself.
- Debug settings can record and copy a size-limited grid scrolling
  performance report that contains no file paths or cell values.
