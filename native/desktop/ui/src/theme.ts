export const THEME_CHANGED_EVENT = "viewda-theme-changed";
export const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

export type ThemePreference = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

export function applyDocumentTheme(
  preference: ThemePreference,
  systemDark = window.matchMedia(SYSTEM_THEME_QUERY).matches,
): EffectiveTheme {
  const effectiveTheme =
    preference === "system" ? (systemDark ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = effectiveTheme;
  window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
  return effectiveTheme;
}
