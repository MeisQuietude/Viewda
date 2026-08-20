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
    OpenSourceError, OpenedSource, OpenedSourceInfo, SourceOpenIntent, inspect_selected_source,
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
    source_error: Option<SourceError>,
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
            source_error: Some(error),
        },
        Err(OpenSourceError::Recent(_)) => OpenedSourceActivation {
            source: None,
            source_error: Some(SourceError::Unsupported),
        },
    };

    publish(app, activation);
}

/// Opens every Parquet file of one drag and drop without exposing the paths.
///
/// Files open in drop order, so the last one dropped becomes the active source.
pub fn open_dropped_paths(app: &tauri::AppHandle, paths: Vec<PathBuf>) {
    match dropped_parquet_paths(paths) {
        Ok(paths) => {
            for path in paths {
                open_path(app, path);
            }
        }
        Err(error) => report_source_error(app, error),
    }
}

fn dropped_parquet_paths(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, SourceError> {
    let paths: Vec<PathBuf> = paths.into_iter().filter(|path| is_parquet(path)).collect();
    if paths.is_empty() {
        return Err(SourceError::NotParquet);
    }
    Ok(paths)
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
            source_error: Some(error),
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
    fn a_drop_opens_its_parquet_files_in_drop_order() {
        assert_eq!(
            dropped_parquet_paths(vec![
                PathBuf::from("/data/notes.txt"),
                PathBuf::from("/data/first.parquet"),
                PathBuf::from("/data/second.PARQUET"),
            ]),
            Ok(vec![
                PathBuf::from("/data/first.parquet"),
                PathBuf::from("/data/second.PARQUET"),
            ])
        );
    }

    #[test]
    fn a_drop_without_parquet_files_reports_one_source_error() {
        assert_eq!(
            dropped_parquet_paths(vec![
                PathBuf::from("/data/notes.txt"),
                PathBuf::from("/data/table.csv"),
            ]),
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
