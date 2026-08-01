import { describe, expect, it } from "vitest";

import { copyRowLimit } from "./copy-limit";

describe("copyRowLimit", () => {
  it("caps narrow selections by rows", () => {
    expect(copyRowLimit(1)).toBe(10_000);
  });

  it("tightens the row cap for wide selections", () => {
    expect(copyRowLimit(100)).toBe(2_500);
    expect(copyRowLimit(10_000)).toBe(25);
  });
});
