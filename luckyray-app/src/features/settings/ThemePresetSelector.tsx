import type { CSSProperties } from "react";
import { THEME_PRESETS, type ThemePreset } from "../../core/theme/themePresets";
import { useI18n, type MessageKey } from "../../core/i18n/index";

export function ThemePresetSelector({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (preset: ThemePreset) => void;
}) {
  const { t } = useI18n();
  const selectedIndex = THEME_PRESETS.findIndex((preset) => preset.id === value);
  return (
    <div className="settings-theme-preset-grid" role="radiogroup" aria-label={t("settings.theme.selector")}>
      {THEME_PRESETS.map((preset, index) => {
        const isSelected = value === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            tabIndex={index === Math.max(0, selectedIndex) ? 0 : -1}
            onKeyDown={(event) => {
              const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
              if (!direction && event.key !== "Home" && event.key !== "End") return;
              event.preventDefault();
              const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? THEME_PRESETS.length - 1
                : (index + direction + THEME_PRESETS.length) % THEME_PRESETS.length;
              const next = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex];
              next?.focus();
              onSelect(THEME_PRESETS[nextIndex]);
            }}
            aria-label={t(`settings.theme.preset.${preset.id}` as MessageKey)}
            className={`settings-theme-preset-card${isSelected ? " active" : ""}`}
            onClick={() => onSelect(preset)}
          >
            <span className="settings-theme-miniature" aria-hidden="true" style={{
              "--preview-base": preset.previewTokens[0],
              "--preview-sidebar": preset.previewTokens[1],
              "--preview-surface": preset.previewTokens[2],
              "--preview-text": preset.previewTokens[3],
              "--preview-accent": preset.previewTokens[4],
            } as CSSProperties}>
              <span className="settings-theme-mini-top"><i /><i /><i /><span /></span>
              <span className="settings-theme-mini-sidebar"><b /><i className="selected" /><i /><i /><i /></span>
              <span className="settings-theme-mini-content">
                <span className="settings-theme-mini-title" />
                <span className="settings-theme-mini-tiles"><i /><i /><i /></span>
                <span className="settings-theme-mini-lines"><i /><i /></span>
              </span>
            </span>
            <span className="settings-theme-preset-footer">
              <span className="settings-theme-preset-copy"><span className="settings-theme-preset-name">{t(`settings.theme.preset.${preset.id}` as MessageKey)}</span><small>{t(`settings.theme.preset.${preset.category}` as MessageKey)}</small></span>
              <span className="settings-theme-preset-check" aria-hidden="true">{isSelected ? "✓" : ""}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
