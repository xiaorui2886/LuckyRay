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
    type Round={id:string;phase:'saving'|'acknowledging'|'draining'|'blocked';previousInert:boolean;saved:boolean};
    // Native events may change this phase while an ACK Promise is pending.
    const blocked=(round:Round)=>round.phase==='blocked';
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
    const cancelled=(reason?:unknown)=>window.dispatchEvent(new CustomEvent('luckyray:workspace-save-error',{
      detail:reason==='update-generation-active'||reason==='update-task-state-unavailable'
        ? '退出已取消：仍有生成任务正在执行，或任务状态暂时不可用，请稍后重试。'
        : reason==='update-gateway-preparing'
          ? '退出已取消：手机连接服务正在处理请求，请稍后重试。'
        : reason==='update-service-drain-incomplete'
        ? '后台进程尚未确认退出，请稍后重试。'
        : typeof reason==='string'&&reason.startsWith('update-lsh-')
          ? '退出已取消：请返回 LightSeek 检查任务和未保存内容，待界面准备完成后再退出。'
          : '退出已取消：请处理未保存内容或版本冲突后重试。',
    }));
    const showStatus=(text:string,phase:'saving'|'draining'|'blocked')=>{
      status=document.createElement('div');status.setAttribute('role',phase==='blocked'?'alert':'status');
      status.setAttribute('aria-live','polite');status.setAttribute('data-workspace-quit-status',phase);
      status.textContent=text;
      Object.assign(status.style,{position:'fixed',right:'24px',bottom:'24px',zIndex:'2147483647',
        maxWidth:'calc(100vw - 48px)',padding:'12px 18px',borderRadius:'12px',pointerEvents:'none',
        fontSize:'13px',background:'var(--theme-surface-panel)',color:'var(--text-primary)',
        border:'1px solid var(--theme-border-strong)',boxShadow:'0 8px 24px #0003'});
      document.body.append(status);
    };
    const deferStatus=(round:Round,phase:'saving'|'draining')=>{
      clearStatus();
      timer=window.setTimeout(()=>{
        timer=undefined;
        if(pending!==round||round.phase!==phase)return;
        if(phase==='saving'&&!Array.from(flushers).some(({hasPendingSave})=>hasPendingSave?.()))return;
        // A small themed status, not an opaque full-screen saving overlay.
        showStatus(phase==='saving'?'正在保存笔记…':'正在退出…',phase);
      },300);
    };
    await listen<{id:string;reason?:unknown}>('luckyray:workspace-quit-cancelled',event=>{
      if(pending?.id!==event.payload.id||pending.phase==='blocked')return;release(pending);cancelled(event.payload.reason);
    },local);
    await listen<{id:string;reason?:unknown}>('luckyray:workspace-quit-blocked',event=>{
      const round=pending;
      if(!round||round.id!==event.payload.id||!round.saved)return;
      round.phase='blocked';clearStatus();
      showStatus(event.payload.reason==='stop-unconfirmed'
        ? 'LightSeek 的保存停止尚未确认，应用保持退出状态。自动重试停止已暂停；如需结束应用，请使用系统强制退出。'
        : '退出收尾尚未完成，应用保持退出状态。请再次关闭窗口以重试清理。','blocked');
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
        if(pending===round&&!blocked(round)){release(round);cancelled();}
      }
    },local);
  })();
}
