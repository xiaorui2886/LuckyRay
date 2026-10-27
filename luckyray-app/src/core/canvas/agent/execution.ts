import type {CanvasAgentExecution,CanvasAgentExecutionStep,CanvasAgentPlan} from './types';
export type AgentTaskState={id:string;status:'queued'|'running'|'succeeded'|'failed'|'cancelled';error?:{message?:string}|null};
const delay=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{if(signal.aborted){reject(Error('canvas-agent-cancelled'));return;}const abort=()=>{clearTimeout(timer);reject(Error('canvas-agent-cancelled'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});
/** Sequential bounded job submission. Never retries a paid generation or resubmits a lost task. */
export async function executeCanvasAgentPlan(plan:CanvasAgentPlan,steps:CanvasAgentExecutionStep[],ports:{
  signal:AbortSignal;assertCurrent:()=>void;submit:(nodeId:string)=>string|undefined;readTask:(nodeId:string)=>AgentTaskState|undefined;
  cancel:(nodeId:string,taskId:string)=>void;onUpdate:(execution:CanvasAgentExecution)=>void;pollMs?:number;timeoutMs?:number;
}):Promise<CanvasAgentExecution>{
  const state:CanvasAgentExecution={planId:plan.id,status:'running',steps:steps.map(s=>({...s,status:s.kind==='text'?'succeeded':s.status}))};
  const publish=()=>ports.onUpdate(structuredClone(state));publish();
  let current:{nodeId:string;taskId:string}|null=null;
  try{
    for(const step of state.steps){
      ports.assertCurrent();if(ports.signal.aborted)throw Error('canvas-agent-cancelled');
      if(step.kind==='text'){step.status='succeeded';publish();continue;}
      step.status='queued';publish();
      const taskId=ports.submit(step.nodeId);if(!taskId)throw Error('canvas-agent-generation-rejected');
      current={nodeId:step.nodeId,taskId};const started=Date.now();
      for(;;){
        ports.assertCurrent();if(ports.signal.aborted)throw Error('canvas-agent-cancelled');
        const task=ports.readTask(step.nodeId);if(!task||task.id!==taskId)throw Error('canvas-agent-generation-changed');
        step.status=task.status;publish();
        if(task.status==='succeeded')break;
        if(task.status==='failed'||task.status==='cancelled'){step.error=task.error?.message||'canvas-agent-generation-failed';throw Error(step.error);}
        if(Date.now()-started>(ports.timeoutMs||20*60*1000))throw Error('canvas-agent-generation-timeout');
        await delay(ports.pollMs??800,ports.signal);
      }
      current=null;
    }
    state.status='completed';
  }catch(error){
    const message=error instanceof Error?error.message:'canvas-agent-generation-failed';
    const cancelled=ports.signal.aborted||message==='canvas-agent-cancelled'||message==='canvas-agent-canvas-changed';
    if(current)ports.cancel(current.nodeId,current.taskId);
    state.status=cancelled?'cancelled':'failed';
    const active=state.steps.find(s=>s.status==='running'||s.status==='queued');if(active){active.status=cancelled?'cancelled':'failed';active.error=message;}
    for(const step of state.steps)if(step.status==='draft')step.status='cancelled';
    // Text-only plans can fail before the first step as well.
    if(!active&&!cancelled){const next=state.steps.find(s=>s.status!=='succeeded');if(next){next.status='failed';next.error=message;}}
  }
  publish();return state;
}
