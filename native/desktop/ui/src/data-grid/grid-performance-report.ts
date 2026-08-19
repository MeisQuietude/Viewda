/**
 * Stable schemaVersion 1 boundary for bounded grid performance diagnostics.
 *
 * Durations and intervals use milliseconds from a monotonic clock. A null value
 * means its required boundary was unavailable. For each distribution, `count`
 * includes every accepted sample, `sampleCount` and percentiles describe the
 * latest 2,048 samples, and `max` spans the recording. Zero count means “not
 * observed”. Lower latency and interval values are better; counts need recording
 * duration and the corresponding input count for interpretation.
 *
 * Envelope
 * - `reportType` identifies this payload as `Viewda grid scroll performance`.
 *   `schemaVersion` is the compatibility boundary for consumers. `recordedAt`
 *   is wall-clock context. `durationMs` is monotonic stop minus start. `runtime`
 *   identifies the app, query engine, webview, platform, and theme. `source` is
 *   null without an open source; otherwise it records only byte size and logical
 *   dimensions, never paths, names, or cell contents.
 *
 * Reference cadence
 * - `referenceAnimationFrameIntervalMs` samples 60 consecutive idle rAF gaps.
 *   Wheel input resets an incomplete series. `observedAnimationFrameHz` is
 *   1,000 / p50, not the display's declared refresh rate.
 *
 * Grid
 * - `configuration` is the latest viewport size in CSS pixels, DPR, vertical
 *   mode, row height, logical dimensions, and pinned-column count.
 * - `configurationChanges`, `visibleViewportChanges`, and
 *   `mountedWindowChanges` count distinct snapshots including the first. Row and
 *   column variants isolate which dimension changed. Visible ranges are on
 *   screen; mounted ranges include overscan.
 * - `maximumRenderedRows`, `maximumRenderedColumns`, and
 *   `maximumRenderedCells` describe the logical mounted body. `maximumDomCells`
 *   is the observed `.viewda-grid-cell` count. These maxima test bounded DOM use.
 *
 * Wheel
 * - Aggregate counts separate input, grid ownership, decided/ambiguous axis,
 *   applied movement, and axis takeover. Axis classification remains the product
 *   boundary; horizontal and vertical reports contain decided events only.
 * - Horizontal requested/applied/clamped values are absolute CSS pixels.
 *   Vertical requested values are normalized CSS pixels and applied values are
 *   logical row steps. `outcomes` explains movement, boundaries, locked-axis
 *   noise, absent extent, and retained sub-row remainder.
 * - Per-axis `movedWheelInputIntervalMs` measures event timestamp gaps between
 *   consecutive `appliedMovement` inputs in the same 250 ms gesture window.
 *   Large values here indicate upstream delivery gaps before Viewda work begins.
 * - Per-axis `wheelHandlerDurationMs` samples every decided event, including
 *   non-moving outcomes. It measures synchronous product work from the handler's
 *   active-recording entry token through completed scroll application. It
 *   excludes diagnostics collection itself. It is not input-to-measurement or
 *   input-to-commit latency.
 * - Per-axis `movedWheelToAnimationFrameMs` measures the latest moved input to
 *   its measurement rAF. `scrollAnimationFrameIntervalMs` measures consecutive
 *   moved-wheel-attributed rAF gaps on that axis within 250 ms.
 *   `longScrollAnimationFrameIntervals` counts those above the reported fixed
 *   50 ms threshold.
 *
 * Timing
 * - Measurement frame counts split callbacks that await a correlated React
 *   commit from callbacks that do not. `measurementCallbackDurationMs` is rAF
 *   timestamp to synchronous callback end.
 * - `measurementToReactCommitMs`, `inputToReactCommitMs`, and
 *   `commitToNextAnimationFrameMs` use their named observed boundaries. They are
 *   not paint duration and must not be added together.
 *
 * Data windows
 * - Queued, started, completed, failed, stale, and pending-at-stop counts expose
 *   request lifecycle. Stale may overlap a terminal outcome. Disposal reasons
 *   explain queued requests intentionally removed before start.
 * - `queueWaitMs` is queue to start. `requestDurationMs` is start to terminal
 *   outcome. A request that never starts has no duration sample. Projection
 *   queue time includes the intentional horizontal idle debounce, so it is not
 *   by itself evidence that the main thread or native engine was blocked.
 * - `recentRequests` keeps the latest 64 terminal requests. `reason` separates
 *   the first base window of a view, row movement, horizontal projection
 *   changes, combined movement, and retries. A projection-only request covers
 *   a small bounded data runway around the mounted DOM rows rather than the
 *   larger base prefetch window. Row offset/count identify that requested
 *   logical slice. Projection count plus the fixed-size key (first/last source
 *   index, contiguous/sparse marker, and stable 32-bit fingerprint) distinguish
 *   projection shapes without recording names, paths, values, or an unbounded
 *   index list. Filter/sort flags show whether a prepared view served the
 *   request. `relativeMs` is the terminal event's offset from recording start.
 *   `outcome` is either the native call result or the reason a queued call was
 *   disposed before it started. `stale` means a completed or failed native call
 *   no longer matched the authoritative viewport at its terminal boundary, so
 *   it intentionally overlaps `completed` or `failed`. Queue and execution
 *   durations distinguish scheduler delay from engine work. This bounded trace
 *   complements aggregate percentiles: it preserves the order and shape needed
 *   to explain a stall.
 *
 * Diagnostic episodes
 * - `frameOverBudgetThresholdMs` is 1.5 × idle rAF p50 after reference sampling,
 *   otherwise 25 ms. The end-to-end threshold is twice that budget. A slow data
 *   window exceeds the reported fixed 50 ms threshold.
 * - Up to 12 episodes retain three preceding frames, the triggered neighborhood,
 *   and two following frames, with at most eight frames per episode. `severity`
 *   is the maximum normalized budget excess in the episode: phase duration /
 *   applicable frame budget, request duration / request budget, or 1 for a
 *   categorical wheel trigger. Stale data uses 2 because it is a discarded
 *   terminal result. The collector keeps the highest severity episodes across
 *   axes and request activity; a worse late episode replaces the weakest retained
 *   episode. Equal severity keeps the earlier episode deterministically. Output
 *   remains chronological.
 * - Episode triggers union frame-over-budget, axis takeover, scroll boundary,
 *   slow data window, and stale data window. Frame fields provide correlation,
 *   relative chronology, wheel batch, measurement/commit phase maxima, viewport
 *   dimension changes, nearby request lifecycle, and the frame's own triggers.
 *   Empty-trigger frames are pre/post context only.
 *
 * Grid components depend only on `GridDiagnosticsSink`; recording ownership,
 * report storage, and debug UI stay outside the grid. Callers use `isEnabled`
 * before constructing snapshots or counting DOM cells, so an inactive session
 * does not pay collection costs merely because the sink remains connected.
 */
export {
  createGridPerformanceController,
  gridDiagnosticsNoopSink,
  type GridDiagnosticsController,
  type GridDiagnosticsSink,
  type GridDataWindowRequest,
  type GridDataWindowRequestReason,
  type GridReactCommitSource,
  type GridWheelOutcome,
} from "./diagnostics/session";
