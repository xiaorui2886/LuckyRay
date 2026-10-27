import type {CreationReadQuery,CreationEditRequest,CreationOpenRequest,CreationReadResult} from './creationTypes';
/** Canvas Agent's bounded host/UI contract. No credentials or arbitrary file paths. */
export type CanvasAgentMediaOptions = {aspects:string[];resolutions:string[];qualities:string[];durations:number[]};
export type CanvasAgentMediaSettings = {aspect?:string;resolution?:string;quality?:string;duration?:number};
export type CanvasAgentMode = 'image' | 'video' | 'script';
export type CanvasAgentImage = { mimeType: 'image/jpeg' | 'image/png'; data: string };
export type CanvasAgentContextNode = {
  id: string; title: string; kind: 'text' | 'image' | 'video' | 'note' | 'group'; text: string;
  editable: boolean; textTruncated?:boolean;textRange?:{start:number;end:number;total:number}; revision: string;layout?:{x:number;y:number;parentId?:string}; image?: CanvasAgentImage; imageUnavailable?: boolean;
};
export type CanvasAgentContext = {
  version: 1; canvasId: string; canvasName: string; snapshotRevision?:string; coverage?:{mode:'overview'|'target'|'full';totalNodes:number;returnedNodes:number;offset:number;textComplete:boolean}; nodes: CanvasAgentContextNode[];
  connections: {source: string; target: string}[];
  generation: {imageModels: string[]; videoModels: string[]; imageReady: boolean; videoReady: boolean; imageOptions?:CanvasAgentMediaOptions;videoOptions?:CanvasAgentMediaOptions};
};
export type CanvasAgentPlanStep = {
  id: string; kind: 'text' | 'image' | 'video'; title: string; content: string;
  /** Context node IDs or IDs of earlier steps in this plan. */
  references: string[]; targetNodeId?: string; settings?:CanvasAgentMediaSettings;
};
export type CanvasAgentPlan = {
  version: 1; id: string; canvasId: string; runId: string; title: string; summary: string; steps: CanvasAgentPlanStep[];
};
export type CanvasAgentReasoningTiming = {reasoningStartedAt?:number;reasoningEndedAt?:number;reasoningDurationMs?:number};
export type CanvasAgentMessage = CanvasAgentReasoningTiming & { role: 'user' | 'assistant'; text: string;reasoningText?:string;turnId?:string;messageId?:string;attemptId?:string;createdAt?:number;eventSeq?:number };
export type CanvasAgentStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
export type CanvasAgentReasoning = {efforts:{id:string;name:string;description?:string}[];defaultEffort?:string};
export type CanvasAgentModelSelection = {provider:string;model:string;reasoningEffort?:string};
export type CanvasAgentModels = {
  available: (CanvasAgentModelSelection & {label:string;inputModalities:string[];reasoning?:CanvasAgentReasoning})[];
  defaultModel: (CanvasAgentModelSelection & {reasoningEffort?:string})|null;
  currentModel: (CanvasAgentModelSelection & {reasoningEffort?:string})|null;
};
export type CanvasAgentActivity = {
  id:string; kind:'phase'|'tool'; label:'preparing'|'resolving-model'|'opening-session'|'waiting-model'|'reading-context'|'proposing-plan'|'finalizing'|'stopping';
  status:'running'|'completed'|'failed'; startedAt:number; endedAt?:number;
};
export type CanvasAgentSnapshot = {
  conversationId: string; activity?: CanvasAgentActivity[];
  updatedAt?:number;execution?:CanvasAgentExecutionPolicy & {reservedMediaJobs:number};
  conversations?:CanvasAgentConversation[]; pendingAction?:CanvasAgentPendingAction;
  stream?:CanvasAgentReasoningTiming & {reasoningActiveStartedAt?:number;turnId?:string;startedAt?:number;attemptId:string;text:string;status:'streaming'|'settled'|'interrupted';reasoning:boolean;reasoningText?:string};
  progress?:{id:string;summary:string;createdAt:number}[];
  tools?:{displayTitle?:string;displayTitleEn?:string;eventSeq?:number;turnId?:string;callId:string;name:string;status:'running'|'completed'|'failed';startedAt:number;endedAt?:number;summary?:string}[];
  canvasId: string; sessionId: string | null; runId: string | null; requestId?: string; status: CanvasAgentStatus;
  messages: CanvasAgentMessage[]; context?: CanvasAgentContext; plan?: CanvasAgentPlan; error?: string; errorDetail?: {message:string}; model?: string; models?:CanvasAgentModels;
};
export type CanvasAgentRequest =
  | {op: 'status'|'models'|'history'; canvasId: string}
  | {op: 'newConversation'; canvasId:string; requestId:string; expectedConversationId:string}
  | {op: 'start'; conversationId:string; canvasId: string; requestId: string; prompt: string; context: CanvasAgentContext; modelSelection?:CanvasAgentModelSelection;execution?:CanvasAgentExecutionPolicy}
  | {op:'resumeConversation';canvasId:string;requestId:string;expectedConversationId:string;conversationId:string}
  | {op:'actionResult';canvasId:string;runId:string;actionId:string;result:CanvasAgentActionResult}
  | {op: 'cancel'; canvasId: string; runId: string};
export type CanvasAgentExecutionStep = {id: string; nodeId: string; title: string; kind:'text'|'image'|'video'; status:'draft'|'queued'|'running'|'succeeded'|'failed'|'cancelled'; error?:string};
/** Renderer-only navigation ownership. Never supplied by model output or sent to the host. */
export type CanvasAgentExecutionOwner = {canvasId:string;loadEpoch:number};
export type CanvasAgentExecution = {planId: string; owner?:CanvasAgentExecutionOwner; status:'draft'|'running'|'completed'|'failed'|'cancelled'; steps:CanvasAgentExecutionStep[]};

/** Per-turn authority, separate from provider/model configuration. Media job budget counts submissions, not successes. */
export type CanvasAgentExecutionPolicy = {mode:'plan'|'autonomous';allowGeneration:boolean;maxMediaJobs:number};
export type CanvasAgentConversation = {conversationId:string;sessionId:string|null;title:string;updatedAt:number;messageCount:number};
export type CanvasAgentPendingAction = {actionId:string;runId:string;kind:'readContext'|'applyPlan'|'editGraph'|'readCreation'|'editCreation'|'openCreation';creationQuery?:CreationReadQuery;creationEdit?:CreationEditRequest;creationOpen?:CreationOpenRequest;operations?:CanvasAgentGraphOperation[];execution?:CanvasAgentExecutionPolicy;readMode?:'overview'|'target'|'full';textOffset?:number;offset?:number;expectedRevision?:string;nodeIds?:string[];plan?:CanvasAgentPlan;context?:CanvasAgentContext;generate?:boolean};
export type CanvasAgentActionResult = {operationReceipts?:{index:number;summary:string}[];status:'completed'|'failed'|'cancelled';summary:string;context?:CanvasAgentContext;creation?:CreationReadResult;generatedJobs:number;nodes?:{id:string;status:'completed'|'failed'|'cancelled';summary?:string}[]};
export type CanvasAgentActionExecutor = (action:CanvasAgentPendingAction,signal:AbortSignal)=>Promise<CanvasAgentActionResult>;
export const CANVAS_AGENT_LIMITS = {requestBytes:2*1024*1024,nodes:256,connections:2048,steps:64,promptChars:48000,nodeTextChars:24000,contextTextBytes:256*1024,images:8,imageBytes:128*1024,totalImageBytes:1024*1024} as const;

export type CanvasAgentGraphOperation = {op:'move';nodeId:string;x:number;y:number}|{op:'connect'|'disconnect';source:string;target:string}|{op:'arrange';nodeIds:string[];layout:'grid'|'horizontal'|'vertical'};

