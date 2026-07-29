import assert from "node:assert/strict";
import test from "node:test";

import { selectUpdateReleases } from "./select-update-releases.mjs";

function release(tag, { draft = false, manifest = true } = {}) {
  const version = tag.slice(1);
  return {
    tag_name: tag,
    draft,
    assets: manifest ? [{ name: `Viewda_${version}_updater.json` }] : [],
  };
}

test("channels follow SemVer rather than GitHub creation order", () => {
  const selected = selectUpdateReleases([
    [release("v0.1.1"), release("v0.2.0-alpha.3")],
    [release("v0.1.0")],
  ]);

  assert.deepEqual(selected, {
    latest: "v0.2.0-alpha.3",
    stable: "v0.1.1",
  });
});

test("draft, malformed, and manifest-less releases cannot freeze channels", () => {
  const selected = selectUpdateReleases([
    release("v0.3.0-alpha.1", { manifest: false }),
    release("v0.2.0", { draft: true }),
    release("v0.1.2", { manifest: false }),
    release("v0.2.0-alpha.3"),
    release("v0.1.1"),
    release("not-semver"),
  ]);

  assert.deepEqual(selected, {
    latest: "v0.2.0-alpha.3",
    stable: "v0.1.1",
  });
});

test("SemVer prerelease precedence handles numeric and lexical identifiers", () => {
  const selected = selectUpdateReleases([
    release("v1.0.0-alpha"),
    release("v1.0.0-alpha.1"),
    release("v1.0.0-alpha.beta"),
    release("v1.0.0-beta.2"),
    release("v1.0.0-beta.11"),
    release("v1.0.0-rc.1"),
  ]);

  assert.equal(selected.latest, "v1.0.0-rc.1");
  assert.equal(selected.stable, null);
});
