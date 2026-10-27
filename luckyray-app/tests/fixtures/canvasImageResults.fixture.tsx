import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ReactFlowProvider} from '@xyflow/react';
import {CanvasImageResults} from '../../src/features/canvas/CanvasImageResults';
import {selectPrimaryResultImage} from '../../src/core/canvas/imageResults';
export function mountResults(element: HTMLElement) {
  const root=createRoot(element), calls:number[]=[], dimensions:number[][]=[];
  function Fixture() {
    const [data,setData]=useState({resultMediaItems:[{url:'https://fixture.invalid/a.png'},{url:'https://fixture.invalid/b.png'},{url:'https://fixture.invalid/c.png'}]});
    return <ReactFlowProvider><CanvasImageResults items={data.resultMediaItems} fallback="missing" resolveUrl={s=>s||''} onDimensions={(w,h)=>dimensions.push([w,h])} onSelectPrimary={index=>{calls.push(index);setData(previous=>selectPrimaryResultImage(previous,index));}}/></ReactFlowProvider>;
  }
  root.render(<Fixture/>);return {root,calls,dimensions};
}
