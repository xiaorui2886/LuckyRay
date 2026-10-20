import { useState } from "react";
import { SHOT_FRAMINGS } from "../../core/canvas/storyboard";
import { parseStoryboardScript, scriptImportError, validateScriptShots, type ScriptParseResult, type ScriptShotInput, type StoryboardScriptImport } from "../../core/canvas/storyboardScript";
import "./CanvasStoryboardScriptImport.css";

export type CanvasStoryboardScriptImportProps = {
  english?: boolean;
  remainingCapacity: number;
  sourceText?: string;
  textSources?: { id: string; label: string; text: string }[];
  onImport: (payload: StoryboardScriptImport) => void;
  onCancel: () => void;
};

export function CanvasStoryboardScriptImport({ english = false, remainingCapacity, sourceText = "", textSources = [], onImport, onCancel }: CanvasStoryboardScriptImportProps) {
  const [source, setSource] = useState(sourceText);
  const [preview, setPreview] = useState<ScriptParseResult | null>(null);
  const [error, setError] = useState("");
  const t = (zh: string, en: string) => english ? en : zh;
  const changeSource = (value: string) => { setSource(value); setPreview(null); setError(""); };
  const edit = (index: number, patch: Partial<ScriptShotInput>) => {
    setPreview(current => current && ({ ...current, shots: current.shots.map((shot, i) => i === index ? { ...shot, ...patch } : shot) }));
    setError("");
  };
  const inspect = () => {
    try { setPreview(parseStoryboardScript(source, remainingCapacity)); setError(""); }
    catch (caught) { setPreview(null); setError(scriptImportError(caught, english)); }
  };
  const confirm = () => {
    if (!preview) return;
    try { validateScriptShots(preview.shots, remainingCapacity); onImport({ sourceText: source, shots: preview.shots }); }
    catch (caught) { setError(scriptImportError(caught, english)); }
  };
  return <section className="canvas-script-import" aria-label={t("从剧本导入镜头", "Import shots from script")}>
    <div className="canvas-script-import__heading"><strong>{t("剧本 → 分镜", "Script → storyboard")}</strong><span>{t(`可导入 ${remainingCapacity} 镜头`, `${remainingCapacity} shots available`)}</span></div>
    <p>{t("按“镜头 1 / Shot 1”拆分；无镜头标题时按空行拆分。支持画面、动作、台词、时长、景别。仅本地整理，不生成内容。", "Split by “Shot 1 / 镜头 1” headings, or blank lines without headings. Supports Visual, Action, Dialogue, Duration and Framing. Local parsing only.")}</p>
    {textSources.length > 0 && <label>{t("读取画布文本", "Use canvas text")}<select value="" onChange={event => { const selected = textSources.find(item => item.id === event.target.value); if (selected) changeSource(selected.text); }}><option value="">{t("选择文本来源…", "Choose a text source…")}</option>{textSources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
    <label>{t("原始剧本", "Source script")}<textarea rows={5} value={source} onChange={event => changeSource(event.target.value)} placeholder={t("镜头 1：清晨\n画面：窗边的咖啡杯\n动作：镜头缓缓推进\n台词：早上好。\n时长：5 秒", "Shot 1: Morning\nVisual: A coffee cup by the window\nAction: Slow push in\nDialogue: Good morning.\nDuration: 5s")} /></label>
    <div className="canvas-script-import__actions"><button type="button" onClick={inspect} disabled={!source.trim() || remainingCapacity < 1}>{t("解析并预览", "Parse & preview")}</button><button type="button" onClick={onCancel}>{t("取消", "Cancel")}</button></div>
    {error && <p className="canvas-script-import__error" role="alert">{error}</p>}
    {preview && <>
      <p role="status">{t(`预览 ${preview.shots.length} 个镜头。导入为镜头草稿，不会自动生成。`, `Preview ${preview.shots.length} shots. Import as drafts; nothing generates automatically.`)} {t("缺省时长为计划值 5 秒、景别为中景，不代表从剧本推断。", "Missing duration defaults to a planned 5s and framing to medium; these are not inferred from the script.")}</p>
      {preview.sourcePreamble && <p>{t("镜头前的标题及说明保留在原始剧本中，不写入镜头画面。", "Document title and preamble stay in the original source, outside shot visuals.")}</p>}
      <div className="canvas-script-import__preview">{preview.shots.map((shot, index) => <fieldset key={index}>
        <legend>{t(`镜头 ${index + 1}`, `Shot ${index + 1}`)}</legend>
        <label>{t("标题", "Title")}<input value={shot.title} onChange={event => edit(index, { title: event.target.value })} /></label>
        <label>{t("画面", "Visual")}<textarea rows={2} value={shot.description || ""} onChange={event => edit(index, { description: event.target.value })} /></label>
        <label>{t("动作 / 运镜", "Action / camera")}<textarea rows={2} value={shot.action} onChange={event => edit(index, { action: event.target.value })} /></label>
        <label>{t("台词", "Dialogue")}<textarea rows={2} value={shot.dialogue} onChange={event => edit(index, { dialogue: event.target.value })} /></label>
        <div className="canvas-script-import__timing"><label>{t("计划时长（秒）", "Planned duration (s)")}{preview.defaultDurationIndexes.includes(index) && <small>{t("原文未指定", "Not specified in source")}</small>}<input type="number" min="0.1" max="3600" step="0.1" value={Number.isNaN(shot.durationSeconds) ? "" : shot.durationSeconds} onChange={event => edit(index, { durationSeconds: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>
        <label>{t("景别", "Framing")}{preview.defaultFramingIndexes.includes(index) && <small>{t("原文未指定", "Not specified in source")}</small>}<select value={shot.framing} onChange={event => edit(index, { framing: event.target.value as ScriptShotInput["framing"] })}>{SHOT_FRAMINGS.map((framing, i) => <option key={framing} value={framing}>{english ? framing : ["远景", "全景", "中景", "近景", "特写"][i]}</option>)}</select></label></div>
      </fieldset>)}</div>
      <button type="button" onClick={confirm} disabled={preview.shots.length > remainingCapacity}>{t(`确认导入 ${preview.shots.length} 个镜头草稿`, `Import ${preview.shots.length} shot drafts`)}</button>
    </>}
  </section>;
}
