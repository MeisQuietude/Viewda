//! Native file-open activation without exposing filesystem paths to the webview.

use std::{path::PathBuf, sync::Mutex};

#[cfg(any(not(target_os = "macos"), test))]
use std::{ffi::OsString, path::Path};

use serde::Serialize;
use tauri::{Emitter, Manager};
use viewda_data_engine::SourceError;

use crate::{
    OpenSourceError, OpenedSource, OpenedSourceInfo, SourceOpenIntent, inspect_selected_source,
};

pub const OPENED_SOURCE_AVAILABLE_EVENT: &str = "opened-source-available";

/// One native activation result waiting for the webview to consume it.
#[derive(Default)]
pub struct PendingOpenedSource(Mutex<Option<OpenedSourceActivation>>);

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
    pending.0.lock().ok()?.take()
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

    if let Ok(mut pending) = app.state::<PendingOpenedSource>().0.lock() {
        *pending = Some(activation);
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
        Err(error) => {
            let _ = app.state::<OpenedSource>().mark_explicit();
            if let Ok(mut pending) = app.state::<PendingOpenedSource>().0.lock() {
                *pending = Some(OpenedSourceActivation {
                    source: None,
                    source_error: Some(error),
                });
            }
            let _ = app.emit(OPENED_SOURCE_AVAILABLE_EVENT, ());
        }
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
    let is_parquet = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("parquet"));
    if !is_parquet {
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
