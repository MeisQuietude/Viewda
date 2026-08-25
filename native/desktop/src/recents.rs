//! Rust-owned persistence and display metadata for recently opened sources.

use std::{
    fs,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use thiserror::Error;

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};

const RECENT_SOURCES_FILE: &str = "recents.json";
const RECENT_MANIFEST_DIRECTORY: &str = "recent-manifests";
const RECENT_SOURCES_LIMIT: usize = 8;

/// The source shape retained by one recent entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecentSourceKind {
    File,
    FolderDataset,
    FileDataset,
}

/// A recent-source entry exposed to the desktop switcher.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSource {
    pub id: String,
    pub kind: RecentSourceKind,
    pub name: String,
    pub directory: String,
    /// Absolute source identity used for display and reopening.
    ///
    /// Ordinary paths are canonical; exact selections retain the logical root
    /// shared by their manifest entries.
    pub path: String,
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
    #[serde(default)]
    kind: StoredRecentSourceKind,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum StoredRecentSourceKind {
    #[default]
    Path,
    ExplicitFiles,
}

/// A validated recent entry resolved without exposing persistence to the UI.
pub(crate) enum ResolvedRecentSource {
    Path(PathBuf),
    ExplicitFiles { root: PathBuf, manifest: PathBuf },
}

/// Serializes every read-modify-write of `recents.json` in this process.
#[derive(Clone, Default)]
pub struct RecentSourcesStore(Arc<Mutex<()>>);

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
        stored
            .entries
            .retain(|entry| stored_entry_is_available(state_path, entry));
        if stored.entries.len() != original_len {
            write_state_file(state_path, &stored)?;
        }
        reconcile_manifest_directory(state_path, &stored)?;

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
            .position(|entry| {
                entry.kind == StoredRecentSourceKind::Path && entry.path == canonical_path
            })
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
                    kind: StoredRecentSourceKind::Path,
                }
            }
        };
        stored.entries.insert(0, entry);
        let evicted = stored
            .entries
            .split_off(stored.entries.len().min(RECENT_SOURCES_LIMIT));
        write_state_file(state_path, &stored)?;
        cleanup_entry_manifests(state_path, &evicted);
        reconcile_manifest_directory(state_path, &stored)?;

        Ok(canonical_path)
    }

    pub(crate) fn record_explicit_files(
        &self,
        state_path: &Path,
        root: &Path,
        manifest: &Path,
    ) -> Result<PathBuf, RecentSourceError> {
        // The manifest keeps logical paths so the persisted root must use the
        // same spelling. In particular, Windows canonicalization adds a `\\?\`
        // prefix that no longer strips from ordinary manifest paths.
        let logical_root = std::path::absolute(root).map_err(|_| RecentSourceError::Storage)?;
        let canonical_root =
            fs::canonicalize(&logical_root).map_err(|_| RecentSourceError::Storage)?;
        require_regular_file(manifest)?;
        let _guard = self.0.lock().map_err(|_| RecentSourceError::Storage)?;
        let mut stored = read_state_file(state_path)?;
        reconcile_manifest_directory(state_path, &stored)?;
        let existing = stored.entries.iter().position(|entry| {
            entry.kind == StoredRecentSourceKind::ExplicitFiles
                && fs::canonicalize(&entry.path).is_ok_and(|root| root == canonical_root)
                && manifest_path(state_path, &entry.id)
                    .is_some_and(|stored_manifest| files_equal(&stored_manifest, manifest))
        });
        let (entry, created_manifest) = if let Some(index) = existing {
            let mut entry = stored.entries.remove(index);
            entry.path = logical_root.clone();
            (entry, None)
        } else {
            let id = format!("recent-{}", stored.next_id);
            stored.next_id = stored
                .next_id
                .checked_add(1)
                .ok_or(RecentSourceError::Storage)?;
            let target = manifest_path(state_path, &id).ok_or(RecentSourceError::Storage)?;
            copy_manifest(manifest, &target)?;
            (
                StoredRecentSource {
                    id,
                    path: logical_root.clone(),
                    kind: StoredRecentSourceKind::ExplicitFiles,
                },
                Some(target),
            )
        };
        stored.entries.insert(0, entry);
        let evicted = stored
            .entries
            .split_off(stored.entries.len().min(RECENT_SOURCES_LIMIT));
        if let Err(error) = write_state_file(state_path, &stored) {
            if let Some(path) = created_manifest {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
        cleanup_entry_manifests(state_path, &evicted);
        reconcile_manifest_directory(state_path, &stored)?;
        Ok(logical_root)
    }

    pub(crate) fn resolve_path(
        &self,
        state_path: &Path,
        id: &str,
    ) -> Result<ResolvedRecentSource, RecentSourceError> {
        let _guard = self.0.lock().map_err(|_| RecentSourceError::Storage)?;
        let mut stored = read_state_file(state_path)?;
        let Some(index) = stored.entries.iter().position(|entry| entry.id == id) else {
            return Err(RecentSourceError::UnknownRecent);
        };
        if stored.entries[index].kind == StoredRecentSourceKind::ExplicitFiles
            && !stored_entry_is_available(state_path, &stored.entries[index])
        {
            let removed = stored.entries.remove(index);
            write_state_file(state_path, &stored)?;
            cleanup_entry_manifests(state_path, &[removed]);
            reconcile_manifest_directory(state_path, &stored)?;
            return Err(RecentSourceError::UnknownRecent);
        }
        let entry = &stored.entries[index];
        Ok(match entry.kind {
            StoredRecentSourceKind::Path => ResolvedRecentSource::Path(entry.path.clone()),
            StoredRecentSourceKind::ExplicitFiles => ResolvedRecentSource::ExplicitFiles {
                root: entry.path.clone(),
                manifest: manifest_path(state_path, &entry.id)
                    .ok_or(RecentSourceError::UnknownRecent)?,
            },
        })
    }

    #[cfg(test)]
    pub(crate) fn path_for_id_path(
        &self,
        state_path: &Path,
        id: &str,
    ) -> Result<PathBuf, RecentSourceError> {
        match self.resolve_path(state_path, id)? {
            ResolvedRecentSource::Path(path) => Ok(path),
            ResolvedRecentSource::ExplicitFiles { root, .. } => Ok(root),
        }
    }

    pub(crate) fn remove_path(&self, state_path: &Path, id: &str) -> Result<(), RecentSourceError> {
        let _guard = self.0.lock().map_err(|_| RecentSourceError::Storage)?;
        let mut stored = read_state_file(state_path)?;
        let original_len = stored.entries.len();
        let removed = stored
            .entries
            .iter()
            .filter(|entry| entry.id == id)
            .map(|entry| StoredRecentSource {
                id: entry.id.clone(),
                path: entry.path.clone(),
                kind: entry.kind,
            })
            .collect::<Vec<_>>();
        stored.entries.retain(|entry| entry.id != id);
        if stored.entries.len() != original_len {
            write_state_file(state_path, &stored)?;
            cleanup_entry_manifests(state_path, &removed);
        }
        reconcile_manifest_directory(state_path, &stored)?;
        Ok(())
    }

    pub(crate) fn clear_path(&self, state_path: &Path) -> Result<(), RecentSourceError> {
        let _guard = self.0.lock().map_err(|_| RecentSourceError::Storage)?;
        let mut stored = read_state_file(state_path)?;
        if stored.entries.is_empty() {
            return reconcile_manifest_directory(state_path, &stored);
        }
        // Identifiers keep counting up so a cleared entry cannot be confused
        // with a source recorded afterwards.
        let removed = std::mem::take(&mut stored.entries);
        write_state_file(state_path, &stored)?;
        cleanup_entry_manifests(state_path, &removed);
        reconcile_manifest_directory(state_path, &stored)
    }
}

pub(crate) fn state_path(app: &AppHandle) -> Result<PathBuf, RecentSourceError> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(RECENT_SOURCES_FILE))
        .map_err(|_| RecentSourceError::Storage)
}

fn display_entry(entry: &StoredRecentSource, home: Option<&Path>) -> RecentSource {
    let mut name = entry
        .path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if entry.path.is_dir() {
        name.push('/');
    }

    RecentSource {
        id: entry.id.clone(),
        kind: match entry.kind {
            StoredRecentSourceKind::ExplicitFiles => RecentSourceKind::FileDataset,
            StoredRecentSourceKind::Path if entry.path.is_dir() => RecentSourceKind::FolderDataset,
            StoredRecentSourceKind::Path => RecentSourceKind::File,
        },
        name,
        directory: display_directory(&entry.path, home),
        path: entry.path.to_string_lossy().into_owned(),
    }
}

fn stored_entry_is_available(state_path: &Path, entry: &StoredRecentSource) -> bool {
    let source_available =
        fs::metadata(&entry.path).is_ok_and(|metadata| metadata.is_file() || metadata.is_dir());
    source_available
        && match entry.kind {
            StoredRecentSourceKind::Path => true,
            StoredRecentSourceKind::ExplicitFiles => manifest_path(state_path, &entry.id)
                .is_some_and(|path| require_regular_file(&path).is_ok()),
        }
}

fn require_regular_file(path: &Path) -> Result<(), RecentSourceError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| RecentSourceError::Storage)?;
    if metadata.file_type().is_file() && !metadata.file_type().is_symlink() {
        Ok(())
    } else {
        Err(RecentSourceError::Storage)
    }
}

fn manifest_directory(state_path: &Path) -> Option<PathBuf> {
    state_path
        .parent()
        .map(|parent| parent.join(RECENT_MANIFEST_DIRECTORY))
}

fn manifest_path(state_path: &Path, id: &str) -> Option<PathBuf> {
    let sequence = id.strip_prefix("recent-")?;
    if sequence.is_empty() || !sequence.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(manifest_directory(state_path)?.join(format!("{id}.manifest")))
}

fn copy_manifest(source: &Path, target: &Path) -> Result<(), RecentSourceError> {
    let directory = target.parent().ok_or(RecentSourceError::Storage)?;
    let mut directory_builder = fs::DirBuilder::new();
    directory_builder.recursive(true);
    #[cfg(unix)]
    directory_builder.mode(0o700);
    directory_builder
        .create(directory)
        .map_err(|_| RecentSourceError::Storage)?;
    let mut source = fs::File::open(source).map_err(|_| RecentSourceError::Storage)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut target_file = options
        .open(target)
        .map_err(|_| RecentSourceError::Storage)?;
    if std::io::copy(&mut source, &mut target_file)
        .and_then(|_| target_file.flush())
        .is_err()
    {
        drop(target_file);
        let _ = fs::remove_file(target);
        return Err(RecentSourceError::Storage);
    }
    if let Err(error) = require_regular_file(target) {
        let _ = fs::remove_file(target);
        return Err(error);
    }
    Ok(())
}

fn files_equal(left: &Path, right: &Path) -> bool {
    let Ok(mut left) = fs::File::open(left) else {
        return false;
    };
    let Ok(mut right) = fs::File::open(right) else {
        return false;
    };
    let Ok(left_size) = left.metadata().map(|metadata| metadata.len()) else {
        return false;
    };
    let Ok(right_size) = right.metadata().map(|metadata| metadata.len()) else {
        return false;
    };
    if left_size != right_size {
        return false;
    }
    let mut left_buffer = [0_u8; 8 * 1024];
    let mut right_buffer = [0_u8; 8 * 1024];
    loop {
        let Ok(left_read) = left.read(&mut left_buffer) else {
            return false;
        };
        let Ok(right_read) = right.read(&mut right_buffer) else {
            return false;
        };
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return false;
        }
        if left_read == 0 {
            return true;
        }
    }
}

fn cleanup_entry_manifests(state_path: &Path, entries: &[StoredRecentSource]) {
    for entry in entries {
        if entry.kind == StoredRecentSourceKind::ExplicitFiles
            && let Some(path) = manifest_path(state_path, &entry.id)
        {
            let _ = fs::remove_file(path);
        }
    }
}

fn reconcile_manifest_directory(
    state_path: &Path,
    stored: &StoredRecentSources,
) -> Result<(), RecentSourceError> {
    let directory = manifest_directory(state_path).ok_or(RecentSourceError::Storage)?;
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(RecentSourceError::Storage),
    };
    for entry in entries {
        let entry = entry.map_err(|_| RecentSourceError::Storage)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(id) = name
            .strip_suffix(".manifest")
            .filter(|id| manifest_path(state_path, id).is_some())
        else {
            continue;
        };
        let referenced = stored.entries.iter().any(|stored_entry| {
            stored_entry.kind == StoredRecentSourceKind::ExplicitFiles && stored_entry.id == id
        });
        if !referenced {
            fs::remove_file(entry.path()).map_err(|_| RecentSourceError::Storage)?;
        }
    }
    Ok(())
}

/// Renders the full parent directory, replacing a canonical `home` prefix with `~`.
///
/// `home` must already be canonical: paths are stored canonicalized, and a
/// symlinked home would otherwise never match.
pub(crate) fn display_directory(path: &Path, home: Option<&Path>) -> String {
    let parent = path.parent().unwrap_or(Path::new(""));
    home.and_then(|home| parent.strip_prefix(home).ok())
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
        .unwrap_or_else(|| parent.to_string_lossy().into_owned())
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

    fn create_manifest(directory: &Path, name: &str, contents: &[u8]) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, contents).expect("recent manifest fixture");
        path
    }

    #[test]
    fn reads_legacy_path_entries_without_a_kind() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source = create_file(directory.path(), "legacy.parquet");
        let state_path = directory.path().join("recents.json");
        fs::write(
            &state_path,
            serde_json::to_vec(&serde_json::json!({
                "nextId": 2,
                "entries": [{"id": "recent-1", "path": source}],
            }))
            .expect("legacy state JSON"),
        )
        .expect("legacy recent state");
        let store = RecentSourcesStore::default();

        let entries = store
            .list_path(&state_path, None)
            .expect("legacy recent source");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, RecentSourceKind::File);
        assert!(matches!(
            store.resolve_path(&state_path, "recent-1"),
            Ok(ResolvedRecentSource::Path(_))
        ));
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
    fn records_lists_and_removes_a_folder_dataset() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let home = directory.path().join("home");
        let dataset = home.join("datasets/trips");
        fs::create_dir_all(&dataset).expect("folder dataset fixture");
        let state_path = directory.path().join("recents.json");
        let store = RecentSourcesStore::default();

        let recorded = store
            .record_path(&state_path, &dataset.join("."))
            .expect("folder dataset");
        store
            .record_path(&state_path, &dataset)
            .expect("same canonical folder dataset");

        let entries = store
            .list_path(&state_path, Some(&home))
            .expect("recent folder datasets");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "recent-1");
        assert_eq!(entries[0].name, "trips/");
        assert_eq!(entries[0].directory, "~/datasets");
        assert_eq!(entries[0].path, recorded.to_string_lossy());
        assert_eq!(
            store.path_for_id_path(&state_path, "recent-1"),
            Ok(recorded)
        );

        store
            .remove_path(&state_path, "recent-1")
            .expect("remove recent folder dataset");
        assert!(
            store
                .list_path(&state_path, Some(&home))
                .expect("removed recent folder dataset")
                .is_empty()
        );
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
    fn keeps_folder_and_distinct_explicit_selections_at_one_root() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let root = directory.path().join("dataset");
        fs::create_dir(&root).expect("dataset root");
        let first = create_manifest(directory.path(), "first", b"first selection");
        let second = create_manifest(directory.path(), "second", b"second selection");
        let state_path = directory.path().join("recents.json");
        let store = RecentSourcesStore::default();

        store
            .record_path(&state_path, &root)
            .expect("folder recent");
        store
            .record_explicit_files(&state_path, &root, &first)
            .expect("first selection");
        store
            .record_explicit_files(&state_path, &root, &second)
            .expect("second selection");
        store
            .record_explicit_files(&state_path, &root, &first)
            .expect("deduplicated first selection");

        let entries = store
            .list_path(&state_path, None)
            .expect("coexisting dataset recents");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].kind, RecentSourceKind::FileDataset);
        assert_eq!(entries[1].kind, RecentSourceKind::FileDataset);
        assert_eq!(entries[2].kind, RecentSourceKind::FolderDataset);
        assert_ne!(entries[0].id, entries[1].id);
        assert!(matches!(
            store.resolve_path(&state_path, &entries[0].id),
            Ok(ResolvedRecentSource::ExplicitFiles { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn persistent_explicit_manifests_are_private() {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = tempfile::tempdir().expect("temporary directory");
        let root = directory.path().join("dataset");
        fs::create_dir(&root).expect("dataset root");
        let manifest = create_manifest(directory.path(), "selection", b"selection");
        fs::set_permissions(&manifest, fs::Permissions::from_mode(0o600))
            .expect("private source manifest");
        let state_path = directory.path().join("recents.json");
        RecentSourcesStore::default()
            .record_explicit_files(&state_path, &root, &manifest)
            .expect("explicit recent");

        let manifest_directory = manifest_directory(&state_path).expect("manifest directory");
        let persistent = manifest_path(&state_path, "recent-1").expect("persistent manifest");
        assert_eq!(
            fs::metadata(manifest_directory)
                .expect("manifest directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(persistent)
                .expect("persistent manifest metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn explicit_manifest_cleanup_tracks_remove_clear_eviction_and_orphans() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let root = directory.path().join("dataset");
        fs::create_dir(&root).expect("dataset root");
        let state_path = directory.path().join("recents.json");
        let store = RecentSourcesStore::default();
        let mut ids = Vec::new();
        for index in 0..=RECENT_SOURCES_LIMIT {
            let manifest = create_manifest(
                directory.path(),
                &format!("selection-{index}"),
                &[index as u8],
            );
            store
                .record_explicit_files(&state_path, &root, &manifest)
                .expect("explicit recent");
            ids.push(format!("recent-{}", index + 1));
        }
        let manifest_directory = manifest_directory(&state_path).expect("manifest directory");
        let orphan = manifest_directory.join("recent-99.manifest");
        let unrelated = manifest_directory.join("notes.txt");
        fs::write(&orphan, b"orphan").expect("orphan manifest");
        fs::write(&unrelated, b"unrelated").expect("unrelated file");

        let entries = store
            .list_path(&state_path, None)
            .expect("reconciled recents");
        assert_eq!(entries.len(), RECENT_SOURCES_LIMIT);
        assert!(!manifest_path(&state_path, &ids[0]).unwrap().exists());
        assert!(!orphan.exists());
        assert!(unrelated.exists());

        let removed = entries[0].id.clone();
        store
            .remove_path(&state_path, &removed)
            .expect("removed explicit recent");
        assert!(!manifest_path(&state_path, &removed).unwrap().exists());
        store.clear_path(&state_path).expect("cleared recents");
        assert_eq!(
            fs::read_dir(&manifest_directory)
                .expect("manifest directory")
                .count(),
            1,
            "only the unrelated file remains"
        );
    }

    #[test]
    fn missing_explicit_manifest_invalidates_only_its_entry() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let root = directory.path().join("dataset");
        fs::create_dir(&root).expect("dataset root");
        let first = create_manifest(directory.path(), "first", b"first");
        let second = create_manifest(directory.path(), "second", b"second");
        let state_path = directory.path().join("recents.json");
        let store = RecentSourcesStore::default();
        store
            .record_explicit_files(&state_path, &root, &first)
            .expect("first recent");
        store
            .record_explicit_files(&state_path, &root, &second)
            .expect("second recent");
        fs::remove_file(manifest_path(&state_path, "recent-1").unwrap())
            .expect("missing manifest fixture");

        let entries = store
            .list_path(&state_path, None)
            .expect("valid recents survive");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "recent-2");
        assert!(matches!(
            store.resolve_path(&state_path, "recent-2"),
            Ok(ResolvedRecentSource::ExplicitFiles { .. })
        ));
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
    fn filters_a_folder_dataset_that_no_longer_exists() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state_path = directory.path().join("recents.json");
        let missing = directory.path().join("missing-dataset");
        fs::create_dir(&missing).expect("folder dataset fixture");
        let store = RecentSourcesStore::default();
        store
            .record_path(&state_path, &missing)
            .expect("recent folder dataset");
        fs::remove_dir(missing).expect("remove folder dataset fixture");

        assert!(
            store
                .list_path(&state_path, None)
                .expect("filtered recent folder datasets")
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
    fn clearing_forgets_every_source_without_reusing_identifiers() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state_path = directory.path().join("recents.json");
        let store = RecentSourcesStore::default();
        store
            .record_path(&state_path, &create_file(directory.path(), "first.parquet"))
            .expect("recent source");

        store.clear_path(&state_path).expect("cleared history");

        assert!(
            store
                .list_path(&state_path, None)
                .expect("cleared recent sources")
                .is_empty()
        );
        store
            .record_path(
                &state_path,
                &create_file(directory.path(), "second.parquet"),
            )
            .expect("recent source after clearing");
        assert_eq!(
            read_state_file(&state_path)
                .expect("recent sources")
                .entries[0]
                .id,
            "recent-2"
        );
    }

    #[test]
    fn keeps_full_directories_outside_home_and_shortens_the_home_prefix() {
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

        assert_eq!(
            entries[0].directory,
            fs::canonicalize(&external)
                .expect("canonical external directory")
                .to_string_lossy()
        );
        assert_eq!(
            display_directory(&home.join("reports/source.parquet"), Some(&home)),
            "~/reports"
        );
    }
}
