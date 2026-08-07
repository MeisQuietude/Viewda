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
  | "cancelled"
  | "notFound"
  | "permissionDenied"
  | "notParquet"
  | "corruptSource"
  | "unsupported"
  | "windowTooLarge"
  | "invalidFilter"
  | "resourceExhausted"
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
  constructor(readonly code: DataWindowErrorCode) {
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
  rowOffset: number,
  rowCount: number,
  filters: DataFilter[] = [],
): Promise<ArrayBuffer> {
  try {
    return await invoke<ArrayBuffer>("get_data_window", {
      generation,
      rowOffset,
      rowCount,
      filters,
    });
  } catch (error) {
    throw new DataWindowCommandError(readDataWindowErrorCode(error));
  }
}

export async function getFilteredRowCount(
  generation: number,
  filterRevision: number,
  filters: DataFilter[],
): Promise<number> {
  try {
    return await invoke<number>("get_filtered_row_count", {
      generation,
      filterRevision,
      filters,
    });
  } catch (error) {
    throw new DataWindowCommandError(readDataWindowErrorCode(error));
  }
}

export async function cancelFilteredRowCount(
  generation: number,
  filterRevision: number,
): Promise<void> {
  try {
    await invoke("cancel_filtered_row_count", { generation, filterRevision });
  } catch (error) {
    throw new DataWindowCommandError(readDataWindowErrorCode(error));
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
      code === "cancelled" ||
      code === "notFound" ||
      code === "permissionDenied" ||
      code === "notParquet" ||
      code === "corruptSource" ||
      code === "unsupported" ||
      code === "windowTooLarge" ||
      code === "invalidFilter" ||
      code === "resourceExhausted" ||
      code === "queryFailed" ||
      code === "queryEngineUnavailable" ||
      code === "encodingFailed"
    ) {
      return code;
    }
  }

  return "unsupported";
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
