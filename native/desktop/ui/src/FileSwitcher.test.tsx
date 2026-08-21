import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileSwitcher, middleTruncate } from "./FileSwitcher";
import { shortcutModifier } from "./desktop";
import type { OpenFile } from "./open-files";

afterEach(cleanup);

function file(
  generation: number,
  name: string,
  directory: string,
  active = false,
): OpenFile {
  return {
    generation,
    name,
    directory,
    path: `/data/${directory}/${name}`,
    active,
    busy: false,
    mode: "data",
    summary: {
      generation,
      displayName: name,
      sizeBytes: 8,
      rowCount: 1,
      rowGroupCount: 1,
      schema: [],
    },
  };
}

function props(files: OpenFile[] = []) {
  return {
    files,
    recentSources: [
      {
        id: "recent-open",
        name: "open.parquet",
        directory: "current",
        path: "/data/current/open.parquet",
      },
      {
        id: "recent-only",
        name: "archive.parquet",
        directory: "old",
        path: "/archive/full/path/old/archive.parquet",
      },
    ],
    opening: false,
    onActivate: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn().mockResolvedValue(true),
    onDismiss: vi.fn(),
    onContextMenu: vi.fn(),
    onOpenFile: vi.fn().mockResolvedValue(undefined),
    onOpenRecent: vi.fn().mockResolvedValue(undefined),
    onRemoveRecent: vi.fn().mockResolvedValue(undefined),
  };
}

function renderedDirectoryLabels(files: OpenFile[]) {
  const view = render(<FileSwitcher {...props(files)} />);
  const labels = new Map(
    Array.from(
      document.querySelectorAll(".file-switcher-row[title]"),
      (row) => [
        row.getAttribute("title"),
        row.querySelector(".file-switcher-directory")?.textContent,
      ],
    ),
  );
  view.unmount();
  return labels;
}

describe("FileSwitcher", () => {
  it("lists open files in MRU order and excludes them from Recent", () => {
    const input = props([
      file(2, "second.parquet", "current", true),
      file(1, "open.parquet", "current"),
    ]);
    render(<FileSwitcher {...input} />);

    const open = within(screen.getByRole("group", { name: "Open files" }));
    expect(open.getAllByRole("option").map((row) => row.textContent)).toEqual([
      "✓second.parquetcurrent",
      "open.parquetcurrent",
    ]);
    const recent = within(screen.getByRole("group", { name: "Recent" }));
    expect(recent.getAllByRole("option")).toHaveLength(1);
    expect(recent.getByText("archive.parquet")).toBeInTheDocument();
  });

  it("filters names and paths and opens the keyboard-highlighted result", () => {
    const input = props([file(1, "trips.parquet", "2026/07", true)]);
    render(<FileSwitcher {...input} />);
    const search = screen.getByRole("combobox", { name: "Search files" });

    fireEvent.change(search, { target: { value: "archive/full" } });
    expect(screen.queryByText("trips.parquet")).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Enter" });

    expect(input.onOpenRecent).toHaveBeenCalledWith("recent-only");
  });

  it("cycles the highlight and removes a recent entry with the platform shortcut", () => {
    const input = props([file(1, "open.parquet", "current", true)]);
    render(<FileSwitcher {...input} />);
    const search = screen.getByRole("combobox", { name: "Search files" });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Backspace", ctrlKey: true });

    expect(input.onRemoveRecent).toHaveBeenCalledWith("recent-only");
  });

  it("clamps selection when the last highlighted row is deleted", () => {
    const input = props([file(1, "other.parquet", "/data/current", true)]);
    const { rerender } = render(<FileSwitcher {...input} />);
    const search = screen.getByRole("combobox", { name: "Search files" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      "file-switcher-recent-recent-only",
    );

    fireEvent.keyDown(search, { key: "Backspace", ctrlKey: true });
    input.recentSources = input.recentSources.slice(0, -1);
    rerender(<FileSwitcher {...input} />);

    const newLast = screen.getByRole("option", { name: /open\.parquet/ });
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      "file-switcher-recent-recent-open",
    );
    expect(newLast).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(input.onOpenRecent).toHaveBeenCalledWith("recent-open");
  });

  it("exposes close and context actions for open rows", () => {
    const input = props([file(1, "open.parquet", "current", true)]);
    render(<FileSwitcher {...input} />);
    const row = screen.getByRole("option", { name: /open\.parquet/ });
    const close = screen.getByRole("button", { name: "Close open.parquet" });
    const open = screen.getByRole("button", { name: /Open File/ });

    expect(fireEvent.keyDown(close, { key: "Enter" })).toBe(true);
    fireEvent.click(close);
    expect(fireEvent.keyDown(open, { key: "Enter" })).toBe(true);
    fireEvent.click(open);
    fireEvent.contextMenu(row);

    expect(input.onClose).toHaveBeenCalledWith(1);
    expect(input.onOpenFile).toHaveBeenCalledOnce();
    expect(input.onContextMenu).toHaveBeenCalledWith(1, 0, 0);
    expect(input.onActivate).not.toHaveBeenCalled();
  });

  it("restores search focus after an open row is removed", async () => {
    const input = props([
      file(1, "first.parquet", "current", true),
      file(2, "second.parquet", "current"),
    ]);
    const { rerender } = render(<FileSwitcher {...input} />);
    const close = screen.getByRole("button", { name: "Close first.parquet" });
    close.focus();

    fireEvent.click(close);
    input.files = input.files.slice(1);
    rerender(<FileSwitcher {...input} />);

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Search files" }),
      ).toHaveFocus(),
    );
  });

  it("shows the platform shortcut until the user starts searching", () => {
    render(<FileSwitcher {...props()} />);
    const search = screen.getByRole("combobox", { name: "Search files" });

    expect(
      screen.getByText(`${shortcutModifier}P`, { selector: "kbd" }),
    ).toHaveAttribute("aria-hidden", "true");

    fireEvent.change(search, { target: { value: "archive" } });
    expect(
      screen.queryByText(`${shortcutModifier}P`, { selector: "kbd" }),
    ).not.toBeInTheDocument();
  });

  it("uses canonical paths for identity, tooltips, and colliding recent files", () => {
    const input = props([file(1, "open.parquet", "current", true)]);
    input.recentSources[0] = {
      ...input.recentSources[0]!,
      path: "/different/current/open.parquet",
    };
    render(<FileSwitcher {...input} />);

    expect(screen.getAllByText("open.parquet")).toHaveLength(2);
    expect(
      screen
        .getByRole("option", { name: /archive\.parquet/ })
        .closest(".file-switcher-row"),
    ).toHaveAttribute("title", "/archive/full/path/old/archive.parquet");
  });

  it("renders a real middle ellipsis instead of relying on end clipping", () => {
    const value = "/one/two/three/four/five/six/seven/eight/nine/ten";
    const truncated = middleTruncate(value, 21);

    expect(truncated).toMatch(/^\/one\/two\/t…/);
    expect(truncated).toMatch(/\/nine\/ten$/);
    expect(truncated).toHaveLength(21);
  });

  it("keeps colliding last-parent paths visibly distinct", () => {
    const first = `/very-long-root/common/${"x".repeat(50)}alpha${"y".repeat(50)}/archive/quarter/exports/shared`;
    const second = `/very-long-root/common/${"x".repeat(50)}beta${"y".repeat(50)}/archive/quarter/exports/shared`;
    const files = [
      {
        ...file(1, "part.parquet", first, true),
        path: `${first}/part.parquet`,
      },
      { ...file(2, "part.parquet", second), path: `${second}/part.parquet` },
    ];
    const forward = renderedDirectoryLabels(files);
    const reversed = renderedDirectoryLabels([...files].reverse());
    const directories = [
      forward.get(files[0]!.path),
      forward.get(files[1]!.path),
    ];
    expect(directories[0]).toContain("alpha");
    expect(directories[1]).toContain("beta");
    expect(new Set(directories).size).toBe(files.length);
    expect(reversed.get(files[0]!.path)).toBe(directories[0]);
    expect(reversed.get(files[1]!.path)).toBe(directories[1]);

    render(<FileSwitcher {...props(files)} />);
    expect(
      screen
        .getByRole("option", { name: /part\.parquet — .*alpha/ })
        .closest(".file-switcher-row"),
    ).toHaveAttribute("title", `${first}/part.parquet`);
    expect(
      screen
        .getByRole("option", { name: /part\.parquet — .*beta/ })
        .closest(".file-switcher-row"),
    ).toHaveAttribute("title", `${second}/part.parquet`);
  });

  it("keeps final path signatures unique across separate collision groups", () => {
    const directories = [
      `/root/group-one/${"a".repeat(60)}/shared`,
      `/root/group-one/${"a".repeat(61)}/shared`,
      `/root/group-two/${"a".repeat(60)}/shared`,
      `/root/group-two/${"a".repeat(61)}/shared`,
    ];
    const files = directories.map((directory, index) => ({
      ...file(index + 1, "part.parquet", directory, index === 0),
      path: `${directory}/part.parquet`,
    }));

    const forward = renderedDirectoryLabels(files);
    const reversed = renderedDirectoryLabels([...files].reverse());
    const labels = files.map(({ path }) => forward.get(path));

    expect(new Set(labels).size).toBe(files.length);
    files.forEach(({ path }, index) => {
      expect(reversed.get(path)).toBe(labels[index]);
    });
  });

  it("does not split Unicode code points while truncating", () => {
    const truncated = middleTruncate("😀abcdefghij🚀", 7);

    expect(truncated).toBe("😀ab…ij🚀");
    expect(Array.from(truncated)).toHaveLength(7);
    expect(truncated).not.toContain("�");
  });
});
