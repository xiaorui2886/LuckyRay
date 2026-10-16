export type WorkspaceInvalidationKind='note'|'graph';
/** Bodyless change hints are coalesced while a renderer owns an in-flight
 * action, handoff, recovery or IME buffer. Draining never supplies new scope. */
export function createWorkspaceInvalidations(services:{blocked:()=>boolean;notes:()=>void|Promise<void>;graph:()=>void|Promise<void>;failed:(error:unknown)=>void;
 schedule?:(run:()=>void)=>unknown;cancel?:(handle:unknown)=>void}){
 let note=false,graph=false,active=true,running:Promise<void>|undefined,timer:unknown;
 const schedule=services.schedule??(run=>setTimeout(run,0));
 const cancel=services.cancel??(handle=>clearTimeout(handle as ReturnType<typeof setTimeout>));
 const kick=()=>{if(!active||running||timer!==undefined||(!note&&!graph)||services.blocked())return;timer=schedule(()=>{timer=undefined;void drain();});};
 const drain=():Promise<void>=>{
  if(running)return running;
  if(!active||services.blocked()||(!note&&!graph))return Promise.resolve();
  running=(async()=>{
   if(note){note=false;try{await services.notes();}catch(error){services.failed(error);}}
   if(!active||services.blocked())return;
   if(graph){graph=false;try{await services.graph();}catch(error){services.failed(error);}}
  })().finally(()=>{running=undefined;kick();});
  return running;
 };
 return {mark:(kind:WorkspaceInvalidationKind)=>{if(!active)return;if(kind==='note')note=true;else graph=true;kick();},kick,
  settled:()=>running??Promise.resolve(),dispose:()=>{active=false;note=false;graph=false;if(timer!==undefined)cancel(timer);timer=undefined;}};
}
