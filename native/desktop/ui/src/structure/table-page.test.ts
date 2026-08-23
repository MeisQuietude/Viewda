import { describe, expect, it } from "vitest";

import {
  pageCovers,
  pageRequestFor,
  STRUCTURE_PAGE_LIMIT,
  STRUCTURE_PAGE_MAX,
  STRUCTURE_PAGE_SIZE,
} from "./table-page";

describe("pageRequestFor", () => {
  it("snaps a viewport to the page boundary below it", () => {
    expect(pageRequestFor(0, 40, 10_000)).toEqual({
      offset: 0,
      limit: STRUCTURE_PAGE_LIMIT,
    });
    expect(pageRequestFor(STRUCTURE_PAGE_SIZE - 1, 40, 10_000)).toEqual({
      offset: 0,
      limit: STRUCTURE_PAGE_LIMIT,
    });
    expect(pageRequestFor(STRUCTURE_PAGE_SIZE, 40, 10_000)).toEqual({
      offset: STRUCTURE_PAGE_SIZE,
      limit: STRUCTURE_PAGE_LIMIT,
    });
  });

  it("keeps a request inside the window the engine answers", () => {
    const request = pageRequestFor(0, 5_000, 100_000);

    expect(request).toEqual({ offset: 0, limit: STRUCTURE_PAGE_MAX });
  });

  it("clamps a viewport that starts past the last row", () => {
    expect(pageRequestFor(9_999, 40, 300)).toEqual({
      offset: 200,
      limit: STRUCTURE_PAGE_MAX,
    });
  });

  it("asks for nothing when there is nothing to show", () => {
    expect(pageRequestFor(0, 40, 0)).toBeNull();
    expect(pageRequestFor(0, 0, 10)).toBeNull();
  });
});

describe("pageCovers", () => {
  const page = { offset: 200, length: 400, totalCount: 10_000 };

  it("accepts a viewport inside the held page", () => {
    expect(pageCovers(page, 200, 40)).toBe(true);
    expect(pageCovers(page, 560, 40)).toBe(true);
  });

  it("rejects a viewport that leaves the held page", () => {
    expect(pageCovers(page, 199, 40)).toBe(false);
    expect(pageCovers(page, 580, 40)).toBe(false);
    expect(pageCovers(null, 0, 40)).toBe(false);
  });

  it("stops asking for rows the table does not have", () => {
    const tail = { offset: 200, length: 100, totalCount: 300 };

    expect(pageCovers(tail, 280, 40)).toBe(true);
  });
});
