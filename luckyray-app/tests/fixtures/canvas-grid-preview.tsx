import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CanvasGridSplit} from '../../src/features/canvas/CanvasGridSplit';
import '../../src/features/canvas/canvasCreative.css';
const canvas=document.createElement('canvas');canvas.width=1201;canvas.height=803;const ctx=canvas.getContext('2d')!;
const colors=['#c5adb7','#d6be91','#98afa4','#9cabca','#c1b5d5','#abb8a2','#c4aa8d','#8baaae','#cdbba5'];
for(let row=0;row<3;row++)for(let col=0;col<3;col++){const x=Math.round(col*canvas.width/3),y=Math.round(row*canvas.height/3),w=Math.round((col+1)*canvas.width/3)-x,h=Math.round((row+1)*canvas.height/3)-y;ctx.fillStyle=colors[row*3+col];ctx.fillRect(x,y,w,h);ctx.fillStyle='#ffffff99';ctx.beginPath();ctx.arc(x+w*.72,y+h*.32,35,0,Math.PI*2);ctx.fill();ctx.fillStyle='#26323b';ctx.font='36px sans-serif';ctx.fillText(`SCENE ${row*3+col+1}`,x+24,y+h-26);}
const url=canvas.toDataURL('image/png');
function Demo(){const[open,setOpen]=useState(true),[outputs,setOutputs]=useState<string[]>([]);return <><button onClick={()=>setOpen(true)}>打开宫格切分</button><p>生产组件视觉测试 · 使用合成图片；原生文件保存另行验收</p><div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14}}>{outputs.map((png,i)=><img key={i} src={png} alt={`切片 ${i+1}`} style={{width:'100%',borderRadius:12}}/>)}</div>{open?<CanvasGridSplit item={{id:'synthetic',label:'九宫格',kind:'image',source:url}} onClose={()=>setOpen(false)} onSplit={async items=>setOutputs(items.map(i=>i.png))}/>:null}</>}
createRoot(document.getElementById('root')!).render(<Demo/>);
