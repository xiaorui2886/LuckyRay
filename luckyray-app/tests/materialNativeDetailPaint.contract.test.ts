import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {observeMaterialDetailPaint,sameMaterialDetailAsset,type MaterialDetailPaintState} from '../src/features/materials/materialNativeDetailRegistry.ts';
const asset={id:'asset-a',name:'A',updatedAt:'r1'} as any;
const request={libraryId:'library-a',asset,assetRevision:'asset-r1'};
function harness(){let seq=0;const queued=new Map<number,()=>void>(),rect={width:600,height:400,left:20,top:30};let visible=true;
 const element={getBoundingClientRect:()=>({...rect})} as HTMLElement;
 let current:MaterialDetailPaintState={requestId:1,binding:{viewId:'main-materials',libraryId:'library-a',generation:3,ready:true},asset,mode:'detail',element};
 const ready:any[]=[],failed:Error[]=[];const frames={request:(cb:()=>void)=>{queued.set(++seq,cb);return seq;},cancel:(id:number)=>{queued.delete(id);},visible:()=>visible};
 return{frames,ready,failed,rect,element,get current(){return current;},set current(next){current=next;},hide:()=>{visible=false;},tick:()=>{const callbacks=[...queued.values()];queued.clear();callbacks.forEach(cb=>cb());},start:(id=1)=>observeMaterialDetailPaint(id,request,()=>current,value=>ready.push(value),error=>failed.push(error),frames)};
}
test('exact viewer is acknowledged only after a presented frame; replacement, visibility, source and geometry races fail',()=>{
 const happy=harness();happy.start();happy.tick();assert.equal(happy.ready.length,0);happy.tick();assert.equal(happy.ready.length,1);
 for(const mode of ['element','hidden','generation','library','asset','request','geometry','close']){const h=harness();h.start();h.tick();
  if(mode==='element')h.current={...h.current,element:{...h.element} as HTMLElement};if(mode==='hidden')h.hide();if(mode==='generation')h.current.binding.generation++;
  if(mode==='library')h.current.binding.libraryId='other';if(mode==='asset')h.current.asset={...asset,updatedAt:'new'};if(mode==='request')h.current.requestId++;
  if(mode==='geometry')h.rect.left++;if(mode==='close')h.current.mode=null;h.tick();assert.equal(h.ready.length,0,mode);assert.equal(h.failed.length,1,mode);
 }
});
test('production openDetail/effect callbacks acknowledge repeated same-object assets via request sequence',async()=>{
 const {default:ts}=await import('typescript');const source=readFileSync(new URL('../src/features/materials/MaterialsPage.tsx',import.meta.url),'utf8');
 const ast=ts.createSourceFile('MaterialsPage.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let open='',effect='';
 const walk=(node:import('typescript').Node)=>{if(ts.isPropertyAssignment(node)&&node.name.getText(ast)==='openDetail')open=node.initializer.getText(ast);
  if(ts.isCallExpression(node)&&node.expression.getText(ast)==='useLayoutEffect'&&node.arguments[0]?.getText(ast).includes('return observeMaterialDetailPaint('))effect=node.arguments[0].getText(ast);ts.forEachChild(node,walk);};walk(ast);assert.ok(open&&effect);
 const h=harness(),ids:number[]=[];const ref=<T>(current:T)=>({current});let timer=0;const nativeDetailPendingRef=ref<any>(null);
 const env:Record<string,any>={binding:()=>h.current.binding,nativeDetailCurrentRef:ref({allAssets:[asset],viewerAsset:asset,viewerMode:'detail',loaded:true}),libraryId:'library-a',nativeDetailPendingRef,nativeDetailSequenceRef:ref(0),nativeDetailElementRef:ref(h.element),scopeRef:ref(null),sameMaterialDetailAsset,
  setTimeout:()=>++timer,clearTimeout:()=>{},setNativeDetailRequestId:(id:number)=>ids.push(id),openDetailViewer:()=>{},materialNativeDetailViews:{get:()=>({binding:()=>h.current.binding})},
  observeMaterialDetailPaint:(id:number,expected:any,read:any,ready:any,failed:any)=>observeMaterialDetailPaint(id,expected,read,ready,failed,h.frames)};
 const compile=(text:string)=>{const js=ts.transpileModule(`const callback = ${text};`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;return Function(...Object.keys(env),`${js};return callback;`)(...Object.values(env));};
 const openDetail=compile(open);
 for(let id=1;id<=2;id++){const promised=openDetail(request);assert.equal(ids.at(-1),id);env.nativeDetailRequestId=id;const cleanup=compile(effect)();h.tick();let settled=false;void promised.then(()=>settled=true);await Promise.resolve();assert.equal(settled,false);h.tick();const ack=await promised;assert.equal(ack.assetId,asset.id);assert.equal(ack.assetRevision,'asset-r1');cleanup();}
 assert.deepEqual(ids,[1,2]);
});
