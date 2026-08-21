import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { binary, int64, list, struct, utf8 } from "@uwdata/flechette";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ValueTree } from "./ValueTree";
import { typedValue } from "./value-format";

afterEach(cleanup);

describe("ValueTree", () => {
  it("navigates, expands, and copies node JSON and quoted paths", () => {
    const onCopy = vi.fn();
    render(
      <ValueTree
        label="profile"
        value={typedValue(
          { addr: { "weird name": ["a", "b", "c", "d"] } },
          struct({ addr: struct({ "weird name": list(utf8()) }) }),
        )}
        onCopy={onCopy}
      />,
    );
    const tree = screen.getByRole("tree", { name: "profile value" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });

    fireEvent.keyDown(tree, { key: "c", ctrlKey: true, altKey: true });
    expect(onCopy).toHaveBeenLastCalledWith('addr."weird name"[3]');
    fireEvent.keyDown(tree, { key: "c", ctrlKey: true });
    expect(onCopy).toHaveBeenLastCalledWith('"d"');
  });

  it("expands a 100k-element list without materializing all rows", () => {
    let valueReads = 0;
    const values = new Proxy(
      { length: 100_000 } as { length: number } & Record<number, bigint>,
      {
        has: (_target, property) =>
          property === "length" || Number.isInteger(Number(property)),
        get: (target, property) => {
          if (property === "length") return target.length;
          valueReads += 1;
          return BigInt(Number(property));
        },
      },
    );
    render(
      <ValueTree
        label="values"
        value={typedValue(values, list(int64()))}
        onCopy={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("treeitem").length).toBeLessThan(30);
    expect(valueReads).toBeLessThan(50);
    expect(
      screen
        .getByRole("tree", { name: "values value" })
        .getAttribute("aria-activedescendant"),
    ).toMatch(/-value-tree-row-root$/);
  });

  it("keeps the active descendant mounted after manual scroll", () => {
    const values = Array.from({ length: 100_000 }, (_value, index) =>
      BigInt(index),
    );
    render(
      <ValueTree
        label="values"
        value={typedValue(values, list(int64()))}
        onCopy={vi.fn()}
      />,
    );
    const tree = screen.getByRole("tree", { name: "values value" });
    const activeId = tree.getAttribute("aria-activedescendant");

    fireEvent.scroll(tree, { target: { scrollTop: 1_000_000 } });

    expect(document.getElementById(activeId!)).not.toBeNull();
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(30);
  });

  it("uses unique active descendant ids across reusable tree instances", () => {
    render(
      <>
        <ValueTree
          label="first"
          value={typedValue([1n], list(int64()))}
          onCopy={vi.fn()}
        />
        <ValueTree
          label="second"
          value={typedValue([2n], list(int64()))}
          onCopy={vi.fn()}
        />
      </>,
    );
    const ids = screen
      .getAllByRole("tree")
      .map((tree) => tree.getAttribute("aria-activedescendant"));
    expect(ids[0]).not.toBe(ids[1]);
    expect(document.getElementById(ids[0]!)).not.toBeNull();
    expect(document.getElementById(ids[1]!)).not.toBeNull();
  });

  it("windows a multi-megabyte binary without formatting every row", () => {
    const bytes = new Uint8Array(4 * 1024 * 1024);
    bytes.set([65, 0, 255]);
    const subarray = vi.spyOn(bytes, "subarray");
    render(
      <ValueTree
        label="payload"
        value={typedValue(bytes, binary())}
        onCopy={vi.fn()}
      />,
    );

    expect(
      screen.getByText("binary · 4.2 MB", {
        selector: ".value-peek-binary-summary",
      }),
    ).toBeInTheDocument();
    const hexDump = screen.getByRole("region", { name: "payload hex dump" });
    expect(hexDump.querySelectorAll(".value-peek-binary-row")).toHaveLength(10);
    expect(hexDump).not.toHaveTextContent("003ffff0");
    expect(subarray.mock.calls.length).toBeLessThan(20);
    expect(
      subarray.mock.calls.every(([start, end]) => end! - start! <= 16),
    ).toBe(true);
  });

  it("renders a null binary as null rather than an empty hex dump", () => {
    render(
      <ValueTree
        label="payload"
        value={typedValue(null, binary())}
        onCopy={vi.fn()}
      />,
    );
    expect(screen.getByText("null", { selector: "pre" })).toBeInTheDocument();
  });
});
