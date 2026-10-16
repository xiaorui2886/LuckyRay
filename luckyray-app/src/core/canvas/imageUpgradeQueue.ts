/** Bound original-image decodes. No persistent cache of image bytes or credentials. */
export function createImageUpgradeQueue(limit=2){
 type Job={start:(done:()=>void)=>()=>void;priority:boolean;cancelled:boolean;stop?:()=>void;finish?:()=>void};
 const waiting:Job[]=[];let active=0;
 function pump(){while(active<limit&&waiting.length){const job=waiting.shift()!;if(job.cancelled)continue;active++;let ended=false;
  const done=()=>{if(ended)return;ended=true;active--;pump();};job.finish=done;try{job.stop=job.start(done);}catch{done();}
 }}
 return {enqueue(start:Job['start'],priority=false){const job:Job={start,priority,cancelled:false};if(priority)waiting.unshift(job);else waiting.push(job);pump();
  return ()=>{if(job.cancelled)return;job.cancelled=true;const index=waiting.indexOf(job);if(index>=0)waiting.splice(index,1);job.stop?.();job.finish?.();};
 },pending:()=>({active,waiting:waiting.length})};
}
