/** Run-local reservation and idempotency boundary. Never refund uncertain paid work. */
export type ActionPolicy = {mode:'plan'|'autonomous';allowGeneration:boolean;maxMediaJobs:number};
export function createCanvasActionLedger<T>() {
  const actions = new Map<string, {fingerprint:string; promise:Promise<T>}>();
  const reservations = new Map<string, number>();
  const policies = new Map<string, string>();
  return {
    run(action: {actionId:string;runId:string;kind:string;generate?:boolean;plan?:{steps:{kind:string}[]};execution?:ActionPolicy}, execute:()=>Promise<T>):Promise<T> {
      const key = `${action.runId}:${action.actionId}`;
      const fingerprint = JSON.stringify(action);
      const prior = actions.get(key);
      if (prior) return prior.fingerprint === fingerprint ? prior.promise : Promise.reject(Error('canvas-agent-action-conflict'));
      const policy = action.execution;
      if ((['applyPlan','editGraph','editCreation','openCreation'].includes(action.kind)) && policy?.mode !== 'autonomous') return Promise.reject(Error('canvas-agent-action-not-authorized'));
      if ((['applyPlan','editGraph','editCreation','openCreation'].includes(action.kind))) {
        const identity=JSON.stringify(policy);
        if (policies.has(action.runId) && policies.get(action.runId)!==identity) return Promise.reject(Error('canvas-agent-policy-changed'));
        policies.set(action.runId,identity);
      }
      if (action.generate && action.kind !== 'applyPlan') return Promise.reject(Error('canvas-agent-action-not-authorized'));
      const requested = action.generate ? action.plan?.steps.filter(step=>step.kind !== 'text').length || 0 : 0;
      const reserved = reservations.get(action.runId) || 0;
      if (requested && (!policy?.allowGeneration || !Number.isSafeInteger(policy.maxMediaJobs) || policy.maxMediaJobs < requested + reserved)) return Promise.reject(Error('canvas-agent-generation-budget'));
      // Reserve before invoking the adapter. Failures can have ambiguous provider outcomes.
      reservations.set(action.runId, reserved + requested);
      const promise = Promise.resolve().then(execute);
      actions.set(key, {fingerprint,promise});
      return promise;
    },
    reserved(runId:string) { return reservations.get(runId) || 0; },
  };
}
