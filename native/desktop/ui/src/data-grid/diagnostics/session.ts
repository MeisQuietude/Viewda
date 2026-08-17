import {
  DiagnosticEpisodeCollector,
  addPhaseDuration,
  emptyPhaseDurations,
  emptyRequestLifecycle,
  hasRequestLifecycle,
  markDiagnosticTrigger,
  mergeRequestLifecycle,
  type DiagnosticFrame,
  type GridPerformanceAxis,
  type RequestLifecycle,
  type WheelBatch,
} from "./episodes";
import { NumericSamples, roundHertz, roundMilliseconds } from "./samples";

// Reports use fixed thresholds so recordings remain comparable across machines.

// A 250 ms pause ends a reported gesture. This is deliberately longer than the
// renderer's axis lock because one report episode may contain several bursts.
const SCROLL_GESTURE_IDLE_MS = 250;

// The report flags both display-relative misses and absolute stalls over 50 ms.
const LONG_SCROLL_FRAME_INTERVAL_MS = 50;

// Sixty idle rAF intervals give a stable refresh-rate estimate in about a second
// on a 60 Hz display.
const REFERENCE_INTERVAL_LIMIT = 60;

// Before that sample is ready, 25 ms allows 1.5 frames on a 60 Hz display.
const FALLBACK_FRAME_BUDGET_MS = 25;

// A data-window call over 50 ms is slow enough to explain a visible stall and
// earns a diagnostic episode.
const DATA_WINDOW_SLOW_MS = 50;

// The last 64 terminal requests usually cover the lead-up to a stall without
// making copied reports unwieldy.
const RECENT_DATA_WINDOW_LIMIT = 64;

// Only the bounded `first:last:shape:hash` fingerprint may enter a copied report.
// Keep this in sync with projectionFingerprint(); it is a privacy boundary.
const PROJECTION_FINGERPRINT_PATTERN = /^(?:\d+|-):(?:\d+|-):[cs]:[\da-f]{8}$/;

// Async work can outlive a recording. Monotonic module-level ids prevent a
// late request, frame, or commit token from colliding with a newer session.
let nextRequestToken = 1;
let nextFrameToken = 1;
let nextCommitToken = 1;

function sanitizeProjectionFingerprint(value: string): string {
  // Reports are copied outside the app. Accept only the fixed-size fingerprint
  // produced by the grid so a diagnostics sink cannot leak arbitrary metadata.
  return PROJECTION_FINGERPRINT_PATTERN.test(value) ? value : "";
}

export interface GridPerformanceStart {
  runtime: {
    appVersion: string;
    queryEngineVersion: string;
    userAgent: string;
    platform: string;
    theme: "light" | "dark";
  };
  source: {
    sizeBytes: number;
    rowCount: number;
    columnCount: number;
  } | null;
}

export interface GridPerformanceConfiguration {
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  verticalMode: "native" | "compressed";
  rowHeight: number;
  rowCount: number;
  columnCount: number;
  pinnedColumnCount: number;
}

export interface GridPerformanceViewport {
  visibleRowStart: number;
  visibleRowCount: number;
  visibleScrollingColumnStart: number;
  visibleScrollingColumnCount: number;
  mountedRowStart: number;
  mountedRowCount: number;
  mountedScrollingColumnStart: number;
  mountedScrollingColumnCount: number;
  renderedColumnCount: number;
  renderedCellCount: number;
}

export type GridWheelOutcome =
  | "appliedMovement"
  | "atStartBoundary"
  | "atEndBoundary"
  | "noScrollableExtent"
  | "axisLockedNoise"
  | "accumulatingWholeRow";

export interface GridPerformanceWheel {
  timeStamp: number;
  handlerDurationMs: number;
  decision: "horizontal" | "vertical" | "ambiguous";
  consumed: boolean;
  takeover: boolean;
  requestedHorizontalPixels: number;
  appliedHorizontalPixels: number;
  requestedVerticalPixels: number;
  appliedVerticalRowSteps: number;
  outcome: GridWheelOutcome | null;
}

export type GridDiagnosticsWheel = Omit<
  GridPerformanceWheel,
  "handlerDurationMs"
>;

export type GridPendingRequestDisposal =
  | "supersededBeforeStart"
  | "satisfiedByCompletedWindow"
  | "invalidatedBeforeStart";

export type GridReactCommitSource = "input" | "measurement";

export type GridDataWindowRequestReason =
  "initial" | "rowWindow" | "columnProjection" | "rowAndColumnWindow" | "retry";

export interface GridDataWindowRequest {
  reason: GridDataWindowRequestReason;
  rowOffset: number;
  rowCount: number;
  projectionCount: number;
  projectionKey: string;
  filtered: boolean;
  sorted: boolean;
}

export interface GridDiagnosticsSink {
  isEnabled(): boolean;
  startWheel(): number | null;
  wheel(startedAt: number | null, event: GridDiagnosticsWheel): number | null;
  configure(configuration: GridPerformanceConfiguration): void;
  measurementStart(timeStamp: number): number | null;
  measurementEnd(
    frameId: number | null,
    timeStamp: number,
    reactWorkScheduled: boolean,
  ): void;
  reactCommit(
    frameId: number | null,
    timeStamp: number,
    source: GridReactCommitSource,
    trackNextAnimationFrame?: boolean,
  ): number | null;
  nextAnimationFrame(commitToken: number | null, timeStamp: number): void;
  viewport(frameId: number | null, viewport: GridPerformanceViewport): void;
  queueRequest(request?: GridDataWindowRequest): number | null;
  disposeRequest(id: number | null, reason: GridPendingRequestDisposal): void;
  startRequest(id: number | null): void;
  finishRequest(
    id: number | null,
    outcome: "completed" | "failed",
    stale: boolean,
  ): void;
}

export interface GridDiagnosticsController {
  readonly sink: GridDiagnosticsSink;
  start(metadata: GridPerformanceStart): void;
  stop(): string | null;
  dispose(): void;
}

interface GridPerformanceClock {
  now(): number;
  isoNow(): string;
}

interface PendingRequest {
  queuedAt: number;
  startedAt: number | null;
  metadata: GridDataWindowRequest | null;
}

interface CompletedRequest {
  relativeMs: number;
  reason: GridDataWindowRequestReason;
  rowOffset: number;
  rowCount: number;
  projectionCount: number;
  projectionKey: string;
  filtered: boolean;
  sorted: boolean;
  queueWaitMs: number | null;
  durationMs: number | null;
  outcome: "completed" | "failed" | GridPendingRequestDisposal;
  stale: boolean;
}

type GridViewportSnapshot = Pick<
  GridPerformanceViewport,
  | "visibleRowStart"
  | "visibleRowCount"
  | "visibleScrollingColumnStart"
  | "visibleScrollingColumnCount"
  | "mountedRowStart"
  | "mountedRowCount"
  | "mountedScrollingColumnStart"
  | "mountedScrollingColumnCount"
>;

class AxisScrollMeasurements {
  private inputEvents = 0;
  private movedEvents = 0;
  private requestedUnits = 0;
  private appliedUnits = 0;
  private longScrollAnimationFrameIntervals = 0;
  private previousMovedInputAt: number | null = null;
  private readonly movedWheelToAnimationFrameMs = new NumericSamples();
  private readonly movedWheelInputIntervalMs = new NumericSamples();
  private readonly wheelHandlerDurationMs = new NumericSamples();
  private readonly scrollAnimationFrameIntervalMs = new NumericSamples();
  private readonly outcomes: Partial<Record<GridWheelOutcome, number>> = {};

  input(
    timeStamp: number,
    handlerDurationMs: number,
    outcome: GridWheelOutcome,
    requested: number,
    applied: number,
  ) {
    this.inputEvents += 1;
    const moved = outcome === "appliedMovement";
    this.movedEvents += Number(moved);
    this.requestedUnits += Math.abs(requested);
    this.appliedUnits += Math.abs(applied);
    this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1;
    this.wheelHandlerDurationMs.add(handlerDurationMs);
    if (moved) {
      if (this.previousMovedInputAt !== null) {
        const interval = timeStamp - this.previousMovedInputAt;
        if (interval >= 0 && interval <= SCROLL_GESTURE_IDLE_MS) {
          this.movedWheelInputIntervalMs.add(interval);
        }
      }
      this.previousMovedInputAt = timeStamp;
    }
  }

  wheelToFrame(milliseconds: number) {
    this.movedWheelToAnimationFrameMs.add(milliseconds);
  }

  frameInterval(milliseconds: number) {
    this.scrollAnimationFrameIntervalMs.add(milliseconds);
    this.longScrollAnimationFrameIntervals += Number(
      milliseconds > LONG_SCROLL_FRAME_INTERVAL_MS,
    );
  }

  report(axis: GridPerformanceAxis) {
    const allowed: GridWheelOutcome[] = [
      "appliedMovement",
      "atStartBoundary",
      "atEndBoundary",
      "noScrollableExtent",
      "axisLockedNoise",
      ...(axis === "vertical" ? (["accumulatingWholeRow"] as const) : []),
    ];
    return {
      inputEvents: this.inputEvents,
      movedEvents: this.movedEvents,
      ...(axis === "horizontal"
        ? {
            requestedPixels: roundMilliseconds(this.requestedUnits),
            appliedPixels: roundMilliseconds(this.appliedUnits),
            clampedPixels: roundMilliseconds(
              Math.max(0, this.requestedUnits - this.appliedUnits),
            ),
          }
        : {
            requestedPixels: roundMilliseconds(this.requestedUnits),
            appliedRowSteps: this.appliedUnits,
          }),
      outcomes: Object.fromEntries(
        allowed.map((outcome) => [outcome, this.outcomes[outcome] ?? 0]),
      ),
      movedWheelToAnimationFrameMs: this.movedWheelToAnimationFrameMs.report(),
      movedWheelInputIntervalMs: this.movedWheelInputIntervalMs.report(),
      wheelHandlerDurationMs: this.wheelHandlerDurationMs.report(),
      scrollAnimationFrameIntervalMs:
        this.scrollAnimationFrameIntervalMs.report(),
      longScrollAnimationFrameIntervals: this.longScrollAnimationFrameIntervals,
    };
  }
}

class GridPerformanceSession {
  private readonly startedAt: number;
  private readonly recordedAt: string;
  private configuration: GridPerformanceConfiguration | null = null;
  private configurationChanges = 0;
  private wheelInputEvents = 0;
  private wheelConsumedEvents = 0;
  private wheelDecidedEvents = 0;
  private wheelMovedEvents = 0;
  private wheelAmbiguousEvents = 0;
  private wheelTakeovers = 0;
  private lastWheelInputAt: number | null = null;
  private pendingMovedWheel: {
    timeStamp: number;
    axis: GridPerformanceAxis;
  } | null = null;
  private pendingWheelBatch: WheelBatch | null = null;
  private pendingWheelFrame: DiagnosticFrame | null = null;
  private previousAttributedScrollFrame: {
    timeStamp: number;
    axis: GridPerformanceAxis;
  } | null = null;
  private previousReferenceFrameTime: number | null = null;
  private referenceFrameBudgetMs: number | null = null;
  private readonly referenceAnimationFrameIntervalMs = new NumericSamples();
  private readonly measurementCallbackDurationMs = new NumericSamples();
  private readonly measurementToReactCommitMs = new NumericSamples();
  private readonly inputToReactCommitMs = new NumericSamples();
  private readonly commitToNextAnimationFrameMs = new NumericSamples();
  private readonly horizontalScroll = new AxisScrollMeasurements();
  private readonly verticalScroll = new AxisScrollMeasurements();
  private measurementFrames = 0;
  private measurementFramesAwaitingReactCommit = 0;
  private measurementFramesNotAwaitingReactCommit = 0;
  private visibleViewportChanges = 0;
  private mountedWindowChanges = 0;
  private visibleRowChanges = 0;
  private visibleColumnChanges = 0;
  private mountedRowChanges = 0;
  private mountedColumnChanges = 0;
  private previousViewport: GridViewportSnapshot | null = null;
  private maximumRenderedRows = 0;
  private maximumRenderedColumns = 0;
  private maximumRenderedCells = 0;
  private maximumDomCells = 0;
  private requestsQueued = 0;
  private requestsStarted = 0;
  private requestsCompleted = 0;
  private requestsFailed = 0;
  private requestsStale = 0;
  private readonly requestDisposals: Record<
    GridPendingRequestDisposal,
    number
  > = {
    supersededBeforeStart: 0,
    satisfiedByCompletedWindow: 0,
    invalidatedBeforeStart: 0,
  };
  private readonly requestQueueWaitMs = new NumericSamples();
  private readonly requestDurationMs = new NumericSamples();
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly recentRequests: CompletedRequest[] = [];
  private pendingRequestLifecycle = emptyRequestLifecycle();
  private readonly frames = new Map<number, DiagnosticFrame>();
  private readonly diagnosticEpisodes = new DiagnosticEpisodeCollector();
  private readonly pendingCommits = new Map<
    number,
    { frameId: number; committedAt: number }
  >();
  private readonly metadata: GridPerformanceStart;

  constructor(
    start: GridPerformanceStart,
    private readonly clock: GridPerformanceClock,
  ) {
    this.startedAt = clock.now();
    this.recordedAt = clock.isoNow();
    this.metadata = {
      runtime: {
        appVersion: start.runtime.appVersion,
        queryEngineVersion: start.runtime.queryEngineVersion,
        userAgent: start.runtime.userAgent,
        platform: start.runtime.platform,
        theme: start.runtime.theme,
      },
      source:
        start.source === null
          ? null
          : {
              sizeBytes: start.source.sizeBytes,
              rowCount: start.source.rowCount,
              columnCount: start.source.columnCount,
            },
    };
  }

  configure(configuration: GridPerformanceConfiguration) {
    const sanitized = {
      viewportWidth: configuration.viewportWidth,
      viewportHeight: configuration.viewportHeight,
      devicePixelRatio: configuration.devicePixelRatio,
      verticalMode: configuration.verticalMode,
      rowHeight: configuration.rowHeight,
      rowCount: configuration.rowCount,
      columnCount: configuration.columnCount,
      pinnedColumnCount: configuration.pinnedColumnCount,
    };
    if (!sameConfiguration(this.configuration, sanitized)) {
      this.configuration = sanitized;
      this.configurationChanges += 1;
    }
  }

  wheel(event: GridPerformanceWheel): number | null {
    if (
      this.lastWheelInputAt !== null &&
      event.timeStamp - this.lastWheelInputAt > SCROLL_GESTURE_IDLE_MS
    ) {
      this.finalizeIdleWheelBatch(event.timeStamp);
    }
    this.lastWheelInputAt = event.timeStamp;
    this.previousReferenceFrameTime = null;
    if (this.referenceFrameBudgetMs === null) {
      this.referenceAnimationFrameIntervalMs.clear();
    }
    this.wheelInputEvents += 1;
    this.wheelConsumedEvents += Number(event.consumed);
    this.wheelDecidedEvents += Number(event.decision !== "ambiguous");
    this.wheelAmbiguousEvents += Number(event.decision === "ambiguous");
    this.wheelTakeovers += Number(event.takeover);
    if (event.decision === "ambiguous" || event.outcome === null) {
      return null;
    }
    const axis = event.decision;
    const requested =
      axis === "horizontal"
        ? event.requestedHorizontalPixels
        : event.requestedVerticalPixels;
    const applied =
      axis === "horizontal"
        ? event.appliedHorizontalPixels
        : event.appliedVerticalRowSteps;
    this.axisMeasurements(axis).input(
      event.timeStamp,
      event.handlerDurationMs,
      event.outcome,
      requested,
      applied,
    );
    const moved = event.outcome === "appliedMovement";
    this.wheelMovedEvents += Number(moved);
    if (moved) {
      this.pendingMovedWheel = { timeStamp: event.timeStamp, axis };
    }
    const batch = (this.pendingWheelBatch ??= emptyWheelBatch());
    batch.firstInputAt ??= event.timeStamp;
    batch.axis = batch.eventCount === 0 || batch.axis === axis ? axis : null;
    batch.eventCount += 1;
    batch.requestedHorizontalPixels +=
      axis === "horizontal" ? Math.abs(event.requestedHorizontalPixels) : 0;
    batch.appliedHorizontalPixels +=
      axis === "horizontal" ? Math.abs(event.appliedHorizontalPixels) : 0;
    batch.requestedVerticalPixels +=
      axis === "vertical" ? Math.abs(event.requestedVerticalPixels) : 0;
    batch.appliedVerticalRowSteps +=
      axis === "vertical" ? Math.abs(event.appliedVerticalRowSteps) : 0;
    batch.outcomes[event.outcome] = (batch.outcomes[event.outcome] ?? 0) + 1;
    if (moved) {
      batch.latestMovedInputAt = event.timeStamp;
    }
    if (event.takeover) {
      batch.triggers.add("axisTakeover");
    }
    if (isBoundaryOutcome(event.outcome)) {
      batch.triggers.add("scrollBoundary");
    }
    if (!moved) {
      return this.pendingWheelFrame?.frameId ?? null;
    }
    this.pendingWheelFrame ??= this.createFrame(event.timeStamp);
    this.pendingWheelFrame.wheelBatch = batch;
    return this.pendingWheelFrame.frameId;
  }

  referenceFrame(timeStamp: number): boolean {
    if (this.referenceFrameBudgetMs !== null) {
      return true;
    }
    if (
      this.lastWheelInputAt !== null &&
      timeStamp - this.lastWheelInputAt < SCROLL_GESTURE_IDLE_MS
    ) {
      this.previousReferenceFrameTime = null;
      return false;
    }
    if (this.previousReferenceFrameTime !== null) {
      this.referenceAnimationFrameIntervalMs.add(
        timeStamp - this.previousReferenceFrameTime,
      );
    }
    this.previousReferenceFrameTime = timeStamp;
    if (
      this.referenceAnimationFrameIntervalMs.sampleCount >=
      REFERENCE_INTERVAL_LIMIT
    ) {
      this.referenceFrameBudgetMs =
        this.referenceAnimationFrameIntervalMs.percentile(0.5) * 1.5;
      return true;
    }
    return false;
  }

  pauseReferenceCadence() {
    this.previousReferenceFrameTime = null;
    if (this.referenceFrameBudgetMs === null) {
      this.referenceAnimationFrameIntervalMs.clear();
    }
  }

  wheelIdle(timeStamp: number) {
    this.finalizeIdleWheelBatch(timeStamp);
  }

  measurementStart(timeStamp: number): number {
    this.scrollFrame(timeStamp);
    const frame = this.pendingWheelFrame ?? this.createFrame(timeStamp);
    this.pendingWheelFrame = null;
    frame.wheelBatch = this.takeWheelBatch();
    frame.measurementStartedAt = timeStamp;
    frame.requestLifecycle = mergeRequestLifecycle(
      frame.requestLifecycle,
      this.takeRequestLifecycle(),
    );
    this.measurementFrames += 1;
    const inputAt = frame.wheelBatch?.latestMovedInputAt;
    if (inputAt !== null && inputAt !== undefined) {
      frame.movedInputToMeasurementStartMs = timeStamp - inputAt;
    }
    return frame.frameId;
  }

  measurementEnd(
    frameId: number,
    timeStamp: number,
    reactWorkScheduled: boolean,
  ) {
    const frame = this.frames.get(frameId);
    if (frame === undefined || frame.measurementStartedAt === null) {
      return;
    }
    const duration = timeStamp - frame.measurementStartedAt;
    frame.measurementDurationMs = duration;
    this.measurementCallbackDurationMs.add(duration);
    if (reactWorkScheduled) {
      this.measurementFramesAwaitingReactCommit += 1;
    } else {
      this.measurementFramesNotAwaitingReactCommit += 1;
      frame.reactCommit ??= false;
      if (duration > this.frameOverBudgetThresholdMs()) {
        markDiagnosticTrigger(
          frame,
          "frameOverBudget",
          duration / this.frameOverBudgetThresholdMs(),
        );
      }
      this.settleIfComplete(frame);
    }
  }

  reactCommit(
    frameId: number,
    timeStamp: number,
    source: GridReactCommitSource,
    trackNextAnimationFrame = true,
  ): number | null {
    const frame = this.frames.get(frameId);
    if (frame === undefined) {
      return null;
    }
    frame.reactCommit = true;
    const inputAt = frame.wheelBatch?.latestMovedInputAt;
    if (inputAt !== null && inputAt !== undefined) {
      const duration = timeStamp - inputAt;
      addPhaseDuration(frame.inputToReactCommit, duration);
      this.inputToReactCommitMs.add(duration);
    }
    if (source === "measurement" && frame.measurementStartedAt !== null) {
      const duration = timeStamp - frame.measurementStartedAt;
      addPhaseDuration(frame.measurementToReactCommit, duration);
      this.measurementToReactCommitMs.add(duration);
    }
    if (
      frame.inputToReactCommit.maxMs > this.frameOverBudgetThresholdMs() ||
      frame.measurementToReactCommit.maxMs > this.frameOverBudgetThresholdMs()
    ) {
      markDiagnosticTrigger(
        frame,
        "frameOverBudget",
        Math.max(
          frame.inputToReactCommit.maxMs,
          frame.measurementToReactCommit.maxMs,
        ) / this.frameOverBudgetThresholdMs(),
      );
    }
    if (!trackNextAnimationFrame) {
      this.settleIfComplete(frame);
      return null;
    }
    const token = nextCommitToken;
    nextCommitToken += 1;
    this.pendingCommits.set(token, { frameId, committedAt: timeStamp });
    return token;
  }

  nextAnimationFrame(commitToken: number, timeStamp: number) {
    const commit = this.pendingCommits.get(commitToken);
    if (commit === undefined) {
      return;
    }
    this.pendingCommits.delete(commitToken);
    const frame = this.frames.get(commit.frameId);
    if (frame === undefined) {
      return;
    }
    const duration = timeStamp - commit.committedAt;
    addPhaseDuration(frame.commitToNextAnimationFrame, duration);
    this.commitToNextAnimationFrameMs.add(duration);
    const start =
      frame.wheelBatch?.latestMovedInputAt ??
      frame.measurementStartedAt ??
      commit.committedAt;
    if (
      duration > this.frameOverBudgetThresholdMs() ||
      timeStamp - start > this.endToEndFrameOverBudgetThresholdMs()
    ) {
      markDiagnosticTrigger(
        frame,
        "frameOverBudget",
        Math.max(
          duration / this.frameOverBudgetThresholdMs(),
          (timeStamp - start) / this.endToEndFrameOverBudgetThresholdMs(),
        ),
      );
    }
    this.settleIfComplete(frame);
  }

  viewport(frameId: number | null, viewport: GridPerformanceViewport) {
    const frame = frameId === null ? undefined : this.frames.get(frameId);
    const previous = this.previousViewport;
    const visibleRowChanged =
      previous === null ||
      previous.visibleRowStart !== viewport.visibleRowStart ||
      previous.visibleRowCount !== viewport.visibleRowCount;
    const visibleColumnChanged =
      previous === null ||
      previous.visibleScrollingColumnStart !==
        viewport.visibleScrollingColumnStart ||
      previous.visibleScrollingColumnCount !==
        viewport.visibleScrollingColumnCount;
    const mountedRowChanged =
      previous === null ||
      previous.mountedRowStart !== viewport.mountedRowStart ||
      previous.mountedRowCount !== viewport.mountedRowCount;
    const mountedColumnChanged =
      previous === null ||
      previous.mountedScrollingColumnStart !==
        viewport.mountedScrollingColumnStart ||
      previous.mountedScrollingColumnCount !==
        viewport.mountedScrollingColumnCount;
    this.visibleViewportChanges += Number(
      visibleRowChanged || visibleColumnChanged,
    );
    this.mountedWindowChanges += Number(
      mountedRowChanged || mountedColumnChanged,
    );
    if (visibleRowChanged) {
      this.visibleRowChanges += 1;
      if (frame !== undefined) frame.visibleRowChanged = true;
    }
    if (visibleColumnChanged) {
      this.visibleColumnChanges += 1;
      if (frame !== undefined) frame.visibleColumnChanged = true;
    }
    if (mountedRowChanged) {
      this.mountedRowChanges += 1;
      if (frame !== undefined) frame.mountedRowChanged = true;
    }
    if (mountedColumnChanged) {
      this.mountedColumnChanges += 1;
      if (frame !== undefined) frame.mountedColumnChanged = true;
    }
    this.previousViewport = {
      visibleRowStart: viewport.visibleRowStart,
      visibleRowCount: viewport.visibleRowCount,
      visibleScrollingColumnStart: viewport.visibleScrollingColumnStart,
      visibleScrollingColumnCount: viewport.visibleScrollingColumnCount,
      mountedRowStart: viewport.mountedRowStart,
      mountedRowCount: viewport.mountedRowCount,
      mountedScrollingColumnStart: viewport.mountedScrollingColumnStart,
      mountedScrollingColumnCount: viewport.mountedScrollingColumnCount,
    };
    this.maximumRenderedRows = Math.max(
      this.maximumRenderedRows,
      viewport.mountedRowCount,
    );
    this.maximumRenderedColumns = Math.max(
      this.maximumRenderedColumns,
      viewport.renderedColumnCount,
    );
    this.maximumRenderedCells = Math.max(
      this.maximumRenderedCells,
      viewport.mountedRowCount * viewport.renderedColumnCount,
    );
    this.maximumDomCells = Math.max(
      this.maximumDomCells,
      viewport.renderedCellCount,
    );
  }

  queueRequest(metadata?: GridDataWindowRequest): number {
    const id = nextRequestToken;
    nextRequestToken += 1;
    this.requestsQueued += 1;
    this.pendingRequestLifecycle.queued += 1;
    this.pendingRequests.set(id, {
      queuedAt: this.clock.now(),
      startedAt: null,
      metadata:
        metadata === undefined
          ? null
          : {
              ...metadata,
              projectionKey: sanitizeProjectionFingerprint(
                metadata.projectionKey,
              ),
            },
    });
    return id;
  }

  disposeRequest(id: number | null, reason: GridPendingRequestDisposal) {
    if (id !== null) {
      const request = this.pendingRequests.get(id);
      if (request === undefined) return;
      this.pendingRequests.delete(id);
      this.requestDisposals[reason] += 1;
      this.pendingRequestLifecycle[reason] += 1;
      this.recordRequest(request, reason, false);
    }
  }

  startRequest(id: number | null) {
    if (id === null) return;
    const request = this.pendingRequests.get(id);
    if (request === undefined) return;
    this.requestsStarted += 1;
    this.pendingRequestLifecycle.started += 1;
    request.startedAt = this.clock.now();
    this.requestQueueWaitMs.add(request.startedAt - request.queuedAt);
  }

  finishRequest(
    id: number | null,
    outcome: "completed" | "failed",
    stale: boolean,
  ) {
    if (id === null) return;
    const request = this.pendingRequests.get(id);
    if (request === undefined) return;
    this.requestsCompleted += Number(outcome === "completed");
    this.requestsFailed += Number(outcome === "failed");
    this.requestsStale += Number(stale);
    this.pendingRequestLifecycle[outcome] += 1;
    this.pendingRequestLifecycle.stale += Number(stale);
    this.pendingRequests.delete(id);
    const duration =
      request.startedAt === null ? null : this.clock.now() - request.startedAt;
    if (duration !== null) this.requestDurationMs.add(duration);
    this.recordRequest(request, outcome, stale);
    if (stale || (duration !== null && duration > DATA_WINDOW_SLOW_MS)) {
      const frame = this.createFrame(this.clock.now());
      frame.requestLifecycle = this.takeRequestLifecycle();
      if (stale) markDiagnosticTrigger(frame, "dataWindowStale", 2);
      if (duration !== null && duration > DATA_WINDOW_SLOW_MS) {
        markDiagnosticTrigger(
          frame,
          "dataWindowSlow",
          duration / DATA_WINDOW_SLOW_MS,
        );
      }
      this.settle(frame);
    }
  }

  report(): string {
    this.flushTail();
    const reference = this.referenceAnimationFrameIntervalMs.report();
    const diagnosticEpisodes = this.diagnosticEpisodes.report();
    return JSON.stringify(
      {
        schemaVersion: 1,
        reportType: "Viewda grid scroll performance",
        recordedAt: this.recordedAt,
        durationMs: roundMilliseconds(
          Math.max(0, this.clock.now() - this.startedAt),
        ),
        runtime: this.metadata.runtime,
        source: this.metadata.source,
        referenceCadence: {
          referenceAnimationFrameIntervalMs: reference,
          observedAnimationFrameHz:
            reference.p50 > 0 ? roundHertz(1_000 / reference.p50) : null,
        },
        grid: {
          configuration: this.configuration,
          configurationChanges: this.configurationChanges,
          visibleViewportChanges: this.visibleViewportChanges,
          mountedWindowChanges: this.mountedWindowChanges,
          visibleRowChanges: this.visibleRowChanges,
          visibleColumnChanges: this.visibleColumnChanges,
          mountedRowChanges: this.mountedRowChanges,
          mountedColumnChanges: this.mountedColumnChanges,
          maximumRenderedRows: this.maximumRenderedRows,
          maximumRenderedColumns: this.maximumRenderedColumns,
          maximumRenderedCells: this.maximumRenderedCells,
          maximumDomCells: this.maximumDomCells,
        },
        wheel: {
          inputEvents: this.wheelInputEvents,
          consumedEvents: this.wheelConsumedEvents,
          decidedEvents: this.wheelDecidedEvents,
          movedEvents: this.wheelMovedEvents,
          ambiguousEvents: this.wheelAmbiguousEvents,
          takeovers: this.wheelTakeovers,
          longScrollAnimationFrameIntervalThresholdMs:
            LONG_SCROLL_FRAME_INTERVAL_MS,
          horizontal: this.horizontalScroll.report("horizontal"),
          vertical: this.verticalScroll.report("vertical"),
        },
        timing: {
          measurementFrames: this.measurementFrames,
          measurementFramesAwaitingReactCommit:
            this.measurementFramesAwaitingReactCommit,
          measurementFramesNotAwaitingReactCommit:
            this.measurementFramesNotAwaitingReactCommit,
          measurementCallbackDurationMs:
            this.measurementCallbackDurationMs.report(),
          measurementToReactCommitMs: this.measurementToReactCommitMs.report(),
          inputToReactCommitMs: this.inputToReactCommitMs.report(),
          commitToNextAnimationFrameMs:
            this.commitToNextAnimationFrameMs.report(),
        },
        dataWindows: {
          queued: this.requestsQueued,
          started: this.requestsStarted,
          completed: this.requestsCompleted,
          failed: this.requestsFailed,
          stale: this.requestsStale,
          pendingAtStop: this.pendingRequests.size,
          pendingRequestDisposals: this.requestDisposals,
          queueWaitMs: this.requestQueueWaitMs.report(),
          requestDurationMs: this.requestDurationMs.report(),
          recentRequests: this.recentRequests,
        },
        diagnostics: {
          frameOverBudgetThresholdMs: roundMilliseconds(
            this.frameOverBudgetThresholdMs(),
          ),
          endToEndFrameOverBudgetThresholdMs: roundMilliseconds(
            this.endToEndFrameOverBudgetThresholdMs(),
          ),
          dataWindowSlowThresholdMs: DATA_WINDOW_SLOW_MS,
          diagnosticEpisodes,
        },
      },
      null,
      2,
    );
  }

  private scrollFrame(timeStamp: number) {
    if (this.pendingMovedWheel !== null) {
      const pending = this.pendingMovedWheel;
      const measurements = this.axisMeasurements(pending.axis);
      measurements.wheelToFrame(timeStamp - pending.timeStamp);
      if (
        this.previousAttributedScrollFrame?.axis === pending.axis &&
        timeStamp - this.previousAttributedScrollFrame.timeStamp <=
          SCROLL_GESTURE_IDLE_MS
      ) {
        measurements.frameInterval(
          timeStamp - this.previousAttributedScrollFrame.timeStamp,
        );
      }
      this.previousAttributedScrollFrame = {
        timeStamp,
        axis: pending.axis,
      };
      this.pendingMovedWheel = null;
    }
  }

  private axisMeasurements(axis: GridPerformanceAxis) {
    return axis === "horizontal" ? this.horizontalScroll : this.verticalScroll;
  }

  private recordRequest(
    request: PendingRequest,
    outcome: "completed" | "failed" | GridPendingRequestDisposal,
    stale: boolean,
  ) {
    const metadata = request.metadata;
    if (metadata === null) return;
    const now = this.clock.now();
    this.recentRequests.push({
      relativeMs: roundMilliseconds(Math.max(0, now - this.startedAt)),
      ...metadata,
      queueWaitMs:
        request.startedAt === null
          ? null
          : roundMilliseconds(request.startedAt - request.queuedAt),
      durationMs:
        request.startedAt === null
          ? null
          : roundMilliseconds(now - request.startedAt),
      outcome,
      stale,
    });
    if (this.recentRequests.length > RECENT_DATA_WINDOW_LIMIT) {
      this.recentRequests.shift();
    }
  }

  private frameOverBudgetThresholdMs(): number {
    return this.referenceFrameBudgetMs ?? FALLBACK_FRAME_BUDGET_MS;
  }

  private endToEndFrameOverBudgetThresholdMs(): number {
    return this.frameOverBudgetThresholdMs() * 2;
  }

  private createFrame(timeStamp: number): DiagnosticFrame {
    const frame: DiagnosticFrame = {
      frameId: nextFrameToken,
      relativeMs: Math.max(0, timeStamp - this.startedAt),
      wheelBatch: null,
      measurementStartedAt: null,
      movedInputToMeasurementStartMs: null,
      measurementDurationMs: null,
      reactCommit: null,
      inputToReactCommit: emptyPhaseDurations(),
      measurementToReactCommit: emptyPhaseDurations(),
      commitToNextAnimationFrame: emptyPhaseDurations(),
      visibleRowChanged: false,
      visibleColumnChanged: false,
      mountedRowChanged: false,
      mountedColumnChanged: false,
      requestLifecycle: emptyRequestLifecycle(),
      triggers: new Set(),
      severity: 0,
      settled: false,
    };
    nextFrameToken += 1;
    this.frames.set(frame.frameId, frame);
    return frame;
  }

  private takeWheelBatch(): WheelBatch | null {
    const batch = this.pendingWheelBatch;
    this.pendingWheelBatch = null;
    return batch;
  }

  private takeRequestLifecycle(): RequestLifecycle {
    const lifecycle = this.pendingRequestLifecycle;
    this.pendingRequestLifecycle = emptyRequestLifecycle();
    return lifecycle;
  }

  private settleIfComplete(frame: DiagnosticFrame) {
    const awaitingCommit = [...this.pendingCommits.values()].some(
      (commit) => commit.frameId === frame.frameId,
    );
    const measurementComplete =
      frame.measurementStartedAt === null ||
      frame.measurementDurationMs !== null;
    if (
      measurementComplete &&
      !awaitingCommit &&
      this.pendingWheelFrame !== frame
    ) {
      this.settle(frame);
    }
  }

  private settle(frame: DiagnosticFrame) {
    if (frame.settled) return;
    frame.settled = true;
    this.frames.delete(frame.frameId);
    if (frame.wheelBatch !== null) {
      for (const trigger of frame.wheelBatch.triggers) {
        markDiagnosticTrigger(frame, trigger, 1);
      }
    }
    this.diagnosticEpisodes.collect(frame);
  }

  private finalizeIdleWheelBatch(timeStamp: number) {
    if (this.pendingWheelBatch === null || this.pendingWheelFrame !== null) {
      return;
    }
    const frame = this.createFrame(
      this.pendingWheelBatch.firstInputAt ?? timeStamp,
    );
    frame.wheelBatch = this.takeWheelBatch();
    frame.requestLifecycle = this.takeRequestLifecycle();
    this.settle(frame);
  }

  private flushTail() {
    if (this.pendingWheelBatch !== null) {
      const frame =
        this.pendingWheelFrame ??
        this.createFrame(
          this.pendingWheelBatch.firstInputAt ?? this.clock.now(),
        );
      frame.wheelBatch = this.takeWheelBatch();
      frame.requestLifecycle = mergeRequestLifecycle(
        frame.requestLifecycle,
        this.takeRequestLifecycle(),
      );
      this.settle(frame);
      this.pendingWheelFrame = null;
    } else if (hasRequestLifecycle(this.pendingRequestLifecycle)) {
      const frame = this.createFrame(this.clock.now());
      frame.requestLifecycle = this.takeRequestLifecycle();
      this.settle(frame);
    }
    for (const frame of this.frames.values()) {
      this.settle(frame);
    }
    this.pendingCommits.clear();
  }
}

export function createGridPerformanceRecorder(clock: GridPerformanceClock) {
  let session: GridPerformanceSession | null = null;
  return {
    isRecording: () => session !== null,
    start: (metadata: GridPerformanceStart) => {
      session = new GridPerformanceSession(metadata, clock);
    },
    stop: () => {
      const completed = session;
      session = null;
      return completed?.report() ?? null;
    },
    configure: (configuration: GridPerformanceConfiguration) =>
      session?.configure(configuration),
    wheel: (event: GridPerformanceWheel) => session?.wheel(event) ?? null,
    referenceFrame: (timeStamp: number) =>
      session?.referenceFrame(timeStamp) ?? true,
    pauseReferenceCadence: () => session?.pauseReferenceCadence(),
    wheelIdle: (timeStamp: number) => session?.wheelIdle(timeStamp),
    measurementStart: (timeStamp: number) =>
      session?.measurementStart(timeStamp) ?? null,
    measurementEnd: (
      frameId: number | null,
      timeStamp: number,
      reactWorkScheduled: boolean,
    ) =>
      frameId === null
        ? undefined
        : session?.measurementEnd(frameId, timeStamp, reactWorkScheduled),
    reactCommit: (
      frameId: number | null,
      timeStamp: number,
      source: GridReactCommitSource,
      trackNextAnimationFrame = true,
    ) =>
      frameId === null
        ? null
        : (session?.reactCommit(
            frameId,
            timeStamp,
            source,
            trackNextAnimationFrame,
          ) ?? null),
    nextAnimationFrame: (commitToken: number | null, timeStamp: number) =>
      commitToken === null
        ? undefined
        : session?.nextAnimationFrame(commitToken, timeStamp),
    viewport: (frameId: number | null, viewport: GridPerformanceViewport) =>
      session?.viewport(frameId, viewport),
    queueRequest: (request?: GridDataWindowRequest) =>
      session?.queueRequest(request) ?? null,
    disposeRequest: (id: number | null, reason: GridPendingRequestDisposal) =>
      session?.disposeRequest(id, reason),
    startRequest: (id: number | null) => session?.startRequest(id),
    finishRequest: (
      id: number | null,
      outcome: "completed" | "failed",
      stale: boolean,
    ) => session?.finishRequest(id, outcome, stale),
  };
}

export const gridDiagnosticsNoopSink: GridDiagnosticsSink = {
  isEnabled: () => false,
  startWheel: () => null,
  wheel: () => null,
  configure: () => undefined,
  measurementStart: () => null,
  measurementEnd: () => undefined,
  reactCommit: () => null,
  nextAnimationFrame: () => undefined,
  viewport: () => undefined,
  queueRequest: () => null,
  disposeRequest: () => undefined,
  startRequest: () => undefined,
  finishRequest: () => undefined,
};

export function createGridPerformanceController(
  clock: GridPerformanceClock = {
    now: () => performance.now(),
    isoNow: () => new Date().toISOString(),
  },
): GridDiagnosticsController {
  const recorder = createGridPerformanceRecorder(clock);
  let referenceAnimationFrame: number | null = null;
  let referenceIdleTimer: number | null = null;
  let referenceCadenceComplete = false;

  const stopReferenceCadence = () => {
    if (referenceAnimationFrame !== null) {
      window.cancelAnimationFrame(referenceAnimationFrame);
      referenceAnimationFrame = null;
    }
    if (referenceIdleTimer !== null) {
      window.clearTimeout(referenceIdleTimer);
      referenceIdleTimer = null;
    }
  };
  const scheduleReferenceCadence = () => {
    if (
      !recorder.isRecording() ||
      referenceCadenceComplete ||
      referenceAnimationFrame !== null
    ) {
      return;
    }
    referenceAnimationFrame = window.requestAnimationFrame((timeStamp) => {
      referenceAnimationFrame = null;
      referenceCadenceComplete = recorder.referenceFrame(timeStamp);
      if (!referenceCadenceComplete) scheduleReferenceCadence();
    });
  };
  const pauseReferenceCadence = () => {
    recorder.pauseReferenceCadence();
    if (referenceAnimationFrame !== null) {
      window.cancelAnimationFrame(referenceAnimationFrame);
      referenceAnimationFrame = null;
    }
    if (referenceIdleTimer !== null) window.clearTimeout(referenceIdleTimer);
    referenceIdleTimer = window.setTimeout(() => {
      referenceIdleTimer = null;
      recorder.wheelIdle(clock.now());
      if (!referenceCadenceComplete) scheduleReferenceCadence();
    }, SCROLL_GESTURE_IDLE_MS);
  };

  const sink: GridDiagnosticsSink = {
    isEnabled: recorder.isRecording,
    startWheel: () => (recorder.isRecording() ? clock.now() : null),
    wheel: (startedAt, event) => {
      if (startedAt === null) return null;
      const handlerDurationMs = Math.max(0, clock.now() - startedAt);
      pauseReferenceCadence();
      return recorder.wheel({ ...event, handlerDurationMs });
    },
    configure: recorder.configure,
    measurementStart: recorder.measurementStart,
    measurementEnd: recorder.measurementEnd,
    reactCommit: recorder.reactCommit,
    nextAnimationFrame: recorder.nextAnimationFrame,
    viewport: recorder.viewport,
    queueRequest: recorder.queueRequest,
    disposeRequest: recorder.disposeRequest,
    startRequest: recorder.startRequest,
    finishRequest: recorder.finishRequest,
  };

  return {
    sink,
    start(metadata) {
      stopReferenceCadence();
      referenceCadenceComplete = false;
      recorder.start(metadata);
      scheduleReferenceCadence();
    },
    stop() {
      stopReferenceCadence();
      return recorder.stop();
    },
    dispose() {
      stopReferenceCadence();
      recorder.stop();
    },
  };
}

function emptyWheelBatch(): WheelBatch {
  return {
    axis: null,
    firstInputAt: null,
    eventCount: 0,
    latestMovedInputAt: null,
    requestedHorizontalPixels: 0,
    appliedHorizontalPixels: 0,
    requestedVerticalPixels: 0,
    appliedVerticalRowSteps: 0,
    outcomes: {},
    triggers: new Set(),
  };
}

function isBoundaryOutcome(outcome: GridWheelOutcome): boolean {
  return (
    outcome === "atStartBoundary" ||
    outcome === "atEndBoundary" ||
    outcome === "noScrollableExtent"
  );
}

function sameConfiguration(
  left: GridPerformanceConfiguration | null,
  right: GridPerformanceConfiguration,
): boolean {
  return (
    left !== null &&
    left.viewportWidth === right.viewportWidth &&
    left.viewportHeight === right.viewportHeight &&
    left.devicePixelRatio === right.devicePixelRatio &&
    left.verticalMode === right.verticalMode &&
    left.rowHeight === right.rowHeight &&
    left.rowCount === right.rowCount &&
    left.columnCount === right.columnCount &&
    left.pinnedColumnCount === right.pinnedColumnCount
  );
}
