import {CanvasComfyTemplates} from './CanvasComfyTemplates';
import {useEffect, useMemo, useRef, useState} from "react";
import {canvasComfyUiClient, subscribeCanvasComfyUiConfig, type CanvasComfyUiConfig} from "../../core/services/canvasComfyUi";
import {parseComfyWorkflow, ComfyWorkflowError, COMFY_WORKFLOW_LIMITS} from "../../core/canvas/comfyWorkflow";
import "./canvasComfyUi.css";

const MAX_WORKFLOW_BYTES = COMFY_WORKFLOW_LIMITS.bytes;
const copyFor = (en: boolean) => (zh: string, english: string) => en ? english : zh;

export function comfyUiError(cause: unknown, en = false): string {
  if (cause instanceof ComfyWorkflowError && !en) return cause.message;
  const code = (cause instanceof ComfyWorkflowError ? cause.code : String(cause)).toLowerCase();
  const copy = copyFor(en);
  if (/revision|conflict|stale/.test(code)) return copy("配置刚刚发生了变化，请刷新后再试。", "Configuration changed. Refresh and try again.");
  if (/local-address|url-invalid|endpoint/.test(code)) return copy("请输入本机地址，例如 http://127.0.0.1:8188。", "Enter a local address, such as http://127.0.0.1:8188.");
  if (/timeout/.test(code)) return copy("连接超时，请确认本机 ComfyUI 已启动。", "Connection timed out. Check that local ComfyUI is running.");
  if (/unreachable|connection-unavailable/.test(code)) return copy("无法连接 ComfyUI，请确认服务已启动和地址正确。", "Could not connect to ComfyUI. Check that the service is running and the address is correct.");
  if (/unexpected-response/.test(code)) return copy("这个地址没有返回 ComfyUI 状态，请检查地址。", "This address did not return ComfyUI status. Check the address.");
  if (/too-large|file-size/.test(code)) return copy("工作流文件过大，请导出当前工作流的 API JSON（不超过 256KB）。", "Workflow is too large. Export the current workflow as API JSON (up to 256KB).");
  if (/api_export_required/.test(code)) return copy("请在 ComfyUI 选择“导出（API）”，普通工作流 JSON 不能用于生成。", "Choose Export (API) in ComfyUI. UI workflow JSON cannot be used for generation.");
  if (/json|syntax/.test(code)) return copy("无法读取这个 JSON，请从 ComfyUI 重新导出 API 工作流。", "Could not read this JSON. Export an API workflow from ComfyUI.");
  if (/workflow|unsupported|binding|node|graph|reference/.test(code)) return copy("暂不支持这个工作流。请导入 MiniMax-H3 支持分支的 API JSON，而不是普通工作流 JSON。", "This workflow is not supported yet. Import a supported MiniMax-H3 branch API JSON, not a UI workflow JSON.");
  return copy("操作未完成，请确认 ComfyUI 已启动后再试。", "Could not complete this action. Check that ComfyUI is running and try again.");
}

/** Import only stores a workflow. It never submits a ComfyUI prompt. */
export function CanvasComfyUiSettings({en}: {en: boolean}) {
  const copy = copyFor(en);
  const [config, setConfig] = useState<CanvasComfyUiConfig | null>(null);
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8188");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"load" | "save" | "test" | "import" | "rename" | "preflight" | "refresh" | null>("load");
  const [connection, setConnection] = useState<"unknown" | "checking" | "online" | "offline">("unknown");
  const [dependencies, setDependencies] = useState<{ready: boolean; missingClasses: string[]; missingModels: string[]; invalidInputs: string[]} | null>(null);
  const [version, setVersion] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true), operation = useRef(false), addressDirty = useRef(false), nameDirty = useRef(false), loadEpoch = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const configRef = useRef(config); configRef.current = config;
  const adopt = (next: CanvasComfyUiConfig, force = false) => {
    if (!mounted.current) return;
    setConfig(next); configRef.current = next;
    if (force || !addressDirty.current) setBaseUrl(next.baseUrl);
    if (force || !nameDirty.current) setName(next.workflowName || "");
  };
  useEffect(() => {
    mounted.current = true;
    const refresh = async () => {
      const epoch = ++loadEpoch.current;
      try {
        const next = await canvasComfyUiClient.get();
        if (!mounted.current || epoch !== loadEpoch.current) return;
        adopt(next);
      } catch (cause) {
        if (!mounted.current || epoch !== loadEpoch.current) return;
        setFailed(true); setMessage(copyFor(en)("未能读取本地配置，请刷新后重试。", "Could not read local configuration. Refresh and try again."));
      } finally { if (mounted.current && epoch === loadEpoch.current) setBusy(old => old === "load" ? null : old); }
    };
    void refresh();
    const unsubscribe = subscribeCanvasComfyUiConfig(() => { if (!operation.current) void refresh(); });
    return () => { mounted.current = false; loadEpoch.current++; unsubscribe(); };
  }, [en]);

  useEffect(() => {setConnection("unknown"); setVersion("");}, [config?.baseUrl]);
  useEffect(() => {setDependencies(null); setMessage(previous => /^(依赖检查通过|Dependencies checked|工作流需要处理|The workflow needs attention)/.test(previous) ? "" : previous);}, [config?.baseUrl, config?.workflowJson, config?.revision]);
  const workflow = useMemo(() => {
    if (!config?.workflowJson) return null;
    try { return parseComfyWorkflow(config.workflowJson, {id: "configured", name: config.workflowName || "MiniMax-H3"}); }
    catch { return null; }
  }, [config?.workflowJson, config?.workflowName]);

  const run = async (kind: Exclude<typeof busy, "load" | null>, action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(kind); setFailed(false); setMessage("");
    try { await action(); }
    catch (cause) {
      if (/revision|conflict|stale/i.test(String(cause))) {
        try {adopt(await canvasComfyUiClient.get());} catch { /* Keep the actionable original error. */ }
      }
      if (mounted.current) { setFailed(true); setMessage(comfyUiError(cause, en)); }
    }
    finally { operation.current = false; if (mounted.current) setBusy(null); }
  };
  const test = () => run("test", async () => {
    setConnection("checking");
    try {
      const result = await canvasComfyUiClient.test(baseUrl.trim());
      if (!mounted.current) return;
      setConnection(result.reachable ? "online" : "offline"); setVersion(result.version || "");
      if (!result.reachable) throw Error(result.error || "connection-unavailable");
      setMessage(addressDirty.current ? copy("连接正常；生成前请先保存这个地址。", "Connected. Save this address before generating.") : copy("连接正常。工作流会在生成前检查。", "Connected. The workflow will be checked before generation."));
    } catch (cause) { if (mounted.current) setConnection("offline"); throw cause; }
  });
  const save = () => run("save", async () => {
    const next = await canvasComfyUiClient.save(baseUrl.trim());
    if (!mounted.current) return;
    addressDirty.current = false; adopt(next); setConnection("unknown"); setVersion(""); setMessage(copy("地址已保存。", "Address saved."));
  });
  const importFile = (file: File) => run("import", async () => {
    if (file.size === 0) throw Error("workflow-json-empty");
    if (file.size > MAX_WORKFLOW_BYTES) throw Error("workflow-file-size");
    const source = await file.text();
    const workflowName = file.name.replace(/\.json$/i, "").trim().slice(0, 80) || "MiniMax-H3";
    parseComfyWorkflow(source, {id: "configured", name: workflowName});
    if (!mounted.current) return;
    const current = configRef.current;
    if (!current) throw Error("configuration-unavailable");
    const next = await canvasComfyUiClient.saveWorkflow(source, workflowName, current.revision);
    if (!mounted.current) return;
    nameDirty.current = false; adopt(next);
    setMessage(copy("工作流已导入，未开始生成。可在视频节点中选择本地 ComfyUI。", "Workflow imported; nothing was generated. Select local ComfyUI in a video node."));
  });
  const rename = () => run("rename", async () => {
    const current = configRef.current;
    if (!current?.workflowJson || !name.trim()) return;
    const next = await canvasComfyUiClient.saveWorkflow(current.workflowJson, name.trim(), current.revision);
    if (!mounted.current) return;
    nameDirty.current = false; adopt(next); setMessage(copy("名称已保存。", "Name saved."));
  });
  const checkDependencies = () => run("preflight", async () => {
    if (!workflow || !config) return;
    const result = await canvasComfyUiClient.preflight(config.baseUrl, workflow.prompt);
    if (!mounted.current) return;
    if (typeof result.ready !== "boolean" || !Array.isArray(result.missingClasses) || !Array.isArray(result.missingModels)) throw Error("unexpected-response");
    if (result.invalidInputs != null && !Array.isArray(result.invalidInputs)) throw Error("unexpected-response");
    setDependencies({...result, invalidInputs: result.invalidInputs ?? []});
    setMessage(result.ready ? copy("依赖检查通过；实际生成仍取决于本机可用资源。", "Dependencies checked. Generation still depends on available resources.") : copy("工作流需要处理，请展开详情查看。", "The workflow needs attention. Expand details to review."));
  });
  const connectionLabel = connection === "checking" ? copy("检测中", "Checking") : connection === "online" ? copy("已连接", "Connected") : connection === "offline" ? copy("未连接", "Disconnected") : copy("未检测", "Not checked");
  return <section className="canvas-comfy-settings" aria-label={copy("本地 ComfyUI", "Local ComfyUI")} aria-busy={!!busy}>
    <header className="canvas-comfy-heading"><span className="canvas-comfy-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="3"/><path d="M8 21h8m-4-4v4m-5-10 3 3 7-5"/></svg></span><div><strong>{copy("本地 ComfyUI", "Local ComfyUI")}</strong><p>{copy("连接本机，生成图片与视频。", "Create images and videos locally.")}</p></div><span className={`canvas-comfy-status is-${connection}`} role="status"><i aria-hidden="true"/>{connectionLabel}</span></header>
    <label className="canvas-comfy-field"><span>{copy("服务地址", "Service address")}</span><input value={baseUrl} spellCheck={false} disabled={!!busy} onChange={event => {addressDirty.current = event.target.value.trim() !== configRef.current?.baseUrl; setBaseUrl(event.target.value); setConnection("unknown"); setVersion(""); setMessage("");}} placeholder="http://127.0.0.1:8188"/></label>
    <div className="canvas-comfy-actions">{!config && !busy ? <button type="button" onClick={() => void run("refresh", async () => adopt(await canvasComfyUiClient.get()))}>{copy("重新读取配置", "Reload configuration")}</button> : null}<button type="button" disabled={!!busy || !config || !baseUrl.trim()} onClick={() => void save()}>{busy === "save" ? copy("保存中…", "Saving…") : copy("保存地址", "Save address")}</button><button type="button" disabled={!!busy || !baseUrl.trim()} onClick={() => void test()}>{busy === "test" ? copy("检测中…", "Checking…") : copy("检测连接", "Test connection")}</button>{version && connection === "online" ? <small>ComfyUI {version}</small> : null}</div>
    <div className={`canvas-comfy-feedback${failed ? " is-error" : ""}`} role={failed ? "alert" : "status"} aria-live="polite">{message || (busy === "load" ? copy("正在读取配置…", "Reading configuration…") : "")}</div>
    <div className="canvas-comfy-workflow-head"><strong>{copy("可用工作流", "Workflows")}</strong><button type="button" disabled={!!busy || !config} onClick={() => fileInput.current?.click()}>{busy === "import" ? copy("导入中…", "Importing…") : workflow ? copy("替换通用 H3", "Replace general H3") : copy("导入 API 工作流", "Import API workflow")}</button><input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label={copy("选择 API 工作流", "Choose API workflow")} onChange={event => {const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file);}}/></div>
    <div className="canvas-comfy-workflow-card canvas-comfy-suite-card">
      <div className="canvas-comfy-workflow-title"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4Z"/></svg><strong>{copy("短剧制作", "Short drama")}</strong><span>{copy("内置", "Built-in")}</span></div>
      <p className="canvas-comfy-suite-author">Work-Fisher</p>
      <div className="canvas-comfy-suite-pills"><span>{copy("有声视频", "Video & audio")}</span><span>{copy("角色图", "Character")}</span><span>{copy("场景图", "Scene")}</span><span>{copy("三视图", "Character views")}</span></div>
      <p className="canvas-comfy-suite-hint">{copy("在生成卡片中选择，或添加「短剧制作」模板。", "Choose it in a generation card, or add the Short drama template.")}</p>
    </div>
    {workflow ? <div className="canvas-comfy-workflow-card"><div className="canvas-comfy-workflow-title"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4Z"/></svg><strong>{copy("通用 H3", "General H3")}</strong><span>{copy("已导入", "Imported")}</span></div><p className="canvas-comfy-suite-author" title={config?.workflowName}>{config?.workflowName || "MiniMax-H3"}</p><p className="canvas-comfy-metrics"><span>{workflow.summary.width} × {workflow.summary.height}</span><span>{workflow.summary.durationSeconds.toLocaleString(en ? "en-US" : "zh-CN", {maximumFractionDigits:3, useGrouping:false})}{copy("秒", "s")}</span><span>{workflow.summary.fps} fps</span></p><div className="canvas-comfy-dependency-row"><button type="button" disabled={!!busy} onClick={() => void checkDependencies()}>{busy === "preflight" ? copy("检查中…", "Checking…") : copy("检查环境", "Check environment")}</button>{dependencies ? <span role="status">{dependencies.ready ? copy("检查通过", "Checks passed") : copy("需要处理", "Needs attention")}</span> : null}</div><details className="canvas-comfy-details"><summary>{copy("工作流详情", "Workflow details")}</summary>{dependencies && !dependencies.ready ? <div className="canvas-comfy-missing">{dependencies.missingClasses.length ? <p>{copy("缺少节点：", "Missing nodes: ")}{dependencies.missingClasses.join("、")}</p> : null}{dependencies.missingModels.length ? <p>{copy("缺少模型：", "Missing models: ")}{dependencies.missingModels.join("、")}</p> : null}{dependencies.invalidInputs.length ? <p>{copy("参数不匹配：", "Unsupported inputs: ")}{dependencies.invalidInputs.join("、")}</p> : null}</div> : null}<label className="canvas-comfy-field"><span>{copy("显示名称", "Display name")}</span><input value={name} maxLength={80} disabled={!!busy} onChange={event => {nameDirty.current = true; setName(event.target.value);}}/></label><button type="button" disabled={!!busy || !name.trim() || name === config?.workflowName} onClick={() => void rename()}>{copy("保存名称", "Save name")}</button><p>{copy("仅修改通用 H3，不影响短剧制作。", "Changes here apply only to General H3, not Short drama.")}</p></details></div> : <div className="canvas-comfy-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7Z M14 3v5h5M10 13h5m-5 4h5"/></svg><p>{config?.workflowJson ? copy("已保存的工作流无法读取，请重新导入。", "The saved workflow could not be read. Import it again.") : copy("导入已在 ComfyUI 跑通的 API JSON。", "Import an API JSON you have run in ComfyUI.")}</p><small>{copy("MiniMax-H3 文本与参考图生成", "MiniMax-H3 text and reference-image generation")}</small></div>}
    <CanvasComfyTemplates baseUrl={config?.baseUrl}/>
  </section>;
}
