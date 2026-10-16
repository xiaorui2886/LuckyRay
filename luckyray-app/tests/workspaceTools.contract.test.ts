import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyTools,decodeTools,moveTool,closeTool} from '../src/workspace/toolLayout.ts';
import {createLayout,decodeLayout} from '../src/workspace/layout.ts';
import {LayoutStore} from '../src/workspace/layoutStore.ts';
import {workspaceOutline} from '../src/workspace/noteOutline.ts';
test('tools group by dock, preserve pinned authority during moves, repair active tab on close',()=>{
 let tools=moveTool(emptyTools(),'outline','right');tools.panels[0].pin={viewId:'library-A-view',objectId:'same-id'};
 tools=moveTool(tools,'backlinks','right');tools=moveTool(tools,'outline','float');assert.deepEqual(tools.panels.find(p=>p.kind==='outline')?.pin,{viewId:'library-A-view',objectId:'same-id'});
 assert.equal(tools.active.right,'backlinks');assert.equal(tools.active.float,'outline');tools=closeTool(tools,'outline');assert.equal(tools.active.float,undefined);assert.ok(decodeTools(tools));
});
test('tool state participates in layout undo and strict identity-only persistence',()=>{
 const store=new LayoutStore('test');store.dispatch({type:'tools',tools:moveTool(emptyTools(),'material-filter','left')});assert.equal(store.getSnapshot().tools?.panels.length,1);store.undo();assert.equal(store.getSnapshot().tools,undefined);store.redo();
 assert.deepEqual(decodeLayout(store.getSnapshot(),'test')?.tools,store.getSnapshot().tools);
 assert.ok(decodeLayout(createLayout('test'),'test'),'old layout without tools migrates');
});
test('malformed/duplicate tool configs never overwrite a valid layout',()=>{
 assert.equal(decodeTools({...emptyTools(),panels:[{kind:'__proto__',dock:'right',pin:null}]}),null);
 const tools=moveTool(emptyTools(),'outline','right');assert.equal(decodeTools({...tools,panels:[...tools.panels,...tools.panels]}),null);
 assert.equal(decodeTools({...tools,floating:{...tools.floating,x:NaN}}),null);
 assert.equal(decodeTools({...tools,active:{right:'backlinks'}}),null);
 const clean=decodeTools({...tools,draft:'secret',panels:[{...tools.panels[0],draft:'secret'}]});assert.ok(!JSON.stringify(clean).includes('secret'));
});
test('outline uses Markdown syntax, including nested/setext headings but excluding fenced code',()=>{
 const content='# 一级\n正文\n## 二级\n```md\n# 代码不是标题\n```\n三级\n---\n';const result=workspaceOutline(content);
 assert.deepEqual(result.map(h=>[h.level,h.text]),[[1,'一级'],[2,'二级'],[2,'三级']]);assert.equal(content.slice(result[1].from,result[1].from+2),'##');
});
