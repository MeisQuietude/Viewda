//! Platform-owned default application selection for Apache Parquet files.

use serde::Serialize;
use thiserror::Error;

#[cfg(any(target_os = "linux", target_os = "macos"))]
const PARQUET_MIME_TYPE: &str = "application/vnd.apache.parquet";

/// State shown by the Settings default-application row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DefaultApplicationStatus {
    /// Viewda is the current default handler.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    Default,
    /// This platform can make Viewda the default directly.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    CanSet,
    /// The platform helper needed to make the change is not installed.
    #[cfg(not(target_os = "windows"))]
    Unavailable,
    /// The running AppImage has no durable desktop integration.
    #[cfg(target_os = "linux")]
    UnintegratedAppImage,
    /// The user must finish the choice in Windows Settings.
    #[cfg(target_os = "windows")]
    SystemSettings,
}

/// Stable failures from a user-requested default application change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum DefaultApplicationError {
    /// The operating system could not read or change the handler.
    #[error("The default application could not be changed.")]
    Unavailable,
}

/// Reads the platform's current Apache Parquet handler where supported.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn get_default_application_status() -> DefaultApplicationStatus {
    platform::status().await
}

/// Reads the platform's current Apache Parquet handler where supported.
#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub fn get_default_application_status() -> DefaultApplicationStatus {
    platform::status()
}

/// Starts the explicit platform action that makes Viewda the default handler.
#[tauri::command]
pub async fn set_default_application() -> Result<DefaultApplicationStatus, DefaultApplicationError>
{
    platform::set_default().await
}

#[cfg(target_os = "linux")]
mod platform {
    use std::{io, process::Command};

    use super::{DefaultApplicationError, DefaultApplicationStatus, PARQUET_MIME_TYPE};

    const VIEWDA_DESKTOP_FILE: &str = "Viewda.desktop";

    #[derive(Clone, Copy)]
    enum XdgMimeAction {
        Query,
        SetDefault,
    }

    pub async fn status() -> DefaultApplicationStatus {
        if let Some(status) = appimage_status(running_from_appimage()) {
            return status;
        }

        match tauri::async_runtime::spawn_blocking(|| run_xdg_mime(XdgMimeAction::Query)).await {
            Ok(Ok(output)) if output.status.success() => {
                parse_query_output(&String::from_utf8_lossy(&output.stdout))
            }
            Ok(Err(error)) if error.kind() == io::ErrorKind::NotFound => {
                DefaultApplicationStatus::Unavailable
            }
            _ => DefaultApplicationStatus::CanSet,
        }
    }

    pub async fn set_default() -> Result<DefaultApplicationStatus, DefaultApplicationError> {
        require_integrated_package(running_from_appimage())?;

        let output =
            tauri::async_runtime::spawn_blocking(|| run_xdg_mime(XdgMimeAction::SetDefault))
                .await
                .map_err(|_| DefaultApplicationError::Unavailable)?
                .map_err(|_| DefaultApplicationError::Unavailable)?;
        if !output.status.success() {
            return Err(DefaultApplicationError::Unavailable);
        }

        Ok(status().await)
    }

    fn run_xdg_mime(action: XdgMimeAction) -> io::Result<std::process::Output> {
        xdg_mime_command(action).output()
    }

    fn xdg_mime_command(action: XdgMimeAction) -> Command {
        let mut command = Command::new("xdg-mime");
        match action {
            XdgMimeAction::Query => command.args(["query", "default", PARQUET_MIME_TYPE]),
            XdgMimeAction::SetDefault => {
                command.args(["default", VIEWDA_DESKTOP_FILE, PARQUET_MIME_TYPE])
            }
        };
        command
    }

    fn parse_query_output(output: &str) -> DefaultApplicationStatus {
        if output.trim() == VIEWDA_DESKTOP_FILE {
            DefaultApplicationStatus::Default
        } else {
            DefaultApplicationStatus::CanSet
        }
    }

    fn running_from_appimage() -> bool {
        std::env::var_os("APPIMAGE").is_some()
    }

    fn appimage_status(appimage: bool) -> Option<DefaultApplicationStatus> {
        appimage.then_some(DefaultApplicationStatus::UnintegratedAppImage)
    }

    fn require_integrated_package(appimage: bool) -> Result<(), DefaultApplicationError> {
        if appimage {
            Err(DefaultApplicationError::Unavailable)
        } else {
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn pins_xdg_mime_argv_contract() {
            let query = xdg_mime_command(XdgMimeAction::Query);
            assert_eq!(query.get_program(), "xdg-mime");
            assert_eq!(
                query
                    .get_args()
                    .map(|argument| argument.to_string_lossy())
                    .collect::<Vec<_>>(),
                ["query", "default", "application/vnd.apache.parquet"]
            );

            let set_default = xdg_mime_command(XdgMimeAction::SetDefault);
            assert_eq!(set_default.get_program(), "xdg-mime");
            assert_eq!(
                set_default
                    .get_args()
                    .map(|argument| argument.to_string_lossy())
                    .collect::<Vec<_>>(),
                [
                    "default",
                    "Viewda.desktop",
                    "application/vnd.apache.parquet"
                ]
            );
        }

        #[test]
        fn parses_only_viewdas_desktop_entry_as_default() {
            assert_eq!(
                parse_query_output("Viewda.desktop\n"),
                DefaultApplicationStatus::Default
            );
            assert_eq!(
                parse_query_output("org.example.Other.desktop\n"),
                DefaultApplicationStatus::CanSet
            );
            assert_eq!(parse_query_output(""), DefaultApplicationStatus::CanSet);
        }

        #[test]
        fn disables_default_changes_for_an_unintegrated_appimage() {
            assert_eq!(
                appimage_status(true),
                Some(DefaultApplicationStatus::UnintegratedAppImage)
            );
            assert_eq!(appimage_status(false), None);
            assert_eq!(
                require_integrated_package(true),
                Err(DefaultApplicationError::Unavailable)
            );
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{DefaultApplicationError, DefaultApplicationStatus};

    pub fn status() -> DefaultApplicationStatus {
        DefaultApplicationStatus::SystemSettings
    }

    pub async fn set_default() -> Result<DefaultApplicationStatus, DefaultApplicationError> {
        tauri_plugin_opener::open_url("ms-settings:defaultapps", None::<&str>)
            .map_err(|_| DefaultApplicationError::Unavailable)?;
        Ok(DefaultApplicationStatus::SystemSettings)
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use block2::RcBlock;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSError, NSObjectProtocol, NSProcessInfo, NSString};
    use objc2_uniform_type_identifiers::UTType;

    use super::{DefaultApplicationError, DefaultApplicationStatus, PARQUET_MIME_TYPE};

    pub fn status() -> DefaultApplicationStatus {
        if !supports_default_application_api() {
            return DefaultApplicationStatus::Unavailable;
        }

        let Some(content_type) = parquet_content_type() else {
            return DefaultApplicationStatus::CanSet;
        };
        let Some(handler_url) =
            NSWorkspace::sharedWorkspace().URLForApplicationToOpenContentType(&content_type)
        else {
            return DefaultApplicationStatus::CanSet;
        };
        let app_url = NSBundle::mainBundle().bundleURL();

        if handler_url.isEqual(Some(&app_url)) {
            DefaultApplicationStatus::Default
        } else {
            DefaultApplicationStatus::CanSet
        }
    }

    pub async fn set_default() -> Result<DefaultApplicationStatus, DefaultApplicationError> {
        if !supports_default_application_api() {
            return Err(DefaultApplicationError::Unavailable);
        }

        let mut receiver = {
            let content_type =
                parquet_content_type().ok_or(DefaultApplicationError::Unavailable)?;
            let app_url = NSBundle::mainBundle().bundleURL();
            let (sender, receiver) = tauri::async_runtime::channel(1);
            let completion: RcBlock<dyn Fn(*mut NSError)> =
                RcBlock::new(move |error: *mut NSError| {
                    let _ = sender.try_send(error.is_null());
                });
            NSWorkspace::sharedWorkspace()
                .setDefaultApplicationAtURL_toOpenContentType_completionHandler(
                    &app_url,
                    &content_type,
                    Some(&completion),
                );
            receiver
        };

        match receiver.recv().await {
            Some(true) => Ok(status()),
            _ => Err(DefaultApplicationError::Unavailable),
        }
    }

    fn supports_default_application_api() -> bool {
        NSProcessInfo::processInfo()
            .operatingSystemVersion()
            .majorVersion
            >= 12
    }

    fn parquet_content_type() -> Option<objc2::rc::Retained<UTType>> {
        UTType::typeWithMIMEType(&NSString::from_str(PARQUET_MIME_TYPE))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod platform {
    use super::{DefaultApplicationError, DefaultApplicationStatus};

    pub fn status() -> DefaultApplicationStatus {
        DefaultApplicationStatus::Unavailable
    }

    pub async fn set_default() -> Result<DefaultApplicationStatus, DefaultApplicationError> {
        Err(DefaultApplicationError::Unavailable)
    }
}
