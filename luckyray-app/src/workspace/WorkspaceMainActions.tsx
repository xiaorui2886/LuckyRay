import {useEffect,useState} from 'react';
import {listen} from '@tauri-apps/api/event';
import {focusEntity} from '../core/services/context';
import {knowledgeTagIdentity} from '../core/services/knowledge';
import {readActiveKnowledgeSource} from '../core/services/knowledgeSource';
import {openInLightSeek,waitForOpenInLightSeekIntent} from '../core/services/openInLightSeek';
import {windowLayoutStore} from './layoutStore';
import {workspaceCommand,viewRefFromGrant} from './nativeClient';
import {createWorkspaceMainActionConsumer,type WorkspaceMainActionTransport} from './mainActionProtocol';

/** Mount once in Main's shell, never in WorkspaceWindow or retained children.
 * It uses the existing Main navigation/layout and the single AI composer. */
export function WorkspaceMainActions(){
 const [error,setError]=useState('');
 useEffect(()=>{
  let alive=true,unlisten:(()=>void)|undefined;
  const transport:WorkspaceMainActionTransport={
   pending:()=>workspaceCommand({op:'parentActionPending'}),
   claim:id=>workspaceCommand({op:'parentActionClaim',id}),
   validate:(id,claimToken)=>workspaceCommand({op:'parentActionValidate',id,claimToken}),
   execute:(id,claimToken,confirmed)=>workspaceCommand({op:'parentActionExecute',id,claimToken,confirmed}),
   complete:(id,claimToken,completion)=>workspaceCommand({op:'parentActionComplete',id,claimToken,completion}),
   cancel:id=>workspaceCommand({op:'parentActionCancel',id}),
  };
  const consumer=createWorkspaceMainActionConsumer(transport,{
   now:()=>performance.now(),alive:()=>alive,knowledgeSource:readActiveKnowledgeSource,
   confirmCreate:action=>window.confirm(`在知识库 ${action.vaultId} 中创建空白笔记「${action.relativePath}」？已有文件不会被覆盖。`),
   openBoundNote:grant=>{
    const store=windowLayoutStore('main');
    store.dispatch({type:'open',view:viewRefFromGrant(grant),groupId:store.getSnapshot().focusedGroup});
    window.location.hash='#workspace';
   },
   openTag:(vaultId,name)=>{
    focusEntity('tag',knowledgeTagIdentity(vaultId,name),{source:'workspace-parent-action'});
    window.location.hash='#tags';
   },
   compose:async request=>{const intent=openInLightSeek(request);await waitForOpenInLightSeekIntent(intent.intentId);},
  });
  const receive=()=>{void consumer.drain(failure=>{if(alive)setError(String(failure));}).catch(failure=>{if(alive)setError(String(failure));});};
  void listen('luckyray:workspace-action-available',receive).then(stop=>{if(!alive)stop();else{unlisten=stop;receive();}}).catch(failure=>{if(alive)setError(String(failure));});
  const fallback=setInterval(receive,1500);
  return()=>{alive=false;unlisten?.();clearInterval(fallback);};
 },[]);
 return error?<div className="workspace-conflict" role="alert">{error}<button type="button" onClick={()=>setError('')}>关闭提示</button></div>:null;
}
