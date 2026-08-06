import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App, formatFileSize } from "./App";
import * as desktop from "./desktop";

vi.mock("./data-grid/DataGrid", () => ({
  DataGrid: () => <section aria-label="Data">Grid data</section>,
}));

let requestSettings: (() => void) | undefined;
let requestOpenSource: (() => void) | undefined;
let reportUpdate: ((update: desktop.UpdateInfo) => void) | undefined;
let reportOpenedSource: (() => void) | undefined;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  requestSettings = undefined;
  requestOpenSource = undefined;
  reportUpdate = undefined;
  reportOpenedSource = undefined;
  vi.spyOn(desktop, "getEngineStatus").mockResolvedValue({
    name: "Viewda data engine",
    version: "0.0.1",
    queryEngineVersion: "v1.5.5",
  });
  vi.spyOn(desktop, "getRecentSources").mockResolvedValue([]);
  vi.spyOn(desktop, "openRecentSource").mockRejectedValue(
    new desktop.OpenSourceError("unsupported"),
  );
  vi.spyOn(desktop, "onOpenSourceRequested").mockImplementation((handler) => {
    requestOpenSource = handler;
    return Promise.resolve(() => {});
  });
  vi.spyOn(desktop, "onSettingsRequested").mockImplementation((handler) => {
    requestSettings = handler;
    return Promise.resolve(() => {});
  });
  vi.spyOn(desktop, "onUpdateAvailable").mockImplementation((handler) => {
    reportUpdate = handler;
    return Promise.resolve(() => {});
  });
  vi.spyOn(desktop, "onOpenedSourceAvailable").mockImplementation((handler) => {
    reportOpenedSource = handler;
    return Promise.resolve(() => {});
  });
  vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
    channel: "stable",
    automaticChecks: true,
  });
  vi.spyOn(desktop, "checkForUpdate").mockResolvedValue(null);
  vi.spyOn(desktop, "setUpdateSettings").mockResolvedValue();
  vi.spyOn(desktop, "discardPendingUpdate").mockResolvedValue();
  vi.spyOn(desktop, "installPendingUpdate").mockResolvedValue();
  vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue(null);
  vi.spyOn(desktop, "takeOpenedSource").mockResolvedValue(null);
  vi.spyOn(desktop, "openReleasesPage").mockResolvedValue();
  vi.spyOn(desktop, "getDefaultApplicationStatus").mockResolvedValue({
    kind: "canSet",
  });
  vi.spyOn(desktop, "setDefaultApplication").mockResolvedValue({
    kind: "default",
  });
});

async function openSettings() {
  await waitFor(() => expect(requestSettings).toBeTypeOf("function"));
  act(() => requestSettings?.());
  return screen.findByRole("dialog", { name: "Settings" });
}

async function readyOpenButton() {
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Open Parquet file…" }),
    ).toBeEnabled(),
  );
  return screen.getByRole("button", { name: "Open Parquet file…" });
}

function expectShortcutHints() {
  const shortcuts = screen.getByLabelText("Keyboard shortcuts");

  expect(within(shortcuts).getByText("Open file")).toBeInTheDocument();
  expect(within(shortcuts).getByText("Settings")).toBeInTheDocument();
  expect(within(shortcuts).getByText("Ctrl+O").tagName).toBe("KBD");
  expect(within(shortcuts).getByText("Ctrl+,").tagName).toBe("KBD");
}

async function openStableDowngrade() {
  vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
    channel: "latest",
    automaticChecks: false,
  });
  vi.spyOn(desktop, "checkForUpdate").mockResolvedValue({
    version: "0.1.0",
    currentVersion: "0.2.0-alpha.1",
    isDowngrade: true,
  });

  render(<App />);
  await openSettings();
  fireEvent.change(screen.getByLabelText("Update channel"), {
    target: { value: "stable" },
  });

  return screen.findByRole("dialog", {
    name: "Stable is currently older.",
  });
}

describe("App", () => {
  it("shows engine startup without presenting the Open action as ready", () => {
    vi.spyOn(desktop, "getEngineStatus").mockReturnValue(new Promise(() => {}));
    render(<App />);

    expect(
      screen.getByRole("button", { name: "Open Parquet file…" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Starting the local data engine…"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Your data never leaves this machine."),
    ).not.toBeInTheDocument();
    expect(desktop.getRecentSources).not.toHaveBeenCalled();
    expectShortcutHints();
  });

  it("shows the ready empty state and platform shortcuts", async () => {
    render(<App />);

    await readyOpenButton();
    expect(screen.getByText("No file open")).toHaveClass(
      "file-context",
      "is-empty",
    );
    expect(
      screen.getByText("Your data never leaves this machine."),
    ).toBeInTheDocument();
    expectShortcutHints();
  });

  it("renders recent files and opens the keyboard-selected entry by id", async () => {
    vi.spyOn(desktop, "getRecentSources").mockResolvedValue([
      {
        id: "recent-8",
        name: "people.parquet",
        directory: "~/Data",
      },
      {
        id: "recent-7",
        name: "events.parquet",
        directory: "~/Projects/metrics",
      },
    ]);
    vi.spyOn(desktop, "openRecentSource").mockResolvedValue({
      generation: 1,
      displayName: "events.parquet",
      sizeBytes: 2048,
      rowCount: 4,
      rowGroupCount: 1,
      schema: [],
    });

    render(<App />);
    const list = await screen.findByRole("list", { name: "Recent files" });
    const entries = within(list).getAllByRole("button");
    const firstEntry = entries[0]!;
    const secondEntry = entries[1]!;

    expect(within(firstEntry).getByText("people.parquet")).toHaveClass(
      "recent-file-name",
    );
    expect(within(firstEntry).getByText("~/Data")).toHaveClass(
      "recent-file-directory",
    );
    firstEntry.focus();
    fireEvent.keyDown(firstEntry, { key: "ArrowDown" });
    expect(secondEntry).toHaveFocus();
    fireEvent.keyDown(secondEntry, { key: "Enter" });

    await waitFor(() =>
      expect(desktop.openRecentSource).toHaveBeenCalledWith("recent-7"),
    );
    expect(await screen.findByText("events.parquet")).toHaveClass(
      "file-context",
    );
  });

  it("does not render the recent-files block for an empty list", async () => {
    render(<App />);

    await readyOpenButton();
    await waitFor(() => expect(desktop.getRecentSources).toHaveBeenCalled());
    expect(
      screen.queryByRole("list", { name: "Recent files" }),
    ).not.toBeInTheDocument();
  });

  it("removes a vanished recent file and shows the existing not-found error", async () => {
    vi.spyOn(desktop, "getRecentSources").mockResolvedValue([
      {
        id: "recent-missing",
        name: "gone.parquet",
        directory: "~/Data",
      },
    ]);
    vi.spyOn(desktop, "openRecentSource").mockRejectedValue(
      new desktop.OpenSourceError("notFound"),
    );

    render(<App />);
    const list = await screen.findByRole("list", { name: "Recent files" });
    fireEvent.click(within(list).getByRole("button"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That file is no longer available. Choose it again.",
    );
    expect(
      screen.queryByRole("list", { name: "Recent files" }),
    ).not.toBeInTheDocument();
  });

  it("shows a recoverable startup error", async () => {
    vi.spyOn(desktop, "getEngineStatus").mockRejectedValue(
      new Error("engine unavailable"),
    );

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Restart Viewda and try again.",
    );
    expect(
      screen.queryByRole("button", { name: "Open Parquet file…" }),
    ).not.toBeInTheDocument();
    expect(desktop.getRecentSources).not.toHaveBeenCalled();
    expectShortcutHints();
  });

  it("opens a local source and renders its path-free summary", async () => {
    const openSource = vi.spyOn(desktop, "openLocalSource").mockResolvedValue({
      generation: 1,
      displayName: "people.parquet",
      sizeBytes: 1_300_000,
      rowCount: 1_234_567,
      rowGroupCount: 12,
      schema: [
        {
          name: "created_on",
          physicalType: "INT32",
          logicalType: "Date",
          children: [],
        },
        {
          name: "related_urls",
          physicalType: "GROUP",
          logicalType: "List",
          children: [
            {
              name: "list",
              physicalType: "GROUP",
              logicalType: null,
              children: [
                {
                  name: "element",
                  physicalType: "BYTE_ARRAY",
                  logicalType: "String",
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    });

    const { container } = render(<App />);
    fireEvent.click(await readyOpenButton());

    expect(await screen.findByText("people.parquet")).toHaveClass(
      "file-context",
    );
    expect(screen.queryByText("Parquet source")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Data" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const dataGrid = screen.getByLabelText("Data");
    expect(dataGrid).toHaveTextContent("Grid data");
    fireEvent.click(screen.getByRole("button", { name: "Structure" }));
    expect(screen.getByLabelText("Data")).toBe(dataGrid);
    expect(container.querySelector(".source-heading")).not.toHaveTextContent(
      "people.parquet",
    );

    const facts = screen.getByLabelText("File facts");
    expect(
      Array.from(
        facts.querySelectorAll("dt"),
        ({ textContent }) => textContent,
      ),
    ).toEqual(["Rows", "Row groups", "Fields", "Size"]);
    const factValues = Array.from(facts.querySelectorAll("dd"));
    expect(factValues.map(({ textContent }) => textContent)).toEqual([
      "1,234,567",
      "12",
      "2",
      "1.3 MB",
    ]);
    for (const value of factValues) {
      expect(value).toHaveClass("fact-value");
    }
    expect(within(facts).getByText("1.3 MB")).toHaveAttribute(
      "title",
      "1,300,000 bytes",
    );

    const schema = screen.getByRole("heading", {
      name: "Schema",
    }).parentElement;
    expect(schema).not.toBeNull();
    expect(within(schema!).getByText("INT32 · Date")).toHaveClass(
      "schema-type",
    );
    expect(within(schema!).getByText("GROUP · List")).toHaveClass(
      "schema-type",
    );
    expect(within(schema!).getByText("GROUP")).toHaveClass("schema-type");
    expect(within(schema!).getByText("BYTE_ARRAY · String")).toHaveClass(
      "schema-type",
    );
    expect(schema?.querySelector(".schema-logical")).toBeNull();
    expect(schema?.querySelector("kbd")).toBeNull();
    expect(
      screen.queryByText("Data preview is not in this build yet."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/[/\\]people\.parquet/)).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    expect(screen.getByRole("button", { name: "Data" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Data")).toBe(dataGrid);
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(screen.getByRole("button", { name: "Structure" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    openSource.mockRejectedValueOnce(
      new desktop.OpenSourceError("permissionDenied"),
    );
    await act(async () => requestOpenSource?.());
    expect(screen.getByRole("button", { name: "Data" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Viewda cannot read that file. Check its permissions and try again.",
    );
  });

  it("treats dialog cancellation as an unchanged empty state", async () => {
    vi.spyOn(desktop, "openLocalSource").mockResolvedValue(null);

    render(<App />);
    fireEvent.click(await readyOpenButton());

    expect(
      await screen.findByRole("button", { name: "Open Parquet file…" }),
    ).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders a recoverable source error from the stable taxonomy", async () => {
    vi.spyOn(desktop, "openLocalSource").mockRejectedValue(
      new desktop.OpenSourceError("corruptFooter"),
    );

    render(<App />);
    fireEvent.click(await readyOpenButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Parquet footer is damaged or incomplete.",
    );
    expect(
      screen.getByRole("button", { name: "Open Parquet file…" }),
    ).toBeEnabled();
  });

  it("renders a path-free source forwarded by native file activation", async () => {
    vi.spyOn(desktop, "takeOpenedSource")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        source: {
          generation: 2,
          displayName: "launched.parquet",
          sizeBytes: 128,
          rowCount: 3,
          rowGroupCount: 1,
          schema: [],
        },
        sourceError: null,
      });
    render(<App />);

    await waitFor(() => expect(reportOpenedSource).toBeTypeOf("function"));
    act(() => reportOpenedSource?.());

    expect(await screen.findByText("launched.parquet")).toHaveClass(
      "file-context",
    );
  });

  it("keeps an explicitly opened source ahead of post-update restore", async () => {
    let resolveRestore: (
      state: desktop.PostUpdateState | null,
    ) => void = () => {};
    vi.spyOn(desktop, "takePostUpdateState").mockReturnValue(
      new Promise((resolve) => {
        resolveRestore = resolve;
      }),
    );
    vi.spyOn(desktop, "takeOpenedSource").mockResolvedValue({
      source: {
        generation: 2,
        displayName: "launched.parquet",
        sizeBytes: 128,
        rowCount: 3,
        rowGroupCount: 1,
        schema: [],
      },
      sourceError: null,
    });
    render(<App />);

    expect(await screen.findByText("launched.parquet")).toBeInTheDocument();
    await act(async () => {
      resolveRestore({
        version: "0.1.0",
        source: {
          generation: 1,
          displayName: "restored.parquet",
          sizeBytes: 256,
          rowCount: 6,
          rowGroupCount: 1,
          schema: [],
        },
        sourceError: null,
      });
    });

    expect(screen.getByText("launched.parquet")).toBeInTheDocument();
    expect(screen.queryByText("restored.parquet")).not.toBeInTheDocument();
  });

  it("shows a recoverable error for a missing native file activation", async () => {
    vi.spyOn(desktop, "takeOpenedSource")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ source: null, sourceError: "notFound" });
    render(<App />);

    await waitFor(() => expect(reportOpenedSource).toBeTypeOf("function"));
    act(() => reportOpenedSource?.());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That file is no longer available. Choose it again.",
    );
  });

  it("installs an available update directly from the titlebar", async () => {
    vi.spyOn(desktop, "checkForUpdate").mockResolvedValue({
      version: "0.1.0",
      currentVersion: "0.0.1",
      isDowngrade: false,
    });
    const install = vi
      .spyOn(desktop, "installPendingUpdate")
      .mockReturnValue(new Promise(() => {}));

    render(<App />);

    const indicator = await screen.findByRole("button", {
      name: "update to 0.1.0",
    });
    expect(desktop.checkForUpdate).toHaveBeenCalledWith({
      automaticCheck: true,
    });
    fireEvent.click(indicator);

    expect(install).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "updating…" })).toBeDisabled();
  });

  it("uses the same titlebar indicator for an update found by the native menu", async () => {
    vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
      channel: "stable",
      automaticChecks: false,
    });
    render(<App />);

    await waitFor(() => expect(reportUpdate).toBeTypeOf("function"));
    expect(desktop.checkForUpdate).not.toHaveBeenCalled();
    act(() =>
      reportUpdate?.({
        version: "0.0.3",
        currentVersion: "0.0.1",
        isDowngrade: false,
      }),
    );

    expect(
      screen.getByRole("button", { name: "update to 0.0.3" }),
    ).toBeInTheDocument();
  });

  it("opens Settings from the native menu and persists update controls", async () => {
    vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
      channel: "stable",
      automaticChecks: false,
    });
    const persist = vi.spyOn(desktop, "setUpdateSettings");
    render(<App />);

    const dialog = await openSettings();
    expect(
      await within(dialog).findByRole("button", { name: "Make default" }),
    ).toBeInTheDocument();
    const defaultApplicationLabel = within(dialog).getByText(
      "Default application",
    );
    const defaultApplicationCopy =
      defaultApplicationLabel.closest(".settings-row-copy");
    expect(defaultApplicationCopy).toContainElement(
      within(dialog).getByText("Open .parquet files in Viewda by default."),
    );
    expect(defaultApplicationLabel).toHaveClass("settings-row-label");
    expect(
      within(dialog).getByRole("button", { name: "Make default" }),
    ).toHaveClass("tonal-button");
    expect(within(dialog).getByText("0.0.1 · DuckDB v1.5.5")).toHaveClass(
      "settings-version",
    );
    const channel = screen.getByLabelText("Update channel");
    expect(channel).toHaveFocus();
    fireEvent.change(channel, { target: { value: "latest" } });
    await waitFor(() =>
      expect(persist).toHaveBeenCalledWith({
        channel: "latest",
        automaticChecks: false,
      }),
    );

    fireEvent.click(screen.getByLabelText("Automatic update checks"));
    await waitFor(() =>
      expect(persist).toHaveBeenCalledWith({
        channel: "latest",
        automaticChecks: true,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(
      await screen.findByText("Viewda is up to date."),
    ).toBeInTheDocument();
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Make default" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });

  it("changes the default application only after the Settings action", async () => {
    const makeDefault = vi.spyOn(desktop, "setDefaultApplication");
    render(<App />);

    const dialog = await openSettings();
    expect(makeDefault).not.toHaveBeenCalled();
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Make default" }),
    );

    expect(
      await within(dialog).findByText("Viewda is the default"),
    ).toHaveClass("settings-note");
    expect(makeDefault).toHaveBeenCalledOnce();
  });

  it("defers the Windows default choice to system Settings", async () => {
    vi.spyOn(desktop, "getDefaultApplicationStatus").mockResolvedValue({
      kind: "systemSettings",
    });
    render(<App />);

    const dialog = await openSettings();
    expect(
      await within(dialog).findByText("Finish the choice in Windows Settings."),
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open Default apps" }),
    );
    expect(desktop.setDefaultApplication).toHaveBeenCalledOnce();
  });

  it("disables the Linux action when xdg-utils is unavailable", async () => {
    vi.spyOn(desktop, "getDefaultApplicationStatus").mockResolvedValue({
      kind: "unavailable",
    });
    render(<App />);

    const dialog = await openSettings();
    expect(
      await within(dialog).findByText("xdg-utils is not installed."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Make default" }),
    ).toBeDisabled();
  });

  it("disables the action for an unintegrated AppImage", async () => {
    vi.spyOn(desktop, "getDefaultApplicationStatus").mockResolvedValue({
      kind: "unintegratedAppImage",
    });
    render(<App />);

    const dialog = await openSettings();
    expect(
      await within(dialog).findByText("Integrate the AppImage first."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Make default" }),
    ).toBeDisabled();
  });

  it("surfaces a prerelease from the Latest channel without changing its version", async () => {
    vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
      channel: "latest",
      automaticChecks: false,
    });
    vi.spyOn(desktop, "checkForUpdate").mockResolvedValue({
      version: "0.2.0-beta.2",
      currentVersion: "0.2.0-alpha.3",
      isDowngrade: false,
    });
    render(<App />);

    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));

    expect(
      await screen.findByRole("button", { name: "update to 0.2.0-beta.2" }),
    ).toBeInTheDocument();
  });

  it("restores the source and removes post-update status after one minute", async () => {
    vi.useFakeTimers();
    vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue({
      version: "0.1.0",
      sourceError: null,
      source: {
        generation: 2,
        displayName: "restored.parquet",
        sizeBytes: 4096,
        rowCount: 12,
        rowGroupCount: 2,
        schema: [],
      },
    });
    render(<App />);
    await act(async () => Promise.resolve());

    expect(screen.getByText("restored.parquet")).toHaveClass("file-context");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("updated to 0.1.0 · what's new");

    act(() => vi.advanceTimersByTime(59_800));
    expect(status).toHaveClass("is-dismissing");
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("opens the Rust-owned releases list and dismisses post-update status on click", async () => {
    vi.useFakeTimers();
    vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue({
      version: "0.1.0-alpha.2",
      sourceError: null,
      source: null,
    });
    const openPage = vi.spyOn(desktop, "openReleasesPage");
    render(<App />);
    await act(async () => Promise.resolve());

    const status = screen.getByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "what's new" }));
    expect(openPage.mock.calls).toEqual([[]]);
    expect(status).toBeInTheDocument();

    fireEvent.click(status);
    expect(status).toHaveClass("is-dismissing");
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("simulates the UI flow without calling the installer", async () => {
    vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
      channel: "stable",
      automaticChecks: false,
    });
    const install = vi.spyOn(desktop, "installPendingUpdate");
    render(<App />);
    await openSettings();
    const summary = screen.getByText("Debug — for Viewda developers", {
      selector: "summary",
    });
    const debug = summary.closest("details");
    expect(debug).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(debug).toHaveAttribute("open");
    fireEvent.click(
      screen.getByRole("button", { name: "Simulate update flow" }),
    );

    const indicator = screen.getByRole("button", {
      name: /update to 99\.99\.99 simulated/i,
    });
    vi.useFakeTimers();
    fireEvent.click(indicator);
    expect(install).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /updating… simulated/i }),
    ).toBeDisabled();

    act(() => vi.advanceTimersByTime(800));
    expect(screen.getByRole("status")).toHaveTextContent(
      "updated to 99.99.99 · what's new simulated",
    );
    expect(install).not.toHaveBeenCalled();
  });

  it("asks whether to downgrade or wait when moving from latest to stable", async () => {
    const discard = vi.spyOn(desktop, "discardPendingUpdate");

    await openStableDowngrade();
    expect(desktop.checkForUpdate).toHaveBeenCalledWith({
      allowDowngrade: true,
    });
    const wait = screen.getByRole("button", { name: "Wait for next stable" });
    await waitFor(() => expect(wait).toHaveFocus());
    fireEvent.keyDown(wait, { key: "Escape" });
    await waitFor(() => expect(discard).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("dialog", {
        name: "Stable is currently older.",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
  });

  it("installs a stable downgrade only after the user chooses it", async () => {
    const install = vi
      .spyOn(desktop, "installPendingUpdate")
      .mockReturnValue(new Promise(() => {}));

    await openStableDowngrade();
    fireEvent.click(screen.getByRole("button", { name: "Downgrade to 0.1.0" }));

    expect(install).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
  });

  it("explains why a Debian package cannot update itself", async () => {
    vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
      channel: "stable",
      automaticChecks: false,
    });
    vi.spyOn(desktop, "checkForUpdate").mockRejectedValue(
      new desktop.UpdateCommandError("manualInstall"),
    );

    render(<App />);
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));

    expect(
      await screen.findByText(
        "This package uses manual updates. Install the AppImage to update inside Viewda.",
      ),
    ).toBeInTheDocument();
  });
});

describe("shortcutModifierFor", () => {
  it("uses native-looking shortcuts on Apple and non-Apple platforms", () => {
    expect(desktop.shortcutModifierFor("MacIntel")).toBe("⌘");
    expect(desktop.shortcutModifierFor("Win32")).toBe("Ctrl+");
    expect(desktop.shortcutModifierFor("Linux x86_64")).toBe("Ctrl+");
  });
});

describe("formatFileSize", () => {
  it.each([
    [999, "999 B"],
    [1_000, "1.0 kB"],
    [999_999, "1.0 MB"],
    [1_300_000, "1.3 MB"],
    [2_500_000_000, "2.5 GB"],
  ])("formats %i bytes as %s", (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });
});
