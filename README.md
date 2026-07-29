# Viewda

A free, fully offline, cross-platform Apache Parquet viewer. Double-click a file bigger
than your RAM — it opens in under a second, in an interface that belongs on
your desktop.

> **Status: pre-alpha.** Viewda is being built right now — there is nothing
> to install yet. Watch the repo to catch the first release.

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
2. **Your data never leaves your machine.** No telemetry, no third parties;
   the one background request is an identifier-free update check with an
   off switch. Anything remote happens only because you opened it.
3. **The basics are free forever.** Viewing, SQL, export, metadata — never
   behind a paywall. MIT, in the open.

## What it will do

- **Open and read everything**: any size, local or over SSH; the data and
  the file's anatomy — schema, statistics, metadata down to row groups.
- **Sort, filter and search** without writing code — and full SQL with
  history when you want it.
- **Take the data with you**: copy or export the selection, the filtered
  view or the whole file — CSV, JSON, Markdown or Parquet.
- **Withstand broken files** and help debug them: everything readable
  opens, the damage gets named.

## Under the hood

A Rust core owns the data — windowed reads, metadata, SQL (DuckDB,
arrow-rs) — and streams Arrow columns to a thin React UI on a canvas grid,
in a Tauri shell. Between them sits one transport-agnostic engine protocol:
shell, engine and UI can each be swapped without rewriting the rest.

## License

[MIT](LICENSE)
