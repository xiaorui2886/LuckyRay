import {isTemplateExecution,validateTemplateExecution} from '../canvas/comfyTemplate';
import {parseComfyWorkflow} from '../canvas/comfyWorkflow';
import {readWorkFisherImage} from '../canvas/workFisherPreset';
import {prepareComfyReferenceImage} from './comfyReferenceImages';
import { invoke } from "@tauri-apps/api/core";
import type { CanvasGenerationRequestSnapshot } from "../canvas/generationTasks";
import type { CanvasVideoGenerationProgress, CanvasVideoGenerationResponse } from "../canvas/videoGenerationAdapter";

export type CanvasComfyUiConfig = { baseUrl: string; workflowJson?: string; workflowName?: string; revision: number };
export type CanvasComfyUiConnection = { reachable: boolean; version?: string; error?: string };
export type ComfyJob = { clientTaskId: string; promptId?: string; state: "uploading" | "submitting" | "queued" | "running" | "succeeded" | "failed" | "unknown"; error?: string; videoPath?: string; imagePath?:string };
function comfyErrorMessage(code?: string): string {
  if (code?.includes("host-buffer")) return "模型读取失败，可能与系统内存容量有关。请查看 ComfyUI，原提示词和参数已保留";
  if (code?.includes("out-of-memory")) return "ComfyUI 报告内存或显存不足，请处理资源占用后再生成";
  if (code?.includes("preflight")) return "工作流所需节点或模型尚未就绪，请在连接设置中检查依赖";
  if (code?.includes("workflow-template")) return "工作流模板或映射无效，请重新检查模板配置。";
  if (code?.includes("workflow")) return "工作流格式或参数不受支持，请重新导入已确认的 H3 API 工作流";
  if (code?.includes("local-address")) return "请使用本机 ComfyUI 地址，例如 http://127.0.0.1:8188";
  return "ComfyUI 生成失败，提示词和参数已保留；请查看服务端错误";
}
function comfyDiagnostic(error:unknown,phase:string):string {
  const value=String(error);
  const cause=/\b(?:stat|open|read)\b[^\n]*not allowed|not allowed[^\n]*\b(?:stat|open|read)\b/i.test(value)?'local-file-command-denied'
    :value.includes('COMFY_IMAGE_LOCAL_READ_FAILED')?'local-image-read-failed'
      :value.includes('comfyui-settings-unavailable')?'local-task-state-unavailable'
        :/invalid args|invalid type/i.test(value)?'native-arguments-invalid'
          :error instanceof TypeError?'javascript-type-error':'unknown';
  // Only fixed categories cross into persisted history, never the raw exception.
  return `phase=${phase}; cause=${cause}; provider_http=unknown`;
}
const listeners = new Set<() => void>();
export function subscribeCanvasComfyUiConfig(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function changed() { for (const listener of listeners) listener(); }
function config(value: unknown): CanvasComfyUiConfig {
  const row = value as CanvasComfyUiConfig;
  if (!row || typeof row.baseUrl !== "string" || !Number.isSafeInteger(row.revision) || row.revision < 0
    || (row.workflowJson != null && typeof row.workflowJson !== "string") || (row.workflowName != null && typeof row.workflowName !== "string")) throw Error("comfyui-config-invalid");
  return { baseUrl: row.baseUrl, revision: row.revision, workflowJson: row.workflowJson ?? undefined, workflowName: row.workflowName ?? undefined };
}
export function createCanvasComfyUiClient(call: typeof invoke = invoke) {
  const mutate = async (command: string, args: Record<string, unknown>) => { const result = config(await call(command, args)); changed(); return result; };
  return {
    get: async () => config(await call("canvas_comfyui_get_config")),
    save: (baseUrl: string) => mutate("canvas_comfyui_set_config", { baseUrl }),
    saveWorkflow: (workflowJson: string | null, workflowName: string, expectedRevision: number) => mutate("canvas_comfyui_set_workflow", { workflowJson, workflowName, expectedRevision }),
    test: (baseUrl: string) => call<CanvasComfyUiConnection>("canvas_comfyui_test_connection", { baseUrl }),
    preflight: (baseUrl: string, workflow: unknown) => call<{ready: boolean; missingClasses: string[]; missingModels: string[]; invalidInputs?: string[]; installedUnetModels?: string[]; installedLoraModels?: string[]}>("canvas_comfyui_preflight", { baseUrl, workflow }),
  };
}
export const canvasComfyUiClient = createCanvasComfyUiClient();

export function createComfyVideoGenerator(call: typeof invoke = invoke, pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException("Stopped watching", "AbortError")); return; }
  const abort = () => { clearTimeout(timer); reject(new DOMException("Stopped watching", "AbortError")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  signal?.addEventListener("abort", abort, {once: true});
})) {
  return async (request: CanvasGenerationRequestSnapshot, clientTaskId: string, onProgress?: (value: CanvasVideoGenerationProgress) => void, signal?: AbortSignal): Promise<CanvasVideoGenerationResponse & {imageUrl?:string}> => {
    if (!request.comfyui || (request.kind !== "video" && request.kind !== "image")) return {success:false,error_kind:"COMFY_WORKFLOW_REQUIRED",error_message:"请先选择 ComfyUI 工作流"};
    if (request.references.some(ref => !["text","note","image"].includes(ref.kind))) return {success:false,error_kind:"COMFY_REFERENCES_UNSUPPORTED",error_message:"当前工作流不支持视频或音频引用"};
    if(isTemplateExecution(request.comfyui.workflow)) {
      try {const execution=validateTemplateExecution(request.comfyui.workflow);if(execution.output.kind!==request.kind)throw Error('模板输出类型与卡片不一致。');}
      catch(error){return {success:false,error_kind:'COMFY_WORKFLOW_INVALID',error_message:error instanceof Error?error.message:'模板运行快照无效。'};}
    }
    const stopped = () => ({success:false,error_kind:"COMFY_WATCH_STOPPED",error_message:"已停止跟踪；ComfyUI 中的任务可能仍在运行，可恢复查看"});
    let phase='prepare';
    try {
      if (signal?.aborted) return stopped();
      onProgress?.({stage:"submitting"});
      // The native ledger makes this idempotent. Unknown acceptance is never a new POST.
      const bindings=isTemplateExecution(request.comfyui.workflow)?request.comfyui.workflow.images.map(nodeId=>({nodeId})):request.kind==='image'?readWorkFisherImage(request.comfyui.workflow).imageNodeIds.map(nodeId=>({nodeId})):parseComfyWorkflow(request.comfyui.workflow,{id:'submitted',name:request.comfyui.workflowName}).bindings.images;
      const imageReferences=request.references.filter(ref=>ref.kind==='image');
      if(imageReferences.length!==bindings.length)throw Error('COMFY_IMAGE_COUNT_INVALID');
      let job:ComfyJob;
      if(imageReferences.length) {
        // Resuming an accepted job must not read changed/deleted source files or
        // upload again. Only the exact not-found response permits first submit.
        const imageSources=await Promise.all(imageReferences.map(async ref=>{
          const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ref.mediaUrl || ''));
          return JSON.stringify([ref.id,[...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('')]);
        }));
        phase='local-task-lookup';
        try {job=await call<ComfyJob>('canvas_comfyui_submit',{request:{clientTaskId,baseUrl:request.comfyui.baseUrl,workflow:request.comfyui.workflow,imageSources,resumeOnly:true}});}
        catch(error) {
          if(String(error)!=='comfyui-task-not-found')throw error;
          const images=[];phase='reference-read';
          for(let index=0;index<imageReferences.length;index++) {
            if(signal?.aborted)return stopped();
            const value=imageReferences[index].mediaUrl;if(!value)throw Error('COMFY_IMAGE_UNAVAILABLE');
            images.push({nodeId:bindings[index].nodeId,dataUrl:await prepareComfyReferenceImage(value,signal)});
          }
          if(signal?.aborted)return stopped();
          phase='native-submit';
          job=await call<ComfyJob>('canvas_comfyui_submit',{request:{clientTaskId,baseUrl:request.comfyui.baseUrl,workflow:request.comfyui.workflow,imageSources,images}});
        }
      } else {phase='native-submit';job = await call<ComfyJob>("canvas_comfyui_submit", {request:{clientTaskId,baseUrl:request.comfyui.baseUrl,workflow:request.comfyui.workflow}});}
      const deadline = Date.now() + 6 * 60 * 60 * 1000;
      for (;;) {
        if (signal?.aborted) return stopped();
        if (job.clientTaskId !== clientTaskId) throw Error("comfyui-job-identity-mismatch");
        if (job.state === "unknown") return {success:false,error_kind:"SUBMISSION_UNKNOWN",error_message:"无法确认任务是否已受理，请到 ComfyUI 核对，避免重复生成",error_detail:job.error};
        if (job.state === "failed") return {success:false,error_kind:"COMFY_EXECUTION_FAILED",error_message:comfyErrorMessage(job.error)};
        if (job.state === "succeeded") {
          onProgress?.({stage:"downloading",providerTaskId:job.promptId});
          phase='materialize';const result = await call<ComfyJob>("canvas_comfyui_materialize", {clientTaskId});
          if(request.kind==='image') {if(!result.imagePath)throw Error(result.error||'comfyui-image-missing');return {success:true,imageUrl:result.imagePath};}
          if (!result.videoPath) throw Error(result.error || "comfyui-video-missing");
          return {success:true,videoUrl:result.videoPath};
        }
        onProgress?.({stage:job.state === "uploading" || job.state === "submitting" ? "submitting" : job.state === "running" ? "generating" : "queued",providerTaskId:job.promptId});
        if (Date.now() > deadline) throw Error("comfyui-observation-timeout");
        await pause(1500, signal);
        phase='status-read';job = await call<ComfyJob>("canvas_comfyui_job_status", {clientTaskId});
      }
    } catch (error) {
      if (signal?.aborted) return stopped();
      const code = String(error);
      if(code.includes('comfyui-reference-capacity'))return {success:false,error_kind:'COMFY_REFERENCE_CAPACITY',error_message:'当前 ComfyUI 节点未提供这些参考图输入。请减少图片，或核对当前工作流节点的输入数量。未上传图片或提交生成。'};
      if(code.includes('COMFY_IMAGE_'))return {success:false,error_kind:'COMFY_IMAGE_INVALID',error_message:code.includes('LOCAL_REQUIRED')?'请先将参考图导入本机素材库，再连接到此卡片。':code.includes('TOO_LARGE')?'参考图超过 12 MB，请选择较小的 PNG、JPEG 或 WebP 原图。':code.includes('LOCAL_READ_FAILED')?'本机参考图读取失败，尚未提交生成；请检查原图是否可访问。':'参考图无法读取或数量不符，请检查图片和生成方式。',error_detail:comfyDiagnostic(error,phase)};
      if (code.includes("submission-binding-changed")) return {success:false,error_kind:"SUBMISSION_BINDING_CHANGED",error_message:"原任务的工作流或地址已变化，不能安全恢复；请先核对 ComfyUI 中的原任务"};
      if (/comfyui-(?:preflight|workflow|local-address)/.test(code)) return {success:false,error_kind:"COMFY_EXECUTION_FAILED",error_message:comfyErrorMessage(code)};
      return {success:false,error_kind:"COMFY_OBSERVATION_INTERRUPTED",error_message:"与 ComfyUI 的连接中断，可恢复查看原任务",error_detail:comfyDiagnostic(error,phase)};
    }
  };
}
export const generateComfyVideo = createComfyVideoGenerator();
