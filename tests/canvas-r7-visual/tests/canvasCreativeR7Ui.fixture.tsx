import {CanvasMotionProvider} from '../src/features/canvas/CanvasMotionContext';
// Synthetic UI fixture. Production components, local canvas data and in-memory callbacks only.
// No native bridge, provider calls, uploads, filesystem writes or paid generation.
import {StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CanvasCreativeRail,type CreativeAction} from '../src/features/canvas/CanvasCreativeRail';
import {CanvasWorkflowLibrary} from '../src/features/canvas/CanvasWorkflowLibrary';
import {CanvasReferencePacks} from '../src/features/canvas/CanvasReferencePacks';
import {CanvasImageTools} from '../src/features/canvas/CanvasImageTools';
import {CanvasDeliveryPanel} from '../src/features/canvas/CanvasDeliveryPanel';
import {CanvasStoryboard} from '../src/features/canvas/CanvasStoryboard';
import type {PackNode} from '../src/core/canvas/creativeReview';
import type {StoryboardNode} from '../src/core/canvas/storyboard';
import '../src/core/theme/themeTokens.css';
import '../src/features/canvas/canvasCreative.css';

function poster(color: string, label: string) {const canvas=document.createElement('canvas');canvas.width=960;canvas.height=640;const ctx=canvas.getContext('2d')!;const gradient=ctx.createLinearGradient(0,0,960,640);gradient.addColorStop(0,color);gradient.addColorStop(1,'#131727');ctx.fillStyle=gradient;ctx.fillRect(0,0,960,640);ctx.fillStyle='#eee8dd';ctx.beginPath();ctx.roundRect(370,140,220,310,26);ctx.fill();ctx.fillStyle='#b5a58d';ctx.fillRect(400,120,160,32);ctx.fillStyle='#716b62';ctx.font='24px sans-serif';ctx.textAlign='center';ctx.fillText(label,480,330);ctx.fillStyle='#ffffffaa';ctx.font='20px sans-serif';ctx.fillText('SYNTHETIC UI FIXTURE',480,560);return canvas.toDataURL('image/png');}
const images=[poster('#b4875e','MORNING'),poster('#546f82','EVENING'),poster('#7a6d89','STUDIO')];
const initial: PackNode[]=[
 {id:'pack-product',data:{kind:'group',label:'晨光 · 产品身份',referencePack:{version:1,kind:'product'}}},
 {id:'product-a',parentId:'pack-product',data:{kind:'image',label:'瓶身正面',refMediaUrl:images[0]}},
 {id:'product-b',parentId:'pack-product',data:{kind:'image',label:'材质与光线',refMediaUrl:images[1]}},
 {id:'pack-style',data:{kind:'group',label:'柔和自然光',referencePack:{version:1,kind:'style'}}},
 {id:'style-a',parentId:'pack-style',data:{kind:'image',label:'柔光背景',refMediaUrl:images[2]}},
 {id:'style-b',parentId:'pack-style',data:{kind:'text',label:'保持柔和阴影与暖白背景'}},
 {id:'target',data:{kind:'generator',generationKind:'image',label:'产品主图'}}
];
const boards:StoryboardNode[]=[{id:'story',data:{kind:'group',label:'晨光产品短片',storyboard:{version:1}}},...images.map((url,i)=>({id:`shot-${i}`,parentId:'story',data:{kind:'generator' as const,generationKind:'image' as const,label:['第一束光','瓶身细节','留白结束'][i],generationPrompt:'合成测试：柔和晨光，保持产品一致。',resultMediaUrl:url,storyboardShot:{version:1 as const,order:i,title:['第一束光','瓶身细节','留白结束'][i],framing:'medium' as const,description:'晨光经过窗帘落在瓶身，暖白背景与柔和阴影。',action:'镜头缓慢推进，保留自然的光线变化。',dialogue:'把片刻留给自己。',durationSeconds:4}}}))];
const labels:Record<string,string>={packs:'参考包',workflows:'创作模板',editImage:'图片精修',storyboard:'分镜板',export:'成品导出'};
function Fixture(){
 const [reduced,setReduced]=useState(false);
 const [panel,setPanel]=useState<CreativeAction|null>(null),[empty,setEmpty]=useState(false),[nodes,setNodes]=useState(initial),[story,setStory]=useState(boards),[status,setStatus]=useState('合成测试 · 不调用模型');
 const close=()=>setPanel(null), items=empty?[]:images.map((source,i)=>({id:`result-${i}`,label:['晨光产品主图','晚间产品主图','棚拍产品主图'][i],kind:'image' as const,source}));
 return <CanvasMotionProvider reduced={reduced}><main className={`creative-fixture${reduced ? " reduce-motion" : ""}`}><nav className="creative-fixture-controls" aria-label="合成场景"><button type="button" aria-pressed={reduced} onClick={()=>setReduced(value=>!value)}>应用内减少动态</button>{Object.entries(labels).map(([key,label])=><button type="button" key={key} onClick={()=>setPanel(key as CreativeAction)}>{label}</button>)}<button type="button" onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light';}}>切换主题</button><button type="button" aria-pressed={empty} onClick={()=>setEmpty(value=>!value)}>空选择场景</button></nav><p className="creative-fixture-label">{status}</p><div className="creative-fixture-art">{images.map((image,i)=><img key={image} src={image} alt={`合成产品图 ${i+1}`}/>)}</div>
 <CanvasCreativeRail alwaysVisible={false} active={panel||undefined} onAction={setPanel}/>
 {panel==='workflows'&&<CanvasWorkflowLibrary selectionCount={empty?0:3} onClose={close} onInsert={template=>setStatus(`已添加合成结构：${template.name}`)} onExport={async()=>({cancelled:false,placeholders:2,omittedEdges:0})}/>}
 {panel==='packs'&&<CanvasReferencePacks nodes={empty?[]:nodes} edges={[]} selectedIds={empty?[]:['product-a','product-b','target']} resolveUrl={url=>url} onClose={close} onCreate={()=>null} onRename={(id,label)=>setNodes(current=>current.map(node=>node.id===id?{...node,data:{...node.data,label}}:node))} onUnmark={id=>setNodes(current=>current.map(node=>node.id===id?{...node,data:{...node.data,referencePack:undefined}}:node))} onApply={()=>null} onLocate={id=>setStatus(`定位合成节点：${id}`)}/>}
 {panel==='editImage'&&<CanvasImageTools item={items[0]} onClose={close} onSave={async()=> '合成副本已完成，未写入磁盘。'}/>}
 {panel==='export'&&<CanvasDeliveryPanel items={items} onClose={close} onSave={async()=>true}/>}
 {panel==='storyboard'&&<CanvasStoryboard nodes={empty?[]:story} selectedCount={empty?0:2} onClose={close} resolveUrl={url=>url} onCreate={()=>'story'} onAdd={()=>{}} onPatch={(_board,id,patch)=>setStory(current=>current.map(node=>node.id===id?{...node,data:{...node.data,storyboardShot:{...node.data.storyboardShot!,...patch}}}:node))} onMove={()=>{}} onRemove={()=>{}} onRename={(id,label)=>setStory(current=>current.map(node=>node.id===id?{...node,data:{...node.data,label}}:node))} onUnmark={()=>{}} onLocate={id=>setStatus(`定位合成镜头：${id}`)}/>}
 </main></CanvasMotionProvider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture/></StrictMode>);
