import { THEME_TOKEN_KEYS, type ThemeResource } from "./packages";
/** Internal overlay: call only after applying base saved settings. Null clears
 * tokens; applyGlobalSettings restores dataset.theme. Accent/fonts stay in settings. */
export function applyPackageTheme(theme: ThemeResource | null, target: HTMLElement) {
  for (const token of THEME_TOKEN_KEYS) target.style.removeProperty(token);
  delete target.dataset.extensionTheme;
  if (!theme) return;
  target.dataset.theme = theme.base;
  target.dataset.extensionTheme = "active";
  for (const [key, value] of Object.entries(theme.tokens)) {
    if (THEME_TOKEN_KEYS.includes(key as typeof THEME_TOKEN_KEYS[number]) && /^#[a-f\d]{6}$/i.test(value)) target.style.setProperty(key, value);
  }
}
