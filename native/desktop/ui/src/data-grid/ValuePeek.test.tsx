import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { binary, utf8 } from "@uwdata/flechette";
import { act } from "react";
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

  it("keeps placement non-negative in a viewport smaller than the anchor", () => {
    const placement = placePeek(
      { x: 0, y: 0, width: 100, height: 100 },
      { width: 360, height: 480 },
      100,
      80,
    );
    expect(placement).toEqual({ left: 8, top: 8, width: 84, height: 64 });
  });

  it("shows a full wrapped string and returns Tab to the grid", () => {
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
    fireEvent.keyDown(screen.getByRole("tree"), { key: "Tab" });
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
    expect(
      screen.getByText(
        (_text, element) =>
          element?.classList.contains("value-peek-binary-row") === true &&
          element.textContent?.includes("00000000  41 00 ff") === true,
      ),
    ).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
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

  it("persists user resizing without replacing it with a viewport clamp", () => {
    let notifyResize: () => void = () => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = () => callback([], this as unknown as ResizeObserver);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("innerWidth", 1_000);
    vi.stubGlobal("innerHeight", 800);
    let measured = { width: 360, height: 480 };
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
    Object.defineProperties(dialog, {
      offsetWidth: { configurable: true, get: () => measured.width },
      offsetHeight: { configurable: true, get: () => measured.height },
    });

    act(notifyResize);
    expect(localStorage.getItem("viewda.value-peek.size")).toBeNull();
    measured = { width: 440, height: 400 };
    act(notifyResize);
    expect(JSON.parse(localStorage.getItem("viewda.value-peek.size")!)).toEqual(
      measured,
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
      width: "44px",
    });
    measured = { width: 44, height: 400 };
    Object.defineProperties(constrainedDialog, {
      offsetWidth: { configurable: true, get: () => measured.width },
      offsetHeight: { configurable: true, get: () => measured.height },
    });
    act(notifyResize);
    expect(JSON.parse(localStorage.getItem("viewda.value-peek.size")!)).toEqual(
      {
        width: 440,
        height: 400,
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
      height: "400px",
    });
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
    expect(dialog).toHaveStyle({ width: "164px" });

    vi.stubGlobal("innerWidth", 1_000);
    fireEvent(window, new Event("resize"));
    expect(dialog).toHaveStyle({ width: "360px" });
  });
});
