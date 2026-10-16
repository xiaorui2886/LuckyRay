import { useEffect, useState } from 'react';
import { preparePromptStarter, PROMPT_STARTERS, type PromptStarterKind } from '../../core/canvas/workflowHelpers';
export function PromptStarterSelect({kind,prompt,english,onInsert}:{kind:PromptStarterKind;prompt:string;english:boolean;onInsert:(prompt:string)=>void}) {
 const [notice,setNotice]=useState('');
 useEffect(()=>setNotice(''),[prompt,kind,english]);
 return <label className="canvas-prompt-starters nodrag nopan nowheel">
  <span>{english?'Prompt starters':'提示词模板'}</span>
  <select value="" aria-label={english?'Insert editable prompt guidance':'插入可编辑的提示词模板'} onChange={event=>{
   const result=preparePromptStarter(prompt,event.target.value,kind,english);
   if(result.status==='inserted') { const next=result.prompt; setNotice(''); onInsert(next); }
   else setNotice(result.status==='too-long'
    ? (english?'Prompt is too long to add this template. Your text is unchanged.':'提示词过长，未插入模板；原文已保留。')
    : result.status==='already-present' ? (english?'This template is already in your prompt.':'已包含这个模板。') : '');
  }}>
   <option value="">{english?'Choose · no automatic generation':'选择模板 · 不会自动生成'}</option>
   {PROMPT_STARTERS.filter(item=>item.kind===kind).map(item=><option key={item.id} value={item.id}>{english?item.en:item.zh}</option>)}
  </select>
  {notice?<small role="status">{notice}</small>:null}
 </label>;
}
