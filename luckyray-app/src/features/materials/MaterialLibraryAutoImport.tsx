import { useEffect, useState } from "react";
import { materialLibrarySession, type MaterialLibrary } from "../../core/services/materialLibraryContext";
import { LIBRARY_ROOT_SOURCE, readLibraryRootWatch, readMaterialWatchStatuses, setLibraryRootWatch } from "./materialWatch";

export function MaterialLibraryAutoImport({ library, disabled }: { library: MaterialLibrary; disabled: boolean }) {
  const [root, setRoot] = useState("");
  const [error, setError] = useState("");
  const [, refresh] = useState(0);
  const config = readLibraryRootWatch(library.id);
  const status = readMaterialWatchStatuses(library.id)[LIBRARY_ROOT_SOURCE];
  useEffect(() => {
    let active = true; setRoot(""); setError("");
    if (library.visible && library.state === "ready") void materialLibrarySession.request<string>({ op: "libraryWatchRoot" }, library.id)
      .then(value => { if (active) setRoot(value); })
      .catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [library.id, library.rootPath, library.state, library.visible]);
  useEffect(() => {
    const sync = () => refresh(value => value + 1);
    window.addEventListener("luckyray:material-watch-sources", sync);
    window.addEventListener("luckyray:material-watch-status", sync);
    window.addEventListener("luckyray:material-library-error", sync);
    return () => {
      window.removeEventListener("luckyray:material-watch-sources", sync);
      window.removeEventListener("luckyray:material-watch-status", sync);
      window.removeEventListener("luckyray:material-library-error", sync);
    };
  }, []);
  const changedRoot = config.enabled && root && config.root !== root;
  return <div className="material-library-auto-import">
    <label><input type="checkbox" checked={config.enabled && !changedRoot} disabled={disabled || (!root && !config.enabled)}
      onChange={event => { try { setLibraryRootWatch(library.id, root || config.root, event.target.checked); setError(""); } catch (reason) { setError(String(reason)); } }}/>
      自动导入库目录中的素材</label>
    <details className="material-library-import-details"><summary tabIndex={0}>导入规则与目录</summary>
    <p title={root}>{root || "库目录不可用"}</p>
    <small>包含子文件夹，沿用此库的{library.storageMode === "managed" ? "托管复制（按内容去重）" : library.storageMode === "source" ? "源文件管理（按路径更新）" : "链接引用（按路径去重）"}；不删除源文件。内部文件、托管 assets 及其他库不扫描。关闭后不再开始新扫描，当前扫描会完成。</small>
    </details>
    {changedRoot && <small role="status">库目录已变化，请重新勾选确认。</small>}
    {config.enabled && status && <small role="status">{status.state === "scanning" ? "后台扫描中…" : status.state === "success" ? `上次导入 ${status.lastImportedCount ?? 0} 个，跳过 ${status.lastSkippedDuplicateCount ?? 0} 个重复项` : status.lastError || "等待扫描"}</small>}
    {config.enabled && !!status?.waitingFiles && <small role="status">等待 {status.waitingFiles} 个文件复制完成…</small>}
    {config.enabled && status?.watchError && <small role="status">{status.watchError}</small>}
    {error && <small className="material-library-error" role="alert">{error}</small>}
  </div>;
}
