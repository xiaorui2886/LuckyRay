import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SHOT_FRAMINGS, type ShotPatch, type StoryboardNode } from "../../core/canvas/storyboard";
import "./canvasStoryboardTable.css";

export type StoryboardReferencePreview = { key: string; url: string; label?: string };
type Props = {
  shots: readonly StoryboardNode[];
  english: boolean;
  resolveUrl: (url: string) => string;
  onPatch: (id: string, patch: ShotPatch) => void;
  onPrompt?: (id: string, prompt: string) => void;
  onRemove: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onDuplicate?: (id: string) => void;
  onRemoveReference?: (id: string, key: string) => void;
  onEditReferences?: (id: string) => void;
  getReferencePreviews?: (id: string) => StoryboardReferencePreview[];
  getReferenceSummary?: (id: string) => { count: number; invalid: number };
  onLocate: (id: string) => void;
  renderDetails: (node: StoryboardNode, index: number) => ReactNode;
  canDuplicate: boolean;
};

/** Drafts stay local until blur. Escape cancels only this edit, not the dialog. */
function Cell({ value, label, onCommit, maxLength = 2000, numeric = false, english }: {
  value: string; label: string; onCommit: (value: string) => void; maxLength?: number; numeric?: boolean; english: boolean;
}) {
  const [draft, setDraft] = useState(value), [invalid, setInvalid] = useState(false);
  const cancel = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (input.current) { input.current.style.height = "auto"; input.current.style.height = `${input.current.scrollHeight + 2}px`; }
  }, [draft]);
  useEffect(() => {
    const resize = () => { if (input.current) { input.current.style.height = "auto"; input.current.style.height = `${input.current.scrollHeight + 2}px`; } };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => { setDraft(value); setInvalid(false); }, [value]);
  const commit = () => {
    if (cancel.current) { cancel.current = false; return; }
    if (numeric && (!draft.trim() || !Number.isFinite(Number(draft)) || Number(draft) < .1 || Number(draft) > 3600)) {
      setInvalid(true); setDraft(value); return;
    }
    const next = numeric ? String(Math.round(Number(draft) * 10) / 10) : draft;
    if (next !== value) onCommit(next);
    setDraft(next);
  };
  return <div className="canvas-shot-cell">
    <textarea ref={input} value={draft} rows={numeric ? 1 : 2} maxLength={maxLength}
      inputMode={numeric ? "decimal" : "text"} aria-label={label} aria-invalid={invalid}
      placeholder={numeric ? "5" : "+"} title={label}
      onFocus={() => { cancel.current = false; }}
      onChange={event => { setDraft(event.target.value); setInvalid(false); }}
      onBlur={commit}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel.current = true; setDraft(value); setInvalid(false); event.currentTarget.blur(); }
        if (event.key === "Enter" && (numeric || event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.blur(); }
      }} />
    {invalid ? <small role="status">{english ? "0.1–3600 s; previous value kept" : "请输入 0.1–3600 秒，已保留原值"}</small> : null}
  </div>;
}
function ReferenceImage({ url, label }: { url: string; label: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return !url || failed ? <span className="canvas-shot-reference-failed">{label}</span> : <img src={url} alt={label} loading="lazy" onError={() => setFailed(true)} />;
}
function Row({ node, index, props }: { node: StoryboardNode; index: number; props: Props }) {
  const [expanded, setExpanded] = useState(false), [removing, setRemoving] = useState(false);
  const s = node.data.storyboardShot!;
  const t = (zh: string, en: string) => props.english ? en : zh;
  const label = (name: string) => `${t("镜头", "Shot")} ${index + 1} · ${name}`;
  const field = (key: "title" | "description" | "action" | "lighting" | "dialogue" | "sound" | "cameraMovement", name: string, maxLength = 2000) =>
    <Cell english={props.english} value={s[key] || ""} label={label(name)} maxLength={maxLength} onCommit={value => props.onPatch(node.id, { [key]: value })} />;
  const refs = props.getReferencePreviews?.(node.id) || [];
  const summary = props.getReferenceSummary?.(node.id);
  const count = summary?.count ?? refs.length;
  const detailId = `shot-detail-${node.id}`;
  return <>
    <tr data-shot-id={node.id} className={expanded ? "is-expanded" : ""}>
      <th scope="row" className="canvas-shot-number"><button type="button" onClick={() => props.onLocate(node.id)} title={t("在画布中定位", "Locate on canvas")}>{String(index + 1).padStart(2, "0")}</button></th>
      <td data-label={t("时长（秒）", "Seconds")} className="canvas-shot-duration"><Cell english={props.english} numeric value={String(s.durationSeconds)} label={label(t("时长（秒）", "Duration in seconds"))} onCommit={value => props.onPatch(node.id, { durationSeconds: Number(value) })} /></td>
      <td data-label={t("画面描述", "Visual description")} className="canvas-shot-visual-cell">{field("description", t("画面描述", "Visual description"), 4000)}
        {s.title || s.lighting || s.sound || s.cameraMovement ? <button type="button" className="canvas-shot-planning-summary" onClick={() => setExpanded(v => !v)} aria-expanded={expanded} aria-controls={detailId} aria-label={label(t("编辑镜头补充信息", "Edit shot details"))}>
          {[[t("名称", "Name"), s.title], [t("光影", "Lighting"), s.lighting], [t("音效", "Sound"), s.sound], [t("运镜", "Camera"), s.cameraMovement]].filter(([, value]) => value).map(([name, value]) => <span key={name}>{name} · {value!.length > 48 ? `${value!.slice(0, 48)}…` : value}</span>)}
        </button> : null}</td>
      <td data-label={t("景别", "Framing")}><select aria-label={label(t("景别", "Framing"))} value={s.framing} onChange={event => props.onPatch(node.id, { framing: event.target.value as typeof s.framing })}>{SHOT_FRAMINGS.map((value, i) => <option key={value} value={value}>{(props.english ? ["Wide", "Full", "Medium", "Close-up", "Detail"] : ["远景", "全景", "中景", "近景", "特写"])[i]}</option>)}</select></td>
      <td data-label={t("对白 · 旁白", "Dialogue / narration")}>{field("dialogue", t("对白 · 旁白", "Dialogue / narration"))}</td>
      <td data-label={t("参考素材", "References")}><div className="canvas-shot-references"><div className="canvas-shot-reference-images">
        {refs.map(ref => <span className="canvas-shot-reference-item" key={ref.key}>
          <ReferenceImage url={props.resolveUrl(ref.url)} label={ref.label || t("参考图", "Reference image")} />
          {props.onRemoveReference ? <button type="button" className="canvas-shot-remove-reference" title={t("移除引用，不删除素材", "Remove reference, keep asset")} aria-label={label(`${t("移除引用", "Remove reference")} ${ref.label || ref.key}`)} onClick={() => props.onRemoveReference!(node.id, ref.key)}>×</button> : null}
        </span>)}
      </div><button type="button" onClick={() => props.onEditReferences ? props.onEditReferences(node.id) : props.onLocate(node.id)} aria-label={label(t("添加参考素材", "Add references"))} title={t("使用画布卡片的参考素材", "Uses the canvas card's references")}>
        <span aria-hidden="true">＋</span><small>{count ? `${count} ${t("项参考", "references")}` : t("添加参考", "Add reference")}</small>
      </button>{summary?.invalid ? <small role="status" className="canvas-shot-warning">{t(`${summary.invalid} 项需检查`, `${summary.invalid} need attention`)}</small> : null}</div></td>

      <td className="canvas-shot-actions"><button type="button" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(v => !v)} title={t("镜头名称、光影、音效、运镜与生成", "Shot name, lighting, sound, camera and generation")}>{expanded ? t("收起", "Close") : t("详情", "Details")}</button><div>
        <button type="button" disabled={!index} onClick={() => props.onMove(node.id, -1)} title={t("前移", "Move earlier")} aria-label={label(t("前移", "Move earlier"))}>↑</button>
        <button type="button" disabled={index === props.shots.length - 1} onClick={() => props.onMove(node.id, 1)} title={t("后移", "Move later")} aria-label={label(t("后移", "Move later"))}>↓</button>
        {props.onDuplicate ? <button type="button" disabled={!props.canDuplicate} onClick={() => props.onDuplicate!(node.id)} title={t("复制镜头，不启动生成", "Duplicate shot without generating")} aria-label={label(t("复制镜头", "Duplicate shot"))}>⧉</button> : null}
        <button type="button" onClick={() => setRemoving(v => !v)} title={t("移出分镜，保留卡片", "Remove from storyboard, keep card")} aria-label={label(t("移出分镜", "Remove from storyboard"))}>−</button>
      </div></td>
    </tr>
    {removing ? <tr className="canvas-shot-remove-row"><td colSpan={7}><span>{t("仅移出分镜，卡片、脚本和生成结果仍保留在画布。", "Only removes this shot from the storyboard. Its card, script and results stay on the canvas.")}</span><button type="button" onClick={() => props.onRemove(node.id)}>{t("确认移出", "Confirm removal")}</button><button type="button" onClick={() => setRemoving(false)}>{t("保留", "Keep")}</button></td></tr> : null}
    {expanded ? <tr className="canvas-shot-detail-row"><td colSpan={7}><div id={detailId}>{props.renderDetails(node, index)}</div></td></tr> : null}
  </>;
}
export function CanvasStoryboardTable(props: Props) {
  const t = (zh: string, en: string) => props.english ? en : zh;
  return <div className="canvas-shot-table-scroll" role="region" tabIndex={0} aria-label={t("镜头脚本", "Shot script table")}>
    <table className="canvas-shot-table"><caption>{t("逐镜头规划 · 离开输入框自动应用，Esc 取消本次编辑", "Plan each shot · blur to apply, Escape to cancel the current edit")}</caption>
      <thead><tr>{[["镜号", "Shot"], ["时长", "Seconds"], ["画面描述", "Visual description"], ["景别", "Framing"], ["对白 · 旁白", "Dialogue / narration"], ["参考素材", "References"], ["操作", "Actions"]].map(([zh, en]) => <th scope="col" key={en}>{t(zh, en)}</th>)}</tr></thead>
      <tbody>{props.shots.map((node, index) => <Row key={node.id} node={node} index={index} props={props} />)}</tbody>
    </table>
  </div>;
}
