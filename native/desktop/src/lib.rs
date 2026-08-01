//! Tauri adapter for the Viewda desktop application.

mod recents;
mod updates;

use std::{path::PathBuf, sync::Mutex};

use recents::{RecentSource, RecentSourceError, RecentSourcesStore};
use serde::Serialize;
use tauri::{
    Emitter, Manager,
    menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder},
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use thiserror::Error;
use updates::{
    PendingUpdate, UpdateError, UpdateInfo, UpdateStateStore, check_for_update,
    check_for_update_with_state, discard_pending_update, get_update_settings,
    install_pending_update, open_releases_page, set_update_settings, take_post_update_state,
};
use viewda_data_engine::{
    EngineError, EngineStatus, SourceError, SourceSummary, engine_status, inspect_local_source,
};

const OPEN_SOURCE_MENU_ID: &str = "open-local-source";
const SETTINGS_MENU_ID: &str = "settings";
const CHECK_FOR_UPDATES_MENU_ID: &str = "check-for-updates";
const OPEN_SOURCE_REQUESTED_EVENT: &str = "open-source-requested";
const SETTINGS_REQUESTED_EVENT: &str = "settings-requested";
const UPDATE_AVAILABLE_EVENT: &str = "update-available";

#[derive(Default)]
struct OpenedSource {
    path: Mutex<Option<PathBuf>>,
    recents: RecentSourcesStore,
}

impl OpenedSource {
    fn current_path(&self) -> Result<Option<PathBuf>, OpenSourceError> {
        self.path
            .lock()
            .map(|path| path.clone())
            .map_err(|_| OpenSourceError::Storage)
    }
}

/// Stable failures exposed by every source-opening command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
enum OpenSourceError {
    #[error("The selected file no longer exists.")]
    NotFound,
    #[error("Viewda does not have permission to read the selected file.")]
    PermissionDenied,
    #[error("The selected file is not a Parquet file.")]
    NotParquet,
    #[error("The Parquet footer is damaged or incomplete.")]
    CorruptFooter,
    #[error("This source is not supported yet.")]
    Unsupported,
    #[error("The recent-source list could not be read or saved.")]
    Storage,
    #[error("The requested recent source does not exist.")]
    UnknownRecent,
}

impl From<SourceError> for OpenSourceError {
    fn from(error: SourceError) -> Self {
        match error {
            SourceError::NotFound => Self::NotFound,
            SourceError::PermissionDenied => Self::PermissionDenied,
            SourceError::NotParquet => Self::NotParquet,
            SourceError::CorruptFooter => Self::CorruptFooter,
            SourceError::Unsupported => Self::Unsupported,
        }
    }
}

impl From<RecentSourceError> for OpenSourceError {
    fn from(error: RecentSourceError) -> Self {
        match error {
            RecentSourceError::Storage => Self::Storage,
            RecentSourceError::UnknownRecent => Self::UnknownRecent,
        }
    }
}

impl OpenSourceError {
    fn source_error(self) -> SourceError {
        match self {
            Self::NotFound => SourceError::NotFound,
            Self::PermissionDenied => SourceError::PermissionDenied,
            Self::NotParquet => SourceError::NotParquet,
            Self::CorruptFooter => SourceError::CorruptFooter,
            Self::Unsupported | Self::Storage | Self::UnknownRecent => SourceError::Unsupported,
        }
    }
}

/// Reports whether the shell-independent engine is linked and responsive.
#[tauri::command]
fn get_engine_status() -> Result<EngineStatus, EngineError> {
    engine_status()
}

/// Owns the native file dialog and passes the selected path directly to data-engine.
///
/// The dialog lives on the Rust side on purpose: the plugin's JS `open()`
/// API would hand the raw path to the webview, and the UI must never see
/// paths or touch files. Cancellation returns `Ok(None)` — it is a normal
/// outcome, not an error.
#[tauri::command]
async fn open_local_source(
    app: tauri::AppHandle,
) -> Result<Option<SourceSummary>, OpenSourceError> {
    // blocking_pick_file would stall the async runtime thread.
    let inspected = tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .add_filter("Parquet", &["parquet"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|_| OpenSourceError::Unsupported)?;

        inspect_selected_source(&app, path).map(Some)
    })
    .await
    .map_err(|_| OpenSourceError::Unsupported)??;

    Ok(inspected.map(|(_, summary)| summary))
}

fn inspect_selected_source(
    app: &tauri::AppHandle,
    path: PathBuf,
) -> Result<(PathBuf, SourceSummary), OpenSourceError> {
    let opened_source = app.state::<OpenedSource>();
    let recent_sources_path = recents::state_path(app).ok();
    inspect_selected_source_at_path(recent_sources_path.as_deref(), opened_source.inner(), path)
}

fn inspect_selected_source_at_path(
    recent_sources_path: Option<&std::path::Path>,
    opened_source: &OpenedSource,
    path: PathBuf,
) -> Result<(PathBuf, SourceSummary), OpenSourceError> {
    let summary = inspect_local_source(&path).map_err(OpenSourceError::from)?;
    remember_inspected_source(recent_sources_path, opened_source, path, summary)
}

fn remember_inspected_source(
    recent_sources_path: Option<&std::path::Path>,
    opened_source: &OpenedSource,
    path: PathBuf,
    summary: SourceSummary,
) -> Result<(PathBuf, SourceSummary), OpenSourceError> {
    let canonical_path = std::fs::canonicalize(&path).unwrap_or(path);
    if let Some(recent_sources_path) = recent_sources_path {
        // Opening a source is the primary operation; history is best-effort.
        let _ = opened_source
            .recents
            .record_path(recent_sources_path, &canonical_path);
    }
    *opened_source
        .path
        .lock()
        .map_err(|_| OpenSourceError::Storage)? = Some(canonical_path.clone());
    Ok((canonical_path, summary))
}

/// Returns existing recent sources without exposing their paths.
#[tauri::command]
async fn get_recent_sources(app: tauri::AppHandle) -> Result<Vec<RecentSource>, RecentSourceError> {
    tauri::async_runtime::spawn_blocking(move || {
        let opened_source = app.state::<OpenedSource>();
        opened_source.recents.list(&app)
    })
    .await
    .map_err(|_| RecentSourceError::Storage)?
}

/// Reopens a Rust-owned recent source selected by its opaque identifier.
#[tauri::command]
async fn open_recent_source(
    app: tauri::AppHandle,
    id: String,
) -> Result<SourceSummary, OpenSourceError> {
    let result =
        tauri::async_runtime::spawn_blocking(move || open_recent_source_with_app(&app, &id))
            .await
            .map_err(|_| OpenSourceError::Unsupported)?;

    result.map(|(_, summary)| summary)
}

fn open_recent_source_with_app(
    app: &tauri::AppHandle,
    id: &str,
) -> Result<(PathBuf, SourceSummary), OpenSourceError> {
    let opened_source = app.state::<OpenedSource>();
    open_recent_source_at_path(&recents::state_path(app)?, opened_source.inner(), id)
}

fn open_recent_source_at_path(
    recent_sources_path: &std::path::Path,
    opened_source: &OpenedSource,
    id: &str,
) -> Result<(PathBuf, SourceSummary), OpenSourceError> {
    let path = opened_source
        .recents
        .path_for_id_path(recent_sources_path, id)?;
    let result = inspect_selected_source_at_path(Some(recent_sources_path), opened_source, path);
    if result == Err(OpenSourceError::NotFound) {
        // Preserve the existing source error even if cleaning a damaged store fails.
        let _ = opened_source.recents.remove_path(recent_sources_path, id);
    }
    result
}

fn check_for_updates_from_menu(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = check_for_update_with_state(
            &app,
            app.state::<PendingUpdate>().inner(),
            app.state::<UpdateStateStore>().inner(),
            false,
            false,
        )
        .await;

        if let Ok(Some(update)) = &result {
            // The receiver can already be gone while the app is shutting down.
            let _ = app.emit(UPDATE_AVAILABLE_EVENT, update.clone());
            return;
        }

        if let Some((message, kind)) = manual_update_check_dialog(&result) {
            app.dialog()
                .message(message)
                .title("Viewda")
                .kind(kind)
                .show(|_| {});
        }
    });
}

fn manual_update_check_dialog(
    result: &Result<Option<UpdateInfo>, UpdateError>,
) -> Option<(&'static str, MessageDialogKind)> {
    match result {
        Ok(Some(_)) => None,
        Ok(None) => Some(("Viewda is up to date", MessageDialogKind::Info)),
        #[cfg(target_os = "linux")]
        Err(UpdateError::ManualInstall) => Some((
            "This package uses manual updates. Install the AppImage to update inside Viewda.",
            MessageDialogKind::Info,
        )),
        Err(_) => Some((
            "Could not check for updates. Try again later.",
            MessageDialogKind::Error,
        )),
    }
}

/// Starts the Viewda desktop application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(OpenedSource::default())
        .manage(PendingUpdate::default())
        .manage(UpdateStateStore::default())
        .menu(|app| {
            // Built on top of the default menu, never a replacement: on
            // macOS the first submenu always becomes the application menu,
            // so a from-scratch menubar would silently drop Quit, Edit
            // (clipboard) and Window.
            let menu = Menu::default(app)?;
            let open_source = MenuItemBuilder::with_id(OPEN_SOURCE_MENU_ID, "Open File…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let settings = MenuItemBuilder::with_id(SETTINGS_MENU_ID, "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let check_for_updates =
                MenuItemBuilder::with_id(CHECK_FOR_UPDATES_MENU_ID, "Check for Updates…")
                    .build(app)?;
            // Lookup by title assumes Tauri's default menu is English;
            // revisit if menus are ever localized.
            let existing_file_menu = menu.items()?.into_iter().find_map(|item| match item {
                MenuItemKind::Submenu(submenu)
                    if submenu.text().is_ok_and(|text| text == "File") =>
                {
                    Some(submenu)
                }
                _ => None,
            });

            if let Some(file_menu) = existing_file_menu {
                let open_separator = PredefinedMenuItem::separator(app)?;
                #[cfg(target_os = "macos")]
                file_menu.prepend_items(&[&open_source, &open_separator])?;
                #[cfg(not(target_os = "macos"))]
                {
                    let update_separator = PredefinedMenuItem::separator(app)?;
                    file_menu.prepend_items(&[
                        &open_source,
                        &open_separator,
                        &settings,
                        &check_for_updates,
                        &update_separator,
                    ])?;
                }
            } else {
                let file_menu = SubmenuBuilder::new(app, "File")
                    .item(&open_source)
                    .separator();
                #[cfg(not(target_os = "macos"))]
                let file_menu = file_menu
                    .item(&settings)
                    .item(&check_for_updates)
                    .separator();
                let file_menu = file_menu.close_window().quit().build()?;
                menu.prepend(&file_menu)?;
            }

            #[cfg(target_os = "macos")]
            if let Some(app_menu) = menu.items()?.into_iter().find_map(|item| match item {
                MenuItemKind::Submenu(submenu) => Some(submenu),
                _ => None,
            }) {
                let separator = PredefinedMenuItem::separator(app)?;
                // The default application menu starts with About + separator.
                app_menu.insert_items(&[&settings, &check_for_updates, &separator], 2)?;
            }

            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id() == OPEN_SOURCE_MENU_ID {
                // The frontend receiver can already be gone while the app is shutting down.
                let _ = app.emit(OPEN_SOURCE_REQUESTED_EVENT, ());
            } else if event.id() == SETTINGS_MENU_ID {
                let _ = app.emit(SETTINGS_REQUESTED_EVENT, ());
            } else if event.id() == CHECK_FOR_UPDATES_MENU_ID {
                check_for_updates_from_menu(app);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_engine_status,
            open_local_source,
            get_recent_sources,
            open_recent_source,
            get_update_settings,
            set_update_settings,
            check_for_update,
            discard_pending_update,
            install_pending_update,
            take_post_update_state,
            open_releases_page
        ])
        .run(tauri::generate_context!())
        .expect("Viewda desktop runtime failed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_is_owned_by_the_data_engine() {
        let status = get_engine_status().expect("packaged query engine should start");

        assert_eq!(status.name, "Viewda data engine");
        assert_eq!(status.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn selected_paths_cross_directly_into_the_data_engine() {
        let missing = PathBuf::from("/viewda-test/source-that-does-not-exist.parquet");
        let directory = tempfile::tempdir().expect("temporary directory");
        let opened_source = OpenedSource::default();

        assert_eq!(
            inspect_selected_source_at_path(
                Some(&directory.path().join("recents.json")),
                &opened_source,
                missing,
            ),
            Err(OpenSourceError::NotFound)
        );
    }

    #[test]
    fn opening_an_unknown_recent_id_returns_a_typed_error() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let opened_source = OpenedSource::default();

        assert_eq!(
            open_recent_source_at_path(
                &directory.path().join("recents.json"),
                &opened_source,
                "recent-that-does-not-exist",
            ),
            Err(OpenSourceError::UnknownRecent)
        );
    }

    #[test]
    fn history_write_failures_do_not_override_a_successful_inspection() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source_path = directory.path().join("source.parquet");
        std::fs::write(&source_path, b"already inspected by the caller").expect("source fixture");
        let blocked_parent = directory.path().join("not-a-directory");
        std::fs::write(&blocked_parent, b"file blocks recents.json").expect("blocked store");
        let opened_source = OpenedSource::default();
        let summary = SourceSummary {
            display_name: "source.parquet".to_owned(),
            size_bytes: 31,
            row_count: 1,
            row_group_count: 1,
            schema: Vec::new(),
        };

        let opened = remember_inspected_source(
            Some(&blocked_parent.join("recents.json")),
            &opened_source,
            source_path.clone(),
            summary.clone(),
        )
        .expect("history storage is best-effort");

        assert_eq!(
            opened.0,
            std::fs::canonicalize(source_path).expect("source path")
        );
        assert_eq!(opened.1, summary);
        assert_eq!(
            opened_source.current_path().expect("opened-source state"),
            Some(opened.0)
        );
    }

    #[test]
    fn opening_a_recent_source_removes_it_when_the_file_disappeared() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let recent_sources_path = directory.path().join("recents.json");
        let source_path = directory.path().join("gone.parquet");
        let opened_source = OpenedSource::default();
        std::fs::write(&source_path, b"not inspected before removal").expect("source fixture");
        opened_source
            .recents
            .record_path(&recent_sources_path, &source_path)
            .expect("recent source");
        std::fs::remove_file(source_path).expect("remove source fixture");

        assert_eq!(
            open_recent_source_at_path(&recent_sources_path, &opened_source, "recent-1"),
            Err(OpenSourceError::NotFound)
        );
        assert_eq!(
            opened_source
                .recents
                .path_for_id_path(&recent_sources_path, "recent-1"),
            Err(RecentSourceError::UnknownRecent)
        );
    }

    #[test]
    fn manual_update_check_uses_native_messages_for_terminal_results() {
        assert_eq!(
            manual_update_check_dialog(&Ok(Some(UpdateInfo {
                version: "0.0.3".into(),
                current_version: "0.0.2".into(),
                is_downgrade: false,
            }))),
            None
        );
        assert_eq!(
            manual_update_check_dialog(&Ok(None)),
            Some(("Viewda is up to date", MessageDialogKind::Info))
        );
        assert_eq!(
            manual_update_check_dialog(&Err(UpdateError::Unavailable)),
            Some((
                "Could not check for updates. Try again later.",
                MessageDialogKind::Error
            ))
        );

        #[cfg(target_os = "linux")]
        assert_eq!(
            manual_update_check_dialog(&Err(UpdateError::ManualInstall)),
            Some((
                "This package uses manual updates. Install the AppImage to update inside Viewda.",
                MessageDialogKind::Info
            ))
        );
    }
}
