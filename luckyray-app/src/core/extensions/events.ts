import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { runPlugin, type PluginScope, type PluginUi } from "./runtime";
import { extensionPackages } from "./packages";

type Claim = { id:string; scope:PluginScope; event:object };
type Dependencies = {
  listen: (handler:(event:{payload:string})=>void)=>Promise<UnlistenFn>;
  claim: (token:string)=>Promise<Claim>;
  discard?: (token:string)=>Promise<unknown>;
  run: typeof runPlugin;
  packages: Pick<typeof extensionPackages,"subscribe"|"snapshot">;
};
const defaults:Dependencies = {
  listen: handler => listen<string>("luckyray-plugin-event",handler),
  claim: token => invoke<Claim>("extension_runtime", {request:JSON.stringify({op:"claimEvent",token})}),
  discard: token => invoke("extension_runtime", {request:JSON.stringify({op:"discardEvent",token})}),
  run: runPlugin,
  packages: extensionPackages,
};
export type PluginEventStatus = { state:"running"|"done"|"failed"; ui?:PluginUi; error?:string };
const statuses = new Map<string,PluginEventStatus>();
export function pluginEventStatus(id:string) { return statuses.get(id) ?? null; }
function publish(id:string, status:PluginEventStatus) {
  statuses.set(id,status);
  window.dispatchEvent(new CustomEvent("luckyray:plugin-event-status", {detail:{id,status}}));
}

/** One main-renderer consumer, claimed once; failures never affect the committed host action. */
export async function startPluginEventPump(deps:Dependencies=defaults):Promise<UnlistenFn> {
  let active = true;
  let queued = 0;
  let queue = Promise.resolve();
  const controllers = new Map<AbortController,string>();
  const stillEnabled = (id:string) => {
    const state = deps.packages.snapshot();
    return !state.ready || state.packages.some(entry => entry.enabled && entry.package.manifest.id === id);
  };
  const unsubscribePackages = deps.packages.subscribe(() => {
    for (const [controller,id] of controllers) if (!stillEnabled(id)) controller.abort();
    for (const id of statuses.keys()) if (!stillEnabled(id)) {
      statuses.delete(id);
      window.dispatchEvent(new CustomEvent("luckyray:plugin-event-status", {detail:{id,status:null}}));
    }
  });
  const onStatusRequest = (event:Event) => {
    const id=(event as CustomEvent<{id:string}>).detail?.id;
    if (typeof id === "string") window.dispatchEvent(new CustomEvent("luckyray:plugin-event-status",{detail:{id,status:statuses.get(id) ?? null}}));
  };
  window.addEventListener("luckyray:plugin-event-status-request",onStatusRequest);
  const unlisten = await deps.listen(event => {
    if (typeof event.payload !== "string") return;
    if (!active || queued >= 128) { void (deps.discard ? deps.discard(event.payload) : deps.claim(event.payload)).catch(()=>{}); return; }
    queued++;
    queue = queue.then(async () => {
      if (!active) { await (deps.discard ? deps.discard(event.payload) : deps.claim(event.payload)).catch(()=>{}); return; }
      let claim:Claim;
      try { claim = await deps.claim(event.payload); }
      catch { return; } // Disabled, unsubscribed or an already-claimed duplicate.
      if (!active) return;
      const controller = new AbortController(); controllers.set(controller,claim.id);
      publish(claim.id,{state:"running"});
      try {
        const result = await deps.run(claim.id,claim.scope,claim.event,controller.signal,() => {});
        if (active && stillEnabled(claim.id)) publish(claim.id,{state:"done",ui:result.ui});
      } catch (error) {
        if (active && stillEnabled(claim.id)) publish(claim.id,{state:"failed",error:error instanceof Error ? error.message : String(error)});
      } finally { controllers.delete(controller); }
    }).catch(() => {}).finally(() => { queued--; });
  }).catch(error => { unsubscribePackages(); window.removeEventListener("luckyray:plugin-event-status-request",onStatusRequest); throw error; });
  return () => { active=false; unlisten(); unsubscribePackages(); window.removeEventListener("luckyray:plugin-event-status-request",onStatusRequest); for (const controller of controllers.keys()) controller.abort(); controllers.clear(); statuses.clear(); };
}
