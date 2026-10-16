import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isTauri } from "@tauri-apps/api/core";
import { createLightSeekNativeMenu, LSH_TOOL_PATHS } from "./lightSeekNativeMenu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { defineMessages, useMessages } from "../../core/i18n/index";
import { createDefaultDshPluginCompatClient } from "../../core/services/dshPluginCompat";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import DshPluginCompatSettingsCard from "../settings/DshPluginCompatSettingsCard";
import DshEngineUpdateCard from "../settings/DshEngineUpdateCard";
import "./lightSeekTools.css";

const COPY = defineMessages({
  tools: { "zh-CN": "LSH 工具", "en-US": "LSH tools" },
  check: { "zh-CN": "检查扩展", "en-US": "Check extensions" },
  about: { "zh-CN": "关于 LSH", "en-US": "About LSH" },
  update: { "zh-CN": "更新 LSH 引擎", "en-US": "Update LSH engine" },
  restart: { "zh-CN": "重启 LSH", "en-US": "Restart LSH" },
  restarting: { "zh-CN": "正在重启…", "en-US": "Restarting…" },
  version: { "zh-CN": "底层 DSH 版本", "en-US": "Underlying DSH version" },
  loading: { "zh-CN": "正在读取…", "en-US": "Reading…" },
  unavailable: { "zh-CN": "暂时无法读取运行时版本", "en-US": "Runtime version is currently unavailable" },
  source: { "zh-CN": "来自当前 LSH 宿主使用的 DSH 包。", "en-US": "Read from the DSH package used by the current LSH host." },
  close: { "zh-CN": "关闭", "en-US": "Close" },
  menuError: { "zh-CN": "工具菜单未能打开，请重试", "en-US": "Tools menu could not open. Try again." },
});

export default function LightSeekToolsMenu({ restarting, onRestart, onOpenChange }: {
  restarting: boolean; onRestart: () => void; onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useMessages(COPY);
  const [menu, setMenu] = useState(false);
  const [nativeOpen, setNativeOpen] = useState(false);
  const [menuError, setMenuError] = useState(false);
  const [dialog, setDialog] = useState<"check" | "about" | "update" | null>(null);
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const nativeMenu = useRef<ReturnType<typeof createLightSeekNativeMenu> | null>(null);
  const nativeBusy = useRef(false);
  const nativeActions = useRef({ onRestart, open: (next: "check" | "about" | "update") => setDialog(next) });
  nativeActions.current = { onRestart, open: (next) => setDialog(next) };
  useEffect(() => () => {
    const owned = nativeMenu.current; nativeMenu.current = null;
    void owned?.then(owned => owned.close()).catch(() => {});
  }, []);
  const close = useCallback(() => { setDialog(null); setMenu(false); requestAnimationFrame(() => trigger.current?.focus()); }, []);
  const modal = useApplicationModalSurface<HTMLDivElement>(dialog !== null, close);
  useLayoutEffect(() => { onOpenChange?.(menu || dialog !== null); return () => onOpenChange?.(false); }, [menu, dialog, onOpenChange]);
  useEffect(() => {
    if (!menu) return;
    popup.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [menu, close]);
  useEffect(() => {
    if (dialog !== "about") return;
    let active = true; setVersion(undefined);
    void createDefaultDshPluginCompatClient().then((client) => client.status()).then((status) => {
      if (active) setVersion(status.runtimeVersion);
    }).catch(() => { if (active) setVersion(null); });
    return () => { active = false; };
  }, [dialog]);
  const openDialog = (next: "check" | "about" | "update") => { setDialog(next); setMenu(false); };
  const openTools = async () => {
    if (!isTauri()) { setMenu((value) => !value); return; }
    if (nativeBusy.current) return;
    nativeBusy.current = true; setNativeOpen(true); setMenuError(false);
    try {
      // The OS popup is above native child Webviews. Opening it never hides,
      // resizes or restarts the LSH surface, and reuses one menu resource.
      nativeMenu.current ??= createLightSeekNativeMenu(t, tool => {
        if (tool === "restart") nativeActions.current.onRestart();
        else nativeActions.current.open(tool);
      }).catch((error) => { nativeMenu.current = null; throw error; });
      const owned = await nativeMenu.current;
      await owned.update(t);
      await owned.restart.setEnabled(!restarting);
      const rect = trigger.current?.getBoundingClientRect();
      await owned.menu.popup(rect ? new LogicalPosition(rect.left, rect.bottom + 4) : undefined);
    } catch { setMenuError(true); }
    finally { nativeBusy.current = false; setNativeOpen(false); }
  };
  return <div className="lsh-tools" data-tauri-no-drag="true">
    <button ref={trigger} type="button" className={`titlebar-ai-browser${menu || nativeOpen ? " active" : ""}`} aria-label={t("tools")} title={t(menuError ? "menuError" : "tools")} aria-haspopup="menu" aria-expanded={menu || nativeOpen} aria-controls={menu ? "lsh-tools-menu" : undefined} onClick={() => void openTools()} onKeyDown={(event) => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); void openTools(); }
    }}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="13" cy="8" r="1" /></svg></button>
    {menu && <div ref={popup} id="lsh-tools-menu" role="menu" aria-label={t("tools")} className="lsh-tools-menu" onKeyDown={(event) => {
      const items = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); close(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
      <button role="menuitem" onClick={() => openDialog("check")}><svg viewBox="0 0 16 16" aria-hidden="true"><path d={LSH_TOOL_PATHS.check} /></svg>{t("check")}</button>
      <button role="menuitem" onClick={() => openDialog("about")}><svg viewBox="0 0 16 16" aria-hidden="true"><path d={LSH_TOOL_PATHS.about} /></svg>{t("about")}</button>
      <button role="menuitem" onClick={() => openDialog("update")}><svg viewBox="0 0 16 16" aria-hidden="true"><path d={LSH_TOOL_PATHS.update} /></svg>{t("update")}</button>
      <div role="separator" />
      <button role="menuitem" disabled={restarting} onClick={() => { close(); onRestart(); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d={LSH_TOOL_PATHS.restart} /></svg>{t(restarting ? "restarting" : "restart")}</button>
    </div>}
    {dialog && createPortal(<div className="lsh-tools-backdrop" onPointerDown={modal.onBackdropPointerDown}>
      <div ref={modal.surfaceRef} role="dialog" aria-modal="true" aria-labelledby="lsh-tools-dialog-title" tabIndex={-1} className="lsh-tools-dialog" onKeyDown={modal.onSurfaceKeyDown}>
        <header><h2 id="lsh-tools-dialog-title">{t(dialog)}</h2><button type="button" onClick={close} aria-label={t("close")}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button></header>
        {dialog === "check" ? <DshPluginCompatSettingsCard /> : dialog === "update" ? <DshEngineUpdateCard /> : <div className="lsh-about"><strong>LightSeek harness</strong><dl><dt>{t("version")}</dt><dd>{version === undefined ? t("loading") : version ?? t("unavailable")}</dd></dl><p>{t("source")}</p></div>}
      </div>
    </div>, trigger.current?.closest(".react-nav-shell") ?? document.body)}
  </div>;
}
