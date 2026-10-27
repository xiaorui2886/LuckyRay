import { REASONING_TIMING_FIELDS, validReasoningTiming, projectReasoningTiming, projectCanvasAgentErrorDetail } from '../canvas/agent/wire';
import { runDshHostOperation } from './dshHostOperations';
import { invoke } from '@tauri-apps/api/core';
import {projectCanvasAgentR5} from '../canvas/agent/wire';
import { validateCanvasAgentPlan } from '../canvas/agent/plan';
import type { CanvasAgentContext } from '../canvas/agent/types';
import type { CanvasAgentRequest,CanvasAgentSnapshot,CanvasAgentModels } from '../canvas/agent/types';

export const CANVAS_AGENT_RPC_BYTES=2*1024*1024;
export function projectCanvasAgentSnapshot(value:unknown,canvasId:string):CanvasAgentSnapshot {
  const invalid=()=>{throw Error('canvas-agent-response-invalid');};
  const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(v);
  if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
  const raw=value as Record<string,unknown>;
  if(typeof raw.error==='string'&&!raw.status)throw Error(/^canvas-agent-[a-z-]+$/.test(raw.error)?raw.error:'canvas-agent-unavailable');
  if(!id(raw.conversationId))return invalid();
  if(raw.canvasId!==canvasId||!['idle','running','completed','failed','cancelled'].includes(String(raw.status))||!Array.isArray(raw.messages)||raw.messages.length>128||new TextEncoder().encode(JSON.stringify(value)).length>CANVAS_AGENT_RPC_BYTES)return invalid();
  if(!(raw.sessionId===null||id(raw.sessionId))||!(raw.runId===null||id(raw.runId))||(raw.requestId!==undefined&&!id(raw.requestId)))return invalid();
  for(const message of raw.messages){if(!message||Object.keys(message).some(key=>!['role','text','reasoningText','turnId','messageId','attemptId','createdAt','eventSeq',...REASONING_TIMING_FIELDS].includes(key))||!validReasoningTiming(message)||!['user','assistant'].includes(message.role)||typeof message.text!=='string'||message.text.length>256000||(message.reasoningText!==undefined&&(typeof message.reasoningText!=='string'||message.reasoningText.length>256000))||['turnId','messageId','attemptId'].some(key=>message[key]!==undefined&&!id(message[key]))||(message.createdAt!==undefined&&(!Number.isSafeInteger(message.createdAt)||message.createdAt<0))||(message.eventSeq!==undefined&&(!Number.isSafeInteger(message.eventSeq)||message.eventSeq<0)))return invalid();}
  let context:CanvasAgentContext|undefined;
  if(raw.context){
    const c=raw.context as CanvasAgentContext;
    if((c.snapshotRevision!==undefined&&!/^[a-f0-9]{16}$/.test(c.snapshotRevision))||c.version!==1||c.canvasId!==canvasId||typeof c.canvasName!=='string'||!Array.isArray(c.nodes)||c.nodes.length>256||!Array.isArray(c.connections)||c.connections.length>2048||!c.generation)return invalid();
    const seen=new Set<string>();
    for(const node of c.nodes){if(!node||!id(node.id)||seen.has(node.id)||!['text','image','video','note','group'].includes(node.kind)||typeof node.title!=='string'||typeof node.text!=='string'||typeof node.editable!=='boolean'||typeof node.revision!=='string'||!/^[a-f0-9]{16}$/.test(node.revision)||node.image!==undefined)return invalid();if(node.layout&&(![node.layout.x,node.layout.y].every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e7)||(node.layout.parentId!==undefined&&!id(node.layout.parentId))))return invalid();seen.add(node.id);}
    if(c.connections.some(edge=>!edge||!seen.has(edge.source)||!seen.has(edge.target)))return invalid();
    if(typeof c.generation.imageReady!=='boolean'||typeof c.generation.videoReady!=='boolean')return invalid();
    for(const list of [c.generation.imageModels,c.generation.videoModels])if(!Array.isArray(list)||list.length>32||list.some(model=>typeof model!=='string'))return invalid();
    for(const options of [c.generation.imageOptions,c.generation.videoOptions])if(options){for(const key of ['aspects','resolutions','qualities','durations'] as const)if(!Array.isArray(options[key])||options[key].length>32||options[key].some(v=>key==='durations'?typeof v!=='number'||!Number.isFinite(v):typeof v!=='string'))return invalid();}
    context=c;
  }
  const plan=raw.plan!==undefined?(context?validateCanvasAgentPlan(raw.plan,context,raw.runId as string):invalid()):undefined;
  if(raw.error!==undefined&&(typeof raw.error!=='string'||!/^canvas-agent-[a-z-]+$/.test(raw.error)))return invalid();
  const errorDetail=raw.errorDetail===undefined?undefined:raw.status==='failed'&&raw.error?projectCanvasAgentErrorDetail(raw.errorDetail):invalid();
  if(raw.model!==undefined&&(typeof raw.model!=='string'||raw.model.length>160))return invalid();
  let models:CanvasAgentModels|undefined;
  if(raw.models!==undefined){
    const m=raw.models as CanvasAgentModels;
    const str=(v:unknown,max=160)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
    const selection=(v:unknown)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&str((v as CanvasAgentModels['available'][number]).provider)&&str((v as CanvasAgentModels['available'][number]).model);
    const reasoningValid=(r:CanvasAgentModels['available'][number]['reasoning'])=>r===undefined||(!!r&&Array.isArray(r.efforts)&&r.efforts.length>0&&r.efforts.length<=32&&r.efforts.every(e=>!!e&&str(e.id)&&str(e.name)&&(e.description===undefined||str(e.description,640)))&&new Set(r.efforts.map(e=>e.id)).size===r.efforts.length&&(r.defaultEffort===undefined||r.efforts.some(e=>e.id===r.defaultEffort)));
    if(!m||!Array.isArray(m.available)||m.available.length>256||m.available.some(v=>!selection(v)||!str(v.label,323)||!Array.isArray(v.inputModalities)||v.inputModalities.some(x=>!['text','image'].includes(x))||!reasoningValid(v.reasoning))
      ||![m.defaultModel,m.currentModel].every(v=>v===null||(selection(v)&&(v.reasoningEffort===undefined||str(v.reasoningEffort)))))return invalid();
    const project=(v:CanvasAgentModels['defaultModel'])=>v?{provider:v.provider,model:v.model,...(v.reasoningEffort?{reasoningEffort:v.reasoningEffort}:{})}:null;
    models={available:m.available.map(v=>({provider:v.provider,model:v.model,label:v.label,inputModalities:[...v.inputModalities],...(v.reasoning?{reasoning:{efforts:v.reasoning.efforts.map(e=>({id:e.id,name:e.name,...(e.description?{description:e.description}:{})})),...(v.reasoning.defaultEffort?{defaultEffort:v.reasoning.defaultEffort}:{})}}:{})})),defaultModel:project(m.defaultModel),currentModel:project(m.currentModel)};
  }
  const labels=['preparing','resolving-model','opening-session','waiting-model','reading-context','proposing-plan','finalizing','stopping'];
  if(raw.activity!==undefined&&(!Array.isArray(raw.activity)||raw.activity.length>24||raw.activity.some(a=>!a||!id(a.id)||!['phase','tool'].includes(a.kind)||!labels.includes(a.label)||!['running','completed','failed'].includes(a.status)||!Number.isSafeInteger(a.startedAt)||a.startedAt<0||(a.endedAt!==undefined&&(!Number.isSafeInteger(a.endedAt)||a.endedAt<a.startedAt)))||new Set(raw.activity.map(a=>a.id)).size!==raw.activity.length))return invalid();
  const extensions=projectCanvasAgentR5(raw,canvasId,(value)=>{
    const nested=projectCanvasAgentSnapshot({canvasId,conversationId:raw.conversationId,sessionId:null,runId:null,status:'idle',messages:[],context:value},canvasId);
    if(!nested.context)return invalid();return nested.context;
  });
  return {...extensions,...(errorDetail?{errorDetail}:{}),canvasId,conversationId:raw.conversationId as string,...(Array.isArray(raw.activity)?{activity:raw.activity.map(a=>({id:a.id,kind:a.kind,label:a.label,status:a.status,startedAt:a.startedAt,...(a.endedAt!==undefined?{endedAt:a.endedAt}:{})}))}:{}),sessionId:raw.sessionId as string|null,runId:raw.runId as string|null,status:raw.status as CanvasAgentSnapshot['status'],messages:raw.messages.map(m=>({...projectReasoningTiming(m),role:m.role,text:m.text,...(m.reasoningText!==undefined?{reasoningText:m.reasoningText}:{}),...(m.turnId!==undefined?{turnId:m.turnId}:{}),...(m.messageId!==undefined?{messageId:m.messageId}:{}),...(m.attemptId!==undefined?{attemptId:m.attemptId}:{}),...(m.createdAt!==undefined?{createdAt:m.createdAt}:{}),...(m.eventSeq!==undefined?{eventSeq:m.eventSeq}:{})})),...(raw.requestId?{requestId:raw.requestId as string}:{}),...(context?{context}:{}),...(plan?{plan}:{}),...(raw.error?{error:raw.error as string}:{}),...(raw.model?{model:raw.model as string}:{}),...(models?{models}:{})};
}

export function createCanvasAgentClient(call:typeof invoke=invoke) {
  return {async dispatch(request:CanvasAgentRequest,isCurrent:()=>boolean=()=>true){
    if(request.op==='start'&&request.prompt.length>48000)throw Error('canvas-agent-prompt-limit');
    if(new TextEncoder().encode(JSON.stringify(request)).length>CANVAS_AGENT_RPC_BYTES)throw Error('canvas-agent-context-limit');
    return runDshHostOperation(async()=>{
      if(!isCurrent())throw Error('canvas-agent-canvas-changed');
      return projectCanvasAgentSnapshot(await call('canvas_agent_dispatch',{request}),request.canvasId);
    });
  }};
}
export const canvasAgentClient=createCanvasAgentClient();
export async function prepareCanvasAgentHost(){
  const [{getCurrentWindow},{preloadDshBackgroundAtStartup}]=await Promise.all([import('@tauri-apps/api/window'),import('./dshBackgroundPreload')]);
  if(getCurrentWindow().label!=='main')throw Error('canvas-agent-main-window-required');
  await preloadDshBackgroundAtStartup('main');
}
export function canvasAgentErrorMessage(error:unknown,english=false):string {
  const code=typeof error==='string'?error:error instanceof Error?error.message:'';
  const messages:Record<string,[string,string]>={
    'canvas-agent-model-failed':['本次请求未完成，未收到具体错误原因。','This request did not complete. No specific error reason was received.'],
    'canvas-agent-runtime-unavailable':['LSH 运行时连接不可用，请检查 LSH 是否已启动并重新连接。','The LSH runtime connection is unavailable. Check that LSH is running and reconnect.'],
    'canvas-agent-auth-required':['LSH 模型认证失败，请检查该模型的登录或凭据配置后重试。','LSH model authentication failed. Check its sign-in or credentials configuration and retry.'],
    'canvas-agent-quota-exceeded':['本次请求的额度已用尽；画布和对话已保留。','The request quota is exhausted. Your canvas and conversation are kept.'],
    'canvas-agent-rate-limit':['本次模型请求受到速率限制，请稍后再试；连接未因此失效。','This model request was rate limited. Try again later; the connection was not disabled.'],
    'canvas-agent-model-context-limit':['本次模型请求超过该模型的上下文上限，请减少引用或缩短内容。','This request exceeds the model context limit. Reduce references or shorten the request.'],
    'canvas-agent-empty-response':['模型本次未返回有效内容，具体原因未知。','The model returned no usable content. The specific reason is unknown.'],
    'canvas-agent-account-sign-in-required':['请先在 LSH 登录 DeepSeek，并确认当前连接支持账号认证。','Sign in to DeepSeek in LSH and confirm that the connection supports account authentication.'],
    'canvas-agent-awaiting-user':['已准备好操作，请先在界面完成确认，再继续对话。','The action is prepared. Complete the UI confirmation before continuing.'],
    'canvas-agent-creation-invalid':['创作操作格式不完整，未执行。请重新读取创作内容后再试。','The creative operation is invalid. Read the current creative contents before retrying.'],
    'canvas-agent-prompt-limit':['本次需求超过传输预算，请分段补充。','The request is too long. Please shorten it.'],
    'canvas-agent-image-unavailable':['有一张参考图暂时无法读取，请重新选择或移除后再试。','A reference image could not be read. Reselect or remove it, then retry.'],
    'canvas-agent-cancelled':['已停止本次操作。','This operation was stopped.'],
    'canvas-agent-interrupted':['上次 Agent 任务因软件关闭而中断，可以重新发送需求。','The previous Agent run was interrupted. You can send a new request.'],
    'canvas-agent-context-stale':['引用内容已经改变，请重新发送需求后再应用方案。','References changed. Send your request again before applying this plan.'],
    'canvas-agent-context-limit':['本次引用超过单批上下文预算，请分批读取或减少图片。','Too much context. Select fewer nodes or images.'],
    'canvas-agent-reasoning-unsupported':['当前模型不支持该思考强度，请重新选择。','This model no longer supports the selected reasoning effort. Choose another effort.'],
    'canvas-agent-images-unsupported':['当前 LSH 模型不支持识图。请切换支持识图的模型，或移除图片引用。','The current LSH model cannot read images. Switch models or remove image references.'],
    'canvas-agent-model-unavailable':['请先在 LSH 中配置可用模型，再回来发送需求。','Configure an available model in LSH before sending.'],
    'canvas-agent-plan-applied':['这份方案已经放入画布，可定位结果或继续提出修改。','This plan is already on the canvas. Locate it or request changes.'],
    'canvas-agent-plan-invalid':['方案格式不完整，尚未修改画布。请让 Agent 重新整理方案。','The plan is incomplete. Nothing was changed; ask the Agent to revise it.'],
    'canvas-agent-canvas-changed':['画布已切换，本次操作没有应用到其他画布。','The canvas changed. This action was not applied elsewhere.'],
    'canvas-agent-node-changed':['待生成节点已被修改，后续生成已停止，请检查后继续。','A pending node changed. Remaining generation was stopped.'],
    'canvas-agent-node-busy':['方案中的节点正在生成，请等待完成或停止后再应用。','A target node is generating. Wait or stop it before applying.'],
    'canvas-agent-intent-fingerprint-failed':['未能建立本次发送凭据，请求尚未发送，请重试。','The send receipt could not be prepared. Nothing was sent; please retry.'],
    'canvas-agent-start-unconfirmed':['上次请求是否收到还未确认，已阻止重复发送。请先核对状态。','The previous request is not yet confirmed. Duplicate sending was blocked; check its status first.'],
    'canvas-agent-start-recovered':['已找回上次请求；再次发送原草稿只会核对回执，不会重复执行。','The previous request was recovered. Sending the original draft will only confirm its receipt, not repeat it.'],
    'canvas-agent-previous-request-recovered':['已找回上次请求，新草稿已保留；确认后再次发送即可开始新任务。','The previous request was recovered. Your new draft is kept; send it again to start a new task.'],
    'canvas-agent-busy':['这张画布的 Agent 正在处理上一条需求。','This canvas Agent is still handling the previous request.'],
    'canvas-agent-generation-config-changed':['生成配置已改变，已停止后续生成。请检查配置后再继续。','Generation settings changed. Remaining generation was stopped.'],
    'canvas-agent-generation-unavailable':['请先在画布配置对应的图片或视频模型。方案可以先放入画布。','Configure the image or video model in Canvas first. You can still add the drafts.'],
    'canvas-agent-transport-busy':['LSH 正在处理另一项宿主操作，请稍后重试。','LSH is handling another host operation. Try again shortly.'],
    'canvas-agent-not-ready':['连接尚未就绪，请点重新连接；若仍失败，请检查 LSH 启动状态。','Connection is not ready. Reconnect, or check LSH startup if it still fails.'],
    'canvas-agent-conversation-conflict':['对话已改变，已阻止旧请求发送。请重新连接后再试。','Conversation changed. The stale request was blocked. Reconnect and retry.'],
    'canvas-agent-execution-unauthorized':['当前为仅规划模式，切换自主创作后可执行画布编辑。','This turn is planning-only. Choose autonomous mode to edit the canvas.'],
    'canvas-agent-generation-unauthorized':['本轮没有媒体生成授权，或上次结果尚未确认，未重复提交。','Media generation is not authorized for this turn, or a previous outcome is uncertain. No duplicate was submitted.'],
    'canvas-agent-media-budget':['本轮媒体任务预算已用完，可检查结果后为下一轮设置预算。','The media-job budget for this turn is exhausted. Review results before authorizing another turn.'],
    'canvas-agent-graph-edit-invalid':['画布结构编辑未通过校验，未应用本批操作。','The graph edit failed validation; this batch was not applied.'],
    'canvas-agent-action-not-authorized':['本轮未授权自主编辑，画布未被修改。','Autonomous editing is not authorized for this turn.'],
    'canvas-agent-generation-budget':['本轮生成预算不足，未追加媒体任务。','The generation budget is insufficient; no additional media jobs were submitted.'],
    'canvas-agent-policy-changed':['本轮执行授权不一致，已停止继续执行。','Execution authority changed within this run; further actions were stopped.'],
    'canvas-agent-action-conflict':['操作回执不一致，已阻止重复执行，请检查画布结果。','The action receipt conflicts; duplicate execution was blocked. Inspect the canvas.'],
    'canvas-agent-conversation-not-found':['这段对话暂时无法恢复，请刷新历史列表。','This conversation could not be restored. Refresh history.'],
    'canvas-agent-storage-unavailable':['对话记录暂时无法保存，未切换到新对话。请重试。','Conversation storage is unavailable. Retry without clearing your history.'],
  };
  return messages[code]?.[english?1:0] || (english?'Canvas Agent is unavailable. Check LSH connection/model and retry; your canvas is unchanged.':'画布 Agent 暂不可用，请检查 LSH 连接和模型后重试；不会因此清空画布。');
}
