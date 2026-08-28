import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { binary, struct, utf8 } from "@uwdata/flechette";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ValuePeek, placePeek } from "./ValuePeek";
import { typedValue } from "./value-format";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    clear: () => values.clear(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ValuePeek", () => {
  const defaultAnchor = { x: 20, y: 20, width: 100, height: 28 };

  function renderResizeFixture() {
    const props = {
      label: "note",
      value: typedValue("text", utf8()),
      onClose: vi.fn(),
      onReturnFocus: vi.fn(),
      onCopy: vi.fn(),
    };
    const view = render(<ValuePeek {...props} anchor={defaultAnchor} />);
    const dialog = screen.getByRole("dialog", { name: "Peek note" });
    const handle = dialog.querySelector(
      ".value-peek-resize-hint",
    ) as HTMLElement;
    return { dialog, handle, props, view };
  }

  function startResize(handle: HTMLElement, pointerId: number) {
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId,
      clientX: 488,
      clientY: 536,
    });
  }

  it("places beside and flips above the anchor without covering its row", () => {
    expect(
      placePeek(
        { x: 20, y: 20, width: 100, height: 28 },
        { width: 360, height: 480 },
        1_000,
        800,
      ),
    ).toMatchObject({ left: 128, top: 56, width: 360 });
    const flipped = placePeek(
      { x: 850, y: 700, width: 100, height: 28 },
      { width: 360, height: 480 },
      1_000,
      800,
    );
    expect(flipped.left + flipped.width).toBeLessThanOrEqual(842);
    expect(flipped.top + flipped.height).toBeLessThanOrEqual(692);
  });

  it("keeps walking placement stable until the active cell would collide", () => {
    vi.stubGlobal("innerWidth", 1_000);
    vi.stubGlobal("innerHeight", 800);
    const props = {
      label: "note",
      value: typedValue("text", utf8()),
      onClose: vi.fn(),
      onReturnFocus: vi.fn(),
      onCopy: vi.fn(),
    };
    const view = render(<ValuePeek {...props} anchor={defaultAnchor} />);
    const dialog = screen.getByRole("dialog", { name: "Peek note" });
    const initial = { left: "128px", top: "56px" };
    expect(dialog).toHaveStyle(initial);

    for (let row = 1; row <= 35; row += 1) {
      view.rerender(
        <ValuePeek
          {...props}
          anchor={{ x: 20, y: 20 + row * 18, width: 100, height: 28 }}
        />,
      );
      expect(dialog).toHaveStyle(initial);
    }

    view.rerender(
      <ValuePeek
        {...props}
        anchor={{ x: 300, y: 100, width: 100, height: 28 }}
      />,
    );
    expect(dialog).toHaveStyle({ left: "408px" });

    view.rerender(
      <ValuePeek
        {...props}
        anchor={{ x: 700, y: 200, width: 100, height: 28 }}
      />,
    );
    expect(dialog).toHaveStyle({ left: "332px", width: "360px" });
  });

  it("keeps a functional full width while following cells in a narrow viewport", () => {
    vi.stubGlobal("innerWidth", 320);
    vi.stubGlobal("innerHeight", 800);
    const props = {
      label: "note",
      value: typedValue("text", utf8()),
      onClose: vi.fn(),
      onReturnFocus: vi.fn(),
      onCopy: vi.fn(),
    };
    const view = render(
      <ValuePeek
        {...props}
        anchor={{ x: 140, y: 20, width: 40, height: 28 }}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Peek note" });
    expect(dialog).toHaveStyle({ left: "8px", top: "56px", width: "304px" });

    for (const y of [100, 180, 260]) {
      view.rerender(
        <ValuePeek {...props} anchor={{ x: 140, y, width: 40, height: 28 }} />,
      );
      expect(dialog).toHaveStyle({ left: "8px", width: "304px" });
      const top = Number.parseFloat(dialog.style.top);
      const height = Number.parseFloat(dialog.style.height);
      expect(top + height <= y || top >= y + 28).toBe(true);
    }
  });

  it("keeps placement non-negative in a viewport smaller than the anchor", () => {
    const placement = placePeek(
      { x: 0, y: 0, width: 100, height: 100 },
      { width: 360, height: 480 },
      100,
      80,
    );
    expect(placement).toEqual({ left: 8, top: 8, width: 84, height: 64 });
  });

  it("uses the functional viewport width when neither side fits Peek", () => {
    expect(
      placePeek(
        { x: 150, y: 120, width: 80, height: 28 },
        { width: 420, height: 360 },
        360,
        600,
      ),
    ).toMatchObject({ left: 8, top: 156, width: 344, height: 360 });
  });

  it("shows a full wrapped string and returns tree Tab to the grid", () => {
    const onReturnFocus = vi.fn();
    render(
      <ValuePeek
        label="note"
        value={typedValue("x".repeat(500), utf8())}
        anchor={{ x: 20, y: 20, width: 100, height: 28 }}
        onClose={vi.fn()}
        onReturnFocus={onReturnFocus}
        onCopy={vi.fn()}
      />,
    );
    expect(
      screen.getByText("x".repeat(500), { selector: "pre" }),
    ).toBeVisible();
    const close = screen.getByRole("button", { name: "Close Peek" });
    const tree = screen.getByRole("tree");
    tree.focus();
    fireEvent.keyDown(tree, { key: "Tab" });
    expect(onReturnFocus).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(tree);
    fireEvent.keyDown(tree, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Copy path" }),
    );
    expect(onReturnFocus).toHaveBeenCalledOnce();
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(tree);
  });

  it("moves backward from a structured tree to its last toolbar control", () => {
    render(
      <ValuePeek
        label="profile"
        value={typedValue({ name: "Ada" }, struct({ name: utf8() }))}
        anchor={defaultAnchor}
        onClose={vi.fn()}
        onReturnFocus={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    const tree = screen.getByRole("tree");
    tree.focus();
    fireEvent.keyDown(tree, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Collapse all" }),
    );
  });

  it("hides only Copy path when path actions are unavailable", () => {
    render(
      <ValuePeek
        label="profile"
        value={typedValue({ name: "Ada" }, struct({ name: utf8() }))}
        anchor={defaultAnchor}
        showCopyPath={false}
        onClose={vi.fn()}
        onReturnFocus={vi.fn()}
        onCopy={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Copy path" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search keys and values" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Expand all" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeVisible();
  });

  it("keeps Space inert in the focused tree and closes Esc back to the grid", () => {
    const onClose = vi.fn();
    const onReturnFocus = vi.fn();
    render(
      <ValuePeek
        label="note"
        value={typedValue("text", utf8())}
        anchor={defaultAnchor}
        onClose={onClose}
        onReturnFocus={onReturnFocus}
        onCopy={vi.fn()}
      />,
    );
    const tree = screen.getByRole("tree");

    expect(fireEvent.keyDown(tree, { key: " " })).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(tree, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onReturnFocus).toHaveBeenCalledOnce();
  });

  it("shows binary bytes as hex and closes on outside click", () => {
    const onClose = vi.fn();
    render(
      <ValuePeek
        label="payload"
        value={typedValue(new Uint8Array([65, 0, 255]), binary())}
        anchor={{ x: 20, y: 20, width: 100, height: 28 }}
        onClose={onClose}
        onReturnFocus={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    const hexDump = screen.getByRole("table", { name: "payload hex dump" });
    expect(hexDump).toHaveTextContent("00000000");
    expect(hexDump).toHaveTextContent("41 00 ff");
    expect(hexDump).toHaveTextContent("A..");
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("copies the selected path and keeps JSON copying on the tree keyboard contract", async () => {
    vi.useFakeTimers();
    const onCopy = vi.fn();
    render(
      <ValuePeek
        label="note"
        value={typedValue("text", utf8())}
        anchor={defaultAnchor}
        onClose={vi.fn()}
        onReturnFocus={vi.fn()}
        onCopy={onCopy}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Copy JSON" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Expand all" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Collapse all" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
    await act(async () => vi.runAllTimersAsync());
    expect(onCopy).toHaveBeenCalledWith("note");
    fireEvent.keyDown(screen.getByRole("tree"), {
      key: "c",
      ctrlKey: true,
    });
    await act(async () => vi.runAllTimersAsync());
    expect(onCopy).toHaveBeenLastCalledWith('"text"');
    vi.useRealTimers();
  });

  it("reopens with its remembered size", () => {
    localStorage.setItem(
      "viewda.value-peek.size",
      JSON.stringify({ width: 420, height: 430 }),
    );
    render(
      <ValuePeek
        label="note"
        value={typedValue("text", utf8())}
        anchor={{ x: 20, y: 20, width: 100, height: 28 }}
        onClose={vi.fn()}
        onReturnFocus={vi.fn()}
        onCopy={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Peek note" })).toHaveStyle({
      width: "420px",
      height: "430px",
    });
  });

  it("clamps an oversized remembered size beside an edge anchor", () => {
    vi.stubGlobal("innerWidth", 600);
    vi.stubGlobal("innerHeight", 500);
    localStorage.setItem(
      "viewda.value-peek.size",
      JSON.stringify({ width: 2_000, height: 2_000 }),
    );
    render(
      <ValuePeek
        label="note"
        value={typedValue("text", utf8())}
        anchor={{ x: 480, y: 440, width: 100, height: 28 }}
        onClose={vi.fn()}
        onReturnFocus={vi.fn()}
        onCopy={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Peek note" })).toHaveStyle({
      left: "8px",
      top: "8px",
      width: "464px",
      height: "424px",
    });
  });

  it("repositions an above-anchor Peek after a committed resize", () => {
    vi.stubGlobal("innerWidth", 1_000);
    vi.stubGlobal("innerHeight", 800);
    render(
      <ValuePeek
        label="note"
        value={typedValue("text", utf8())}
        anchor={{ x: 850, y: 700, width: 100, height: 28 }}
        onClose={vi.fn()}
        onReturnFocus={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Peek note" });
    const handle = dialog.querySelector(
      ".value-peek-resize-hint",
    ) as HTMLElement;
    expect(dialog).toHaveStyle({ left: "482px", top: "212px" });

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 12,
      clientX: 842,
      clientY: 692,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 12,
      clientX: 842,
      clientY: 792,
    });
    fireEvent.pointerUp(handle, { pointerId: 12 });

    expect(dialog).toHaveStyle({ top: "112px", height: "580px" });
  });

  it("resizes from a fixed corner and persists only dimensions the user changed", () => {
    vi.stubGlobal("innerWidth", 1_000);
    vi.stubGlobal("innerHeight", 800);
    const view = render(
      <ValuePeek
        label="note"
        value={typedValue("text", utf8())}
        anchor={{ x: 20, y: 20, width: 100, height: 28 }}
        onClose={vi.fn()}
        onReturnFocus={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Peek note" });
    const handle = dialog.querySelector(
      ".value-peek-resize-hint",
    ) as HTMLElement;
    expect(dialog).toHaveStyle({ left: "128px", top: "56px" });
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 488,
      clientY: 536,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: 568,
      clientY: 456,
    });
    expect(dialog).toHaveStyle({
      left: "128px",
      top: "56px",
      width: "440px",
      height: "400px",
    });
    expect(localStorage.getItem("viewda.value-peek.size")).toBeNull();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(JSON.parse(localStorage.getItem("viewda.value-peek.size")!)).toEqual(
      { width: 440, height: 400 },
    );

    view.unmount();
    vi.stubGlobal("innerWidth", 180);
    const constrained = render(
      <ValuePeek
        label="note"
        value={typedValue("text", utf8())}
        anchor={{ x: 20, y: 20, width: 100, height: 28 }}
        onClose={vi.fn()}
        onReturnFocus={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    const constrainedDialog = screen.getByRole("dialog", {
      name: "Peek note",
    });
    expect(constrainedDialog).toHaveStyle({
      left: "8px",
      width: "164px",
    });
    const constrainedHandle = constrainedDialog.querySelector(
      ".value-peek-resize-hint",
    ) as HTMLElement;
    fireEvent.pointerDown(constrainedHandle, {
      button: 0,
      pointerId: 2,
      clientX: 172,
      clientY: 456,
    });
    fireEvent.pointerMove(constrainedHandle, {
      pointerId: 2,
      clientX: 172,
      clientY: 476,
    });
    fireEvent.pointerUp(constrainedHandle, { pointerId: 2 });
    expect(JSON.parse(localStorage.getItem("viewda.value-peek.size")!)).toEqual(
      {
        width: 440,
        height: 420,
      },
    );
    constrained.unmount();

    vi.stubGlobal("innerWidth", 1_000);
    render(
      <ValuePeek
        label="note"
        value={typedValue("text", utf8())}
        anchor={{ x: 20, y: 20, width: 100, height: 28 }}
        onClose={vi.fn()}
        onReturnFocus={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Peek note" })).toHaveStyle({
      width: "440px",
      height: "420px",
    });
  });

  it("clamps pointer resizing to the viewport without moving its origin", () => {
    vi.stubGlobal("innerWidth", 500);
    vi.stubGlobal("innerHeight", 400);
    render(
      <ValuePeek
        label="note"
        value={typedValue("text", utf8())}
        anchor={{ x: 20, y: 20, width: 100, height: 28 }}
        onClose={vi.fn()}
        onReturnFocus={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Peek note" });
    const handle = dialog.querySelector(
      ".value-peek-resize-hint",
    ) as HTMLElement;
    const origin = { left: "128px", top: "56px" };
    expect(dialog).toHaveStyle(origin);

    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 3,
      clientX: 488,
      clientY: 372,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 3,
      clientX: 900,
      clientY: 900,
    });

    expect(dialog).toHaveStyle({
      ...origin,
      width: "364px",
      height: "336px",
    });
    fireEvent.pointerCancel(handle, { pointerId: 3 });
    expect(dialog).toHaveStyle({ ...origin, width: "360px", height: "336px" });
    expect(localStorage.getItem("viewda.value-peek.size")).toBeNull();
  });

  it("cancels resizing when pointer capture is lost", () => {
    vi.stubGlobal("innerWidth", 1_000);
    vi.stubGlobal("innerHeight", 800);
    const { dialog, handle } = renderResizeFixture();

    startResize(handle, 4);
    fireEvent.pointerMove(handle, {
      pointerId: 4,
      clientX: 568,
      clientY: 456,
    });
    expect(dialog).toHaveClass("is-resizing");

    fireEvent.lostPointerCapture(handle, { pointerId: 4 });
    expect(dialog).not.toHaveClass("is-resizing");
    expect(dialog).toHaveStyle({
      left: "128px",
      top: "56px",
      width: "360px",
      height: "480px",
    });
    fireEvent.pointerUp(handle, { pointerId: 4 });
    expect(localStorage.getItem("viewda.value-peek.size")).toBeNull();
  });

  it("does not cancel a completed resize when releasing capture", () => {
    vi.stubGlobal("innerWidth", 1_000);
    vi.stubGlobal("innerHeight", 800);
    const { dialog, handle } = renderResizeFixture();
    let captured = false;
    Object.defineProperties(handle, {
      setPointerCapture: {
        value: vi.fn(() => {
          captured = true;
        }),
      },
      hasPointerCapture: { value: vi.fn(() => captured) },
      releasePointerCapture: {
        value: vi.fn((pointerId: number) => {
          captured = false;
          fireEvent.lostPointerCapture(handle, { pointerId });
        }),
      },
    });

    startResize(handle, 5);
    fireEvent.pointerMove(handle, {
      pointerId: 5,
      clientX: 528,
      clientY: 496,
    });
    fireEvent.pointerUp(handle, { pointerId: 5 });

    expect(dialog).not.toHaveClass("is-resizing");
    expect(JSON.parse(localStorage.getItem("viewda.value-peek.size")!)).toEqual(
      { width: 400, height: 440 },
    );
  });

  it("ignores non-primary resize gestures", () => {
    vi.stubGlobal("innerWidth", 1_000);
    vi.stubGlobal("innerHeight", 800);
    const { dialog, handle } = renderResizeFixture();

    fireEvent.pointerDown(handle, {
      button: 1,
      pointerId: 6,
      clientX: 488,
      clientY: 536,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 6,
      clientX: 568,
      clientY: 616,
    });

    expect(dialog).not.toHaveClass("is-resizing");
    expect(dialog).toHaveStyle({ width: "360px", height: "480px" });
    expect(localStorage.getItem("viewda.value-peek.size")).toBeNull();
  });

  it("replays an anchor change after a completed resize", () => {
    vi.stubGlobal("innerWidth", 1_000);
    vi.stubGlobal("innerHeight", 800);
    const { dialog, handle, props, view } = renderResizeFixture();
    startResize(handle, 7);
    fireEvent.pointerMove(handle, {
      pointerId: 7,
      clientX: 568,
      clientY: 456,
    });

    view.rerender(
      <ValuePeek
        {...props}
        anchor={{ x: 700, y: 500, width: 100, height: 28 }}
      />,
    );
    expect(dialog).toHaveStyle({ left: "128px", top: "56px" });
    fireEvent.pointerUp(handle, { pointerId: 7 });

    expect(dialog).toHaveStyle({
      left: "252px",
      top: "92px",
      width: "440px",
      height: "400px",
    });
    expect(JSON.parse(localStorage.getItem("viewda.value-peek.size")!)).toEqual(
      { width: 440, height: 400 },
    );
  });

  it("cancels an active resize and re-places after a viewport resize", () => {
    vi.stubGlobal("innerWidth", 1_000);
    vi.stubGlobal("innerHeight", 800);
    const { dialog, handle } = renderResizeFixture();
    startResize(handle, 8);
    fireEvent.pointerMove(handle, {
      pointerId: 8,
      clientX: 528,
      clientY: 496,
    });
    expect(dialog).toHaveClass("is-resizing");

    vi.stubGlobal("innerWidth", 300);
    vi.stubGlobal("innerHeight", 300);
    fireEvent(window, new Event("resize"));

    expect(dialog).not.toHaveClass("is-resizing");
    expect(dialog).toHaveStyle({
      left: "8px",
      top: "56px",
      width: "284px",
      height: "236px",
    });
    expect(localStorage.getItem("viewda.value-peek.size")).toBeNull();
  });

  it("recomputes placement when the window resizes", () => {
    vi.stubGlobal("innerWidth", 1_000);
    vi.stubGlobal("innerHeight", 800);
    render(
      <ValuePeek
        label="note"
        value={typedValue("text", utf8())}
        anchor={{ x: 20, y: 20, width: 100, height: 28 }}
        onClose={vi.fn()}
        onReturnFocus={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Peek note" });
    expect(dialog).toHaveStyle({ width: "360px" });

    vi.stubGlobal("innerWidth", 300);
    fireEvent(window, new Event("resize"));
    expect(dialog).toHaveStyle({ left: "8px", width: "284px" });

    vi.stubGlobal("innerWidth", 1_000);
    fireEvent(window, new Event("resize"));
    expect(dialog).toHaveStyle({ width: "360px" });
  });
});
