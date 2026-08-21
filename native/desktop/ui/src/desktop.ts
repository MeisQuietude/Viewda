// The only module allowed to import Tauri APIs (an ESLint rule enforces
// this). Keeping the shell behind one seam is what lets a different shell —
// or a future web build — replace it without touching the rest of the UI.
// File selection and filesystem access live in Rust. The switcher receives
// canonical paths only for identity, search, tooltip, copy, and reveal actions.
import { Channel, invoke } from "@tauri-apps/api/core";
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
  columnCount: number;
  schema: SchemaField[];
  schemaNodeCount: number;
  schemaIsTruncated: boolean;
  stringsTruncated: boolean;
}

export type SourceKind = "file" | "folderDataset" | "fileDataset";

export interface OpenedSourceBatch {
  sources: SourceSummary[];
  sourceError: DatasetErrorDetail | null;
}

export type SourceOpenProgressPhase =
  "waiting" | "readingFooter" | "decodingFooter" | "summarizing";

export type SourceOpenCancelOutcome = "cancelled" | "published";

export interface RecentSource {
  id: string;
  name: string;
  directory: string;
  path: string;
}

/** One open source, as Rust lists it in most-recently-used order. */
export interface OpenedSourceEntry {
  generation: number;
  kind: SourceKind;
  datasetMemberCount: number | null;
  datasetIgnoredFileCount: number | null;
  name: string;
  directory: string;
  path: string;
  active: boolean;
}

export interface PartitionValue {
  key: string;
  value: string;
}

export interface DatasetMemberSummary {
  relativePath: string;
  partitions: PartitionValue[];
}

export interface DatasetMemberPage {
  offset: number;
  total: number;
  members: DatasetMemberSummary[];
}

export interface DatasetPartitionNode {
  partition: PartitionValue;
  memberCount: number;
}

export interface DatasetPartitionPage {
  nodes: DatasetPartitionNode[];
  nextAfter: PartitionValue | null;
}

export interface DatasetInspectionProgress {
  completedMemberCount: number;
  totalMemberCount: number;
  rowCount: number;
  rowGroupCount: number;
  schema: SchemaField[] | null;
  schemaNodeCount: number;
  schemaIsTruncated: boolean;
  stringsTruncated: boolean;
  schemaComplete: boolean;
}

export interface DatasetReadySummary {
  displayName: string;
  memberCount: number;
  ignoredFileCount: number;
  sizeBytes: number;
  rowCount: number;
  rowGroupCount: number;
  columnCount: number;
  schema: SchemaField[];
  schemaNodeCount: number;
  schemaIsTruncated: boolean;
  stringsTruncated: boolean;
  schemaDriftMemberCount: number;
  partitionColumnIndices: number[];
  provenanceColumnIndex: number;
}

export type DatasetStatus =
  | { state: "inspecting"; progress: DatasetInspectionProgress }
  | { state: "ready"; summary: DatasetReadySummary }
  | { state: "failed"; error: DatasetErrorDetail };

export interface SchemaField {
  name: string;
  physicalType: string;
  logicalType: string | null;
  children: SchemaField[];
}

export interface SourceSchemaPage {
  offset: number;
  totalCount: number;
  /** Bounded top-level Data columns; nested leaves are paged by Structure. */
  columns: SchemaField[];
}

export interface SourceSchemaNodeCursor {
  path: number[];
  leafIndex: number;
}

export interface SourceSchemaNode {
  path: number[];
  name: string;
  physicalType: string;
  logicalType: string | null;
  hasChildren: boolean;
  leafIndex: number | null;
}

export interface SourceSchemaNodePage {
  nodes: SourceSchemaNode[];
  nextCursor: SourceSchemaNodeCursor | null;
  totalCount: number;
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
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "isNull"
  | "isNotNull";

export interface DataFilter {
  columnIndex: number;
  operator: DataFilterOperator;
  values: string[];
  matchCase?: boolean;
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

export interface ExportRowRange {
  start: number;
  end: number;
}

export interface DataExportRequest {
  columnIndices: number[];
  rowRanges: ExportRowRange[];
  output: { format: "csv"; options: Record<string, never> };
}

export type DataExportScope = "selection" | "view";

export type DataExportErrorCode =
  | "noSourceOpen"
  | "sourceChanged"
  | "viewChanged"
  | "alreadyRunning"
  | "notFound"
  | "permissionDenied"
  | "sourceChanged"
  | "notParquet"
  | "corruptSource"
  | "invalidRequest"
  | "unsupported"
  | "diskFull"
  | "resourceExhausted"
  | "queryFailed"
  | "queryEngineUnavailable"
  | "cancelled";

interface DataExportStatusBase {
  id: number;
  fileName: string;
  bytesWritten: number;
}

export type DataExportStatus =
  | (DataExportStatusBase & { state: "running" })
  | (DataExportStatusBase & { state: "completed" })
  | (DataExportStatusBase & { state: "cancelled" })
  | (DataExportStatusBase & {
      state: "failed";
      error: DataExportErrorCode;
    });

export interface ColumnStatistics {
  minimum: string | null;
  maximum: string | null;
  minMaxComputed: boolean;
  nullShare: number;
  approximateDistinctCount: number;
}

export type StructureByteUnit = "compressed" | "uncompressed";

export type StructureSortDirection = "ascending" | "descending";

export type StructureRowGroupSort =
  "index" | "rowCount" | "bytes" | "compressionRatio" | "bloomFilters";

export type StructureColumnSort =
  "index" | "name" | "bytes" | "compressionRatio";

export interface StructureKeyValueEntry {
  index: number;
  key: string;
  valueBytes: number | null;
}

export interface StructureKeyValue {
  index: number;
  key: string;
  value: string | null;
  isTruncated: boolean;
}

export interface StructureSummary {
  compressedBytes: number;
  uncompressedBytes: number;
  compressionRatio: number | null;
  formatVersion: number;
  createdBy: string | null;
  rowCount: number;
  rowGroupCount: number;
  columnCount: number;
  rowsPerRowGroup: number | null;
  footerBytes: number;
  codecs: string[];
  chunkCount: number;
  chunksWithStatistics: number;
  chunksWithBloomFilter: number;
  unreadableRowGroupCount: number;
  keyValueCount: number;
  keyValueMetadata: StructureKeyValueEntry[];
  stringsTruncated?: boolean;
}

export interface StructureLensTotal {
  chunkCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
}

export interface StructureCodecTotal {
  codec: string;
  total: StructureLensTotal;
}

export interface StructureRatioStep {
  maxRatio: number | null;
  total: StructureLensTotal;
}

export interface StructurePresenceTotals {
  present: StructureLensTotal;
  absent: StructureLensTotal;
}

export interface StructureLensTotals {
  codecs: StructureCodecTotal[];
  ratioSteps: StructureRatioStep[];
  unrated: StructureLensTotal;
  statistics: StructurePresenceTotals;
  bloomFilters: StructurePresenceTotals;
}

export interface StructureLayoutSegment {
  columnIndex: number;
  columnName: string;
  compressedBytes: number;
  uncompressedBytes: number;
  compressionRatio: number | null;
  codec: string;
  encodings: string[];
  hasStatistics: boolean;
  hasBloomFilter: boolean;
  hasPageIndex: boolean;
}

export interface StructureLayoutTail {
  segmentCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
}

export interface StructureLayoutRow {
  index: number;
  compressedBytes: number;
  uncompressedBytes: number;
  isReadable: boolean;
  segments: StructureLayoutSegment[];
  tail: StructureLayoutTail | null;
}

export interface StructureLayout {
  offset: number;
  totalCount: number;
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  overview: StructureLayoutOverviewBucket[];
  rows: StructureLayoutRow[];
}

export interface StructureLayoutOverviewBucket {
  rowStart: number;
  rowEnd: number;
  compressedBytes: number;
  uncompressedBytes: number;
  dominantRatioStepCompressed: number | null;
  dominantRatioStepUncompressed: number | null;
  dominantCodecCompressed: string | null;
  dominantCodecUncompressed: string | null;
  statisticsShareCompressed: number;
  statisticsShareUncompressed: number;
  hasBloomFilter: boolean;
  hasLayoutFacts: boolean;
  focusedCompressedBytes: number;
  focusedUncompressedBytes: number;
}

export interface StructureRowGroupSummary {
  index: number;
  rowCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
  compressionRatio: number | null;
  chunkCount: number;
  chunksWithBloomFilter: number;
  isReadable: boolean;
  hasLayoutFacts: boolean;
}

export interface StructureRowGroupPage {
  offset: number;
  totalCount: number;
  rowGroups: StructureRowGroupSummary[];
}

export interface StructureColumnSummary {
  index: number;
  name: string;
  physicalType: string;
  logicalType: string | null;
  compressedBytes: number;
  uncompressedBytes: number;
  compressionRatio: number | null;
  encodings: string[];
  share: number;
  // The running total follows the file's own bytes-descending ranking, so a
  // column keeps the same value under any visible sort.
  cumulativeShare: number;
}

export interface StructureColumnPage {
  offset: number;
  totalCount: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  columns: StructureColumnSummary[];
}

export interface StructureChunkStatistics {
  minimum: string | null;
  maximum: string | null;
  minimumIsExact: boolean;
  maximumIsExact: boolean;
  nullCount: number | null;
  distinctCount: number | null;
}

export interface StructureChunkDetails {
  rowGroupIndex: number;
  columnIndex: number;
  columnName: string;
  physicalType: string;
  codec: string;
  encodings: string[];
  valueCount: number;
  compressedBytes: number;
  uncompressedBytes: number;
  compressionRatio: number | null;
  dataPageOffset: number;
  dictionaryPageOffset: number | null;
  bloomFilterBytes: number | null;
  hasBloomFilter: boolean;
  columnHasBloomFilter: boolean;
  hasPageIndex: boolean;
  hasOffsetIndex: boolean;
  statistics: StructureChunkStatistics | null;
}

export type StructureBloomProbeOutcome =
  "mayContain" | "definitelyAbsent" | "noFilter" | "unreadable";

export interface StructureBloomProbeResult {
  index: number;
  outcome: StructureBloomProbeOutcome;
}

export interface StructureBloomProbe {
  columnIndex: number;
  offset: number;
  totalCount: number;
  rowGroups: StructureBloomProbeResult[];
}

// Both counters stay zero while the footer itself is being decoded.
export interface StructureLoadProgress {
  completedRowGroups: number;
  totalRowGroups: number;
  completedChunks: number;
  totalChunks: number;
}

export interface TextValueSuggestions {
  values: string[];
  isPartial: boolean;
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

export interface UpdateProgress {
  percent: number;
}

export interface DataExportCloseDialog {
  message: string;
  destructiveButton: string;
}

export interface UpdateCheckOptions {
  allowDowngrade?: boolean;
  automaticCheck?: boolean;
}

export interface PostUpdateState {
  version: string;
  sources: SourceSummary[];
  sourceError: DatasetErrorDetail | null;
}

export type DefaultApplicationStatus =
  | { kind: "default" }
  | { kind: "canSet" }
  | { kind: "unavailable" }
  | { kind: "unintegratedAppImage" }
  | { kind: "systemSettings" };

export interface OpenedSourceActivation {
  source: SourceSummary | null;
  sourceError: DatasetErrorDetail | null;
}

export function shortcutModifierFor(platform: string): string {
  return /Mac|iPhone|iPad|iPod/.test(platform) ? "⌘" : "Ctrl+";
}

export const shortcutModifier = shortcutModifierFor(navigator.platform);

export type SourceErrorCode =
  | "notFound"
  | "permissionDenied"
  | "sourceChanged"
  | "notParquet"
  | "corruptFooter"
  | "unsupported";

export type DatasetErrorCode =
  | SourceErrorCode
  | "noSourceOpen"
  | "noParquetFiles"
  | "pageTooLarge"
  | "inspectionStepTooLarge"
  | "cancelled"
  | "schemaConflict"
  | "invalidMember"
  | "notDataset"
  | "notReady"
  | "window";

export interface SourceErrorDetail {
  code: Exclude<DatasetErrorCode, "window">;
  member?: string;
  column?: string;
}

export interface DatasetWindowErrorDetail {
  code: "window";
  error: { code: DataWindowErrorCode };
}

export type DatasetErrorDetail = SourceErrorDetail | DatasetWindowErrorDetail;

export type DataWindowErrorCode =
  | "noSourceOpen"
  | "sourceChanged"
  | "viewChanged"
  | "cancelled"
  | "notFound"
  | "permissionDenied"
  | "notParquet"
  | "corruptSource"
  | "invalidMember"
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

export type StructureErrorCode =
  | "noSourceOpen"
  | "sourceChanged"
  | "notLoaded"
  | "cancelled"
  | "notFound"
  | "permissionDenied"
  | "notParquet"
  | "corruptFooter"
  | "unsupported"
  | "unknownRowGroup"
  | "unknownColumn"
  | "unknownKeyValue"
  | "invalidProbeValue"
  | "unsupportedProbeColumn";

export type UpdateErrorCode =
  "unavailable" | "storage" | "noPendingUpdate" | "manualInstall";

export class OpenSourceError extends Error {
  readonly code: DatasetErrorCode;

  readonly detail: DatasetErrorDetail;

  constructor(detail: DatasetErrorDetail | SourceErrorDetail["code"]) {
    const normalized = typeof detail === "string" ? { code: detail } : detail;
    super(normalized.code);
    this.detail = normalized;
    this.code = normalized.code;
    this.name = "OpenSourceError";
  }
}

export class DatasetCommandError extends Error {
  readonly code: DatasetErrorCode;

  readonly detail: DatasetErrorDetail;

  constructor(detail: DatasetErrorDetail | SourceErrorDetail["code"]) {
    const normalized = typeof detail === "string" ? { code: detail } : detail;
    super(normalized.code);
    this.detail = normalized;
    this.code = normalized.code;
    this.name = "DatasetCommandError";
  }
}

export class DataWindowCommandError extends Error {
  constructor(
    readonly code: DataWindowErrorCode,
    readonly diagnostics?: DataViewResourceDiagnostics,
    readonly detail?: SourceErrorDetail,
  ) {
    super(code);
    this.name = "DataWindowCommandError";
  }
}

export class DataExportCommandError extends Error {
  constructor(readonly code: DataExportErrorCode) {
    super(code);
    this.name = "DataExportCommandError";
  }
}

export class ColumnStatisticsCommandError extends Error {
  constructor(readonly code: ColumnStatisticsErrorCode) {
    super(code);
    this.name = "ColumnStatisticsCommandError";
  }
}

export class StructureCommandError extends Error {
  constructor(readonly code: StructureErrorCode) {
    super(code);
    this.name = "StructureCommandError";
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

export function installPendingUpdate(
  onProgress: (progress: UpdateProgress) => void,
): Promise<boolean> {
  const onProgressChannel = new Channel<UpdateProgress>(onProgress);
  return invokeUpdate("install_pending_update", {
    onProgress: onProgressChannel,
  });
}

export function takePostUpdateState(): Promise<PostUpdateState | null> {
  return invoke<PostUpdateState | null>("take_post_update_state");
}

export function takeOpenedSource(): Promise<OpenedSourceActivation | null> {
  return invoke<OpenedSourceActivation | null>("take_opened_source");
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

export function openLocalSource(
  attempt: string,
  groupAsDataset = false,
): Promise<OpenedSourceBatch | null> {
  return invokeSource<OpenedSourceBatch | null>("open_local_source", {
    attempt,
    groupAsDataset,
  });
}

export function openLocalFolder(
  attempt: string,
): Promise<SourceSummary | null> {
  return invokeSource<SourceSummary | null>("open_local_folder", {
    attempt,
  });
}

export function cancelSourceOpen(
  attempt: string,
): Promise<SourceOpenCancelOutcome> {
  return invokeSource<SourceOpenCancelOutcome>("cancel_source_open", {
    attempt,
  });
}

export function getSourceOpenProgress(): Promise<SourceOpenProgressPhase | null> {
  return invokeSource<SourceOpenProgressPhase | null>(
    "get_source_open_progress",
  );
}

export function getSourceSchemaPage(
  generation: number,
  offset: number,
  limit: number,
): Promise<SourceSchemaPage> {
  return invokeSource<SourceSchemaPage>("get_source_schema_page", {
    generation,
    offset,
    limit,
  });
}

export function getSourceSchemaNodePage(
  generation: number,
  cursor: SourceSchemaNodeCursor | null,
  limit: number,
): Promise<SourceSchemaNodePage> {
  return invokeSource<SourceSchemaNodePage>("get_source_schema_node_page", {
    generation,
    cursor,
    limit,
  });
}

export function getRecentSources(): Promise<RecentSource[]> {
  return invoke<RecentSource[]>("get_recent_sources");
}

export function openRecentSource(
  id: string,
  attempt: string,
): Promise<SourceSummary> {
  return invokeSource<SourceSummary>("open_recent_source", { id, attempt });
}

export function removeRecentSource(id: string): Promise<void> {
  return invoke("remove_recent_source", { id });
}

export function clearRecentSources(): Promise<void> {
  return invoke("clear_recent_sources");
}

export function listOpenedSources(): Promise<OpenedSourceEntry[]> {
  return invoke<OpenedSourceEntry[]>("list_opened_sources");
}

export function activateOpenedSource(generation: number): Promise<void> {
  return invoke("activate_opened_source", { generation });
}

export function cycleOpenedSource(reverse: boolean): Promise<number | null> {
  return invoke<number | null>("cycle_opened_source", { reverse });
}

/** Closes one open source; `false` means a running export kept it open. */
export function closeOpenedSource(generation: number): Promise<boolean> {
  return invoke<boolean>("close_opened_source", { generation });
}

export function revealOpenedSource(generation: number): Promise<void> {
  return invoke("reveal_opened_source", { generation });
}

export function reloadOpenedSource(generation: number): Promise<SourceSummary> {
  return invokeSource<SourceSummary>("reload_opened_source", { generation });
}

export function getDatasetStatus(generation: number): Promise<DatasetStatus> {
  return invokeDataset<DatasetStatus>("get_dataset_status", { generation });
}

export function getDatasetPreview(generation: number): Promise<ArrayBuffer> {
  return invokeDataset<ArrayBuffer>("get_dataset_preview", { generation });
}

export function cancelDatasetInspection(generation: number): Promise<boolean> {
  return invokeDataset<boolean>("cancel_dataset_inspection", { generation });
}

export function getDatasetMembers(
  generation: number,
  offset: number,
  limit: number,
): Promise<DatasetMemberPage> {
  return invokeDataset<DatasetMemberPage>("get_dataset_members", {
    generation,
    offset,
    limit,
  });
}

export function getDatasetPartitions(
  generation: number,
  parent: PartitionValue[],
  after: PartitionValue | null,
  limit: number,
): Promise<DatasetPartitionPage> {
  return invokeDataset<DatasetPartitionPage>("get_dataset_partitions", {
    generation,
    parent,
    after,
    limit,
  });
}

export function getDatasetSchemaDriftMembers(
  generation: number,
  offset: number,
  limit: number,
): Promise<DatasetMemberPage> {
  return invokeDataset<DatasetMemberPage>("get_dataset_schema_drift_members", {
    generation,
    offset,
    limit,
  });
}

export function selectDatasetStructureMember(
  generation: number,
  ordinal: number,
): Promise<DatasetMemberSummary> {
  return invokeStructure<DatasetMemberSummary>(
    "select_dataset_structure_member",
    { generation, ordinal },
  );
}

async function invokeSource<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new OpenSourceError(readDatasetErrorDetail(error));
  }
}

async function invokeDataset<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new DatasetCommandError(readDatasetErrorDetail(error));
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

export async function startDataExport(
  generation: number,
  viewRevision: number,
  scope: DataExportScope,
  request: DataExportRequest,
): Promise<DataExportStatus | null> {
  try {
    return await invoke<DataExportStatus | null>("start_data_export", {
      generation,
      viewRevision,
      scope,
      request,
    });
  } catch (error) {
    throw new DataExportCommandError(readDataExportErrorCode(error));
  }
}

export function getDataExportStatus(
  generation: number,
): Promise<DataExportStatus | null> {
  return invoke<DataExportStatus | null>("get_data_export_status", {
    generation,
  });
}

export function cancelDataExport(id: number): Promise<boolean> {
  return invoke<boolean>("cancel_data_export", { id });
}

export function dismissDataExport(id: number): Promise<boolean> {
  return invoke<boolean>("dismiss_data_export", { id });
}

export async function revealDataExport(id: number): Promise<void> {
  try {
    await invoke("reveal_data_export", { id });
  } catch (error) {
    throw new DataExportCommandError(readDataExportErrorCode(error));
  }
}

export async function getTextValueSuggestions(
  generation: number,
  suggestionRevision: number,
  columnIndex: number,
  prefix: string,
  operator: DataFilterOperator,
): Promise<TextValueSuggestions> {
  try {
    return await invoke<TextValueSuggestions>("get_text_value_suggestions", {
      generation,
      suggestionRevision,
      columnIndex,
      prefix,
      operator,
    });
  } catch (error) {
    throw readDataWindowCommandError(error);
  }
}

export async function cancelTextValueSuggestions(
  generation: number,
  suggestionRevision: number,
): Promise<void> {
  try {
    await invoke("cancel_text_value_suggestions", {
      generation,
      suggestionRevision,
    });
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

export function getStructureSummary(
  generation: number,
): Promise<StructureSummary> {
  return invokeStructure<StructureSummary>("get_structure_summary", {
    generation,
  });
}

export function getStructureLoadProgress(
  generation: number,
): Promise<StructureLoadProgress | null> {
  return invoke<StructureLoadProgress | null>("get_structure_load_progress", {
    generation,
  });
}

export function cancelStructureLoad(generation: number): Promise<void> {
  return invoke("cancel_structure_load", { generation });
}

export function getStructureLensTotals(
  generation: number,
): Promise<StructureLensTotals> {
  return invokeStructure<StructureLensTotals>("get_structure_lens_totals", {
    generation,
  });
}

export function getStructureLayout(
  generation: number,
  unit: StructureByteUnit,
  rowOffset: number,
  rowLimit: number,
  segmentLimit: number,
  focusedColumn: number | null,
): Promise<StructureLayout> {
  return invokeStructure<StructureLayout>("get_structure_layout", {
    generation,
    unit,
    rowOffset,
    rowLimit,
    segmentLimit,
    focusedColumn,
  });
}

export function getStructureRowGroups(
  generation: number,
  unit: StructureByteUnit,
  sort: StructureRowGroupSort,
  direction: StructureSortDirection,
  offset: number,
  limit: number,
): Promise<StructureRowGroupPage> {
  return invokeStructure<StructureRowGroupPage>("get_structure_row_groups", {
    generation,
    unit,
    sort,
    direction,
    offset,
    limit,
  });
}

export function getStructureColumns(
  generation: number,
  unit: StructureByteUnit,
  sort: StructureColumnSort,
  direction: StructureSortDirection,
  offset: number,
  limit: number,
): Promise<StructureColumnPage> {
  return invokeStructure<StructureColumnPage>("get_structure_columns", {
    generation,
    unit,
    sort,
    direction,
    offset,
    limit,
  });
}

export function getStructureChunk(
  generation: number,
  rowGroupIndex: number,
  columnIndex: number,
): Promise<StructureChunkDetails> {
  return invokeStructure<StructureChunkDetails>("get_structure_chunk", {
    generation,
    rowGroupIndex,
    columnIndex,
  });
}

export function getStructureKeyValue(
  generation: number,
  index: number,
): Promise<StructureKeyValue> {
  return invokeStructure<StructureKeyValue>("get_structure_key_value", {
    generation,
    index,
  });
}

export function getStructureRowOffset(
  generation: number,
  rowGroupIndex: number,
): Promise<number> {
  return invokeStructure<number>("get_structure_row_offset", {
    generation,
    rowGroupIndex,
  });
}

export function getStructureReport(
  generation: number,
  unit: StructureByteUnit,
): Promise<string> {
  return invokeStructure<string>("get_structure_report", { generation, unit });
}

export function probeStructureBloomFilter(
  generation: number,
  columnIndex: number,
  value: string,
  offset: number,
  limit: number,
): Promise<StructureBloomProbe> {
  return invokeStructure<StructureBloomProbe>("probe_structure_bloom_filter", {
    generation,
    columnIndex,
    value,
    offset,
    limit,
  });
}

export function cancelStructureBloomProbe(generation: number): Promise<void> {
  return invoke("cancel_structure_bloom_probe", { generation });
}

async function invokeStructure<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new StructureCommandError(readStructureErrorCode(error));
  }
}

export function onOpenSourceRequested(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen("open-source-requested", handler);
}

export function onOpenFolderRequested(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen("open-folder-requested", handler);
}

export function onCloseSourceRequested(
  handler: (generation: number) => void,
): Promise<UnlistenFn> {
  return listen<number>("close-source-requested", (event) => {
    handler(event.payload);
  });
}

export function onRecentSourcesChanged(
  handler: () => void,
): Promise<UnlistenFn> {
  return listen("recent-sources-changed", handler);
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

export function getPendingDataExportCloseDialog(): Promise<DataExportCloseDialog | null> {
  return invoke<DataExportCloseDialog | null>(
    "get_pending_data_export_close_dialog",
  );
}

export function resolveDataExportCloseDialog(
  cancelExport: boolean,
): Promise<boolean> {
  return invoke<boolean>("resolve_data_export_close_dialog", { cancelExport });
}

export function onDataExportCloseRequested(
  handler: (dialog: DataExportCloseDialog) => void,
): Promise<UnlistenFn> {
  return listen<DataExportCloseDialog>(
    "data-export-close-requested",
    ({ payload }) => handler(payload),
  );
}

function readSourceErrorDetail(error: unknown): SourceErrorDetail {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (
      code === "notFound" ||
      code === "noSourceOpen" ||
      code === "permissionDenied" ||
      code === "sourceChanged" ||
      code === "notParquet" ||
      code === "corruptFooter" ||
      code === "noParquetFiles" ||
      code === "pageTooLarge" ||
      code === "inspectionStepTooLarge" ||
      code === "cancelled" ||
      code === "schemaConflict" ||
      code === "invalidMember" ||
      code === "notDataset" ||
      code === "notReady" ||
      code === "unsupported"
    ) {
      const member = "member" in error ? error.member : undefined;
      const column = "column" in error ? error.column : undefined;
      return {
        code,
        ...(typeof member === "string" ? { member } : {}),
        ...(typeof column === "string" ? { column } : {}),
      };
    }
  }

  return { code: "unsupported" };
}

function readDatasetErrorDetail(error: unknown): DatasetErrorDetail {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "window" &&
    "error" in error
  ) {
    return {
      code: "window",
      error: { code: readDataWindowErrorCode(error.error) },
    };
  }
  return readSourceErrorDetail(error);
}

function readDataWindowErrorCode(error: unknown): DataWindowErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (code === "window" && "error" in error) {
      return readDataWindowErrorCode(error.error);
    }
    if (
      code === "noSourceOpen" ||
      code === "sourceChanged" ||
      code === "viewChanged" ||
      code === "cancelled" ||
      code === "notFound" ||
      code === "permissionDenied" ||
      code === "notParquet" ||
      code === "corruptSource" ||
      code === "invalidMember" ||
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
  const detail =
    code === "sourceChanged" || code === "invalidMember"
      ? readSourceErrorDetail(error)
      : undefined;
  return new DataWindowCommandError(code, diagnostics, detail);
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

function readDataExportErrorCode(error: unknown): DataExportErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (
      code === "noSourceOpen" ||
      code === "sourceChanged" ||
      code === "viewChanged" ||
      code === "alreadyRunning" ||
      code === "notFound" ||
      code === "permissionDenied" ||
      code === "notParquet" ||
      code === "corruptSource" ||
      code === "invalidRequest" ||
      code === "unsupported" ||
      code === "diskFull" ||
      code === "resourceExhausted" ||
      code === "queryFailed" ||
      code === "queryEngineUnavailable" ||
      code === "cancelled"
    ) {
      return code;
    }
  }

  return "queryFailed";
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

function readStructureErrorCode(error: unknown): StructureErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (
      code === "noSourceOpen" ||
      code === "sourceChanged" ||
      code === "notLoaded" ||
      code === "cancelled" ||
      code === "notFound" ||
      code === "permissionDenied" ||
      code === "notParquet" ||
      code === "corruptFooter" ||
      code === "unsupported" ||
      code === "unknownRowGroup" ||
      code === "unknownColumn" ||
      code === "unknownKeyValue" ||
      code === "invalidProbeValue" ||
      code === "unsupportedProbeColumn"
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
