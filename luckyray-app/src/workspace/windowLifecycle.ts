import {listen} from '@tauri-apps/api/event';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {workspaceCommand} from './nativeClient';

// Window lifetime, not a route effect: hidden/retained editors must participate.
const flushers=new Set<{flush:()=>Promise<boolean>;hasPendingSave?:()=>boolean}>();
let installed:Promise<void>|undefined;
let composing=false;
export const workspaceCompositionActive=()=>composing;
export function registerWorkspaceFlush(flush:()=>Promise<boolean>,hasPendingSave?:()=>boolean){
  const registration={flush,hasPendingSave};
  flushers.add(registration);return ()=>{flushers.delete(registration);};
}
export function installWorkspaceLifecycle():Promise<void>{
  return installed??=(async()=>{
    type Round={id:string;phase:'saving'|'acknowledging'|'draining';previousInert:boolean;saved:boolean};
    let pending:Round|null=null;
    let status:HTMLDivElement|null=null;let timer:number|undefined;
    // A native cancellation cannot cancel an IO operation already in progress.
    // Wait for that operation before a retry, then run a fresh barrier: never
    // reuse a cancelled round's boolean as proof for newly edited content.
    let flushing:Promise<void>=Promise.resolve();
    const root=document.getElementById('root');
    document.addEventListener('compositionstart',()=>{composing=true;},true);
    document.addEventListener('compositionend',()=>{composing=false;},true);
    const local={target:{kind:'WebviewWindow' as const,label:getCurrentWindow().label}};
    // Keep Main's draft/IME quit barrier. Independent window creation, merge
    // admission and automatic restoration are no longer product startup work.
    const clearStatus=()=>{
      if(timer!==undefined)window.clearTimeout(timer);timer=undefined;
      status?.remove();status=null;
    };
    const release=(round:Round)=>{
      if(pending!==round)return;
      clearStatus();if(root)root.inert=round.previousInert;pending=null;
    };
    const cancelled=()=>window.dispatchEvent(new CustomEvent('luckyray:workspace-save-error',{
      detail:'退出已取消：请处理未保存内容或版本冲突后重试。',
    }));
    const deferStatus=(round:Round,phase:'saving'|'draining')=>{
      clearStatus();
      timer=window.setTimeout(()=>{
        timer=undefined;
        if(pending!==round||round.phase!==phase)return;
        if(phase==='saving'&&!Array.from(flushers).some(({hasPendingSave})=>hasPendingSave?.()))return;
        status=document.createElement('div');status.setAttribute('role','status');
        status.setAttribute('aria-live','polite');status.setAttribute('data-workspace-quit-status',phase);
        status.textContent=phase==='saving'?'正在保存笔记…':'正在退出…';
        // A small themed status, not an opaque full-screen saving overlay.
        Object.assign(status.style,{position:'fixed',right:'24px',bottom:'24px',zIndex:'2147483647',
          maxWidth:'calc(100vw - 48px)',padding:'12px 18px',borderRadius:'12px',pointerEvents:'none',
          fontSize:'13px',background:'var(--theme-surface-panel)',color:'var(--text-primary)',
          border:'1px solid var(--theme-border-strong)',boxShadow:'0 8px 24px #0003'});
        document.body.append(status);
      },300);
    };
    await listen<{id:string}>('luckyray:workspace-quit-cancelled',event=>{
      if(pending?.id!==event.payload.id)return;release(pending);cancelled();
    },local);
    await listen<{id:string}>('luckyray:workspace-quit-draining',event=>{
      const round=pending;
      if(!round||round.id!==event.payload.id||!round.saved||round.phase!=='acknowledging')return;
      round.phase='draining';deferStatus(round,'draining');
    },local);
    await listen<{id:string}>('luckyray:workspace-quit-prepare',async event=>{
      const id=event.payload.id;
      if(pending)return;
      const round:Round={id,phase:'saving',previousInert:root?.inert??false,saved:false};pending=round;
      // Do not end an IME composition programmatically and risk losing its buffer.
      if(!composing){if(root)root.inert=true;deferStatus(round,'saving');}
      let saved=false;
      if(!composing){
        await flushing;
        if(pending!==round)return;
        if(!composing){
          const work=Array.from(flushers,({flush})=>Promise.resolve().then(flush));
          flushing=Promise.allSettled(work).then(()=>{});
          try{saved=(await Promise.all(work.map(async result=>{
            if(!await result)throw new Error('workspace-quit-save-incomplete');
            return true;
          }))).every(Boolean);}catch{/* Native cancels the whole quit; remaining IO stays serialized. */}
        }
      }
      if(pending!==round)return;
      clearStatus();round.saved=saved;round.phase='acknowledging';
      if(!saved){release(round);cancelled();}
      try{await workspaceCommand({op:'quitAck',id,saved});}catch{
        if(pending===round){release(round);cancelled();}
      }
    },local);
  })();
}
