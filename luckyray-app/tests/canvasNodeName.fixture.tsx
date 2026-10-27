import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CanvasNodeName} from '../src/features/canvas/CanvasNodeName';
function Fixture(){const [name,setName]=useState('Original name');return <><div id="parent" onClick={()=>document.querySelector('#propagated')!.textContent+='click;'} onDoubleClick={()=>document.querySelector('#propagated')!.textContent+='double;'} onPointerDown={()=>document.querySelector('#propagated')!.textContent+='pointer;'} onKeyDown={()=>document.querySelector('#propagated')!.textContent+='key;'}><CanvasNodeName value={name} english onCommit={value=>{setName(value);document.querySelector('#commits')!.textContent+=value+';';}}/></div><button id="outside">Outside</button><output id="commits"/><output id="propagated"/></>;}
createRoot(document.querySelector('#root')!).render(<Fixture/>);
