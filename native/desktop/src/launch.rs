//! Native file-open activation without exposing filesystem paths to the webview.

use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[cfg(any(not(target_os = "macos"), test))]
use std::ffi::OsString;

use serde::Serialize;
use tauri::{Emitter, Manager};
use viewda_data_engine::SourceError;

use crate::{
    OpenSourceError, OpenedSource, OpenedSourceInfo, OpenedSourceKind, SourceDescriptor,
    SourceOpenIntent, SourceOpenPublication, inspect_selected_source_at_path_for_request,
    open_dataset_descriptor_for_request, open_explicit_files_for_request, recents,
};

pub const OPENED_SOURCE_AVAILABLE_EVENT: &str = "opened-source-available";
pub const SOURCE_DRAG_STATE_EVENT: &str = "source-drag-state";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum SourceDragPhase {
    Enter,
    Leave,
    Drop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum SourceDragKind {
    Folder,
    Files,
    Mixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceDragPayload {
    state: SourceDragPhase,
    kind: SourceDragKind,
}

#[derive(Default)]
struct SourceDragStateValue {
    request: u64,
    active: Option<SourceDragKind>,
}

#[derive(Default)]
pub struct SourceDragState(Mutex<SourceDragStateValue>);

pub fn publish_source_drag_enter(app: &tauri::AppHandle, paths: &[PathBuf]) {
    let (kind, ambiguous_path) = classify_drag_kind_without_io(paths);
    let request = match app.state::<SourceDragState>().0.lock() {
        Ok(mut state) => {
            state.request = state.request.wrapping_add(1);
            state.active = Some(kind);
            state.request
        }
        Err(_) => return,
    };
    publish_source_drag_state(app, SourceDragPhase::Enter, kind);
    let Some(path) = ambiguous_path else {
        return;
    };
    let worker_app = app.clone();
    dispatch_native_source_open(move || {
        let resolved = std::fs::metadata(path)
            .ok()
            .filter(|metadata| metadata.is_dir())
            .map_or(SourceDragKind::Mixed, |_| SourceDragKind::Folder);
        let publish = worker_app
            .state::<SourceDragState>()
            .0
            .lock()
            .is_ok_and(|mut state| {
                if state.request != request || state.active.is_none() {
                    return false;
                }
                let changed = state.active != Some(resolved);
                state.active = Some(resolved);
                changed
            });
        if publish {
            publish_source_drag_state(&worker_app, SourceDragPhase::Enter, resolved);
        }
    });
}

pub fn publish_source_drag_leave(app: &tauri::AppHandle) {
    let kind = app
        .state::<SourceDragState>()
        .0
        .lock()
        .ok()
        .and_then(|mut state| {
            state.request = state.request.wrapping_add(1);
            state.active.take()
        })
        .unwrap_or(SourceDragKind::Mixed);
    publish_source_drag_state(app, SourceDragPhase::Leave, kind);
}

fn publish_source_drag_state(app: &tauri::AppHandle, state: SourceDragPhase, kind: SourceDragKind) {
    let _ = app.emit(SOURCE_DRAG_STATE_EVENT, SourceDragPayload { state, kind });
}

fn classify_drag_kind_without_io(paths: &[PathBuf]) -> (SourceDragKind, Option<PathBuf>) {
    if paths.len() != 1 {
        return (
            if !paths.is_empty()
                && paths.iter().all(|path| {
                    path.extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("parquet"))
                })
            {
                SourceDragKind::Files
            } else {
                SourceDragKind::Mixed
            },
            None,
        );
    }
    if is_parquet(&paths[0]) {
        (SourceDragKind::Files, None)
    } else {
        (SourceDragKind::Mixed, Some(paths[0].clone()))
    }
}

/// Native activation results waiting for the webview to consume them, oldest first.
///
/// Dropping several files at once activates them faster than the webview drains
/// the queue, and every activation carries a source the window must keep open.
#[derive(Default)]
pub struct PendingOpenedSource(Mutex<VecDeque<OpenedSourceActivation>>);

/// Path-free result of an operating-system file-open activation.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedSourceActivation {
    source: Option<OpenedSourceInfo>,
    source_error: Option<OpenSourceError>,
}

#[tauri::command]
pub fn take_opened_source(
    pending: tauri::State<'_, PendingOpenedSource>,
) -> Option<OpenedSourceActivation> {
    pending.0.lock().ok()?.pop_front()
}

#[derive(Debug, PartialEq, Eq)]
enum OpenPathSource {
    Folder(PathBuf),
    File(PathBuf),
}

fn classify_open_path(path: PathBuf) -> Result<OpenPathSource, SourceError> {
    if path.is_dir() {
        Ok(OpenPathSource::Folder(path))
    } else if is_parquet(&path) {
        Ok(OpenPathSource::File(path))
    } else {
        Err(SourceError::NotParquet)
    }
}

#[cfg(not(target_os = "macos"))]
fn open_path(app: &tauri::AppHandle, path: PathBuf) {
    open_paths(app, vec![path]);
}

pub fn open_paths(app: &tauri::AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let Some(request) = begin_native_source_open(app) else {
        return;
    };
    let worker_app = app.clone();
    dispatch_native_source_open(move || open_paths_for_request(&worker_app, paths, request));
}

fn open_paths_for_request(app: &tauri::AppHandle, paths: Vec<PathBuf>, request: u64) {
    for path in paths {
        let result = classify_open_path(path)
            .map_err(OpenSourceError::from)
            .and_then(|source| inspect_native_source(app, source, request));
        if !publish_native_open_result(app, request, result, false) {
            return;
        }
    }
}

pub fn open_recent(app: &tauri::AppHandle, id: &str) {
    let Some(request) = begin_native_source_open(app) else {
        return;
    };
    let worker_app = app.clone();
    let id = id.to_owned();
    dispatch_native_source_open(move || {
        let result = crate::open_recent_source_with_app_for_request(&worker_app, &id, request)
            .map(|(_, source)| Some(source));
        publish_native_open_result(&worker_app, request, result, true);
    });
}

fn begin_native_source_open(app: &tauri::AppHandle) -> Option<u64> {
    if let Ok(mut drag) = app.state::<SourceDragState>().0.lock() {
        drag.request = drag.request.wrapping_add(1);
        drag.active = None;
    }
    let opened_source = app.state::<OpenedSource>();
    if let Err(error) = opened_source.mark_explicit() {
        publish_open_error(app, error);
        return None;
    }
    match opened_source.begin_source_open() {
        Ok(request) => Some(request),
        Err(error) => {
            publish_open_error(app, error);
            None
        }
    }
}

fn inspect_native_source(
    app: &tauri::AppHandle,
    source: OpenPathSource,
    request: u64,
) -> Result<Option<OpenedSourceInfo>, OpenSourceError> {
    match source {
        OpenPathSource::Folder(path) => {
            open_dataset_descriptor_for_request(app, SourceDescriptor::Folder(path), request)
        }
        OpenPathSource::File(path) => inspect_selected_source_at_path_for_request(
            recents::state_path(app).ok().as_deref(),
            app.state::<OpenedSource>().inner(),
            path,
            SourceOpenIntent::Explicit,
            SourceOpenPublication {
                request,
                client_attempt: None,
                reload_generation: None,
            },
        )
        .map(|opened| opened.map(|(_, source)| source)),
    }
}

fn dispatch_native_source_open(job: impl FnOnce() + Send + 'static) {
    tauri::async_runtime::spawn_blocking(job);
}

fn publish_native_open_result(
    app: &tauri::AppHandle,
    request: u64,
    result: Result<Option<OpenedSourceInfo>, OpenSourceError>,
    refresh_recent_on_error: bool,
) -> bool {
    let current = app
        .state::<OpenedSource>()
        .source_open_is_current(request)
        .unwrap_or(false);
    if !current {
        if refresh_recent_on_error && result.is_err() {
            let _ = crate::recent_sources_changed(app);
        }
        return false;
    }
    match result {
        Ok(Some(source)) => {
            let refresh_recent = source.kind == OpenedSourceKind::File;
            publish(
                app,
                OpenedSourceActivation {
                    source: Some(source),
                    source_error: None,
                },
            );
            if refresh_recent {
                let _ = crate::recent_sources_changed(app);
            }
        }
        Ok(None) => return false,
        Err(error) => {
            publish_open_error(app, error);
            if refresh_recent_on_error {
                let _ = crate::recent_sources_changed(app);
            }
        }
    }
    true
}

fn publish_open_error(app: &tauri::AppHandle, error: OpenSourceError) {
    let source_error = match error {
        OpenSourceError::Source(error) => error.into(),
        OpenSourceError::Recent(_) => SourceError::Unsupported.into(),
        error @ OpenSourceError::Dataset(_) => error,
    };
    publish(
        app,
        OpenedSourceActivation {
            source: None,
            source_error: Some(source_error),
        },
    );
}

/// Classifies and opens one native drop without exposing its paths.
///
/// Files open in drop order, so the last one dropped becomes the active source.
pub fn finish_source_drop(app: &tauri::AppHandle, paths: Vec<PathBuf>) {
    let group_files = platform_alt_modifier_active();
    let (drag_request, kind) = match app.state::<SourceDragState>().0.lock() {
        Ok(mut state) => {
            state.request = state.request.wrapping_add(1);
            let kind = state.active.take().unwrap_or(SourceDragKind::Mixed);
            (state.request, kind)
        }
        Err(_) => return,
    };
    publish_source_drag_state(app, SourceDragPhase::Drop, kind);
    let worker_app = app.clone();
    dispatch_native_source_open(move || {
        let dropped = classify_dropped_paths(paths, group_files);
        let current_drop = worker_app
            .state::<SourceDragState>()
            .0
            .lock()
            .is_ok_and(|state| state.request == drag_request && state.active.is_none());
        if !current_drop {
            return;
        }
        let dropped = match dropped {
            Ok(dropped) => dropped,
            Err(error) => {
                publish_open_error(&worker_app, error.into());
                return;
            }
        };
        let Some(request) = begin_native_source_open(&worker_app) else {
            return;
        };
        if !worker_app
            .state::<OpenedSource>()
            .source_open_is_current(request)
            .unwrap_or(false)
        {
            return;
        }
        match dropped {
            DroppedSource::Folder(path) => {
                publish_dataset_for_request(&worker_app, DatasetDrop::Folder(path), request)
            }
            DroppedSource::FileDataset(paths) => {
                publish_dataset_for_request(&worker_app, DatasetDrop::ExplicitFiles(paths), request)
            }
            DroppedSource::Files(paths) => open_paths_for_request(&worker_app, paths, request),
        }
    });
}

// WRY's cross-platform drop event omits keyboard modifiers, so the native
// callback samples the platform state at Drop instead of trusting webview focus.
#[cfg(target_os = "linux")]
fn platform_alt_modifier_active() -> bool {
    use gtk::gdk::{Display, Keymap, ModifierType};

    Display::default()
        .and_then(|display| Keymap::for_display(&display))
        .is_some_and(|keymap| keymap.modifier_state() & ModifierType::MOD1_MASK.bits() != 0)
}

#[cfg(target_os = "windows")]
fn platform_alt_modifier_active() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_MENU};

    // The high bit is the key's current state; the low bit is historical.
    unsafe { GetAsyncKeyState(VK_MENU.into()) as u16 & 0x8000 != 0 }
}

#[cfg(target_os = "macos")]
fn platform_alt_modifier_active() -> bool {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags};

    NSEvent::modifierFlags_class().contains(NSEventModifierFlags::Option)
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn platform_alt_modifier_active() -> bool {
    false
}

#[derive(Debug, PartialEq, Eq)]
enum DroppedSource {
    Folder(PathBuf),
    Files(Vec<PathBuf>),
    FileDataset(Vec<PathBuf>),
}

fn classify_dropped_paths(
    paths: Vec<PathBuf>,
    group_files: bool,
) -> Result<DroppedSource, SourceError> {
    classify_dropped_paths_with(paths, group_files, |path| {
        std::fs::metadata(path).is_ok_and(|metadata| metadata.is_dir())
    })
}

fn classify_dropped_paths_with(
    paths: Vec<PathBuf>,
    group_files: bool,
    is_directory: impl FnOnce(&Path) -> bool,
) -> Result<DroppedSource, SourceError> {
    if paths.is_empty() {
        return Err(SourceError::NotParquet);
    }
    if paths.len() == 1 {
        let path = paths.into_iter().next().expect("one path");
        return if is_directory(&path) {
            Ok(DroppedSource::Folder(path))
        } else if is_parquet(&path) {
            Ok(DroppedSource::Files(vec![path]))
        } else {
            Err(SourceError::NotParquet)
        };
    }
    // Multi-path drop callbacks must stay independent of selection size. The
    // background open path performs exact existence and file validation.
    if !paths.iter().all(|path| is_parquet(path)) {
        return Err(SourceError::NotParquet);
    }
    if group_files {
        Ok(DroppedSource::FileDataset(paths))
    } else {
        Ok(DroppedSource::Files(paths))
    }
}

enum DatasetDrop {
    Folder(PathBuf),
    ExplicitFiles(Vec<PathBuf>),
}

fn publish_dataset_for_request(app: &tauri::AppHandle, dropped: DatasetDrop, request: u64) {
    let result = match dropped {
        DatasetDrop::Folder(path) => {
            open_dataset_descriptor_for_request(app, SourceDescriptor::Folder(path), request)
        }
        DatasetDrop::ExplicitFiles(paths) => open_explicit_files_for_request(app, paths, request),
    };
    publish_native_open_result(app, request, result, false);
}

fn is_parquet(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("parquet"))
}

fn publish(app: &tauri::AppHandle, activation: OpenedSourceActivation) {
    if let Ok(mut pending) = app.state::<PendingOpenedSource>().0.lock() {
        pending.push_back(activation);
    }
    let _ = app.emit(OPENED_SOURCE_AVAILABLE_EVENT, ());
}

#[cfg(not(target_os = "macos"))]
pub fn open_from_args<I>(app: &tauri::AppHandle, args: I, cwd: &Path)
where
    I: IntoIterator<Item = OsString>,
{
    if let Some(path) = path_from_args(args, cwd) {
        open_path(app, path);
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn path_from_args<I>(args: I, cwd: &Path) -> Option<PathBuf>
where
    I: IntoIterator<Item = OsString>,
{
    let raw_path = args
        .into_iter()
        .skip(1)
        .find(|argument| !argument.to_string_lossy().starts_with('-'))?;
    let raw_path = PathBuf::from(raw_path);
    let path = if raw_path.is_absolute() {
        raw_path
    } else {
        cwd.join(raw_path)
    };
    Some(path)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{Arc, mpsc},
        time::Duration,
    };

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn parses_an_existing_parquet_argument() {
        let directory = tempdir().expect("temporary directory");
        let source = directory.path().join("people.parquet");
        fs::write(&source, b"PAR1PAR1").expect("temporary source");

        assert_eq!(
            path_from_args(
                [OsString::from("viewda"), source.clone().into_os_string()],
                directory.path()
            ),
            Some(source)
        );
    }

    #[test]
    fn parses_an_absolute_folder_argument() {
        let directory = tempdir().expect("temporary directory");

        assert_eq!(
            path_from_args(
                [
                    OsString::from("viewda"),
                    directory.path().as_os_str().to_owned(),
                ],
                Path::new("/unused")
            ),
            Some(directory.path().to_path_buf())
        );
    }

    #[test]
    fn resolves_a_relative_folder_argument_before_classification() {
        let directory = tempdir().expect("temporary directory");
        let source = directory.path().join("dataset");
        fs::create_dir(&source).expect("dataset directory");

        assert_eq!(
            path_from_args(
                [OsString::from("viewda"), OsString::from("dataset")],
                directory.path()
            ),
            Some(source)
        );
    }

    #[test]
    fn dispatches_existing_directories_without_an_application_handle() {
        let directory = tempdir().expect("temporary directory");
        let file = directory.path().join("part.parquet");
        fs::write(&file, b"PAR1PAR1").expect("temporary source");

        assert_eq!(
            classify_open_path(directory.path().to_path_buf()),
            Ok(OpenPathSource::Folder(directory.path().to_path_buf()))
        );
        assert_eq!(
            classify_open_path(file.clone()),
            Ok(OpenPathSource::File(file))
        );
    }

    #[test]
    fn native_folder_dispatch_returns_before_blocked_io_and_discards_a_stale_result() {
        let directory = tempdir().expect("temporary directory");
        let opened_source = Arc::new(OpenedSource::default());
        let stale_request = opened_source.begin_source_open().expect("first activation");
        let (entered, entered_rx) = mpsc::sync_channel(0);
        let (release, release_rx) = mpsc::sync_channel(0);
        let (finished, finished_rx) = mpsc::sync_channel(0);
        let worker_source = Arc::clone(&opened_source);
        let folder = directory.path().to_path_buf();

        dispatch_native_source_open(move || {
            entered.send(()).expect("worker entered");
            release_rx.recv().expect("release root I/O");
            let opened = crate::inspect_dataset_for_request(
                worker_source.as_ref(),
                SourceDescriptor::Folder(folder),
                None,
                None,
                SourceOpenIntent::Explicit,
                SourceOpenPublication {
                    request: stale_request,
                    client_attempt: None,
                    reload_generation: None,
                },
                true,
            )
            .map(|opened| opened.is_some());
            finished.send(opened).expect("worker result");
        });

        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("dispatch returns while the worker is blocked");
        assert!(finished_rx.try_recv().is_err());
        let _newer_request = opened_source.begin_source_open().expect("newer activation");
        release.send(()).expect("release worker");

        assert_eq!(
            finished_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("worker finishes"),
            Ok(false)
        );
        assert_eq!(opened_source.open_paths(), Ok(Vec::new()));
    }

    #[test]
    fn preserves_a_missing_parquet_path_for_the_engine_error() {
        let directory = tempdir().expect("temporary directory");
        let source = directory.path().join("missing.parquet");

        assert_eq!(
            path_from_args(
                [OsString::from("viewda"), OsString::from("missing.parquet")],
                directory.path()
            ),
            Some(source)
        );
    }

    #[test]
    fn rejects_a_non_parquet_argument_before_inspection() {
        let directory = tempdir().expect("temporary directory");

        assert_eq!(
            path_from_args(
                [OsString::from("viewda"), OsString::from("people.csv")],
                directory.path()
            ),
            Some(directory.path().join("people.csv"))
        );
        assert_eq!(
            classify_open_path(directory.path().join("people.csv")),
            Err(SourceError::NotParquet)
        );
    }

    #[test]
    fn ignores_wrapper_flags_without_showing_a_source_error() {
        let directory = tempdir().expect("temporary directory");

        assert_eq!(
            path_from_args(
                [OsString::from("viewda"), OsString::from("--help")],
                directory.path()
            ),
            None
        );
    }

    #[test]
    fn a_plain_drop_keeps_parquet_files_in_drop_order() {
        let dropped = classify_dropped_paths(
            vec![
                PathBuf::from("/data/first.parquet"),
                PathBuf::from("/data/second.PARQUET"),
            ],
            false,
        )
        .expect("plain Parquet drop");
        let DroppedSource::Files(paths) = dropped else {
            panic!("plain drop must keep separate files");
        };
        assert_eq!(
            paths,
            [
                PathBuf::from("/data/first.parquet"),
                PathBuf::from("/data/second.PARQUET"),
            ]
        );
    }

    #[test]
    fn multi_path_drop_classification_does_not_require_filesystem_entries() {
        let paths = vec![
            PathBuf::from("/does-not-exist/first.parquet"),
            PathBuf::from("/does-not-exist/second.PARQUET"),
        ];

        assert_eq!(
            classify_dropped_paths(paths.clone(), false),
            Ok(DroppedSource::Files(paths.clone()))
        );
        assert_eq!(
            classify_dropped_paths(paths.clone(), true),
            Ok(DroppedSource::FileDataset(paths))
        );
    }

    #[test]
    fn single_path_drop_dispatch_returns_before_metadata_finishes() {
        let path = PathBuf::from("/blocked/dataset");
        let (metadata_started, metadata_started_rx) = mpsc::sync_channel(0);
        let (release_metadata, release_metadata_rx) = mpsc::sync_channel(0);
        let (finished, finished_rx) = mpsc::sync_channel(0);

        dispatch_native_source_open(move || {
            let result = classify_dropped_paths_with(vec![path], false, |_| {
                metadata_started.send(()).expect("metadata started");
                release_metadata_rx.recv().expect("release metadata");
                true
            });
            finished.send(result).expect("classification result");
        });

        metadata_started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("drop callback returns before metadata finishes");
        assert!(finished_rx.try_recv().is_err());
        release_metadata.send(()).expect("release metadata");
        assert_eq!(
            finished_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("classification finishes"),
            Ok(DroppedSource::Folder(PathBuf::from("/blocked/dataset")))
        );
    }

    #[test]
    fn a_drop_without_parquet_files_reports_one_source_error() {
        assert_eq!(
            classify_dropped_paths(
                vec![
                    PathBuf::from("/data/notes.txt"),
                    PathBuf::from("/data/table.csv"),
                ],
                false,
            ),
            Err(SourceError::NotParquet)
        );
    }

    #[test]
    fn dataset_activation_keeps_the_path_free_dataset_error_shape() {
        let activation = OpenedSourceActivation {
            source: None,
            source_error: Some(
                viewda_data_engine::DatasetError::InvalidMember {
                    member: "partition/broken.parquet".to_owned(),
                }
                .into(),
            ),
        };

        assert_eq!(
            serde_json::to_value(activation).expect("activation JSON"),
            serde_json::json!({
                "source": null,
                "sourceError": {
                    "code": "invalidMember",
                    "member": "partition/broken.parquet",
                },
            })
        );
    }

    #[test]
    fn modifier_groups_only_multiple_parquet_files() {
        let dropped = classify_dropped_paths(
            vec![PathBuf::from("a.parquet"), PathBuf::from("b.PARQUET")],
            true,
        )
        .expect("grouped Parquet drop");
        assert_eq!(
            dropped,
            DroppedSource::FileDataset(vec![
                PathBuf::from("a.parquet"),
                PathBuf::from("b.PARQUET"),
            ])
        );
    }

    #[test]
    fn one_folder_drop_is_always_a_folder_dataset() {
        let directory = tempdir().expect("drop folder");
        let dropped = classify_dropped_paths(vec![directory.path().to_path_buf()], false)
            .expect("folder drop");
        assert!(matches!(dropped, DroppedSource::Folder(path) if path == directory.path()));
    }

    #[test]
    fn mixed_folder_and_file_drop_is_rejected() {
        let directory = tempdir().expect("drop folder");
        assert_eq!(
            classify_dropped_paths(
                vec![
                    directory.path().to_path_buf(),
                    PathBuf::from("part.parquet")
                ],
                true,
            ),
            Err(SourceError::NotParquet)
        );
    }

    #[test]
    fn drag_hint_defers_ambiguous_metadata_and_has_a_path_free_wire_shape() {
        let directory = tempdir().expect("drag fixtures");
        let folder = directory.path().join("dataset");
        let file = directory.path().join("part.parquet");
        let unsupported = directory.path().join("notes.csv");
        fs::create_dir(&folder).expect("drag folder");
        fs::write(&file, b"drag file").expect("drag file");
        fs::write(&unsupported, b"drag file").expect("unsupported drag file");

        assert_eq!(
            classify_drag_kind_without_io(std::slice::from_ref(&folder)),
            (SourceDragKind::Mixed, Some(folder.clone()))
        );
        assert_eq!(
            classify_drag_kind_without_io(std::slice::from_ref(&file)),
            (SourceDragKind::Files, None)
        );
        assert_eq!(
            classify_drag_kind_without_io(std::slice::from_ref(&unsupported)),
            (SourceDragKind::Mixed, Some(unsupported.clone()))
        );
        assert_eq!(
            classify_drag_kind_without_io(&[folder.clone(), file.clone()]),
            (SourceDragKind::Mixed, None)
        );
        assert_eq!(
            classify_drag_kind_without_io(&[
                directory.path().join("missing-1.parquet"),
                directory.path().join("missing-2.PARQUET"),
            ]),
            (SourceDragKind::Files, None)
        );
        assert_eq!(
            classify_drag_kind_without_io(&[
                directory.path().join("missing.parquet"),
                directory.path().join("notes.txt"),
            ]),
            (SourceDragKind::Mixed, None)
        );
        assert_eq!(
            serde_json::to_value(SourceDragPayload {
                state: SourceDragPhase::Enter,
                kind: SourceDragKind::Folder,
            })
            .expect("drag payload JSON"),
            serde_json::json!({ "state": "enter", "kind": "folder" })
        );
        assert!(
            !serde_json::to_string(&SourceDragPayload {
                state: SourceDragPhase::Drop,
                kind: SourceDragKind::Mixed,
            })
            .expect("path-free drag JSON")
            .contains(directory.path().to_string_lossy().as_ref())
        );
    }

    #[test]
    fn finds_a_parquet_path_after_wrapper_flags() {
        let directory = tempdir().expect("temporary directory");
        let source = directory.path().join("people.parquet");

        assert_eq!(
            path_from_args(
                [
                    OsString::from("viewda"),
                    OsString::from("--wrapper-flag"),
                    OsString::from("people.parquet")
                ],
                directory.path()
            ),
            Some(source)
        );
    }
}
