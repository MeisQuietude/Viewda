# Viewda

A free, offline, cross-platform Apache Parquet viewer. Tauri shell, Rust
core (DuckDB, arrow-rs), React UI on a canvas grid.

Rules that apply to every task:

- English only: code, comments, commits, docs.
- Speed first: know the performance cost of every change and surface it.
- No network, no telemetry. The sole exception is the built-in update check.
- The UI never touches data or files. Everything goes through the Rust
  core's engine protocol; data crosses as Arrow columns.
- Layers stay swappable: third-party UI dependencies live behind adapters.

Git:

- Trunk-based: `main` stays green; work in short-lived branches
  (`type/topic`) merged by PR.
- Conventional Commits (`feat:`, `fix:`, `docs:`, …); imperative subject,
  body only when the diff can't speak for itself.
- Atomic commits: one logical change each.
- User-facing changes get a plain-language entry in `## Unreleased` of
  `CHANGELOG.md` — same commit as the change.
