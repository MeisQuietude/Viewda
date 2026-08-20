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
let requestCloseSource: ((generation: number) => void) | undefined;
let reportUpdate: ((update: desktop.UpdateInfo) => void) | undefined;
let reportOpenedSource: (() => void) | undefined;
let requestDataExportClose:
  ((dialog: desktop.DataExportCloseDialog) => void) | undefined;
let systemDark = false;
let themeChangeListeners = new Set<EventListener>();
let listedSources: desktop.OpenedSourceEntry[] = [];

function listedSource(
  generation: number,
  name: string,
  active = true,
): desktop.OpenedSourceEntry {
  return {
    generation,
    name,
    directory: "~/Data",
    path: `/home/test/Data/${name}`,
    active,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

beforeEach(() => {
  requestSettings = undefined;
  requestOpenSource = undefined;
  requestCloseSource = undefined;
  reportUpdate = undefined;
  reportOpenedSource = undefined;
  requestDataExportClose = undefined;
  systemDark = false;
  themeChangeListeners = new Set();
  listedSources = [];
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return systemDark;
      },
      addEventListener: (_type: string, listener: EventListener) =>
        themeChangeListeners.add(listener),
      removeEventListener: (_type: string, listener: EventListener) =>
        themeChangeListeners.delete(listener),
    })),
  );
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
  vi.spyOn(desktop, "onDataExportCloseRequested").mockImplementation(
    (handler) => {
      requestDataExportClose = handler;
      return Promise.resolve(() => {});
    },
  );
  vi.spyOn(desktop, "getPendingDataExportCloseDialog").mockResolvedValue(null);
  vi.spyOn(desktop, "resolveDataExportCloseDialog").mockResolvedValue(true);
  vi.spyOn(desktop, "getUpdateSettings").mockResolvedValue({
    channel: "stable",
    automaticChecks: true,
  });
  vi.spyOn(desktop, "getDataViewSettings").mockResolvedValue({
    memoryLimit: "mb384",
  });
  vi.spyOn(desktop, "checkForUpdate").mockResolvedValue(null);
  vi.spyOn(desktop, "setUpdateSettings").mockResolvedValue();
  vi.spyOn(desktop, "setDataViewSettings").mockResolvedValue();
  vi.spyOn(desktop, "setThemePreference").mockResolvedValue();
  vi.spyOn(desktop, "syncSystemTheme").mockResolvedValue();
  vi.spyOn(desktop, "discardPendingUpdate").mockResolvedValue();
  vi.spyOn(desktop, "installPendingUpdate").mockResolvedValue(true);
  vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue(null);
  vi.spyOn(desktop, "takeOpenedSource").mockResolvedValue(null);
  vi.spyOn(desktop, "listOpenedSources").mockImplementation(async () =>
    listedSources.map((entry) => ({ ...entry })),
  );
  vi.spyOn(desktop, "activateOpenedSource").mockResolvedValue();
  vi.spyOn(desktop, "cycleOpenedSource").mockResolvedValue(null);
  vi.spyOn(desktop, "closeOpenedSource").mockResolvedValue(true);
  vi.spyOn(desktop, "removeRecentSource").mockResolvedValue();
  vi.spyOn(desktop, "revealOpenedSource").mockResolvedValue();
  vi.spyOn(desktop, "onCloseSourceRequested").mockImplementation((handler) => {
    requestCloseSource = handler;
    return Promise.resolve(() => {});
  });
  vi.spyOn(desktop, "onRecentSourcesChanged").mockResolvedValue(() => {});
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

function renderWithOpenSources(...sources: desktop.OpenedSourceEntry[]) {
  listedSources = sources;
  vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue({
    version: "0.1.0",
    sourceError: null,
    sources: sources.map((source) => ({
      generation: source.generation,
      displayName: source.name,
      sizeBytes: 8,
      rowCount: 1,
      rowGroupCount: 1,
      schema: [],
    })),
  });
  render(<App />);
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

    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(
      await screen.findByRole("region", { name: "File switcher" }),
    ).toBeInTheDocument();
  });

  it("renders recent files and opens the keyboard-selected entry by id", async () => {
    listedSources = [listedSource(1, "events.parquet")];
    vi.spyOn(desktop, "getRecentSources").mockResolvedValue([
      {
        id: "recent-8",
        name: "people.parquet",
        directory: "~/Data",
        path: "/home/tester/Data/people.parquet",
      },
      {
        id: "recent-7",
        name: "events.parquet",
        directory: "~/Projects/metrics",
        path: "/home/tester/Projects/metrics/events.parquet",
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
    expect(
      (await screen.findAllByText("events.parquet")).some((element) =>
        element.closest(".file-context"),
      ),
    ).toBe(true);
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
        path: "/home/tester/Data/gone.parquet",
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
    listedSources = [listedSource(1, "people.parquet")];
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

    expect(
      (await screen.findByText("people.parquet")).closest(".file-context"),
    ).not.toBeNull();
    expect(screen.queryByText("Parquet source")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Data" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const dataGrid = await screen.findByLabelText("Data");
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
    listedSources = [listedSource(2, "launched.parquet")];
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

    expect(
      (await screen.findByText("launched.parquet")).closest(".file-context"),
    ).not.toBeNull();
  });

  it("merges a partial post-update restore after an explicit activation", async () => {
    listedSources = [listedSource(2, "launched.parquet")];
    let resolveRestore: (
      state: desktop.PostUpdateState | null,
    ) => void = () => {};
    vi.spyOn(desktop, "takePostUpdateState").mockReturnValue(
      new Promise((resolve) => {
        resolveRestore = resolve;
      }),
    );
    vi.spyOn(desktop, "takeOpenedSource")
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
      })
      .mockResolvedValue(null);
    render(<App />);

    expect(await screen.findByText("launched.parquet")).toBeInTheDocument();
    listedSources = [
      listedSource(2, "launched.parquet"),
      { ...listedSource(1, "restored.parquet"), active: false },
    ];
    await act(async () => {
      resolveRestore({
        version: "0.1.0",
        sources: [
          {
            generation: 1,
            displayName: "restored.parquet",
            sizeBytes: 256,
            rowCount: 6,
            rowGroupCount: 1,
            schema: [],
          },
        ],
        sourceError: null,
      });
    });

    expect(screen.getByText("launched.parquet")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(
      await screen.findByRole("option", { name: /restored\.parquet/ }),
    ).toBeInTheDocument();
  });

  it("switches and closes independent file sessions in native MRU order", async () => {
    listedSources = [
      {
        ...listedSource(2, "part-0.parquet"),
        directory: "~/data/2026/08",
        path: "/data/2026/08/part-0.parquet",
      },
      {
        ...listedSource(1, "part-0.parquet", false),
        directory: "~/data/2026/07",
        path: "/data/2026/07/part-0.parquet",
      },
    ];
    vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue({
      version: "0.1.0",
      sourceError: null,
      sources: [
        {
          generation: 2,
          displayName: "part-0.parquet",
          sizeBytes: 16,
          rowCount: 2,
          rowGroupCount: 1,
          schema: [],
        },
        {
          generation: 1,
          displayName: "part-0.parquet",
          sizeBytes: 8,
          rowCount: 1,
          rowGroupCount: 1,
          schema: [],
        },
      ],
    });

    render(<App />);
    const title = await screen.findByRole("button", { name: "Switch files" });
    expect(title).toHaveTextContent("part-0.parquet— 08· 2▾");

    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    const openRows = await screen.findAllByRole("option", {
      name: /part-0\.parquet/,
    });
    expect(
      openRows.map((row) =>
        row.closest(".file-switcher-row")?.getAttribute("title"),
      ),
    ).toEqual(["/data/2026/08/part-0.parquet", "/data/2026/07/part-0.parquet"]);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search files" }), {
      key: "Escape",
    });

    vi.spyOn(desktop, "cycleOpenedSource").mockImplementation(async () => {
      listedSources = [
        { ...listedSources[1]!, active: true },
        { ...listedSources[0]!, active: false },
      ];
      return 1;
    });
    expect(fireEvent.keyDown(window, { key: "Tab", ctrlKey: true })).toBe(
      false,
    );
    await waitFor(() =>
      expect(desktop.cycleOpenedSource).toHaveBeenCalledWith(false),
    );
    act(() => requestCloseSource?.(2));
    await waitFor(() =>
      expect(desktop.closeOpenedSource).toHaveBeenCalledWith(2),
    );
  });

  it("dismisses the switcher when native closes its last open file", async () => {
    renderWithOpenSources(listedSource(1, "single.parquet"));
    vi.spyOn(desktop, "closeOpenedSource").mockImplementation(async () => {
      listedSources = [];
      return true;
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Switch files" }),
    );
    await waitFor(() => expect(requestCloseSource).toBeTypeOf("function"));
    act(() => requestCloseSource?.(1));

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "File switcher" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("No file open")).toBeInTheDocument();
  });

  it.each([
    {
      condition: "export cancellation leaves native close unconfirmed",
      outcome: false,
      expectedListCalls: 0,
    },
    {
      condition: "native close rejects while the file remains open",
      outcome: new Error("native close failed"),
      expectedListCalls: 1,
    },
  ])(
    "keeps the switcher open when $condition",
    async ({ outcome, expectedListCalls }) => {
      renderWithOpenSources(listedSource(1, "single.parquet"));
      let settleClose = () => {};
      vi.spyOn(desktop, "closeOpenedSource").mockImplementation(
        () =>
          new Promise<boolean>((resolve, reject) => {
            settleClose = () => {
              if (outcome instanceof Error) reject(outcome);
              else resolve(outcome);
            };
          }),
      );

      fireEvent.click(
        await screen.findByRole("button", { name: "Switch files" }),
      );
      const listCalls = vi.mocked(desktop.listOpenedSources).mock.calls.length;
      fireEvent.click(
        screen.getByRole("button", { name: "Close single.parquet" }),
      );

      await waitFor(() =>
        expect(desktop.closeOpenedSource).toHaveBeenCalledWith(1),
      );
      await act(async () => settleClose());
      expect(desktop.listOpenedSources).toHaveBeenCalledTimes(
        listCalls + expectedListCalls,
      );
      expect(
        screen.getByRole("region", { name: "File switcher" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: /single\.parquet/ }),
      ).toBeInTheDocument();
    },
  );

  it("dismisses after a rejected native close if the source is gone", async () => {
    renderWithOpenSources(listedSource(1, "single.parquet"));
    vi.spyOn(desktop, "closeOpenedSource").mockImplementation(async () => {
      listedSources = [];
      throw new Error("native response was lost");
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Switch files" }),
    );
    act(() => requestCloseSource?.(1));

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "File switcher" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("No file open")).toBeInTheDocument();
  });

  it("dismisses after two open rows are closed without waiting between clicks", async () => {
    renderWithOpenSources(
      listedSource(2, "second.parquet"),
      listedSource(1, "first.parquet", false),
    );
    vi.spyOn(desktop, "closeOpenedSource").mockImplementation(
      async (generation) => {
        listedSources = listedSources.filter(
          (source) => source.generation !== generation,
        );
        return true;
      },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Switch files" }),
    );
    const firstClose = screen.getByRole("button", {
      name: "Close first.parquet",
    });
    const secondClose = screen.getByRole("button", {
      name: "Close second.parquet",
    });
    fireEvent.click(firstClose);
    fireEvent.click(secondClose);

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "File switcher" }),
      ).not.toBeInTheDocument(),
    );
    expect(desktop.closeOpenedSource).toHaveBeenCalledTimes(2);
  });

  it("ignores an older empty listing after a newer file is synchronized", async () => {
    renderWithOpenSources(listedSource(1, "old.parquet"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch files" }),
    );
    await waitFor(() => expect(reportOpenedSource).toBeTypeOf("function"));

    let resolveOldListing: (
      entries: desktop.OpenedSourceEntry[],
    ) => void = () => undefined;
    vi.mocked(desktop.listOpenedSources)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldListing = resolve;
          }),
      )
      .mockResolvedValueOnce([listedSource(2, "new.parquet")]);
    const listCalls = vi.mocked(desktop.listOpenedSources).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Close old.parquet" }));
    await waitFor(() =>
      expect(desktop.listOpenedSources).toHaveBeenCalledTimes(listCalls + 1),
    );

    vi.mocked(desktop.takeOpenedSource)
      .mockResolvedValueOnce({
        source: {
          generation: 2,
          displayName: "new.parquet",
          sizeBytes: 8,
          rowCount: 1,
          rowGroupCount: 1,
          schema: [],
        },
        sourceError: null,
      })
      .mockResolvedValueOnce(null);
    act(() => reportOpenedSource?.());

    expect(
      await screen.findByRole("option", { name: /new\.parquet/ }),
    ).toBeInTheDocument();
    const recentCalls = vi.mocked(desktop.getRecentSources).mock.calls.length;
    await act(async () => resolveOldListing([]));
    await waitFor(() =>
      expect(desktop.getRecentSources).toHaveBeenCalledTimes(recentCalls + 1),
    );

    expect(
      screen.getByRole("option", { name: /new\.parquet/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No file open")).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "File switcher" }),
    ).toBeInTheDocument();
  });

  it("captures Ctrl+Tab and serializes rapid native MRU cycles", async () => {
    listedSources = [listedSource(1, "single.parquet")];
    vi.spyOn(desktop, "takeOpenedSource")
      .mockResolvedValueOnce({
        source: {
          generation: 1,
          displayName: "single.parquet",
          sizeBytes: 8,
          rowCount: 1,
          rowGroupCount: 1,
          schema: [],
        },
        sourceError: null,
      })
      .mockResolvedValue(null);
    render(<App />);
    expect(await screen.findByText("single.parquet")).toBeInTheDocument();

    let resolveFirst = () => {};
    vi.mocked(desktop.cycleOpenedSource)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = () => resolve(1);
          }),
      )
      .mockResolvedValue(null);

    expect(fireEvent.keyDown(window, { key: "Tab", ctrlKey: true })).toBe(
      false,
    );
    expect(fireEvent.keyDown(window, { key: "Tab", ctrlKey: true })).toBe(
      false,
    );
    await waitFor(() =>
      expect(desktop.cycleOpenedSource).toHaveBeenCalledOnce(),
    );
    act(resolveFirst);
    await waitFor(() =>
      expect(desktop.cycleOpenedSource).toHaveBeenCalledTimes(2),
    );
    expect(desktop.cycleOpenedSource).toHaveBeenNthCalledWith(2, false);
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

  it("restores a pending export close dialog when the webview mounts", async () => {
    vi.mocked(desktop.getPendingDataExportCloseDialog).mockResolvedValue({
      message:
        "“orders-view.csv” is still being exported. If you close Viewda now, the unfinished file will be deleted.",
      destructiveButton: "Close Viewda",
    });

    render(<App />);

    const dialog = await screen.findByRole("dialog", {
      name: "Export in progress",
    });
    expect(dialog).toHaveTextContent("orders-view.csv");
    expect(
      within(dialog).getByRole("button", { name: "Close Viewda" }),
    ).toBeInTheDocument();
  });

  it("keeps a running export when the close dialog is dismissed", async () => {
    render(<App />);

    await waitFor(() => expect(requestDataExportClose).toBeTypeOf("function"));
    act(() =>
      requestDataExportClose?.({
        message:
          "“orders-view.csv” is still being exported. If you close Viewda now, the unfinished file will be deleted.",
        destructiveButton: "Close Viewda",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Export in progress",
    });
    expect(dialog).toHaveTextContent("orders-view.csv");
    expect(dialog).toHaveTextContent("unfinished file will be deleted");
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Keep Exporting" }),
      ).toHaveFocus(),
    );

    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() =>
      expect(desktop.resolveDataExportCloseDialog).toHaveBeenCalledWith(false),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses the explicit destructive action to cancel the export and close", async () => {
    render(<App />);

    await waitFor(() => expect(requestDataExportClose).toBeTypeOf("function"));
    act(() =>
      requestDataExportClose?.({
        message: "2 exports are still running.",
        destructiveButton: "Close Viewda",
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Close Viewda" }),
    );

    await waitFor(() =>
      expect(desktop.resolveDataExportCloseDialog).toHaveBeenCalledWith(true),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("installs an available update directly from the titlebar", async () => {
    vi.spyOn(desktop, "checkForUpdate").mockResolvedValue({
      version: "0.1.0",
      currentVersion: "0.0.1",
      isDowngrade: false,
    });
    const install = vi
      .spyOn(desktop, "installPendingUpdate")
      .mockImplementation((onProgress) => {
        onProgress({ percent: 37 });
        return new Promise<boolean>(() => {});
      });

    render(<App />);

    const indicator = await screen.findByRole("button", {
      name: "update to 0.1.0",
    });
    expect(desktop.checkForUpdate).toHaveBeenCalledWith({
      automaticCheck: true,
    });
    fireEvent.click(indicator);

    expect(install).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("updating…");
    expect(
      screen.getByRole("progressbar", { name: "Downloading update" }),
    ).toHaveAttribute("aria-valuenow", "37");
  });

  it("shows indeterminate progress when the update size is unknown", async () => {
    vi.spyOn(desktop, "checkForUpdate").mockResolvedValue({
      version: "0.1.0",
      currentVersion: "0.0.1",
      isDowngrade: false,
    });
    vi.spyOn(desktop, "installPendingUpdate").mockReturnValue(
      new Promise<boolean>(() => {}),
    );

    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "update to 0.1.0" }),
    );

    const progress = screen.getByRole("progressbar", {
      name: "Downloading update",
    });
    expect(progress).toHaveClass("is-indeterminate");
    expect(progress).not.toHaveAttribute("aria-valuenow");
  });

  it("keeps a failed update actionable for retry", async () => {
    vi.spyOn(desktop, "checkForUpdate").mockResolvedValue({
      version: "0.1.0",
      currentVersion: "0.0.1",
      isDowngrade: false,
    });
    const install = vi
      .spyOn(desktop, "installPendingUpdate")
      .mockRejectedValueOnce(new Error("download failed"))
      .mockReturnValue(new Promise<boolean>(() => {}));

    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "update to 0.1.0" }),
    );

    const retry = await screen.findByRole("button", {
      name: "update to 0.1.0",
    });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);

    expect(install).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("updating…");
  });

  it("keeps an available update when the export cancellation is declined", async () => {
    vi.spyOn(desktop, "checkForUpdate").mockResolvedValue({
      version: "0.1.0",
      currentVersion: "0.0.1",
      isDowngrade: false,
    });
    vi.spyOn(desktop, "installPendingUpdate").mockResolvedValue(false);

    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: "update to 0.1.0" }),
    );

    expect(
      await screen.findByRole("button", { name: "update to 0.1.0" }),
    ).toBeEnabled();
    expect(
      screen.queryByText("The update could not be installed. Try again."),
    ).not.toBeInTheDocument();
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
    const persistMemory = vi.spyOn(desktop, "setDataViewSettings");
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
    expect(
      within(dialog).getByText(/Grid windows are not affected/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/up to 90% of the drive's currently free space/),
    ).toBeInTheDocument();
    const performanceHelp = within(dialog)
      .getByText("How memory and temporary disk work", { selector: "summary" })
      .closest("details");
    expect(performanceHelp).not.toHaveAttribute("open");
    fireEvent.change(within(dialog).getByLabelText("Preparation memory"), {
      target: { value: "mb1536" },
    });
    await waitFor(() =>
      expect(persistMemory).toHaveBeenCalledWith({ memoryLimit: "mb1536" }),
    );
    const theme = screen.getByLabelText("Theme");
    expect(theme).toHaveFocus();
    const channel = screen.getByLabelText("Update channel");
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

  it("applies and persists an explicit theme immediately", async () => {
    const persist = vi.spyOn(desktop, "setThemePreference");
    render(<App initialTheme="light" />);

    const dialog = await openSettings();
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.change(within(dialog).getByLabelText("Theme"), {
      target: { value: "dark" },
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    await waitFor(() => expect(persist).toHaveBeenCalledWith("dark"));
  });

  it("keeps System mode synchronized with live OS theme changes", async () => {
    render(<App initialTheme="system" />);
    expect(document.documentElement.dataset.theme).toBe("light");

    act(() => {
      systemDark = true;
      const event = new Event("change");
      for (const listener of themeChangeListeners) {
        listener(event);
      }
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    await waitFor(() =>
      expect(desktop.syncSystemTheme).toHaveBeenLastCalledWith("dark"),
    );
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
    listedSources = [listedSource(2, "restored.parquet")];
    vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue({
      version: "0.1.0",
      sourceError: null,
      sources: [
        {
          generation: 2,
          displayName: "restored.parquet",
          sizeBytes: 4096,
          rowCount: 12,
          rowGroupCount: 2,
          schema: [],
        },
      ],
    });
    render(<App />);
    await act(async () => Promise.resolve());

    expect(
      screen.getByText("restored.parquet").closest(".file-context"),
    ).not.toBeNull();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("updated to 0.1.0 · what's new");

    act(() => vi.advanceTimersByTime(59_800));
    expect(status).toHaveClass("is-dismissing");
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("opens the Rust-owned releases list and explicitly dismisses post-update status", async () => {
    vi.useFakeTimers();
    vi.spyOn(desktop, "takePostUpdateState").mockResolvedValue({
      version: "0.1.0-alpha.2",
      sourceError: null,
      sources: [],
    });
    const openPage = vi.spyOn(desktop, "openReleasesPage");
    render(<App />);
    await act(async () => Promise.resolve());

    const status = screen.getByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "what's new" }));
    expect(openPage.mock.calls).toEqual([[]]);
    expect(status).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss update status" }),
    );
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
    expect(screen.getByRole("status")).toHaveTextContent("updating…simulated");
    const progress = screen.getByRole("progressbar", {
      name: "Downloading update",
    });
    expect(progress).toHaveAttribute("aria-valuenow", "0");

    act(() => vi.advanceTimersByTime(160));
    expect(progress).toHaveAttribute("aria-valuenow", "25");

    act(() => vi.advanceTimersByTime(640));
    expect(screen.getByRole("status")).toHaveTextContent(
      "updated to 99.99.99 · what's new simulated",
    );
    expect(install).not.toHaveBeenCalled();
  });

  it("keeps a stopped grid performance report available for automation and copy fallback", async () => {
    const clipboardWrite = vi
      .fn()
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    render(<App />);
    let dialog = await openSettings();
    let now = 1_000;
    let timerCallback: (() => void) | null = null;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      timerCallback = typeof handler === "function" ? handler : null;
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    const clearRecordingInterval = vi
      .spyOn(window, "clearInterval")
      .mockImplementation(() => undefined);
    fireEvent.click(
      within(dialog).getByText("Debug — for Viewda developers", {
        selector: "summary",
      }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Start recording" }),
    );
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Recording grid performance",
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    const recordingStatus = screen.getByLabelText("Grid performance recording");
    expect(recordingStatus).toHaveTextContent(
      "Recording grid performance0:00Stop recording",
    );
    now = 66_000;
    act(() => timerCallback?.());
    expect(recordingStatus).toHaveTextContent(
      "Recording grid performance1:05Stop recording",
    );
    fireEvent.click(
      within(recordingStatus).getByRole("button", { name: "Stop recording" }),
    );
    expect(clearRecordingInterval).toHaveBeenCalledWith(1);
    const completedStatus = screen.getByLabelText(
      "Grid performance recording completed",
    );
    expect(completedStatus).not.toHaveTextContent(
      "Grid performance report ready",
    );
    const duration = within(completedStatus).getByLabelText(
      "Recording duration 1 minute 5 seconds",
    );
    expect(duration.tagName).toBe("TIME");
    expect(duration).toHaveTextContent("1:05");
    expect(within(completedStatus).queryByText("Copy report")).toBeNull();
    expect(within(completedStatus).queryByText("Record again")).toBeNull();
    const copyReport = within(completedStatus).getByRole("button", {
      name: "Copy report",
    });
    const recordAgain = within(completedStatus).getByRole("button", {
      name: "Record again",
    });
    expect(copyReport).toHaveAttribute("title", "Copy report");
    expect(recordAgain).toHaveAttribute("title", "Record again");
    expect(copyReport).not.toHaveClass("is-copied");
    expect(
      copyReport.querySelector(".grid-performance-copy-glyph"),
    ).toBeInTheDocument();
    expect(
      copyReport.querySelector(".grid-performance-copy-check"),
    ).toBeInTheDocument();
    const completedActions = within(completedStatus).getAllByRole("button");
    expect(completedActions).toHaveLength(3);
    const dismiss = completedActions[completedActions.length - 1];
    if (dismiss === undefined) {
      throw new Error("Completed performance actions are missing.");
    }
    expect(dismiss).toHaveAccessibleName("Dismiss performance report");
    expect(dismiss).toHaveAttribute("title", "Dismiss performance report");

    fireEvent.click(copyReport);
    const copyError = await within(completedStatus).findByRole("status");
    expect(copyError).toHaveTextContent(
      "Copy failed; report remains available in Settings.",
    );
    expect(copyError).toHaveClass("grid-performance-copy-error");
    expect(copyError).toBeVisible();

    fireEvent.click(copyReport);
    await waitFor(() => expect(copyReport).toHaveClass("is-copied"));
    const copySuccess = within(completedStatus).getByRole("status");
    expect(copySuccess).toHaveTextContent("Report copied.");
    expect(copySuccess).toHaveClass("grid-performance-live");
    expect(copySuccess).not.toHaveClass("grid-performance-copy-error");

    fireEvent.click(dismiss);
    expect(
      screen.queryByLabelText("Grid performance recording completed"),
    ).not.toBeInTheDocument();
    dialog = await openSettings();
    fireEvent.click(
      within(dialog).getByText("Debug — for Viewda developers", {
        selector: "summary",
      }),
    );
    const report = within(dialog).getByLabelText("Grid performance report");
    expect(report).toHaveAttribute("readonly");
    expect(JSON.parse((report as HTMLTextAreaElement).value)).toMatchObject({
      schemaVersion: 1,
      runtime: {
        appVersion: "0.0.1",
        queryEngineVersion: "v1.5.5",
        theme: "light",
      },
      grid: { maximumDomCells: 0 },
      wheel: { inputEvents: 0 },
    });

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy report" }),
    );
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(3));
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Report copied",
    );
    expect(within(dialog).getByLabelText("Grid performance report")).toBe(
      report,
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Record again" }),
    );
    expect(
      screen.getByLabelText("Grid performance recording"),
    ).toHaveTextContent("0:00");
    expect(
      within(dialog).queryByLabelText("Grid performance report"),
    ).not.toBeInTheDocument();
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
      .mockImplementation((onProgress) => {
        onProgress({ percent: 63 });
        return new Promise<boolean>(() => {});
      });

    await openStableDowngrade();
    fireEvent.click(screen.getByRole("button", { name: "Downgrade to 0.1.0" }));

    expect(install).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
    expect(
      screen.getByRole("progressbar", { name: "Downloading update" }),
    ).toHaveAttribute("aria-valuenow", "63");
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
