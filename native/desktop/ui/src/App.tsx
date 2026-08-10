import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  checkForUpdate,
  discardPendingUpdate,
  getPendingDataExportCloseDialog,
  getDefaultApplicationStatus,
  getDataViewSettings,
  getEngineStatus,
  getRecentSources,
  getUpdateSettings,
  installPendingUpdate,
  onOpenSourceRequested,
  onOpenedSourceAvailable,
  onDataExportCloseRequested,
  onSettingsRequested,
  onUpdateAvailable,
  openLocalSource,
  openRecentSource,
  openReleasesPage,
  OpenSourceError,
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
  type RecentSource,
  type SourceErrorCode,
  type SourceSummary,
  type UpdateChannel,
  type UpdateInfo,
  type UpdateSettings,
  UpdateCommandError,
} from "./desktop";
import { SchemaTreeNode } from "./SchemaTree";
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

type SourceMode = "data" | "structure";

type TitlebarUpdate =
  | { kind: "available"; version: string; simulated: boolean }
  | { kind: "installing"; version: string; simulated: boolean }
  | {
      kind: "installed";
      version: string;
      simulated: boolean;
      dismissing: boolean;
    };

const SIMULATED_UPDATE_VERSION = "99.99.99";
const SIMULATED_INSTALL_DELAY_MS = 800;
const POST_UPDATE_FADE_DELAY_MS = 59_800;
const POST_UPDATE_REMOVE_DELAY_MS = 60_000;
const UPDATE_FADE_DURATION_MS = 200;

export function App({
  initialTheme = "system",
}: {
  initialTheme?: ThemePreference;
}) {
  const [readiness, setReadiness] = useState<Readiness>({ kind: "loading" });
  const [source, setSource] = useState<SourceSummary | null>(null);
  const [sourceError, setSourceError] = useState<SourceErrorCode | null>(null);
  const [sourceMode, setSourceMode] = useState<SourceMode>("data");
  const [opening, setOpening] = useState(false);
  const [recentSources, setRecentSources] = useState<RecentSource[]>([]);
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
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const simulatedInstallTimer = useRef<number | null>(null);
  const dismissTimer = useRef<number | null>(null);
  const receivedOpenedSource = useRef(false);

  useLayoutEffect(() => {
    const systemTheme = window.matchMedia(SYSTEM_THEME_QUERY);
    const applyTheme = () => {
      const effectiveTheme = applyDocumentTheme(
        themePreference,
        systemTheme.matches,
      );
      if (themePreference === "system") {
        void syncSystemTheme(effectiveTheme).catch(() => {
          // DOM and canvas still follow the live OS theme if native sync fails.
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

  const openSource = useCallback(async () => {
    setOpening(true);
    setSourceError(null);

    try {
      const selected = await openLocalSource();
      if (selected !== null) {
        setSource(selected);
        setSourceMode("data");
      }
    } catch (error) {
      setSourceError(
        error instanceof OpenSourceError ? error.code : "unsupported",
      );
    } finally {
      setOpening(false);
    }
  }, []);

  const openRecent = useCallback(async (id: string) => {
    setOpening(true);
    setSourceError(null);

    try {
      setSource(await openRecentSource(id));
      setSourceMode("data");
    } catch (error) {
      const code =
        error instanceof OpenSourceError ? error.code : "unsupported";
      setSourceError(code);
      if (code === "notFound") {
        setRecentSources((entries) =>
          entries.filter((entry) => entry.id !== id),
        );
      }
    } finally {
      setOpening(false);
    }
  }, []);

  const receiveOpenedSource = useCallback(async () => {
    try {
      const activation = await takeOpenedSource();
      if (activation === null) {
        return;
      }
      receivedOpenedSource.current = true;
      setSourceError(activation.sourceError);
      if (activation.source !== null) {
        setSource(activation.source);
        setSourceMode("data");
      }
    } catch {
      setSourceError("unsupported");
    }
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
    let active = true;

    getRecentSources()
      .then((entries) => {
        if (active) {
          setRecentSources(entries);
        }
      })
      .catch(() => {
        if (active) {
          setRecentSources([]);
        }
      });

    return () => {
      active = false;
    };
  }, [readiness.kind]);

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
        if (!receivedOpenedSource.current && restored.source !== null) {
          setSource(restored.source);
          setSourceMode("data");
          setSourceMode("data");
        }
        if (!receivedOpenedSource.current && restored.sourceError !== null) {
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
  }, []);

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
        window.clearTimeout(simulatedInstallTimer.current);
      }
      if (dismissTimer.current !== null) {
        window.clearTimeout(dismissTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (source === null) {
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
        setSourceMode(event.key === "1" ? "data" : "structure");
      }
    };
    window.addEventListener("keydown", switchMode);
    return () => window.removeEventListener("keydown", switchMode);
  }, [source]);

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
    setTitlebarUpdate({ ...available, kind: "installing" });
    setUpdateMessage(null);

    if (available.simulated) {
      simulatedInstallTimer.current = window.setTimeout(() => {
        setTitlebarUpdate({
          kind: "installed",
          version: available.version,
          simulated: true,
          dismissing: false,
        });
        simulatedInstallTimer.current = null;
      }, SIMULATED_INSTALL_DELAY_MS);
      return;
    }

    try {
      const restarting = await installPendingUpdate();
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
    setUpdateMessage(null);
    try {
      const restarting = await installPendingUpdate();
      if (!restarting) {
        setInstallingDowngrade(false);
      }
    } catch {
      setInstallingDowngrade(false);
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
    <main className="app-shell">
      <header className="titlebar">
        <span className={`file-context${source === null ? " is-empty" : ""}`}>
          {source?.displayName ?? "No file open"}
        </span>
        {source !== null && (
          <ModeSwitch mode={sourceMode} onMode={setSourceMode} />
        )}
        <TitlebarUpdateStatus
          update={titlebarUpdate}
          onActivate={installAvailableUpdate}
          onDismiss={dismissPostUpdate}
          onReleasePage={showReleasePage}
        />
      </header>

      <div className={`workspace${source === null ? " is-empty" : ""}`}>
        {source === null ? (
          <section className="empty-state" aria-label="Open a Parquet file">
            {readiness.kind === "loading" && (
              <>
                <OpenButton disabled opening={false} onOpen={openSource} />
                <p className="empty-message">Starting the local data engine…</p>
              </>
            )}
            {readiness.kind === "ready" && (
              <>
                <OpenButton opening={opening} onOpen={openSource} />
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
                The local data engine could not start. Restart Viewda and try
                again.
              </p>
            )}
            <ShortcutHints modifier={shortcutModifier} />
            {sourceError !== null && <SourceErrorMessage code={sourceError} />}
          </section>
        ) : (
          <>
            <div className="mode-panel" hidden={sourceMode !== "data"}>
              <div className="data-mode">
                {sourceError !== null && (
                  <SourceErrorMessage code={sourceError} />
                )}
                <Suspense
                  fallback={
                    <p className="data-grid-loading" role="status">
                      Loading data grid…
                    </p>
                  }
                >
                  <DataGrid
                    key={source.generation}
                    source={source}
                    viewSettings={dataViewSettings}
                  />
                </Suspense>
              </div>
            </div>
            <div
              className="mode-panel structure-mode-panel"
              hidden={sourceMode !== "structure"}
            >
              <SourceDetails
                opening={opening}
                source={source}
                sourceError={sourceError}
                onOpen={openSource}
              />
            </div>
          </>
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
          changingDefaultApplication={changingDefaultApplication}
        />
      )}
      {downgrade !== null && (
        <DowngradeDialog
          update={downgrade}
          installing={installingDowngrade}
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
        onClick={onDismiss}
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
      </div>
    );
  }

  const installing = update.kind === "installing";
  return (
    <button
      className={`update-indicator${installing ? " is-installing" : ""}`}
      type="button"
      disabled={installing}
      onClick={() => void onActivate()}
    >
      {installing ? "updating…" : `update to ${update.version}`}
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
  onDowngrade,
  onWait,
}: {
  update: UpdateInfo;
  installing: boolean;
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
}: {
  opening: boolean;
  disabled?: boolean;
  onOpen: () => Promise<void>;
}) {
  return (
    <button
      className="open-button"
      type="button"
      disabled={disabled || opening}
      onClick={() => void onOpen()}
    >
      {opening ? "Opening…" : "Open Parquet file…"}
    </button>
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
  opening,
  source,
  sourceError,
  onOpen,
}: {
  opening: boolean;
  source: SourceSummary;
  sourceError: SourceErrorCode | null;
  onOpen: () => Promise<void>;
}) {
  return (
    <section className="source-view" aria-label="Parquet source">
      <div className="source-heading">
        <OpenButton opening={opening} onOpen={onOpen} />
      </div>

      <dl className="source-facts" aria-label="File facts">
        <Fact label="Rows" value={formatNumber(source.rowCount)} />
        <Fact label="Row groups" value={formatNumber(source.rowGroupCount)} />
        <Fact label="Fields" value={formatNumber(source.schema.length)} />
        <Fact
          label="Size"
          value={formatFileSize(source.sizeBytes)}
          title={`${formatNumber(source.sizeBytes)} bytes`}
        />
      </dl>

      {sourceError !== null && <SourceErrorMessage code={sourceError} />}

      <div className="schema-card">
        <h2>Schema</h2>
        <ul className="schema-tree">
          {source.schema.map((field, fieldIndex) => (
            <SchemaTreeNode key={fieldIndex} field={field} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function Fact({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="fact-value" title={title}>
        {value}
      </dd>
    </div>
  );
}

function SourceErrorMessage({ code }: { code: SourceErrorCode }) {
  const messages: Record<SourceErrorCode, string> = {
    notFound: "That file is no longer available. Choose it again.",
    permissionDenied:
      "Viewda cannot read that file. Check its permissions and try again.",
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

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
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
