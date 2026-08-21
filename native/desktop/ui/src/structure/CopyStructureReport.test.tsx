import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import * as desktop from "../desktop";
import { CopyStructureReport } from "./CopyStructureReport";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

it("keeps its label stable and confirms a successful copy without layout text", async () => {
  vi.useFakeTimers();
  vi.spyOn(desktop, "getStructureReport").mockResolvedValue("# report");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });

  render(<CopyStructureReport generation={7} unit="uncompressed" active />);

  const button = screen.getByRole("button", { name: "Copy report" });
  expect(button).not.toHaveClass("is-copied");
  expect(button).toHaveAttribute(
    "title",
    expect.stringContaining(
      "Includes the writer, column names and metadata keys.",
    ),
  );
  const copyGlyph = button.querySelector(".copy-structure-glyph");
  await act(async () => {
    fireEvent.click(button);
  });

  expect(button).toHaveClass("is-copied");
  expect(button).toHaveTextContent("Copy report");
  expect(button.querySelector(".copy-structure-check")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Report copied.");
  expect(screen.getByRole("status")).toHaveClass("visually-hidden");
  expect(desktop.getStructureReport).toHaveBeenCalledWith(7, "uncompressed");
  expect(writeText).toHaveBeenCalledWith("# report");

  act(() => vi.advanceTimersByTime(500));
  await act(async () => {
    fireEvent.click(button);
  });
  act(() => vi.advanceTimersByTime(500));

  expect(button).toHaveClass("is-copied");

  act(() => vi.advanceTimersByTime(500));

  expect(button).not.toHaveClass("is-copied");
  expect(button).toHaveAccessibleName("Copy report");
  expect(button.querySelector(".copy-structure-glyph")).toBe(copyGlyph);
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  expect(desktop.getStructureReport).toHaveBeenCalledTimes(2);
});

it("shows a fixed-slot failure affordance without changing the button label", async () => {
  vi.spyOn(desktop, "getStructureReport").mockRejectedValue(new Error("copy"));

  render(<CopyStructureReport generation={7} unit="compressed" active />);

  const button = screen.getByRole("button", { name: "Copy report" });
  fireEvent.click(button);

  await waitFor(() => expect(button).toHaveClass("is-failed"));
  expect(button).toHaveAccessibleName("Copy report");
  expect(button).toHaveAttribute(
    "title",
    expect.stringContaining("Copy failed."),
  );
  expect(button.querySelector(".copy-structure-failure")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Copy failed.");
});

it("never lets an older report request overwrite a newer copy", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  vi.spyOn(desktop, "getStructureReport")
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });

  render(<CopyStructureReport generation={7} unit="compressed" active />);
  const button = screen.getByRole("button", { name: "Copy report" });
  fireEvent.click(button);
  fireEvent.click(button);
  second.resolve("# current");
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("# current"));
  first.resolve("# stale");

  await waitFor(() =>
    expect(desktop.getStructureReport).toHaveBeenCalledTimes(2),
  );
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText).not.toHaveBeenCalledWith("# stale");
});

it("does not write a report that resolves after unmount", async () => {
  const pending = deferred<string>();
  vi.spyOn(desktop, "getStructureReport").mockReturnValue(pending.promise);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });

  const view = render(
    <CopyStructureReport generation={7} unit="compressed" active />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
  view.unmount();
  pending.resolve("# stale");
  await Promise.resolve();
  await Promise.resolve();

  expect(writeText).not.toHaveBeenCalled();
});

it("does not write a report that resolves after its file is deactivated", async () => {
  const pending = deferred<string>();
  vi.spyOn(desktop, "getStructureReport").mockReturnValue(pending.promise);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });

  const view = render(
    <CopyStructureReport generation={7} unit="compressed" active />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
  view.rerender(
    <CopyStructureReport generation={7} unit="compressed" active={false} />,
  );
  pending.resolve("# stale A");
  await Promise.resolve();
  await Promise.resolve();

  expect(writeText).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
