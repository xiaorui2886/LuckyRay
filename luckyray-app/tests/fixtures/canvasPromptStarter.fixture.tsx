import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PromptStarterSelect} from '../../src/features/canvas/PromptStarterSelect';
export function mountStarterFixture(element:HTMLElement,initial:string,kind:'image'|'video'='image',english=false){
 function Fixture(){const [prompt,setPrompt]=useState(initial);return <><PromptStarterSelect kind={kind} prompt={prompt} english={english} onInsert={setPrompt}/><textarea aria-label="提示词" value={prompt} onChange={event=>setPrompt(event.target.value)}/></>}
 const root=createRoot(element);root.render(<Fixture/>);return root;
}
