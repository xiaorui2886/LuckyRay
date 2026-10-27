// Synthetic state driver only. Never calls Main, native services or a model.
import React, {useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CanvasAgentPanel} from '../src/features/canvas/CanvasAgentPanel';
import {CanvasAgentOrb} from '../src/features/canvas/CanvasAgentOrb';
import type {CanvasAgentSnapshot, CanvasAgentPlan} from '../src/core/canvas/agent/types';
import '../src/canvas-spike-scroll.css';
import '../src/core/theme/themeTokens.css';
const events:string[]=[];
(window as any).fixtureEvents=events;
const plan:CanvasAgentPlan={version:1,id:'fixture-plan',canvasId:'fixture',runId:'fixture',title:'合成检查方案',summary:'没有模型或真实生成',steps:[{id:'text',kind:'text',title:'合成文本',content:'仅界面检查',references:[]}]};
function App(){
  const [open,setOpen]=useState(false),[phase,setPhase]=useState('idle'),[showPlan,setShowPlan]=useState(false),[errorLamp,setErrorLamp]=useState(false);
  const [conversationId,setConversationId]=useState('fixture-conversation');
  const finishCancel=useRef<(()=>void)|null>(null),finishApply=useRef<(()=>void)|null>(null),finishNew=useRef<(()=>void)|null>(null);
  const done=()=>{finishCancel.current?.();finishCancel.current=null;finishApply.current?.();finishApply.current=null;finishNew.current?.();finishNew.current=null;setPhase('idle');setShowPlan(false);};
  const snapshot:CanvasAgentSnapshot={canvasId:'fixture',conversationId,sessionId:'fixture',runId:'fixture',status:phase==='failed'?'failed':'completed',messages:conversationId==='fixture-conversation'?[{role:'user',text:'合成检查，不发送真实请求。'},{role:'assistant',text:'保留原有未发送草稿和参考。'}]:[],...(phase==='running'?{activity:[{id:'fixture-phase',kind:'phase',label:'waiting-model',status:'running',startedAt:1}]}:{}),...(showPlan?{plan}:{}),...(phase==='failed'?{error:'合成失败提示'}:{})};
  return <main className="fixture-root canvas-editor-body">
    <nav className="fixture-toolbar"><button onClick={()=>setPhase('running')}>模拟运行</button><button onClick={()=>setPhase('generating')}>模拟生成</button><button onClick={()=>{setPhase('idle');setShowPlan(true);}}>模拟方案</button><button onClick={done}>完成</button><button onClick={()=>setPhase('failed')}>模拟失败</button><button onClick={()=>setPhase('unavailable')}>连接不可用</button><button onClick={()=>setErrorLamp(v=>!v)}>保存错误</button></nav>
    <div className={`canvas-editor-save-light is-${errorLamp?'error':'saved'}`} data-status={errorLamp?'保存失败':'已保存'} title={errorLamp?'保存失败':'已保存'} role="status" aria-live="polite" aria-label={errorLamp?'保存失败':'已保存'}><span aria-hidden="true"/></div>
    {open?<CanvasAgentPanel canvasName="黑洞加载状态合成检查" draftKey="black-hole-ui-fixture" snapshot={snapshot} onNewConversation={()=>{events.push('synthetic-new-conversation');return new Promise<void>(resolve=>{finishNew.current=()=>{setConversationId('fixture-new-conversation');resolve();};});}} contextChips={[]} execution={phase==='generating'?{planId:'fixture-plan',status:'running',steps:[]}:null} busy={phase==='running'} availability={phase==='unavailable'?'unavailable':'ready'} onSend={()=>events.push('UNEXPECTED-SEND')} onCancel={()=>{events.push('synthetic-cancel');return new Promise<void>(resolve=>{finishCancel.current=resolve;});}} onApply={()=>{events.push('synthetic-apply');return new Promise<void>(resolve=>{finishApply.current=resolve;});}} onLocate={()=>events.push('UNEXPECTED-LOCATE')} onRemoveContext={()=>events.push('UNEXPECTED-REMOVE')} onClose={()=>setOpen(false)}/>:<CanvasAgentOrb busy={phase==='running'||phase==='generating'} unavailable={phase==='unavailable'} english={false} onOpen={()=>setOpen(true)}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
