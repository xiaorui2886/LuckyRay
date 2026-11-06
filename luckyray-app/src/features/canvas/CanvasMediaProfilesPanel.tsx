import { canvasProfileModelIds } from "../../core/canvas/apiModelLibrary";
import {CanvasComfyUiSettings} from "./CanvasComfyUiSettings";
import { GenerationConcurrencySettings } from "./GenerationConcurrencySettings";
import { isTwelveMediaHost } from "../../core/canvas/mediaCapabilities";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../core/i18n/index";
import {
  CANVAS_MEDIA_PRESETS,
  canvasMediaProfilesClient,
  type CanvasMediaProfileInput,
  type CanvasMediaProfilesSnapshot,
} from "../../core/services/canvasMediaProfiles";

function ModelPickerField({label, value, values, onChange, models, disabled, placeholder, fetchLabel, fetchBusy, onFetch, fetchDisabled}: {
  label: string; value: string; values: string[]; onChange: (values: string[]) => void;
  models: string[]; disabled?: boolean; placeholder: string; fetchLabel: string;
  fetchBusy: boolean; onFetch: () => void; fetchDisabled?: boolean;
}) {
  const {locale} = useI18n();
  const english = locale === "en-US";
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const candidates = useMemo(() => Array.from(new Set([...values, ...models])), [values, models]);
  const filtered = candidates.filter(id => id.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {if (!boxRef.current?.contains(event.target as Node)) setOpen(false);};
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);
  const add = () => {
    const id = query.trim();
    if (!id || id.length > 128 || values.length >= 500) return;
    onChange(Array.from(new Set([...values, id])));
    setQuery(""); setOpen(true);
  };
  return <div className="canvas-model-picker" ref={boxRef} onKeyDown={event => {
    if (event.key === "Escape" && open && !event.nativeEvent.isComposing) {event.preventDefault(); event.stopPropagation(); setOpen(false);}
  }}>
    <div className="canvas-model-picker-head">
      <label><span>{label}</span>
        <div className="canvas-model-picker-row">
          <input aria-label={label} disabled={disabled} value={disabled ? value : query} placeholder={placeholder} spellCheck={false} maxLength={128}
            onFocus={() => setOpen(true)} onChange={event => {setQuery(event.target.value); setOpen(true);}}
            onKeyDown={event => {if (event.key === "Enter" && !event.nativeEvent.isComposing) {event.preventDefault(); add();}}} />
          <button type="button" className="canvas-model-picker-toggle" disabled={disabled} aria-label={english ? `Choose ${label}` : `选择${label}`} aria-expanded={open} onClick={() => setOpen(current => !current)}>
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden><path d="M2 4.2 6 8.4 10 4.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </label>
      <button type="button" className="canvas-model-fetch" disabled={disabled || fetchBusy || fetchDisabled} onClick={() => {setOpen(true); onFetch();}}>{fetchBusy ? "…" : fetchLabel}</button>
    </div>
    {!disabled ? <p className="canvas-model-picker-status">{english ? `${values.length} added · Available on API cards after saving` : `已添加 ${values.length} 个 · 保存后可在 API 卡片直接选择`}</p> : null}
    {open && !disabled ? <div className="canvas-model-picker-list" role="group" aria-label={english ? `${label} selection` : `${label}勾选`}>
      {filtered.map(id => <label key={id} className={`canvas-model-option canvas-model-check-option${values.includes(id) ? " is-selected" : ""}`}>
        <input type="checkbox" checked={values.includes(id)} disabled={disabled || (!values.includes(id) && values.length >= 500)} onChange={() => onChange(values.includes(id) ? values.filter(value => value !== id) : [...values, id])} />
        <span className="canvas-model-option-id">{id}</span>
      </label>)}
      {query.trim() && !candidates.includes(query.trim()) ? <button type="button" className="canvas-model-option" onClick={add}>{english ? "Add" : "添加"}「{query.trim()}」</button> : null}
      {!filtered.length && !query.trim() ? <p className="canvas-model-picker-empty">{english ? "Fetch models, or enter a model ID to add." : "获取模型后勾选，或输入模型 ID 添加。"}</p> : null}
    </div> : null}
  </div>;
}

// The editor is unloaded by Canvas Home. Keep its unsaved connection draft in
// this window's memory only, never in browser storage or the native profile.
let retainedConnectionDraft: CanvasMediaProfileInput | null = null;

export function CanvasMediaProfilesPanel({
  snapshot,
  onChange,
  section = "generation",
  onDraftChange,
}: {
  section?: "generation" | "connections";
  onDraftChange?: (hasDraft: boolean) => void;
  snapshot: CanvasMediaProfilesSnapshot | null;
  onChange: (value: CanvasMediaProfilesSnapshot) => void;
}) {
  const { locale } = useI18n();
  const en = locale === "en-US";
  const copy = (zh: string, english: string) => (en ? english : zh);
  const [draft, setDraft] = useState<CanvasMediaProfileInput | null>(() => retainedConnectionDraft);
  useLayoutEffect(() => { retainedConnectionDraft = draft; }, [draft]);
  useEffect(() => { onDraftChange?.(!!draft); }, [!!draft, onDraftChange]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const discoveryEpoch = useRef(0);
  const discoveryContext = JSON.stringify([
    draft?.id,
    draft?.baseUrl,
    draft?.imageProtocol,
    draft?.videoProtocol,
    draft?.textProtocol,
    draft?.apiKey,
    draft?.clearApiKey,
  ]);
  const discoveryContextRef = useRef(discoveryContext);
  discoveryContextRef.current = discoveryContext;
  useEffect(() => {
    discoveryEpoch.current++;
    setModels([]);
    setModelsBusy(false);
  }, [discoveryContext]);
  useEffect(
    () => () => {
      discoveryEpoch.current++;
    },
    [],
  );
  const localGeminiMismatch =
    !!draft &&
    /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/i.test(
      draft.baseUrl.trim(),
    ) &&
    draft.imageModel.startsWith("gemini-") &&
    draft.imageModel.includes("image") &&
    draft.imageProtocol === "openai-image";
  const isArkPlan = draft?.baseUrl.replace(/\/$/, "") === CANVAS_MEDIA_PRESETS.arkPlan.baseUrl;
  const selectableProfiles = snapshot?.profiles.filter(p => p.id !== "doubao-default" && p.imageProtocol !== "doubao-image" && p.videoProtocol !== "doubao-video") || [];
  const active = selectableProfiles.find(
    (p) => p.id === snapshot?.activeProfileId,
  );
  const modelSummary = (kind: "text" | "image" | "video") => {
    const count = canvasProfileModelIds(active, kind).length;
    return count ? copy(`${count} 个已添加模型`, `${count} added models`) : "—";
  };
  const run = async (
    action: () => Promise<CanvasMediaProfilesSnapshot>,
    close = false,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      onChange(await action());
      if (close) {
        setDraft(null);
        setConfirmDelete(false);
      }
    } catch (error) {
      // Surface the backend's own error code verbatim instead of collapsing
      // every failure into the misleading name/URL/protocol hint.
      const code = String(error);
      setError(
        code.includes("origin-key-required")
          ? copy(
              "更换服务地址后，请输入该服务自己的 Key，或明确清除旧 Key。",
              "Enter the new service's own key or explicitly clear the previous key when changing service origin.",
            )
          : code.includes("conflict") || code.includes("changed")
            ? copy(
                "配置已变化，请取消编辑并重新打开。",
                "Configuration changed. Cancel and reopen the editor.",
              )
            : copy(`操作未完成（${code}）。`, `Operation failed (${code}).`),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const fetchModels = async (protocol?: string) => {
    if (modelsBusy || !draft || isArkPlan) return;
    const epoch = ++discoveryEpoch.current;
    const context = discoveryContextRef.current;
    const current = () =>
      epoch === discoveryEpoch.current &&
      context === discoveryContextRef.current;
    setModelsBusy(true);
    setError("");
    try {
      const ids = await canvasMediaProfilesClient.listModels(
        draft.baseUrl,
        draft.apiKey || "",
        protocol || draft.imageProtocol,
        {profileId:draft.expectedRevision===null?undefined:draft.id,profileRevision:draft.expectedRevision??undefined,clearApiKey:!!draft.clearApiKey || draft.expectedRevision===null},
      );
      if (!current()) return;
      setModels(ids);
    } catch (cause) {
      if (!current()) return;
      setModels([]);
      const code = String(cause);
      setError(
        code.includes("no_api_key")
          ? copy(
              "请先填写该服务的 API Key 再获取模型。",
              "Enter this service's API key before fetching models.",
            )
          : code.includes("empty_response")
            ? copy(
                "服务返回了空模型列表。",
                "The service returned an empty model list.",
              )
            : copy(
                `获取模型未完成（${code}）。`,
                `Fetching models failed (${code}).`,
              ),
      );
    } finally {
      if (current()) setModelsBusy(false);
    }
  };

  const editActive = () => {
    if (!active) return;
    setError("");
    setConfirmDelete(false);
    setModels([]);
    setDraft({
      id: active.id,
      name: active.name,
      baseUrl: active.baseUrl,
      imageModel: active.imageModel,
      videoModel: active.videoModel,
      imageModels: active.imageModels,
      videoModels: active.videoModels,
      textModel:active.textModel || "",textProtocol:active.textProtocol || "legacy",textModels:active.textModels,
      imageProtocol: active.imageProtocol,
      videoProtocol: active.videoProtocol,
      expectedRevision: active.revision,
      apiKey: "",
      clearApiKey: false,
    });
  };
  return (
    <section className="canvas-settings-generation canvas-media-profiles">
      <div className="canvas-settings-profile-content" hidden={section !== "generation"}>
      <label className="canvas-settings-connection-row">
        <span>{copy("当前配置", "Active connection")}</span>
        <select
          aria-label={copy("当前生成配置", "Active generation connection")}
          value={active?.id || ""}
          disabled={busy || !snapshot || !!draft}
          onChange={(e) =>
            void run(() => canvasMediaProfilesClient.activate(e.target.value))
          }
        >
          <option value="" disabled>{copy("请选择生成配置", "Select a generation connection")}</option>
          {selectableProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.apiKeyConfigured ? "" : copy(" · 待配置", " · Setup required")}
            </option>
          ))}
        </select>
      </label>
      <div className="canvas-media-profile-command-bar">
        <div className="canvas-media-profile-actions">
          <button
            type="button"
            disabled={busy || !!draft}
            onClick={() => {
              setModels([]);
              setConfirmDelete(false);
              setDraft({
                ...CANVAS_MEDIA_PRESETS.custom,
                textModel:"",textProtocol:"disabled",
                id: `media-${crypto.randomUUID()}`,
                expectedRevision: null,
                apiKey: "",
              });
              setError("");
            }}
          >
            {copy("添加配置", "Add connection")}
          </button>
          <button
            type="button"
            disabled={busy || !active || !!draft}
            onClick={editActive}
          >
            {copy("编辑", "Edit")}
          </button>
          {draft ? (
            <>
              <button
                type="button"
                className="is-primary"
                disabled={busy || !draft.name.trim() || !draft.baseUrl.trim()}
                onClick={() =>
                  void run(
                    () =>
                      canvasMediaProfilesClient.save({
                        ...draft,
                        imageModels:
                          draft.imageProtocol === "disabled"
                            ? []
                            : canvasProfileModelIds({...draft, revision:1, apiKeyConfigured:false}, "image"),
                        textModels: draft.textProtocol === "openai-chat" ? canvasProfileModelIds({...draft, revision:1, apiKeyConfigured:false}, "text") : [],
                        videoModels:
                          draft.videoProtocol === "disabled"
                            ? []
                            : canvasProfileModelIds({...draft, revision:1, apiKeyConfigured:false}, "video"),
                      }),
                    true,
                  )
                }
              >
                {busy
                  ? copy("保存中…", "Saving…")
                  : copy("保存配置", "Save connection")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setConfirmDelete(false);
                  setError("");
                }}
              >
                {copy("取消", "Cancel")}
              </button>
              {draft.expectedRevision !== null &&
              (snapshot?.profiles.length || 0) > 1 ? (
                <button
                  type="button"
                  className="is-danger"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  {copy("删除", "Delete")}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        {draft ? (
          <>
            {" "}
            {confirmDelete ? (
              <div className="canvas-media-profile-delete-confirm" role="alert">
                <p>
                  {copy(
                    "删除后，绑定这套配置的未完成任务将不能继续。确认删除？",
                    "Pending work bound to this connection cannot continue after deletion. Delete?",
                  )}
                </p>
                <div className="canvas-media-profile-actions">
                  <button
                    className="is-danger"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          canvasMediaProfilesClient.remove(
                            draft.id,
                            draft.expectedRevision!,
                          ),
                        true,
                      )
                    }
                  >
                    {copy("确认删除", "Confirm deletion")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmDelete(false)}
                  >
                    {copy("保留", "Keep")}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {!draft && active ? (
        <dl className="canvas-media-profile-summary">
          <div><dt>{copy("文本", "Text")}</dt><dd>{(active.textProtocol ?? "legacy") === "legacy" ? copy("沿用软件设置", "Use app settings") : active.textProtocol === "disabled" ? copy("未启用", "Disabled") : modelSummary("text")}</dd></div>
          <div><dt>{copy("图片", "Image")}</dt><dd>{active.imageProtocol === "disabled" ? copy("未启用", "Disabled") : modelSummary("image")}</dd></div>
          <div><dt>{copy("视频", "Video")}</dt><dd>{active.videoProtocol === "disabled"
            ? copy("未启用", "Disabled")
            : modelSummary("video")}</dd></div>
        </dl>
      ) : null}
      {draft ? (
        <div className="canvas-media-profile-editor">
          <p className="canvas-media-draft-status">
            {copy(
              "编辑中 · 保存后生效",
              "Editing · Save to apply",
            )}
          </p>
          {draft.expectedRevision === null ? (
            <label>
              <span>{copy("预设", "Preset")}</span>
              <select
                defaultValue="custom"
                disabled={busy}
                onChange={(e) => {
                  const preset =
                    CANVAS_MEDIA_PRESETS[
                      e.target.value as keyof typeof CANVAS_MEDIA_PRESETS
                    ];
                  setModels([]);
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          ...preset,
                          textProtocol: "disabled",
                          imageModels: [],
                          videoModels: e.target.value === "bigmodel" ? ["cogvideox-flash"] : [],
                          apiKey: "",
                          clearApiKey: false,
                        }
                      : null,
                  );
                }}
              >
                <option value="arkPlan">火山方舟 · Agent Plan</option>
                <option value="arkPaygo">火山方舟 · 按量付费</option>
                <option value="easycli">EasyCLIProxyAPI</option>
                <option value="custom">{copy("自定义", "Custom")}</option>
                <option value="agnes">Agnes</option>
                <option value="openai">OpenAI</option>
                <option value="twelve">12API</option>
                <option value="genericImage">{copy("通用图片备用 · OpenAI Images 兼容", "Generic image fallback · OpenAI Images compatible")}</option>
                <option value="genericVideo">{copy("通用视频备用 · OpenAI Videos 兼容", "Generic video fallback · OpenAI Videos compatible")}</option>
                <option value="bigmodel">智谱 CogVideoX-Flash</option>
              </select>
            </label>
          ) : null}
          <label>
            <span>{copy("名称", "Name")}</span>
            <input
              disabled={busy}
              value={draft.name}
              maxLength={80}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            <span>Base URL</span>
            <input
              disabled={busy}
              value={draft.baseUrl}
              placeholder="https://…/v1 或 http://127.0.0.1:端口/v1"
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            />
          </label>
          {!isArkPlan ? <fieldset className="canvas-media-profile-section canvas-media-model-group">
            <legend>{copy("文本生成", "Text generation")}</legend>
            <label><span>{copy("文本协议", "Text protocol")}</span>
              <select disabled={busy} value={draft.textProtocol || "legacy"} onChange={e=>setDraft({...draft,textProtocol:e.target.value as CanvasMediaProfileInput["textProtocol"]})}>
                <option value="openai-chat">OpenAI Chat Completions</option>
                <option value="legacy">{copy("沿用软件设置（兼容旧配置）", "Use app settings (legacy)")}</option>
                <option value="disabled">{copy("不启用", "Disabled")}</option>
              </select>
            </label>
            {draft.textProtocol === "openai-chat" ? <>
              <ModelPickerField label={copy("文本模型", "Text model")} value={draft.textModel || ""} values={Array.from(new Set([draft.textModel, ...(draft.textModels ?? [])].filter((id): id is string => !!id)))}
                onChange={textModels=>setDraft({...draft,textModels,textModel:textModels.includes(draft.textModel || "") ? draft.textModel : textModels[0] || ""})} models={models} disabled={busy}
                placeholder={copy("填写或选择文本模型 ID", "Type or pick a text model ID")}
                fetchLabel={copy("获取模型", "Fetch models")} fetchBusy={modelsBusy}
                onFetch={()=>void fetchModels("openai-image")} fetchDisabled={!draft.baseUrl.trim()} />
              <p className="canvas-media-profile-hint">{copy("使用这套配置的 Base URL 和 Key，不再读取软件外部的文本模型设置。模型需支持 /chat/completions。", "Uses this connection's URL and key independently of app text settings; requires /chat/completions support.")}</p>
            </> : null}
          </fieldset> : null}
          <fieldset className="canvas-media-profile-section canvas-media-model-group">
            <legend>{copy("图片生成", "Image generation")}</legend>
          <label>
            <span>{copy("图片协议", "Image protocol")}</span>
            <select
              disabled={busy}
              value={draft.imageProtocol}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  imageProtocol: e.target
                    .value as CanvasMediaProfileInput["imageProtocol"],
                })
              }
            >
              <option value="ark-image">火山方舟 Images</option>
              <option value="easycli-auto">{copy("EasyCLIProxyAPI · 按模型自动匹配", "EasyCLIProxyAPI · Auto by model")}</option>
              <option value="agnes">Agnes</option>
              <option value="openai-image">{copy("OpenAI Images 兼容协议", "OpenAI Images compatible protocol")}</option>
              <option value="gemini-image">Gemini Images</option>
              <option value="12ai-task">12API Task</option>
              <option value="disabled">{copy("不启用", "Disabled")}</option>
            </select>
          </label>
          <ModelPickerField
            label={copy("图片模型", "Image model")}
            value={draft.imageModel} values={Array.from(new Set([draft.imageModel, ...(draft.imageModels ?? [])].filter(Boolean)))}
            onChange={imageModels => setDraft({...draft,imageModels,imageModel:imageModels.includes(draft.imageModel) ? draft.imageModel : imageModels[0] || ""})}
            models={models}
            disabled={busy || draft.imageProtocol === "disabled"}
            placeholder={copy(
              "填写或从列表选择模型 ID",
              "Type or pick a model ID",
            )}
            fetchLabel={copy("获取模型", "Fetch models")}
            fetchBusy={modelsBusy}
            onFetch={() => void fetchModels()}
            fetchDisabled={!draft.baseUrl.trim() || isArkPlan}
          />

          {draft.imageProtocol === "easycli-auto" ? <p className="canvas-media-profile-hint">{copy(
            "选择节点中的 GPT / Gemini 图片模型时自动匹配接口。",
            "Automatically matches the interface for the GPT / Gemini image model selected on the node.",
          )}</p> : null}
          {localGeminiMismatch ? (
            <div className="canvas-media-protocol-hint" role="status">
              <p>
                {copy(
                  "如果这是 EasyCLIProxyAPI，可启用自动匹配：同一配置下，GPT 图片走 OpenAI Images，Gemini 图片走 Gemini Images。",
                  "For EasyCLIProxyAPI, enable automatic routing: GPT images use OpenAI Images and Gemini images use Gemini Images in the same connection.",
                )}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft({ ...draft, imageProtocol: "easycli-auto" });
                  setModels([]);
                  setError("");
                }}
              >
                {copy("启用 EasyCLI 自动匹配", "Enable EasyCLI auto routing")}
              </button>
            </div>
          ) : null}
          </fieldset>
          <fieldset className="canvas-media-profile-section canvas-media-model-group">
            <legend>{copy("视频生成", "Video generation")}</legend>
          <label>
            <span>{copy("视频协议", "Video protocol")}</span>
            <select
              disabled={busy}
              value={draft.videoProtocol}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  videoProtocol: e.target
                    .value as CanvasMediaProfileInput["videoProtocol"],
                  ...(e.target.value === "bigmodel-video" ? {videoModel:"cogvideox-flash",videoModels:["cogvideox-flash"]} : {}),
                })
              }
            >
              <option value="disabled">{copy("不启用", "Disabled")}</option>
              <option value="agnes">Agnes</option>
              <option value="ark-video">火山方舟 Content Generation</option>
              <option value="openai-video">{copy("OpenAI Videos 兼容协议（第三方兼容服务）", "OpenAI Videos compatible protocol (third-party services)")}</option>
              <option value="bigmodel-video">智谱 CogVideoX-Flash</option>
              <option value="12ai-task">12API Task</option>
            </select>
          </label>
          <ModelPickerField
            label={copy("视频模型", "Video model")}
            value={draft.videoModel} values={Array.from(new Set([draft.videoModel, ...(draft.videoModels ?? [])].filter(Boolean)))}
            onChange={videoModels => setDraft({...draft,videoModels,videoModel:videoModels.includes(draft.videoModel) ? draft.videoModel : videoModels[0] || ""})}
            models={draft.videoProtocol === "bigmodel-video" ? ["cogvideox-flash"] : models}
            disabled={busy || draft.videoProtocol === "disabled" || draft.videoProtocol === "bigmodel-video"}
            placeholder={copy(
              "填写或从列表选择模型 ID",
              "Type or pick a model ID",
            )}
            fetchLabel={copy("获取模型", "Fetch models")}
            fetchBusy={modelsBusy}
            onFetch={() => void fetchModels()}
            fetchDisabled={!draft.baseUrl.trim() || isArkPlan || draft.videoProtocol === "bigmodel-video"}
          />
          </fieldset>
          {draft.videoProtocol === "bigmodel-video" ? <p className="canvas-media-profile-hint">{copy(
            "智谱专用异步接口，仅接入 cogvideox-flash。提示词最多 512 个字符，支持一张 PNG／JPEG 图片（不超过 5 MiB）或首帧，不支持尾帧或视频参考；时长、清晰度、音频等未验证参数不发送。免费额度与可用性以智谱账户为准，不会自动切换收费模型。",
            "Dedicated BigModel async API for cogvideox-flash only. Supports a prompt up to 512 characters and one PNG/JPEG image (up to 5 MiB) / first frame, not a last frame or video reference. Unverified duration, resolution and audio options are not sent. Free quota and availability depend on your BigModel account; no automatic switch to paid models.",
          )}</p> : null}
          {draft.imageProtocol === "openai-image" || draft.videoProtocol === "openai-video" ? <p className="canvas-media-profile-hint">{copy(
            "通用备用仅兼容所选 Images／Videos 接口，不是任意厂商通用接口。请填写服务实际支持的地址和模型；仅兼容文本聊天并不代表兼容生图／视频。备用配置需手动切换，不会失败后自动调用或产生额外费用。",
            "Fallback connections require the selected Images / Videos API contract, not just chat compatibility. Enter the service's supported URL and model. Switch connections manually; failures never trigger another provider or extra generation automatically.",
          )}</p> : null}
          <label>
            <span>API Key</span>
            <input
              type="password"
              autoComplete="off"
              disabled={busy || draft.clearApiKey}
              value={draft.apiKey || ""}
              placeholder={copy(
                "已有 Key 留空保留；新配置单独填写",
                "Leave blank to keep an existing key; new connections need their own key",
              )}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            />
          </label>
          {draft.expectedRevision !== null ? (
            <label className="canvas-media-clear-key">
              <input
                type="checkbox"
                disabled={busy}
                checked={!!draft.clearApiKey}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    clearApiKey: e.target.checked,
                    apiKey: "",
                  })
                }
              />
              <span>
                {copy("清除这套配置的 Key", "Clear this connection's key")}
              </span>
            </label>
          ) : null}
          {(draft.imageProtocol === "ark-image" || draft.videoProtocol === "ark-video") ? <p className="canvas-media-profile-hint">{copy("火山方舟与豆包会员不互通。Agent Plan 与按量付费各用独立 Key，不回退；请填写控制台实际可用的准确模型 ID。Agent Plan 不使用 /models 获取列表。停止跟踪不代表供应商停止生成或计费。", "Ark is separate from Doubao membership. Agent Plan and pay-as-you-go use separate keys with no fallback. Enter exact available model IDs; Agent Plan does not query /models. Stopping tracking does not cancel provider work or billing.")}</p> : null}
          <p className="canvas-media-profile-hint">
            {copy(
              "仅支持所选协议的模型可用。使用中转会把提示词与参考素材发送给该服务；请使用它自己的 Key。",
              "Models must support the selected protocol. Relays receive your prompts and references; use a key issued by that service.",
            )}
          </p>
          {isTwelveMediaHost(draft.baseUrl) &&
          ["openai-image", "gemini-image"].includes(draft.imageProtocol) ? (
            <p className="canvas-media-profile-hint">
              {copy(
                "12API 图片会按已识别的 GPT / Gemini 模型匹配对应接口和参数；异步 Task 模式保持独立。其他服务商仍使用你选择的协议。",
                "For 12API, recognised GPT / Gemini image models use their matching interface and parameters. Task mode stays separate; other providers retain the selected protocol.",
              )}
            </p>
          ) : null}
          {draft.imageProtocol === "gemini-image" ? (
            <p className="canvas-media-profile-hint">
              {copy(
                "Gemini 使用 /v1beta 的原生生图接口。模型 ID 以该服务返回的列表为准；登录账号不代表每个模型都有额度。文本模型可在上方文本生成区域独立配置，不会作为图片模型调用。",
                "Gemini uses the native /v1beta image endpoint. Use the model ID returned by this service; account access does not guarantee model quota. Configure text models separately in the text generation section above.",
              )}
            </p>
          ) : null}
          {draft.baseUrl.trim().startsWith("http://") ? (
            <p className="canvas-media-profile-hint">
              {copy(
                "本机接口仅支持 localhost、127.0.0.1 或 [::1]。服务须支持所选图片／视频协议；本机图片使用 Base64 返回。ComfyUI 请使用“连接”中的独立设置。",
                "Local HTTP accepts only localhost, 127.0.0.1 or [::1]. The service must implement the selected image/video protocol; local images use Base64 responses. For ComfyUI, use its separate settings in Connections.",
              )}
            </p>
          ) : null}
          {draft.imageProtocol === "12ai-task" ||
          draft.videoProtocol === "12ai-task" ? (
            <p className="canvas-media-profile-hint">
              {copy(
                "Task 协议按已登记模型提供对应参数；未识别模型仅发送提示词，使用服务默认参数。视频参考需已有公网 HTTPS 地址，不会自动上传本地文件。",
                "Task mode exposes options for registered models; unrecognised models receive only a prompt and use service defaults. Video references require existing public HTTPS URLs; local files are not automatically uploaded.",
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      <GenerationConcurrencySettings en={en} />
      </div>
      <div className="canvas-settings-connections-content" hidden={section !== "connections"}>
      <CanvasComfyUiSettings en={en} />
      </div>
      {error ? (
        <p className="canvas-settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
