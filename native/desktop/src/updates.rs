//! Signed application updates, release channels, and one-shot workflow restore.

use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, ipc::Channel};
use tauri_plugin_updater::{Update, UpdaterExt};
use thiserror::Error;
use viewda_data_engine::SourceError;

use crate::{
    OpenSourceError, OpenedSource, OpenedSourceInfo, SourceOpenIntent, inspect_selected_source,
    theme::ThemePreference, view_settings::DataViewSettings,
};

const UPDATE_STATE_FILE: &str = "updates.json";
const STABLE_ENDPOINT: &str = "https://meisquietude.github.io/Viewda/updates/stable.json";
const LATEST_ENDPOINT: &str = "https://meisquietude.github.io/Viewda/updates/latest.json";
const AUTOMATIC_CHECK_INTERVAL_SECONDS: u64 = 24 * 60 * 60;

/// A release stream selected by the user.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateChannel {
    Stable,
    Latest,
}

/// User-controlled update behavior.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    pub channel: UpdateChannel,
    pub automatic_checks: bool,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            channel: default_channel(env!("CARGO_PKG_VERSION")),
            automatic_checks: true,
        }
    }
}

/// A signed release that can be installed from the active channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub is_downgrade: bool,
}

/// State returned once after a successful update restarted the application.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostUpdateState {
    pub version: String,
    /// Restored sources in most-recently-used order, the active one first.
    pub sources: Vec<OpenedSourceInfo>,
    /// Reported only when nothing could be restored: a window with sources open
    /// has no surface for a restore failure.
    pub source_error: Option<SourceError>,
}

/// Download progress reported while installing a checked update.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateProgress {
    pub percent: u8,
}

/// Stable update failures exposed to the desktop UI.
#[derive(Debug, Clone, Copy, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum UpdateError {
    #[error("The update service is unavailable.")]
    Unavailable,
    #[error("The update state could not be read or saved.")]
    Storage,
    #[error("No checked update is ready to install.")]
    NoPendingUpdate,
    #[cfg(target_os = "linux")]
    #[error("This package must be updated by its package manager.")]
    ManualInstall,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredUpdateState {
    #[serde(default)]
    settings: UpdateSettings,
    #[serde(default)]
    theme_preference: ThemePreference,
    #[serde(default)]
    data_view_settings: DataViewSettings,
    #[serde(default)]
    last_automatic_check_unix_seconds: Option<u64>,
    #[serde(default)]
    pending_restart: Option<PendingRestart>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingRestart {
    version: String,
    /// Open sources in most-recently-used order, the active one first.
    #[serde(default)]
    source_paths: Vec<PathBuf>,
    /// The active source, repeated for releases that restore a single source.
    ///
    /// Installing a downgrade restarts into such a release, and it fails to read
    /// the whole state file when this field is missing.
    #[serde(default)]
    source_path: Option<PathBuf>,
}

impl PendingRestart {
    fn new(version: String, source_paths: Vec<PathBuf>) -> Self {
        Self {
            source_path: source_paths.first().cloned(),
            source_paths,
            version,
        }
    }

    /// Sources to reopen, most recently used first, from either marker shape.
    fn restored_paths(self) -> Vec<PathBuf> {
        if self.source_paths.is_empty() {
            self.source_path.into_iter().collect()
        } else {
            self.source_paths
        }
    }
}

/// Keeps a checked, signature-verified release on the Rust side.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

/// Serializes persisted application-state mutations within this process.
///
/// Commands must not write a snapshot read before another command changed the
/// same file. Keeping the lock around each read-modify-write preserves settings,
/// throttle timestamps, and restart markers as independent fields.
#[derive(Default)]
pub struct UpdateStateStore(Mutex<()>);

#[derive(Default)]
struct UpdateProgressTracker {
    downloaded_bytes: u64,
    last_percent: Option<u8>,
}

impl UpdateProgressTracker {
    fn record_chunk(
        &mut self,
        chunk_length: usize,
        content_length: Option<u64>,
    ) -> Option<UpdateProgress> {
        self.downloaded_bytes = self.downloaded_bytes.saturating_add(chunk_length as u64);
        let content_length = content_length.filter(|length| *length > 0)?;
        let percent = self
            .downloaded_bytes
            .saturating_mul(100)
            .checked_div(content_length)
            .unwrap_or_default()
            .min(100) as u8;
        self.report(percent)
    }

    fn finish(&mut self) -> Option<UpdateProgress> {
        self.report(100)
    }

    fn report(&mut self, percent: u8) -> Option<UpdateProgress> {
        if self.last_percent == Some(percent) {
            return None;
        }
        self.last_percent = Some(percent);
        Some(UpdateProgress { percent })
    }
}

impl UpdateStateStore {
    fn read(&self, app: &AppHandle) -> Result<StoredUpdateState, UpdateError> {
        self.read_path(&state_path(app)?)
    }

    fn mutate<T>(
        &self,
        app: &AppHandle,
        mutation: impl FnOnce(&mut StoredUpdateState) -> T,
    ) -> Result<T, UpdateError> {
        self.mutate_path(&state_path(app)?, mutation)
    }

    pub(crate) fn theme_preference(&self, app: &AppHandle) -> Result<ThemePreference, UpdateError> {
        Ok(self.read(app)?.theme_preference)
    }

    pub(crate) fn set_theme_preference(
        &self,
        app: &AppHandle,
        preference: ThemePreference,
    ) -> Result<(), UpdateError> {
        self.mutate(app, |stored| stored.theme_preference = preference)
    }

    pub(crate) fn data_view_settings(
        &self,
        app: &AppHandle,
    ) -> Result<DataViewSettings, UpdateError> {
        Ok(self.read(app)?.data_view_settings)
    }

    pub(crate) fn set_data_view_settings(
        &self,
        app: &AppHandle,
        settings: DataViewSettings,
    ) -> Result<(), UpdateError> {
        self.mutate(app, |stored| stored.data_view_settings = settings)
    }

    fn read_path(&self, path: &Path) -> Result<StoredUpdateState, UpdateError> {
        let _guard = self.0.lock().map_err(|_| UpdateError::Storage)?;
        read_state_file(path)
    }

    fn mutate_path<T>(
        &self,
        path: &Path,
        mutation: impl FnOnce(&mut StoredUpdateState) -> T,
    ) -> Result<T, UpdateError> {
        let _guard = self.0.lock().map_err(|_| UpdateError::Storage)?;
        let mut stored = read_state_file(path)?;
        let result = mutation(&mut stored);
        write_state_file(path, &stored)?;
        Ok(result)
    }
}

/// Reads the persisted release channel and automatic-check preference.
#[tauri::command]
pub fn get_update_settings(
    app: AppHandle,
    store: State<'_, UpdateStateStore>,
) -> Result<UpdateSettings, UpdateError> {
    Ok(store.read(&app)?.settings)
}

/// Persists user-controlled update behavior.
#[tauri::command]
pub fn set_update_settings(
    app: AppHandle,
    store: State<'_, UpdateStateStore>,
    settings: UpdateSettings,
) -> Result<(), UpdateError> {
    store.mutate(&app, |stored| stored.settings = settings)
}

/// Checks the selected channel without exposing updater network access to JS.
///
/// `allow_downgrade` is only used immediately after switching from latest to
/// stable. It lets the UI ask whether to install the older stable release or
/// wait; normal checks continue to accept newer versions only.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    store: State<'_, UpdateStateStore>,
    allow_downgrade: bool,
    automatic_check: bool,
) -> Result<Option<UpdateInfo>, UpdateError> {
    check_for_update_with_state(&app, &pending, &store, allow_downgrade, automatic_check).await
}

pub(crate) async fn check_for_update_with_state(
    app: &AppHandle,
    pending: &PendingUpdate,
    store: &UpdateStateStore,
    allow_downgrade: bool,
    automatic_check: bool,
) -> Result<Option<UpdateInfo>, UpdateError> {
    require_self_updating_package()?;
    let settings = if automatic_check {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| UpdateError::Storage)?
            .as_secs();
        let settings = store.mutate(app, |stored| {
            if !automatic_check_is_due(stored.last_automatic_check_unix_seconds, now) {
                return None;
            }

            // Persist the attempt before network access. A temporarily
            // unavailable endpoint must not turn every application launch
            // into another request; the user can always retry explicitly
            // with Check now.
            stored.last_automatic_check_unix_seconds = Some(now);
            Some(stored.settings)
        })?;
        let Some(settings) = settings else {
            return Ok(None);
        };
        settings
    } else {
        store.read(app)?.settings
    };
    let endpoint = match settings.channel {
        UpdateChannel::Stable => STABLE_ENDPOINT,
        UpdateChannel::Latest => LATEST_ENDPOINT,
    };
    let endpoint = endpoint.parse().map_err(|_| UpdateError::Unavailable)?;

    let builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|_| UpdateError::Unavailable)?;
    let updater = if allow_downgrade {
        builder.version_comparator(|current, release| release.version != current)
    } else {
        builder
    }
    .build()
    .map_err(|_| UpdateError::Unavailable)?;
    let update = updater
        .check()
        .await
        .map_err(|_| UpdateError::Unavailable)?;
    let info = update
        .as_ref()
        .map(update_info)
        .transpose()
        .map_err(|_| UpdateError::Unavailable)?;
    *pending.0.lock().map_err(|_| UpdateError::Unavailable)? = update;

    Ok(info)
}

/// Discards a checked release, for example when a stable downgrade is declined.
#[tauri::command]
pub fn discard_pending_update(pending: State<'_, PendingUpdate>) -> Result<(), UpdateError> {
    *pending.0.lock().map_err(|_| UpdateError::Unavailable)? = None;
    Ok(())
}

/// Installs the checked update after the caller has approved shutdown.
///
/// The pending restart marker is written before installation because the
/// Windows updater exits the process as part of the install. The marker keeps
/// the currently open sources entirely in Rust and lets the new process restore
/// them without ever handing their paths to the webview.
pub(crate) async fn install_pending_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    store: State<'_, UpdateStateStore>,
    opened_source: State<'_, OpenedSource>,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), UpdateError> {
    require_self_updating_package()?;
    let update = pending
        .0
        .lock()
        .map_err(|_| UpdateError::Unavailable)?
        .take()
        .ok_or(UpdateError::NoPendingUpdate)?;
    let source_paths = opened_source
        .open_paths()
        .map_err(|_| UpdateError::Storage)?;
    let restart = PendingRestart::new(update.version.clone(), source_paths);
    store.mutate(&app, |stored| stored.pending_restart = Some(restart))?;

    let progress = Mutex::new(UpdateProgressTracker::default());
    let chunk_progress = on_progress.clone();
    if update
        .download_and_install(
            |chunk_length, content_length| {
                if let Some(progress) = progress
                    .lock()
                    .ok()
                    .and_then(|mut tracker| tracker.record_chunk(chunk_length, content_length))
                {
                    let _ = chunk_progress.send(progress);
                }
            },
            || {
                if let Some(progress) = progress
                    .lock()
                    .ok()
                    .and_then(|mut tracker| tracker.finish())
                {
                    let _ = on_progress.send(progress);
                }
            },
        )
        .await
        .is_err()
    {
        *pending.0.lock().map_err(|_| UpdateError::Unavailable)? = Some(update);
        store.mutate(&app, |stored| stored.pending_restart = None)?;
        return Err(UpdateError::Unavailable);
    }

    Ok(())
}

/// Restores the pre-update sources and reports the installed version once.
#[tauri::command]
pub async fn take_post_update_state(
    app: AppHandle,
    store: State<'_, UpdateStateStore>,
) -> Result<Option<PostUpdateState>, UpdateError> {
    let restart = store.mutate(&app, |stored| {
        stored
            .pending_restart
            .as_ref()
            .filter(|restart| restart.version == env!("CARGO_PKG_VERSION"))?;
        stored.pending_restart.take()
    })?;
    let Some(restart) = restart else {
        return Ok(None);
    };
    let version = restart.version.clone();
    let paths = restart.restored_paths();
    let inspected = tauri::async_runtime::spawn_blocking(move || {
        // Reopened least recently used first, so the pre-update active source
        // ends up active again.
        paths
            .into_iter()
            .rev()
            .map(|path| inspect_selected_source(&app, path, SourceOpenIntent::Restore))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|_| UpdateError::Storage)?;

    let mut sources = Vec::new();
    let mut source_error = None;
    for result in inspected {
        match result {
            Ok(Some((_, source))) => sources.push(source),
            Ok(None) => {}
            // The source meant to become active is inspected last, so its
            // failure is the one an empty window reports.
            Err(OpenSourceError::Source(error)) => source_error = Some(error),
            Err(OpenSourceError::Recent(_)) => return Err(UpdateError::Storage),
        }
    }
    sources.reverse();

    Ok(Some(PostUpdateState {
        version,
        source_error: source_error.filter(|_| sources.is_empty()),
        sources,
    }))
}

/// Opens the immutable GitHub Releases page without accepting a URL from the webview.
#[tauri::command]
pub fn open_releases_page() -> Result<(), UpdateError> {
    tauri_plugin_opener::open_url(releases_page_url(), None::<&str>)
        .map_err(|_| UpdateError::Unavailable)
}

fn default_channel(version: &str) -> UpdateChannel {
    Version::parse(version)
        .ok()
        .filter(|version| !version.pre.is_empty())
        .map_or(UpdateChannel::Stable, |_| UpdateChannel::Latest)
}

fn automatic_check_is_due(last_check: Option<u64>, now: u64) -> bool {
    match last_check {
        None => true,
        Some(last_check) if last_check > now => true,
        Some(last_check) => now - last_check >= AUTOMATIC_CHECK_INTERVAL_SECONDS,
    }
}

fn require_self_updating_package() -> Result<(), UpdateError> {
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_none() {
        return Err(UpdateError::ManualInstall);
    }

    Ok(())
}

fn update_info(update: &Update) -> Result<UpdateInfo, semver::Error> {
    let current = Version::parse(&update.current_version)?;
    let candidate = Version::parse(&update.version)?;

    Ok(UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        is_downgrade: candidate < current,
    })
}

fn releases_page_url() -> &'static str {
    "https://github.com/MeisQuietude/Viewda/releases"
}

fn state_path(app: &AppHandle) -> Result<PathBuf, UpdateError> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(UPDATE_STATE_FILE))
        .map_err(|_| UpdateError::Storage)
}

fn read_state_file(path: &Path) -> Result<StoredUpdateState, UpdateError> {
    match fs::read(path) {
        Ok(contents) => serde_json::from_slice(&contents).map_err(|_| UpdateError::Storage),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(StoredUpdateState::default()),
        Err(_) => Err(UpdateError::Storage),
    }
}

fn write_state_file(path: &Path, state: &StoredUpdateState) -> Result<(), UpdateError> {
    let parent = path.parent().ok_or(UpdateError::Storage)?;
    fs::create_dir_all(parent).map_err(|_| UpdateError::Storage)?;
    let contents = serde_json::to_vec_pretty(state).map_err(|_| UpdateError::Storage)?;
    fs::write(path, contents).map_err(|_| UpdateError::Storage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prereleases_default_to_latest_and_stable_versions_to_stable() {
        for version in ["0.1.0-alpha.1", "0.1.0-beta.2", "0.1.0-rc.1"] {
            assert_eq!(default_channel(version), UpdateChannel::Latest);
        }
        assert_eq!(default_channel("0.1.0"), UpdateChannel::Stable);
    }

    #[test]
    fn missing_state_file_uses_version_appropriate_defaults() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state = read_state_file(&directory.path().join("missing.json"))
            .expect("missing state is a first launch");

        assert_eq!(state.settings, UpdateSettings::default());
        assert_eq!(state.theme_preference, ThemePreference::System);
        assert_eq!(state.data_view_settings, DataViewSettings::default());
        assert!(state.settings.automatic_checks);
        assert!(state.last_automatic_check_unix_seconds.is_none());
        assert!(state.pending_restart.is_none());
    }

    #[test]
    fn state_from_before_automatic_check_throttling_remains_readable() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("updates.json");
        fs::write(
            &path,
            r#"{
                "settings": {
                    "channel": "latest",
                    "automaticChecks": false
                },
                "pendingRestart": null
            }"#,
        )
        .expect("legacy state fixture");

        let state = read_state_file(&path).expect("legacy state remains compatible");

        assert_eq!(state.settings.channel, UpdateChannel::Latest);
        assert!(!state.settings.automatic_checks);
        assert_eq!(state.theme_preference, ThemePreference::System);
        assert_eq!(state.data_view_settings, DataViewSettings::default());
        assert!(state.last_automatic_check_unix_seconds.is_none());
    }

    #[test]
    fn automatic_checks_run_at_most_once_per_day() {
        let now = 2 * AUTOMATIC_CHECK_INTERVAL_SECONDS;

        assert!(automatic_check_is_due(None, now));
        assert!(!automatic_check_is_due(Some(now), now));
        assert!(!automatic_check_is_due(Some(now - 1), now));
        assert!(automatic_check_is_due(
            Some(now - AUTOMATIC_CHECK_INTERVAL_SECONDS),
            now
        ));
        assert!(automatic_check_is_due(Some(now + 1), now));
    }

    #[test]
    fn download_progress_reports_changed_percentages_and_completion() {
        let mut progress = UpdateProgressTracker::default();

        assert_eq!(
            progress.record_chunk(1, Some(400)),
            Some(UpdateProgress { percent: 0 })
        );
        assert_eq!(progress.record_chunk(1, Some(400)), None);
        assert_eq!(
            progress.record_chunk(198, Some(400)),
            Some(UpdateProgress { percent: 50 })
        );
        assert_eq!(progress.finish(), Some(UpdateProgress { percent: 100 }));
        assert_eq!(progress.finish(), None);
    }

    #[test]
    fn download_progress_stays_indeterminate_without_a_content_length() {
        let mut progress = UpdateProgressTracker::default();

        assert_eq!(progress.record_chunk(1024, None), None);
        assert_eq!(progress.finish(), Some(UpdateProgress { percent: 100 }));
    }

    #[test]
    fn update_progress_uses_the_frontend_wire_shape() {
        assert_eq!(
            serde_json::to_value(UpdateProgress { percent: 42 })
                .expect("serializable update progress"),
            serde_json::json!({ "percent": 42 })
        );
    }

    #[test]
    fn serialized_mutations_preserve_independent_update_state_fields() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("updates.json");
        let store = UpdateStateStore::default();

        store
            .mutate_path(&path, |stored| {
                stored.last_automatic_check_unix_seconds = Some(42);
            })
            .expect("automatic check timestamp");
        store
            .mutate_path(&path, |stored| {
                stored.settings = UpdateSettings {
                    channel: UpdateChannel::Latest,
                    automatic_checks: false,
                };
            })
            .expect("user settings");
        store
            .mutate_path(&path, |stored| {
                stored.theme_preference = ThemePreference::Dark;
            })
            .expect("appearance preference");
        store
            .mutate_path(&path, |stored| {
                stored.data_view_settings.memory_limit =
                    viewda_data_engine::DataViewMemoryLimit::Mb1536;
            })
            .expect("data-view resources");
        store
            .mutate_path(&path, |stored| {
                stored.pending_restart = Some(PendingRestart::new("0.1.0".to_owned(), Vec::new()));
            })
            .expect("restart marker");
        let restart = store
            .mutate_path(&path, |stored| stored.pending_restart.take())
            .expect("post-update marker");

        let stored = store.read_path(&path).expect("stored update state");

        assert_eq!(
            restart.as_ref().map(|restart| restart.version.as_str()),
            Some("0.1.0")
        );
        assert_eq!(stored.last_automatic_check_unix_seconds, Some(42));
        assert_eq!(stored.settings.channel, UpdateChannel::Latest);
        assert!(!stored.settings.automatic_checks);
        assert_eq!(stored.theme_preference, ThemePreference::Dark);
        assert_eq!(
            stored.data_view_settings.memory_limit,
            viewda_data_engine::DataViewMemoryLimit::Mb1536
        );
        assert!(stored.pending_restart.is_none());
    }

    #[test]
    fn restored_sources_keep_their_frontend_wire_shape() {
        let state = PostUpdateState {
            version: "0.1.0".to_owned(),
            sources: vec![OpenedSourceInfo {
                generation: 2,
                summary: viewda_data_engine::SourceSummary {
                    display_name: "trips.parquet".to_owned(),
                    size_bytes: 31,
                    row_count: 7,
                    row_group_count: 1,
                    schema: Vec::new(),
                },
            }],
            source_error: None,
        };

        assert_eq!(
            serde_json::to_value(state).expect("post-update state JSON"),
            serde_json::json!({
                "version": "0.1.0",
                "sources": [{
                    "generation": 2,
                    "displayName": "trips.parquet",
                    "sizeBytes": 31,
                    "rowCount": 7,
                    "rowGroupCount": 1,
                    "schema": [],
                }],
                "sourceError": null,
            })
        );
    }

    #[test]
    fn the_restart_marker_keeps_every_open_source_in_use_order() {
        let restart = PendingRestart::new(
            "0.1.0".to_owned(),
            vec![
                PathBuf::from("/data/active.parquet"),
                PathBuf::from("/data/second.parquet"),
            ],
        );

        assert_eq!(
            serde_json::to_value(&restart).expect("restart marker JSON"),
            serde_json::json!({
                "version": "0.1.0",
                "sourcePaths": ["/data/active.parquet", "/data/second.parquet"],
                "sourcePath": "/data/active.parquet",
            })
        );
        assert_eq!(
            restart.restored_paths(),
            [
                PathBuf::from("/data/active.parquet"),
                PathBuf::from("/data/second.parquet")
            ]
        );
    }

    #[test]
    fn a_restart_marker_from_a_single_source_release_still_restores_it() {
        let restart: PendingRestart = serde_json::from_value(serde_json::json!({
            "version": "0.1.0",
            "sourcePath": "/data/only.parquet",
        }))
        .expect("single-source restart marker");

        assert_eq!(
            restart.restored_paths(),
            [PathBuf::from("/data/only.parquet")]
        );
    }

    #[test]
    fn release_page_covers_every_version_between_updates() {
        assert_eq!(
            releases_page_url(),
            "https://github.com/MeisQuietude/Viewda/releases"
        );
    }
}
