import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createDefaultAiModelProfilesClient,
  type AiModelProfile,
  type AiModelProfileInput,
  type AiModelProfilesSnapshot,
  type LightSeekModelSyncResult,
} from "../../core/services/aiModelProfiles";
import {
  AI_PROTOCOL_LABELS,
  AI_PROVIDER_ENTRIES,
  getAiProviderMeta,
  resolveAiProviderPreset,
  type AiApiProtocol,
} from "../../core/services/aiProviders";
import { defineMessages, useMessages } from "../../core/i18n/index";

const COPY = defineMessages({
  "capability.unknown": { "zh-CN": "能力未知", "en-US": "Capabilities unknown" },
  "capability.image": { "zh-CN": "支持图片", "en-US": "Image input" },
  "capability.text": { "zh-CN": "仅文本", "en-US": "Text only" },
  "sync.synced": { "zh-CN": "已同步", "en-US": "Synced" },
  "sync.credentialMissing": { "zh-CN": "未配置凭据", "en-US": "Credentials not configured" },
  "sync.notExported": { "zh-CN": "插件未提供可同步连接", "en-US": "Plugin does not export a syncable connection" },
  "sync.endpointMissing": { "zh-CN": "连接地址不可投影", "en-US": "Connection endpoint cannot be resolved" },
  "sync.unsupported": { "zh-CN": "协议暂不支持", "en-US": "Protocol not supported yet" },
  "sync.skipped": { "zh-CN": "已跳过", "en-US": "Skipped" },
  "status.loadFailed": { "zh-CN": "本地模型配置暂时无法读取", "en-US": "Local model connections are temporarily unavailable" },
  "status.saved": { "zh-CN": "模型配置已保存到本地", "en-US": "Model connection saved locally" },
  "status.invalid": { "zh-CN": "模型配置无效或无法保存", "en-US": "The model connection is invalid or could not be saved" },
  "status.originKeyRequired": { "zh-CN": "更换服务地址后，请填写该服务自己的 Key，或先清除原 Key。", "en-US": "When changing service origin, enter its own key or explicitly clear the old key." },
  "relay.notice": { "zh-CN": "中转服务会收到提示词和输入内容；请使用该中转自己的 Key。模型和能力以账户实际支持为准。", "en-US": "This relay receives prompts and inputs. Use its own key; model availability and capabilities depend on your account." },
  "status.activated": { "zh-CN": "当前模型已切换", "en-US": "Active model connection changed" },
  "status.activateFailed": { "zh-CN": "请先启用该配置并保存 API Key", "en-US": "Enable this connection and save its API key first" },
  "status.deleted": { "zh-CN": "模型配置已删除", "en-US": "Model connection deleted" },
  "status.keepOne": { "zh-CN": "至少需要保留一个可用模型配置", "en-US": "Keep at least one usable model connection" },
  "status.testSuccess.one": { "zh-CN": "连接成功，已读取 {count} 个可用模型", "en-US": "Connected; found {count} available model" }, "status.testSuccess.other": { "zh-CN": "连接成功，已读取 {count} 个可用模型", "en-US": "Connected; found {count} available models" },
  "status.unauthorized": { "zh-CN": "连接失败：API Key 无效或无权访问", "en-US": "Connection failed: the API key is invalid or unauthorized" },
  "status.rateLimited": { "zh-CN": "连接失败：接口请求过于频繁", "en-US": "Connection failed: too many requests" },
  "status.timeout": { "zh-CN": "连接失败：接口响应超时", "en-US": "Connection failed: the endpoint timed out" },
  "status.emptyModels": { "zh-CN": "连接成功，但接口没有返回可用模型；可继续手动填写模型 ID", "en-US": "Connected, but no models were returned. You can still enter a model ID manually." },
  "status.testFailed": { "zh-CN": "连接失败：请检查协议、Base URL、API Key 与网络", "en-US": "Connection failed. Check the protocol, Base URL, API key, and network." },
  "status.syncFailed": { "zh-CN": "暂时无法同步 LightSeek 模型配置，请稍后重试。", "en-US": "Could not sync model connections from LightSeek. Try again later." },
  "status.syncComplete": { "zh-CN": "LightSeek 模型配置同步完成", "en-US": "LightSeek model connections synced" },
  "status.syncPartial": { "zh-CN": "LightSeek 模型配置已部分同步", "en-US": "LightSeek model connections partially synced" },
  "status.syncStale": { "zh-CN": "同步结果已过期，请重新同步", "en-US": "The sync result is outdated. Sync again." },
  "status.syncNotReady": { "zh-CN": "LightSeek 尚未准备好同步模型配置", "en-US": "LightSeek is not ready to sync model connections." },
  "header.title": { "zh-CN": "API 连接", "en-US": "API Connections" },
  "header.description": { "zh-CN": "一个连接可读取并使用多个模型。非敏感参数保存在本地配置文件；密钥只由后端托管。", "en-US": "One connection can expose multiple models. Non-sensitive settings stay in local configuration; secrets are owned by the backend." },
  "action.syncing": { "zh-CN": "正在同步", "en-US": "Syncing" },
  "action.sync": { "zh-CN": "从 LightSeek 同步", "en-US": "Sync from LightSeek" },
  "action.add": { "zh-CN": "添加 API 连接", "en-US": "Add API connection" },
  "note.title": { "zh-CN": "当前连接用于应用内模型调用", "en-US": "The active connection is used by LuckyRay" },
  "note.description": { "zh-CN": "连接测试只验证所选模型的普通消息能力；官方 DSH 的运行与诊断由独立的 DSH 主机负责。", "en-US": "Connection tests cover normal model messages only. Official DSH runtime and diagnostics remain owned by its independent host." },
  "sync.summary": { "zh-CN": "LightSeek 同步结果：已同步 {synced}，跳过 {skipped}，暂不支持 {unsupported}", "en-US": "LightSeek sync: {synced} synced, {skipped} skipped, {unsupported} unsupported" },
  "profile.models.one": { "zh-CN": "{count} 个模型", "en-US": "{count} model" }, "profile.models.other": { "zh-CN": "{count} 个模型", "en-US": "{count} models" },
  "profile.current": { "zh-CN": "当前", "en-US": "Current" },
  "profile.connected": { "zh-CN": "已连接", "en-US": "Connected" },
  "profile.pending": { "zh-CN": "待配置", "en-US": "Setup required" },
  "profile.connection": { "zh-CN": "模型连接", "en-US": "Model connection" },
  "profile.fromLightSeek": { "zh-CN": "来自 LightSeek", "en-US": "From LightSeek" },
  "editor.edit": { "zh-CN": "编辑 API 连接", "en-US": "Edit API connection" },
  "editor.add": { "zh-CN": "添加 API 连接", "en-US": "Add API connection" },
  "editor.description": { "zh-CN": "一枚 Key 管理一组模型；保存后可测试连接并同步模型列表。", "en-US": "One key manages a group of models. Save to test the connection and sync its model list." },
  "editor.close": { "zh-CN": "关闭模型编辑", "en-US": "Close model editor" },
  "field.name": { "zh-CN": "连接名称", "en-US": "Connection name" },
  "field.namePlaceholder": { "zh-CN": "例如：DeepSeek 主力", "en-US": "For example: Primary DeepSeek" },
  "field.provider": { "zh-CN": "提供商", "en-US": "Provider" },
  "field.address": { "zh-CN": "API 地址", "en-US": "API address" },
  "field.model": { "zh-CN": "当前模型", "en-US": "Current model" },
  "field.syncedModels.one": { "zh-CN": "已同步 {count} 个模型", "en-US": "{count} model synced" }, "field.syncedModels.other": { "zh-CN": "已同步 {count} 个模型", "en-US": "{count} models synced" },
  "field.manualModel": { "zh-CN": "可手动输入，连接成功后自动同步", "en-US": "Enter manually; successful connections sync automatically" },
  "field.modelPlaceholder": { "zh-CN": "输入模型 ID", "en-US": "Enter model ID" },
  "compatibility.title": { "zh-CN": "应用内模型连接", "en-US": "LuckyRay model connection" },
  "compatibility.description": { "zh-CN": "用于普通模型消息及现有 Canvas 直连生成；不代表或配置 DSH 运行状态。", "en-US": "Used for normal model messages and existing direct Canvas generation; it does not represent or configure DSH runtime state." },
  "secret.saved": { "zh-CN": "已安全保存；留空不会覆盖。", "en-US": "Saved securely; leave blank to keep it." },
  "secret.local": { "zh-CN": "仅保存在后端本机设置中，前端不会读回。", "en-US": "Stored only in backend settings and never read back by the frontend." },
  "secret.replace": { "zh-CN": "输入新 Key 可替换", "en-US": "Enter a new key to replace" },
  "secret.enter": { "zh-CN": "输入 API Key", "en-US": "Enter API key" },
  "action.hide": { "zh-CN": "隐藏输入", "en-US": "Hide input" },
  "action.show": { "zh-CN": "显示输入", "en-US": "Show input" },
  "action.cancelClear": { "zh-CN": "取消清除", "en-US": "Keep key" },
  "action.clearKey": { "zh-CN": "清除 Key", "en-US": "Clear key" },
  "advanced.title": { "zh-CN": "高级参数", "en-US": "Advanced parameters" },
  "field.protocol": { "zh-CN": "API 协议", "en-US": "API protocol" },
  "field.temperature": { "zh-CN": "温度", "en-US": "Temperature" },
  "field.maxTokens": { "zh-CN": "最大输出 Tokens", "en-US": "Maximum output tokens" },
  "field.context": { "zh-CN": "上下文窗口", "en-US": "Context window" },
  "field.enabled": { "zh-CN": "在模型菜单中启用", "en-US": "Show in model menus" },
  "action.activate": { "zh-CN": "设为当前连接", "en-US": "Make active" },
  "action.reading": { "zh-CN": "正在读取模型", "en-US": "Reading models" },
  "action.test": { "zh-CN": "测试并同步模型", "en-US": "Test & sync models" },
  "action.delete": { "zh-CN": "删除连接", "en-US": "Delete connection" },
  "action.cancel": { "zh-CN": "取消", "en-US": "Cancel" },
  "action.saving": { "zh-CN": "保存中", "en-US": "Saving" },
  "action.save": { "zh-CN": "保存连接", "en-US": "Save connection" },
});

type Props = {
  onActiveProfileChanged: (profile: AiModelProfile) => void;
  onStatus: (message: string, error?: boolean) => void;
};

type Draft = Omit<AiModelProfileInput, "id"> & { id?: string };

function emptyDraft(): Draft {
  const provider = "deepseek";
  const preset = resolveAiProviderPreset(provider);
  return {
    name: "",
    provider,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    model: preset.model,
    availableModels: preset.model ? [preset.model] : [],
    temperature: 0.7,
    maxOutputTokens: preset.maxOutputTokens,
    contextWindowTokens: preset.contextWindowTokens,
    enabled: true,
    apiKey: "",
    clearApiKey: false,
  };
}

function draftFromProfile(profile: AiModelProfile): Draft {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    availableModels: profile.availableModels,
    temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens,
    contextWindowTokens: profile.contextWindowTokens,
    enabled: profile.enabled,
    apiKey: "",
    clearApiKey: false,
  };
}

function createProfileId(): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "").slice(0, 10)
    || Math.random().toString(36).slice(2, 12);
  return `profile-${Date.now().toString(36)}-${random}`.toLowerCase();
}

function capabilityLabel(profile: AiModelProfile, t: ReturnType<typeof useMessages<typeof COPY>>["t"]): string {
  const selected = profile.modelCapabilities.find((capability) => capability.id === profile.model);
  if (!selected || selected.inputState === "unknown") return t("capability.unknown");
  return selected.input.includes("image") ? t("capability.image") : t("capability.text");
}

function syncItemLabel(item: LightSeekModelSyncResult["items"][number], t: ReturnType<typeof useMessages<typeof COPY>>["t"]): string {
  if (item.status === "synced") return t("sync.synced");
  if (item.reason === "credential-missing") return t("sync.credentialMissing");
  if (item.reason === "export-not-registered") return t("sync.notExported");
  if (item.reason === "endpoint-unresolved") return t("sync.endpointMissing");
  if (item.reason === "protocol-unresolved" || item.reason === "wire-protocol-unsupported") {
    return t("sync.unsupported");
  }
  return t("sync.skipped");
}

export default function AiModelProfilesPanel({ onActiveProfileChanged, onStatus }: Props) {
  const { plural, t } = useMessages(COPY);
  const [snapshot, setSnapshot] = useState<AiModelProfilesSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const [busy, setBusy] = useState("");
  const [syncResult, setSyncResult] = useState<LightSeekModelSyncResult | null>(null);

  const selectedProfile = useMemo(
    () => draft?.id ? snapshot?.profiles.find((profile) => profile.id === draft.id) || null : null,
    [draft?.id, snapshot?.profiles],
  );

  const publish = useCallback((next: AiModelProfilesSnapshot) => {
    setSnapshot(next);
    window.dispatchEvent(new CustomEvent("luckyray:ai-model-profiles-changed", { detail: next }));
  }, []);

  const load = useCallback(async () => {
    try {
      const client = await createDefaultAiModelProfilesClient();
      publish(await client.list());
    } catch {
      onStatus(t("status.loadFailed"), true);
    }
  }, [onStatus, publish, t]);

  useEffect(() => { void load(); }, [load]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  };

  const changeProvider = (provider: string) => {
    const preset = resolveAiProviderPreset(provider);
    setDraft((current) => current ? {
      ...current,
      provider,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      model: preset.model || current.model,
      availableModels: preset.model ? [preset.model] : [],
      maxOutputTokens: preset.maxOutputTokens,
      contextWindowTokens: preset.contextWindowTokens,
    } : current);
  };

  const changeProtocol = (protocol: AiApiProtocol) => {
    if (!draft) return;
    const preset = resolveAiProviderPreset(draft.provider, protocol);
    setDraft({ ...draft, protocol: preset.protocol, baseUrl: preset.baseUrl });
  };

  const save = async () => {
    if (!draft) return;
    setBusy("save");
    try {
      const client = await createDefaultAiModelProfilesClient();
      const id = draft.id || createProfileId();
      const next = await client.save({ ...draft, id });
      publish(next);
      const saved = next.profiles.find((profile) => profile.id === id);
      if (saved) {
        setDraft(draftFromProfile(saved));
        if (next.activeProfileId === saved.id) onActiveProfileChanged(saved);
      }
      setKeyVisible(false);
      onStatus(t("status.saved"));
    } catch (error) {
      onStatus(t(String(error).includes("origin-key-required") ? "status.originKeyRequired" : "status.invalid"), true);
    } finally {
      setBusy("");
    }
  };

  const activate = async (profileId: string) => {
    setBusy("activate");
    try {
      const client = await createDefaultAiModelProfilesClient();
      const next = await client.activate(profileId);
      publish(next);
      const profile = next.profiles.find((item) => item.id === next.activeProfileId);
      if (profile) onActiveProfileChanged(profile);
      onStatus(t("status.activated"));
    } catch {
      onStatus(t("status.activateFailed"), true);
    } finally {
      setBusy("");
    }
  };

  const remove = async (profileId: string) => {
    setBusy("delete");
    try {
      const client = await createDefaultAiModelProfilesClient();
      const next = await client.remove(profileId);
      publish(next);
      setDraft(null);
      const active = next.profiles.find((profile) => profile.id === next.activeProfileId);
      if (active) onActiveProfileChanged(active);
      onStatus(t("status.deleted"));
    } catch {
      onStatus(t("status.keepOne"), true);
    } finally {
      setBusy("");
    }
  };

  const testConnection = async (profileId: string) => {
    setBusy("test");
    try {
      const client = await createDefaultAiModelProfilesClient();
      const next = await client.test(profileId);
      publish(next);
      const tested = next.profiles.find((profile) => profile.id === profileId);
      if (tested) setDraft(draftFromProfile(tested));
      onStatus(plural(tested?.availableModels.length || 0, { one: "status.testSuccess.one", other: "status.testSuccess.other" }));
    } catch (error) {
      const code = String(error || "");
      const message = code.includes("unauthorized") ? t("status.unauthorized")
        : code.includes("rate-limited") ? t("status.rateLimited")
          : code.includes("timeout") ? t("status.timeout")
            : code.includes("model-list-empty") ? t("status.emptyModels")
              : t("status.testFailed");
      onStatus(message, true);
    } finally {
      setBusy("");
    }
  };

  const syncFromLightSeek = async () => {
    setBusy("lightseek-sync");
    try {
      const client = await createDefaultAiModelProfilesClient();
      const result = await client.syncFromLightSeek();
      setSyncResult(result);
      if (result.snapshot) {
        publish(result.snapshot);
        const active = result.snapshot.profiles.find(
          (profile) => profile.id === result.snapshot?.activeProfileId,
        );
        if (active) {
          setDraft(draftFromProfile(active));
          onActiveProfileChanged(active);
        }
      }
      const statusKey = result.outcome === "synced" ? "status.syncComplete"
        : result.outcome === "partial" ? "status.syncPartial"
          : result.outcome === "stale" ? "status.syncStale"
            : result.outcome === "not-ready" ? "status.syncNotReady"
              : "status.syncFailed";
      onStatus(t(statusKey), !["synced", "partial"].includes(result.outcome));
    } catch {
      onStatus(t("status.syncFailed"), true);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="ai-profile-manager">
      <div className="ai-profile-manager-head">
        <div>
          <strong>{t("header.title")}</strong>
          <span>{t("header.description")}</span>
        </div>
        <button className="settings-btn" type="button" disabled={Boolean(busy)} onClick={() => void syncFromLightSeek()}>
          {t(busy === "lightseek-sync" ? "action.syncing" : "action.sync")}
        </button>
        <button className="settings-btn settings-btn-primary" type="button" disabled={Boolean(busy)} onClick={() => { setDraft(emptyDraft()); setKeyVisible(false); }}>
          {t("action.add")}
        </button>
      </div>

      <div className="ai-profile-unified-note">
        <span className="ai-profile-unified-icon">↗</span>
        <div><b>{t("note.title")}</b><span>{t("note.description")}</span></div>
      </div>

      {syncResult && syncResult.items.length > 0 && (
        <div className="ai-profile-unified-note" aria-live="polite">
          <span className="ai-profile-unified-icon">{syncResult.synced}</span>
          <div>
            <b>{t("sync.summary", { synced: syncResult.synced, skipped: syncResult.skipped, unsupported: syncResult.unsupported })}</b>
            <span>{syncResult.items.map((item) => `${item.displayName}: ${syncItemLabel(item, t)}`).join("; ")}</span>
          </div>
        </div>
      )}

      <div className="ai-profile-grid">
        {snapshot?.profiles.map((profile) => (
          <button
            type="button"
            key={profile.id}
            className={`ai-profile-card${profile.id === snapshot.activeProfileId ? " active" : ""}${!profile.enabled ? " disabled" : ""}`}
            onClick={() => { setDraft(draftFromProfile(profile)); setKeyVisible(false); }}
          >
            <span className="ai-profile-card-status" />
            <span className="ai-profile-card-copy">
              <b>{profile.name}</b>
              <small>{profile.model} · {plural(profile.availableModels.length, { one: "profile.models.one", other: "profile.models.other" })} · {capabilityLabel(profile, t)} · {profile.sourceProvider || profile.provider}</small>
            </span>
            <span className="ai-profile-card-badges">
              {profile.id === snapshot.activeProfileId && <em>{t("profile.current")}</em>}
              <i className={profile.apiKeyConfigured ? "ready" : ""}>{t(profile.apiKeyConfigured ? "profile.connected" : "profile.pending")}</i>
              <i>{t("profile.connection")}</i>
              {profile.sourceIdentity && <i>{t("profile.fromLightSeek")}</i>}
            </span>
          </button>
        ))}
      </div>

      {draft && (
        <div className="ai-profile-editor">
          <div className="ai-profile-editor-head">
            <div><span className="ai-profile-editor-kicker">MODEL CONNECTION</span><b>{t(draft.id ? "editor.edit" : "editor.add")}</b><span>{t("editor.description")}</span></div>
            <button type="button" className="ai-profile-editor-close" aria-label={t("editor.close")} onClick={() => setDraft(null)}>×</button>
          </div>
          <div className="ai-profile-editor-core">
            <div className="ai-profile-form-grid primary">
              <label><span>{t("field.name")}</span><input className="settings-input" value={draft.name} onChange={(event) => update("name", event.target.value)} placeholder={t("field.namePlaceholder")} /></label>
              <label><span>{t("field.provider")}</span><select className="select" value={draft.provider} onChange={(event) => changeProvider(event.target.value)}>{AI_PROVIDER_ENTRIES.map(([id, meta]) => <option key={id} value={id}>{meta.label}</option>)}</select></label>
              {draft.provider === "twelveai" ? <p className="settings-note">{t("relay.notice")}</p> : null}
              <label className="wide"><span>{t("field.address")}</span><input className="settings-input" value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} /></label>
              <label className="wide"><span>{t("field.model")} <small>{draft.availableModels.length > 1 ? plural(draft.availableModels.length, { one: "field.syncedModels.one", other: "field.syncedModels.other" }) : t("field.manualModel")}</small></span>{draft.availableModels.length > 1 ? <select className="select" value={draft.model} onChange={(event) => update("model", event.target.value)}>{draft.availableModels.map((model) => <option key={model} value={model}>{model}</option>)}</select> : <input className="settings-input" value={draft.model} onChange={(event) => update("model", event.target.value)} placeholder={t("field.modelPlaceholder")} />}</label>
            </div>
            <div className="ai-profile-compatibility">
              <span className="ready" />
              <div><b>{t("compatibility.title")}</b><small>{t("compatibility.description")}</small></div>
            </div>
          </div>

          <div className="settings-secret-editor ai-profile-secret-editor">
            <div className="settings-secret-copy"><b>API Key</b><span>{t(selectedProfile?.apiKeyConfigured ? "secret.saved" : "secret.local")}</span></div>
            <div className="settings-secret-input-row">
              <input
                className="settings-input settings-secret-input"
                type={keyVisible ? "text" : "password"}
                autoComplete="new-password"
                value={draft.apiKey || ""}
                onChange={(event) => update("apiKey", event.target.value)}
                placeholder={t(selectedProfile?.apiKeyConfigured ? "secret.replace" : "secret.enter")}
              />
              <button type="button" className="settings-btn" onClick={() => setKeyVisible((visible) => !visible)}>{t(keyVisible ? "action.hide" : "action.show")}</button>
              {selectedProfile?.apiKeyConfigured && <button type="button" className="settings-btn settings-btn-danger" onClick={() => update("clearApiKey", !draft.clearApiKey)}>{t(draft.clearApiKey ? "action.cancelClear" : "action.clearKey")}</button>}
            </div>
          </div>

          <details className="ai-profile-advanced">
            <summary>{t("advanced.title")}</summary>
            <div className="ai-profile-form-grid advanced">
              <label><span>{t("field.protocol")}</span><select className="select" value={draft.protocol} onChange={(event) => changeProtocol(event.target.value as AiApiProtocol)}>{getAiProviderMeta(draft.provider).protocols.map((protocol) => <option key={protocol} value={protocol}>{AI_PROTOCOL_LABELS[protocol]}</option>)}</select></label>
              <label><span>{t("field.temperature")}</span><input className="settings-input" type="number" min={0} max={2} step={0.1} value={draft.temperature} onChange={(event) => update("temperature", Number(event.target.value))} /></label>
              <label><span>{t("field.maxTokens")}</span><input className="settings-input" type="number" min={64} max={32768} value={draft.maxOutputTokens} onChange={(event) => update("maxOutputTokens", Number(event.target.value))} /></label>
              <label><span>{t("field.context")}</span><input className="settings-input" type="number" min={1024} max={2000000} value={draft.contextWindowTokens} onChange={(event) => update("contextWindowTokens", Number(event.target.value))} /></label>
              <label className="ai-profile-enabled"><span>{t("field.enabled")}</span><button type="button" className={`toggle${draft.enabled ? " on" : ""}`} aria-pressed={draft.enabled} onClick={() => update("enabled", !draft.enabled)} /></label>
            </div>
          </details>

          <div className="ai-profile-editor-actions">
            {draft.id && draft.id !== snapshot?.activeProfileId && <button className="settings-btn" disabled={Boolean(busy)} onClick={() => void activate(draft.id!)}>{t("action.activate")}</button>}
            {draft.id && selectedProfile?.apiKeyConfigured && <button className="settings-btn" disabled={Boolean(busy)} onClick={() => void testConnection(draft.id!)}>{t(busy === "test" ? "action.reading" : "action.test")}</button>}
            {draft.id && <button className="settings-btn settings-btn-danger subtle" disabled={Boolean(busy)} onClick={() => void remove(draft.id!)}>{t("action.delete")}</button>}
            <span />
            <button className="settings-btn" onClick={() => setDraft(null)}>{t("action.cancel")}</button>
            <button className="settings-btn settings-btn-primary" disabled={Boolean(busy) || !draft.name.trim() || !draft.model.trim() || !draft.baseUrl.trim()} onClick={() => void save()}>{t(busy === "save" ? "action.saving" : "action.save")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
