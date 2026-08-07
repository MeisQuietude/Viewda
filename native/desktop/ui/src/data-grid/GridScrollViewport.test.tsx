import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GridScrollViewport } from "./GridScrollViewport";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setElementSize(
  element: HTMLElement,
  {
    clientHeight,
    clientWidth,
    scrollHeight = clientHeight,
    scrollWidth = clientWidth,
  }: {
    clientHeight: number;
    clientWidth: number;
    scrollHeight?: number;
    scrollWidth?: number;
  },
): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    clientWidth: { configurable: true, value: clientWidth },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollWidth: { configurable: true, value: scrollWidth },
  });
}

describe("GridScrollViewport", () => {
  it("places native scrollbars around the row viewport and synchronizes them", async () => {
    const { container, getByTestId } = render(
      <GridScrollViewport headerHeight={32}>
        <div data-testid="grid-scroller" />
      </GridScrollViewport>,
    );
    const root = container.querySelector<HTMLElement>(".grid-canvas");
    const gridScroller = getByTestId("grid-scroller");
    expect(root).not.toBeNull();
    setElementSize(root!, { clientHeight: 400, clientWidth: 800 });
    setElementSize(gridScroller, {
      clientHeight: 400,
      clientWidth: 800,
      scrollHeight: 1_000,
      scrollWidth: 1_200,
    });

    fireEvent.scroll(gridScroller);

    const vertical = container.querySelector<HTMLElement>(
      ".grid-scrollbar-vertical",
    );
    const horizontal = container.querySelector<HTMLElement>(
      ".grid-scrollbar-horizontal",
    );
    expect(vertical).not.toBeNull();
    expect(horizontal).not.toBeNull();
    await waitFor(() => expect(vertical).not.toHaveAttribute("hidden"));
    expect(horizontal).not.toHaveAttribute("hidden");
    expect(vertical).toHaveStyle({ top: "32px", bottom: "0px" });
    expect(horizontal).toHaveStyle({ right: "0px" });
    expect(
      vertical?.querySelector<HTMLElement>(
        ".grid-scroll-spacer-vertical > div",
      ),
    ).toHaveStyle({ height: "968px" });
    expect(
      horizontal?.querySelector<HTMLElement>(
        ".grid-scroll-spacer-horizontal > div",
      ),
    ).toHaveStyle({ width: "1200px" });

    gridScroller.scrollTop = 240;
    gridScroller.scrollLeft = 120;
    fireEvent.scroll(gridScroller);
    expect(vertical?.scrollTop).toBe(240);
    expect(horizontal?.scrollLeft).toBe(120);

    if (vertical === null || horizontal === null) {
      throw new Error("Grid scrollbars were not rendered");
    }
    vertical.scrollTop = 360;
    fireEvent.scroll(vertical);
    expect(gridScroller.scrollTop).toBe(360);
    horizontal.scrollLeft = 180;
    fireEvent.scroll(horizontal);
    expect(gridScroller.scrollLeft).toBe(180);
  });

  it("does not show a vertical scrollbar when rows fit", async () => {
    const { container, getByTestId } = render(
      <GridScrollViewport headerHeight={32}>
        <div data-testid="grid-scroller" />
      </GridScrollViewport>,
    );
    const root = container.querySelector<HTMLElement>(".grid-canvas");
    const gridScroller = getByTestId("grid-scroller");
    expect(root).not.toBeNull();
    setElementSize(root!, { clientHeight: 400, clientWidth: 800 });
    setElementSize(gridScroller, {
      clientHeight: 400,
      clientWidth: 800,
      scrollHeight: 400,
      scrollWidth: 1_200,
    });

    fireEvent.scroll(gridScroller);

    const vertical = container.querySelector(".grid-scrollbar-vertical");
    const horizontal = container.querySelector(".grid-scrollbar-horizontal");
    await waitFor(() => expect(horizontal).not.toHaveAttribute("hidden"));
    expect(vertical).toHaveAttribute("hidden");
  });

  it("ignores clipped overflowing ancestors when discovering the grid scroller", async () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }

        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const { container, getByTestId } = render(
      <GridScrollViewport headerHeight={32}>
        <div
          data-testid="clipped-container"
          style={{ overflowX: "hidden", overflowY: "hidden" }}
        >
          <div
            data-testid="grid-scroller"
            style={{ overflowX: "auto", overflowY: "auto" }}
          />
        </div>
      </GridScrollViewport>,
    );
    const root = container.querySelector<HTMLElement>(".grid-canvas");
    const clippedContainer = getByTestId("clipped-container");
    const gridScroller = getByTestId("grid-scroller");
    expect(root).not.toBeNull();
    setElementSize(root!, { clientHeight: 400, clientWidth: 800 });
    setElementSize(clippedContainer, {
      clientHeight: 400,
      clientWidth: 800,
      scrollHeight: 1_200,
    });
    setElementSize(gridScroller, {
      clientHeight: 380,
      clientWidth: 780,
      scrollHeight: 1_000,
    });

    act(() => resizeCallback?.([], {} as ResizeObserver));

    const vertical = container.querySelector<HTMLElement>(
      ".grid-scrollbar-vertical",
    );
    await waitFor(() => expect(vertical).not.toHaveAttribute("hidden"));
    gridScroller.scrollTop = 240;
    fireEvent.scroll(gridScroller);
    expect(vertical?.scrollTop).toBe(240);

    clippedContainer.scrollTop = 120;
    fireEvent.scroll(clippedContainer);
    expect(vertical?.scrollTop).toBe(240);
  });

  it("builds large scroll ranges from browser-safe spacer chunks", async () => {
    const { container, getByTestId } = render(
      <GridScrollViewport headerHeight={32}>
        <div data-testid="grid-scroller" />
      </GridScrollViewport>,
    );
    const root = container.querySelector<HTMLElement>(".grid-canvas");
    const gridScroller = getByTestId("grid-scroller");
    expect(root).not.toBeNull();
    setElementSize(root!, { clientHeight: 400, clientWidth: 800 });
    setElementSize(gridScroller, {
      clientHeight: 400,
      clientWidth: 800,
      scrollHeight: 972_554_272,
    });

    fireEvent.scroll(gridScroller);

    const vertical = container.querySelector<HTMLElement>(
      ".grid-scrollbar-vertical",
    );
    await waitFor(() => expect(vertical).not.toHaveAttribute("hidden"));
    const chunks = Array.from(
      vertical?.querySelectorAll<HTMLElement>(
        ".grid-scroll-spacer-vertical > div",
      ) ?? [],
      (element) => Number.parseFloat(element.style.height),
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks)).toBe(5_000_000);
    expect(chunks.reduce((sum, chunk) => sum + chunk, 0)).toBe(972_554_240);
  });
});
