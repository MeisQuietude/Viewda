// The only module allowed to import Tauri APIs (an ESLint rule enforces
// this). Keeping the shell behind one seam is what lets a different shell —
// or a future web build — replace it without touching the rest of the UI.
// Note what is absent: no dialog API and no paths. File selection lives
// entirely in Rust, and the UI only ever receives a path-free summary.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface EngineStatus {
  name: string;
  version: string;
  queryEngineVersion: string;
}

export interface SourceSummary {
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

interface NativeSourceError {
  code: SourceErrorCode;
}

interface NativePostUpdateState {
  version: string;
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

export type UpdateErrorCode =
  "unavailable" | "storage" | "noPendingUpdate" | "manualInstall";

export class OpenSourceError extends Error {
  constructor(readonly code: SourceErrorCode) {
    super(code);
    this.name = "OpenSourceError";
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
