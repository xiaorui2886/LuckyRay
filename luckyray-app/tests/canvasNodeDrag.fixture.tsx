// Appended to CanvasSpike by test harness to exercise private production components.

import { createRoot } from 'react-dom/client';
const dragTypes = { spike: SpikeNodeView };
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="blue"/></svg>');
const video = 'data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAARHEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggQx7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuNy4xMDNXQYxMYXZmNjEuNy4xMDNEiYhAj0AAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WImHDOqpi3FQ+cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QCYloA4JCwgUC6gUCagQJVsIRVuYEBElTDZ/tzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYxLjcuMTAzc3PWY8CLY8WImHDOqpi3FQ9nyKFFo4dFTkNPREVSRIeUTGF2YzYxLjE5LjEwMSBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QojngQCjw4EAAICQAwCdASpAAEAAAEcIhYWIhYSIAgICdaoD+AIG6EFcMdITAFVYAP7/TRL//FhX8WFfxYV/8WFf/PzO7cX85gCjloEAKADRAQABEBAAGAAYWC/0AAiOgACjloEAUADRAQABEBAAGAAYWC/0AAiOgACjloEAeADRAQABEBAAGAAYWC/0AAiOgACjloEAoADRAQABEBAAGAAYWC/0AAiOgACjloEAyADRAQABEBAAGAAYWC/0AAiOgACjloEA8ADRAQABEBAAGAAYWC/0AAiOgACjloEBGADRAQABEBAUYABhYL/QACI6AACjloEBQADRAQABEBAAGAAYWC/0AAiOgACjloEBaADRAQABEBAAGAAYWC/0AAiOgACjloEBkADRAQABEBAAGAAYWC/0AAiOgACjloEBuADRAQABEBAAGAAYWC/0AAiOgACjloEB4ADRAQABEBAAGAAYWC/0AAiOgACjloECCADRAQABEBAAGAAYWC/0AAiOgACjloECMADRAQABEBAAGAAYWC/0AAiOgACjloECWADRAQABEBAAGAAYWC/0AAiOgACjloECgADRAQABEBAAGAAYWC/0AAiOgACjloECqADRAQABEBAAGAAYWC/0AAiOgACjloEC0ADRAQABEBAUYABhYL/QACI6AACjloEC+ADRAQABEBAAGAAYWC/0AAiOgACjloEDIADRAQABEBAAGAAYWC/0AAiOgACjloEDSADRAQABEBAAGAAYWC/0AAiOgACjloEDcADRAQABEBAAGAAYWC/0AAiOgACjloEDmADRAQABEBAAGAAYWC/0AAiOgACjloEDwADRAQABEBAAGAAYWC/0AAiOgAAcU7trkbuPs4EAt4r3gQHxggGj8IED';
function DragFixture() {
 const flow = useReactFlow();
 const defaults = useContext(CanvasNodeUiContext);
 const [editing, setEditing] = useState<string | null>(null);
 const [nodes, setNodes] = useState<SpikeNode[]>([]);
 (window as any).load = (kind: string, stale = true, zoom = 1, normalize = true) => {
  setEditing(null); flow.setViewport({x:0,y:0,zoom});
  const data = kind === 'generator-image' || kind === 'generator-video'
   ? {kind:'generator', label:'Generated media', generationKind:kind.endsWith('video')?'video':'image', resultMediaUrl:kind.endsWith('image')?image:video}
   : {kind,label:'Generated text with content. '.repeat(24), ...(kind === 'image'?{refKind:'image',refMediaUrl:image}:kind==='video'?{refKind:'video',refMediaUrl:video}:{})};
  const raw = {id:'node',type:'spike',position:{x:120,y:120},style:{width:320,height:260},data,dragHandle:stale?'.canvas-node-drag-handle':undefined};
  const restored = JSON.parse(JSON.stringify(raw));
  setNodes([normalize ? withInitialSquareSize(restored) : restored]);
 };
 useEffect(() => { (window as any).load('text'); }, []);
 (window as any).node = () => nodes[0];
 (window as any).viewport = () => flow.getViewport();
 return <div className="canvas-editor-stage" style={{width:'100vw',height:'100vh'}}><CanvasNodeUiContext.Provider value={{...defaults,inlineEditingNodeId:editing,startInlineEdit:setEditing,finishInlineEdit:()=>setEditing(null),updateInlineLabel:(id,label)=>setNodes(ns=>ns.map(n=>n.id===id?{...n,data:{...n.data,label}}:n))}}>
 <ReactFlow nodes={nodes} edges={[]} nodeTypes={dragTypes} onNodesChange={changes=>setNodes(ns=>applyNodeChanges(changes,ns))} nodesDraggable panOnDrag={[1,2]} nodeDragThreshold={3}/>
 </CanvasNodeUiContext.Provider><div style={{position:'absolute',right:10,top:10,zIndex:20,display:'grid',gap:6}}>{['text','image','video','generator-image','generator-video'].map(kind=><button key={kind} onClick={()=>(window as any).load(kind)}>{kind}</button>)}<button onClick={()=>(window as any).load('text',false)}>ordinary text</button><button onClick={()=>(window as any).load('text',true,.5)}>text 50%</button><output data-testid="node-position">{JSON.stringify(nodes[0]?.position)}</output><output>{editing?'editing':'drag mode'}</output></div></div>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider locale="en-US"><ReactFlowProvider><DragFixture/></ReactFlowProvider></I18nProvider>);
