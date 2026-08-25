import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  activateOpenedSource,
  cancelSourceOpen,
  cycleOpenedSource,
  checkForUpdate,
  closeOpenedSource,
  discardPendingUpdate,
  getPendingDataExportCloseDialog,
  getDefaultApplicationStatus,
  getDataViewSettings,
  getEngineStatus,
  getRecentSources,
  getSourceOpenProgress,
  getStructureRowOffset,
  getUpdateSettings,
  installPendingUpdate,
  listOpenedSources,
  onCloseSourceRequested,
  onOpenSourceRequested,
  onOpenedSourceAvailable,
  onRecentSourcesChanged,
  onDataExportCloseRequested,
  onSettingsRequested,
  onUpdateAvailable,
  openLocalSource,
  openRecentSource,
  openReleasesPage,
  OpenSourceError,
  removeRecentSource,
  resolveDataExportCloseDialog,
  setThemePreference as persistThemePreference,
  setDataViewSettings as persistDataViewSettings,
  setUpdateSettings as persistUpdateSettings,
  setDefaultApplication,
  shortcutModifier,
  syncSystemTheme,
  takePostUpdateState,
  takeOpenedSource,
  type DefaultApplicationStatus,
  type DataViewMemoryLimit,
  type DataViewSettings,
  type DataExportCloseDialog,
  type EngineStatus,
  type OpenedSourceEntry,
  type RecentSource,
  type SourceErrorCode,
  type SourceOpenProgressPhase,
  type SourceSummary,
  type StructureByteUnit,
  type UpdateChannel,
  type UpdateInfo,
  type UpdateSettings,
  UpdateCommandError,
} from "./desktop";
import {
  activeOpenFile,
  distinguishingTail,
  mergeOpenFiles,
  type OpenFile,
  type SourceMode,
} from "./open-files";
import { FileContextMenu, FileSwitcher } from "./FileSwitcher";
import { GridPerformanceDebug } from "./data-grid/GridPerformanceDebug";
import type { GridDiagnosticsSink } from "./data-grid/diagnostics/session";
import { CopyStructureReport } from "./structure/CopyStructureReport";
import { KeyValueMetadata } from "./structure/KeyValueMetadata";
import { StructureCard, StructureLoadStatus } from "./structure/StructureCard";
import { StructureLayoutView } from "./structure/StructureLayout";
import { ColumnsSection, RowGroupTable } from "./structure/StructureTables";
import { useStructureSummary } from "./structure/use-structure-summary";
import {
  applyDocumentTheme,
  SYSTEM_THEME_QUERY,
  type ThemePreference,
} from "./theme";

const DataGrid = lazy(async () => {
  const { DataGrid: Grid } = await import("./data-grid/DataGrid");
  return { default: Grid };
});

type Readiness =
  | { kind: "loading" }
  | { kind: "ready"; engine: EngineStatus }
  | { kind: "error" };

type TitlebarUpdate =
  | { kind: "available"; version: string; simulated: boolean }
  | {
      kind: "installing";
      version: string;
      simulated: boolean;
      progress: number | null;
    }
  | {
      kind: "installed";
      version: string;
      simulated: boolean;
      dismissing: boolean;
    };

const SIMULATED_UPDATE_VERSION = "99.99.99";
const SIMULATED_INSTALL_STEP_MS = 160;
const POST_UPDATE_FADE_DELAY_MS = 59_800;
const POST_UPDATE_REMOVE_DELAY_MS = 60_000;
const UPDATE_FADE_DURATION_MS = 200;

export function App({
  initialTheme = "system",
}: {
  initialTheme?: ThemePreference;
}) {
  const [readiness, setReadiness] = useState<Readiness>({ kind: "loading" });
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [sourceError, setSourceError] = useState<SourceErrorCode | null>(null);
  const [opening, setOpening] = useState(false);
  const [recentSources, setRecentSources] = useState<RecentSource[]>([]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [fileContextMenu, setFileContextMenu] = useState<{
    generation: number;
    x: number;
    y: number;
  } | null>(null);
  const [updateSettings, setUpdateSettings] = useState<UpdateSettings | null>(
    null,
  );
  const [dataViewSettings, setDataViewSettings] = useState<DataViewSettings>({
    memoryLimit: "mb384",
  });
  const [dataViewSettingsMessage, setDataViewSettingsMessage] = useState<
    string | null
  >(null);
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(initialTheme);
  const [themeMessage, setThemeMessage] = useState<string | null>(null);
  const [titlebarUpdate, setTitlebarUpdate] = useState<TitlebarUpdate | null>(
    null,
  );
  const [downgrade, setDowngrade] = useState<UpdateInfo | null>(null);
  const [dataExportCloseDialog, setDataExportCloseDialog] =
    useState<DataExportCloseDialog | null>(null);
  const [resolvingDataExportClose, setResolvingDataExportClose] =
    useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [defaultApplication, setDefaultApplicationStatus] =
    useState<DefaultApplicationStatus | null>(null);
  const [changingDefaultApplication, setChangingDefaultApplication] =
    useState(false);
  const [defaultApplicationMessage, setDefaultApplicationMessage] = useState<
    string | null
  >(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [installingDowngrade, setInstallingDowngrade] = useState(false);
  const [downgradeProgress, setDowngradeProgress] = useState<number | null>(
    null,
  );
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const simulatedInstallTimer = useRef<number | null>(null);
  const dismissTimer = useRef<number | null>(null);
  const cycleFilesTail = useRef<Promise<void>>(Promise.resolve());
  const previousOpenFileCount = useRef(0);
  const openFilesSyncSequence = useRef(0);
  const sourceOpenRequest = useRef(0);
  const sourceOpenAttempt = useRef<string | null>(null);
  const sourceOpenCancellation = useRef<string | null>(null);
  // Native listings carry no schema, so the window keeps the summary of every
  // file it opened for as long as that file stays open.
  const summaries = useRef(new Map<number, SourceSummary>());
  const activeFile = activeOpenFile(openFiles);
  const activeGeneration = activeFile?.generation ?? null;

  useLayoutEffect(() => {
    if (previousOpenFileCount.current > 0 && openFiles.length === 0) {
      setSwitcherOpen(false);
    }
    previousOpenFileCount.current = openFiles.length;
  }, [openFiles.length]);

  const refreshRecentSources = useCallback(async () => {
    try {
      setRecentSources(await getRecentSources());
    } catch {
      setRecentSources([]);
    }
  }, []);

  useLayoutEffect(() => {
    const systemTheme = window.matchMedia(SYSTEM_THEME_QUERY);
    const applyTheme = () => {
      const effectiveTheme = applyDocumentTheme(
        themePreference,
        systemTheme.matches,
      );
      if (themePreference === "system") {
        void syncSystemTheme(effectiveTheme).catch(() => {
          // Application content still follows the live OS theme if native sync fails.
        });
      }
    };
    applyTheme();
    if (themePreference !== "system") {
      return;
    }
    systemTheme.addEventListener("change", applyTheme);
    return () => systemTheme.removeEventListener("change", applyTheme);
  }, [themePreference]);

  /// Mirrors the native open set, adding the summaries of files opened just now.
  const syncOpenFiles = useCallback(async (opened: SourceSummary[] = []) => {
    const sequence = ++openFilesSyncSequence.current;
    for (const summary of opened) {
      summaries.current.set(summary.generation, summary);
    }
    const entries = await listOpenedSources();
    if (sequence !== openFilesSyncSequence.current) {
      return entries;
    }
    const open = new Set(entries.map((entry) => entry.generation));
    for (const generation of summaries.current.keys()) {
      if (!open.has(generation)) {
        summaries.current.delete(generation);
      }
    }
    setOpenFiles((previous) =>
      mergeOpenFiles(entries, summaries.current, previous),
    );
    return entries;
  }, []);

  const openSource = useCallback(async () => {
    if (sourceOpenAttempt.current !== null) {
      return;
    }
    const request = ++sourceOpenRequest.current;
    const attempt = crypto.randomUUID();
    sourceOpenAttempt.current = attempt;
    setOpening(true);
    setSourceError(null);

    try {
      const selected = await openLocalSource(attempt);
      if (sourceOpenRequest.current === request && selected !== null) {
        await syncOpenFiles([selected]);
      }
    } catch (error) {
      if (
        sourceOpenRequest.current === request &&
        sourceOpenCancellation.current !== attempt
      ) {
        setSourceError(
          error instanceof OpenSourceError ? error.code : "unsupported",
        );
      }
    } finally {
      if (sourceOpenRequest.current === request) {
        sourceOpenAttempt.current = null;
        setOpening(false);
      }
    }
  }, [syncOpenFiles]);

  const openRecent = useCallback(
    async (id: string) => {
      if (sourceOpenAttempt.current !== null) {
        return;
      }
      const request = ++sourceOpenRequest.current;
      const attempt = crypto.randomUUID();
      sourceOpenAttempt.current = attempt;
      setOpening(true);
      setSourceError(null);

      try {
        const selected = await openRecentSource(id, attempt);
        if (sourceOpenRequest.current !== request) {
          return;
        }
        await syncOpenFiles([selected]);
        await refreshRecentSources();
        setSwitcherOpen(false);
      } catch (error) {
        const code =
          error instanceof OpenSourceError ? error.code : "unsupported";
        if (
          sourceOpenRequest.current !== request ||
          sourceOpenCancellation.current === attempt
        ) {
          return;
        }
        setSourceError(code);
        if (code === "notFound") {
          setRecentSources((entries) =>
            entries.filter((entry) => entry.id !== id),
          );
        }
      } finally {
        if (sourceOpenRequest.current === request) {
          sourceOpenAttempt.current = null;
          setOpening(false);
        }
      }
    },
    [refreshRecentSources, syncOpenFiles],
  );

  const cancelOpenSource = useCallback(() => {
    const request = sourceOpenRequest.current;
    const attempt = sourceOpenAttempt.current;
    if (attempt === null) {
      return;
    }
    sourceOpenCancellation.current = attempt;
    void cancelSourceOpen(attempt)
      .then((outcome) => {
        if (sourceOpenRequest.current !== request) {
          return;
        }
        sourceOpenCancellation.current = null;
        if (outcome === "cancelled") {
          sourceOpenAttempt.current = null;
          sourceOpenRequest.current += 1;
          setOpening(false);
        }
      })
      .catch(() => {
        if (sourceOpenRequest.current === request) {
          sourceOpenCancellation.current = null;
          setSourceError("unsupported");
        }
      });
  }, []);

  const receiveOpenedSource = useCallback(async () => {
    try {
      // One drag and drop can queue several activations; each of them opened a file.
      const opened: SourceSummary[] = [];
      let received = false;
      let failure: SourceErrorCode | null = null;
      for (;;) {
        const activation = await takeOpenedSource();
        if (activation === null) {
          break;
        }
        received = true;
        failure = activation.sourceError;
        if (activation.source !== null) {
          opened.push(activation.source);
        }
      }
      if (!received) {
        return;
      }
      setSourceError(failure);
      if (opened.length > 0) {
        await syncOpenFiles(opened);
      }
    } catch {
      setSourceError("unsupported");
    }
  }, [syncOpenFiles]);

  const activateFile = useCallback(
    async (generation: number) => {
      try {
        await activateOpenedSource(generation);
      } catch {
        // The file is gone natively; the refresh below settles the window.
      }
      await syncOpenFiles();
    },
    [syncOpenFiles],
  );

  const closeFile = useCallback(
    async (generation: number) => {
      try {
        if (!(await closeOpenedSource(generation))) {
          return false;
        }
      } catch {
        // A rejected request can still mean native state changed; verify it below.
      }
      let entries: OpenedSourceEntry[];
      try {
        entries = await syncOpenFiles();
      } catch {
        return false;
      }
      if (entries.some((entry) => entry.generation === generation)) {
        return false;
      }
      await refreshRecentSources();
      return true;
    },
    [refreshRecentSources, syncOpenFiles],
  );

  const closeOtherFiles = useCallback(
    async (generation: number) => {
      for (const file of openFiles) {
        if (
          file.generation !== generation &&
          !(await closeFile(file.generation))
        ) {
          break;
        }
      }
    },
    [closeFile, openFiles],
  );

  const setFileBusy = useCallback((generation: number, busy: boolean) => {
    setOpenFiles((files) =>
      files.map((file) =>
        file.generation === generation && file.busy !== busy
          ? { ...file, busy }
          : file,
      ),
    );
  }, []);

  const removeRecent = useCallback(
    async (id: string) => {
      await removeRecentSource(id);
      await refreshRecentSources();
    },
    [refreshRecentSources],
  );

  const setActiveMode = useCallback((mode: SourceMode) => {
    setOpenFiles((files) =>
      files.map((file) => (file.active ? { ...file, mode } : file)),
    );
  }, []);

  useEffect(() => {
    let active = true;

    getEngineStatus()
      .then((engine) => {
        if (active) {
          setReadiness({ kind: "ready", engine });
        }
      })
      .catch(() => {
        if (active) {
          setReadiness({ kind: "error" });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (readiness.kind !== "ready") {
      return;
    }
    void refreshRecentSources();
  }, [readiness.kind, refreshRecentSources]);

  useEffect(() => {
    let active = true;
    let unlisten = () => {};
    onRecentSourcesChanged(() => void refreshRecentSources())
      .then((stopListening) => {
        if (active) {
          unlisten = stopListening;
        } else {
          stopListening();
        }
      })
      .catch(() => {});
    return () => {
      active = false;
      unlisten();
    };
  }, [refreshRecentSources]);

  useEffect(() => {
    if (readiness.kind === "ready") {
      void import("./data-grid/DataGrid");
    }
  }, [readiness.kind]);

  useEffect(() => {
    let active = true;
    let unlisten = () => {};

    onOpenSourceRequested(() => {
      void openSource();
    })
      .then((stopListening) => {
        if (active) {
          unlisten = stopListening;
        } else {
          stopListening();
        }
      })
      .catch(() => {
        // The visible Open button remains available if native events are unavailable.
      });

    return () => {
      active = false;
      unlisten();
    };
  }, [openSource]);

  useEffect(() => {
    let active = true;
    let unlisten = () => {};

    onCloseSourceRequested((generation) => {
      void closeFile(generation);
    })
      .then((stopListening) => {
        if (active) {
          unlisten = stopListening;
        } else {
          stopListening();
        }
      })
      .catch(() => {
        // Without native events the file stays open until it is closed again.
      });

    return () => {
      active = false;
      unlisten();
    };
  }, [closeFile]);

  useEffect(() => {
    let active = true;
    let unlisten = () => {};

    onOpenedSourceAvailable(() => void receiveOpenedSource())
      .then((stopListening) => {
        if (active) {
          unlisten = stopListening;
          void receiveOpenedSource();
        } else {
          stopListening();
        }
      })
      .catch(() => void receiveOpenedSource());

    return () => {
      active = false;
      unlisten();
    };
  }, [receiveOpenedSource]);

  useEffect(() => {
    let active = true;
    let unlisten = () => {};
    const receivePendingDialog = () => {
      void getPendingDataExportCloseDialog()
        .then((dialog) => {
          if (active && dialog !== null) {
            setDataExportCloseDialog(dialog);
          }
        })
        .catch(() => {
          // A later close request emits the same copy again.
        });
    };

    onDataExportCloseRequested((dialog) => {
      if (active) {
        setDataExportCloseDialog(dialog);
      }
    })
      .then((stopListening) => {
        if (!active) {
          stopListening();
          return;
        }
        unlisten = stopListening;
        receivePendingDialog();
      })
      .catch(() => {
        receivePendingDialog();
      });

    return () => {
      active = false;
      unlisten();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlistenSettings = () => {};
    let unlistenUpdate = () => {};

    onSettingsRequested(() => setSettingsOpen(true))
      .then((stopListening) => {
        if (active) {
          unlistenSettings = stopListening;
        } else {
          stopListening();
        }
      })
      .catch(() => {
        // Native settings remain available again after the next application start.
      });
    onUpdateAvailable((update) => {
      setTitlebarUpdate({
        kind: "available",
        version: update.version,
        simulated: false,
      });
    })
      .then((stopListening) => {
        if (active) {
          unlistenUpdate = stopListening;
        } else {
          stopListening();
        }
      })
      .catch(() => {
        // Automatic checks still provide the same indicator if native events fail.
      });

    return () => {
      active = false;
      unlistenSettings();
      unlistenUpdate();
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    let active = true;
    setDefaultApplicationStatus(null);
    setDefaultApplicationMessage(null);
    getDefaultApplicationStatus()
      .then((status) => {
        if (active) {
          setDefaultApplicationStatus(status);
        }
      })
      .catch(() => {
        if (active) {
          setDefaultApplicationStatus({ kind: "unavailable" });
        }
      });

    return () => {
      active = false;
    };
  }, [settingsOpen]);

  useEffect(() => {
    let active = true;

    takePostUpdateState()
      .then((restored) => {
        if (!active || restored === null) {
          return;
        }
        setTitlebarUpdate({
          kind: "installed",
          version: restored.version,
          simulated: false,
          dismissing: false,
        });
        if (restored.sources.length > 0) {
          void syncOpenFiles(restored.sources);
        }
        if (restored.sourceError !== null) {
          setSourceError(restored.sourceError);
        }
      })
      .catch(() => {
        // A damaged local restore marker must not block the application.
      });

    getUpdateSettings()
      .then(async (settings) => {
        if (!active) {
          return;
        }
        setUpdateSettings(settings);
        if (!settings.automaticChecks) {
          return;
        }
        const available = await checkForUpdate({ automaticCheck: true });
        if (active && available !== null) {
          setTitlebarUpdate({
            kind: "available",
            version: available.version,
            simulated: false,
          });
        }
      })
      .catch(() => {
        // Automatic checks are best-effort and never replace local work.
      });

    getDataViewSettings()
      .then((settings) => {
        if (active) {
          setDataViewSettings(settings);
        }
      })
      .catch(() => {
        // The minimum resource budget remains safe if settings cannot be read.
      });

    return () => {
      active = false;
    };
  }, [syncOpenFiles]);

  useEffect(() => {
    if (titlebarUpdate?.kind !== "installed") {
      return;
    }

    const fadeTimer = window.setTimeout(() => {
      setTitlebarUpdate((current) =>
        current?.kind === "installed"
          ? { ...current, dismissing: true }
          : current,
      );
    }, POST_UPDATE_FADE_DELAY_MS);
    const removeTimer = window.setTimeout(
      () => setTitlebarUpdate(null),
      POST_UPDATE_REMOVE_DELAY_MS,
    );

    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(removeTimer);
    };
  }, [
    titlebarUpdate?.kind,
    titlebarUpdate?.kind === "installed" ? titlebarUpdate.version : null,
    titlebarUpdate?.kind === "installed" ? titlebarUpdate.simulated : null,
  ]);

  useEffect(
    () => () => {
      if (simulatedInstallTimer.current !== null) {
        window.clearInterval(simulatedInstallTimer.current);
      }
      if (dismissTimer.current !== null) {
        window.clearTimeout(dismissTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (activeGeneration === null) {
      return;
    }
    const switchMode = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLSelectElement ||
          target instanceof HTMLTextAreaElement)
      ) {
        return;
      }
      if (event.key === "1" || event.key === "2") {
        event.preventDefault();
        setActiveMode(event.key === "1" ? "data" : "structure");
      }
    };
    window.addEventListener("keydown", switchMode);
    return () => window.removeEventListener("keydown", switchMode);
  }, [activeGeneration, setActiveMode]);

  useEffect(() => {
    const cycleFiles = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Tab" ||
        !event.ctrlKey ||
        event.metaKey ||
        event.altKey
      ) {
        return;
      }
      // Claimed in the capture phase: the webview would otherwise move keyboard
      // focus out of the grid before the window sees the shortcut.
      event.preventDefault();
      event.stopPropagation();
      cycleFilesTail.current = cycleFilesTail.current
        .then(async () => {
          await cycleOpenedSource(event.shiftKey);
          await syncOpenFiles();
        })
        .catch(() => undefined);
    };
    window.addEventListener("keydown", cycleFiles, { capture: true });
    return () =>
      window.removeEventListener("keydown", cycleFiles, { capture: true });
  }, [syncOpenFiles]);

  useEffect(() => {
    const openSwitcher = (event: globalThis.KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        !["p", "n"].includes(event.key.toLowerCase())
      ) {
        return;
      }
      event.preventDefault();
      setFileContextMenu(null);
      setSwitcherOpen(true);
    };
    window.addEventListener("keydown", openSwitcher, { capture: true });
    return () =>
      window.removeEventListener("keydown", openSwitcher, { capture: true });
  }, []);

  const runUpdateCheck = useCallback(async (allowDowngrade = false) => {
    setCheckingUpdates(true);
    setUpdateMessage(null);
    try {
      const available = await checkForUpdate({ allowDowngrade });
      if (available === null) {
        setTitlebarUpdate(null);
        setUpdateMessage("Viewda is up to date.");
      } else if (available.isDowngrade) {
        setTitlebarUpdate(null);
        setDowngrade(available);
      } else {
        setTitlebarUpdate({
          kind: "available",
          version: available.version,
          simulated: false,
        });
        setUpdateMessage(null);
      }
    } catch (error) {
      setUpdateMessage(
        error instanceof UpdateCommandError && error.code === "manualInstall"
          ? "This package uses manual updates. Install the AppImage to update inside Viewda."
          : "Could not check for updates. Try again later.",
      );
    } finally {
      setCheckingUpdates(false);
    }
  }, []);

  const changeUpdateChannel = useCallback(
    async (channel: UpdateChannel) => {
      if (updateSettings === null || channel === updateSettings.channel) {
        return;
      }
      const previous = updateSettings.channel;
      const next = { ...updateSettings, channel };
      setUpdateSettings(next);
      setTitlebarUpdate(null);
      setUpdateMessage(null);
      try {
        await persistUpdateSettings(next);
        await runUpdateCheck(previous === "latest" && channel === "stable");
      } catch {
        setUpdateSettings(updateSettings);
        setUpdateMessage("Could not save the update channel.");
      }
    },
    [runUpdateCheck, updateSettings],
  );

  const changeThemePreference = useCallback(
    async (preference: ThemePreference) => {
      if (preference === themePreference) {
        return;
      }
      const previous = themePreference;
      setThemePreference(preference);
      setThemeMessage(null);
      try {
        await persistThemePreference(preference);
      } catch {
        setThemePreference(previous);
        setThemeMessage("Could not save the appearance preference.");
      }
    },
    [themePreference],
  );

  const changeAutomaticChecks = useCallback(
    async (automaticChecks: boolean) => {
      if (updateSettings === null) {
        return;
      }
      const next = { ...updateSettings, automaticChecks };
      setUpdateSettings(next);
      setUpdateMessage(null);
      try {
        await persistUpdateSettings(next);
      } catch {
        setUpdateSettings(updateSettings);
        setUpdateMessage("Could not save the update preference.");
      }
    },
    [updateSettings],
  );

  const changeDataViewMemory = useCallback(
    async (memoryLimit: DataViewMemoryLimit) => {
      if (memoryLimit === dataViewSettings.memoryLimit) {
        return;
      }
      const previous = dataViewSettings;
      const next = { memoryLimit };
      setDataViewSettings(next);
      setDataViewSettingsMessage(null);
      try {
        await persistDataViewSettings(next);
      } catch {
        setDataViewSettings(previous);
        setDataViewSettingsMessage(
          "Could not save the filter and sort memory limit.",
        );
      }
    },
    [dataViewSettings],
  );

  const installAvailableUpdate = useCallback(async () => {
    if (titlebarUpdate?.kind !== "available") {
      return;
    }
    const available = titlebarUpdate;
    setTitlebarUpdate({
      ...available,
      kind: "installing",
      progress: available.simulated ? 0 : null,
    });
    setUpdateMessage(null);

    if (available.simulated) {
      let progress = 0;
      simulatedInstallTimer.current = window.setInterval(() => {
        if (progress === 100) {
          setTitlebarUpdate({
            kind: "installed",
            version: available.version,
            simulated: true,
            dismissing: false,
          });
          if (simulatedInstallTimer.current !== null) {
            window.clearInterval(simulatedInstallTimer.current);
            simulatedInstallTimer.current = null;
          }
          return;
        }
        progress += 25;
        setTitlebarUpdate((current) =>
          current?.kind === "installing" ? { ...current, progress } : current,
        );
      }, SIMULATED_INSTALL_STEP_MS);
      return;
    }

    try {
      const restarting = await installPendingUpdate(({ percent }) => {
        setTitlebarUpdate((current) =>
          current?.kind === "installing"
            ? { ...current, progress: percent }
            : current,
        );
      });
      if (!restarting) {
        setTitlebarUpdate(available);
      }
    } catch {
      setTitlebarUpdate(available);
      setUpdateMessage("The update could not be installed. Try again.");
    }
  }, [titlebarUpdate]);

  const installDowngrade = useCallback(async () => {
    setInstallingDowngrade(true);
    setDowngradeProgress(null);
    setUpdateMessage(null);
    try {
      const restarting = await installPendingUpdate(({ percent }) => {
        setDowngradeProgress(percent);
      });
      if (!restarting) {
        setInstallingDowngrade(false);
        setDowngradeProgress(null);
      }
    } catch {
      setInstallingDowngrade(false);
      setDowngradeProgress(null);
      setUpdateMessage("The update could not be installed. Try again.");
    }
  }, []);

  const waitForStable = useCallback(async () => {
    try {
      await discardPendingUpdate();
      setDowngrade(null);
      setUpdateMessage("Waiting for the next stable release.");
    } catch {
      setUpdateMessage("Could not dismiss the stable downgrade.");
    }
  }, []);

  const simulateUpdate = useCallback(() => {
    setTitlebarUpdate({
      kind: "available",
      version: SIMULATED_UPDATE_VERSION,
      simulated: true,
    });
    setUpdateMessage("Simulated update ready in the titlebar.");
  }, []);

  const dismissPostUpdate = useCallback(() => {
    setTitlebarUpdate((current) =>
      current?.kind === "installed"
        ? { ...current, dismissing: true }
        : current,
    );
    if (dismissTimer.current !== null) {
      window.clearTimeout(dismissTimer.current);
    }
    dismissTimer.current = window.setTimeout(() => {
      setTitlebarUpdate((current) =>
        current?.kind === "installed" ? null : current,
      );
      dismissTimer.current = null;
    }, UPDATE_FADE_DURATION_MS);
  }, []);

  const showReleasePage = useCallback(async () => {
    try {
      await openReleasesPage();
    } catch {
      setUpdateMessage("Could not open the releases page.");
    }
  }, []);

  const resolveExportClose = useCallback(async (cancelExport: boolean) => {
    setResolvingDataExportClose(true);
    try {
      await resolveDataExportCloseDialog(cancelExport);
      setDataExportCloseDialog(null);
    } catch {
      // Keep the decision available so the user can retry.
    } finally {
      setResolvingDataExportClose(false);
    }
  }, []);

  // Panels keep the order the files were opened in. Following the
  // most-recently-used order instead would move their DOM nodes on every switch,
  // and a moved scroll box loses the reading position it was showing.
  const panels = useMemo(
    () =>
      [...openFiles].sort(
        (first, second) => first.generation - second.generation,
      ),
    [openFiles],
  );

  const makeDefaultApplication = useCallback(async () => {
    setChangingDefaultApplication(true);
    setDefaultApplicationMessage(null);
    try {
      setDefaultApplicationStatus(await setDefaultApplication());
    } catch {
      setDefaultApplicationMessage("Could not change the default application.");
    } finally {
      setChangingDefaultApplication(false);
    }
  }, []);

  return (
    <GridPerformanceDebug
      engine={readiness.kind === "ready" ? readiness.engine : null}
      source={activeFile?.summary ?? null}
    >
      {({ diagnostics, settings: gridPerformanceDebug }) => (
        <main className="app-shell">
          <header className="titlebar">
            {activeFile === null ? (
              <span className="file-context is-empty">No file open</span>
            ) : (
              <FileContext
                file={activeFile}
                tail={distinguishingTail(activeFile, openFiles)}
                count={openFiles.length}
                onOpen={() => setSwitcherOpen((open) => !open)}
              />
            )}
            {activeFile !== null && (
              <ModeSwitch mode={activeFile.mode} onMode={setActiveMode} />
            )}
            <TitlebarUpdateStatus
              update={titlebarUpdate}
              onActivate={installAvailableUpdate}
              onDismiss={dismissPostUpdate}
              onReleasePage={showReleasePage}
            />
          </header>

          {switcherOpen && (
            <FileSwitcher
              files={openFiles}
              recentSources={recentSources}
              opening={opening}
              onActivate={activateFile}
              onClose={closeFile}
              onDismiss={() => setSwitcherOpen(false)}
              onContextMenu={(generation, x, y) => {
                setFileContextMenu({ generation, x, y });
              }}
              onOpenFile={openSource}
              onOpenRecent={openRecent}
              onRemoveRecent={removeRecent}
            />
          )}

          {fileContextMenu !== null && (
            <FileContextMenu
              file={
                openFiles.find(
                  (file) => file.generation === fileContextMenu.generation,
                ) ?? null
              }
              x={fileContextMenu.x}
              y={fileContextMenu.y}
              onClose={() => {
                setFileContextMenu(null);
                void closeFile(fileContextMenu.generation);
              }}
              onDismiss={() => setFileContextMenu(null)}
              onCloseOthers={() => {
                setFileContextMenu(null);
                void closeOtherFiles(fileContextMenu.generation);
              }}
            />
          )}

          <div className={`workspace${activeFile === null ? " is-empty" : ""}`}>
            {activeFile === null ? (
              <section className="empty-state" aria-label="Open a Parquet file">
                {readiness.kind === "loading" && (
                  <>
                    <OpenButton disabled opening={false} onOpen={openSource} />
                    <p className="empty-message">
                      Starting the local data engine…
                    </p>
                  </>
                )}
                {readiness.kind === "ready" && (
                  <>
                    <OpenButton
                      opening={opening}
                      onOpen={openSource}
                      onCancel={cancelOpenSource}
                    />
                    <RecentFiles
                      entries={recentSources}
                      opening={opening}
                      onOpen={openRecent}
                    />
                    <p className="empty-message">
                      Your data never leaves this machine.
                    </p>
                  </>
                )}
                {readiness.kind === "error" && (
                  <p className="empty-message status-error" role="alert">
                    The local data engine could not start. Restart Viewda and
                    try again.
                  </p>
                )}
                <ShortcutHints modifier={shortcutModifier} />
                {sourceError !== null && (
                  <SourceErrorMessage code={sourceError} />
                )}
              </section>
            ) : (
              panels.map((file) => (
                <Fragment key={file.generation}>
                  <div
                    className="mode-panel"
                    hidden={!file.active || file.mode !== "data"}
                  >
                    <div className="data-mode">
                      {file.active && sourceError !== null && (
                        <SourceErrorMessage code={sourceError} />
                      )}
                      <OpenFileDataGrid
                        file={file}
                        viewSettings={dataViewSettings}
                        diagnostics={file.active ? diagnostics : undefined}
                        onBusyChange={setFileBusy}
                      />
                    </div>
                  </div>
                  <div
                    className="mode-panel structure-mode-panel"
                    hidden={!file.active || file.mode !== "structure"}
                  >
                    <SourceDetails
                      active={file.active && file.mode === "structure"}
                      opening={file.active ? opening : false}
                      source={file.summary}
                      sourceError={file.active ? sourceError : null}
                      onOpen={openSource}
                      onCancelOpen={cancelOpenSource}
                      onOpenData={(row) => {
                        setOpenFiles((current) => {
                          const target = current.find(
                            (candidate) =>
                              candidate.generation === file.generation,
                          );
                          if (target?.active !== true) {
                            return current;
                          }
                          return current.map((candidate) =>
                            candidate.generation === file.generation
                              ? {
                                  ...candidate,
                                  mode: "data",
                                  dataTargetRow: {
                                    row,
                                    request:
                                      (candidate.dataTargetRow?.request ?? 0) +
                                      1,
                                  },
                                }
                              : candidate,
                          );
                        });
                      }}
                    />
                  </div>
                </Fragment>
              ))
            )}
          </div>

          {settingsOpen && updateSettings !== null && (
            <SettingsDialog
              defaultApplication={defaultApplication}
              defaultApplicationMessage={defaultApplicationMessage}
              settings={updateSettings}
              dataViewSettings={dataViewSettings}
              dataViewSettingsMessage={dataViewSettingsMessage}
              themePreference={themePreference}
              themeMessage={themeMessage}
              engine={readiness.kind === "ready" ? readiness.engine : null}
              checking={checkingUpdates}
              message={updateMessage}
              onAutomaticChecks={changeAutomaticChecks}
              onDataViewMemory={changeDataViewMemory}
              onChannel={changeUpdateChannel}
              onTheme={changeThemePreference}
              onCheck={runUpdateCheck}
              onClose={() => setSettingsOpen(false)}
              onMakeDefault={makeDefaultApplication}
              onSimulate={simulateUpdate}
              gridPerformanceDebug={gridPerformanceDebug}
              changingDefaultApplication={changingDefaultApplication}
            />
          )}
          {downgrade !== null && (
            <DowngradeDialog
              update={downgrade}
              installing={installingDowngrade}
              progress={downgradeProgress}
              onDowngrade={installDowngrade}
              onWait={waitForStable}
            />
          )}
          {dataExportCloseDialog !== null && (
            <ExportCloseDialog
              copy={dataExportCloseDialog}
              resolving={resolvingDataExportClose}
              onDecision={resolveExportClose}
            />
          )}
        </main>
      )}
    </GridPerformanceDebug>
  );
}

function OpenFileDataGrid({
  file,
  viewSettings,
  diagnostics,
  onBusyChange,
}: {
  file: OpenFile;
  viewSettings: DataViewSettings;
  diagnostics: GridDiagnosticsSink | undefined;
  onBusyChange: (generation: number, busy: boolean) => void;
}) {
  const reportOperation = useCallback(
    (running: boolean) => onBusyChange(file.generation, running),
    [file.generation, onBusyChange],
  );
  return (
    <Suspense
      fallback={
        <p className="data-grid-loading" role="status">
          Loading data grid…
        </p>
      }
    >
      <DataGrid
        source={file.summary}
        requestedRow={file.dataTargetRow}
        viewSettings={viewSettings}
        diagnostics={diagnostics}
        active={file.active && file.mode === "data"}
        onOperationChange={reportOperation}
      />
    </Suspense>
  );
}

function ExportCloseDialog({
  copy,
  resolving,
  onDecision,
}: {
  copy: DataExportCloseDialog;
  resolving: boolean;
  onDecision: (cancelExport: boolean) => Promise<void>;
}) {
  return (
    <ModalDialog
      labelledBy="export-close-title"
      className="export-close-dialog"
      onClose={resolving ? undefined : () => void onDecision(false)}
    >
      <h2 id="export-close-title">Export in progress</h2>
      <p>{copy.message}</p>
      <div className="dialog-actions">
        <button
          className="text-button"
          type="button"
          disabled={resolving}
          onClick={() => void onDecision(false)}
        >
          Keep Exporting
        </button>
        <button
          className="danger-button"
          type="button"
          disabled={resolving}
          onClick={() => void onDecision(true)}
        >
          {resolving ? "Stopping export…" : copy.destructiveButton}
        </button>
      </div>
    </ModalDialog>
  );
}

function RecentFiles({
  entries,
  opening,
  onOpen,
}: {
  entries: RecentSource[];
  opening: boolean;
  onOpen: (id: string) => Promise<void>;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  if (entries.length === 0) {
    return null;
  }

  const focusSibling = (index: number, offset: number) => {
    const next = (index + offset + entries.length) % entries.length;
    buttons.current[next]?.focus();
  };

  return (
    <ul className="recent-files" aria-label="Recent files">
      {entries.map((entry, index) => (
        <li key={entry.id}>
          <button
            ref={(button) => {
              buttons.current[index] = button;
            }}
            type="button"
            aria-label={`Open ${entry.name} from ${entry.directory}`}
            disabled={opening}
            onClick={() => void onOpen(entry.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusSibling(index, 1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                focusSibling(index, -1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                void onOpen(entry.id);
              }
            }}
          >
            <span className="recent-file-name">{entry.name}</span>
            <span className="recent-file-directory">{entry.directory}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function FileContext({
  file,
  tail,
  count,
  onOpen,
}: {
  file: OpenFile;
  tail: string | null;
  count: number;
  onOpen: () => void;
}) {
  return (
    <button
      className="file-context"
      type="button"
      aria-label="Switch files"
      onClick={onOpen}
    >
      <span className="file-context-name">{file.name}</span>
      {tail !== null && <span className="file-context-tail">— {tail}</span>}
      {count > 1 && <span className="file-context-count">· {count}</span>}
      <span className="file-context-caret" aria-hidden="true">
        ▾
      </span>
    </button>
  );
}

function ModeSwitch({
  mode,
  onMode,
}: {
  mode: SourceMode;
  onMode: (mode: SourceMode) => void;
}) {
  return (
    <div className="mode-switch" role="group" aria-label="File view">
      <button
        type="button"
        aria-pressed={mode === "data"}
        title={`Data (${shortcutModifier}1)`}
        onClick={() => onMode("data")}
      >
        Data
      </button>
      <button
        type="button"
        aria-pressed={mode === "structure"}
        title={`Structure (${shortcutModifier}2)`}
        onClick={() => onMode("structure")}
      >
        Structure
      </button>
    </div>
  );
}

function TitlebarUpdateStatus({
  update,
  onActivate,
  onDismiss,
  onReleasePage,
}: {
  update: TitlebarUpdate | null;
  onActivate: () => Promise<void>;
  onDismiss: () => void;
  onReleasePage: () => Promise<void>;
}) {
  if (update === null) {
    return null;
  }

  if (update.kind === "installed") {
    return (
      <div
        className={`post-update-status${update.dismissing ? " is-dismissing" : ""}`}
        role="status"
      >
        <span>updated to {update.version} · </span>
        <button
          className="update-link"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void onReleasePage();
          }}
        >
          what's new
        </button>
        {update.simulated && (
          <>
            {" "}
            <SimulatedBadge />
          </>
        )}
        <button
          className="update-dismiss"
          type="button"
          aria-label="Dismiss update status"
          title="Dismiss"
          onClick={onDismiss}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    );
  }

  if (update.kind === "installing") {
    return (
      <div className="update-indicator is-installing" role="status">
        <span>updating…</span>
        {update.simulated && <SimulatedBadge />}
        <UpdateProgressBar progress={update.progress} />
      </div>
    );
  }

  return (
    <button
      className="update-indicator"
      type="button"
      onClick={() => void onActivate()}
    >
      update to {update.version}
      {update.simulated && (
        <>
          {" "}
          <SimulatedBadge />
        </>
      )}
    </button>
  );
}

function SimulatedBadge() {
  return <span className="simulated-badge">simulated</span>;
}

function SettingsDialog({
  defaultApplication,
  defaultApplicationMessage,
  settings,
  dataViewSettings,
  dataViewSettingsMessage,
  themePreference,
  themeMessage,
  engine,
  checking,
  message,
  onAutomaticChecks,
  onDataViewMemory,
  onChannel,
  onTheme,
  onCheck,
  onClose,
  onMakeDefault,
  onSimulate,
  gridPerformanceDebug,
  changingDefaultApplication,
}: {
  defaultApplication: DefaultApplicationStatus | null;
  defaultApplicationMessage: string | null;
  settings: UpdateSettings;
  dataViewSettings: DataViewSettings;
  dataViewSettingsMessage: string | null;
  themePreference: ThemePreference;
  themeMessage: string | null;
  engine: EngineStatus | null;
  checking: boolean;
  message: string | null;
  onAutomaticChecks: (enabled: boolean) => Promise<void>;
  onDataViewMemory: (memoryLimit: DataViewMemoryLimit) => Promise<void>;
  onChannel: (channel: UpdateChannel) => Promise<void>;
  onTheme: (preference: ThemePreference) => Promise<void>;
  onCheck: () => Promise<void>;
  onClose: () => void;
  onMakeDefault: () => Promise<void>;
  onSimulate: () => void;
  gridPerformanceDebug: ReactNode;
  changingDefaultApplication: boolean;
}) {
  return (
    <ModalDialog
      labelledBy="settings-title"
      className="settings-dialog"
      onClose={onClose}
    >
      <h2 id="settings-title">Settings</h2>
      <section className="settings-section" aria-labelledby="files-title">
        <p id="files-title" className="eyebrow">
          Files
        </p>
        <div className="settings-row">
          <span className="settings-row-copy">
            <span className="settings-row-label">Default application</span>
            <span className="settings-note">
              {defaultApplicationDescription(
                defaultApplication,
                defaultApplicationMessage,
              )}
            </span>
          </span>
          <DefaultApplicationControl
            status={defaultApplication}
            changing={changingDefaultApplication}
            onMakeDefault={onMakeDefault}
          />
        </div>
      </section>
      <section className="settings-section" aria-labelledby="appearance-title">
        <p id="appearance-title" className="eyebrow">
          Appearance
        </p>
        <div className="settings-row">
          <label htmlFor="theme-preference">Theme</label>
          <select
            id="theme-preference"
            value={themePreference}
            onChange={(event) =>
              void onTheme(event.target.value as ThemePreference)
            }
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
        {themeMessage !== null && (
          <p className="theme-message" role="status">
            {themeMessage}
          </p>
        )}
      </section>
      <section className="settings-section" aria-labelledby="performance-title">
        <p id="performance-title" className="eyebrow">
          Performance
        </p>
        <div className="settings-row">
          <span className="settings-row-copy">
            <label className="settings-row-label" htmlFor="sorting-memory">
              Preparation memory
            </label>
            <span className="settings-note">
              Used while applying filters or sorting.
            </span>
          </span>
          <select
            id="sorting-memory"
            value={dataViewSettings.memoryLimit}
            onChange={(event) =>
              void onDataViewMemory(event.target.value as DataViewMemoryLimit)
            }
          >
            <option value="mb384">384 MB</option>
            <option value="mb768">768 MB</option>
            <option value="mb1536">1.5 GB</option>
            <option value="mb3072">3 GB</option>
          </select>
        </div>
        <details className="performance-help">
          <summary>How memory and temporary disk work</summary>
          <p>
            Keep 384 MB unless a large filter or sort runs out of memory or is
            too slow. The four limits allow up to 1, 2, 4, or 8 workers. Higher
            limits can finish sooner, but let Viewda use more RAM. Grid windows
            are not affected.
          </p>
          <p>
            Data that does not fit in RAM spills beside the source file when
            possible. Viewda can use up to 90% of the drive&apos;s currently
            free space and stops before exceeding that limit.
          </p>
        </details>
        {dataViewSettingsMessage !== null && (
          <p className="theme-message" role="status">
            {dataViewSettingsMessage}
          </p>
        )}
      </section>
      <section className="settings-section" aria-labelledby="updates-title">
        <p id="updates-title" className="eyebrow">
          Updates
        </p>
        <div className="settings-row">
          <label htmlFor="update-channel">Update channel</label>
          <select
            id="update-channel"
            value={settings.channel}
            onChange={(event) =>
              void onChannel(event.target.value as UpdateChannel)
            }
          >
            <option value="stable">Stable</option>
            <option value="latest">Latest</option>
          </select>
        </div>
        <label className="settings-row settings-checkbox">
          <span>Automatic update checks</span>
          <input
            type="checkbox"
            checked={settings.automaticChecks}
            onChange={(event) => void onAutomaticChecks(event.target.checked)}
          />
        </label>
        <div className="settings-row">
          <span>Version</span>
          <span className="settings-version">
            {engine === null
              ? "Loading…"
              : `${engine.version} · DuckDB ${engine.queryEngineVersion}`}
          </span>
        </div>
        <div className="settings-row settings-check">
          <span>Check for updates</span>
          <button
            className="text-button"
            type="button"
            disabled={checking}
            onClick={() => void onCheck()}
          >
            {checking ? "Checking…" : "Check now"}
          </button>
        </div>
        {message !== null && (
          <p className="update-message" role="status">
            {message}
          </p>
        )}
      </section>
      <details className="debug-settings">
        <summary>Debug — for Viewda developers</summary>
        <button className="text-button" type="button" onClick={onSimulate}>
          Simulate update flow
        </button>
        {gridPerformanceDebug}
      </details>
      <div className="dialog-actions">
        <button className="dialog-close" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </ModalDialog>
  );
}

function DefaultApplicationControl({
  status,
  changing,
  onMakeDefault,
}: {
  status: DefaultApplicationStatus | null;
  changing: boolean;
  onMakeDefault: () => Promise<void>;
}) {
  if (status === null) {
    return <span className="settings-note">Checking…</span>;
  }
  if (status.kind === "default") {
    return <span className="settings-note">Viewda is the default</span>;
  }

  const unavailable =
    status.kind === "unavailable" || status.kind === "unintegratedAppImage";
  const systemSettings = status.kind === "systemSettings";
  return (
    <button
      className="tonal-button"
      type="button"
      disabled={changing || unavailable}
      onClick={() => void onMakeDefault()}
    >
      {changing
        ? systemSettings
          ? "Opening…"
          : "Changing…"
        : systemSettings
          ? "Open Default apps"
          : "Make default"}
    </button>
  );
}

function defaultApplicationDescription(
  status: DefaultApplicationStatus | null,
  message: string | null,
): string {
  if (message !== null) {
    return message;
  }
  if (status?.kind === "unintegratedAppImage") {
    return "Integrate the AppImage first.";
  }
  if (status?.kind === "unavailable") {
    return "xdg-utils is not installed.";
  }
  if (status?.kind === "systemSettings") {
    return "Finish the choice in Windows Settings.";
  }
  return "Open .parquet files in Viewda by default.";
}

function DowngradeDialog({
  update,
  installing,
  progress,
  onDowngrade,
  onWait,
}: {
  update: UpdateInfo;
  installing: boolean;
  progress: number | null;
  onDowngrade: () => Promise<void>;
  onWait: () => Promise<void>;
}) {
  return (
    <ModalDialog
      labelledBy="downgrade-title"
      onClose={installing ? undefined : () => void onWait()}
    >
      <p className="eyebrow">Stable channel</p>
      <h2 id="downgrade-title">Stable is currently older.</h2>
      <p>
        You have {update.currentVersion}. Stable is {update.version}. You can
        downgrade now or keep this version until a newer stable release arrives.
      </p>
      {installing && (
        <div className="downgrade-progress" role="status">
          <span>downloading…</span>
          <UpdateProgressBar progress={progress} />
        </div>
      )}
      <div className="dialog-actions">
        <button
          className="text-button"
          type="button"
          disabled={installing}
          onClick={() => void onWait()}
        >
          Wait for next stable
        </button>
        <button
          className="update-action"
          type="button"
          disabled={installing}
          onClick={() => void onDowngrade()}
        >
          {installing ? "Updating…" : `Downgrade to ${update.version}`}
        </button>
      </div>
    </ModalDialog>
  );
}

function UpdateProgressBar({ progress }: { progress: number | null }) {
  return (
    <span
      className={`update-progress${progress === null ? " is-indeterminate" : ""}`}
      role="progressbar"
      aria-label="Downloading update"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress ?? undefined}
    >
      <span
        className="update-progress-value"
        style={
          progress === null
            ? undefined
            : { transform: `scaleX(${progress / 100})` }
        }
      />
    </span>
  );
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function ModalDialog({
  labelledBy,
  className,
  onClose,
  children,
}: {
  labelledBy: string;
  className?: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    const firstFocusable =
      dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? dialog)?.focus();

    return () => {
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && onClose !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const dialog = dialogRef.current;
    const focusable = Array.from(
      dialog?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    );
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      dialog?.focus();
      return;
    }
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        !dialog?.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        className={`modal-dialog${className === undefined ? "" : ` ${className}`}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </section>
    </div>
  );
}

function OpenButton({
  opening,
  disabled = false,
  onOpen,
  onCancel,
}: {
  opening: boolean;
  disabled?: boolean;
  onOpen: () => Promise<void>;
  onCancel?: () => void;
}) {
  const [progress, setProgress] = useState<SourceOpenProgressPhase | null>(
    null,
  );
  useEffect(() => {
    if (!opening) {
      setProgress(null);
      return;
    }
    let active = true;
    const readProgress = async () => {
      try {
        const next = await getSourceOpenProgress();
        if (active) {
          setProgress(next);
        }
      } catch {
        // The Open action remains cancellable if a status poll fails.
      }
    };
    void readProgress();
    const interval = window.setInterval(() => void readProgress(), 250);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [opening]);
  const progressLabel =
    progress === "waiting"
      ? "Waiting to inspect the Parquet footer…"
      : progress === "readingFooter"
        ? "Reading the Parquet footer…"
        : progress === "decodingFooter"
          ? "Decoding the Parquet footer…"
          : progress === "summarizing"
            ? "Preparing the source summary…"
            : null;
  return (
    <div className="open-source-control">
      <button
        className="open-button"
        type="button"
        disabled={disabled}
        onClick={() => (opening ? onCancel?.() : void onOpen())}
      >
        {opening ? "Cancel opening" : "Open Parquet file…"}
      </button>
      {progressLabel !== null && (
        <span role="status" aria-live="polite">
          {progressLabel}
        </span>
      )}
    </div>
  );
}

function ShortcutHints({ modifier }: { modifier: string }) {
  return (
    <dl className="shortcut-hints" aria-label="Keyboard shortcuts">
      <div>
        <dt>Open file</dt>
        <dd>
          <kbd>{modifier}O</kbd>
        </dd>
      </div>
      <div>
        <dt>Settings</dt>
        <dd>
          <kbd>{modifier},</kbd>
        </dd>
      </div>
    </dl>
  );
}

function SourceDetails({
  active,
  opening,
  source,
  sourceError,
  onOpen,
  onCancelOpen,
  onOpenData,
}: {
  active: boolean;
  opening: boolean;
  source: SourceSummary;
  sourceError: SourceErrorCode | null;
  onOpen: () => Promise<void>;
  onCancelOpen: () => void;
  onOpenData: (row: number) => void;
}) {
  const { state, cancel, retry } = useStructureSummary(
    source.generation,
    active,
  );
  const [unit, setUnit] = useState<StructureByteUnit>("compressed");
  const [highlightedColumn, setHighlightedColumn] = useState<number | null>(
    null,
  );
  const [dataBridgeError, setDataBridgeError] = useState<string | null>(null);
  const [selectedRowGroup, setSelectedRowGroup] = useState<{
    row: number;
    request: number;
  } | null>(null);
  const rowOffsetRequest = useRef(0);
  const activeRef = useRef(active);
  const summary = state.kind === "ready" ? state.summary : null;
  const refreshing = state.kind === "ready" && state.refreshing;

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      rowOffsetRequest.current += 1;
    }
  }, [active]);

  useEffect(
    () => () => {
      rowOffsetRequest.current += 1;
    },
    [],
  );

  return (
    <section
      className="source-view"
      aria-label="Parquet source"
      aria-busy={refreshing || undefined}
      inert={refreshing || undefined}
      onClickCapture={
        refreshing
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
            }
          : undefined
      }
    >
      <header className="source-heading" aria-label="Structure actions">
        {summary !== null && (
          <CopyStructureReport
            generation={source.generation}
            unit={unit}
            active={active}
          />
        )}
        <OpenButton opening={opening} onOpen={onOpen} onCancel={onCancelOpen} />
      </header>

      <StructureCard source={source} summary={summary} />
      <StructureLoadStatus state={state} onCancel={cancel} onRetry={retry} />

      {sourceError !== null && <SourceErrorMessage code={sourceError} />}

      {summary !== null && (
        <>
          {summary.rowGroupCount === 0 ? (
            <p className="structure-empty">No row groups</p>
          ) : (
            <>
              <StructureLayoutView
                generation={source.generation}
                summary={summary}
                unit={unit}
                onUnit={setUnit}
                rowGroupCount={summary.rowGroupCount}
                dataAvailable
                highlightedColumn={highlightedColumn}
                onHighlightColumn={setHighlightedColumn}
                selectedRow={selectedRowGroup?.row ?? null}
                onSelectRow={(row) =>
                  setSelectedRowGroup((current) => ({
                    row,
                    request: (current?.request ?? 0) + 1,
                  }))
                }
                onOpenRow={(rowGroupIndex) => {
                  const request = ++rowOffsetRequest.current;
                  setDataBridgeError(null);
                  void getStructureRowOffset(
                    source.generation,
                    rowGroupIndex,
                  ).then(
                    (row) => {
                      if (
                        activeRef.current &&
                        rowOffsetRequest.current === request
                      ) {
                        onOpenData(row);
                      }
                    },
                    () => {
                      if (
                        activeRef.current &&
                        rowOffsetRequest.current === request
                      ) {
                        setDataBridgeError(
                          "This row group could not be located in Data.",
                        );
                      }
                    },
                  );
                }}
              />
              {dataBridgeError !== null && (
                <p className="structure-status-error" role="alert">
                  {dataBridgeError}
                </p>
              )}
              <RowGroupTable
                generation={source.generation}
                unit={unit}
                rowGroupCount={summary.rowGroupCount}
                requestedRow={selectedRowGroup}
              />
            </>
          )}
        </>
      )}

      <ColumnsSection
        generation={source.generation}
        unit={unit}
        columnCount={summary?.columnCount ?? source.columnCount}
        columnPathsTruncated={summary?.columnPathsTruncated}
        chunkAggregatesComplete={summary?.chunkAggregatesComplete}
        ready={summary !== null}
      />
      {summary !== null && (
        <KeyValueMetadata generation={source.generation} summary={summary} />
      )}
    </section>
  );
}

function SourceErrorMessage({ code }: { code: SourceErrorCode }) {
  const messages: Record<SourceErrorCode, string> = {
    notFound: "That file is no longer available. Choose it again.",
    permissionDenied:
      "Viewda cannot read that file. Check its permissions and try again.",
    sourceChanged: "That file changed after it was opened. Open it again.",
    notParquet: "That file is not Parquet. Choose a .parquet file.",
    corruptFooter:
      "The Parquet footer is damaged or incomplete. Choose another file.",
    unsupported: "Viewda cannot inspect that source yet. Choose another file.",
  };

  return (
    <p className="source-error" role="alert">
      {messages[code]}
    </p>
  );
}

export function formatFileSize(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  if (bytes < 1_000) {
    return `${bytes} B`;
  }

  let value = bytes;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }

  if (value >= 999.95 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }

  return `${value.toFixed(1)} ${units[unit]}`;
}
