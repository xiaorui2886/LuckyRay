/** Receipt-grounded context aid, never a replacement DSH transcript or authority. */
const clone=value=>JSON.parse(JSON.stringify(value));
const only=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
export function validTaskContext(value,canvasId,conversationId){
 return only(value,['version','canvasId','conversationId','goal','initialGoal','instructions','omittedInstructions','receipts'])&&value.version===1&&value.canvasId===canvasId&&value.conversationId===conversationId&&typeof value.goal==='string'&&value.goal.length<=48000&&typeof value.initialGoal==='string'&&value.initialGoal.length<=48000&&Array.isArray(value.instructions)&&value.instructions.length<=8&&value.instructions.every(v=>typeof v==='string'&&v.length<=48000)&&Number.isSafeInteger(value.omittedInstructions)&&value.omittedInstructions>=0&&Array.isArray(value.receipts)&&value.receipts.length<=32&&value.receipts.every(r=>only(r,['actionId','kind','status','summary','summaryTruncated','completion','nodeIds','revision'])&&typeof r.actionId==='string'&&r.actionId.length<=160&&typeof r.kind==='string'&&r.kind.length<=80&&['completed','failed','cancelled'].includes(r.status)&&typeof r.summary==='string'&&r.summary.length<=1200&&Array.isArray(r.nodeIds)&&r.nodeIds.length<=256&&r.nodeIds.every(id=>typeof id==='string'&&id.length<=160)&&(r.completion===undefined||['read','applied','awaiting-user','applied-unconfirmed'].includes(r.completion))&&typeof r.summaryTruncated==='boolean'&&(!r.revision||/^[a-f0-9]{16}$/.test(r.revision)));
}
export function beginTaskContext(previous,{canvasId,conversationId,prompt}){
 const prior=validTaskContext(previous,canvasId,conversationId)?previous:null;
 const instructions=[...(prior?.instructions??[]),prompt];
 return {version:1,canvasId,conversationId,goal:prompt,initialGoal:prior?.initialGoal??prompt,instructions:instructions.slice(-8),omittedInstructions:(prior?.omittedInstructions??0)+Math.max(0,instructions.length-8),receipts:clone(prior?.receipts??[])};
}
export function recordTaskReceipt(task,action,result){
 if(!task)return task;
 const receipt={actionId:action.actionId,kind:action.kind,status:result.status,summary:String(result.summary??'').slice(0,1200),summaryTruncated:String(result.summary??'').length>1200,...(result.creation?.completion?{completion:result.creation.completion}:{}),nodeIds:(result.nodes??[]).map(n=>n.id).slice(0,256),...(result.creation?.revision||result.context?.snapshotRevision?{revision:result.creation?.revision??result.context.snapshotRevision}:{})};
 return {...task,receipts:[...task.receipts.filter(r=>r.actionId!==receipt.actionId),receipt].slice(-32)};
}
export function taskContextForModel(task){
 if(!task)return null;
 return {...clone(task),notice:'The goal is the latest exact user request, including its constraints. initialGoal is historical; later user instructions supersede conflicts. instructions contains recent exact user requests; omittedInstructions explicitly counts older requests retained only in the official session, never reconstructed here. Receipts are prior observed execution outcomes, not permission or proof of current state. Reread referenced objects and revisions before edits. No receipt means no verified action. The official DSH session remains the conversation history; this aid never authorizes generation or additional access.'};
}
