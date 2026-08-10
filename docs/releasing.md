# Releasing

For maintainers: the steps need push access to `main` and the repository
signing secrets.

Prepare and verify the version on a branch:

```sh
scripts/release.sh prepare 1.2.3
# Move Unreleased entries under a dated version heading.
scripts/run.sh check
```

Commit the version and changelog together. After that commit reaches `main`,
create and push a signed annotated tag:

```sh
git tag --sign --annotate v1.2.3 --message "Viewda 1.2.3"
git push origin v1.2.3
```

The tag workflow requires a GitHub-verified tag on `main` and the
`TAURI_SIGNING_PRIVATE_KEY` repository secret. It builds and verifies every
installer, embeds update signatures in the updater manifest, and creates a
draft release. Smoke-test its assets on physical target machines before
publishing it. Publishing refreshes the Stable and Latest update channels on
GitHub Pages.

## Prereleases

Alpha and beta versions ship through the same steps with a prerelease
version such as `1.2.3-beta.1`. Keep the GitHub Release marked as a
pre-release: the Latest update channel serves it, Stable ignores it. A
version enters beta when its scope is complete; from then on it takes
fixes and polish only.

Release notes follow the reader:

- A prerelease section in `CHANGELOG.md` describes the delta from the
  previous release, prerelease or not. Its readers follow the Latest
  channel and already have everything older.
- When the stable version ships, fold its prerelease sections into the
  stable section: one delta from the previous stable release, with
  intermediate states collapsed — an entry added in one prerelease and
  fixed in another appears once, finished. The step-by-step history
  stays frozen in each prerelease's GitHub Release notes.
- The first stable release has nothing earlier to diff against: its
  notes describe everything the app does, written for a first install.

## What CI produces

CI verifies native Linux x64 AppImage and Debian packages, macOS Apple silicon
and Intel installers, Universal macOS, and Windows x64. Each directly
installable format has its own Actions archive with the full commit SHA.
Updater companions are archived only for release tags; release files use the
release version instead.
