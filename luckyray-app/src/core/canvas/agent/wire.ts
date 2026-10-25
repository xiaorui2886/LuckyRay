import {validateCreationRead,validateCreationEdit,validateCreationOpen} from './creationContract';
import type {CanvasAgentContext,CanvasAgentSnapshot} from './types';
import {validateCanvasAgentPlan} from './plan';
const invalid=():never=>{throw Error('canvas-agent-response-invalid');};
const record=(x:unknown):Record<string,any>=>x&&typeof x==='object'&&!Array.isArray(x)?x:invalid();
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(x);
const text=(x:unknown,n:number):x is string=>typeof x==='string'&&x.length<=n;
const time=(x:unknown):x is number=>Number.isSafeInteger(x)&&Number(x)>=0;
const keys=(x:Record<string,any>,allowed:string[])=>Object.keys(x).every(k=>allowed.includes(k));
export const REASONING_TIMING_FIELDS=['reasoningStartedAt','reasoningEndedAt','reasoningDurationMs'] as const;
export function validReasoningTiming(x:Record<string,any>,active=false):boolean {
 const fields:readonly string[]=active?[...REASONING_TIMING_FIELDS,'reasoningActiveStartedAt']:REASONING_TIMING_FIELDS;
 return fields.every(k=>x[k]===undefined||time(x[k])) && (!fields.slice(1).some(k=>x[k]!==undefined)||x.reasoningStartedAt!==undefined)
  && (x.reasoningEndedAt===undefined||x.reasoningEndedAt>=x.reasoningStartedAt)
  && (x.reasoningActiveStartedAt===undefined||x.reasoningActiveStartedAt>=x.reasoningStartedAt);
}
export function projectReasoningTiming(x:Record<string,any>) {return Object.fromEntries(REASONING_TIMING_FIELDS.filter(k=>x[k]!==undefined).map(k=>[k,x[k]]));}

/** Display-only error payload. Never accept arbitrary exception objects or blank messages. */
export function projectCanvasAgentErrorDetail(value:unknown):{message:string} {
 const detail=record(value);
 if(!keys(detail,['message'])||!text(detail.message,2000)||!detail.message.trim()||new TextEncoder().encode(detail.message).length>2000||/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/.test(detail.message))invalid();
 return {message:detail.message};
}

/** Project only typed, public runtime data. No raw provider objects/arguments/credentials cross this boundary. */
export function projectCanvasAgentR5(value:Record<string,unknown>,canvasId:string,context:((value:unknown)=>CanvasAgentContext)):Partial<CanvasAgentSnapshot>{
 const out:Partial<CanvasAgentSnapshot>={};
 if(value.updatedAt!==undefined){if(!time(value.updatedAt))invalid();out.updatedAt=value.updatedAt as number;}
 if(value.execution!==undefined){const e=record(value.execution);if(!keys(e,['mode','allowGeneration','maxMediaJobs','reservedMediaJobs'])||!['plan','autonomous'].includes(e.mode)||typeof e.allowGeneration!=='boolean'||!time(e.maxMediaJobs)||e.maxMediaJobs>1000||!time(e.reservedMediaJobs)||e.reservedMediaJobs>e.maxMediaJobs)invalid();out.execution={mode:e.mode,allowGeneration:e.allowGeneration,maxMediaJobs:e.maxMediaJobs,reservedMediaJobs:e.reservedMediaJobs};}
 if(value.stream!==undefined){const s=record(value.stream);if(!keys(s,['attemptId','text','status','reasoning','reasoningText','turnId','startedAt',...REASONING_TIMING_FIELDS,'reasoningActiveStartedAt'])||!validReasoningTiming(s,true)||(s.turnId!==undefined&&(!id(s.turnId)||s.turnId!==value.runId))||(s.startedAt!==undefined&&!time(s.startedAt))||!id(s.attemptId)||!text(s.text,256000)||!['streaming','settled','interrupted'].includes(s.status)||typeof s.reasoning!=='boolean'||(s.reasoningText!==undefined&&!text(s.reasoningText,256000)))invalid();out.stream={...projectReasoningTiming(s),...(s.reasoningActiveStartedAt!==undefined?{reasoningActiveStartedAt:s.reasoningActiveStartedAt}:{}),...(s.turnId!==undefined?{turnId:s.turnId}:{}),...(s.startedAt!==undefined?{startedAt:s.startedAt}:{}),attemptId:s.attemptId,text:s.text,status:s.status,reasoning:s.reasoning,...(s.reasoningText!==undefined?{reasoningText:s.reasoningText}:{})};}
 if(value.progress!==undefined){if(!Array.isArray(value.progress)||value.progress.length>64)invalid();out.progress=(value.progress as unknown[]).map(v=>{const p=record(v);if(!keys(p,['id','summary','createdAt'])||!id(p.id)||!text(p.summary,4000)||!time(p.createdAt))invalid();return {id:p.id,summary:p.summary,createdAt:p.createdAt};});}
 if(value.tools!==undefined){if(!Array.isArray(value.tools)||value.tools.length>128)invalid();out.tools=(value.tools as unknown[]).map(v=>{const p=record(v);if(!keys(p,['callId','name','status','startedAt','endedAt','summary','turnId','eventSeq','displayTitle','displayTitleEn'])||['displayTitle','displayTitleEn'].some(k=>p[k]!==undefined&&!text(p[k],240))||(p.eventSeq!==undefined&&!time(p.eventSeq))||(p.turnId!==undefined&&!id(p.turnId))||!id(p.callId)||!text(p.name,160)||!/^canvas_[a-z_]+$/.test(p.name)||!['running','completed','failed'].includes(p.status)||!time(p.startedAt)||(p.endedAt!==undefined&&(!time(p.endedAt)||p.endedAt<p.startedAt))||(p.summary!==undefined&&!text(p.summary,4000)))invalid();return {...(p.displayTitle!==undefined?{displayTitle:p.displayTitle}:{}),...(p.displayTitleEn!==undefined?{displayTitleEn:p.displayTitleEn}:{}),...(p.eventSeq!==undefined?{eventSeq:p.eventSeq}:{}),...(p.turnId!==undefined?{turnId:p.turnId}:{}),callId:p.callId,name:p.name,status:p.status,startedAt:p.startedAt,...(p.endedAt!==undefined?{endedAt:p.endedAt}:{}),...(p.summary!==undefined?{summary:p.summary}:{})};});}
 if(value.conversations!==undefined){if(!Array.isArray(value.conversations)||value.conversations.length>256)invalid();out.conversations=(value.conversations as unknown[]).map(v=>{const p=record(v);if(!keys(p,['conversationId','sessionId','title','updatedAt','messageCount'])||!id(p.conversationId)||!(p.sessionId===null||id(p.sessionId))||!text(p.title,240)||!time(p.updatedAt)||!time(p.messageCount))invalid();return {conversationId:p.conversationId,sessionId:p.sessionId,title:p.title,updatedAt:p.updatedAt,messageCount:p.messageCount};});if(new Set(out.conversations.map(c=>c.conversationId)).size!==out.conversations.length)invalid();}
 if(value.pendingAction!==undefined){const p=record(value.pendingAction);if(!keys(p,['actionId','runId','kind','nodeIds','plan','context','generate','execution','offset','operations','expectedRevision','creationQuery','creationEdit','creationOpen'])||!id(p.actionId)||!id(p.runId)||p.runId!==value.runId||value.status!=='running'||!['readContext','applyPlan','editGraph','readCreation','editCreation','openCreation'].includes(p.kind)||(p.generate!==undefined&&typeof p.generate!=='boolean')||(p.nodeIds!==undefined&&(!Array.isArray(p.nodeIds)||p.nodeIds.length>256||p.nodeIds.some((v:unknown)=>!id(v)))))invalid();
  if(p.expectedRevision!==undefined&&(typeof p.expectedRevision!=='string'||!/^[a-f0-9]{16}$/.test(p.expectedRevision)))invalid();
  if(p.offset!==undefined&&(!Number.isSafeInteger(p.offset)||p.offset<0||p.offset>1000000))invalid();
  if(p.execution!==undefined){const e=record(p.execution);if(!keys(e,['mode','allowGeneration','maxMediaJobs'])||!['plan','autonomous'].includes(e.mode)||typeof e.allowGeneration!=='boolean'||!Number.isSafeInteger(e.maxMediaJobs)||e.maxMediaJobs<0||e.maxMediaJobs>1000)invalid();}
  const ctx=p.context!==undefined?context(p.context):undefined;if(ctx&&ctx.canvasId!==canvasId)invalid();
  const plan=p.plan!==undefined?(ctx?validateCanvasAgentPlan(p.plan,ctx,p.runId):invalid()):undefined;
  if(p.kind==='applyPlan'&&(!plan||!ctx||!p.execution))invalid();
  if(p.kind==='editGraph'){
   if(!ctx||!p.execution||p.execution.mode!=='autonomous'||plan||p.generate||!Array.isArray(p.operations)||!p.operations.length||p.operations.length>64)invalid();
   const ids=new Set(ctx!.nodes.map(n=>n.id));
   for(const raw of p.operations){const o=record(raw);
    if(o.op==='move'){if(!keys(o,['op','nodeId','x','y'])||!ids.has(o.nodeId)||![o.x,o.y].every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e6))invalid();}
    else if(o.op==='connect'||o.op==='disconnect'){if(!keys(o,['op','source','target'])||!ids.has(o.source)||!ids.has(o.target)||o.source===o.target)invalid();}
    else if(o.op==='arrange'){if(!keys(o,['op','nodeIds','layout'])||!['grid','horizontal','vertical'].includes(o.layout)||!Array.isArray(o.nodeIds)||!o.nodeIds.length||o.nodeIds.length>256||o.nodeIds.some((n:string)=>!ids.has(n)))invalid();}
    else invalid();
   }
  }else if(p.operations!==undefined)invalid();if(p.kind==='readContext'&&(plan||p.generate))invalid();
  const creationQuery=p.creationQuery!==undefined?validateCreationRead(p.creationQuery):undefined;
  const creationEdit=p.creationEdit!==undefined?validateCreationEdit(p.creationEdit):undefined;
  const creationOpen=p.creationOpen!==undefined?validateCreationOpen(p.creationOpen):undefined;
  const isCreation=['readCreation','editCreation','openCreation'].includes(p.kind);
  if(isCreation){
   if(plan||p.generate!==undefined||p.operations!==undefined||p.offset!==undefined||p.nodeIds!==undefined||p.expectedRevision!==undefined||!ctx)invalid();
   if(p.kind==='readCreation'&&(!creationQuery||creationEdit||creationOpen))invalid();
   if(p.kind==='editCreation'&&(!creationEdit||creationQuery||creationOpen||p.execution?.mode!=='autonomous'))invalid();
   if(p.kind==='openCreation'&&(!creationOpen||creationQuery||creationEdit||p.execution?.mode!=='autonomous'))invalid();
  }else if(creationQuery||creationEdit||creationOpen)invalid();
  out.pendingAction={...(creationQuery?{creationQuery}:{}),...(creationEdit?{creationEdit}:{}),...(creationOpen?{creationOpen}:{}),...(p.expectedRevision!==undefined?{expectedRevision:p.expectedRevision}:{}),actionId:p.actionId,runId:p.runId,kind:p.kind,...(p.operations?{operations:structuredClone(p.operations)}:{}),...(p.offset!==undefined?{offset:p.offset}:{}),...(p.execution?{execution:{...p.execution}}:{}),...(p.nodeIds?{nodeIds:[...p.nodeIds]}:{}),...(ctx?{context:ctx}:{}),...(plan?{plan}:{}),...(p.generate!==undefined?{generate:p.generate}:{})};
 }
 return out;
}
