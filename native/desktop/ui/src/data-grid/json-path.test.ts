import { describe, expect, it } from "vitest";

import {
  formatJsonFieldTarget,
  formatJsonPath,
  jsonPathIsValid,
  JSON_PATH_BYTE_LIMIT,
  parseJsonPath,
} from "./json-path";

describe("JSON path grammar", () => {
  it("round-trips quoted object keys and array indices", () => {
    const text = 'items[2]."unit.price"."quote""key"';
    const parsed = parseJsonPath(text);

    expect(parsed).toEqual({
      path: [
        { field: "items" },
        { index: 2 },
        { field: "unit.price" },
        { field: 'quote"key' },
      ],
      error: null,
    });
    if (parsed.path !== null) {
      expect(formatJsonPath(parsed.path)).toBe(text);
      expect(formatJsonFieldTarget(["payload"], parsed.path)).toBe(
        `payload.${text}`,
      );
    }
  });

  it("keeps a root array index distinct from an object key", () => {
    const parsed = parseJsonPath('[0]."0"');

    expect(parsed).toEqual({
      path: [{ index: 0 }, { field: "0" }],
      error: null,
    });
    if (parsed.path !== null) {
      expect(formatJsonFieldTarget(["payload"], parsed.path)).toBe(
        "payload[0].0",
      );
    }
  });

  it("counts the maximum u32 index by its exact decimal byte length", () => {
    const maximumIndex = 4_294_967_295;

    expect(parseJsonPath(`[${maximumIndex}]`)).toEqual({
      path: [{ index: maximumIndex }],
      error: null,
    });
    expect(
      jsonPathIsValid([
        { field: "x".repeat(JSON_PATH_BYTE_LIMIT - 10) },
        { index: maximumIndex },
      ]),
    ).toBe(true);
    expect(
      jsonPathIsValid([
        { field: "x".repeat(JSON_PATH_BYTE_LIMIT - 9) },
        { index: maximumIndex },
      ]),
    ).toBe(false);
    expect(parseJsonPath("[4294967296]").path).toBeNull();
  });

  it.each([
    "",
    "items.",
    ".items",
    "items[-1]",
    "items[01]",
    'items["0"]',
    "items.unit price",
    'items."unterminated',
  ])("rejects the ambiguous manual path %j", (path) => {
    expect(parseJsonPath(path).path).toBeNull();
  });
});
