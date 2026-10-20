import { useEffect, useRef, useState } from "react";
import { CanvasStoryboardCandidates } from "./CanvasStoryboardCandidates";
import { CanvasStoryboardScriptImport, type CanvasStoryboardScriptImportProps } from "./CanvasStoryboardScriptImport";
import type { StoryboardCandidateState } from "../../core/canvas/storyboardCandidates";
import type { StoryboardScriptImport } from "../../core/canvas/storyboardScript";
import "./canvasStoryboardWorkflow.css";
import { CanvasCreativeDialog } from "./CanvasCreativeDialog";
import {
  isStoryboard,
  canBeShot,
  validShot,
  validStoryboardChoice,
  SHOT_FRAMINGS,
  SHOT_LIMIT,
  shotPreview,
  buildStoryboardPrompt,
  shotTime,
  storyboardShots,
  storyboardTimeline,
  type ShotPatch,
  type StoryboardNode,
  type StoryboardShot,
} from "../../core/canvas/storyboard";

function Field({
  value,
  label,
  multiline = false,
  maxLength = 100,
  onCommit,
}: {
  value: string;
  label: string;
  multiline?: boolean;
  maxLength?: number;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const props = {
    value: draft,
    maxLength,
    "aria-label": label,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onBlur: () => {
      if (draft !== value) onCommit(draft);
    },
  };
  return (
    <label className="canvas-storyboard-field">
      <span>{label}</span>
      {multiline ? <textarea {...props} rows={2} /> : <input {...props} />}
    </label>
  );
}
function Duration({
  value,
  onCommit,
  english,
}: {
  value: number;
  onCommit: (v: number) => void;
  english: boolean;
}) {
  const [draft, setDraft] = useState(String(value)),
    [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(String(value));
    setInvalid(false);
  }, [value]);
  return (
    <label className="canvas-storyboard-field">
      <span>{english ? "Planned seconds" : "计划时长（秒）"}</span>
      <input
        type="number"
        min="0.1"
        max="3600"
        step="0.1"
        value={draft}
        aria-invalid={invalid}
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(false);
        }}
        onBlur={() => {
          const n = Number(draft);
          if (!draft.trim() || !Number.isFinite(n) || n < 0.1 || n > 3600) {
            setDraft(String(value));
            setInvalid(true);
            return;
          }
          const rounded = Math.round(n * 10) / 10;
          if (rounded !== value) onCommit(rounded);
          else setDraft(String(value));
        }}
      />
      {invalid ? (
        <small role="status">
          {english
            ? "Use 0.1–3600 seconds. Previous value kept."
            : "请输入 0.1–3600 秒，已保留原值。"}
        </small>
      ) : null}
    </label>
  );
}
export type StoryboardPosition = {
  boardId: string;
  shotId?: string;
  mode?: "board" | "script";
};
type StoryboardProps = {
  nodes: readonly StoryboardNode[];
  selectedCount: number;
  position?: StoryboardPosition;
  onNavigate?: (position: StoryboardPosition) => void;
  onCreate: (name: string, fromSelection: boolean) => string;
  onAdd: (boardId: string) => void;
  onPatch: (boardId: string, id: string, patch: ShotPatch) => void;
  onMove: (boardId: string, id: string, delta: -1 | 1) => void;
  onRemove: (boardId: string, id: string) => void;
  onRename: (boardId: string, name: string) => void;
  onUnmark: (boardId: string) => void;
  onPrompt?: (boardId: string, id: string, prompt: string) => void;
  onBuildPrompt?: (boardId: string, id: string) => string;
  onGenerate?: (boardId: string, id: string) => void;
  generationError?: string | null;
  onImportScript?: (boardId: string, payload: StoryboardScriptImport) => void;
  sourceText?: string;
  getImportCapacity?: (boardId: string) => number;
  textSources?: CanvasStoryboardScriptImportProps["textSources"];
  getCandidates?: (boardId: string, shotId: string) => StoryboardCandidateState;
  onChooseResult?: (boardId: string, shotId: string, key: string) => void;
  onClearResult?: (boardId: string, shotId: string) => void;
  getReferenceSummary?: (boardId: string, shotId: string) => { count: number; invalid: number };
  onExportBoard?: (boardId: string) => void;
  exportBusy?: boolean;
  exportError?: string | null;
  exportNotice?: string | null;
  onLocate: (id: string) => void;
  resolveUrl: (url: string) => string;
  onClose: () => void;
  english?: boolean;
};
function Preview({
  node,
  resolveUrl,
  onLocate,
  english,
}: {
  node: StoryboardNode;
  resolveUrl: StoryboardProps["resolveUrl"];
  onLocate: () => void;
  english: boolean;
}) {
  const raw = shotPreview(node),
    url = raw ? resolveUrl(raw) : "";
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <button
      type="button"
      className="canvas-storyboard-preview"
      onClick={onLocate}
      aria-label={english ? "Open canvas card" : "打开画布卡片"}
    >
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="canvas-storyboard-no-image">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="m3 15 5-5 4 4 3-2 6 5" />
          </svg>
          {node.data.storyboardShot?.chosenResult?.kind === "video"
            ? (english ? "Chosen video (no poster)" : "已选视频（无封面）")
            : english ? "No frame yet" : "尚未生成画面"}
        </span>
      )}
      <span className="canvas-storyboard-preview-link">
        {english ? "Open card" : "打开卡片"}
      </span>
    </button>
  );
}
function Shot({
  node,
  index,
  start,
  end,
  count,
  english,
  resolveUrl,
  onPatch,
  onMove,
  onRemove,
  onLocate,
  onPrompt,
  onBuildPrompt,
  onGenerate,
  candidates,
  onChoose,
  onClear,
  references,
  flush,
  run,
}: {
  node: StoryboardNode;
  index: number;
  start: number;
  end: number;
  count: number;
  english: boolean;
  resolveUrl: StoryboardProps["resolveUrl"];
  onPatch: (p: ShotPatch) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  onLocate: () => void;
  onPrompt?: (prompt: string) => void;
  onBuildPrompt?: () => string;
  onGenerate?: () => void;
  candidates?: StoryboardCandidateState;
  onChoose?: (key: string) => void;
  onClear?: () => void;
  references?: { count: number; invalid: number };
  flush: () => void;
  run: (fn: () => void) => void;
}) {
  const s = node.data.storyboardShot!;
  const generationDetails = useRef<HTMLDetailsElement>(null);
  const [prepared, setPrepared] = useState<string | null>(null),
    [remove, setRemove] = useState(false);
  const framing = english
    ? ["Wide", "Full", "Medium", "Close-up", "Detail"]
    : ["远景", "全景", "中景", "近景", "特写"];
  const prepare = () => {
    flush();
    run(() => {
      setPrepared(
        onBuildPrompt ? onBuildPrompt() : buildStoryboardPrompt(node, english),
      );
      if (generationDetails.current) generationDetails.current.open = true;
    });
  };
  const busy = !!candidates?.activeTaskIds.length || ["queued", "running"].includes(
    node.data.generationTask?.status || "",
  );
  return (
    <article
      className="canvas-storyboard-shot"
      data-shot-id={node.id}
      aria-label={`${english ? "Shot" : "镜头"} ${index + 1}`}
    >
      <div className="canvas-storyboard-visual">
        <div className="canvas-storyboard-shot-index">
          <strong>{String(index + 1).padStart(2, "0")}</strong>
          <small>
            {shotTime(start)} — {shotTime(end)}
          </small>
        </div>
        <Preview
          node={node}
          resolveUrl={resolveUrl}
          onLocate={onLocate}
          english={english}
        />
        {candidates ? <CanvasStoryboardCandidates
          state={candidates} chosenKey={s.chosenResult?.key} english={english}
          resolveUrl={resolveUrl} onChoose={onChoose} onClear={onClear}
        /> : null}
        <button
          type="button"
          className="canvas-storyboard-open-card"
          title={references?.invalid ? (english ? `${references.invalid} references need attention` : `${references.invalid} 项参考内容需检查`) : undefined}
          onClick={onLocate}
        >
          {english ? "Edit on canvas" : "在画布中编辑"}
          {references?.count ? ` · ${english ? "References" : "参考"} ${references.count}${references.invalid ? " !" : ""}` : references?.invalid ? " !" : ""}
        </button>
        {node.data.kind === "generator" && onGenerate ? (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              node.data.generationPrompt?.trim() ? run(onGenerate) : prepare()
            }
          >
            {busy
              ? english
                ? "Generating…"
                : "正在生成…"
              : !node.data.generationPrompt?.trim()
                ? english
                  ? "Prepare generation"
                  : "准备生成"
                : node.data.generationKind === "video"
                  ? english
                    ? "Generate video"
                    : "生成视频"
                  : english
                    ? "Generate frame"
                    : "生成画面"}
          </button>
        ) : null}
        {busy && (node.data.kind !== "generator" || !onGenerate) ? <small role="status">
          {english ? "Generating…" : "正在生成…"}
        </small> : null}
        {node.data.kind === "generator" ? (
          <small className="canvas-storyboard-model">
            {node.data.generationModel ||
              (english
                ? "Uses the current model configuration"
                : "使用当前模型配置")}
          </small>
        ) : null}
        {node.data.generationTask?.status === "failed" ? (
          <small role="status">
            {english
              ? "Generation failed. Open the card for details."
              : "生成失败，请打开卡片查看详情。"}
          </small>
        ) : null}
      </div>
      <div className="canvas-storyboard-copy">
        <Field
          label={english ? "Shot name" : "镜头名称"}
          value={s.title}
          onCommit={(title) => onPatch({ title })}
        />
        <div className="canvas-storyboard-row">
          <label className="canvas-storyboard-field">
            <span>{english ? "Framing" : "景别"}</span>
            <select
              value={s.framing}
              onChange={(e) =>
                onPatch({
                  framing: e.target.value as StoryboardShot["framing"],
                })
              }
            >
              {SHOT_FRAMINGS.map((v, i) => (
                <option key={v} value={v}>
                  {framing[i]}
                </option>
              ))}
            </select>
          </label>
          <Duration
            value={s.durationSeconds}
            onCommit={(durationSeconds) => onPatch({ durationSeconds })}
            english={english}
          />
        </div>
        <Field
          multiline
          maxLength={4000}
          label={english ? "Visual description" : "画面描述"}
          value={s.description || ""}
          onCommit={(description) => onPatch({ description })}
        />
        <Field
          multiline
          maxLength={2000}
          label={english ? "Action / camera" : "动作 / 运镜"}
          value={s.action}
          onCommit={(action) => onPatch({ action })}
        />
        <Field
          multiline
          maxLength={2000}
          label={english ? "Dialogue / narration" : "台词 / 旁白"}
          value={s.dialogue}
          onCommit={(dialogue) => onPatch({ dialogue })}
        />
        {node.data.kind === "generator" && onPrompt ? (
          <details
            ref={generationDetails}
            className="canvas-storyboard-generation"
          >
            <summary>
              {english
                ? "Generation prompt · shared with canvas card"
                : "生成提示词 · 与画布卡片同步"}
            </summary>
            <p>
              {english
                ? "Only this prompt and configured references are sent. Shot names, dialogue and planned timing are not sent automatically."
                : "生成使用下方提示词及已配置的参考内容。镜头名称、台词和计划时长不会自动发送。"}
            </p>
            <Field
              multiline
              maxLength={12000}
              label={english ? "Generation prompt" : "生成提示词"}
              value={node.data.generationPrompt || ""}
              onCommit={(value) => run(() => onPrompt(value))}
            />
            <button type="button" onClick={prepare}>
              {english
                ? "Prepare from visual description"
                : "用画面描述准备提示词"}
            </button>
            {prepared !== null ? (
              <div className="canvas-storyboard-prompt-review">
                {prepared ? (
                  <>
                    <p>
                      {english
                        ? "Review before replacing the current prompt. This does not start generation."
                        : "确认后替换此镜头的生成提示词，不会自动生成。"}
                    </p>
                    <pre>{prepared}</pre>
                    <div>
                      <button
                        type="button"
                        onClick={() =>
                          run(() => {
                            onPrompt(prepared);
                            setPrepared(null);
                          })
                        }
                      >
                        {english ? "Use this prompt" : "采用此提示词"}
                      </button>
                      <button type="button" onClick={() => setPrepared(null)}>
                        {english ? "Keep current" : "保留原提示词"}
                      </button>
                    </div>
                  </>
                ) : (
                  <p role="status">
                    {english
                      ? "Write a visual description or action first."
                      : "请先填写画面描述或动作 / 运镜。"}
                  </p>
                )}
              </div>
            ) : null}
          </details>
        ) : null}
      </div>
      <div className="canvas-storyboard-shot-actions">
        <button
          type="button"
          disabled={index === 0}
          aria-label={english ? "Move shot earlier" : "镜头前移"}
          title={english ? "Move earlier" : "前移"}
          onClick={() => onMove(-1)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 14 6-6 6 6" />
          </svg>
        </button>
        <button
          type="button"
          disabled={index === count - 1}
          aria-label={english ? "Move shot later" : "镜头后移"}
          title={english ? "Move later" : "后移"}
          onClick={() => onMove(1)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 10 6 6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={english ? "Remove shot, keep card" : "移出分镜，保留卡片"}
          title={english ? "Remove shot, keep card" : "移出分镜，保留卡片"}
          onClick={() => setRemove((v) => !v)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14" />
          </svg>
        </button>
      </div>
      {remove ? (
        <div className="canvas-storyboard-remove-confirm">
          <span>
            {english
              ? "The card and its script will remain on the canvas."
              : "卡片、脚本和生成结果仍保留在画布中。"}
          </span>
          <button type="button" onClick={onRemove}>
            {english ? "Confirm removal" : "确认移出"}
          </button>
          <button type="button" onClick={() => setRemove(false)}>
            {english ? "Keep" : "保留"}
          </button>
        </div>
      ) : null}
    </article>
  );
}
export function CanvasStoryboard(props: StoryboardProps) {
  const {
    nodes,
    selectedCount,
    onCreate,
    onAdd,
    onPatch,
    onMove,
    onRemove,
    onRename,
    onUnmark,
    onLocate,
    resolveUrl,
    onClose,
    english = false,
  } = props;
  const boards = nodes.filter(isStoryboard);
  const [selected, setSelected] = useState(props.position?.boardId || ""),
    [mode, setMode] = useState<"board" | "script">(
      props.position?.mode || "board",
    );
  const [name, setName] = useState(""),
    [creating, setCreating] = useState(false),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false),
    [generationAttempted, setGenerationAttempted] = useState(false),
    [importing, setImporting] = useState(false);
  const board = boards.find((n) => n.id === selected) || boards[0],
    id = board?.id || "",
    shots = storyboardShots(nodes, id),
    timeline = storyboardTimeline(nodes, id);
  const importCapacity = props.getImportCapacity?.(id) ?? Math.max(0, SHOT_LIMIT - shots.length);
  const chosenCount = shots.filter(node => validStoryboardChoice(node.data.storyboardShot?.chosenResult)).length;
  const exportReason = nodes.some(n=>n.parentId===id&&n.data.storyboardShot&&(!canBeShot(n)||!validShot(n.data.storyboardShot)))
    ? (english ? "Resolve unsupported shot data before exporting" : "请先处理无效镜头数据，避免漏导出")
    : shots.length > 50
    ? (english ? "Export supports at most 50 shots" : "每次最多导出 50 个镜头")
    : !shots.length || chosenCount !== shots.length
      ? (english ? "Choose a result for every shot before exporting" : "请先为每个镜头采用一个结果，再导出")
      : "";
  const list = useRef<HTMLDivElement>(null);
  const flush = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches("input,textarea"))
      active.blur();
  };
  const remember = (
    boardId = id,
    shotId: string | null | undefined = props.position?.shotId,
    nextMode = mode,
  ) =>
    props.onNavigate?.({
      boardId,
      shotId: shotId === null ? undefined : shotId,
      mode: nextMode,
    });
  const run = (fn: () => void) => {
    try {
      flush();
      fn();
      setError("");
    } catch {
      setError(
        english
          ? "Unable to apply. Check the selected cards and field values."
          : "操作未完成，请检查选中的卡片与输入内容。",
      );
    }
  };
  const locate = (nodeId: string) => {
    flush();
    remember(id, nodeId);
    onLocate(nodeId);
  };
  const close = () => {
    flush();
    remember();
    onClose();
  };
  useEffect(() => {
    setConfirm(false);
    setError("");
    setGenerationAttempted(false);
    setImporting(false);
  }, [id]);
  useEffect(() => {
    const shotId = props.position?.shotId;
    const target = Array.from(
      list.current?.querySelectorAll<HTMLElement>("[data-shot-id]") || [],
    ).find((el) => el.dataset.shotId === shotId);
    target?.scrollIntoView?.({ block: "nearest" });
  }, [id, mode, props.position?.shotId]);
  const unsupported = nodes.filter(
    (n) =>
      n.parentId === id &&
      n.data.storyboardShot &&
      (!canBeShot(n) || !validShot(n.data.storyboardShot)),
  ).length;
  const create = (fromSelection: boolean) =>
    run(() => {
      const boardId = onCreate(
        name.trim() || (english ? "Storyboard" : "分镜板"),
        fromSelection,
      );
      setSelected(boardId);
      remember(boardId, null, "board");
      setMode("board");
      setName("");
      setCreating(false);
    });
  return (
    <CanvasCreativeDialog
      title={english ? "Storyboard" : "分镜板"}
      subtitle={english ? "Keep the script and every frame in the same story." : "镜头、台词与画面，在同一个故事里。"}
      onClose={close}
      english={english}
      className="canvas-storyboard-dialog"
      dismissOnBackdrop={false}
    >
      <div className="canvas-storyboard-workspace">
        <aside
          className="canvas-storyboard-library"
          aria-label={english ? "Saved storyboards" : "已有分镜板"}
        >
          <div className="canvas-storyboard-library-heading">
            <span>{english ? "In this canvas" : "当前画布"}</span>
            <button
              type="button"
              onClick={() => {
                flush();
                setCreating((v) => !v);
              }}
            >
              {english ? "+ New" : "+ 新建"}
            </button>
          </div>
          <nav>
            {boards.map((n) => (
              <button
                type="button"
                key={n.id}
                aria-pressed={id === n.id}
                onClick={() => {
                  flush();
                  setSelected(n.id);
                  remember(n.id, null);
                  setCreating(false);
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="M3 10h18M10 10v10" />
                </svg>
                <span>
                  <strong>
                    {n.data.label || (english ? "Storyboard" : "分镜板")}
                  </strong>
                  <small>
                    {storyboardShots(nodes, n.id).length}{" "}
                    {english ? "shots" : "个镜头"}
                  </small>
                </span>
              </button>
            ))}
          </nav>
          {!boards.length ? (
            <p>
              {english
                ? "Your storyboards will stay here."
                : "创建的分镜板会保留在这里，随时回来继续。"}
            </p>
          ) : null}
        </aside>
        <main className="canvas-storyboard-main">
          {creating || !board ? (
            <div className="canvas-storyboard-create">
              <strong>{english ? "Start a storyboard" : "新建分镜板"}</strong>
              <div className="canvas-storyboard-toolbar">
                <input
                  aria-label={english ? "New storyboard name" : "新分镜板名称"}
                  placeholder={
                    english ? "Name this story" : "给这段故事起个名字"
                  }
                  maxLength={60}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <button type="button" onClick={() => create(false)}>
                  {english ? "New board" : "新建分镜板"}
                </button>
                <button
                  type="button"
                  disabled={!selectedCount}
                  onClick={() => create(true)}
                >
                  {english ? "From selection" : "从选中卡片创建"}
                </button>
              </div>
            </div>
          ) : null}
          {error ? (
            <p className="canvas-creative-notice" role="alert">
              {error}
            </p>
          ) : null}
          {generationAttempted && props.generationError ? (
            <p className="canvas-creative-notice" role="alert">
              {props.generationError}
            </p>
          ) : null}
          {board ? (
            <>
              <div className="canvas-storyboard-heading">
                <Field
                  label={english ? "Storyboard name" : "分镜板名称"}
                  value={board.data.label || ""}
                  maxLength={60}
                  onCommit={(v) => run(() => onRename(id, v))}
                />
                <span>
                  {shots.length} {english ? "shots" : "个镜头"} ·{" "}
                  {shotTime(timeline.total)}
                </span>
                <button type="button" onClick={() => locate(id)}>
                  {english ? "Show on canvas" : "查看画布"}
                </button>
                <button
                  type="button"
                  disabled={shots.length >= SHOT_LIMIT}
                  onClick={() => run(() => onAdd(id))}
                >
                  {english ? "Add shot" : "添加镜头"}
                </button>
              </div>
              <div className="canvas-storyboard-viewbar">
                <div
                  role="group"
                  aria-label={english ? "Storyboard view" : "分镜视图"}
                >
                  {(["board", "script"] as const).map((v) => (
                    <button
                      type="button"
                      key={v}
                      aria-pressed={mode === v}
                      onClick={() => {
                        flush();
                        setMode(v);
                        remember(id, null, v);
                      }}
                    >
                      {v === "board"
                        ? english
                          ? "Frames & script"
                          : "分镜创作"
                        : english
                          ? "Read script"
                          : "连贯脚本"}
                    </button>
                  ))}
                </div>
                <div className="canvas-storyboard-workflow-actions">
                  {props.onImportScript ? <button type="button" aria-expanded={importing}
                    disabled={importCapacity < 1}
                    onClick={() => { flush(); setImporting(v => !v); }}>
                    {english ? "Import script" : "导入脚本"}
                  </button> : null}
                  {props.onExportBoard ? <>
                    <small className="canvas-storyboard-export-count">{english ? "Chosen" : "已采用"} {chosenCount}/{shots.length}</small>
                    <button type="button" disabled={!!exportReason || props.exportBusy}
                      title={exportReason || (english ? "Export chosen results and script · up to 50 shots" : "导出已采用结果与脚本 · 最多 50 个镜头")}
                      onClick={() => run(() => props.onExportBoard!(id))}>
                      {props.exportBusy ? (english ? "Exporting…" : "正在导出…") : (english ? "Export storyboard" : "导出分镜")}
                    </button>
                  </> : null}
                </div>
              </div>
              {props.exportError ? <p role="alert" className="canvas-creative-notice">{props.exportError}</p> : null}
              {props.exportNotice ? <small role="status">{props.exportNotice}</small> : null}
              {importing && props.onImportScript ? <CanvasStoryboardScriptImport
                key={id} english={english} remainingCapacity={importCapacity}
                sourceText={props.sourceText ?? board.data.storyboard?.sourceScript}
                textSources={props.textSources}
                onCancel={() => setImporting(false)}
                onImport={payload => { flush(); props.onImportScript!(id, payload); setImporting(false); }}
              /> : null}
              {unsupported ? (
                <p role="status" className="canvas-creative-notice">
                  {english
                    ? `${unsupported} unsupported records are preserved.`
                    : `${unsupported} 项暂不支持的镜头信息已保留。`}
                </p>
              ) : null}
              <div
                className={`canvas-storyboard-list ${mode === "script" ? "is-script" : ""}`}
                ref={list}
              >
                {shots.map((node, index) =>
                  mode === "script" ? (
                    <article
                      className="canvas-storyboard-script-shot"
                      data-shot-id={node.id}
                      key={node.id}
                    >
                      <header>
                        <strong>
                          {String(index + 1).padStart(2, "0")} ·{" "}
                          {node.data.storyboardShot!.title ||
                            (english ? "Untitled shot" : "未命名镜头")}
                        </strong>
                        <small>
                          {shotTime(timeline.shots[index].start)} —{" "}
                          {shotTime(timeline.shots[index].end)}
                        </small>
                        <button
                          type="button"
                          onClick={() => {
                            setMode("board");
                            remember(id, node.id, "board");
                          }}
                        >
                          {english ? "Edit shot" : "编辑镜头"}
                        </button>
                      </header>
                      <div>
                        <Preview
                          node={node}
                          resolveUrl={resolveUrl}
                          onLocate={() => locate(node.id)}
                          english={english}
                        />
                        <dl>
                          <dt>{english ? "Framing" : "景别"}</dt>
                          <dd>
                            {
                              (english
                                ? [
                                    "Wide",
                                    "Full",
                                    "Medium",
                                    "Close-up",
                                    "Detail",
                                  ]
                                : ["远景", "全景", "中景", "近景", "特写"])[
                                SHOT_FRAMINGS.indexOf(
                                  node.data.storyboardShot!.framing,
                                )
                              ]
                            }
                          </dd>
                          <dt>{english ? "Visual" : "画面"}</dt>
                          <dd>
                            {node.data.storyboardShot!.description ||
                              (english
                                ? "No description yet"
                                : "尚未填写画面描述")}
                          </dd>
                          <dt>{english ? "Action / camera" : "动作 / 运镜"}</dt>
                          <dd>{node.data.storyboardShot!.action || "—"}</dd>
                          <dt>
                            {english ? "Dialogue / narration" : "台词 / 旁白"}
                          </dt>
                          <dd className="is-dialogue">
                            {node.data.storyboardShot!.dialogue || "—"}
                          </dd>
                        </dl>
                      </div>
                    </article>
                  ) : (
                    <Shot
                      key={node.id}
                      node={node}
                      index={index}
                      count={shots.length}
                      start={timeline.shots[index].start}
                      end={timeline.shots[index].end}
                      english={english}
                      resolveUrl={resolveUrl}
                      onPatch={(p) => run(() => onPatch(id, node.id, p))}
                      onMove={(d) => run(() => onMove(id, node.id, d))}
                      onRemove={() => run(() => onRemove(id, node.id))}
                      onLocate={() => locate(node.id)}
                      onPrompt={
                        props.onPrompt
                          ? (p) => props.onPrompt!(id, node.id, p)
                          : undefined
                      }
                      onBuildPrompt={
                        props.onBuildPrompt
                          ? () => props.onBuildPrompt!(id, node.id)
                          : undefined
                      }
                      onGenerate={
                        props.onGenerate
                          ? () => {
                              setGenerationAttempted(true);
                              props.onGenerate!(id, node.id);
                            }
                          : undefined
                      }
                      candidates={props.getCandidates?.(id, node.id)}
                      references={props.getReferenceSummary?.(id, node.id)}
                      onChoose={props.onChooseResult ? key => run(() => props.onChooseResult!(id, node.id, key)) : undefined}
                      onClear={props.onClearResult ? () => run(() => props.onClearResult!(id, node.id)) : undefined}
                      flush={flush}
                      run={run}
                    />
                  ),
                )}
                {!shots.length ? (
                  <div className="canvas-creative-empty">
                    <strong>
                      {english
                        ? "Your first shot starts here"
                        : "从第一个镜头开始"}
                    </strong>
                    <p>
                      {english
                        ? "Add a shot, write its visual and dialogue, then prepare its generation prompt."
                        : "添加镜头，写下画面与台词，再准备生成提示词。"}
                    </p>
                    <button type="button" onClick={() => run(() => onAdd(id))}>
                      {english ? "Add shot" : "添加镜头"}
                    </button>
                  </div>
                ) : null}
              </div>
              <footer className="canvas-storyboard-footer">
                <small>
                  {english
                    ? "Planned timing does not set generated video length."
                    : "计划时长用于脚本节奏，不改变生成视频时长。"}
                </small>
                <button
                  type="button"
                  onClick={() => {
                    flush();
                    setConfirm((v) => !v);
                  }}
                >
                  {english ? "Unmark board" : "取消分镜标记"}
                </button>
                {confirm ? (
                  <span>
                    <button
                      type="button"
                      onClick={() => run(() => onUnmark(id))}
                    >
                      {english ? "Confirm, keep cards" : "确认，保留卡片"}
                    </button>
                    <button type="button" onClick={() => setConfirm(false)}>
                      {english ? "Keep" : "保留"}
                    </button>
                  </span>
                ) : null}
              </footer>
            </>
          ) : (
            <div className="canvas-creative-empty">
              <strong>
                {english
                  ? "A continuous script, shot by shot"
                  : "把一段故事，变成连贯的镜头"}
              </strong>
              <p>
                {english
                  ? "Write visuals and dialogue beside each frame. Generate deliberately, then return to the same story."
                  : "画面、运镜与台词放在一起。按镜头生成，随时回到同一份脚本。"}
              </p>
            </div>
          )}
        </main>
      </div>
    </CanvasCreativeDialog>
  );
}
