import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  binary,
  int64,
  list,
  struct,
  tableFromArrays,
  tableToIPC,
  utf8,
  type DataType,
} from "@uwdata/flechette";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";

import { ValueTree } from "./ValueTree";
import { arrowTypedValue, rawJsonValue, typedValue } from "./value-format";
import { decodeArrowWindow, windowArrowValue } from "./arrow-window";
import { VALUE_COPY_CHARACTER_LIMIT } from "./value-json-serializer";
import { ChunkedJsonSource, JSON_NODE_METADATA_LIMIT } from "./json-value";
import { formatJsonFieldTarget, JSON_PATH_BYTE_LIMIT } from "./json-path";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ValueTree", () => {
  it("derives deterministic rows under StrictMode rerenders", () => {
    const value = typedValue(
      { first: { leaf: 1n }, second: 2n },
      struct({ first: struct({ leaf: int64() }), second: int64() }),
    );
    const { rerender } = render(
      <StrictMode>
        <ValueTree label="record" value={value} onCopy={vi.fn()} />
      </StrictMode>,
    );
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent(
      "first",
    );

    rerender(
      <StrictMode>
        <ValueTree label="record" value={value} onCopy={vi.fn()} />
      </StrictMode>,
    );

    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent(
      "first",
    );
    expect(
      screen.getByRole("tree").getAttribute("aria-activedescendant"),
    ).toMatch(/root-0$/);
  });

  it("navigates, expands, and copies node JSON", async () => {
    vi.useFakeTimers();
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

    fireEvent.keyDown(tree, { key: "c", ctrlKey: true });
    await act(async () => vi.runAllTimersAsync());
    expect(onCopy).toHaveBeenLastCalledWith('"d"');
  });

  it("copies the structured column path through the active nested value", async () => {
    const onCopy = vi.fn();
    render(
      <ValueTree
        label="profile"
        fieldPath={["profile", "root.name"]}
        value={typedValue(
          { addr: { "weird name": ["first"] } },
          struct({ addr: struct({ "weird name": list(utf8()) }) }),
        )}
        onCopy={onCopy}
      />,
    );
    const tree = screen.getByRole("tree", { name: "profile value" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });

    fireEvent.keyDown(tree, { key: "c", ctrlKey: true, shiftKey: true });
    await act(async () => Promise.resolve());

    expect(onCopy).toHaveBeenCalledWith(
      'profile."root.name".addr."weird name"[0]',
    );
  });

  it("opens active-node actions from the keyboard and ignores Shift+C", () => {
    const onCopy = vi.fn();
    render(
      <ValueTree
        label="profile"
        fieldPath={["profile"]}
        value={typedValue({ name: "Ada" }, struct({ name: utf8() }))}
        onCopy={onCopy}
      />,
    );
    const tree = screen.getByRole("tree", { name: "profile value" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    const activeId = tree.getAttribute("aria-activedescendant");

    fireEvent.keyDown(tree, { key: "c", shiftKey: true });
    expect(onCopy).not.toHaveBeenCalled();
    expect(tree).toHaveAttribute("aria-activedescendant", activeId);

    fireEvent.keyDown(tree, { key: "F10", shiftKey: true });
    expect(
      screen.getByRole("menu", { name: "name value actions" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Copy content" }),
    ).toHaveFocus();
  });

  it("leaves the path shortcut unhandled when path actions are unavailable", () => {
    const onCopy = vi.fn();
    render(
      <ValueTree
        label="profile"
        value={typedValue("Ada", utf8())}
        onCopy={onCopy}
      />,
    );
    const tree = screen.getByRole("tree", { name: "profile value" });

    expect(
      fireEvent.keyDown(tree, {
        key: "c",
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toBe(true);
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("keeps an all-disabled context menu keyboard-contained", () => {
    vi.useFakeTimers();
    render(
      <ValueTree
        label="payload"
        value={typedValue("x".repeat(8 * 1024 * 1024), utf8())}
        onCopy={vi.fn()}
      />,
    );
    const tree = screen.getByRole("tree", { name: "payload value" });
    fireEvent.keyDown(tree, { key: "c", ctrlKey: true });
    fireEvent.keyDown(tree, { key: "F10", shiftKey: true });

    const menu = screen.getByRole("menu", { name: "payload value actions" });
    expect(menu).toHaveFocus();
    expect(
      screen.getByRole("menuitem", { name: "Copy content" }),
    ).toBeDisabled();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(tree).toHaveFocus();
  });

  it("promotes active struct and leaf fields with their column paths", () => {
    const onPromoteField = vi.fn();
    render(
      <ValueTree
        label="profile"
        fieldPath={["profile"]}
        value={typedValue(
          { address: { city: "Utrecht" }, name: "Ada" },
          struct({ address: struct({ city: utf8() }), name: utf8() }),
        )}
        onPromoteField={onPromoteField}
        onCopy={vi.fn()}
      />,
    );
    const tree = screen.getByRole("tree", { name: "profile value" });
    fireEvent.keyDown(tree, {
      key: "ArrowDown",
    });
    const actionGroups = document.querySelectorAll(
      ".value-tree-toolbar-actions > .value-tree-toolbar-action-group",
    );
    expect(actionGroups).toHaveLength(1);
    expect(actionGroups[0]?.querySelectorAll("button")).toHaveLength(2);
    fireEvent.contextMenu(screen.getByRole("treeitem", { selected: true }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Promote to column" }),
    );

    expect(onPromoteField).toHaveBeenNthCalledWith(1, ["profile", "address"]);

    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.contextMenu(screen.getByRole("treeitem", { selected: true }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Promote to column" }),
    );

    expect(onPromoteField).toHaveBeenNthCalledWith(2, [
      "profile",
      "address",
      "city",
    ]);
  });

  it("filters and copies an exact JSON path without using bounded labels", async () => {
    vi.useFakeTimers();
    const longKey = `prefix.${"x".repeat(180)}"quoted`;
    const path = [
      { field: longKey },
      { index: 0 },
      { field: "unit.price" },
    ] as const;
    const onFilterJsonField = vi.fn();
    const onCopy = vi.fn();
    render(
      <ValueTree
        label="payload"
        fieldPath={["payload"]}
        value={typedValue(
          JSON.stringify({ [longKey]: [{ "unit.price": 12 }] }),
          utf8(),
          "JSON",
        )}
        onFilterJsonField={onFilterJsonField}
        onPromoteField={vi.fn()}
        onCopy={onCopy}
      />,
    );
    await act(async () => vi.runAllTimersAsync());

    const tree = screen.getByRole("tree", { name: "payload value" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    for (let step = 0; step < 4; step += 1) {
      fireEvent.keyDown(tree, { key: "ArrowRight" });
    }
    fireEvent.contextMenu(screen.getByRole("treeitem", { selected: true }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Filter by this field" }),
    );

    expect(onFilterJsonField).toHaveBeenCalledWith({
      path,
      valueType: "number",
    });
    fireEvent.contextMenu(screen.getByRole("treeitem", { selected: true }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
    await act(async () => Promise.resolve());
    expect(onCopy).toHaveBeenCalledWith(
      formatJsonFieldTarget(["payload"], path),
    );
    vi.useRealTimers();
  });

  it("copies a safe exact path beyond the wire limit without invisible bidi controls", async () => {
    vi.useFakeTimers();
    const onFilterJsonField = vi.fn();
    const onCopy = vi.fn();
    const oversizedKey = `${"x".repeat(JSON_PATH_BYTE_LIMIT + 1)}\u202etrail`;
    render(
      <ValueTree
        label="payload"
        fieldPath={["payload"]}
        value={typedValue(
          JSON.stringify({ [oversizedKey]: 12 }),
          utf8(),
          "JSON",
        )}
        onFilterJsonField={onFilterJsonField}
        onCopy={onCopy}
      />,
    );
    await act(async () => vi.runAllTimersAsync());

    const tree = screen.getByRole("tree", { name: "payload value" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });

    fireEvent.contextMenu(screen.getByRole("treeitem", { selected: true }));
    expect(
      screen.queryByRole("menuitem", { name: "Filter by this field" }),
    ).toBeNull();
    const copyPath = screen.getByRole("menuitem", { name: "Copy path" });
    expect(copyPath).toBeEnabled();
    fireEvent.click(copyPath);
    await act(async () => Promise.resolve());
    expect(onFilterJsonField).not.toHaveBeenCalled();
    expect(onCopy).toHaveBeenCalledOnce();
    const copied = onCopy.mock.calls[0]?.[0] as string;
    expect(copied).not.toContain("\u202e");
    expect(copied).toContain("\\u202e");
    expect(copied).toBe(
      formatJsonFieldTarget(["payload"], [{ field: oversizedKey }]),
    );
  });

  it("caps the final copied path after escaping expands object keys", async () => {
    vi.useFakeTimers();
    const renderKey = async (key: string, onCopy: (text: string) => void) => {
      render(
        <ValueTree
          label="payload"
          fieldPath={["payload"]}
          value={typedValue(JSON.stringify({ [key]: 12 }), utf8(), "JSON")}
          onCopy={onCopy}
        />,
      );
      await act(async () => vi.runAllTimersAsync());
      fireEvent.keyDown(screen.getByRole("tree", { name: "payload value" }), {
        key: "ArrowDown",
      });
      fireEvent.contextMenu(screen.getByRole("treeitem", { selected: true }));
      return screen.getByRole("menuitem", { name: "Copy path" });
    };

    const fittingKey = "\\\u202e".repeat(8_190);
    const fittingCopy = vi.fn();
    const fittingButton = await renderKey(fittingKey, fittingCopy);
    expect(fittingButton).toBeEnabled();
    fireEvent.click(fittingButton);
    await act(async () => Promise.resolve());
    const copied = fittingCopy.mock.calls[0]?.[0] as string;
    expect(copied).toHaveLength(65_530);
    expect(copied).not.toContain("\u202e");
    expect(copied).toBe(
      formatJsonFieldTarget(["payload"], [{ field: fittingKey }]),
    );

    cleanup();
    const oversizedCopy = vi.fn();
    const oversizedButton = await renderKey(
      "\\\u202e".repeat(8_191),
      oversizedCopy,
    );
    expect(oversizedButton).toBeDisabled();
    fireEvent.click(oversizedButton);
    expect(oversizedCopy).not.toHaveBeenCalled();
  });

  it("renders an empty field name explicitly", () => {
    render(
      <ValueTree
        label="union_value"
        value={typedValue({ "": 1n }, struct({ "": int64() }))}
        onCopy={vi.fn()}
      />,
    );
    expect(
      screen.getByText('[""]', { selector: ".value-tree-name" }),
    ).toBeVisible();
  });

  it("chunks a large copy and cancels it when Peek switches values", async () => {
    vi.useFakeTimers();
    const onCopy = vi.fn();
    const view = render(
      <ValueTree
        label="payload"
        value={typedValue("x".repeat(8 * 1024 * 1024), utf8())}
        onCopy={onCopy}
      />,
    );
    fireEvent.keyDown(screen.getByRole("tree"), {
      key: "c",
      ctrlKey: true,
    });

    expect(screen.getByText("Preparing content for copy…")).toBeInTheDocument();
    expect(onCopy).not.toHaveBeenCalled();
    view.rerender(
      <ValueTree
        label="payload"
        value={typedValue("next", utf8())}
        onCopy={onCopy}
      />,
    );
    await act(async () => vi.runAllTimersAsync());

    expect(onCopy).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Preparing content for copy…"),
    ).not.toBeInTheDocument();
  });

  it("does not cut the 8,192-character detail inside an astral code point", () => {
    const { container } = render(
      <ValueTree
        label="text"
        value={typedValue(`${"a".repeat(8_191)}😀tail`, utf8())}
        onCopy={vi.fn()}
      />,
    );

    const preview = container.querySelector("pre")?.textContent ?? "";
    expect(preview.endsWith("…")).toBe(true);
    expect(preview).not.toContain("\ud83d");
    expect(preview).not.toContain("�");
  });

  it("uses rope lookahead without filling a removed high-surrogate slot", () => {
    const source = new ChunkedJsonSource();
    source.append(`${"a".repeat(8_191)}\ud83d`);
    source.append("\ude00following");
    const { container } = render(
      <ValueTree
        label="text"
        value={rawJsonValue(source, utf8())}
        onCopy={vi.fn()}
      />,
    );

    const preview = container.querySelector("pre")?.textContent ?? "";
    expect(preview).toBe(`${"a".repeat(8_191)}…`);
    expect(preview).not.toContain("😀");
    expect(preview).not.toContain("following");
  });

  it("keeps Arrow detail sampling fixed after an astral preview boundary", async () => {
    vi.useFakeTimers();
    const text = `${"a".repeat(8_191)}😀following-${"x".repeat(20_000)}`;
    const bytes = tableToIPC(
      tableFromArrays({ text: [text] }, { types: { text: utf8() } }),
      { format: "stream" },
    );
    const fieldPath = ["text"];
    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [
      fieldPath,
    ]);
    const { container } = render(
      <ValueTree
        label="text"
        value={arrowTypedValue(windowArrowValue(window, fieldPath, 0)!)}
        onCopy={vi.fn()}
      />,
    );

    await act(async () => vi.runAllTimersAsync());
    const preview = container.querySelector("pre")?.textContent ?? "";
    expect(preview).toBe(`${"a".repeat(8_191)}…`);
    expect(preview).not.toContain("😀");
    expect(preview).not.toContain("following");
  });

  it("cancels an earlier copy before a new node copy can finish", async () => {
    vi.useFakeTimers();
    const onCopy = vi.fn();
    render(
      <ValueTree
        label="payload"
        value={typedValue(
          { large: "x".repeat(8 * 1024 * 1024), next: "next" },
          struct({ large: utf8(), next: utf8() }),
        )}
        onCopy={onCopy}
      />,
    );
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "c", ctrlKey: true });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "c", ctrlKey: true });
    await act(async () => vi.runAllTimersAsync());

    expect(onCopy).toHaveBeenCalledOnce();
    expect(onCopy).toHaveBeenCalledWith('"next"');
  });

  it("blocks a second copy until the pending clipboard write settles", async () => {
    vi.useFakeTimers();
    let finishFirstWrite!: () => void;
    const onCopy = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstWrite = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    render(
      <ValueTree
        label="payload"
        value={typedValue(
          { first: "A", second: "B" },
          struct({ first: utf8(), second: utf8() }),
        )}
        onCopy={onCopy}
      />,
    );
    const tree = screen.getByRole("tree");
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "c", ctrlKey: true });
    await act(async () => vi.advanceTimersToNextTimerAsync());
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onCopy).toHaveBeenLastCalledWith('"A"');

    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "c", ctrlKey: true });
    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(onCopy).toHaveBeenCalledOnce();
    expect(screen.getByText("Preparing content for copy…")).toBeInTheDocument();

    await act(async () => finishFirstWrite());
    fireEvent.keyDown(tree, { key: "c", ctrlKey: true });
    await act(async () => vi.runAllTimersAsync());
    expect(onCopy).toHaveBeenCalledTimes(2);
    expect(onCopy).toHaveBeenLastCalledWith('"B"');
  });

  it("rejects an oversized JSON copy without touching the clipboard", async () => {
    vi.useFakeTimers();
    const onCopy = vi.fn();
    render(
      <ValueTree
        label="payload"
        value={typedValue("x".repeat(VALUE_COPY_CHARACTER_LIMIT), utf8())}
        onCopy={onCopy}
      />,
    );
    fireEvent.keyDown(screen.getByRole("tree"), {
      key: "c",
      ctrlKey: true,
    });
    await act(async () => vi.runAllTimersAsync());

    expect(onCopy).not.toHaveBeenCalled();
    expect(
      screen.getByText(/exceeds the 33,554,432-character copy limit/),
    ).toBeInTheDocument();
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
    expect(valueReads).toBeLessThan(100);
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
    const view = render(
      <ValueTree
        label="payload"
        value={typedValue(bytes, binary())}
        onCopy={vi.fn()}
      />,
    );

    expect(
      screen.getByText("binary · 4.2 MB", {
        selector: ".value-peek-binary-summary span",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Offset")).toBeInTheDocument();
    expect(screen.getByText("Hex bytes")).toBeInTheDocument();
    expect(screen.getByText("ASCII")).toBeInTheDocument();
    expect(
      screen.getByText("Dot (.) means a non-printable byte."),
    ).toBeInTheDocument();
    const hexDump = screen.getByRole("table", { name: "payload hex dump" });
    expect(
      within(hexDump).getByRole("columnheader", { name: "Offset" }),
    ).toBeVisible();
    expect(
      within(hexDump).getByRole("columnheader", { name: "Hex bytes" }),
    ).toBeVisible();
    expect(
      within(hexDump).getByRole("columnheader", { name: "ASCII" }),
    ).toBeVisible();
    expect(within(hexDump).getAllByRole("row")[1]).toHaveAccessibleName(
      /00000000.*41 00 ff.*A/,
    );
    expect(
      screen.getByText("Dot (.) means a non-printable byte."),
    ).not.toHaveAttribute("aria-hidden");
    expect(hexDump.querySelectorAll(".value-peek-binary-row")).toHaveLength(10);
    expect(hexDump).not.toHaveTextContent("003ffff0");
    expect(subarray.mock.calls.length).toBeLessThan(20);
    expect(
      subarray.mock.calls.every(([start, end]) => end! - start! <= 8),
    ).toBe(true);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Expand all" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Collapse all" }),
    ).not.toBeInTheDocument();

    view.rerender(
      <ValueTree
        label="payload"
        value={typedValue("x".repeat(500), utf8())}
        onCopy={vi.fn()}
      />,
    );
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Expand all" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Collapse all" }),
    ).not.toBeInTheDocument();
  });

  it("copies a selected binary node as quoted base64 JSON", async () => {
    vi.useFakeTimers();
    const onCopy = vi.fn();
    render(
      <ValueTree
        label="payload"
        value={typedValue(new Uint8Array([65, 0, 255]), binary())}
        onCopy={onCopy}
      />,
    );

    fireEvent.keyDown(screen.getByRole("tree"), {
      key: "c",
      ctrlKey: true,
    });
    await act(async () => vi.runAllTimersAsync());

    expect(onCopy).toHaveBeenCalledWith('"QQD/"');
    expect(screen.getByText("Copied content.")).toBeInTheDocument();
  });

  it("reports a rejected clipboard write without false success feedback", async () => {
    vi.useFakeTimers();
    render(
      <ValueTree
        label="payload"
        value={typedValue("value", utf8())}
        onCopy={() => Promise.reject(new Error("clipboard unavailable"))}
      />,
    );

    fireEvent.keyDown(screen.getByRole("tree"), {
      key: "c",
      ctrlKey: true,
    });
    await act(async () => vi.runAllTimersAsync());

    expect(
      screen.getByText("The JSON value could not be copied."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Copied content.")).not.toBeInTheDocument();
  });

  it("renders a null binary as null rather than an empty hex dump", () => {
    const { container } = render(
      <ValueTree
        label="payload"
        value={typedValue(null, binary())}
        onCopy={vi.fn()}
      />,
    );
    expect(screen.getByText("null", { selector: "pre" })).toBeInTheDocument();
    expect(
      container.querySelector(".value-tree-wrap.has-detail"),
    ).not.toBeNull();
  });

  it("parses logical JSON into a lossless semantic tree", async () => {
    vi.useFakeTimers();
    const onCopy = vi.fn();
    const source =
      ' \n{"wide":1.2300e+400,"wide":-0,"escaped":"a\\u0062","ok":true,"empty":null}\t ';
    render(
      <ValueTree
        label="json_value"
        value={typedValue(source, utf8(), "JSON")}
        onCopy={onCopy}
      />,
    );

    expect(screen.getByText(/Parsing JSON/)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("tree"), {
      key: "c",
      ctrlKey: true,
    });
    expect(onCopy).not.toHaveBeenCalled();
    await act(async () => vi.runAllTimersAsync());

    expect(screen.getAllByText("wide", { selector: ".is-key" })).toHaveLength(
      2,
    );
    expect(document.querySelector(".cell-preview-number")).toBeInTheDocument();
    expect(document.querySelector(".cell-preview-boolean")).toBeInTheDocument();
    expect(document.querySelector(".cell-preview-null")).toBeInTheDocument();
    expect(document.querySelector(".value-tree-type")).toHaveTextContent(
      "object",
    );
    expect(document.querySelector(".value-tree-type")).not.toHaveTextContent(
      "JSON",
    );
    const tree = screen.getByRole("tree", { name: "json_value value" });
    fireEvent.keyDown(tree, { key: "c", ctrlKey: true });
    await act(async () => vi.runAllTimersAsync());
    expect(onCopy).toHaveBeenLastCalledWith(source);
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "c", ctrlKey: true });
    await act(async () => vi.runAllTimersAsync());
    expect(onCopy).toHaveBeenLastCalledWith("1.2300e+400");
    vi.useRealTimers();
  });

  it("keeps copy feedback visible until the clipboard write settles", async () => {
    vi.useFakeTimers();
    let finishWrite!: () => void;
    const onCopy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    render(
      <ValueTree
        label="payload"
        value={typedValue("ready", utf8())}
        onCopy={onCopy}
      />,
    );

    fireEvent.keyDown(screen.getByRole("tree"), {
      key: "c",
      ctrlKey: true,
    });
    await act(async () => vi.advanceTimersToNextTimerAsync());
    expect(onCopy).toHaveBeenCalledWith('"ready"');
    expect(screen.getByText("Preparing content for copy…")).toBeInTheDocument();
    expect(document.querySelector(".value-tree-status")).toBeNull();

    await act(async () => finishWrite());
    expect(
      screen.queryByText("Preparing content for copy…"),
    ).not.toBeInTheDocument();
  });

  it("keeps JSON-looking plain UTF-8 as one scalar", () => {
    render(
      <ValueTree
        label="plain"
        value={typedValue('{"not":"logical JSON"}', utf8())}
        onCopy={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    expect(
      screen.getByText('{"not":"logical JSON"}', { selector: "pre" }),
    ).toBeInTheDocument();
  });

  it("shows malformed logical JSON as searchable raw text", async () => {
    vi.useFakeTimers();
    const onCopy = vi.fn();
    const source = '{"oops":]';
    render(
      <ValueTree
        label="json_value"
        value={typedValue(source, utf8(), "JSON")}
        onCopy={onCopy}
      />,
    );
    await act(async () => vi.runAllTimersAsync());

    expect(screen.getByText(/Invalid JSON at character \d+/)).toHaveTextContent(
      "Showing raw text",
    );
    expect(screen.getByRole("button", { name: "Expand all" })).toBeDisabled();
    const tree = screen.getByRole("tree", { name: "json_value value" });
    fireEvent.keyDown(tree, { key: "c", ctrlKey: true });
    await act(async () => vi.runAllTimersAsync());
    expect(onCopy).toHaveBeenLastCalledWith(JSON.stringify(source));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search keys and values" }),
      { target: { value: "OOPS" } },
    );
    await act(async () => vi.runAllTimersAsync());
    expect(screen.getByText(/1 of 1 matches/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("falls back to bounded raw-source search when valid JSON exceeds the tree cap", async () => {
    vi.useFakeTimers();
    const onCopy = vi.fn();
    const source = `[${"0,".repeat(JSON_NODE_METADATA_LIMIT)}"needle"]`;
    render(
      <ValueTree
        label="json_value"
        value={typedValue(source, utf8(), "JSON")}
        onCopy={onCopy}
      />,
    );
    await act(async () => vi.runAllTimersAsync());

    expect(screen.getByText(/JSON tree is too large/)).toHaveTextContent(
      "literal-source search",
    );
    const search = screen.getByRole("searchbox", {
      name: "Search raw JSON source",
    });
    fireEvent.change(search, { target: { value: "needle" } });
    await act(async () => vi.runAllTimersAsync());
    expect(screen.getByText(/1 of 1 matches/)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("tree"), { key: "c", ctrlKey: true });
    await act(async () => vi.runAllTimersAsync());
    expect(onCopy).toHaveBeenCalledWith(source);
  });

  it("cancels and resumes a long JSON parse without stale completion", async () => {
    vi.useFakeTimers();
    const source = `{"value":"${"x".repeat(2 * 1024 * 1024)}"}`;
    const { container } = render(
      <ValueTree
        label="json_value"
        value={typedValue(source, utf8(), "JSON")}
        onCopy={vi.fn()}
      />,
    );

    await act(async () => vi.runOnlyPendingTimersAsync());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText(/Canceled JSON parsing after/)).toBeInTheDocument();
    expect(
      screen.getByText(/Showing the first 8,192 of 2,097,164 characters/),
    ).toBeInTheDocument();
    const rawPreview = container.querySelector("pre");
    expect(rawPreview).toHaveTextContent(/^\{"value":"x/);
    expect(rawPreview?.textContent).toHaveLength(8_193);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await act(async () => vi.runAllTimersAsync());
    expect(
      screen.getByText("value", { selector: ".value-tree-name.is-key" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Parsing JSON/)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("restarts canceled Arrow logical JSON parsing from the byte source", async () => {
    vi.useFakeTimers();
    const source = `{"value":"${"x".repeat(2 * 1024 * 1024)}","needle":true}`;
    const bytes = tableToIPC(
      tableFromArrays({ json: [source] }, { types: { json: utf8() } }),
      { format: "stream" },
    );
    const fieldPath = ["json"];
    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0, [
      fieldPath,
    ]);
    const value = arrowTypedValue(
      windowArrowValue(window, fieldPath, 0)!,
      "JSON",
    );
    render(<ValueTree label="json_value" value={value} onCopy={vi.fn()} />);

    await act(async () => vi.runOnlyPendingTimersAsync());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await act(async () => vi.runAllTimersAsync());

    expect(
      screen.getByText("needle", { selector: ".value-tree-name.is-key" }),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search keys and values" }),
      { target: { value: "needle" } },
    );
    await act(async () => vi.runAllTimersAsync());
    expect(screen.getByText(/1 of 1 matches/)).toBeInTheDocument();
  });

  it("searches keys and scalar values once, navigates, and restores expansion", async () => {
    vi.useFakeTimers();
    const source = '{"needle":"needle","nested":{"value":"NEEDLE here"}}';
    render(
      <ValueTree
        label="json_value"
        value={typedValue(source, utf8(), "JSON")}
        onCopy={vi.fn()}
      />,
    );
    await act(async () => vi.runAllTimersAsync());
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    const search = screen.getByRole("searchbox", {
      name: "Search keys and values",
    });
    fireEvent.change(search, { target: { value: "needle" } });
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeDisabled();
    await act(async () => vi.runAllTimersAsync());

    expect(screen.getByText(/1 of 2 matches/)).toBeInTheDocument();
    expect(document.querySelector("mark")).toHaveTextContent(/needle/i);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByText(/2 of 2 matches/)).toBeInTheDocument();
    expect(screen.getByText("value", { selector: ".is-key" })).toBeVisible();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeEnabled();
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("keeps parsed JSON search within each key and scalar span", async () => {
    vi.useFakeTimers();
    const source = '{"row":1,"group":1,"ok":false}';
    render(
      <ValueTree
        label="json_value"
        value={typedValue(source, utf8(), "JSON")}
        onCopy={vi.fn()}
      />,
    );
    await act(async () => vi.runAllTimersAsync());
    const search = screen.getByRole("searchbox", {
      name: "Search keys and values",
    });

    for (const [query, label, snippet] of [
      ["ok", "ok", "ok"],
      ["group", "group", "group"],
      ["false", "ok", "false"],
    ] as const) {
      fireEvent.change(search, { target: { value: query } });
      await act(async () => vi.runAllTimersAsync());
      expect(screen.getByText(/1 of 1 matches/)).toBeInTheDocument();
      const selected = screen.getByRole("treeitem", { selected: true });
      expect(selected.querySelector(".value-tree-name")?.textContent).toBe(
        label,
      );
      expect(
        within(selected).getByText(snippet, { selector: "mark" }).parentElement
          ?.textContent,
      ).toBe(snippet);
    }

    for (const query of ['1,"group', '1,"ok']) {
      fireEvent.change(search, { target: { value: query } });
      await act(async () => vi.runAllTimersAsync());
      expect(screen.getByText(/^No matches/)).toBeInTheDocument();
      expect(document.querySelector("mark")).toBeNull();
    }
    vi.useRealTimers();
  });

  it("reports character progress while searching one multi-megabyte nested scalar", async () => {
    vi.useFakeTimers();
    const note = `${"x".repeat(4_095)}𐐀${"x".repeat(2 * 1024 * 1024)}needle`;
    render(
      <ValueTree
        label="payload"
        value={typedValue({ note }, struct({ note: utf8() }))}
        onCopy={vi.fn()}
      />,
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search keys and values" }),
      { target: { value: "needle" } },
    );

    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(screen.getByText(/Searching after 1 node/)).toHaveTextContent(
      /[\d,]+ characters/,
    );
    const first = Number(
      screen
        .getByText(/Searching after 1 node/)
        .textContent!.match(/· ([\d,]+) characters/)![1]!
        .replaceAll(",", ""),
    );
    await act(async () => vi.runOnlyPendingTimersAsync());
    const second = Number(
      screen
        .getByText(/Searching after 1 node/)
        .textContent!.match(/· ([\d,]+) characters/)![1]!
        .replaceAll(",", ""),
    );
    expect(second).toBeGreaterThan(first);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText(/Canceled after 1 node/)).toHaveTextContent(
      `${second.toLocaleString()} characters`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await act(async () => vi.runAllTimersAsync());
    expect(screen.getByText(/1 of 1 matches/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("discards stale search chunks when the query changes", async () => {
    vi.useFakeTimers();
    const values = Array.from({ length: 10_000 }, (_value, index) =>
      index % 2 === 0 ? `old ${index}` : `new ${index}`,
    );
    const view = render(
      <ValueTree
        label="values"
        value={typedValue(values, list(utf8()))}
        onCopy={vi.fn()}
      />,
    );
    const search = screen.getByRole("searchbox", {
      name: "Search keys and values",
    });
    fireEvent.change(search, { target: { value: "old".repeat(100_000) } });
    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(screen.getByText(/Searching after 0 nodes/)).toHaveTextContent(
      /4,096 characters/,
    );
    fireEvent.change(search, { target: { value: "new" } });
    await act(async () => vi.runAllTimersAsync());

    expect(screen.getByText(/1 of 5,000 matches/)).toBeInTheDocument();
    expect(document.querySelector("mark")).toHaveTextContent("new");
    for (let ordinal = 1; ordinal < 64; ordinal += 1) {
      fireEvent.keyDown(search, { key: "Enter" });
    }
    expect(screen.getByText(/64 of 5,000 matches/)).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByText(/Locating match 65 of 5,000/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await act(async () => vi.runAllTimersAsync());
    expect(screen.getByText(/65 of 5,000 matches/)).toBeInTheDocument();
    view.unmount();
    await act(async () => vi.runAllTimersAsync());
    vi.useRealTimers();
  });

  it("evicts old rendered matches while navigating beyond the cache prefix", async () => {
    vi.useFakeTimers();
    let valueReads = 0;
    const readsByIndex = new Map<number, number>();
    const values = new Proxy(
      { length: 2_000 } as { length: number } & Record<number, string>,
      {
        has: (_target, property) =>
          property === "length" || Number.isInteger(Number(property)),
        get: (target, property) => {
          if (property === "length") return target.length;
          valueReads += 1;
          const index = Number(property);
          readsByIndex.set(index, (readsByIndex.get(index) ?? 0) + 1);
          return "needle";
        },
      },
    );
    render(
      <ValueTree
        label="values"
        value={typedValue(values, list(utf8()))}
        onCopy={vi.fn()}
      />,
    );
    const search = screen.getByRole("searchbox", {
      name: "Search keys and values",
    });
    const tree = screen.getByRole("tree", { name: "values value" });

    fireEvent.change(search, { target: { value: "needle" } });
    await act(async () => vi.runAllTimersAsync());
    expect(screen.getByText(/1 of 2,000 matches/)).toBeInTheDocument();
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(30);
    for (let ordinal = 1; ordinal < 100; ordinal += 1) {
      fireEvent.keyDown(search, { key: "Enter" });
      if (screen.queryByText(/Locating match/)) {
        await act(async () => vi.runAllTimersAsync());
      }
    }
    expect(screen.getByText(/100 of 2,000 matches/)).toBeInTheDocument();

    for (let ordinal = 100; ordinal > 1; ordinal -= 1) {
      fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
      if (screen.queryByText(/Locating match/)) {
        await act(async () => vi.runAllTimersAsync());
      }
    }
    expect(screen.getByText(/1 of 2,000 matches/)).toBeInTheDocument();
    expect(readsByIndex.get(69)).toBeLessThanOrEqual(12);

    fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
    await act(async () => vi.runAllTimersAsync());
    expect(screen.getByText(/2,000 of 2,000 matches/)).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByText(/1 of 2,000 matches/)).toBeInTheDocument();

    const readsBeforeUnseenRow = valueReads;
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.scroll(tree, { target: { scrollTop: 1_960 } });
    expect(valueReads).toBeGreaterThan(readsBeforeUnseenRow);
    expect(readsByIndex.get(69)).toBeLessThanOrEqual(12);
    vi.useRealTimers();
  });

  it("cancels scheduled search callbacks on value replacement and unmount", async () => {
    vi.useFakeTimers();
    const oldValues = Array.from({ length: 100_000 }, () => "old");
    const view = render(
      <ValueTree
        label="value"
        value={typedValue(oldValues, list(utf8()))}
        onCopy={vi.fn()}
      />,
    );
    const search = screen.getByRole("searchbox", {
      name: "Search keys and values",
    });
    fireEvent.change(search, { target: { value: "old" } });
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(screen.getByText(/Searching/)).toBeInTheDocument();

    view.rerender(
      <ValueTree
        label="value"
        value={typedValue(["fresh"], list(utf8()))}
        onCopy={vi.fn()}
      />,
    );
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.runAllTimersAsync());
    expect(screen.queryByText(/Searching|matches/)).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveValue("");

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "fresh" },
    });
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.runAllTimersAsync());
    vi.useRealTimers();
  });

  it("starts a 100k-node expansion in bounded chunks and can cancel it", async () => {
    vi.useFakeTimers();
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

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(valueReads).toBeLessThan(1_000);
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(30);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText(/Canceled after \d+ nodes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await act(async () => vi.runAllTimersAsync());
    expect(valueReads).toBeGreaterThanOrEqual(100_000);
    expect(
      Number.parseFloat(
        (document.querySelector(".value-tree-spacer") as HTMLElement).style
          .height,
      ),
    ).toBeGreaterThan(2_799_000);
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(30);
    vi.useRealTimers();
  });

  it("keeps a deep active view stable while later search chunks stay cancelable", async () => {
    vi.useFakeTimers();
    const depth = 512;
    let deepLengthReads = 0;
    let deepValue: unknown = "needle";
    let deepType: DataType = utf8();
    for (let level = 0; level < depth; level += 1) {
      const child = deepValue;
      deepValue = new Proxy(
        { length: 1, 0: child } as { length: number } & Record<number, unknown>,
        {
          has: (_target, property) => property === "length" || property === "0",
          get: (target, property, receiver) => {
            if (property === "length") deepLengthReads += 1;
            return Reflect.get(target, property, receiver);
          },
        },
      );
      deepType = list(deepType);
    }
    let wideReads = 0;
    const wide = new Proxy(
      { length: 10_000 } as { length: number } & Record<number, string>,
      {
        has: (_target, property) =>
          property === "length" || Number.isInteger(Number(property)),
        get: (target, property) => {
          if (property === "length") return target.length;
          wideReads += 1;
          return "later";
        },
      },
    );
    render(
      <ValueTree
        label="mixed"
        value={typedValue(
          { deep: deepValue, wide },
          struct({ deep: deepType, wide: list(utf8()) }),
        )}
        onCopy={vi.fn()}
      />,
    );
    const search = screen.getByRole("searchbox", {
      name: "Search keys and values",
    });
    fireEvent.change(search, { target: { value: "needle" } });
    for (let tick = 0; tick < 12; tick += 1) {
      if (screen.queryByText(/1 found/)) break;
      await act(async () => vi.runOnlyPendingTimersAsync());
    }
    expect(screen.getByText(/1 found/)).toBeInTheDocument();
    const readsAfterMatch = deepLengthReads;

    for (let tick = 0; tick < 4; tick += 1) {
      await act(async () => vi.runOnlyPendingTimersAsync());
      expect(deepLengthReads).toBe(readsAfterMatch);
    }
    expect(wideReads).toBeLessThan(1_000);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText(/Canceled after/)).toBeInTheDocument();
    const readsAtCancel = wideReads;
    await act(async () => vi.runAllTimersAsync());
    expect(wideReads).toBe(readsAtCancel);
    vi.useRealTimers();
  });

  it("parses, expands, and searches deeply nested JSON without recursion", async () => {
    vi.useFakeTimers();
    const depth = 20_000;
    const source = `${"[".repeat(depth)}"needle"${"]".repeat(depth)}`;
    render(
      <ValueTree
        label="deep_json"
        value={typedValue(source, utf8(), "JSON")}
        onCopy={vi.fn()}
      />,
    );
    await act(async () => vi.runAllTimersAsync());

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(screen.getByText(/Expanding after 128 nodes/)).toBeInTheDocument();
    await act(async () => vi.runAllTimersAsync());
    expect(
      Number.parseFloat(
        (document.querySelector(".value-tree-spacer") as HTMLElement).style
          .height,
      ),
    ).toBe((depth + 1) * 28);

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search keys and values" }),
      { target: { value: "needle" } },
    );
    await act(async () => vi.runAllTimersAsync());
    expect(screen.getByText(/1 of 1 matches/)).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { selected: true })).toHaveAttribute(
      "aria-level",
      String(depth + 1),
    );
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(30);
    vi.useRealTimers();
  });
});
