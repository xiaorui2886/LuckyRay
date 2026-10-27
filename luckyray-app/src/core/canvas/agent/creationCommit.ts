import type { CanvasAgentActionResult, CanvasAgentContext } from './types';
import type { CreationReadResult } from './creationTypes';
/** Called only after the in-memory mutation. Any later failure is ambiguous,
 * never an invitation to repeat a create/import with a fresh action ID. */
export async function completeCreationMutation(ports:{
  applied:CreationReadResult; summary:string; affectedIds:string[];operationReceipts?:{index:number;summary:string}[];
  assertCurrent:()=>void; persist:()=>Promise<void>;
  readAfter:()=>Promise<{creation:CreationReadResult;context:CanvasAgentContext}>;
}):Promise<CanvasAgentActionResult>{
  try {
    ports.assertCurrent();await ports.persist();ports.assertCurrent();
    const {creation,context}=await ports.readAfter();ports.assertCurrent();
    if(creation.revision!==ports.applied.revision)throw Error('canvas-agent-context-stale');
    const notice=ports.summary+(ports.affectedIds.length>256?' Only the first 256 affected objects are included in this receipt; reread remaining objects by ID.':'');
    return {status:'completed',summary:notice,...(ports.operationReceipts?{operationReceipts:ports.operationReceipts}:{}),creation:{...creation,completion:'applied',notice},context,generatedJobs:0,nodes:ports.affectedIds.slice(0,256).map(id=>({id,status:'completed'}))};
  }catch{
    const notice='The creation edit was applied in memory, but persistence or the final state refresh could not be confirmed. Do not repeat this operation. Stop and ask the user to inspect the canvas and save status before continuing.';
    return {status:'failed',summary:notice,creation:{...ports.applied,completion:'applied-unconfirmed',notice},generatedJobs:0};
  }
}

