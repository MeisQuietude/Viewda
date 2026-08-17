import { describe, expect, it } from "vitest";

import {
  createGridPerformanceController,
  createGridPerformanceRecorder,
  gridDiagnosticsNoopSink,
  type GridPerformanceWheel,
  type GridWheelOutcome,
} from "./diagnostics/session";

function recorder() {
  let now = 1_000;
  return {
    recording: createGridPerformanceRecorder({
      now: () => now,
      isoNow: () => "2026-08-13T10:00:00.000Z",
    }),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

const metadata = {
  runtime: {
    appVersion: "0.1.0-alpha.3",
    queryEngineVersion: "v1.5.5",
    userAgent: "WebKit test",
    platform: "Linux x86_64",
    theme: "light" as const,
  },
  source: { sizeBytes: 40_000_000_000, rowCount: 1_000_000, columnCount: 40 },
};

function wheel(
  overrides: Partial<GridPerformanceWheel> = {},
): GridPerformanceWheel {
  return {
    timeStamp: 10,
    handlerDurationMs: 0,
    decision: "horizontal",
    consumed: true,
    takeover: false,
    requestedHorizontalPixels: 40,
    appliedHorizontalPixels: 40,
    requestedVerticalPixels: 0,
    appliedVerticalRowSteps: 0,
    outcome: "appliedMovement",
    ...overrides,
  };
}

const viewport = {
  visibleRowStart: 3,
  visibleRowCount: 25,
  visibleScrollingColumnStart: 4,
  visibleScrollingColumnCount: 10,
  mountedRowStart: 0,
  mountedRowCount: 31,
  mountedScrollingColumnStart: 0,
  mountedScrollingColumnCount: 14,
  renderedColumnCount: 15,
  renderedCellCount: 465,
};

describe("grid performance report", () => {
  it("exposes whether a connected sink is currently collecting", () => {
    const controller = createGridPerformanceController();

    expect(gridDiagnosticsNoopSink.isEnabled()).toBe(false);
    expect(controller.sink.isEnabled()).toBe(false);
    controller.start(metadata);
    expect(controller.sink.isEnabled()).toBe(true);
    controller.stop();
    expect(controller.sink.isEnabled()).toBe(false);

    controller.dispose();
  });

  it("keeps the initial schema contract and summarizes safe metadata", () => {
    const { recording, advance } = recorder();
    recording.start(metadata);
    recording.configure({
      viewportWidth: 1_200,
      viewportHeight: 700,
      devicePixelRatio: 1.5,
      verticalMode: "compressed",
      rowHeight: 28,
      rowCount: 1_000_000,
      columnCount: 40,
      pinnedColumnCount: 1,
    });
    recording.wheel(wheel());
    const frame = recording.measurementStart(18);
    recording.viewport(frame, viewport);
    recording.measurementEnd(frame, 21, false);
    const request = recording.queueRequest();
    advance(5);
    recording.startRequest(request);
    advance(25);
    recording.finishRequest(request, "completed", false);
    advance(70);

    const report = JSON.parse(recording.stop() ?? "null");

    expect(report).toMatchObject({
      schemaVersion: 1,
      reportType: "Viewda grid scroll performance",
      recordedAt: "2026-08-13T10:00:00.000Z",
      durationMs: 100,
      runtime: metadata.runtime,
      source: metadata.source,
      referenceCadence: {
        observedAnimationFrameHz: null,
        referenceAnimationFrameIntervalMs: { count: 0 },
      },
      grid: {
        configuration: { verticalMode: "compressed", viewportWidth: 1_200 },
        visibleViewportChanges: 1,
        mountedWindowChanges: 1,
        maximumRenderedRows: 31,
        maximumRenderedColumns: 15,
        maximumRenderedCells: 465,
        maximumDomCells: 465,
      },
      wheel: {
        inputEvents: 1,
        movedEvents: 1,
        horizontal: {
          requestedPixels: 40,
          appliedPixels: 40,
          clampedPixels: 0,
        },
      },
      timing: {
        measurementFrames: 1,
        measurementFramesAwaitingReactCommit: 0,
        measurementFramesNotAwaitingReactCommit: 1,
      },
      dataWindows: {
        queued: 1,
        started: 1,
        completed: 1,
        failed: 0,
        stale: 0,
        pendingAtStop: 0,
        queueWaitMs: { count: 1, p50: 5 },
        requestDurationMs: { count: 1, p50: 25 },
      },
    });
  });

  it("keeps mounted-window changes as context without opening an episode", () => {
    const { recording } = recorder();
    recording.start(metadata);
    const frame = recording.measurementStart(10);
    recording.viewport(frame, viewport);
    recording.measurementEnd(frame, 12, false);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.diagnostics.diagnosticEpisodes).toEqual([]);
    expect(report.grid).toMatchObject({
      mountedRowChanges: 1,
      mountedColumnChanges: 1,
    });
  });

  it("does not let mounted-window context extend an active episode", () => {
    const { recording } = recorder();
    recording.start(metadata);
    const boundary = (timeStamp: number) => {
      recording.wheel(
        wheel({
          timeStamp,
          requestedHorizontalPixels: 10,
          appliedHorizontalPixels: 0,
          outcome: "atEndBoundary",
        }),
      );
      const frame = recording.measurementStart(timeStamp + 1);
      recording.measurementEnd(frame, timeStamp + 2, false);
    };
    boundary(100);
    for (let index = 0; index < 2; index += 1) {
      const frame = recording.measurementStart(110 + index * 10);
      recording.viewport(frame, {
        ...viewport,
        mountedRowStart: index + 1,
      });
      recording.measurementEnd(frame, 111 + index * 10, false);
    }
    boundary(500);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.diagnostics.diagnosticEpisodes).toHaveLength(2);
    for (const episode of report.diagnostics.diagnosticEpisodes) {
      expect(episode.triggers).toEqual(["scrollBoundary"]);
    }
  });

  it.each([
    [16.667, 60],
    [8.333, 120],
  ])("measures a %sms reference stream as about %sHz", (interval, hertz) => {
    const { recording } = recorder();
    recording.start(metadata);
    let complete = false;
    for (let index = 0; index <= 60; index += 1) {
      complete = recording.referenceFrame(index * interval);
    }

    const report = JSON.parse(recording.stop() ?? "null");
    expect(complete).toBe(true);
    expect(
      report.referenceCadence.referenceAnimationFrameIntervalMs,
    ).toMatchObject({ count: 60, sampleCount: 60, p50: interval });
    expect(report.referenceCadence.observedAnimationFrameHz).toBeCloseTo(
      hertz,
      0,
    );
    expect(report.diagnostics.frameOverBudgetThresholdMs).toBeCloseTo(
      interval * 1.5,
      2,
    );
  });

  it("pauses reference cadence until wheel input has been idle", () => {
    const { recording } = recorder();
    recording.start(metadata);
    recording.referenceFrame(0);
    recording.referenceFrame(16);
    recording.wheel(wheel({ timeStamp: 20 }));
    expect(recording.referenceFrame(200)).toBe(false);
    recording.referenceFrame(270);
    recording.referenceFrame(286);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(
      report.referenceCadence.referenceAnimationFrameIntervalMs,
    ).toMatchObject({ count: 1, p50: 16 });
  });

  it("keeps one consecutive reference series and freezes it at 60 intervals", () => {
    const { recording } = recorder();
    recording.start(metadata);
    for (let index = 0; index <= 10; index += 1) {
      recording.referenceFrame(index * 16);
    }
    recording.pauseReferenceCadence();
    for (let index = 0; index <= 60; index += 1) {
      recording.referenceFrame(1_000 + index * 16);
    }
    recording.pauseReferenceCadence();
    recording.referenceFrame(3_000);
    recording.referenceFrame(3_016);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(
      report.referenceCadence.referenceAnimationFrameIntervalMs,
    ).toMatchObject({ count: 60, sampleCount: 60, p50: 16 });
  });

  it("correlates measurement frames with and without a React commit", () => {
    const { recording } = recorder();
    recording.start(metadata);
    recording.wheel(wheel({ timeStamp: 10 }));
    const withoutCommit = recording.measurementStart(18);
    recording.measurementEnd(withoutCommit, 20, false);

    recording.wheel(wheel({ timeStamp: 30 }));
    const withCommit = recording.measurementStart(35);
    recording.measurementEnd(withCommit, 38, true);
    const commit = recording.reactCommit(withCommit, 42, "measurement");
    recording.nextAnimationFrame(commit, 50);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.timing).toMatchObject({
      measurementFrames: 2,
      measurementFramesAwaitingReactCommit: 1,
      measurementFramesNotAwaitingReactCommit: 1,
      measurementCallbackDurationMs: { count: 2, p50: 2, p95: 3 },
      measurementToReactCommitMs: { count: 1, p50: 7 },
      inputToReactCommitMs: { count: 1, p50: 12 },
      commitToNextAnimationFrameMs: { count: 1, p50: 8 },
    });
    expect(report.diagnostics).not.toHaveProperty("healthyComparisonFrames");
  });

  it("does not apply a single-frame budget to a normal end-to-end span", () => {
    const { recording } = recorder();
    recording.start(metadata);
    for (let index = 0; index <= 60; index += 1) {
      recording.referenceFrame(index * 17);
    }
    recording.wheel(wheel({ timeStamp: 2_000 }));
    const frame = recording.measurementStart(2_005);
    recording.measurementEnd(frame, 2_006, true);
    const commit = recording.reactCommit(frame, 2_010, "measurement");
    recording.nextAnimationFrame(commit, 2_026);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.timing).toMatchObject({
      inputToReactCommitMs: { p50: 10 },
      commitToNextAnimationFrameMs: { p50: 16 },
    });
    expect(report.diagnostics).toMatchObject({
      frameOverBudgetThresholdMs: 25.5,
      endToEndFrameOverBudgetThresholdMs: 51,
      diagnosticEpisodes: [],
    });
  });

  it("applies the single-frame budget to commit-to-next-rAF", () => {
    const { recording } = recorder();
    recording.start(metadata);
    const frame = recording.measurementStart(10);
    recording.measurementEnd(frame, 11, true);
    const commit = recording.reactCommit(frame, 12, "measurement");
    recording.nextAnimationFrame(commit, 40);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.timing.commitToNextAnimationFrameMs.p50).toBe(28);
    expect(report.diagnostics.diagnosticEpisodes[0].triggers).toContain(
      "frameOverBudget",
    );
  });

  it("correlates an input-owned commit without assigning it to measurement", () => {
    const { recording } = recorder();
    recording.start(metadata);
    const frame = recording.wheel(
      wheel({
        decision: "vertical",
        requestedHorizontalPixels: 0,
        appliedHorizontalPixels: 0,
        requestedVerticalPixels: 28,
        appliedVerticalRowSteps: 1,
      }),
    );
    const commit = recording.reactCommit(frame, 14, "input");
    recording.nextAnimationFrame(commit, 18);
    const measurement = recording.measurementStart(20);
    recording.measurementEnd(measurement, 21, false);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.timing).toMatchObject({
      measurementFramesAwaitingReactCommit: 0,
      measurementFramesNotAwaitingReactCommit: 1,
      measurementToReactCommitMs: { count: 0 },
      inputToReactCommitMs: { count: 1, p50: 4 },
      commitToNextAnimationFrameMs: { count: 1, p50: 4 },
    });
  });

  it("keeps a pending input commit distinct from an intervening measurement", () => {
    const { recording } = recorder();
    recording.start(metadata);
    const frame = recording.wheel(
      wheel({
        timeStamp: 10,
        decision: "vertical",
        requestedHorizontalPixels: 0,
        appliedHorizontalPixels: 0,
        requestedVerticalPixels: 28,
        appliedVerticalRowSteps: 1,
      }),
    );
    recording.measurementStart(12);
    recording.measurementEnd(frame, 13, true);
    recording.reactCommit(frame, 50, "input", false);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.timing).toMatchObject({
      measurementFramesAwaitingReactCommit: 1,
      inputToReactCommitMs: { count: 1, p50: 40 },
      measurementToReactCommitMs: { count: 0 },
      commitToNextAnimationFrameMs: { count: 0 },
    });
    expect(report.diagnostics.diagnosticEpisodes[0]).toMatchObject({
      triggers: ["frameOverBudget"],
      frames: [expect.objectContaining({ frameId: frame })],
    });
  });

  it("does not let an old session consume a new commit token", () => {
    const { recording } = recorder();
    recording.start(metadata);
    const oldFrame = recording.measurementStart(10);
    recording.measurementEnd(oldFrame, 11, true);
    const oldCommit = recording.reactCommit(oldFrame, 12, "measurement");
    recording.stop();

    recording.start(metadata);
    const newFrame = recording.measurementStart(20);
    recording.measurementEnd(newFrame, 21, true);
    const newCommit = recording.reactCommit(newFrame, 22, "measurement");
    recording.nextAnimationFrame(oldCommit, 24);
    recording.nextAnimationFrame(newCommit, 26);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(newCommit).not.toBe(oldCommit);
    expect(report.timing.commitToNextAnimationFrameMs).toMatchObject({
      count: 1,
      p50: 4,
    });
  });

  it("keeps two commits for one frame correlated to their own next animation frames", () => {
    const { recording } = recorder();
    recording.start(metadata);
    const frame = recording.wheel(
      wheel({
        decision: "vertical",
        requestedHorizontalPixels: 0,
        appliedHorizontalPixels: 0,
        requestedVerticalPixels: 28,
        appliedVerticalRowSteps: 1,
      }),
    );
    const inputCommit = recording.reactCommit(frame, 14, "input");
    const measurement = recording.measurementStart(15);
    recording.measurementEnd(measurement, 17, true);
    const measurementCommit = recording.reactCommit(
      measurement,
      18,
      "measurement",
    );
    recording.nextAnimationFrame(inputCommit, 20);
    recording.nextAnimationFrame(measurementCommit, 22);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.timing).toMatchObject({
      inputToReactCommitMs: { count: 2, p50: 4, p95: 8 },
      measurementToReactCommitMs: { count: 1, p50: 3 },
      commitToNextAnimationFrameMs: { count: 2, p50: 4, max: 6 },
    });
  });

  it("serializes diagnostic frames in chronological order", () => {
    const { recording } = recorder();
    recording.start(metadata);
    const earlier = recording.measurementStart(10);
    recording.measurementEnd(earlier, 11, true);
    const later = recording.measurementStart(20);
    recording.measurementEnd(later, 21, true);
    recording.reactCommit(later, 60, "measurement", false);
    const earlierCommit = recording.reactCommit(earlier, 70, "measurement");
    recording.nextAnimationFrame(earlierCommit, 80);

    const report = JSON.parse(recording.stop() ?? "null");
    const frames = report.diagnostics.diagnosticEpisodes[0].frames;
    expect(frames.map((frame: { frameId: number }) => frame.frameId)).toEqual([
      earlier,
      later,
    ]);
  });

  it("records one next-frame sample when one commit satisfies two frame ids", () => {
    const { recording } = recorder();
    recording.start(metadata);
    const first = recording.measurementStart(10);
    recording.measurementEnd(first, 11, true);
    const second = recording.measurementStart(12);
    recording.measurementEnd(second, 13, true);

    const primary = recording.reactCommit(first, 15, "measurement", true);
    expect(recording.reactCommit(second, 15, "measurement", false)).toBeNull();
    recording.nextAnimationFrame(primary, 20);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.timing).toMatchObject({
      measurementToReactCommitMs: { count: 2, p50: 3, max: 5 },
      commitToNextAnimationFrameMs: { count: 1, p50: 5 },
    });
  });

  it("accounts for every decided wheel event with axis-specific outcomes", () => {
    const { recording } = recorder();
    recording.start(metadata);
    const horizontalOutcomes: GridWheelOutcome[] = [
      "appliedMovement",
      "atStartBoundary",
      "atEndBoundary",
      "noScrollableExtent",
      "axisLockedNoise",
    ];
    horizontalOutcomes.forEach((outcome, index) =>
      recording.wheel(
        wheel({
          timeStamp: index,
          requestedHorizontalPixels: index === 0 ? -10 : 0,
          appliedHorizontalPixels: index === 0 ? -4 : 0,
          outcome,
        }),
      ),
    );
    const verticalOutcomes: GridWheelOutcome[] = [
      ...horizontalOutcomes,
      "accumulatingWholeRow",
    ];
    verticalOutcomes.forEach((outcome, index) =>
      recording.wheel(
        wheel({
          timeStamp: 10 + index,
          decision: "vertical",
          requestedHorizontalPixels: 0,
          appliedHorizontalPixels: 0,
          requestedVerticalPixels: 7,
          appliedVerticalRowSteps: outcome === "appliedMovement" ? 1 : 0,
          outcome,
        }),
      ),
    );
    recording.wheel(
      wheel({
        decision: "ambiguous",
        requestedHorizontalPixels: 0,
        appliedHorizontalPixels: 0,
        outcome: null,
      }),
    );

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.wheel).toMatchObject({
      inputEvents: 12,
      decidedEvents: 11,
      ambiguousEvents: 1,
      movedEvents: 2,
      horizontal: {
        requestedPixels: 10,
        appliedPixels: 4,
        clampedPixels: 6,
      },
      vertical: { requestedPixels: 42, appliedRowSteps: 1 },
    });
    expect(sumValues(report.wheel.horizontal.outcomes)).toBe(
      report.wheel.horizontal.inputEvents,
    );
    expect(sumValues(report.wheel.vertical.outcomes)).toBe(
      report.wheel.vertical.inputEvents,
    );
    expect(report.wheel.movedEvents).toBe(
      report.wheel.horizontal.movedEvents + report.wheel.vertical.movedEvents,
    );
    expect(report.wheel.horizontal.outcomes).not.toHaveProperty(
      "accumulatingWholeRow",
    );
  });

  it("finalizes an idle boundary batch without attributing movement latency", () => {
    const { recording } = recorder();
    recording.start(metadata);
    for (let index = 0; index < 20; index += 1) {
      expect(
        recording.wheel(
          wheel({
            timeStamp: 1_100 + index,
            requestedHorizontalPixels: 10,
            appliedHorizontalPixels: 0,
            outcome: "atEndBoundary",
          }),
        ),
      ).toBeNull();
    }
    recording.wheelIdle(1_400);
    const frame = recording.measurementStart(1_500);
    recording.measurementEnd(frame, 1_501, false);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.wheel).not.toHaveProperty("wheelToAnimationFrameMs");
    const episodes = report.diagnostics.diagnosticEpisodes;
    expect(episodes[0].frames).toHaveLength(2);
    expect(episodes[0].frames[0]).toMatchObject({
      axis: "horizontal",
      relativeMs: 100,
      wheelBatch: { eventCount: 20 },
      triggers: ["scrollBoundary"],
    });
    expect(episodes[0].frames[1]).toMatchObject({
      wheelBatch: null,
      measurementDurationMs: 1,
    });
  });

  it("keeps a boundary batch at its input time when recording stops", () => {
    const { recording, advance } = recorder();
    recording.start(metadata);
    recording.wheel(
      wheel({
        timeStamp: 1_100,
        requestedHorizontalPixels: 10,
        appliedHorizontalPixels: 0,
        outcome: "atEndBoundary",
      }),
    );
    advance(200);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.diagnostics.diagnosticEpisodes[0].frames[0]).toMatchObject({
      relativeMs: 100,
      wheelBatch: { eventCount: 1 },
    });
  });

  it("records every pending-request disposal reason", () => {
    const { recording } = recorder();
    recording.start(metadata);
    for (const reason of [
      "supersededBeforeStart",
      "satisfiedByCompletedWindow",
      "invalidatedBeforeStart",
    ] as const) {
      recording.disposeRequest(recording.queueRequest(), reason);
    }

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.dataWindows).toMatchObject({
      queued: 3,
      started: 0,
      pendingAtStop: 0,
      pendingRequestDisposals: {
        supersededBeforeStart: 1,
        satisfiedByCompletedWindow: 1,
        invalidatedBeforeStart: 1,
      },
    });
  });

  it("keeps diagnostic episodes bounded and free of unknown payloads", () => {
    const { recording } = recorder();
    const sentinel = "/private/SECRET_COLUMN_VALUE.parquet";
    recording.start({
      ...metadata,
      runtime: { ...metadata.runtime, sourcePath: sentinel },
      source: { ...metadata.source, displayName: sentinel },
    } as typeof metadata);
    recording.configure({
      viewportWidth: 1,
      viewportHeight: 1,
      devicePixelRatio: 1,
      verticalMode: "native",
      rowHeight: 28,
      rowCount: 1,
      columnCount: 1,
      pinnedColumnCount: 0,
      columnName: sentinel,
    } as never);
    for (let index = 0; index < 509; index += 1) {
      recording.wheel(
        wheel({
          timeStamp: index * 100,
          requestedHorizontalPixels: 10,
          appliedHorizontalPixels: index === 0 ? 0 : 10,
          outcome: index === 0 ? "atEndBoundary" : "appliedMovement",
        }),
      );
      const frame = recording.measurementStart(index * 100 + 1);
      recording.measurementEnd(
        frame,
        index * 100 + (index === 0 ? 30 : 2),
        false,
      );
    }

    const serialized = recording.stop() ?? "";
    const report = JSON.parse(serialized);
    expect(serialized).not.toContain(sentinel);
    expect(report.diagnostics.diagnosticEpisodes.length).toBeLessThanOrEqual(
      12,
    );
    for (const episode of report.diagnostics.diagnosticEpisodes) {
      expect(episode.frames.length).toBeLessThanOrEqual(8);
    }
    expect(report.diagnostics.diagnosticEpisodes[0].triggers).toEqual(
      expect.arrayContaining(["scrollBoundary", "frameOverBudget"]),
    );
    expect(report.diagnostics).not.toHaveProperty("healthyComparisonFrames");
  });

  it("retains the worst episodes regardless of axis or arrival order", () => {
    const { recording, advance } = recorder();
    recording.start(metadata);
    const healthyContext = (timeStamp: number) => {
      for (let index = 0; index < 2; index += 1) {
        const frame = recording.measurementStart(timeStamp + index * 2);
        recording.measurementEnd(frame, timeStamp + index * 2 + 1, false);
      }
    };
    const wheelAnomaly = (
      decision: "horizontal" | "vertical",
      timeStamp: number,
    ) => {
      recording.wheel(
        wheel({
          timeStamp,
          decision,
          requestedHorizontalPixels: decision === "horizontal" ? 10 : 0,
          appliedHorizontalPixels: decision === "horizontal" ? 10 : 0,
          requestedVerticalPixels: decision === "vertical" ? 28 : 0,
          appliedVerticalRowSteps: decision === "vertical" ? 1 : 0,
        }),
      );
      const frame = recording.measurementStart(timeStamp + 1);
      recording.measurementEnd(frame, timeStamp + 31, false);
      healthyContext(timeStamp + 40);
    };

    for (let index = 0; index < 8; index += 1) {
      wheelAnomaly("horizontal", 1_100 + index * 100);
    }
    wheelAnomaly("vertical", 2_200);

    const slow = recording.queueRequest();
    recording.startRequest(slow);
    advance(51);
    recording.finishRequest(slow, "completed", false);
    healthyContext(2_500);

    const stale = recording.queueRequest();
    recording.startRequest(stale);
    advance(1);
    recording.finishRequest(stale, "completed", true);

    const report = JSON.parse(recording.stop() ?? "null");
    const episodes = report.diagnostics.diagnosticEpisodes as Array<{
      triggers: string[];
      frames: Array<{ axis: string | null; triggers: string[] }>;
    }>;
    expect(episodes.length).toBeLessThanOrEqual(12);
    expect(
      episodes.some(
        (episode) =>
          episode.triggers.includes("frameOverBudget") &&
          episode.frames.some(
            (frame) =>
              frame.axis === "vertical" &&
              frame.triggers.includes("frameOverBudget"),
          ),
      ),
    ).toBe(true);
    expect(
      episodes.filter((episode) => episode.triggers.includes("dataWindowSlow")),
    ).toHaveLength(1);
    expect(
      episodes.filter((episode) =>
        episode.triggers.includes("dataWindowStale"),
      ),
    ).toHaveLength(1);
  });

  it("triggers episodes for slow and stale data-window completions", () => {
    const { recording, advance } = recorder();
    recording.start(metadata);
    const slow = recording.queueRequest();
    recording.startRequest(slow);
    advance(51);
    recording.finishRequest(slow, "completed", false);
    const stale = recording.queueRequest();
    recording.startRequest(stale);
    advance(1);
    recording.finishRequest(stale, "completed", true);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.diagnostics.dataWindowSlowThresholdMs).toBe(50);
    expect(
      report.diagnostics.diagnosticEpisodes.flatMap(
        (episode: { triggers: string[] }) => episode.triggers,
      ),
    ).toEqual(expect.arrayContaining(["dataWindowSlow", "dataWindowStale"]));
  });

  it("replaces an early mild episode with a worse late episode", () => {
    const { recording } = recorder();
    recording.start(metadata);
    for (let index = 0; index < 12; index += 1) {
      const frame = recording.measurementStart(index * 100);
      recording.measurementEnd(frame, index * 100 + 30, false);
      for (let context = 1; context <= 2; context += 1) {
        const healthy = recording.measurementStart(index * 100 + 30 + context);
        recording.measurementEnd(healthy, index * 100 + 31 + context, false);
      }
    }
    const worst = recording.measurementStart(2_000);
    recording.measurementEnd(worst, 2_100, false);

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.diagnostics.diagnosticEpisodes).toHaveLength(12);
    expect(
      report.diagnostics.diagnosticEpisodes.some(
        (episode: { severity: number; frames: Array<{ frameId: number }> }) =>
          episode.severity === 4 &&
          episode.frames.some((frame) => frame.frameId === worst),
      ),
    ).toBe(true);
  });

  it("reports per-axis input delivery and synchronous handler work", () => {
    const { recording } = recorder();
    recording.start(metadata);
    recording.wheel(wheel({ timeStamp: 10, handlerDurationMs: 0.5 }));
    recording.wheel(wheel({ timeStamp: 26, handlerDurationMs: 0.75 }));

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.wheel.horizontal).toMatchObject({
      movedWheelInputIntervalMs: { count: 1, p50: 16 },
      wheelHandlerDurationMs: { count: 2, p50: 0.5, p95: 0.75 },
    });
    expect(report.wheel).not.toHaveProperty("wheelToAnimationFrameMs");
    expect(report.wheel).not.toHaveProperty("scrollAnimationFrameIntervalMs");
  });

  it("does not treat pauses between wheel gestures as input delivery gaps", () => {
    const { recording } = recorder();
    recording.start(metadata);
    recording.wheel(wheel({ timeStamp: 10 }));
    recording.wheel(wheel({ timeStamp: 300 }));
    recording.wheel(wheel({ timeStamp: 316 }));

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.wheel.horizontal.movedWheelInputIntervalMs).toMatchObject({
      count: 1,
      p50: 16,
      max: 16,
    });
  });

  it("caps numeric samples and rounds timing values", () => {
    const { recording } = recorder();
    recording.start(metadata);
    for (let index = 0; index < 3_000; index += 1) {
      recording.wheel(wheel({ timeStamp: index * 2 }));
      const frame = recording.measurementStart(index * 2 + 1);
      recording.measurementEnd(frame, index * 2 + 1.999_999_999_9, false);
    }

    const report = JSON.parse(recording.stop() ?? "null");
    expect(report.wheel.horizontal.movedWheelToAnimationFrameMs).toMatchObject({
      count: 3_000,
      sampleCount: 2_048,
      p50: 1,
      max: 1,
    });
    expect(report.timing).not.toHaveProperty("movedWheelToMeasurementStartMs");
    expect(report.timing.measurementCallbackDurationMs.p50).toBe(1);
  });

  it("resets a previous recording and ignores its request tokens", () => {
    const { recording } = recorder();
    recording.start(metadata);
    const oldRequest = recording.queueRequest();
    recording.start(metadata);
    recording.startRequest(oldRequest);
    recording.finishRequest(oldRequest, "completed", false);

    expect(JSON.parse(recording.stop() ?? "null").dataWindows).toMatchObject({
      queued: 0,
      started: 0,
      completed: 0,
      pendingAtStop: 0,
    });
    expect(recording.stop()).toBeNull();
  });
});

function sumValues(values: Record<string, number>): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}
