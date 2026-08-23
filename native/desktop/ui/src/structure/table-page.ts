/** Bounded paging for the Structure tables. */

/** Rows a page is aligned to, so scrolling reuses the page it already has. */
export const STRUCTURE_PAGE_SIZE = 200;

/** Rows one request asks for. The engine refuses more than 1000. */
export const STRUCTURE_PAGE_LIMIT = 400;

/** Largest window the engine will answer in one call. */
export const STRUCTURE_PAGE_MAX = 1_000;

export interface StructurePageRequest {
  offset: number;
  limit: number;
}

/**
 * Chooses the page that covers a viewport.
 *
 * Requests snap to a page boundary and reach past the viewport, so ordinary
 * scrolling stays inside the page already held instead of asking per frame.
 */
export function pageRequestFor(
  rowStart: number,
  rowCount: number,
  totalCount: number,
): StructurePageRequest | null {
  if (totalCount <= 0 || rowCount <= 0) {
    return null;
  }
  const clampedStart = Math.min(Math.max(0, rowStart), totalCount - 1);
  const offset =
    Math.floor(clampedStart / STRUCTURE_PAGE_SIZE) * STRUCTURE_PAGE_SIZE;
  const needed = Math.max(0, rowStart + rowCount - offset);
  const limit = Math.min(
    STRUCTURE_PAGE_MAX,
    Math.max(STRUCTURE_PAGE_LIMIT, needed),
  );
  return { offset, limit };
}

/** Reports whether a held page already answers every row of a viewport. */
export function pageCovers(
  page: { offset: number; length: number; totalCount: number } | null,
  rowStart: number,
  rowCount: number,
): boolean {
  if (page === null || rowCount <= 0) {
    return page !== null;
  }
  const end = Math.min(rowStart + rowCount, page.totalCount);
  return rowStart >= page.offset && end <= page.offset + page.length;
}
