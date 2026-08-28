import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ColumnPicker, type ColumnPickerColumn } from "./ColumnPicker";

const columns: ColumnPickerColumn[] = [
  {
    id: "profile",
    name: "profile",
    type: "GROUP",
    depth: 0,
    selection: "partial",
    exact: false,
    pinned: false,
    ancestorIds: [],
  },
  {
    id: "city",
    name: "profile.city",
    type: "String",
    depth: 1,
    selection: "all",
    exact: true,
    pinned: true,
    ancestorIds: ["profile"],
  },
  {
    id: "address",
    name: "profile.address",
    type: "GROUP",
    depth: 1,
    selection: "none",
    exact: false,
    pinned: false,
    ancestorIds: ["profile"],
  },
  {
    id: "postal",
    name: "profile.address.postal_code",
    type: "Int32",
    depth: 2,
    selection: "none",
    exact: false,
    pinned: false,
    ancestorIds: ["profile", "address"],
  },
  {
    id: "items-element",
    name: "items.element.sku",
    type: "String",
    depth: 2,
    selection: "none",
    exact: false,
    pinned: false,
    ancestorIds: ["items", "items-element"],
    disabledReason: "Fields inside a list or map cannot be used as columns.",
  },
  {
    id: "tail",
    name: "tail",
    type: "Boolean",
    depth: 0,
    selection: "none",
    exact: false,
    pinned: false,
    ancestorIds: [],
  },
];

afterEach(cleanup);

describe("ColumnPicker", () => {
  it("renders partial subtrees and keeps unavailable-field reasons visible", () => {
    renderPicker();

    const profile = screen.getByRole("checkbox", {
      name: "Project profile",
    }) as HTMLInputElement;
    expect(profile).not.toBeChecked();
    expect(profile.indeterminate).toBe(true);
    expect(
      screen.getByRole("checkbox", { name: "Project profile.city" }),
    ).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Unpin profile.city" }),
    ).toHaveAttribute("aria-pressed", "true");

    const unavailable = screen.getByRole("checkbox", {
      name: "Project items.element.sku",
    });
    expect(unavailable).toBeDisabled();
    expect(unavailable.closest(".column-picker-row")).toHaveTextContent(
      "Fields inside a list or map cannot be used as columns.",
    );
  });

  it("removes non-empty subtrees and adds empty subtrees in one click", () => {
    const onToggle = vi.fn();
    renderPicker(columns, onToggle);

    fireEvent.click(screen.getByRole("checkbox", { name: "Project profile" }));
    expect(onToggle).toHaveBeenLastCalledWith("profile", false);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Project profile.address" }),
    );
    expect(onToggle).toHaveBeenLastCalledWith("address", true);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Project profile.city" }),
    );
    expect(onToggle).toHaveBeenLastCalledWith("city", false);
  });

  it("uses compact virtual rows without hiding disabled reasons", () => {
    renderPicker();

    const firstRow = screen
      .getByRole("checkbox", { name: "Project profile" })
      .closest(".column-picker-row");
    const secondRow = screen
      .getByRole("checkbox", { name: "Project profile.city" })
      .closest(".column-picker-row");
    expect(firstRow).toHaveStyle({ height: "36px" });
    expect(secondRow).toHaveStyle({ transform: "translateY(36px)" });
    expect(
      screen
        .getByRole("checkbox", { name: "Project items.element.sku" })
        .closest(".column-picker-row"),
    ).toHaveTextContent(
      "Fields inside a list or map cannot be used as columns.",
    );
  });

  it("keeps matching ancestors while filtering the schema tree", () => {
    renderPicker();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "postal" },
    });

    expect(
      screen.getByRole("checkbox", { name: "Project profile" }),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", {
        name: "Project profile.address",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("checkbox", {
        name: "Project profile.address.postal_code",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("checkbox", { name: "Project profile.city" }),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("3 matching fields");
  });

  it("skips unavailable rows with ArrowUp and ArrowDown", () => {
    renderPicker();

    const postal = screen.getByRole("checkbox", {
      name: "Project profile.address.postal_code",
    });
    const tail = screen.getByRole("checkbox", { name: "Project tail" });
    postal.focus();
    fireEvent.keyDown(postal, { key: "ArrowDown" });
    expect(tail).toHaveFocus();
    fireEvent.keyDown(tail, { key: "ArrowUp" });
    expect(postal).toHaveFocus();
  });

  it("keeps a long path leaf visible and isolates bidi controls", () => {
    const control = "\u202e";
    renderPicker([
      {
        ...columns[3]!,
        id: "long-path",
        name: `profile.${"ancestor.".repeat(12)}${control}.postal_code`,
        namePrefix: `profile.${"ancestor.".repeat(12)}${control}.`,
        nameLeaf: "postal_code",
      },
    ]);

    const row = screen
      .getByRole("checkbox", { name: /Project profile/ })
      .closest(".column-picker-row");
    expect(row?.querySelector(".column-picker-prefix")).toBeInTheDocument();
    expect(row?.querySelector(".column-picker-leaf")).toHaveTextContent(
      "postal_code",
    );
    expect(
      row?.querySelector(".viewda-grid-header-bidi-control"),
    ).toHaveTextContent(control);
    expect(row?.querySelector(".column-picker-name")).not.toHaveAttribute(
      "title",
    );
  });
});

function renderPicker(pickerColumns = columns, onToggle = vi.fn()) {
  return render(
    <ColumnPicker
      columns={pickerColumns}
      projectedCount={1}
      onHideAll={vi.fn()}
      onShowAll={vi.fn()}
      onToggle={onToggle}
      onTogglePinned={vi.fn()}
    />,
  );
}
