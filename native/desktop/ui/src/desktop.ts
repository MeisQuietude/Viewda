// The only module allowed to import Tauri APIs (an ESLint rule enforces
// this). Keeping the shell behind one seam is what lets a different shell —
// or a future web build — replace it without touching the rest of the UI.
// Note what is absent: no dialog API and no paths. File selection lives
// entirely in Rust, and the UI only ever receives a path-free summary.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { EffectiveTheme, ThemePreference } from "./theme";

export interface EngineStatus {
  name: string;
  version: string;
  queryEngineVersion: string;
}

export interface SourceSummary {
  generation: number;
  displayName: string;
  sizeBytes: number;
  rowCount: number;
  rowGroupCount: number;
  schema: SchemaField[];
}

export interface RecentSource {
  id: string;
  name: string;
  directory: string;
}

export interface SchemaField {
  name: string;
  physicalType: string;
  logicalType: string | null;
  children: SchemaField[];
}

export type DataFilterOperator =
  | "equals"
  | "notEquals"
  | "greaterThan"
  | "greaterThanOrEqual"
  | "lessThan"
  | "lessThanOrEqual"
  | "oneOf"
  | "range"
  | "textContains"
  | "isNull"
  | "isNotNull";

export interface DataFilter {
  columnIndex: number;
  operator: DataFilterOperator;
  values: string[];
}

export type SortDirection = "ascending" | "descending";

export interface SortColumn {
  sourceIndex: number;
  direction: SortDirection;
}

export interface DataViewStatus {
  revision: number;
  rowCount: number;
}

export interface DataViewSortDiagnostic {
  physicalType: string;
  logicalType: string | null;
  direction: SortDirection;
}

export interface DataViewResourceDiagnostics {
  operation: "preparation" | "window";
  applicationVersion: string;
  operatingSystem: string;
  architecture: string;
  queryEngineVersion: string;
  message: string;
  memoryLimit: string;
  maxTemporaryDirectorySize: string;
  threads: number;
  rowCount: number;
  sourceSizeBytes: number;
  rowGroupCount: number;
  columnCount: number;
  filterCount: number;
  sortColumns: DataViewSortDiagnostic[];
}

export interface ColumnStatistics {
  minimum: string | null;
  maximum: string | null;
  minMaxComputed: boolean;
  nullShare: number;
  approximateDistinctCount: number;
}

export type UpdateChannel = "stable" | "latest";

export interface UpdateSettings {
  channel: UpdateChannel;
  automaticChecks: boolean;
}

export type DataViewMemoryLimit = "mb384" | "mb768" | "mb1536" | "mb3072";

export interface DataViewSettings {
  memoryLimit: DataViewMemoryLimit;
}

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  isDowngrade: boolean;
}

export interface UpdateCheckOptions {
  allowDowngrade?: boolean;
  automaticCheck?: boolean;
}

export interface PostUpdateState {
  version: string;
  source: SourceSummary | null;
  sourceError: SourceErrorCode | null;
}

export type DefaultApplicationStatus =
  | { kind: "default" }
  | { kind: "canSet" }
  | { kind: "unavailable" }
  | { kind: "unintegratedAppImage" }
  | { kind: "systemSettings" };

export interface OpenedSourceActivation {
  source: SourceSummary | null;
  sourceError: SourceErrorCode | null;
}

interface NativeSourceError {
  code: SourceErrorCode;
}

interface NativePostUpdateState {
  version: string;
  source: SourceSummary | null;
  sourceError: NativeSourceError | null;
}

interface NativeOpenedSourceActivation {
  source: SourceSummary | null;
  sourceError: NativeSourceError | null;
}

export function shortcutModifierFor(platform: string): string {
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "⌘" : "Ctrl+";
}

export const shortcutModifier = shortcutModifierFor(navigator.platform);

export type SourceErrorCode =
  | "notFound"
  | "permissionDenied"
  | "notParquet"
  | "corruptFooter"
  | "unsupported";

export type DataWindowErrorCode =
  | "noSourceOpen"
  | "sourceChanged"
  | "viewChanged"
  | "cancelled"
  | "notFound"
  | "permissionDenied"
  | "notParquet"
  | "corruptSource"
  | "unsupported"
  | "windowTooLarge"
  | "invalidFilter"
  | "invalidSort"
  | "resourceExhausted"
  | "memoryExhausted"
  | "temporaryStorageExhausted"
  | "queryFailed"
  | "queryEngineUnavailable"
  | "encodingFailed";

export type ColumnStatisticsErrorCode =
  | "noSourceOpen"
  | "sourceChanged"
  | "unsupportedColumn"
  | "cancelled"
  | "notFound"
  | "permissionDenied"
  | "notParquet"
  | "corruptSource"
  | "unsupported"
  | "resourceExhausted"
  | "queryFailed"
  | "queryEngineUnavailable";

export type UpdateErrorCode =
  "unavailable" | "storage" | "noPendingUpdate" | "manualInstall";

export class OpenSourceError extends Error {
  constructor(readonly code: SourceErrorCode) {
    super(code);
    this.name = "OpenSourceError";
  }
}

export class DataWindowCommandError extends Error {
  constructor(
    readonly code: DataWindowErrorCode,
    readonly diagnostics?: DataViewResourceDiagnostics,
  ) {
    super(code);
    this.name = "DataWindowCommandError";
  }
}

export class ColumnStatisticsCommandError extends Error {
  constructor(readonly code: ColumnStatisticsErrorCode) {
    super(code);
    this.name = "ColumnStatisticsCommandError";
  }
}

export class UpdateCommandError extends Error {
  constructor(readonly code: UpdateErrorCode) {
    super(code);
    this.name = "UpdateCommandError";
  }
}

export function getEngineStatus(): Promise<EngineStatus> {
  return invoke<EngineStatus>("get_engine_status");
}

export function getUpdateSettings(): Promise<UpdateSettings> {
  return invoke<UpdateSettings>("get_update_settings");
}

export function setUpdateSettings(settings: UpdateSettings): Promise<void> {
  return invoke("set_update_settings", { settings });
}

export function getDataViewSettings(): Promise<DataViewSettings> {
  return invoke<DataViewSettings>("get_data_view_settings");
}

export function setDataViewSettings(settings: DataViewSettings): Promise<void> {
  return invoke("set_data_view_settings", { settings });
}

export function getThemePreference(): Promise<ThemePreference> {
  return invoke<ThemePreference>("get_theme_preference");
}

export function setThemePreference(preference: ThemePreference): Promise<void> {
  return invoke("set_theme_preference", { preference });
}

export function syncSystemTheme(effectiveTheme: EffectiveTheme): Promise<void> {
  return invoke("sync_system_theme", { effectiveTheme });
}

export function checkForUpdate({
  allowDowngrade = false,
  automaticCheck = false,
}: UpdateCheckOptions = {}): Promise<UpdateInfo | null> {
  return invokeUpdate<UpdateInfo | null>("check_for_update", {
    allowDowngrade,
    automaticCheck,
  });
}

export function discardPendingUpdate(): Promise<void> {
  return invokeUpdate("discard_pending_update");
}

export function installPendingUpdate(): Promise<void> {
  return invokeUpdate("install_pending_update");
}

export function takePostUpdateState(): Promise<PostUpdateState | null> {
  return invoke<NativePostUpdateState | null>("take_post_update_state").then(
    (state) =>
      state === null
        ? null
        : {
            ...state,
            sourceError: state.sourceError?.code ?? null,
          },
  );
}

export function takeOpenedSource(): Promise<OpenedSourceActivation | null> {
  return invoke<NativeOpenedSourceActivation | null>("take_opened_source").then(
    (activation) =>
      activation === null
        ? null
        : {
            source: activation.source,
            sourceError: activation.sourceError?.code ?? null,
          },
  );
}

export function getDefaultApplicationStatus(): Promise<DefaultApplicationStatus> {
  return invoke<DefaultApplicationStatus>("get_default_application_status");
}

export function setDefaultApplication(): Promise<DefaultApplicationStatus> {
  return invoke<DefaultApplicationStatus>("set_default_application");
}

export function openReleasesPage(): Promise<void> {
  return invokeUpdate("open_releases_page");
}

export function showMainWindow(): Promise<void> {
  return getCurrentWindow().show();
}

export async function openLocalSource(): Promise<SourceSummary | null> {
  return invokeSource<SourceSummary | null>("open_local_source");
}

export function getRecentSources(): Promise<RecentSource[]> {
  return invoke<RecentSource[]>("get_recent_sources");
}

export function openRecentSource(id: string): Promise<SourceSummary> {
  return invokeSource<SourceSummary>("open_recent_source", { id });
}

async function invokeSource<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new OpenSourceError(readSourceErrorCode(error));
  }
}

export async function getDataWindow(
  generation: number,
  viewRevision: number,
  rowOffset: number,
  rowCount: number,
  sourceIndices: readonly number[],
): Promise<ArrayBuffer> {
  try {
    return await invoke<ArrayBuffer>("get_data_window", {
      generation,
      viewRevision,
      rowOffset,
      rowCount,
      sourceIndices,
    });
  } catch (error) {
    throw readDataWindowCommandError(error);
  }
}

export async function prepareDataView(
  generation: number,
  viewRevision: number,
  filters: DataFilter[],
  sort: SortColumn[],
  settings: DataViewSettings,
): Promise<DataViewStatus> {
  try {
    return await invoke<DataViewStatus>("prepare_data_view", {
      generation,
      viewRevision,
      filters,
      sort,
      settings,
    });
  } catch (error) {
    throw readDataWindowCommandError(error);
  }
}

export async function getDataViewStatus(
  generation: number,
): Promise<DataViewStatus> {
  try {
    return await invoke<DataViewStatus>("get_data_view_status", { generation });
  } catch (error) {
    throw readDataWindowCommandError(error);
  }
}

export async function cancelDataView(
  generation: number,
  viewRevision: number,
): Promise<void> {
  try {
    await invoke("cancel_data_view", { generation, viewRevision });
  } catch (error) {
    throw readDataWindowCommandError(error);
  }
}

export async function getColumnStatistics(
  generation: number,
  columnIndex: number,
  includeMinMax: boolean,
): Promise<ColumnStatistics> {
  try {
    return await invoke<ColumnStatistics>("get_column_statistics", {
      generation,
      columnIndex,
      includeMinMax,
    });
  } catch (error) {
    throw new ColumnStatisticsCommandError(
      readColumnStatisticsErrorCode(error),
    );
  }
}

export function cancelColumnStatistics(generation: number): Promise<void> {
  return invoke("cancel_column_statistics", { generation });
}

export function onOpenSourceRequested(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen("open-source-requested", handler);
}

export function onSettingsRequested(handler: () => void): Promise<UnlistenFn> {
  return listen("settings-requested", handler);
}

export function onUpdateAvailable(
  handler: (update: UpdateInfo) => void,
): Promise<UnlistenFn> {
  return listen<UpdateInfo>("update-available", ({ payload }) =>
    handler(payload),
  );
}

export function onOpenedSourceAvailable(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen("opened-source-available", handler);
}

function readSourceErrorCode(error: unknown): SourceErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (
      code === "notFound" ||
      code === "permissionDenied" ||
      code === "notParquet" ||
      code === "corruptFooter" ||
      code === "unsupported"
    ) {
      return code;
    }
  }

  return "unsupported";
}

function readDataWindowErrorCode(error: unknown): DataWindowErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (
      code === "noSourceOpen" ||
      code === "sourceChanged" ||
      code === "viewChanged" ||
      code === "cancelled" ||
      code === "notFound" ||
      code === "permissionDenied" ||
      code === "notParquet" ||
      code === "corruptSource" ||
      code === "unsupported" ||
      code === "windowTooLarge" ||
      code === "invalidFilter" ||
      code === "invalidSort" ||
      code === "resourceExhausted" ||
      code === "memoryExhausted" ||
      code === "temporaryStorageExhausted" ||
      code === "queryFailed" ||
      code === "queryEngineUnavailable" ||
      code === "encodingFailed"
    ) {
      return code;
    }
  }

  return "unsupported";
}

function readDataWindowCommandError(error: unknown): DataWindowCommandError {
  const code = readDataWindowErrorCode(error);
  const diagnostics =
    code === "memoryExhausted" || code === "temporaryStorageExhausted"
      ? readDataViewResourceDiagnostics(error)
      : undefined;
  return new DataWindowCommandError(code, diagnostics);
}

function readDataViewResourceDiagnostics(
  error: unknown,
): DataViewResourceDiagnostics | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("diagnostics" in error) ||
    typeof error.diagnostics !== "object" ||
    error.diagnostics === null
  ) {
    return undefined;
  }
  const diagnostics = error.diagnostics as Record<string, unknown>;
  const {
    operation,
    applicationVersion,
    operatingSystem,
    architecture,
    queryEngineVersion,
    message,
    memoryLimit,
    maxTemporaryDirectorySize,
    threads,
    rowCount,
    sourceSizeBytes,
    rowGroupCount,
    columnCount,
    filterCount,
    sortColumns: nativeSortColumns,
  } = diagnostics;
  if (
    (operation !== "preparation" && operation !== "window") ||
    typeof applicationVersion !== "string" ||
    typeof operatingSystem !== "string" ||
    typeof architecture !== "string" ||
    typeof queryEngineVersion !== "string" ||
    typeof message !== "string" ||
    typeof memoryLimit !== "string" ||
    typeof maxTemporaryDirectorySize !== "string" ||
    !isNonNegativeSafeInteger(threads) ||
    !isNonNegativeSafeInteger(rowCount) ||
    !isNonNegativeSafeInteger(sourceSizeBytes) ||
    !isNonNegativeSafeInteger(rowGroupCount) ||
    !isNonNegativeSafeInteger(columnCount) ||
    !isNonNegativeSafeInteger(filterCount) ||
    !Array.isArray(nativeSortColumns)
  ) {
    return undefined;
  }
  const sortColumns: DataViewSortDiagnostic[] = [];
  for (const column of nativeSortColumns) {
    if (typeof column !== "object" || column === null) {
      return undefined;
    }
    const { physicalType, logicalType, direction } = column as Record<
      string,
      unknown
    >;
    if (
      typeof physicalType !== "string" ||
      (logicalType !== null && typeof logicalType !== "string") ||
      (direction !== "ascending" && direction !== "descending")
    ) {
      return undefined;
    }
    sortColumns.push({ physicalType, logicalType, direction });
  }

  return {
    operation,
    applicationVersion,
    operatingSystem,
    architecture,
    queryEngineVersion,
    message,
    memoryLimit,
    maxTemporaryDirectorySize,
    threads,
    rowCount,
    sourceSizeBytes,
    rowGroupCount,
    columnCount,
    filterCount,
    sortColumns,
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readColumnStatisticsErrorCode(
  error: unknown,
): ColumnStatisticsErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (
      code === "noSourceOpen" ||
      code === "sourceChanged" ||
      code === "unsupportedColumn" ||
      code === "cancelled" ||
      code === "notFound" ||
      code === "permissionDenied" ||
      code === "notParquet" ||
      code === "corruptSource" ||
      code === "unsupported" ||
      code === "resourceExhausted" ||
      code === "queryFailed" ||
      code === "queryEngineUnavailable"
    ) {
      return code;
    }
  }

  return "unsupported";
}

async function invokeUpdate<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new UpdateCommandError(readUpdateErrorCode(error));
  }
}

function readUpdateErrorCode(error: unknown): UpdateErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (
      code === "unavailable" ||
      code === "storage" ||
      code === "noPendingUpdate" ||
      code === "manualInstall"
    ) {
      return code;
    }
  }

  return "unavailable";
}
