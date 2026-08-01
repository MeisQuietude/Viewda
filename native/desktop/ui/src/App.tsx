import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  checkForUpdate,
  discardPendingUpdate,
  getDefaultApplicationStatus,
  getEngineStatus,
  getRecentSources,
  getUpdateSettings,
  installPendingUpdate,
  onOpenSourceRequested,
  onOpenedSourceAvailable,
  onSettingsRequested,
  onUpdateAvailable,
  openLocalSource,
  openRecentSource,
  openReleasesPage,
  OpenSourceError,
  setUpdateSettings as persistUpdateSettings,
  setDefaultApplication,
  shortcutModifier,
  takePostUpdateState,
  takeOpenedSource,
  type DefaultApplicationStatus,
  type EngineStatus,
  type RecentSource,
  type SchemaField,
  type SourceErrorCode,
  type SourceSummary,
  type UpdateChannel,
  type UpdateInfo,
  type UpdateSettings,
  UpdateCommandError,
} from "./desktop";

type Readiness =
  | { kind: "loading" }
  | { kind: "ready"; engine: EngineStatus }
  | { kind: "error" };

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

export function App() {
  const [readiness, setReadiness] = useState<Readiness>({ kind: "loading" });
  const [source, setSource] = useState<SourceSummary | null>(null);
  const [sourceError, setSourceError] = useState<SourceErrorCode | null>(null);
  const [opening, setOpening] = useState(false);
  const [recentSources, setRecentSources] = useState<RecentSource[]>([]);
  const [updateSettings, setUpdateSettings] = useState<UpdateSettings | null>(
    null,
  );
  const [titlebarUpdate, setTitlebarUpdate] = useState<TitlebarUpdate | null>(
    null,
  );
  const [downgrade, setDowngrade] = useState<UpdateInfo | null>(null);
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

  const openSource = useCallback(async () => {
    setOpening(true);
    setSourceError(null);

    try {
      const selected = await openLocalSource();
      if (selected !== null) {
        setSource(selected);
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
      await installPendingUpdate();
    } catch {
      setTitlebarUpdate(available);
      setUpdateMessage("The update could not be installed. Try again.");
    }
  }, [titlebarUpdate]);

  const installDowngrade = useCallback(async () => {
    setInstallingDowngrade(true);
    setUpdateMessage(null);
    try {
      await installPendingUpdate();
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
        <TitlebarUpdateStatus
          update={titlebarUpdate}
          onActivate={installAvailableUpdate}
          onDismiss={dismissPostUpdate}
          onReleasePage={showReleasePage}
        />
      </header>

      <div className="workspace">
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
          <SourceDetails
            opening={opening}
            source={source}
            sourceError={sourceError}
            onOpen={openSource}
          />
        )}
      </div>

      {settingsOpen && updateSettings !== null && (
        <SettingsDialog
          defaultApplication={defaultApplication}
          defaultApplicationMessage={defaultApplicationMessage}
          settings={updateSettings}
          engine={readiness.kind === "ready" ? readiness.engine : null}
          checking={checkingUpdates}
          message={updateMessage}
          onAutomaticChecks={changeAutomaticChecks}
          onChannel={changeUpdateChannel}
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
    </main>
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
  engine,
  checking,
  message,
  onAutomaticChecks,
  onChannel,
  onCheck,
  onClose,
  onMakeDefault,
  onSimulate,
  changingDefaultApplication,
}: {
  defaultApplication: DefaultApplicationStatus | null;
  defaultApplicationMessage: string | null;
  settings: UpdateSettings;
  engine: EngineStatus | null;
  checking: boolean;
  message: string | null;
  onAutomaticChecks: (enabled: boolean) => Promise<void>;
  onChannel: (channel: UpdateChannel) => Promise<void>;
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
          {source.schema.map((field) => (
            <SchemaNode
              key={`${field.name}-${field.physicalType}`}
              field={field}
            />
          ))}
        </ul>
      </div>
      <p className="data-preview-note">
        Data preview is not in this build yet.
      </p>
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

// Physical wrapper nodes are part of the inspected Parquet schema. Keep them
// visible instead of collapsing the tree into a lossy notation such as List<T>.
function SchemaNode({ field }: { field: SchemaField }) {
  return (
    <li>
      <div className="schema-field">
        <span className="schema-name">{field.name}</span>
        <span className="schema-type">
          {field.physicalType}
          {field.logicalType !== null && ` · ${field.logicalType}`}
        </span>
      </div>
      {field.children.length > 0 && (
        <ul>
          {field.children.map((child) => (
            <SchemaNode
              key={`${child.name}-${child.physicalType}`}
              field={child}
            />
          ))}
        </ul>
      )}
    </li>
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
