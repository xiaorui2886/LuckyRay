import { useEffect, useRef, useState } from "react";
import { readActiveKnowledgeWriteSource } from "../../core/services/knowledgeSource";
import { readNoteRecovery, recoverNoteVersion, recoveryCopyName, type NoteRecoveryItem, type NoteRecoverySnapshot } from "../../core/services/noteRecovery";

export function NoteRecoveryPanel({ vaultId, hasUnsavedChanges, saveAffected, disabled }: {
  vaultId: string; hasUnsavedChanges: () => boolean; saveAffected: (paths: string[]) => Promise<void>; disabled: boolean;
}) {
  const [snapshot, setSnapshot] = useState<NoteRecoverySnapshot | null>(null);
  const [item, setItem] = useState<NoteRecoveryItem | null>(null);
  const [slot, setSlot] = useState("retained");
  const [destination, setDestination] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, [vaultId]);
  const refresh = async () => {
    const request = ++generation.current;
    setBusy(true); setMessage(""); setItem(null);
    try { const value = await readNoteRecovery(vaultId); if (request === generation.current) setSnapshot(value); }
    catch (error) { if (request === generation.current) { setSnapshot(null); setMessage(String(error)); } }
    finally { if (request === generation.current) setBusy(false); }
  };
  const select = (record: NoteRecoveryItem | null) => {
    setItem(record); setSlot(record?.versions[0]?.slot || "retained");
    setDestination(record ? recoveryCopyName(record.originalPath) : ""); setMessage("");
  };
  const run = async (restore: boolean) => {
    if (!item || busy || disabled) return;
    if (hasUnsavedChanges()) { setMessage("请先保存或处理编辑器中的草稿和保存冲突。"); return; }
    const source = readActiveKnowledgeWriteSource();
    const request = ++generation.current;
    setBusy(true); setMessage("");
    try {
      await saveAffected([item.originalPath]);
      if (request !== generation.current || readActiveKnowledgeWriteSource() !== source) return;
      const path = await recoverNoteVersion(vaultId, item, slot, restore ? null : destination.trim(), restore);
      if (request !== generation.current || readActiveKnowledgeWriteSource() !== source) return;
      setItem(null);
      setMessage(restore ? `已恢复原路径：${path}。请刷新并重新打开笔记。` : `已另存：${path}。原事务仍需检查，现有版本和记录均保留；请刷新并重新打开副本。`);
      const next = await readNoteRecovery(vaultId);
      if (request === generation.current && readActiveKnowledgeWriteSource() === source) setSnapshot(next);
    } catch (error) {
      if (request === generation.current && readActiveKnowledgeWriteSource() === source) {
        setMessage(`${String(error)}。操作未确认；可能已留下副本，请刷新记录并检查文件，勿直接重复执行。`); setItem(null);
      }
    } finally { if (request === generation.current) setBusy(false); }
  };
  const version = item?.versions.find(value => value.slot === slot);
  return <details className="vault-attachment-maintenance" data-note-recovery="panel">
    <summary>笔记历史与失败恢复</summary>
    <p>Mac 使用对象和版本检查检测外部并发修改。移动或保存中断时可能同时保留多个文件，保留副本不代表事务已完成。</p>
    <p>可读版本可另存为新文件；删除的原 inode 仅在原路径空闲时恢复。这里不会覆盖现有内容、修改权限或清理历史。无法读取的版本（包括权限为 000 的文件）需人工核实。</p>
    <p>副本保存在原目录中以保持相对附件引用。恢复原路径只处理选中记录，不会撤销整个批次；完整维护操作请使用下方“恢复已有操作”。</p>
    <button type="button" data-note-recovery="refresh" disabled={busy || disabled} onClick={() => void refresh()}>{busy ? "正在处理…" : "读取恢复记录"}</button>
    {snapshot && <div className="vault-attachment-form">
      {(snapshot.startupBlocked || snapshot.scanIncomplete || snapshot.issues.length > 0 || snapshot.records.some(record => record.pending)) && <p role="alert">存在未确认记录或未能完整检查的文件。正常编辑仍可能受保护检查阻止，另存副本不会解除原事务。</p>}
      <label>记录<select data-note-recovery="records" disabled={busy || disabled} value={item?.recordPath || ""} onChange={event => select(snapshot.records.find(record => record.recordPath === event.target.value) || null)}>
        <option value="">{snapshot.records.length ? "选择版本记录" : "没有可读取的记录"}</option>
        {snapshot.records.map(record => <option key={record.recordPath} value={record.recordPath}>{record.pending ? "待检查" : "历史"} · {record.originalPath} · {record.recordPath}</option>)}
      </select></label>
      {snapshot.issues.map(issue => <p className="vault-attachment-error" key={issue.recordPath}>{issue.recordPath}：记录或对象无法验证，文件保留。</p>)}
    </div>}
    {item && <div className="vault-attachment-form">
      {!item.canRestore && <p role="status" data-note-recovery="restore-unavailable">此记录不能恢复到原路径。请检查现有文件，或将可读版本另存；不会覆盖现有内容。</p>}
      <label>可读版本<select data-note-recovery="versions" disabled={busy} value={slot} onChange={event => setSlot(event.target.value)}>{item.versions.map(value => <option key={value.slot} value={value.slot}>{value.slot === "retained" ? "保留版本" : "当前路径版本"} · {value.bytes} 字节 · {value.revision.slice(0, 12)}</option>)}</select></label>
      {item.unavailableVersions > 0 && <p role="alert">{item.unavailableVersions} 个版本缺少读取权限或对象身份不符，未作为恢复来源。</p>}
      {version?.changedSinceRecord && <p role="alert">此 inode 的内容在记录后发生过变化，可能来自延迟写入。这里只允许将当前可读内容另存为新副本，不会把原事务判为完成。</p>}
      {version?.preview != null && <details><summary>查看文本开头（最多 4096 字符）</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{version.preview}</pre></details>}
      <label>副本路径（原目录中的新名称）<input data-note-recovery="destination" value={destination} disabled={busy} onChange={event => setDestination(event.target.value)} /></label>
      <div className="vault-attachment-actions"><button type="button" data-note-recovery="copy" disabled={busy || disabled || !version || !destination.trim()} onClick={() => void run(false)}>另存此版本</button>
        <button type="button" data-note-recovery="restore" disabled={busy || disabled || !item.canRestore} onClick={() => void run(true)}>恢复删除前的原文件</button></div>
    </div>}
    {message && <p role="status" data-note-recovery="status" className="vault-attachment-error">{message}</p>}
  </details>;
}
