import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SchemaTreeNode } from "./SchemaTree";

afterEach(cleanup);

describe("SchemaTreeNode", () => {
  it("addresses nested leaves in Parquet depth-first order", () => {
    const select = vi.fn();
    render(
      <ul>
        <SchemaTreeNode
          leafOffset={4}
          selectedLeaf={5}
          onSelectLeaf={select}
          field={{
            name: "record",
            physicalType: "GROUP",
            logicalType: null,
            children: [
              {
                name: "id",
                physicalType: "INT64",
                logicalType: null,
                children: [],
              },
              {
                name: "nested",
                physicalType: "GROUP",
                logicalType: null,
                children: [
                  {
                    name: "value",
                    physicalType: "BYTE_ARRAY",
                    logicalType: "String",
                    children: [],
                  },
                ],
              },
            ],
          }}
        />
      </ul>,
    );

    expect(screen.getByRole("button", { name: /value/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /id/ }));
    fireEvent.click(screen.getByRole("button", { name: /value/ }));

    expect(select.mock.calls).toEqual([[4], [5]]);
    expect(
      screen.queryByRole("button", { name: /record/ }),
    ).not.toBeInTheDocument();
  });
});
