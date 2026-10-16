import { useEffect, useRef, useState } from "react";
import { dispatchMaterialsToolbarCommand } from "../features/materials/materialsToolbarProtocol";
import { openGlobalSearchWithQuery } from "../features/search/searchOpenIntent";
import { getShortcutValue, matchesShortcut } from "./shortcuts";
import { readSavedSettings } from "../features/settings/useSettings";

export function TitlebarMaterialSearch({ query, mode }: { query: string; mode: "materials" | "global" }) {
  const [shortcut, setShortcut] = useState(() => getShortcutValue("searchModeToggle"));
  const [enabled, setEnabled] = useState(() => readSavedSettings()["search.modeShortcutEnabled"] !== false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const update = () => { setShortcut(getShortcutValue("searchModeToggle")); setEnabled(readSavedSettings()["search.modeShortcutEnabled"] !== false); };
    window.addEventListener("luckyray:settings-change", update); window.addEventListener("luckyray:shortcuts-change", update);
    return () => { window.removeEventListener("luckyray:settings-change", update); window.removeEventListener("luckyray:shortcuts-change", update); };
  }, []);
  const changeMode = (next: typeof mode) => {
    dispatchMaterialsToolbarCommand({ type: "set-search-mode", mode: next });
  };
  return <div className="titlebar-search titlebar-material-search" role="search">
    <button type="button" className="titlebar-search-mode" aria-label={`搜索模式：${mode === "materials" ? "素材" : "全局"}`} title={enabled ? `${shortcut} 切换 · Esc 离开输入框 · Shift+Tab 向前导航` : "点击切换搜索模式"}
      onClick={() => { changeMode(mode === "materials" ? "global" : "materials"); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5h11m-3-3 3 3-3 3M14 11H3m3-3-3 3 3 3"/></svg></button>
    <input ref={input} type="search" aria-label={mode === "materials" ? "搜索当前素材库" : "全局搜索"}
      placeholder={mode === "materials" ? "搜索素材…" : "搜索全局…"} maxLength={240} value={query}
      onClick={() => { if (mode === "global") openGlobalSearchWithQuery(query, true); }}
      onChange={event => dispatchMaterialsToolbarCommand({ type: "set-query", query: event.target.value })}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); input.current?.blur(); return; }
        // Never trap reverse focus traversal, even if a saved custom chord asks for it.
        if (event.key === "Tab" && event.shiftKey) return;
        if (enabled && matchesShortcut(event.nativeEvent, "searchModeToggle")) {
          event.preventDefault(); event.stopPropagation(); changeMode(mode === "materials" ? "global" : "materials");
        } else if (event.key === "Enter" && mode === "global") {
          event.preventDefault(); event.stopPropagation(); openGlobalSearchWithQuery(query, true);
        }
      }}/>
    <button type="button" aria-label="以图搜图" title="以图搜图 · 可直接拖入图片" data-material-appearance-trigger data-material-appearance-drop
      onClick={() => { dispatchMaterialsToolbarCommand({ type: "toggle-appearance" }); }}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="5.5" cy="5.5" r="1"/><path d="m3 12 4-4 3 3 2-2 2 2"/></svg>
    </button>
  </div>;
}
