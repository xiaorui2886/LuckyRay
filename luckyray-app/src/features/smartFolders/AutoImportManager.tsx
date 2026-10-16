import { useCallback, useEffect, useState } from "react";
import { openDataDir } from "../../core/services/system";
import {
  addMaterialWatchSource,
  readMaterialWatchSources,
  readMaterialWatchStatuses,
  removeMaterialWatchSource,
  updateMaterialWatchSource,
  type MaterialWatchSource,
  type MaterialWatchStatus,
  type MaterialWatchStorageMode,
} from "../materials/materialWatch";
import { useSettings } from "../settings/useSettings";
import { defineMessages, useMessages } from "../../core/i18n/index";

const COPY = defineMessages({
  "dialog.choose": { "zh-CN": "选择自动导入文件夹", "en-US": "Choose auto-import folder" },
  "status.added": { "zh-CN": "已添加来源，并开始扫描", "en-US": "Source added and scan started" },
  "error.choose": { "zh-CN": "选择文件夹失败，请稍后重试。", "en-US": "Could not choose a folder. Try again later." },
  "status.removed": { "zh-CN": "自动导入来源已移除，原文件和已入库内容未受影响", "en-US": "Auto-import source removed; original and imported content are unaffected" },
  "status.started": { "zh-CN": "已开始扫描自动导入来源", "en-US": "Auto-import scan started" },
  "header.title": { "zh-CN": "自动导入", "en-US": "Auto Import" },
  "header.description": { "zh-CN": "只扫描你明确选择的目录；关闭后不会继续扫描。", "en-US": "Only folders you explicitly choose are scanned; turning it off stops further scans." },
  "header.status.one": { "zh-CN": "{state} · {count} 个目录", "en-US": "{state} · {count} folder" }, "header.status.other": { "zh-CN": "{state} · {count} 个目录", "en-US": "{state} · {count} folders" },
  "state.enabled": { "zh-CN": "已启用", "en-US": "Enabled" },
  "state.disabled": { "zh-CN": "已关闭", "en-US": "Off" },
  "master.title": { "zh-CN": "启用自动导入", "en-US": "Enable Auto Import" },
  "master.enabled": { "zh-CN": "已按现有规则扫描启用的来源", "en-US": "Enabled sources are scanned with their current rules" },
  "master.disabled": { "zh-CN": "当前不会扫描任何来源", "en-US": "No sources are currently scanned" },
  "master.turnOff": { "zh-CN": "关闭自动导入", "en-US": "Turn off Auto Import" },
  "master.turnOn": { "zh-CN": "启用自动导入", "en-US": "Turn on Auto Import" },
  "action.add": { "zh-CN": "添加文件夹", "en-US": "Add folder" },
  "action.scan": { "zh-CN": "立即扫描", "en-US": "Scan now" },
  "enabled.count": { "zh-CN": "{count} 个已启用", "en-US": "{count} enabled" },
  "empty.title": { "zh-CN": "还没有自动导入来源", "en-US": "No auto-import sources yet" },
  "empty.description": { "zh-CN": "添加你希望 LuckyRay 定期检查的文件夹。", "en-US": "Add folders you want LuckyRay to check periodically." },
  "source.toggle": { "zh-CN": "{action} {path}", "en-US": "{action} {path}" },
  "source.enable": { "zh-CN": "启用", "en-US": "Enable" },
  "source.disable": { "zh-CN": "停用", "en-US": "Disable" },
  "source.mode": { "zh-CN": "管理方式", "en-US": "Management mode" },
  "mode.managed": { "zh-CN": "托管复制", "en-US": "Managed copy" },
  "mode.linked": { "zh-CN": "链接引用", "en-US": "Linked reference" },
  "mode.source": { "zh-CN": "源文件管理", "en-US": "Source file management" },
  "source.recursive": { "zh-CN": "包含子文件夹", "en-US": "Include subfolders" },
  "source.preserve": { "zh-CN": "保留目录结构", "en-US": "Preserve folder structure" },
  "action.open": { "zh-CN": "打开", "en-US": "Open" },
  "action.remove": { "zh-CN": "移除", "en-US": "Remove" },
  "error.open": { "zh-CN": "无法打开目录", "en-US": "Could not open folder" },
  "confirm.title": { "zh-CN": "移除这个来源？", "en-US": "Remove this source?" },
  "confirm.description": { "zh-CN": "不会删除原文件，也不会删除已经导入的素材。", "en-US": "Original files and already imported assets will not be deleted." },
  "action.cancel": { "zh-CN": "取消", "en-US": "Cancel" },
  "confirm.remove": { "zh-CN": "确认移除", "en-US": "Remove source" },
  "note": { "zh-CN": "新增文件会按内容哈希去重；关闭“保留目录结构”时进入全部素材。", "en-US": "New files are deduplicated by content hash; disabling “Preserve folder structure” places them in All Materials." },
  "scan.never": { "zh-CN": "尚未扫描", "en-US": "Not scanned yet" },
  "scan.scanning": { "zh-CN": "扫描中", "en-US": "Scanning" },
  "scan.failed": { "zh-CN": "扫描失败", "en-US": "Scan failed" },
  "scan.success": { "zh-CN": "{imported}，{skipped}", "en-US": "{imported} and {skipped}" },
  "scan.imported.one": { "zh-CN": "上次导入 {count} 个", "en-US": "Last scan imported {count} item" },
  "scan.imported.other": { "zh-CN": "上次导入 {count} 个", "en-US": "Last scan imported {count} items" },
  "scan.skipped.one": { "zh-CN": "跳过 {count} 个重复项", "en-US": "skipped {count} duplicate" },
  "scan.skipped.other": { "zh-CN": "跳过 {count} 个重复项", "en-US": "skipped {count} duplicates" },
  "scan.waiting": { "zh-CN": "等待扫描", "en-US": "Waiting to scan" },
});

type AutoImportT = ReturnType<typeof useMessages<typeof COPY>>["t"];
type AutoImportPlural = ReturnType<typeof useMessages<typeof COPY>>["plural"];

export default function AutoImportManager({ mode }: { mode: "inline" }) {
  const { plural, t } = useMessages(COPY);
  const { get, set } = useSettings();
  const [sources, setSources] = useState<MaterialWatchSource[]>(() => readMaterialWatchSources());
  const [statuses, setStatuses] = useState<Record<string, MaterialWatchStatus>>(() => readMaterialWatchStatuses());
  const [pendingRemoval, setPendingRemoval] = useState<MaterialWatchSource | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const enabled = Boolean(get("general.watchFolder", false));

  useEffect(() => {
    const syncSources = () => setSources(readMaterialWatchSources());
    const syncStatuses = () => setStatuses(readMaterialWatchStatuses());
    window.addEventListener("luckyray:material-watch-sources", syncSources);
    window.addEventListener("luckyray:material-watch-status", syncStatuses);
    return () => {
      window.removeEventListener("luckyray:material-watch-sources", syncSources);
      window.removeEventListener("luckyray:material-watch-status", syncStatuses);
    };
  }, []);

  const showMessage = useCallback((text: string, failed = false) => {
    setMessage(failed ? "" : text);
    setError(failed ? text : "");
  }, []);

  const chooseFolder = useCallback(async () => {
    showMessage("");
    try {
      const { open: chooseDirectory } = await import("@tauri-apps/plugin-dialog");
      const selected = await chooseDirectory({ title: t("dialog.choose"), directory: true, multiple: false });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      setSources(addMaterialWatchSource(path, {
        storageMode: String(get("materials.importMode", "linked")) as MaterialWatchStorageMode,
        recursive: true,
        preserveFolderStructure: true,
      }));
      set("general.watchFolder", true);
      window.dispatchEvent(new CustomEvent("luckyray:material-watch-run-now"));
      showMessage(t("status.added"));
    } catch {
      showMessage(t("error.choose"), true);
    }
  }, [get, set, showMessage, t]);

  const patchSource = useCallback((sourceId: string, patch: Partial<MaterialWatchSource>) => {
    setSources(updateMaterialWatchSource(sourceId, patch));
  }, []);

  const removeSource = useCallback(() => {
    if (!pendingRemoval) return;
    setSources(removeMaterialWatchSource(pendingRemoval.id));
    setPendingRemoval(null);
    showMessage(t("status.removed"));
  }, [pendingRemoval, showMessage, t]);

  const runNow = useCallback(() => {
    set("general.watchFolder", true);
    window.dispatchEvent(new CustomEvent("luckyray:material-watch-run-now"));
    showMessage(t("status.started"));
  }, [set, showMessage, t]);

  return (
    <section className={`smart-auto-import-region ${mode}`} aria-labelledby="smart-auto-import-heading">
      <header className="smart-auto-import-inline-head">
        <div>
          <h2 id="smart-auto-import-heading">{t("header.title")}</h2>
          <p>{t("header.description")}</p>
        </div>
        <span>{plural(sources.length, { one: "header.status.one", other: "header.status.other" }, { state: enabled ? t("state.enabled") : t("state.disabled") })}</span>
      </header>

      <div className="smart-auto-import-body">
        <div className="smart-auto-import-master">
          <div><strong>{t("master.title")}</strong><small>{enabled ? t("master.enabled") : t("master.disabled")}</small></div>
          <button
            type="button"
            role="switch"
            aria-label={enabled ? t("master.turnOff") : t("master.turnOn")}
            aria-checked={enabled}
            className={`smart-switch${enabled ? " active" : ""}`}
            onClick={() => set("general.watchFolder", !enabled)}
          ><span aria-hidden="true" /></button>
        </div>

        <div className="smart-auto-import-toolbar">
          <button type="button" className="primary" onClick={() => void chooseFolder()}>{t("action.add")}</button>
          <button type="button" disabled={!sources.length} onClick={runNow}>{t("action.scan")}</button>
          <span>{t("enabled.count", { count: sources.filter((source) => source.enabled).length })}</span>
        </div>

        {message ? <div className="smart-auto-import-message" role="status">{message}</div> : null}
        {error ? <div className="smart-inline-error" role="alert">{error}</div> : null}

        <div className="smart-auto-import-list">
          {sources.length === 0 ? (
            <div className="smart-auto-import-empty"><strong>{t("empty.title")}</strong><p>{t("empty.description")}</p></div>
          ) : sources.map((source) => {
            const status = statuses[source.id];
            return (
              <article className="smart-auto-import-source" key={source.id}>
                <div className="smart-auto-import-source-head">
                  <div><strong title={source.path}>{source.path}</strong><small className={`state-${status?.state || "idle"}`}>{formatWatchStatus(status, plural, t)}</small></div>
                  <button
                    type="button"
                    role="switch"
                    aria-label={t("source.toggle", { action: source.enabled ? t("source.disable") : t("source.enable"), path: source.path })}
                    aria-checked={source.enabled}
                    className={`smart-switch compact${source.enabled ? " active" : ""}`}
                    onClick={() => patchSource(source.id, { enabled: !source.enabled })}
                  ><span aria-hidden="true" /></button>
                </div>
                <div className="smart-auto-import-source-controls">
                  <label><span>{t("source.mode")}</span><select value={source.storageMode} onChange={(event) => patchSource(source.id, { storageMode: event.target.value as MaterialWatchStorageMode })}><option value="managed">{t("mode.managed")}</option><option value="linked">{t("mode.linked")}</option><option value="source">{t("mode.source")}</option></select></label>
                  <label className="smart-inline-check"><input type="checkbox" checked={source.recursive} onChange={(event) => patchSource(source.id, { recursive: event.target.checked })} /><span>{t("source.recursive")}</span></label>
                  <label className="smart-inline-check"><input type="checkbox" checked={source.preserveFolderStructure} onChange={(event) => patchSource(source.id, { preserveFolderStructure: event.target.checked })} /><span>{t("source.preserve")}</span></label>
                  <span className="smart-auto-import-source-spacer" />
                  <button type="button" onClick={() => void openDataDir(source.path).catch(() => showMessage(t("error.open"), true))}>{t("action.open")}</button>
                  <button type="button" className="danger" onClick={() => setPendingRemoval(source)}>{t("action.remove")}</button>
                </div>
              </article>
            );
          })}
        </div>

        {pendingRemoval ? (
          <div className="smart-auto-import-confirm" role="alertdialog" aria-labelledby="smart-auto-import-remove-title">
            <div><strong id="smart-auto-import-remove-title">{t("confirm.title")}</strong><p>{t("confirm.description")}</p><small title={pendingRemoval.path}>{pendingRemoval.path}</small></div>
            <div><button type="button" onClick={() => setPendingRemoval(null)}>{t("action.cancel")}</button><button type="button" className="danger" onClick={removeSource}>{t("confirm.remove")}</button></div>
          </div>
        ) : null}

        <p className="smart-auto-import-note">{t("note")}</p>
      </div>
    </section>
  );
}

function formatWatchStatus(status: MaterialWatchStatus | undefined, plural: AutoImportPlural, t: AutoImportT) {
  if (!status) return t("scan.never");
  if (status.state === "scanning") return t("scan.scanning");
  if (status.state === "error") return t("scan.failed");
  if (status.state === "success") {
    const imported = status.lastImportedCount || 0;
    const skipped = status.lastSkippedDuplicateCount || 0;
    return t("scan.success", {
      imported: plural(imported, { one: "scan.imported.one", other: "scan.imported.other" }),
      skipped: plural(skipped, { one: "scan.skipped.one", other: "scan.skipped.other" }),
    });
  }
  return t("scan.waiting");
}
