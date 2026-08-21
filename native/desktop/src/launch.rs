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
    DatasetDropModifier, OpenSourceError, OpenedSource, OpenedSourceInfo, SourceDescriptor,
    SourceOpenIntent, inspect_selected_source, open_dataset_descriptor_from_native,
};

pub const OPENED_SOURCE_AVAILABLE_EVENT: &str = "opened-source-available";

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

pub fn open_path(app: &tauri::AppHandle, path: PathBuf) {
    let _ = app.state::<OpenedSource>().mark_explicit();
    let inspected = inspect_selected_source(app, path, SourceOpenIntent::Explicit)
        .and_then(crate::require_explicit_source);
    let activation = match inspected {
        Ok((_, source)) => OpenedSourceActivation {
            source: Some(source),
            source_error: None,
        },
        Err(OpenSourceError::Source(error)) => OpenedSourceActivation {
            source: None,
            source_error: Some(error.into()),
        },
        Err(OpenSourceError::Recent(_)) => OpenedSourceActivation {
            source: None,
            source_error: Some(SourceError::Unsupported.into()),
        },
        Err(error @ OpenSourceError::Dataset(_)) => OpenedSourceActivation {
            source: None,
            source_error: Some(error),
        },
    };

    publish(app, activation);
    let _ = crate::recent_sources_changed(app);
}

pub fn open_recent(app: &tauri::AppHandle, id: &str) {
    let activation = match crate::open_recent_source_with_app(app, id) {
        Ok((_, source)) => OpenedSourceActivation {
            source: Some(source),
            source_error: None,
        },
        Err(OpenSourceError::Source(error)) => OpenedSourceActivation {
            source: None,
            source_error: Some(error.into()),
        },
        Err(OpenSourceError::Recent(_)) => OpenedSourceActivation {
            source: None,
            source_error: Some(SourceError::Unsupported.into()),
        },
        Err(error @ OpenSourceError::Dataset(_)) => OpenedSourceActivation {
            source: None,
            source_error: Some(error),
        },
    };
    publish(app, activation);
    let _ = crate::recent_sources_changed(app);
}

/// Opens every Parquet file of one drag and drop without exposing the paths.
///
/// Files open in drop order, so the last one dropped becomes the active source.
pub fn open_dropped_paths(app: &tauri::AppHandle, paths: Vec<PathBuf>) {
    let group_files = app
        .state::<DatasetDropModifier>()
        .0
        .swap(false, std::sync::atomic::Ordering::AcqRel);
    match classify_dropped_paths(paths, group_files) {
        Ok(DroppedSource::Folder(path)) => publish_dataset(app, SourceDescriptor::Folder(path)),
        Ok(DroppedSource::FileDataset(paths)) => {
            publish_dataset(app, SourceDescriptor::explicit_files(paths));
        }
        Ok(DroppedSource::Files(paths)) => {
            for path in paths {
                open_path(app, path);
            }
        }
        Err(error) => report_source_error(app, error),
    }
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
    if paths.is_empty() {
        return Err(SourceError::NotParquet);
    }
    if paths.len() == 1 && paths[0].is_dir() {
        return Ok(DroppedSource::Folder(
            paths.into_iter().next().expect("one path"),
        ));
    }
    if paths.iter().any(|path| path.is_dir() || !is_parquet(path)) {
        return Err(SourceError::NotParquet);
    }
    if group_files && paths.len() > 1 {
        Ok(DroppedSource::FileDataset(paths))
    } else {
        Ok(DroppedSource::Files(paths))
    }
}

fn publish_dataset(app: &tauri::AppHandle, descriptor: SourceDescriptor) {
    let activation = match open_dataset_descriptor_from_native(app, descriptor) {
        Ok(source) => OpenedSourceActivation {
            source: Some(source),
            source_error: None,
        },
        Err(OpenSourceError::Recent(_)) => OpenedSourceActivation {
            source: None,
            source_error: Some(SourceError::Unsupported.into()),
        },
        Err(error) => OpenedSourceActivation {
            source: None,
            source_error: Some(error),
        },
    };
    publish(app, activation);
}

fn is_parquet(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("parquet"))
}

fn report_source_error(app: &tauri::AppHandle, error: SourceError) {
    let _ = app.state::<OpenedSource>().mark_explicit();
    publish(
        app,
        OpenedSourceActivation {
            source: None,
            source_error: Some(error.into()),
        },
    );
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
    match parquet_path_from_args(args, cwd) {
        Ok(Some(path)) => open_path(app, path),
        Ok(None) => {}
        Err(error) => report_source_error(app, error),
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn parquet_path_from_args<I>(args: I, cwd: &Path) -> Result<Option<PathBuf>, SourceError>
where
    I: IntoIterator<Item = OsString>,
{
    let Some(raw_path) = args
        .into_iter()
        .skip(1)
        .find(|argument| !argument.to_string_lossy().starts_with('-'))
    else {
        return Ok(None);
    };
    let path = PathBuf::from(raw_path);
    if !is_parquet(&path) {
        return Err(SourceError::NotParquet);
    }

    Ok(Some(if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn parses_an_existing_parquet_argument() {
        let directory = tempdir().expect("temporary directory");
        let source = directory.path().join("people.parquet");
        fs::write(&source, b"PAR1PAR1").expect("temporary source");

        assert_eq!(
            parquet_path_from_args(
                [OsString::from("viewda"), source.clone().into_os_string()],
                directory.path()
            ),
            Ok(Some(source))
        );
    }

    #[test]
    fn preserves_a_missing_parquet_path_for_the_engine_error() {
        let directory = tempdir().expect("temporary directory");
        let source = directory.path().join("missing.parquet");

        assert_eq!(
            parquet_path_from_args(
                [OsString::from("viewda"), OsString::from("missing.parquet")],
                directory.path()
            ),
            Ok(Some(source))
        );
    }

    #[test]
    fn rejects_a_non_parquet_argument_before_inspection() {
        let directory = tempdir().expect("temporary directory");

        assert_eq!(
            parquet_path_from_args(
                [OsString::from("viewda"), OsString::from("people.csv")],
                directory.path()
            ),
            Err(SourceError::NotParquet)
        );
    }

    #[test]
    fn ignores_wrapper_flags_without_showing_a_source_error() {
        let directory = tempdir().expect("temporary directory");

        assert_eq!(
            parquet_path_from_args(
                [OsString::from("viewda"), OsString::from("--help")],
                directory.path()
            ),
            Ok(None)
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
            vec![PathBuf::from("a.parquet"), PathBuf::from("b.parquet")],
            true,
        )
        .expect("grouped Parquet drop");
        assert!(matches!(dropped, DroppedSource::FileDataset(paths) if paths.len() == 2));
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
    fn finds_a_parquet_path_after_wrapper_flags() {
        let directory = tempdir().expect("temporary directory");
        let source = directory.path().join("people.parquet");

        assert_eq!(
            parquet_path_from_args(
                [
                    OsString::from("viewda"),
                    OsString::from("--wrapper-flag"),
                    OsString::from("people.parquet")
                ],
                directory.path()
            ),
            Ok(Some(source))
        );
    }
}
