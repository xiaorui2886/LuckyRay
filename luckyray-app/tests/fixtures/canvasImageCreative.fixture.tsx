import { useRef } from 'react';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { CanvasImageToolbar } from '../../src/features/canvas/CanvasGridSplit';
import { CanvasImageCreativeMenu, CanvasCreativeRecipeEditor } from '../../src/features/canvas/CanvasImageCreativeMenu';
export { CanvasImageCreativeMenu, CanvasCreativeRecipeEditor };
export function ToolbarFixture({ source = 'ok', onRecipe, creative = true }: { source?: string; onRecipe: (value: unknown) => void; creative?: boolean }) {
 const stage = useRef<HTMLDivElement>(null);
 return <ReactFlowProvider><div ref={stage} className="canvas-editor-stage" style={{ width: 1000, height: 700 }}><ReactFlow nodes={[{ id: 'image', position: {x: 100, y: 300}, width: 320, height: 200, data: { label: 'Image' } }]} edges={[]}><CanvasImageToolbar nodeId="image" stage={stage} source={source} onSplit={() => onRecipe('split')} onCompare={() => onRecipe('compare')} onCreativeRecipe={creative ? onRecipe : undefined}/></ReactFlow></div></ReactFlowProvider>;
}
