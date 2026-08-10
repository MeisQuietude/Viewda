# Contributing to Viewda

Bug reports and ideas are welcome at any time. Code is welcome once the
change is agreed in an issue: what Viewda does and how it is built are
deliberate choices, so a pull request that arrives without a discussed
issue may be closed even when the code is good.

Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting a bug

Open a [bug report](https://github.com/MeisQuietude/Viewda/issues/new?template=bug_report.yml).
The version is in Settings → Version; the file that triggered the bug
matters as much as the steps, so describe its size and shape even if you
cannot share it.

Never report a security vulnerability in a public issue. Use the process in
[SECURITY.md](SECURITY.md) instead.

## Proposing a feature

Open a [feature request](https://github.com/MeisQuietude/Viewda/issues/new?template=feature_request.yml)
describing what you are trying to do with a Parquet file and why the app
gets in the way today. A described problem survives a change of design; a
described solution often doesn't.

Two answers are common and neither means the idea is bad: it costs
responsiveness, or it belongs to a later stage of the roadmap.

## Setting up

Install [rustup](https://rustup.rs/). On Linux, install the native
dependencies first:

```sh
scripts/install-tauri-deps.sh # Linux only
scripts/run.sh setup
scripts/run.sh check
```

Windows development uses Git Bash and requires the
[Microsoft C++ Build Tools and WebView2](https://v2.tauri.app/start/prerequisites/#windows).

`scripts/run.sh check` is the canonical gate: CI runs the same one, so a green
run locally means a green run there. Other commands are `test`, `fmt`, `dev`,
`bundle` and `doctor`; `check-native` runs the host-specific Rust gate used by
macOS and Windows CI. An optional Justfile exposes the same names. The scripts
provision pinned Node.js and DuckDB dependencies, while rustup reads the pinned
toolchain from `native/rust-toolchain.toml`.

## Working on code

- Branch off `main` as `type/topic`, matching the Conventional Commits type
  of the work (`feat/column-picker`, `fix/appimage-launch`).
- Keep commits atomic and their subjects in the imperative
  ([Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)).
- Run `scripts/run.sh check` before pushing.
- Describe user-visible changes in `## Unreleased` of `CHANGELOG.md` in the
  same commit, in the words a user would recognize.
- Add or update tests with the behavior they protect.
- Write everything in English: code, comments, commits and docs.
- Say what the change costs in speed when it touches reading, rendering or
  querying. Viewda trades features for responsiveness, not the other way
  around.

Open the pull request against `main` and fill in the template. By
contributing you agree that your work is licensed under the
[Apache License 2.0](../LICENSE), like the rest of the project.

Leave the version number alone: your entry stays under `## Unreleased` until
the maintainer cuts a release, following
[docs/releasing.md](../docs/releasing.md).
