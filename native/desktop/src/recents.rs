//! Rust-owned persistence and display metadata for recently opened sources.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use thiserror::Error;

const RECENT_SOURCES_FILE: &str = "recents.json";
const RECENT_SOURCES_LIMIT: usize = 8;

/// A path-free recent-source entry exposed to the desktop UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSource {
    pub id: String,
    pub name: String,
    pub directory: String,
}

/// Stable failures for recent-source commands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum RecentSourceError {
    #[error("The recent-source list could not be read or saved.")]
    Storage,
    #[error("The requested recent source does not exist.")]
    UnknownRecent,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct StoredRecentSources {
    next_id: u64,
    entries: Vec<StoredRecentSource>,
}

impl Default for StoredRecentSources {
    fn default() -> Self {
        Self {
            next_id: 1,
            entries: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredRecentSource {
    id: String,
    path: PathBuf,
}

/// Serializes every read-modify-write of `recents.json` in this process.
#[derive(Default)]
pub struct RecentSourcesStore(Mutex<()>);

impl RecentSourcesStore {
    pub fn list(&self, app: &AppHandle) -> Result<Vec<RecentSource>, RecentSourceError> {
        let home = app.path().home_dir().ok();
        self.list_path(&state_path(app)?, home.as_deref())
    }

    fn list_path(
        &self,
        state_path: &Path,
        home: Option<&Path>,
    ) -> Result<Vec<RecentSource>, RecentSourceError> {
        let _guard = self.0.lock().map_err(|_| RecentSourceError::Storage)?;
        let mut stored = read_state_file(state_path)?;
        let canonical_home = home.and_then(|home| fs::canonicalize(home).ok());
        let original_len = stored.entries.len();
        stored.entries.retain(|entry| entry.path.is_file());
        if stored.entries.len() != original_len {
            write_state_file(state_path, &stored)?;
        }

        Ok(stored
            .entries
            .iter()
            .map(|entry| display_entry(entry, canonical_home.as_deref()))
            .collect())
    }

    pub(crate) fn record_path(
        &self,
        state_path: &Path,
        path: &Path,
    ) -> Result<PathBuf, RecentSourceError> {
        let canonical_path = fs::canonicalize(path).map_err(|_| RecentSourceError::Storage)?;
        let _guard = self.0.lock().map_err(|_| RecentSourceError::Storage)?;
        let mut stored = read_state_file(state_path)?;
        let existing = stored
            .entries
            .iter()
            .position(|entry| entry.path == canonical_path)
            .map(|index| stored.entries.remove(index));
        let entry = match existing {
            Some(entry) => entry,
            None => {
                let id = format!("recent-{}", stored.next_id);
                stored.next_id = stored
                    .next_id
                    .checked_add(1)
                    .ok_or(RecentSourceError::Storage)?;
                StoredRecentSource {
                    id,
                    path: canonical_path.clone(),
                }
            }
        };
        stored.entries.insert(0, entry);
        stored.entries.truncate(RECENT_SOURCES_LIMIT);
        write_state_file(state_path, &stored)?;

        Ok(canonical_path)
    }

    pub(crate) fn path_for_id_path(
        &self,
        state_path: &Path,
        id: &str,
    ) -> Result<PathBuf, RecentSourceError> {
        let _guard = self.0.lock().map_err(|_| RecentSourceError::Storage)?;
        read_state_file(state_path)?
            .entries
            .into_iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.path)
            .ok_or(RecentSourceError::UnknownRecent)
    }

    pub(crate) fn remove_path(&self, state_path: &Path, id: &str) -> Result<(), RecentSourceError> {
        let _guard = self.0.lock().map_err(|_| RecentSourceError::Storage)?;
        let mut stored = read_state_file(state_path)?;
        let original_len = stored.entries.len();
        stored.entries.retain(|entry| entry.id != id);
        if stored.entries.len() != original_len {
            write_state_file(state_path, &stored)?;
        }
        Ok(())
    }
}

pub(crate) fn state_path(app: &AppHandle) -> Result<PathBuf, RecentSourceError> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(RECENT_SOURCES_FILE))
        .map_err(|_| RecentSourceError::Storage)
}

fn display_entry(entry: &StoredRecentSource, home: Option<&Path>) -> RecentSource {
    let name = entry
        .path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parent = entry.path.parent().unwrap_or(Path::new(""));
    let directory = home
        .and_then(|home| parent.strip_prefix(home).ok())
        .map(|relative| {
            if relative.as_os_str().is_empty() {
                "~".to_owned()
            } else {
                let relative = relative
                    .iter()
                    .map(|component| component.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                format!("~/{relative}")
            }
        })
        .unwrap_or_else(|| {
            parent.file_name().map_or_else(
                || "…".to_owned(),
                |name| format!("…/{}", name.to_string_lossy()),
            )
        });

    RecentSource {
        id: entry.id.clone(),
        name,
        directory,
    }
}

fn read_state_file(path: &Path) -> Result<StoredRecentSources, RecentSourceError> {
    match fs::read(path) {
        Ok(contents) => Ok(serde_json::from_slice(&contents).unwrap_or_default()),
        Err(_) => Ok(StoredRecentSources::default()),
    }
}

fn write_state_file(path: &Path, state: &StoredRecentSources) -> Result<(), RecentSourceError> {
    let parent = path.parent().ok_or(RecentSourceError::Storage)?;
    fs::create_dir_all(parent).map_err(|_| RecentSourceError::Storage)?;
    let contents = serde_json::to_vec_pretty(state).map_err(|_| RecentSourceError::Storage)?;
    fs::write(path, contents).map_err(|_| RecentSourceError::Storage)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_file(directory: &Path, name: &str) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, name).expect("recent-source fixture");
        path
    }

    #[test]
    fn records_newest_first_and_deduplicates_canonical_paths() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state_path = directory.path().join("recents.json");
        let first = create_file(directory.path(), "first.parquet");
        let second = create_file(directory.path(), "second.parquet");
        let store = RecentSourcesStore::default();

        store
            .record_path(&state_path, &first)
            .expect("first source");
        store
            .record_path(&state_path, &second)
            .expect("second source");
        store
            .record_path(
                &state_path,
                &directory.path().join(".").join("first.parquet"),
            )
            .expect("same canonical source");

        let entries = store
            .list_path(&state_path, Some(directory.path()))
            .expect("recent sources");
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["first.parquet", "second.parquet"]
        );
        assert_eq!(entries[0].directory, "~");
    }

    #[test]
    fn keeps_only_eight_sources() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state_path = directory.path().join("recents.json");
        let store = RecentSourcesStore::default();

        for index in 0..10 {
            let path = create_file(directory.path(), &format!("source-{index}.parquet"));
            store
                .record_path(&state_path, &path)
                .expect("recent source");
        }

        let entries = store
            .list_path(&state_path, None)
            .expect("capped recent sources");
        assert_eq!(entries.len(), RECENT_SOURCES_LIMIT);
        assert_eq!(entries[0].name, "source-9.parquet");
        assert_eq!(entries[7].name, "source-2.parquet");
    }

    #[test]
    fn filters_sources_that_no_longer_exist() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state_path = directory.path().join("recents.json");
        let missing = create_file(directory.path(), "missing.parquet");
        let store = RecentSourcesStore::default();
        store
            .record_path(&state_path, &missing)
            .expect("recent source");
        fs::remove_file(missing).expect("remove source fixture");

        assert!(
            store
                .list_path(&state_path, None)
                .expect("filtered recent sources")
                .is_empty()
        );
        assert_eq!(
            store.path_for_id_path(&state_path, "recent-1"),
            Err(RecentSourceError::UnknownRecent)
        );
    }

    #[test]
    fn replaces_malformed_state_when_recording_the_next_source() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state_path = directory.path().join("recents.json");
        let source = create_file(directory.path(), "source.parquet");
        let store = RecentSourcesStore::default();
        fs::write(&state_path, b"not JSON").expect("malformed state fixture");

        store
            .record_path(&state_path, &source)
            .expect("malformed state is replaced");

        let stored = read_state_file(&state_path).expect("repaired recent sources");
        assert_eq!(stored.entries.len(), 1);
        assert_eq!(stored.entries[0].id, "recent-1");
    }

    #[test]
    fn shortens_directories_outside_the_home_path() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let home = directory.path().join("home");
        let external = directory.path().join("external");
        fs::create_dir_all(&home).expect("home fixture");
        fs::create_dir_all(&external).expect("external directory fixture");
        let state_path = directory.path().join("recents.json");
        let source = create_file(&external, "source.parquet");
        let store = RecentSourcesStore::default();
        store
            .record_path(&state_path, &source)
            .expect("external recent source");

        let entries = store
            .list_path(&state_path, Some(&home))
            .expect("shortened recent source");

        assert_eq!(entries[0].directory, "…/external");
        assert!(
            !entries[0]
                .directory
                .contains(directory.path().to_string_lossy().as_ref())
        );
    }
}
