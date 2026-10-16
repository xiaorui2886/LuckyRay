import {applyAiWriteResponse,buildAiWriteDraft,type AiWriteAction,type EditorRange} from '../core/services/editor';
import type {NoteActionValue} from '../features/notes/NoteRuntime';
export type NoteTagRenameReview={id:string;oldName:string;name:string;notes:Array<{documentId:string;title:string}>;inlineOnlyCount:number;scope:'frontmatter-only';expiresInMs:number};
export type NoteMainAction=
 | {kind:'composeAi';text:string}
 | {kind:'openTag';vaultId:string;name:string}
 | {kind:'suggestAi';title:string;content:string;currentTags:string[];knownTags:string[]}
 | {kind:'writeAi';action:AiWriteAction;content:string;selection:EditorRange}
 | {kind:'pickAttachment';selection:EditorRange}
 | {kind:'pickCatalog';selection:EditorRange;suggestedAssetId?:string}
 | {kind:'importDocument'}
 | {kind:'exportDocument';format:'markdown'|'pdf';content:string;title:string}
 | {kind:'renameTag';review:NoteTagRenameReview}
 | {kind:'manageKnowledge';vaultId:string;sourceId:string;section:'vaults'|'settings'|'folders'|'attachments'};
export type NoteMainClaim={id:string;claimToken:string;remainingMs:number;action:NoteMainAction;source?:{viewId:string;vaultId:string;sourceId:string;title:string}};
export type NoteMainCompletion=
 | Extract<NoteActionValue,{kind:'suggestion'|'replace-range'|'acknowledged'}>
 | {kind:'cancelled'}|{kind:'failed';code:string};
export const NOTE_MAIN_HANDLER_KINDS=Object.freeze(['composeAi','openTag','suggestAi','writeAi','pickAttachment','pickCatalog','importDocument','exportDocument','renameTag','manageKnowledge'] as const);
export type NoteAiProvider=(messages:Array<{role:'user';content:string}>,options:{systemPrompt:string;temperature:number;maxTokens:number})=>Promise<{success:boolean;content?:string|null;error_message?:string|null}>;
export function validateNoteMainClaim(claim:NoteMainClaim){
 if(!claim||!/^[a-f0-9]{64}$/.test(claim.id)||!/^[a-f0-9]{64}$/.test(claim.claimToken)||!Number.isFinite(claim.remainingMs)||claim.remainingMs<=0||claim.remainingMs>180000||!NOTE_MAIN_HANDLER_KINDS.includes(claim.action?.kind))throw Error('workspace-note-main-invalid-claim');
}
export function parseScopedNoteSuggestion(raw:string):Extract<NoteActionValue,{kind:'suggestion'}>{
 if(raw.length>32*1024)throw Error('AI 标签建议超过限制。');
 const cleaned=raw.trim().replace(/<think>[\s\S]*?<\/think>/gi,'').replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
 const json=cleaned.startsWith('{')?cleaned:cleaned.slice(Math.max(0,cleaned.indexOf('{')),cleaned.lastIndexOf('}')+1);
 const value=JSON.parse(json) as {summary?:unknown;tags?:unknown;auto_tags?:unknown};
 const rawTags=value?.tags??value?.auto_tags??[];
 if(!value||typeof value!=='object'||(value.summary!==undefined&&typeof value.summary!=='string')||!Array.isArray(rawTags)||rawTags.length>32)throw Error('AI 标签建议格式无效。');
 const byKey=new Map<string,string>();for(const tag of rawTags){if(typeof tag!=='string'||tag.length>120||/[\0\r\n]/.test(tag))throw Error('AI 返回无效标签。');const name=tag.trim().replace(/^#+/,'').trim().normalize('NFC');if(name&&!byKey.has(name.toLocaleLowerCase()))byKey.set(name.toLocaleLowerCase(),name);}
 const tags=[...byKey.values()].slice(0,8);
 return {kind:'suggestion',summary:typeof value.summary==='string'?value.summary.slice(0,4000):undefined,tags};
}
export async function generateScopedNoteSuggestion(action:Extract<NoteMainAction,{kind:'suggestAi'}>,provider:NoteAiProvider){
 if(action.content.length>256*1024||action.knownTags.length>256||action.currentTags.length>256)throw Error('workspace-note-ai-content-limit');
 const prompt=`文档标题: ${action.title.slice(0,256)}\n\n当前标签: ${action.currentTags.join(', ')||'无'}\n已有标签库: ${action.knownTags.slice(0,80).join(', ')||'无'}\n\n文档内容:\n${action.content.slice(0,4000)||'（空文档）'}\n\n请为这篇 Markdown 文档生成：\n1. 一段 50 字以内摘要\n2. 3-5 个文档属性标签建议。标签不要带 #，不要输出颜色值、纯数字、代码片段或文件扩展名。\n\n严格输出 JSON，不要输出其它内容：\n{"summary":"...","tags":["标签1","标签2","标签3"]}`;
 const response=await provider([{role:'user',content:prompt}],{systemPrompt:'你是知识库标签助手。只输出 JSON，不要解释。',temperature:0.3,maxTokens:500});
 if(!response.success||!response.content)throw Error(response.error_message||'AI 没有返回标签建议。');return parseScopedNoteSuggestion(response.content);
}
export async function generateScopedNoteWrite(action:Extract<NoteMainAction,{kind:'writeAi'}>,provider:NoteAiProvider):Promise<Extract<NoteActionValue,{kind:'replace-range'}>>{
 // These are the modes enabled by production Notes inline writing. Other
 // legacy union values must not silently become a different operation.
 if(!['rewrite','shorten','expand','continue'].includes(action.action))throw Error('当前笔记 AI 写作只支持改写、精简、扩写和续写。');
 if(action.content.length>256*1024||action.selection.start<0||action.selection.end<action.selection.start||action.selection.end>action.content.length)throw Error('workspace-note-ai-selection-invalid');
 if(action.action!=='continue'&&!action.content.slice(action.selection.start,action.selection.end).trim())throw Error('请先选中要处理的一段正文。');
 const built=buildAiWriteDraft(action.action,{content:action.content,selectionStart:action.selection.start,selectionEnd:action.selection.end});if(!built.ok)throw Error(built.status);
 const response=await provider([{role:'user',content:built.draft.prompt}],{systemPrompt:built.draft.systemPrompt,temperature:0.35,maxTokens:8192});
 if(!response.success||!response.content||response.content.length>256*1024)throw Error(response.error_message||'AI 没有返回可预览内容。');
 const applied=applyAiWriteResponse(built.draft,response.content);if(!applied.replacement)throw Error('AI 没有返回可预览的编辑范围。');
 return {kind:'replace-range',selection:applied.replacement.range,text:applied.replacement.text};
}
