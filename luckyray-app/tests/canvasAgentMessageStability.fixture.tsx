// Local synthetic event replay. No native bridge, model, tool execution or persistence API.
import {useLayoutEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CanvasAgentPanel} from '../src/features/canvas/CanvasAgentPanel';
import type {CanvasAgentSnapshot,CanvasAgentExecution} from '../src/core/canvas/agent/types';
import '../src/core/theme/themeTokens.css';

const epoch=1793000000000;
const history=Array.from({length:6},(_,i)=>[
 {role:'user' as const,text:`Synthetic history question ${i}`,createdAt:epoch+i*10},
 {role:'assistant' as const,text:`Synthetic historical reply ${i}.\n${'Retained historical line.\n'.repeat(4)}`,turnId:`old-${i}`,attemptId:`old-attempt-${i}`,createdAt:epoch+i*10+1},
]).flat();
const tool=(state='completed')=>({callId:'synthetic-edit',name:'canvas_edit_creation',status:state as any,startedAt:epoch+100,endedAt:state==='running'?undefined:epoch+140,summary:'Synthetic draft receipt.',eventSeq:2,turnId:'run-replay'});
const makeExecution=():CanvasAgentExecution=>({canvasId:'synthetic-canvas',planId:'synthetic-plan',status:'completed',steps:[{id:'step-a',nodeId:'synthetic-board',title:'Synthetic storyboard',kind:'text',status:'succeeded'},{id:'step-b',nodeId:'synthetic-shot',title:'Synthetic shot',kind:'image',status:'succeeded'}]} as any);
const base=(conversationId='replay'):CanvasAgentSnapshot=>({canvasId:'synthetic-canvas',conversationId,sessionId:'synthetic-session',runId:'run-replay',status:'running',messages:[...history,{role:'user',text:'Synthetic task. No model or media call.',createdAt:epoch+90}],tools:[],progress:[],activity:[{id:'prepare',kind:'phase',label:'preparing',status:'completed',startedAt:epoch+91,endedAt:epoch+95}]} as any);

type ReplayState={snapshot:CanvasAgentSnapshot;execution:CanvasAgentExecution|null;busy:boolean};
function Fixture(){
 const [state,setState]=useState<ReplayState>({snapshot:base(),execution:null,busy:true});
 useLayoutEffect(()=>{
  const api={
   set(value:ReplayState){setState(value);},
   scenario({length=900,card='late',lateTool=false,fail=false,conversationId='replay',noTools=false,withReasoning=false}:{length?:number;card?:string;lateTool?:boolean;fail?:boolean;conversationId?:string;noTools?:boolean;withReasoning?:boolean}={}){
    const initial=base(conversationId),text=('Synthetic answer paragraph. Measured layout only.\n\n'.repeat(Math.ceil(length/50))).slice(0,length);
    const reasoningText=withReasoning?'Synthetic published-reasoning fixture; not actual model reasoning.\n\n'.repeat(140):undefined;
    const snapshots=[{label:'prepare',snapshot:initial,execution:null,busy:true}];
    const completedTool=tool();
    if(!noTools) snapshots.push({label:'tool',snapshot:{...initial,tools:[tool('running')]},execution:null,busy:true} as any);
    for(const [i,n]of [Math.min(140,length),Math.min(480,length),length].entries()) snapshots.push({label:`stream-${i}`,snapshot:{...initial,tools:noTools?[]:[completedTool],stream:{attemptId:'answer-attempt',turnId:'run-replay',status:'streaming',text:text.slice(0,n),startedAt:epoch+160,reasoning:withReasoning&&i<2,reasoningText:reasoningText?.slice(0,i<2?3000:undefined)}},execution:card==='early'?makeExecution():null,busy:true} as any);
    if(lateTool) snapshots.push({label:'late-tool',snapshot:{...initial,tools:[completedTool,{...completedTool,callId:'late-read',name:'canvas_read_creation',status:'running',startedAt:epoch+220,endedAt:undefined,eventSeq:4}],stream:{attemptId:'answer-attempt',turnId:'run-replay',status:'streaming',text,startedAt:epoch+160,reasoning:false}},execution:makeExecution(),busy:true} as any);
    snapshots.push({label:'settle',snapshot:{...initial,status:fail?'failed':'completed',error:fail?'canvas-agent-creation-invalid':undefined,messages:[...initial.messages,{role:'assistant',text,reasoningText,attemptId:'answer-attempt',messageId:'final-message',turnId:'run-replay',createdAt:epoch+160,eventSeq:3}],tools:noTools?[]:lateTool?[completedTool,{...completedTool,callId:'late-read',name:'canvas_read_creation',startedAt:epoch+220,endedAt:epoch+250,eventSeq:4}]:[completedTool],stream:{attemptId:'answer-attempt',turnId:'run-replay',status:'settled',text:'',reasoning:false}},execution:card==='none'?null:makeExecution(),busy:false} as any);
    return snapshots;
   }
  };
  (window as any).agentReplay=api;
 },[]);
 return <main className="replay-stage"><div className="replay-title">Synthetic Agent presentation replay — no model, tool, or native storage</div><CanvasAgentPanel canvasName="Synthetic replay" snapshot={state.snapshot} execution={state.execution} busy={state.busy} contextChips={[]} draftKey="presentation-replay-only" availability="ready" onSend={()=>false} onCancel={()=>{}} onApply={()=>false} onLocate={()=>{}} onRemoveContext={()=>{}} onClose={()=>{}} /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
