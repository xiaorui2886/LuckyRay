const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),fs=require('node:fs'),{createRequire}=require('node:module');
const app=path.resolve(__dirname,'..'),req=createRequire(path.join(app,'package.json'));
const tools=process.env.LR_TEST_TOOLS?createRequire(path.resolve(process.env.LR_TEST_TOOLS,'package.json')):req;
const {JSDOM}=tools('jsdom'),dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'https://synthetic.invalid'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','navigator'])Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
global.IS_REACT_ACT_ENVIRONMENT=true;
const React=req('react'),{createRoot}=req('react-dom/client');
const esbuild=req(req.resolve('esbuild',{paths:[fs.realpathSync(path.join(app,'node_modules/vite'))]}));
const bundle=esbuild.buildSync({entryPoints:[path.join(app,'src/features/canvas/CanvasStoryboardTable.tsx')],bundle:true,write:false,format:'cjs',platform:'node',packages:'external',loader:{'.css':'empty'}});
const loaded={exports:{}};new Function('module','exports','require',bundle.outputFiles[0].text)(loaded,loaded.exports,req);
const {CanvasStoryboardTable}=loaded.exports;
const make=id=>({id,data:{kind:'generator',storyboardShot:{version:1,order:0,title:'',framing:'medium',durationSeconds:5,description:'合成画面',action:'',dialogue:'',lighting:'柔和晨光',sound:'风声',cameraMovement:'缓慢推进'}}});

test('summary toggles details both ways and stays in sync with the right-side toggle',async()=>{
  const root=createRoot(document.getElementById('root')),nodes=[make('one'),make('two')],before=structuredClone(nodes),calls=[];
  const record=(...args)=>calls.push(args);
  try{
    await React.act(()=>root.render(React.createElement(CanvasStoryboardTable,{shots:nodes,english:false,resolveUrl:x=>x,onPatch:record,onRemove:record,onMove:record,onLocate:record,canDuplicate:false,renderDetails:n=>React.createElement('div',null,n.data.storyboardShot.lighting)})));
    const row=id=>document.querySelector(`[data-shot-id="${id}"]`);
    const summary=id=>row(id).querySelector('.canvas-shot-planning-summary');
    const action=id=>row(id).querySelector('.canvas-shot-actions>button');
    const assertOpen=(id,open)=>{
      assert.equal(action(id).getAttribute('aria-expanded'),String(open));
      assert.equal(action(id).textContent,open?'收起':'详情');
      assert.equal(!!document.getElementById(`shot-detail-${id}`),open);
    };
    assertOpen('one',false);assertOpen('two',false);
    await React.act(()=>summary('one').click());assertOpen('one',true);assertOpen('two',false);
    await React.act(()=>summary('one').click());assertOpen('one',false);
    await React.act(()=>summary('one').click());await React.act(()=>action('one').click());assertOpen('one',false);
    await React.act(()=>action('one').click());await React.act(()=>summary('one').click());assertOpen('one',false);
    await React.act(()=>summary('one').click());await React.act(()=>summary('two').click());assertOpen('one',true);assertOpen('two',true);
    await React.act(()=>summary('one').click());assertOpen('one',false);assertOpen('two',true);
    assert.equal(summary('one').getAttribute('aria-expanded'),'false');assert.equal(summary('two').getAttribute('aria-expanded'),'true');
    for(const id of ['one','two'])assert.equal(summary(id).getAttribute('aria-controls'),`shot-detail-${id}`);
    assert.deepEqual(nodes,before,'expansion must not mutate shot data');assert.equal(calls.length,0,'expansion must not invoke data or locate actions');
  }finally{await React.act(()=>root.unmount());}
});
