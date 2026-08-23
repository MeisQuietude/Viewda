# Changelog

Newest first. `Unreleased` is what's already on `main` but not shipped; every other section matches a GitHub Release. When a version leaves prerelease, its prerelease sections fold into the stable section; their original notes stay on the GitHub Releases.

Within a version: Added · Changed · Fixed · Removed.

Backward-incompatible entries start with **Breaking:**.

## Unreleased

### Added

- Inspect Parquet storage in Structure view with exact chunk coverage and
  row-group ranges; sortable row-group and physical-column tables with stable
  leaf numbers for shortened paths; an optional chunk map with compression,
  codec and statistics lenses plus independent Bloom markers; chunk details and
  Bloom probes; and a path-free, value-free Markdown report.

### Fixed

- Keep the column selector visible above the data grid's column headers.
- Made the empty WHERE popup shorter, narrower, and consistent in size with the query controls.

## 0.2.0 — 2026-08-21

### Added

- Keep several Parquet files open with independent reading state and background
  operations. Open them from the dialog, recent history, file manager, or drag
  and drop; use the searchable MRU switcher below the active file name or
  keyboard shortcuts, and close the active file without losing the others.

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
