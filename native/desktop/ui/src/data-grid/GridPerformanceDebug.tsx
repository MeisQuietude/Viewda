import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { EngineStatus, SourceSummary } from "../desktop";
import {
  createGridPerformanceController,
  type GridDiagnosticsSink,
} from "./grid-performance-report";

type GridPerformanceState =
  | { kind: "idle" }
  | { kind: "recording"; startedAt: number }
  | {
      kind: "completed";
      durationMs: number;
      report: string;
      statusVisible: boolean;
    };

interface GridPerformanceDebugRenderProps {
  diagnostics: GridDiagnosticsSink;
  settings: ReactNode;
}

export function GridPerformanceDebug({
  engine,
  source,
  children,
}: {
  engine: EngineStatus | null;
  source: SourceSummary | null;
  children(props: GridPerformanceDebugRenderProps): ReactNode;
}) {
  const controllerRef = useRef<ReturnType<
    typeof createGridPerformanceController
  > | null>(null);
  controllerRef.current ??= createGridPerformanceController();
  const controller = controllerRef.current;
  const [state, setState] = useState<GridPerformanceState>({ kind: "idle" });
  const [message, setMessage] = useState<string | null>(null);

  const start = useCallback(() => {
    if (engine === null) return;
    controller.start({
      runtime: {
        appVersion: engine.version,
        queryEngineVersion: engine.queryEngineVersion,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        theme:
          document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      },
      source:
        source === null
          ? null
          : {
              sizeBytes: source.sizeBytes,
              rowCount: source.rowCount,
              columnCount: source.schema.length,
            },
    });
    setMessage("Recording grid performance…");
    setState({ kind: "recording", startedAt: performance.now() });
  }, [controller, engine, source]);

  const stop = useCallback(() => {
    const report = controller.stop();
    if (report !== null && state.kind === "recording") {
      setState({
        kind: "completed",
        durationMs: Math.max(0, performance.now() - state.startedAt),
        report,
        statusVisible: true,
      });
    }
    setMessage(
      report === null ? "No recording was active." : "Recording stopped.",
    );
  }, [controller, state]);

  const copy = useCallback(async () => {
    if (state.kind !== "completed") return;
    setMessage(null);
    try {
      await navigator.clipboard.writeText(state.report);
      setMessage("Report copied.");
    } catch {
      setMessage(
        "Could not copy the report. The report remains available in Settings.",
      );
    }
  }, [state]);

  const dismiss = useCallback(() => {
    setState((current) =>
      current.kind === "completed"
        ? { ...current, statusVisible: false }
        : current,
    );
    setMessage(null);
  }, []);

  useEffect(() => () => controller.dispose(), [controller]);

  return (
    <>
      {children({
        diagnostics: controller.sink,
        settings: (
          <GridPerformanceSettings
            state={state}
            message={message}
            onStart={start}
            onStop={stop}
            onCopy={copy}
          />
        ),
      })}
      {(state.kind === "recording" ||
        (state.kind === "completed" && state.statusVisible)) && (
        <GridPerformanceStatus
          state={state}
          message={message}
          onStop={stop}
          onCopy={copy}
          onRecordAgain={start}
          onDismiss={dismiss}
        />
      )}
    </>
  );
}

function GridPerformanceSettings({
  state,
  message,
  onStart,
  onStop,
  onCopy,
}: {
  state: GridPerformanceState;
  message: string | null;
  onStart: () => void;
  onStop: () => void;
  onCopy: () => Promise<void>;
}) {
  return (
    <div className="grid-performance-debug">
      <p>
        Record bounded, path-free grid and scroll metrics while reproducing a
        performance problem.
      </p>
      {state.kind === "recording" ? (
        <button className="text-button" type="button" onClick={onStop}>
          Stop recording
        </button>
      ) : state.kind === "idle" ? (
        <button className="text-button" type="button" onClick={onStart}>
          Start recording
        </button>
      ) : (
        <div className="grid-performance-actions">
          <button className="text-button" type="button" onClick={onStart}>
            Record again
          </button>
          <button
            className="text-button"
            type="button"
            onClick={() => void onCopy()}
          >
            Copy report
          </button>
        </div>
      )}
      {state.kind === "completed" && (
        <>
          <label htmlFor="grid-performance-report">
            Grid performance report
          </label>
          <textarea
            id="grid-performance-report"
            readOnly
            value={state.report}
          />
        </>
      )}
      {message !== null && <p role="status">{message}</p>}
    </div>
  );
}

function GridPerformanceStatus({
  state,
  message,
  onStop,
  onCopy,
  onRecordAgain,
  onDismiss,
}: {
  state: Exclude<GridPerformanceState, { kind: "idle" }>;
  message: string | null;
  onStop: () => void;
  onCopy: () => Promise<void>;
  onRecordAgain: () => void;
  onDismiss: () => void;
}) {
  if (state.kind === "completed") {
    const elapsedTime = formatElapsedTime(state.durationMs / 1_000);
    const copySucceeded = message === "Report copied.";
    const copyFailed =
      message?.startsWith("Could not copy the report.") ?? false;
    return (
      <aside
        className="grid-performance-recording-status is-completed"
        aria-label="Grid performance recording completed"
      >
        <time
          aria-label={`Recording duration ${formatElapsedTimeLabel(state.durationMs / 1_000)}`}
        >
          {elapsedTime}
        </time>
        <span className="grid-performance-status-actions">
          <button
            className={`grid-performance-icon-button grid-performance-copy${copySucceeded ? " is-copied" : ""}`}
            type="button"
            aria-label="Copy report"
            title="Copy report"
            onClick={() => void onCopy()}
          >
            <span className="grid-performance-copy-icons" aria-hidden="true">
              <svg
                className="grid-performance-copy-glyph"
                viewBox="0 0 16 16"
                fill="none"
              >
                <rect x="5" y="3" width="8" height="9" rx="1.5" />
                <path d="M3 6.5v5A1.5 1.5 0 0 0 4.5 13H9" />
              </svg>
              <svg
                className="grid-performance-copy-check"
                viewBox="0 0 16 16"
                fill="none"
              >
                <path d="m3.5 8.5 3 3 6-7" />
              </svg>
            </span>
          </button>
          <button
            className="grid-performance-icon-button grid-performance-record-again"
            type="button"
            aria-label="Record again"
            title="Record again"
            onClick={onRecordAgain}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M13 5V2.5l-1.2 1.2A5.5 5.5 0 1 0 13.5 9" />
              <path d="M9.5 5H13" />
            </svg>
          </button>
          <button
            className="grid-performance-icon-button grid-performance-dismiss"
            type="button"
            aria-label="Dismiss performance report"
            title="Dismiss performance report"
            onClick={onDismiss}
          >
            ×
          </button>
        </span>
        {copySucceeded && (
          <span
            className="grid-performance-live"
            role="status"
            aria-live="polite"
          >
            Report copied.
          </span>
        )}
        {copyFailed && (
          <span
            className="grid-performance-copy-error"
            role="status"
            aria-live="polite"
          >
            Copy failed; report remains available in Settings.
          </span>
        )}
      </aside>
    );
  }

  return (
    <aside
      className="grid-performance-recording-status"
      aria-label="Grid performance recording"
    >
      <span className="grid-performance-recording-dot" aria-hidden="true" />
      <span>Recording grid performance</span>
      <GridPerformanceElapsedTime startedAt={state.startedAt} />
      <button className="text-button" type="button" onClick={onStop}>
        Stop recording
      </button>
    </aside>
  );
}

function GridPerformanceElapsedTime({ startedAt }: { startedAt: number }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    const updateElapsed = () => {
      setElapsedSeconds(
        Math.max(0, Math.floor((performance.now() - startedAt) / 1_000)),
      );
    };
    const interval = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(interval);
  }, [startedAt]);

  return <time>{formatElapsedTime(elapsedSeconds)}</time>;
}

function formatElapsedTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatElapsedTimeLabel(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ${remainingSeconds} ${remainingSeconds === 1 ? "second" : "seconds"}`;
}
