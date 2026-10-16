import React from 'react';
import {createRoot} from 'react-dom/client';
import {SharpImageView} from '../../src/features/canvas/CanvasSharpImage';
export function mountImage(container:HTMLElement,initial:Record<string,unknown>={}){
 const root=createRoot(container);let props={source:'https://fixture.invalid/original.png',preview:'https://fixture.invalid/preview.png',alt:'fixture',fallback:'unavailable',zoom:.1,...initial};
 const render=()=>root.render(<SharpImageView {...props}/>);render();return {root,update(next:Record<string,unknown>){props={...props,...next};render();}};
}
