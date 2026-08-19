//! Persisted appearance preference and native window theme synchronization.

#[cfg(target_os = "linux")]
use std::cell::RefCell;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Theme, window::Color};
use thiserror::Error;

use crate::updates::{UpdateError, UpdateStateStore};

const MAIN_WINDOW_LABEL: &str = "main";
const LIGHT_BACKGROUND: Color = Color(0xf4, 0xf3, 0xef, 0xff);
const DARK_BACKGROUND: Color = Color(0x14, 0x16, 0x17, 0xff);
#[cfg(target_os = "linux")]
const LIGHT_MENU_FOREGROUND: &str = "#1b1d1e";
#[cfg(target_os = "linux")]
const DARK_MENU_FOREGROUND: &str = "#f0f0eb";

#[cfg(target_os = "linux")]
thread_local! {
    static LINUX_MENU_PROVIDER: RefCell<Option<gtk::CssProvider>> = const { RefCell::new(None) };
}

/// User-selected application appearance.
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

/// Resolved color scheme used for the webview background.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EffectiveTheme {
    Light,
    Dark,
}

/// Stable appearance failures exposed to the desktop UI.
#[derive(Debug, Clone, Copy, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum ThemeError {
    #[error("The appearance preference could not be read or saved.")]
    Storage,
    #[error("The native window theme could not be changed.")]
    Unavailable,
}

impl From<UpdateError> for ThemeError {
    fn from(error: UpdateError) -> Self {
        match error {
            UpdateError::Storage => Self::Storage,
            _ => Self::Unavailable,
        }
    }
}

/// Reads the persisted appearance preference.
#[tauri::command]
pub fn get_theme_preference(
    app: AppHandle,
    store: State<'_, UpdateStateStore>,
) -> Result<ThemePreference, ThemeError> {
    store.theme_preference(&app).map_err(Into::into)
}

/// Applies and persists a new appearance preference.
#[tauri::command]
pub fn set_theme_preference(
    app: AppHandle,
    store: State<'_, UpdateStateStore>,
    preference: ThemePreference,
) -> Result<(), ThemeError> {
    let previous = store.theme_preference(&app)?;
    apply_native_theme(&app, preference)?;
    if let Err(error) = store.set_theme_preference(&app, preference) {
        let _ = apply_native_theme(&app, previous);
        return Err(error.into());
    }
    Ok(())
}

/// Updates the native background after a live OS-theme change.
#[tauri::command]
pub fn sync_system_theme(
    app: AppHandle,
    store: State<'_, UpdateStateStore>,
    effective_theme: EffectiveTheme,
) -> Result<(), ThemeError> {
    if store.theme_preference(&app)? != ThemePreference::System {
        return Ok(());
    }
    set_background(&app, effective_theme)
}

pub(crate) fn apply_saved_theme(app: &AppHandle, store: &UpdateStateStore) {
    let preference = store.theme_preference(app).unwrap_or_default();
    let _ = apply_native_theme(app, preference);
}

#[cfg(target_os = "linux")]
fn configure_linux_native_controls(theme: EffectiveTheme) {
    use gtk::prelude::{CssProviderExt, GtkSettingsExt};

    if let Some(settings) = gtk::Settings::default() {
        // WebKitGTK otherwise fades an idle horizontal thumb completely,
        // making the grid's dedicated scrollbar lane look non-interactive.
        settings.set_gtk_overlay_scrolling(false);
    }

    let Some(screen) = gtk::gdk::Screen::default() else {
        return;
    };
    let foreground = match theme {
        EffectiveTheme::Light => LIGHT_MENU_FOREGROUND,
        EffectiveTheme::Dark => DARK_MENU_FOREGROUND,
    };
    // Tauri queues the native theme update, so a GTK symbolic color loaded
    // here can resolve against the previous theme and retain that color.
    let css = format!("menubar > menuitem > box > label {{ color: {foreground}; }}");
    LINUX_MENU_PROVIDER.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some(provider) = slot.as_ref() {
            let _ = provider.load_from_data(css.as_bytes());
            return;
        }

        let provider = gtk::CssProvider::new();
        if provider.load_from_data(css.as_bytes()).is_ok() {
            // Muda nests each top-level GtkAccelLabel inside a GtkBox. Match
            // that exact chain so submenu labels keep their native colors.
            gtk::StyleContext::add_provider_for_screen(
                &screen,
                &provider,
                gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
            );
            *slot = Some(provider);
        }
    });
}

fn apply_native_theme(app: &AppHandle, preference: ThemePreference) -> Result<(), ThemeError> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or(ThemeError::Unavailable)?;
    window
        .set_theme(native_theme(preference))
        .map_err(|_| ThemeError::Unavailable)?;
    let effective_theme = match preference {
        ThemePreference::Light => EffectiveTheme::Light,
        ThemePreference::Dark => EffectiveTheme::Dark,
        ThemePreference::System => window
            .theme()
            .map(effective_theme)
            .map_err(|_| ThemeError::Unavailable)?,
    };
    set_background(app, effective_theme)
}

fn set_background(app: &AppHandle, effective_theme: EffectiveTheme) -> Result<(), ThemeError> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or(ThemeError::Unavailable)?;
    #[cfg(target_os = "linux")]
    configure_linux_native_controls(effective_theme);
    window
        .set_background_color(Some(background_color(effective_theme)))
        .map_err(|_| ThemeError::Unavailable)
}

fn native_theme(preference: ThemePreference) -> Option<Theme> {
    match preference {
        ThemePreference::System => None,
        ThemePreference::Light => Some(Theme::Light),
        ThemePreference::Dark => Some(Theme::Dark),
    }
}

fn effective_theme(theme: Theme) -> EffectiveTheme {
    match theme {
        Theme::Dark => EffectiveTheme::Dark,
        _ => EffectiveTheme::Light,
    }
}

fn background_color(theme: EffectiveTheme) -> Color {
    match theme {
        EffectiveTheme::Light => LIGHT_BACKGROUND,
        EffectiveTheme::Dark => DARK_BACKGROUND,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_map_to_native_theme_overrides() {
        assert_eq!(native_theme(ThemePreference::System), None);
        assert_eq!(native_theme(ThemePreference::Light), Some(Theme::Light));
        assert_eq!(native_theme(ThemePreference::Dark), Some(Theme::Dark));
    }

    #[test]
    fn effective_themes_use_the_prepaint_backgrounds() {
        assert_eq!(background_color(EffectiveTheme::Light), LIGHT_BACKGROUND);
        assert_eq!(background_color(EffectiveTheme::Dark), DARK_BACKGROUND);
    }
}
