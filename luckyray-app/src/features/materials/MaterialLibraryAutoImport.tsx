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
    <label title={root || undefined}><input type="checkbox" checked={config.enabled && !changedRoot} disabled={disabled || (!root && !config.enabled)}
      onChange={event => { try { setLibraryRootWatch(library.id, root || config.root, event.target.checked); setError(""); } catch (reason) { setError(String(reason)); } }}/>
      自动导入库目录中的素材</label>
    {changedRoot && <small role="status">库目录已变化，请重新勾选确认。</small>}
    {config.enabled && status?.state === "scanning" && <small role="status">后台扫描中…</small>}
    {config.enabled && status?.lastError && <small className="material-library-error" role="alert">{status.lastError}</small>}
    {config.enabled && !!status?.waitingFiles && <small role="status">等待 {status.waitingFiles} 个文件复制完成…</small>}
    {config.enabled && status?.watchError && <small role="status">{status.watchError}</small>}
    {error && <small className="material-library-error" role="alert">{error}</small>}
  </div>;
}
