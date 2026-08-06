//! Persisted resource choices for preparing filtered and sorted data views.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use thiserror::Error;
use viewda_data_engine::DataViewMemoryLimit;

use crate::updates::{UpdateError, UpdateStateStore};

/// User-controlled resources for future view preparations.
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataViewSettings {
    /// Memory available to each future filter or sort preparation.
    pub memory_limit: DataViewMemoryLimit,
}

/// Stable settings failures exposed to the desktop UI.
#[derive(Debug, Clone, Copy, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum DataViewSettingsError {
    #[error("The data-view settings could not be read or saved.")]
    Storage,
}

impl From<UpdateError> for DataViewSettingsError {
    fn from(_error: UpdateError) -> Self {
        Self::Storage
    }
}

/// Reads resources applied to future filter and sort preparations.
#[tauri::command]
pub fn get_data_view_settings(
    app: AppHandle,
    store: State<'_, UpdateStateStore>,
) -> Result<DataViewSettings, DataViewSettingsError> {
    store.data_view_settings(&app).map_err(Into::into)
}

/// Persists resources applied to future filter and sort preparations.
#[tauri::command]
pub fn set_data_view_settings(
    app: AppHandle,
    store: State<'_, UpdateStateStore>,
    settings: DataViewSettings,
) -> Result<(), DataViewSettingsError> {
    store
        .set_data_view_settings(&app, settings)
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimum_memory_is_the_stable_wire_default() {
        assert_eq!(
            serde_json::to_value(DataViewSettings::default()).expect("settings JSON"),
            serde_json::json!({ "memoryLimit": "mb384" })
        );
    }
}
