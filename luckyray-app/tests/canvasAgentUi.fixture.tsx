// Production UI components, synthetic state only; no native bridge/model services.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CanvasAgentPanel } from '../src/features/canvas/CanvasAgentPanel';
import { CanvasCreativeRail } from '../src/features/canvas/CanvasCreativeRail';
import { CanvasLibraryPicker } from '../src/features/canvas/CanvasLibraryPicker';
import '../src/features/canvas/canvasCreative.css';
import '../src/canvas-spike-scroll.css';
import '../src/core/theme/themeTokens.css';

const picture = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#bbd2ca"/><circle cx="290" cy="80" r="44" fill="#ead6ab"/><path d="M0 270 110 100 230 280 300 170 400 280V300H0" fill="#476858"/></svg>');
const fullPicture = (width:number,height:number) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="3" y="3" width="${width-6}" height="${height-6}" fill="#bbd2ca" stroke="#263d39" stroke-width="6"/><rect x="12" y="12" width="60" height="60" fill="#d76560"/><rect x="${width-72}" y="12" width="60" height="60" fill="#c9a34d"/><rect x="12" y="${height-72}" width="60" height="60" fill="#376aa0"/><rect x="${width-72}" y="${height-72}" width="60" height="60" fill="#586e4e"/><path d="M${width*.15} ${height*.7} ${width*.5} ${height*.3} ${width*.85} ${height*.7}Z" fill="#567d70"/></svg>`);
const thinking = { provider: 'deepseek-official', model: 'deepseek-flash', label: 'Official default', inputModalities: ['text'], reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Maximum' }] } };
const catalog = { available: [thinking, ...Array.from({length: 35}, (_, i) => ({ provider: 'fixture-only', model: `synthetic-long-model-name-${i}`, label: `Synthetic ${i}`, inputModalities: ['text'] }))], defaultModel: { provider: thinking.provider, model: thinking.model }, currentModel: null };
const events: string[] = [];
const videoChecks = new URLSearchParams(location.search).has('video');
const testVideo = `${location.origin}/synthetic.mp4`;
(window as any).fixtureEvents = events;

function App() {
  const [host, setHost] = useState<HTMLElement | null>(null), [picker, setPicker] = useState<'asset' | 'note' | null>(null);
  const [selectedModel, setSelectedModel] = useState<any>({ provider: thinking.provider, model: thinking.model, reasoningEffort: 'low' });
  const [shape,setShape] = useState('square');
  const full = shape === 'portrait' ? fullPicture(600,1000) : shape === 'landscape' ? fullPicture(1200,600) : fullPicture(800,800);
  return <main className="canvas-host" ref={setHost} onPointerDown={event => event.stopPropagation()}>
    <div className="synthetic-art" aria-hidden="true"><div>仅合成内容 · 用于检查遮挡与模糊</div><img src={picture}/></div>
    <nav className="fixture-toolbar"><button onClick={() => setPicker('asset')}>素材库弹窗</button><button onClick={() => setPicker('note')}>知识库弹窗</button><button onClick={() => document.fullscreenElement ? document.exitFullscreen() : host?.requestFullscreen()}>全屏检查</button><button onClick={() => document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'}>切换主题</button><button onClick={()=>setShape('square')}>方图</button><button onClick={()=>setShape('landscape')}>横图</button><button onClick={()=>setShape('portrait')}>竖图</button></nav>
    <CanvasCreativeRail alwaysVisible={false} onAction={action => events.push(`rail:${action}`)}/>
    <CanvasAgentPanel canvasName="合成 UI 检查画布" draftKey="fixture-ui-only" busy={false} snapshot={{canvasId:'fixture',sessionId:'fixture',runId:'fixture',status:'completed',messages:[{role:'user',text:'合成对话，仅用于检查界面；没有发起模型请求。'},{role:'assistant',text:'这里保留原有对话、参考和未发送文字。'}]}}
      execution={null} models={catalog} selectedModel={selectedModel} onSelectModel={setSelectedModel}
      contextChips={[{id:'image',kind:'image',title:'合成山间晨光',thumbnailUrl:picture,previewUrl:full,previewText:'SHOULD-NOT-RENDER: image generation prompt'},{id:'video',kind:'video',title:'合成视频',thumbnailUrl:videoChecks?undefined:picture,videoUrl:videoChecks?testVideo:undefined,previewText:'SHOULD-NOT-RENDER: video generation prompt'},{id:'text',kind:'text',title:'实际文字参考内容，应当只显示一次。',previewText:'实际文字参考内容，应当只显示一次。'},{id:'note',kind:'note',title:'不应显示的笔记标题',previewText:'实际笔记正文，应当只显示一次。'}]}
      onSend={() => events.push('SEND-NOT-EXPECTED')} onApply={() => events.push('APPLY-NOT-EXPECTED')} onCancel={() => events.push('CANCEL-NOT-EXPECTED')}
      onLocate={() => events.push('locate')} onRemoveContext={() => events.push('REMOVE-NOT-EXPECTED')} onClose={() => {}}/>
    {host && picker && <CanvasLibraryPicker portalHost={host} variant={picker} title={picker === 'asset' ? '选择素材' : '选择笔记'} items={[{id:'one',name:'合成条目',kind:'image',thumbnailUrl:picture,contentText:'实际合成正文'}, ...(videoChecks&&picker==='asset'?[{id:'film',name:'合成视频',kind:'video',thumbnailUrl:picture,libraryPath:testVideo}, {id:'film-no-cover',name:'无封面视频',kind:'video',libraryPath:testVideo}, {id:'film-missing',name:'失效视频',kind:'video',thumbnailUrl:picture,libraryPath:`${location.origin}/missing.mp4`}]:[])]} loading={false} onPick={() => events.push('pick')} onClose={() => setPicker(null)} renderItem={item => item.name} emptyText="空" resolveUrl={url => url || ''}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
