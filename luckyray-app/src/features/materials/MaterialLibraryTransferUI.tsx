import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { materialLibrarySession, readMaterialLibraryPreference, type MaterialLibraryRegistry } from "../../core/services/materialLibraryContext";
import { materialLibraryTransfers, isMaterialTransferRunning, requestMaterialLibraryCopy, type MaterialLibraryCopyIntent, type MaterialTransferTask } from "../../core/services/materialLibraryTransfers";
import { toMaterialCatalogError } from "../../core/services/materialCatalog";
import { useApplicationModalSurface } from "../../app/applicationModalIsolation";
import "./materialLibraryTransfers.css";
import "./materialLibraryDialogPolish.css";
import { MATERIAL_LIBRARY_NAVIGATION_EVENT, publishMaterialLibraryNavigationBusy, type MaterialLibraryNavigationIntent } from "./materialLibraryNavigationProtocol";

type MovePlan = { libraryId: string; libraryName: string; oldRoot: string; newRoot: string; managedAssets: number; managedBytes: number; linkedAssets: number; excluded: string[] };
type MergePlan = { sourceId: string; targetId: string; sourceName: string; targetName: string; assets: { total: number; identicalContent: number; newCopies: number }; folders: { total: number; mapped: number; new: number; omitted: number }; tags: { total: number; mapped: number; new: number; omitted: number }; identical: { sourceName: string; targetName: string; metadataDiffers: boolean; metadataDifferences?: string[] }[]; nameConflicts: { name: string }[]; notes: string[] };
type TransferDialog = ({ kind: "export" | "restore" | "tasks"; libraryId: string; name: string } | { kind: "copy"; libraryId: string; name: string; intent: MaterialLibraryCopyIntent } | { kind: "move"; libraryId: string; name: string } | { kind: "merge"; libraryId: string; name: string }) & { watchRoots?: string[] };
const formatBytes = (bytes: number) => bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB` : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
function watchRoots(libraryId: string) {
  try {
    const sources: unknown = JSON.parse(readMaterialLibraryPreference("luckyray-material-watch-sources-v1", libraryId) ?? "[]");
    return Array.isArray(sources) ? sources.filter(s => s && s.enabled === true && typeof s.path === "string").map(s => s.path as string).slice(0, 64) : [];
  } catch { return []; }
}
const phaseLabel: Record<string, string> = { prepared: "准备中", running: "正在处理", verifying: "核验原文件", staging: "正在暂存", committing: "正在提交", completed: "已完成", partial: "部分完成", failed: "未完成", cancelled: "已取消", interrupted: "等待恢复" };
const kindLabel = { copy: "跨库复制", export: "完整库包备份", restore: "库包恢复为新库", move: "整库移动" };
export function MaterialLibraryTransferUI({ showControls = true }: { showControls?: boolean }) {
  const session = useSyncExternalStore(materialLibrarySession.subscribe, materialLibrarySession.getSnapshot);
  const transfers = useSyncExternalStore(materialLibraryTransfers.subscribe, materialLibraryTransfers.getSnapshot);
  const [dialog, setDialogState] = useState<TransferDialog | null>(null);
  const [target, setTarget] = useState(""); const [root, setRoot] = useState(""); const [packagePath, setPackagePath] = useState(""); const [name, setName] = useState("");
  const [movePlan, setMovePlan] = useState<MovePlan | null>(null); const [moveConfirm, setMoveConfirm] = useState<MovePlan | null>(null);
  const [mergeSource, setMergeSource] = useState(""); const [mergePlan, setMergePlan] = useState<MergePlan | null>(null); const [mergeConfirm, setMergeConfirm] = useState<MergePlan | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const dialogRef = useRef<TransferDialog | null>(null), dialogGeneration = useRef(0), previewGeneration = useRef(0), operationGeneration = useRef(0), previewOperation = useRef(false), mounted = useRef(true);
  const invalidatePreview = () => {
    previewGeneration.current++;
    setMovePlan(null); setMoveConfirm(null); setMergePlan(null); setMergeConfirm(null);
    if (previewOperation.current) {
      operationGeneration.current++; previewOperation.current = false; setBusy(false); setPreviewing(false);
    }
  };
  // Each logical opening owns its native dialog; queued close events from an old
  // element cannot dismiss a newly opened preview before showModal runs.
  const setDialog = (next: TransferDialog | null) => { invalidatePreview(); dialogGeneration.current++; dialogRef.current = next; setDialogState(next); };
  const locked = busy && !previewing;
  const modal = useRef<HTMLDialogElement>(null);
  const modalSurface = useApplicationModalSurface<HTMLDialogElement>(!!dialog, () => { if (!locked) setDialog(null); }, { closeOnEscape: !locked, closeOnBackdrop: !locked });
  const current = session.registry?.libraries.find(l => l.id === session.libraryId);
  const execute = async (work: () => Promise<unknown>, readOnlyPreview = false) => {
    const operation = ++operationGeneration.current;
    previewOperation.current = readOnlyPreview; setPreviewing(readOnlyPreview); setBusy(true); setError(null);
    try { await work(); }
    catch (e) { if (mounted.current && operation === operationGeneration.current) setError(toMaterialCatalogError(e).message); }
    finally { if (mounted.current && operation === operationGeneration.current) { previewOperation.current = false; setPreviewing(false); setBusy(false); } }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; previewGeneration.current++; operationGeneration.current++; }; }, []);
  useEffect(() => { if (dialogRef.current?.kind === "move" || dialogRef.current?.kind === "merge") setDialog(null); }, [session.libraryId]);
  useEffect(() => {
    const copy = (event: Event) => {
      if (locked) return;
      const intent = (event as CustomEvent<MaterialLibraryCopyIntent>).detail;
      setError(null); setTarget(""); setDialog({ kind: "copy", libraryId: intent.libraryId, name: session.registry?.libraries.find(l => l.id === intent.libraryId)?.name ?? "源素材库", intent });
    };
    window.addEventListener("luckyray:material-library-copy", copy);
    return () => window.removeEventListener("luckyray:material-library-copy", copy);
  }, [session.registry, locked]);
  useEffect(() => {
    if (!session.libraryId) return;
    const owner = session.libraryId; let current = true;
    void materialLibraryTransfers.load(owner);
    // After restart, recover other registered owners' unfinished work even if their
    // libraries are hidden/offline. Each list still requires an explicit owner.
    void materialLibrarySession.request<MaterialLibraryRegistry>({ op: "registry", include_hidden: true }, null).then(registry => {
      if (current) for (const library of registry.libraries) if (library.id !== owner) void materialLibraryTransfers.load(library.id, true);
    }).catch(() => {});
    return () => { current = false; };
  }, [session.libraryId]);
  useEffect(() => { if (!transfers.tasks.some(isMaterialTransferRunning)) return; const timer = window.setInterval(() => { void materialLibraryTransfers.refresh(); }, 500); return () => window.clearInterval(timer); }, [transfers.tasks]);
  useEffect(() => { if (dialog) { if (!modal.current?.open) modal.current?.showModal(); } else modal.current?.close(); }, [dialog]);
  const chooseRoot = async () => { const { open } = await import("@tauri-apps/plugin-dialog"); const selected = await open({ directory: true, multiple: false, title: "选择新库的空目录" }); if (typeof selected === "string") setRoot(selected); };
  const chooseMoveRoot = async (libraryId: string) => {
    const generation = ++previewGeneration.current;
    const active = () => mounted.current && generation === previewGeneration.current && dialogRef.current?.kind === "move" && dialogRef.current.libraryId === libraryId;
    setMovePlan(null); setMoveConfirm(null); setRoot("");
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false, title: "选择整库移动后的空目录" });
    if (!active() || typeof selected !== "string") return;
    setRoot(selected);
    const plan = await materialLibrarySession.request<MovePlan>({ op: "moveLibraryPreview", root: selected }, libraryId);
    if (!active()) return;
    if (plan.libraryId !== libraryId) throw new Error("移动预览的库身份不一致，请重新选择目录");
    setRoot(plan.newRoot); setMovePlan(plan);
  };
  const choosePackage = async () => { const { open } = await import("@tauri-apps/plugin-dialog"); const selected = await open({ multiple: false, title: "选择完整素材库包", filters: [{ name: "LuckyRay 素材库包", extensions: ["lrlibrary"] }] }); if (typeof selected === "string") setPackagePath(selected); };
  const submit = async () => {
    if (!dialog || dialog.kind === "tasks") return;
    const frozen = dialog;
    const confirmedMove = movePlan, confirmedMerge = mergePlan;
    await execute(async () => {
      if (frozen.kind === "copy") await materialLibraryTransfers.start(frozen.libraryId, { op: "transferCopy", targetLibraryId: target, selection: frozen.intent.selection });
      else if (frozen.kind === "move") {
        if (!confirmedMove || moveConfirm !== confirmedMove || confirmedMove.libraryId !== frozen.libraryId || confirmedMove.newRoot !== root) throw new Error("移动方案已变化，请重新预览并确认");
        await materialLibraryTransfers.start(confirmedMove.libraryId, { op: "moveLibrary", root: confirmedMove.newRoot });
      } else if (frozen.kind === "merge") {
        if (!confirmedMerge || mergeConfirm !== confirmedMerge || confirmedMerge.sourceId !== mergeSource || confirmedMerge.targetId !== frozen.libraryId) throw new Error("合并方案已变化，请重新预览并确认");
        await materialLibraryTransfers.start(confirmedMerge.sourceId, { op: "transferCopy", targetLibraryId: confirmedMerge.targetId, selection: {} });
      }
      else if (frozen.kind === "restore") await materialLibraryTransfers.start(frozen.libraryId, { op: "transferRestore", packagePath, root, name, watchRoots: frozen.watchRoots });
      else {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const destination = await save({ title: "完整素材库包备份", defaultPath: `${frozen.name.replace(/[\\/:*?"<>|]/g, "_")}.lrlibrary`, filters: [{ name: "LuckyRay 素材库包", extensions: ["lrlibrary"] }] });
        if (!destination) return;
        await materialLibraryTransfers.start(frozen.libraryId, { op: "transferExport", destination, watchRoots: frozen.watchRoots });
      }
      setDialog({ kind: "tasks", libraryId: frozen.libraryId, name: frozen.name });
    });
  };
  const open = (kind: "export" | "restore" | "tasks", libraryId = session.libraryId, libraryName = current?.name) => { if (!libraryId || !libraryName) return; setError(null); setRoot(""); setPackagePath(""); setName(`${libraryName} · 恢复`); setDialog({ kind, libraryId, name: libraryName, watchRoots: watchRoots(libraryId) }); };
  const openMove = (libraryId: string, libraryName: string) => { setError(null); setRoot(""); setDialog({ kind: "move", libraryId, name: libraryName }); };
  const openMerge = (libraryId: string, libraryName: string) => { setError(null); setMergeSource(""); setDialog({ kind: "merge", libraryId, name: libraryName }); };
  const chooseMergeSource = (sourceId: string) => {
    invalidatePreview(); setMergeSource(sourceId); setError(null);
    const owner = dialogRef.current; if (!sourceId || owner?.kind !== "merge") return;
    const generation = previewGeneration.current;
    void execute(async () => {
      const plan = await materialLibrarySession.request<MergePlan>({ op: "mergeLibraryPreview", sourceId }, owner.libraryId);
      if (!mounted.current || generation !== previewGeneration.current || dialogRef.current !== owner) return;
      if (plan.sourceId !== sourceId || plan.targetId !== owner.libraryId) throw new Error("合并预览的库身份不一致，请重新选择来源");
      setMergePlan(plan);
    }, true);
  };
  useEffect(() => {
    const requested = (event: Event) => {
      if (locked) return;
      const intent = (event as CustomEvent<MaterialLibraryNavigationIntent>).detail;
      if (!intent.libraryId || intent.fromManagement) return;
      if (intent.action === "copyLibrary") requestMaterialLibraryCopy({ libraryId: intent.libraryId, selection: {}, label: "整个素材库" });
      else if (intent.action === "moveLibrary") openMove(intent.libraryId, intent.name);
      else if (intent.action === "mergeLibrary") openMerge(intent.libraryId, intent.name);
      else if (intent.action === "export" || intent.action === "restore" || intent.action === "tasks") open(intent.action, intent.libraryId, intent.name);
    };
    window.addEventListener(MATERIAL_LIBRARY_NAVIGATION_EVENT, requested);
    return () => window.removeEventListener(MATERIAL_LIBRARY_NAVIGATION_EVENT, requested);
  }, [locked]);
  useEffect(() => {
    publishMaterialLibraryNavigationBusy("transfer", busy);
    return () => publishMaterialLibraryNavigationBusy("transfer", false);
  }, [busy]);
  const running = transfers.tasks.filter(isMaterialTransferRunning).length;
  return <>
    {showControls && <div className="material-transfer-toolbar" aria-label="素材库备份与恢复">
      <button type="button" disabled={!current || current.state !== "ready"} onClick={() => open("export")}>完整库包备份</button>
      <button type="button" disabled={!current} onClick={() => open("restore")}>从库包恢复新库</button>
      <button type="button" disabled={!current} onClick={() => open("tasks")}>库任务{running ? ` · ${running} 进行中` : transfers.tasks.length ? ` · ${transfers.tasks.length}` : ""}</button>
      {running > 0 && <span role="status">任务按开始时的库执行，可继续切库浏览</span>}
    </div>}
    {!showControls && !dialog && (error || transfers.error) && <p className="material-library-error" role="alert">{error || transfers.error}</p>}
    <dialog key={dialogGeneration.current} ref={element => { modal.current = element; modalSurface.surfaceRef.current = element; }} onKeyDown={modalSurface.onSurfaceKeyDown} className={`material-library-dialog material-transfer-dialog${dialog?.kind === "tasks" ? " material-library-tasks-dialog" : ""}`} onCancel={event => { event.preventDefault(); if (!locked) setDialog(null); }} onClose={event => { if (!locked && dialog && dialogRef.current === dialog && event.currentTarget === modal.current && !event.currentTarget.open) setDialog(null); }}>
      <header><h2>{dialog?.kind === "copy" ? "复制到其他素材库" : dialog?.kind === "move" ? "移动整库到新位置" : dialog?.kind === "merge" ? "合并其他素材库到此库" : dialog?.kind === "export" ? "备份完整素材库" : dialog?.kind === "restore" ? "从完整库包恢复新库" : "素材库任务"}</h2><button type="button" aria-label="关闭素材库任务" disabled={locked} onClick={() => setDialog(null)}>×</button></header>
      {dialog && dialog.kind !== "tasks" && <p className="material-library-help">{dialog.kind === "restore" ? "恢复为一个新库，原有库与笔记引用保留。所需媒体成为独立托管副本，监控目录需在新电脑重新设置。" : dialog.kind === "move" ? "把整个素材库移动到新的空目录。库 ID、素材身份、分类与标签保持不变；先复制并核验，成功后才切换登记。原文件保留，可随时手动清理。" : dialog.kind === "merge" ? `把所选素材库的全部素材合并进「${dialog.name}」。源库登记与文件保持不变；内容相同的素材跳过并沿用此库版本，同名不同内容的素材同时保留。` : `源库：${dialog.name}。${dialog.kind === "copy" ? `${dialog.intent.label}；目标同内容素材会跳过并保留其原信息。` : "包内含普通素材的媒体、分类、标签、智能规则与显示偏好。原件缺失或变化时，本次备份不会报完整成功。"}`}</p>}
      {dialog?.kind === "copy" && <label>目标素材库<select aria-label="目标素材库" value={target} onChange={event => setTarget(event.target.value)} disabled={busy}><option value="">选择另一个库</option>{session.registry?.libraries.filter(l => l.id !== dialog.libraryId && l.visible && l.state === "ready").map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
      {dialog?.kind === "restore" && <>
        <label>新库名称<input aria-label="恢复新库名称" value={name} maxLength={120} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label>完整库包<div className="material-library-directory"><input aria-label="完整库包路径" value={packagePath} readOnly /><button type="button" disabled={busy} onClick={() => { void execute(choosePackage); }}>选择库包…</button></div></label>
        <label>新库空目录<div className="material-library-directory"><input aria-label="恢复新库空目录" value={root} readOnly /><button type="button" disabled={busy} onClick={() => { void execute(chooseRoot); }}>选择目录…</button></div></label>
      </>}
      {dialog?.kind === "move" && <>
        <label>目标空目录<div className="material-library-directory"><input aria-label="整库移动目标目录" value={root} readOnly placeholder="选择一个现有空目录" /><button type="button" disabled={locked} onClick={() => { void execute(() => chooseMoveRoot(dialog.libraryId), true); }}>选择目录…</button></div></label>
        {movePlan && <div className="material-transfer-move-plan" aria-label="移动影响预览">
          <p><strong>{movePlan.libraryName}</strong>：{movePlan.managedAssets} 个托管文件 · 约 {formatBytes(movePlan.managedBytes)} 将复制到新位置。</p>
          <p className="material-library-location" title={movePlan.oldRoot}>原位置：{movePlan.oldRoot}</p>
          <p className="material-library-location" title={movePlan.newRoot}>新位置：{movePlan.newRoot}</p>
          <label className="material-transfer-move-confirm"><input type="checkbox" checked={moveConfirm === movePlan} onChange={event => setMoveConfirm(event.target.checked ? movePlan : null)} disabled={busy} />我确认把以上内容移动到新位置（原文件保留，成功后在原位置写入恢复说明）</label>
          {movePlan.excluded.length > 0 && <details><summary>不参与移动的内容</summary><ul>{movePlan.excluded.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
        </div>}
      </>}
      {dialog?.kind === "merge" && <>
        <label>合并来源<select aria-label="合并来源素材库" value={mergeSource} onChange={event => chooseMergeSource(event.target.value)} disabled={locked}>
          <option value="">选择要合并进来的素材库</option>
          {session.registry?.libraries.filter(l => l.id !== dialog.libraryId && l.visible && l.state === "ready").map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select></label>
        {mergePlan && <div className="material-transfer-move-plan" aria-label="合并影响预览">
          <p><strong>{mergePlan.sourceName}</strong> → <strong>{mergePlan.targetName}</strong>：共 {mergePlan.assets.total} 个素材 · {mergePlan.assets.newCopies} 个将复制 · {mergePlan.assets.identicalContent} 个内容相同跳过。</p>
          <p>分类：{mergePlan.folders.mapped} 个并入相同父级下的同名分类 · {mergePlan.folders.new} 个新建 · {mergePlan.folders.omitted} 个不复制；标签：{mergePlan.tags.mapped} 个并入同名 · {mergePlan.tags.new} 个新建 · {mergePlan.tags.omitted} 个不复制。</p>
          <label className="material-transfer-move-confirm"><input type="checkbox" checked={mergeConfirm === mergePlan} onChange={event => setMergeConfirm(event.target.checked ? mergePlan : null)} disabled={busy} />我确认按以上方案合并（源库保持不变，之后可另行从列表移除）</label>
          {mergePlan.identical.length > 0 && <details><summary>内容相同、将跳过的素材</summary><ul>{mergePlan.identical.slice(0, 20).map((item, index) => <li key={index}>{item.sourceName}{item.targetName !== item.sourceName ? ` → 沿用「${item.targetName}」` : ""}{item.metadataDiffers ? ` · 人工信息不同${item.metadataDifferences?.length ? `（${item.metadataDifferences.join("、")}）` : ""}，保留目标库版本；源库版本仍在源库` : ""}</li>)}</ul></details>}
          {mergePlan.nameConflicts.length > 0 && <details><summary>同名但内容不同、将同时保留</summary><ul>{mergePlan.nameConflicts.slice(0, 20).map((item, index) => <li key={index}>{item.name}</li>)}</ul></details>}
          <details><summary>合并说明</summary><ul>{mergePlan.notes.map((item, index) => <li key={index}>{item}</li>)}</ul></details>
        </div>}
      </>}
      {dialog?.kind === "tasks" && <div className="material-transfer-tasks">{transfers.tasks.length ? transfers.tasks.map(task => <TransferRow key={task.taskId} task={task} busy={busy} perform={execute} close={() => setDialog(null)} />) : <div className="material-transfer-empty"><svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01"/></svg><strong>暂无素材库任务</strong><p>复制、备份和恢复的结果会保留在这里。</p></div>}</div>}
      {(error || transfers.error) && <p className="material-library-error" role="alert">{error || transfers.error}</p>}
      <footer><button type="button" disabled={locked} onClick={() => setDialog(null)}>{dialog?.kind === "tasks" ? "完成" : "取消"}</button>{dialog && dialog.kind !== "tasks" && <button type="button" disabled={busy || (dialog.kind === "copy" && !target) || (dialog.kind === "restore" && (!name.trim() || !root || !packagePath)) || (dialog.kind === "move" && (!movePlan || moveConfirm !== movePlan || movePlan.libraryId !== dialog.libraryId || movePlan.newRoot !== root)) || (dialog.kind === "merge" && (!mergePlan || mergeConfirm !== mergePlan || mergePlan.sourceId !== mergeSource || mergePlan.targetId !== dialog.libraryId))} onClick={() => { void submit(); }}>{busy ? "正在准备…" : dialog.kind === "copy" ? "开始复制" : dialog.kind === "move" ? "开始移动" : dialog.kind === "merge" ? "开始合并" : dialog.kind === "export" ? "选择位置并备份" : "恢复为新库"}</button>}</footer>
    </dialog>
  </>;
}
function TransferRow({ task, busy, perform, close }: { task: MaterialTransferTask; busy: boolean; perform: (work: () => Promise<unknown>) => Promise<void>; close: () => void }) {
  const running = isMaterialTransferRunning(task);
  return <section className="material-transfer-task" aria-label={`${kindLabel[task.kind]} ${phaseLabel[task.phase] ?? task.phase}`}>
    <div className="material-transfer-task-heading"><strong>{kindLabel[task.kind]}</strong><span>{phaseLabel[task.phase] ?? task.phase}</span>
      {running && task.phase !== "committing" && <button type="button" disabled={busy} onClick={() => { void perform(() => materialLibraryTransfers.cancel(task)); }}>取消任务</button>}
      {!running && task.retryable && <button type="button" disabled={busy} onClick={() => { void perform(() => materialLibraryTransfers.retry(task)); }}>按原目标重试</button>}</div>
    <p className="material-library-location">{task.sourceName}{task.targetName ? ` → ${task.targetName}` : ""}</p>
    <p>{task.completed} / {task.total} 项 · 成功 {task.copied} · 跳过 {task.skipped} · 失败 {task.failed}</p>
    {running && <><progress aria-label="素材库任务进度" max={task.currentTotalBytes || Math.max(task.total, 1)} value={task.currentTotalBytes ? task.currentBytes : task.completed} /><p className="material-transfer-current">{task.currentFile ?? "正在准备"}{task.phase === "committing" ? " · 正在登记完整结果" : ""}</p></>}
    {task.error && <p className="material-library-error" role="alert">{task.error}</p>}
    {task.outputPath && <p className="material-library-location" title={task.outputPath}>{task.outputPath}</p>}
    {task.kind === "restore" && task.phase === "completed" && task.targetLibraryId && <button type="button" disabled={busy} onClick={() => { void perform(async () => { await materialLibrarySession.refresh(); await materialLibrarySession.select(task.targetLibraryId!); close(); }); }}>打开恢复的新库</button>}
    {task.items.length > 0 && <details><summary>逐项结果{task.failed ? ` · ${task.failed} 项需要处理` : ""}</summary><ul>{task.items.map((item, index) => <li key={`${item.assetId}:${index}`}><span>{item.name}</span><span>{({ pending: "等待", copied: "已完成", skipped: "目标已存在", failed: "失败", cancelled: "已取消" } as Record<string, string>)[item.state] ?? item.state}{item.error ? `：${item.error}` : ""}</span></li>)}</ul></details>}
  </section>;
}
