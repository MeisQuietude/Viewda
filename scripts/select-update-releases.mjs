#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const TAG_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseVersionTag(tag) {
  if (typeof tag !== "string") {
    return null;
  }
  const match = TAG_PATTERN.exec(tag);
  if (match === null) {
    return null;
  }
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) =>
        /^\d+$/.test(identifier) && !/^(0|[1-9]\d*)$/.test(identifier),
    )
  ) {
    return null;
  }

  return {
    tag,
    text: tag.slice(1),
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) {
      return 0;
    }
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const sharedLength = Math.min(
    left.prerelease.length,
    right.prerelease.length,
  );
  for (let index = 0; index < sharedLength; index += 1) {
    const compared = compareIdentifiers(
      left.prerelease[index],
      right.prerelease[index],
    );
    if (compared !== 0) {
      return compared;
    }
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

function flattenPages(input) {
  if (!Array.isArray(input)) {
    throw new TypeError("GitHub releases must be a JSON array.");
  }
  return input.every(Array.isArray) ? input.flat() : input;
}

export function selectUpdateReleases(input) {
  const candidates = flattenPages(input).flatMap((release) => {
    if (release?.draft !== false) {
      return [];
    }
    const version = parseVersionTag(release.tag_name);
    if (version === null || !Array.isArray(release.assets)) {
      return [];
    }
    const manifest = `Viewda_${version.text}_updater.json`;
    if (!release.assets.some((asset) => asset?.name === manifest)) {
      return [];
    }
    return [{ release, version }];
  });
  const highest = (eligible) =>
    eligible.reduce(
      (selected, candidate) =>
        selected === null ||
        compareVersions(candidate.version, selected.version) > 0
          ? candidate
          : selected,
      null,
    )?.release.tag_name ?? null;

  return {
    latest: highest(candidates),
    stable: highest(
      candidates.filter(({ version }) => version.prerelease.length === 0),
    ),
  };
}

function run() {
  const channel = process.argv[2];
  if (channel !== "latest" && channel !== "stable") {
    process.stderr.write(
      "Usage: scripts/select-update-releases.mjs <latest|stable>\n",
    );
    process.exitCode = 2;
    return;
  }
  const selected = selectUpdateReleases(
    JSON.parse(fs.readFileSync(process.stdin.fd, "utf8")),
  )[channel];
  if (selected !== null) {
    process.stdout.write(selected);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
