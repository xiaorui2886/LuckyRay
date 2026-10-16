import { AttachmentPortabilitySection } from "./AttachmentPortabilitySection";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getVaultAttachmentWorkflow, listAttachmentOperations, getAttachmentLinkUpdatePolicy, setAttachmentLinkUpdatePolicy, type AttachmentLinkUpdatePolicy } from "../../core/services/vaultAttachments";
import { ensureActiveKnowledgeUiSource } from "../../core/services/knowledge";
import { readActiveKnowledgeWriteSource } from "../../core/services/knowledgeSource";
import { attachmentIssueLabel, attachmentWorkflowBusy } from "../../core/services/vaultAttachmentWorkflow";
import { importIssueMessage } from './ImportResultNotice';
import "./vaultAttachments.css";
import { AttachmentHandlingSelect } from "./AttachmentHandlingSelect";

const resultLabels: Record<string, string> = { complete: "已完成", "complete-with-unresolved": "已处理可确定项，部分引用需要关注", partial: "部分完成，可继续或恢复", "rolled-back": "引用变更已回滚" };
export type VaultAttachmentsPanelProps = { vaultId: string; relativePath: string | null; notePaths: string[]; hasUnsavedChanges: () => boolean; saveAffected: (paths: string[]) => Promise<void>; chooseDirectory: () => Promise<string | null> };

/** Content inside the existing Knowledge settings dialog. No extra modal,
 * sidebar entry, or separate import wizard. Closing settings leaves jobs alive. */
export function VaultAttachmentsPanel({ vaultId, relativePath, notePaths, hasUnsavedChanges, saveAffected, chooseDirectory }: VaultAttachmentsPanelProps) {
  const workflow = getVaultAttachmentWorkflow(vaultId);
  const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot, workflow.getSnapshot);
  const busy = attachmentWorkflowBusy(state);
  const [action, setAction] = useState("collect");
  const [scope, setScope] = useState("current");
  const [oldPath, setOldPath] = useState("");
  const [newPath, setNewPath] = useState("");
  const [recordId, setRecordId] = useState("");
  const [records, setRecords] = useState<string[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [recordError, setRecordError] = useState("");
  const [message, setMessage] = useState("");
  const [linkPolicy, setLinkPolicy] = useState<AttachmentLinkUpdatePolicy | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  useEffect(() => {
    let cancelled=false;setLinkPolicy(null);
    void getAttachmentLinkUpdatePolicy(vaultId).then(value=>{if(!cancelled)setLinkPolicy(value);}).catch(error=>{if(!cancelled)setMessage(String(error));});
    return ()=>{cancelled=true;};
  },[vaultId]);
  const changeLinkPolicy = async (policy: AttachmentLinkUpdatePolicy) => {
    const source = readActiveKnowledgeWriteSource();
    setPolicyBusy(true);setMessage('');
    try {
      const active=await ensureActiveKnowledgeUiSource();
      if(active.vaultId!==vaultId || readActiveKnowledgeWriteSource()!==source)throw new Error('知识库已切换，请重新打开设置');
      const savedPolicy = await setAttachmentLinkUpdatePolicy(vaultId,active.sourceEpoch,policy);
      if (readActiveKnowledgeWriteSource()===source) setLinkPolicy(savedPolicy);
    }catch(error){if(readActiveKnowledgeWriteSource()===source)setMessage(String(error));}finally{setPolicyBusy(false);}
  };
  const [maintenanceOpen, setMaintenanceOpen] = useState(state.phase !== "idle");
  const generation = useRef(0);
  const refreshRecords = async () => {
    const request = ++generation.current;
    setLoadingRecords(true); setRecordError("");
    try { const next = await listAttachmentOperations(vaultId); if (request === generation.current) setRecords(next); }
    catch (error) { if (request === generation.current) setRecordError(String(error)); }
    finally { if (request === generation.current) setLoadingRecords(false); }
  };
  useEffect(() => { if (action === "recover" && maintenanceOpen) void refreshRecords(); return () => { generation.current += 1; }; }, [action, maintenanceOpen, vaultId]);
  const selectedPaths = scope === "current" ? relativePath ? [relativePath] : [] : notePaths;
  const start = () => {
    setMessage("");
    if (hasUnsavedChanges()) { setMessage("请先保存正在编辑的笔记，再进行维护。"); return; }
    if (action === "collect") void workflow.collect(selectedPaths);
    else if (action === "rename") void workflow.rename(oldPath.trim(), newPath.trim());
  };
  const issues = state.result?.issues || state.plan?.issues || [];
  const receipt = state.importReceipt;
  return <section className="notes-vault-section vault-attachment-settings" aria-label="附件设置">
    <div className="notes-vault-section-heading"><h3>附件</h3><span>统一处理与显示</span></div>
    <AttachmentHandlingSelect vaultId={vaultId} disabled={busy} />
    <div className="vault-attachment-rule"><span>新附件位置</span><code>attachments/</code></div>
    <label className="vault-attachment-rule">附件移动后更新链接<select value={linkPolicy || 'ask'} disabled={linkPolicy===null || policyBusy || busy} onChange={event=>void changeLinkPolicy(event.target.value as AttachmentLinkUpdatePolicy)}><option value="ask">每次询问</option><option value="always">本库始终更新可确认的链接</option></select></label>
    <p className="notes-index-popover-note">拖入文件、插入素材和导入笔记共用上述选择，自动生成有效链接。点击笔记收藏旁的附件按钮可浏览附件。</p>
    <p className="notes-index-popover-note">已有知识库沿用原附件位置和链接，打开时不会转换旧文件。删除笔记不会自动删除附件。</p>
    {receipt && receipt.errors.length > 0 && <div className="vault-attachment-state" role="status">
      <div className="vault-attachment-state-heading"><strong>导入结果 · {receipt.copiedCount} 篇笔记已导入</strong><button type="button" onClick={() => workflow.clearImport()}>收起结果</button></div>
      <p>{receipt.errors.length} 项需要处理。{receipt.conflictRenamedCount > 0 ? `${receipt.conflictRenamedCount} 项同名笔记已另存，原文件未覆盖。` : ""}</p>
      <ul className="vault-attachment-issues">{receipt.errors.map((error, index) => <li key={index}><strong>{importIssueMessage(error)}</strong><span>{error.sourcePath}</span></li>)}</ul>
    </div>}
    <AttachmentPortabilitySection vaultId={vaultId} notePaths={notePaths} saveAffected={saveAffected} chooseDirectory={chooseDirectory} />
    <details className="vault-attachment-maintenance" open={maintenanceOpen} onToggle={event => setMaintenanceOpen(event.currentTarget.open)}>
      <summary>附件维护 <span>{busy ? "处理中，可关闭设置" : "仅在需要整理旧文件时使用"}</span></summary>
      <div className="vault-attachment-form">
        <label>维护操作<select value={action} disabled={busy || state.phase === "review"} onChange={event => { setAction(event.target.value); setMessage(""); workflow.reset(); }}><option value="collect">收集旧素材附件</option><option value="rename">移动或重命名附件</option><option value="recover">恢复已有操作</option></select></label>
        {state.phase === "idle" && <>
          {action === "collect" && <>
            <label>处理范围<select value={scope} onChange={event => setScope(event.target.value)}><option value="current" disabled={!relativePath}>当前笔记{relativePath ? ` · ${relativePath.split("/").pop()}` : "（请先打开一篇笔记）"}</option><option value="vault">当前知识库 · {notePaths.length} 篇笔记</option></select></label>
            <p>仅收集该范围中能够唯一定位的旧素材附件，并更新对应引用；素材原件保留。确认范围后自动处理，只有未解析引用或较大批次才需要进一步确认。</p>
          </>}
          {action === "rename" && <>
            <label>当前附件路径<input value={oldPath} onChange={event => setOldPath(event.target.value)} placeholder="attachments/图片.png" /></label>
            <label>新位置或名称<input value={newPath} onChange={event => setNewPath(event.target.value)} placeholder="attachments/新名称.png" /></label>
            <p>路径相对于知识库。先确认引用更新范围，再移动附件。操作期间暂停其他编辑器写入；最后检查后新建的旧引用仍可能受影响。</p>
          </>}
          {action === "recover" && <>
            <label>操作记录<select value={recordId} disabled={loadingRecords} onChange={event => setRecordId(event.target.value)}><option value="">{loadingRecords ? "正在读取…" : records.length ? "选择本库记录" : "暂无操作记录"}</option>{records.map((id, index) => <option value={id} key={id}>记录 {index + 1} · {id.slice(0, 8)}…{id.slice(-4)}</option>)}</select></label>
            <p>继续剩余步骤或回滚引用。已复制的附件保留，外部修改不会被覆盖。</p>
            {recordError && <p role="alert" className="vault-attachment-error">{recordError}</p>}
          </>}
        </>}
      </div>
      {state.phase !== "idle" && <div className="vault-attachment-state" role="status" aria-live="polite">
        <strong>{state.title} · {busy ? state.phase === "planning" ? "正在检查" : "正在处理" : state.phase === "review" ? "请确认影响范围" : state.phase === "failed" ? "未完成" : state.phase === "cancelled" ? "已停止，未执行写入" : state.title === "附件引用检查" ? "只读检查完成" : state.result ? resultLabels[state.result.status] || state.result.status : issues.length ? "没有可执行的变更，部分引用需要关注" : "没有需要处理的旧附件"}</strong>
        {state.plan && <p>{state.plan.documentCount} 项笔记变更 · {state.plan.attachmentCount} 项附件变更 · 复制 {(state.plan.copyBytes / 1048576).toFixed(2)} MB · 备份 {(state.plan.backupBytes / 1048576).toFixed(2)} MB</p>}
        {state.title === "附件引用检查" && <p>本次仅刷新诊断，没有复制或修改文件。历史操作记录保持原样。</p>}
        {state.result && <p>已处理 {state.result.completedFiles} / {state.result.totalFiles} 项。请重新打开笔记查看内容更新。</p>}
        {busy && <p>可随时关闭设置，任务会继续。可请求停止后续步骤，实际停止位置以返回结果为准；已完成部分不会被撤销。{state.cancelRequested ? "已请求停止。" : ""}</p>}
        {state.error && <p role="alert" className="vault-attachment-error">{state.error}</p>}
        {issues.length > 0 && <ul className="vault-attachment-issues">{issues.map((issue, index) => <li key={index}><strong>{attachmentIssueLabel(issue.status)}</strong><span>{issue.document} · {issue.target}</span></li>)}</ul>}
        {state.plan && state.plan.files.length > 0 && <details><summary>查看 {state.plan.files.length} 项文件变更</summary><ul className="vault-attachment-files">{state.plan.files.map(file => <li key={file.relativePath}><span>{file.relativePath}</span><span>{file.before === null ? "新建" : file.after === null ? "移除原路径" : "更新引用"}</span></li>)}</ul></details>}
        {state.result && <details><summary>恢复信息</summary><p>记录 {state.result.operationId}</p><p>{state.result.recoveryPath}</p></details>}
      </div>}
      {message && <p role="alert" className="vault-attachment-error">{message}</p>}
      <div className="vault-attachment-actions">
        {busy ? <button type="button" disabled={state.cancelRequested} onClick={() => void workflow.stop()}>停止后续步骤</button>
          : state.phase === "review" ? <><button type="button" onClick={() => workflow.reset()}>取消本次维护</button><button type="button" className="primary" onClick={() => void workflow.confirm(hasUnsavedChanges)}>{issues.length ? "仅处理可确定项" : "确认执行"}</button></>
          : state.phase !== "idle" ? <button type="button" onClick={() => workflow.reset()}>返回维护选项</button>
          : action === "recover" ? <><button type="button" disabled={loadingRecords} onClick={() => void refreshRecords()}>刷新记录</button><button type="button" disabled={!recordId} onClick={() => { if (hasUnsavedChanges()) { setMessage("请先保存正在编辑的笔记。"); return; } void workflow.recover(recordId, true); }}>回滚引用</button><button type="button" className="primary" disabled={!recordId} onClick={() => { if (hasUnsavedChanges()) { setMessage("请先保存正在编辑的笔记。"); return; } void workflow.recover(recordId, false); }}>继续操作</button></>
          : <>{action === "collect" && <button type="button" disabled={!selectedPaths.length} onClick={() => void workflow.inspect(selectedPaths)}>只检查引用</button>}<button type="button" className="primary" disabled={action === "collect" ? !selectedPaths.length : !oldPath.trim() || !newPath.trim()} onClick={start}>{action === "collect" ? "确认范围并收集" : "检查引用更新"}</button></>}
      </div>
    </details>
  </section>;
}
