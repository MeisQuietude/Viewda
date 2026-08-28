import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ColumnPicker } from "./ColumnPicker";

describe("ColumnPicker", () => {
  it("keeps the leaf visible for path titles and plain-name ellipsis separate", () => {
    render(
      <ColumnPicker
        columns={[
          {
            id: "nested",
            name: 'profile."weird name".leaf',
            titlePrefix: 'profile."weird name".',
            titleLeaf: "leaf",
            type: "Int64",
            visible: true,
            pinned: false,
          },
          {
            id: "plain",
            name: "ordinary_very_long_column_name",
            type: "Utf8",
            visible: true,
            pinned: false,
          },
        ]}
        onHideAll={vi.fn()}
        onShowAll={vi.fn()}
        onToggle={vi.fn()}
        onTogglePinned={vi.fn()}
      />,
    );

    const nestedRow = screen
      .getByRole("checkbox", { name: 'Show profile."weird name".leaf' })
      .closest(".column-picker-row");
    const nestedName = nestedRow?.querySelector(".column-picker-name");
    expect(nestedName).toHaveClass("is-path");
    expect(nestedName?.textContent).toBe('profile."weird name".leaf');
    expect(
      nestedName?.querySelector(".viewda-grid-header-prefix-content"),
    ).toHaveTextContent('profile."weird name"');
    expect(
      nestedName?.querySelector(".viewda-grid-header-prefix-separator"),
    ).toHaveTextContent(".");
    expect(
      nestedName?.querySelector(".viewda-grid-header-leaf"),
    ).toHaveTextContent("leaf");

    const plainRow = screen
      .getByRole("checkbox", { name: "Show ordinary_very_long_column_name" })
      .closest(".column-picker-row");
    expect(plainRow?.querySelector(".column-picker-name")).toHaveClass(
      "is-plain",
    );
  });
});
