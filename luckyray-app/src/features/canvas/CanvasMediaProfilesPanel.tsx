import { isTwelveMediaHost } from "../../core/canvas/mediaCapabilities";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../core/i18n/index";
import {
  CANVAS_MEDIA_PRESETS,
  canvasMediaProfilesClient,
  type CanvasMediaProfileInput,
  type CanvasMediaProfilesSnapshot,
} from "../../core/services/canvasMediaProfiles";

function ModelPickerField({
  label,
  value,
  onChange,
  models,
  disabled,
  placeholder,
  fetchLabel,
  fetchBusy,
  onFetch,
  fetchDisabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  models: string[];
  disabled?: boolean;
  placeholder: string;
  fetchLabel: string;
  fetchBusy: boolean;
  onFetch: () => void;
  fetchDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!query) return models;
    return models.filter((id) => id.toLowerCase().includes(query));
  }, [models, value]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node))
        setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const select = (id: string) => {
    onChange(id);
    setOpen(false);
    inputRef.current?.focus();
  };
  return (
    <div className="canvas-model-picker" ref={boxRef}>
      <div className="canvas-model-picker-head">
        <label>
          <span>{label}</span>
          <div className="canvas-model-picker-row">
            <input
              ref={inputRef}
              disabled={disabled}
              value={value}
              placeholder={placeholder}
              spellCheck={false}
              aria-haspopup="listbox"
              aria-expanded={open}
              onFocus={() => {
                if (models.length) setOpen(true);
              }}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (!models.length) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setOpen(true);
                }
                if (
                  e.key === "Enter" &&
                  open &&
                  filtered[0] &&
                  filtered[0] !== value
                ) {
                  e.preventDefault();
                  select(filtered[0]);
                }
              }}
            />
            <button
              type="button"
              className="canvas-model-picker-toggle"
              disabled={disabled || !models.length}
              aria-label={
                models.length ? `${models.length} ${fetchLabel}` : fetchLabel
              }
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
            >
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
                <path
                  d="M2 4.2 6 8.4 10 4.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </label>
        <button
          type="button"
          className="canvas-model-fetch"
          disabled={disabled || fetchBusy || fetchDisabled}
          onClick={onFetch}
        >
          <span
            className={
              "canvas-model-fetch-icon" + (fetchBusy ? " is-spinning" : "")
            }
            aria-hidden
          >
            <svg viewBox="0 0 14 14" width="12" height="12">
              <path
                d="M11.6 5.2A4.9 4.9 0 0 0 2.3 4M2.4 8.8a4.9 4.9 0 0 0 9.3 1.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <path
                d="M12 2.6v2.7H9.3M2 11.4V8.7h2.7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          {fetchBusy ? "…" : fetchLabel}
        </button>
      </div>
      {models.length > 0 && (
        <p className="canvas-model-picker-status">
          {models.length} 可选
          {filtered.length !== models.length
            ? ` · 匹配 ${filtered.length}`
            : ""}
          {value.trim() && !models.includes(value.trim())
            ? " · 当前为手动输入"
            : ""}
        </p>
      )}
      {open && models.length > 0 && (
        <div
          className="canvas-model-picker-list"
          role="listbox"
          aria-label={label}
        >
          {filtered.slice(0, 200).map((id) => (
            <button
              key={id}
              type="button"
              role="option"
              aria-selected={id === value}
              className={
                "canvas-model-option" + (id === value ? " is-selected" : "")
              }
              onClick={() => select(id)}
            >
              <span className="canvas-model-option-id">{id}</span>
              {id === value ? (
                <span className="canvas-model-option-check" aria-hidden>
                  <svg viewBox="0 0 12 12" width="11" height="11">
                    <path
                      d="M2.2 6.4 4.8 9 9.8 3.2"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              ) : null}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="canvas-model-picker-empty">
              没有匹配项；可直接手动输入。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function CanvasMediaProfilesPanel({
  snapshot,
  onChange,
}: {
  snapshot: CanvasMediaProfilesSnapshot | null;
  onChange: (value: CanvasMediaProfilesSnapshot) => void;
}) {
  const { locale } = useI18n();
  const en = locale === "en-US";
  const copy = (zh: string, english: string) => (en ? english : zh);
  const [draft, setDraft] = useState<CanvasMediaProfileInput | null>(null);
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
  const active = snapshot?.profiles.find(
    (p) => p.id === snapshot.activeProfileId,
  );
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
            : copy(`操作未完成（${code}）。`, "Operation failed (${code})."),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const fetchModels = async (protocol?: string) => {
    if (modelsBusy || !draft) return;
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
                "Fetching models failed (${code}).",
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
      <div className="canvas-settings-section-title">
        <strong>{copy("生成配置", "Generation connections")}</strong>
      </div>
      <label>
        <span>{copy("当前配置", "Active connection")}</span>
        <select
          aria-label={copy("当前生成配置", "Active generation connection")}
          value={active?.id || ""}
          disabled={busy || !snapshot || !!draft}
          onChange={(e) =>
            void run(() => canvasMediaProfilesClient.activate(e.target.value))
          }
        >
          {snapshot?.profiles.map((p) => (
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
                            : models.length
                              ? models.filter((id) => /image|图|img/i.test(id))
                              : draft.imageModels,
                        textModels: draft.textProtocol === "openai-chat" ? (models.length ? models : draft.textModels) : [],
                        videoModels:
                          draft.videoProtocol === "disabled"
                            ? []
                            : models.length
                              ? models.filter((id) => /video|视频/i.test(id))
                              : draft.videoModels,
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
        <p className="canvas-media-profile-summary">
          {copy("文本", "Text")}: {(active.textProtocol ?? "legacy") === "legacy" ? copy("沿用软件设置", "Use app settings") : active.textProtocol === "disabled" ? copy("未启用", "Disabled") : active.textModel || "—"}
          <br />
          {copy("图片", "Image")}: {active.imageModel || "—"}
          <br />
          {copy("视频", "Video")}:{" "}
          {active.videoProtocol === "disabled"
            ? copy("未启用", "Disabled")
            : active.videoModel || "—"}
        </p>
      ) : null}
      {draft ? (
        <div className="canvas-media-profile-editor">
          <p className="canvas-media-draft-status">
            {copy(
              "编辑中 · 收起面板会保留本次输入，保存后生效",
              "Editing · Closing this panel keeps your input; save to apply",
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
                          apiKey: "",
                          clearApiKey: false,
                        }
                      : null,
                  );
                }}
              >
                <option value="easycli">EasyCLIProxyAPI · Gemini</option>
                <option value="custom">{copy("自定义", "Custom")}</option>
                <option value="agnes">Agnes</option>
                <option value="openai">OpenAI</option>
                <option value="twelve">12API</option>
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
          <fieldset className="canvas-media-profile-section">
            <legend>{copy("文本生成", "Text generation")}</legend>
            <label><span>{copy("文本协议", "Text protocol")}</span>
              <select disabled={busy} value={draft.textProtocol || "legacy"} onChange={e=>setDraft({...draft,textProtocol:e.target.value as CanvasMediaProfileInput["textProtocol"]})}>
                <option value="openai-chat">OpenAI Chat Completions</option>
                <option value="legacy">{copy("沿用软件设置（兼容旧配置）", "Use app settings (legacy)")}</option>
                <option value="disabled">{copy("不启用", "Disabled")}</option>
              </select>
            </label>
            {draft.textProtocol === "openai-chat" ? <>
              <ModelPickerField label={copy("文本模型", "Text model")} value={draft.textModel || ""}
                onChange={textModel=>setDraft({...draft,textModel})} models={models} disabled={busy}
                placeholder={copy("填写或选择文本模型 ID", "Type or pick a text model ID")}
                fetchLabel={copy("获取模型", "Fetch models")} fetchBusy={modelsBusy}
                onFetch={()=>void fetchModels("openai-image")} fetchDisabled={!draft.baseUrl.trim()} />
              <p className="canvas-media-profile-hint">{copy("使用这套配置的 Base URL 和 Key，不再读取软件外部的文本模型设置。模型需支持 /chat/completions。", "Uses this connection's URL and key independently of app text settings; requires /chat/completions support.")}</p>
            </> : null}
          </fieldset>
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
              <option value="agnes">Agnes</option>
              <option value="openai-image">OpenAI Images</option>
              <option value="gemini-image">Gemini Images</option>
              <option value="12ai-task">12API Task</option>
              <option value="disabled">{copy("不启用", "Disabled")}</option>
            </select>
          </label>
          {localGeminiMismatch ? (
            <div className="canvas-media-protocol-hint" role="status">
              <p>
                {copy(
                  "EasyCLIProxyAPI 的 Gemini 账号生图使用 Gemini Images 协议。OpenAI Images 接口不能仅凭同名模型直接调用。",
                  "Gemini account images in EasyCLIProxyAPI use Gemini Images; an OpenAI Images endpoint does not gain support from the model name alone.",
                )}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft({ ...draft, imageProtocol: "gemini-image" });
                  setModels([]);
                  setError("");
                }}
              >
                {copy("改用 Gemini Images", "Use Gemini Images")}
              </button>
            </div>
          ) : null}
          <ModelPickerField
            label={copy("图片模型", "Image model")}
            value={draft.imageModel}
            onChange={(imageModel) => setDraft({ ...draft, imageModel })}
            models={models}
            disabled={busy}
            placeholder={copy(
              "填写或从列表选择模型 ID",
              "Type or pick a model ID",
            )}
            fetchLabel={copy("获取模型", "Fetch models")}
            fetchBusy={modelsBusy}
            onFetch={() => void fetchModels()}
            fetchDisabled={!draft.baseUrl.trim()}
          />
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
                })
              }
            >
              <option value="disabled">{copy("不启用", "Disabled")}</option>
              <option value="agnes">Agnes</option>
              <option value="openai-video">OpenAI / Sora Videos</option>
              <option value="12ai-task">12API Task</option>
            </select>
          </label>
          <ModelPickerField
            label={copy("视频模型", "Video model")}
            value={draft.videoModel}
            onChange={(videoModel) => setDraft({ ...draft, videoModel })}
            models={models}
            disabled={busy}
            placeholder={copy(
              "填写或从列表选择模型 ID",
              "Type or pick a model ID",
            )}
            fetchLabel={copy("获取模型", "Fetch models")}
            fetchBusy={modelsBusy}
            onFetch={() => void fetchModels()}
            fetchDisabled={!draft.baseUrl.trim()}
          />
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
                "本机接口仅支持 localhost、127.0.0.1 或 [::1]。服务须支持所选图片／视频协议；本机图片使用 Base64 返回。ComfyUI 工作流接口尚未接入。",
                "Local HTTP accepts only localhost, 127.0.0.1 or [::1]. The service must implement the selected image/video protocol; local images use Base64 responses. ComfyUI workflows are not yet supported.",
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
      {error ? (
        <p className="canvas-settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
