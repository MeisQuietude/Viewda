import { roundMilliseconds } from "./samples";

const EPISODE_LIMIT = 12;
const FRAME_LIMIT = 8;
const PRE_CONTEXT = 3;
const POST_CONTEXT = 2;

export type GridPerformanceAxis = "horizontal" | "vertical";
export type DiagnosticTrigger =
  | "frameOverBudget"
  | "axisTakeover"
  | "scrollBoundary"
  | "dataWindowSlow"
  | "dataWindowStale";

export interface WheelBatch {
  axis: GridPerformanceAxis | null;
  firstInputAt: number | null;
  eventCount: number;
  latestMovedInputAt: number | null;
  requestedHorizontalPixels: number;
  appliedHorizontalPixels: number;
  requestedVerticalPixels: number;
  appliedVerticalRowSteps: number;
  outcomes: Partial<Record<string, number>>;
  triggers: Set<DiagnosticTrigger>;
}

export type RequestLifecycle = Record<
  | "queued"
  | "started"
  | "completed"
  | "failed"
  | "stale"
  | "supersededBeforeStart"
  | "satisfiedByCompletedWindow"
  | "invalidatedBeforeStart",
  number
>;

export interface PhaseDurations {
  count: number;
  maxMs: number;
}

export interface DiagnosticFrame {
  frameId: number;
  relativeMs: number;
  wheelBatch: WheelBatch | null;
  measurementStartedAt: number | null;
  movedInputToMeasurementStartMs: number | null;
  measurementDurationMs: number | null;
  reactCommit: boolean | null;
  inputToReactCommit: PhaseDurations;
  measurementToReactCommit: PhaseDurations;
  commitToNextAnimationFrame: PhaseDurations;
  visibleRowChanged: boolean;
  visibleColumnChanged: boolean;
  mountedRowChanged: boolean;
  mountedColumnChanged: boolean;
  requestLifecycle: RequestLifecycle;
  triggers: Set<DiagnosticTrigger>;
  severity: number;
  settled: boolean;
}

interface DiagnosticEpisode {
  triggers: Set<DiagnosticTrigger>;
  frames: DiagnosticFrame[];
  postContextRemaining: number;
  severity: number;
  triggerFrameId: number;
  triggerRelativeMs: number;
}

export class DiagnosticEpisodeCollector {
  private readonly retained: DiagnosticEpisode[] = [];
  private active: DiagnosticEpisode | null = null;
  private readonly preContext: DiagnosticFrame[] = [];

  collect(frame: DiagnosticFrame) {
    if (this.active !== null && this.active.frames.length >= FRAME_LIMIT) {
      this.finishActive();
    }
    if (frame.triggers.size > 0 && this.active === null) {
      this.active = {
        triggers: new Set(),
        frames: [...this.preContext],
        postContextRemaining: POST_CONTEXT,
        severity: frame.severity,
        triggerFrameId: frame.frameId,
        triggerRelativeMs: frame.relativeMs,
      };
    }
    if (this.active !== null) {
      for (const trigger of frame.triggers) this.active.triggers.add(trigger);
      this.active.severity = Math.max(this.active.severity, frame.severity);
      if (!this.active.frames.some((item) => item.frameId === frame.frameId)) {
        this.active.frames.push(frame);
      }
      if (frame.triggers.size > 0) {
        this.active.postContextRemaining = POST_CONTEXT;
      } else {
        this.active.postContextRemaining -= 1;
        if (this.active.postContextRemaining <= 0) this.finishActive();
      }
    }
    this.preContext.push(frame);
    if (this.preContext.length > PRE_CONTEXT) this.preContext.shift();
  }

  report() {
    this.finishActive();
    return [...this.retained].sort(compareEpisodeChronology).map((episode) => ({
      severity: roundMilliseconds(episode.severity),
      triggers: [...episode.triggers],
      frames: [...episode.frames]
        .sort(compareDiagnosticFrames)
        .map(reportDiagnosticFrame),
    }));
  }

  private finishActive() {
    const episode = this.active;
    if (episode === null) return;
    this.active = null;
    if (this.retained.length < EPISODE_LIMIT) {
      this.retained.push(episode);
      return;
    }
    let weakestIndex = 0;
    for (let index = 1; index < this.retained.length; index += 1) {
      const candidate = this.retained[index];
      const weakest = this.retained[weakestIndex];
      if (
        candidate !== undefined &&
        weakest !== undefined &&
        compareEpisodeRank(candidate, weakest) < 0
      ) {
        weakestIndex = index;
      }
    }
    const weakest = this.retained[weakestIndex];
    if (weakest !== undefined && compareEpisodeRank(episode, weakest) > 0) {
      this.retained[weakestIndex] = episode;
    }
  }
}

export function markDiagnosticTrigger(
  frame: DiagnosticFrame,
  trigger: DiagnosticTrigger,
  normalizedSeverity: number,
) {
  frame.triggers.add(trigger);
  frame.severity = Math.max(frame.severity, normalizedSeverity);
}

export function emptyPhaseDurations(): PhaseDurations {
  return { count: 0, maxMs: 0 };
}

export function addPhaseDuration(phase: PhaseDurations, milliseconds: number) {
  phase.count += 1;
  phase.maxMs = Math.max(phase.maxMs, milliseconds);
}

export function emptyRequestLifecycle(): RequestLifecycle {
  return {
    queued: 0,
    started: 0,
    completed: 0,
    failed: 0,
    stale: 0,
    supersededBeforeStart: 0,
    satisfiedByCompletedWindow: 0,
    invalidatedBeforeStart: 0,
  };
}

export function mergeRequestLifecycle(
  left: RequestLifecycle,
  right: RequestLifecycle,
): RequestLifecycle {
  return {
    queued: left.queued + right.queued,
    started: left.started + right.started,
    completed: left.completed + right.completed,
    failed: left.failed + right.failed,
    stale: left.stale + right.stale,
    supersededBeforeStart:
      left.supersededBeforeStart + right.supersededBeforeStart,
    satisfiedByCompletedWindow:
      left.satisfiedByCompletedWindow + right.satisfiedByCompletedWindow,
    invalidatedBeforeStart:
      left.invalidatedBeforeStart + right.invalidatedBeforeStart,
  };
}

export function hasRequestLifecycle(lifecycle: RequestLifecycle): boolean {
  return Object.values(lifecycle).some((count) => count > 0);
}

function compareEpisodeRank(
  left: DiagnosticEpisode,
  right: DiagnosticEpisode,
): number {
  return (
    left.severity - right.severity ||
    right.triggerRelativeMs - left.triggerRelativeMs ||
    right.triggerFrameId - left.triggerFrameId
  );
}

function compareEpisodeChronology(
  left: DiagnosticEpisode,
  right: DiagnosticEpisode,
): number {
  return (
    left.triggerRelativeMs - right.triggerRelativeMs ||
    left.triggerFrameId - right.triggerFrameId
  );
}

function compareDiagnosticFrames(
  left: DiagnosticFrame,
  right: DiagnosticFrame,
): number {
  return left.relativeMs - right.relativeMs || left.frameId - right.frameId;
}

function reportDiagnosticFrame(frame: DiagnosticFrame) {
  return {
    frameId: frame.frameId,
    relativeMs: roundMilliseconds(frame.relativeMs),
    axis: frame.wheelBatch?.axis ?? null,
    wheelBatch:
      frame.wheelBatch === null
        ? null
        : {
            eventCount: frame.wheelBatch.eventCount,
            requestedHorizontalPixels: roundMilliseconds(
              frame.wheelBatch.requestedHorizontalPixels,
            ),
            appliedHorizontalPixels: roundMilliseconds(
              frame.wheelBatch.appliedHorizontalPixels,
            ),
            requestedVerticalPixels: roundMilliseconds(
              frame.wheelBatch.requestedVerticalPixels,
            ),
            appliedVerticalRowSteps: frame.wheelBatch.appliedVerticalRowSteps,
            outcomes: frame.wheelBatch.outcomes,
          },
    measurementDurationMs:
      frame.measurementDurationMs === null
        ? null
        : roundMilliseconds(frame.measurementDurationMs),
    movedInputToMeasurementStartMs:
      frame.movedInputToMeasurementStartMs === null
        ? null
        : roundMilliseconds(frame.movedInputToMeasurementStartMs),
    reactCommit: frame.reactCommit,
    inputToReactCommit: reportPhaseDurations(frame.inputToReactCommit),
    measurementToReactCommit: reportPhaseDurations(
      frame.measurementToReactCommit,
    ),
    commitToNextAnimationFrame: reportPhaseDurations(
      frame.commitToNextAnimationFrame,
    ),
    visibleRowChanged: frame.visibleRowChanged,
    visibleColumnChanged: frame.visibleColumnChanged,
    mountedRowChanged: frame.mountedRowChanged,
    mountedColumnChanged: frame.mountedColumnChanged,
    requestLifecycle: frame.requestLifecycle,
    triggers: [...frame.triggers],
  };
}

function reportPhaseDurations(phase: PhaseDurations) {
  return { count: phase.count, maxMs: roundMilliseconds(phase.maxMs) };
}
