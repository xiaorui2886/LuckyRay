// Complete production dist, AppShell, lazy routes and all shipped CSS.
// Only native transports/data are synthetic; no production components replaced.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE);
const root=path.resolve(__dirname,'..'), dist=path.resolve(process.env.LUCKYRAY_TEST_DIST||path.join(root,'dist'));
const out=process.env.LUCKYRAY_EVIDENCE_DIR;fs.mkdirSync(out,{recursive:true});
const script=JSON.parse(fs.readFileSync(path.join(root,'plugin-sdk/examples/page-desk/example.page-desk.lrpack.json')));
const template=JSON.parse(fs.readFileSync(path.join(root,'examples/extensions/research-note.lrpack.json')));
const second=structuredClone(script);second.manifest.id='fixture.helper';second.manifest.name='素材使用清单';second.resource.contributions=[{id:'run',label:'生成素材清单',kind:'command'}];
const packs=[{package:script,enabled:true,digest:'script',grants:[],epoch:1},{package:second,enabled:false,digest:'second',grants:[],epoch:1},{package:template,enabled:false,digest:'template',epoch:0}];
async function boot(page,testPacks=packs) {
 await page.addInitScript(({packs})=>{
  if(!localStorage.getItem('luckyray-settings-v1'))localStorage.setItem('luckyray-settings-v1',JSON.stringify({'general.theme':'dark','general.language':'zh-CN','extensions.sidebarPages':'[]'}));
  window.isTauri=true;let next=1;const callbacks={};window.nativeCalls=[];window.menuOptions=null;window.runtimeEvents={};
  const menuActions={};window.menuAction=id=>menuActions[id].onmessage(id);
  let state={revision:1,hostVersion:'1.9.3',packages:packs};
  const surface={ready:true,stage:'client-ready',ownedDirectProcessCount:1};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
  window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},convertFileSrc:path=>path,transformCallback:(fn)=>{const id=next++;callbacks[id]=fn;return id},unregisterCallback:id=>delete callbacks[id],invoke:async(command,args={})=>{
   window.nativeCalls.push({command,args});
   if(command==='manage_extension_packages'){const r=JSON.parse(args.request);if(r.op!=='list'){const item=state.packages.find(x=>x.package.manifest.id===r.id);if(r.op==='enable'||r.op==='disable')item.enabled=r.op==='enable';state.revision++}return structuredClone(state)}
   if(command==='extension_runtime'){const r=JSON.parse(args.request);if(r.op==='start'){const token=String(next++);window.runtimeEvents[token]=r.event;return {token}}if(r.op==='poll'){const e=window.runtimeEvents[r.token];return {kind:'result',result:{ok:true,value:e.contribution==='about'?{title:'关于此示例',text:'这是一个声明了两个 page 入口的验证样例。当前页：about。'}:{title:'示例看板',text:'这是主内容区的插件页面。\n保存的备注：（还没有）\n已保存次数：0',fields:[{id:'note',label:'备注（保存在插件自己的数据里）',value:''}],actions:[{id:'save',label:'保存备注'}]}},receipts:[]}}return null}
   if(command==='dsh_host_status')return {stage:'probe-completed',latestProbePassed:true,hostReusable:true};
   if(command.startsWith('dsh_native_surface_'))return surface;
   if(command==='dsh_plugin_compat_status')return {runtimeVersion:'0.1.5-rc.2',manifestValid:true,plugins:[],bundles:[],quarantineSet:[]};
   if(command==='get_collection_server_base_url')return 'http://127.0.0.1:1';
   if(command==='get_local_transport_client_config')return {baseUrl:'http://127.0.0.1:1',credential:''};
   if(command==='plugin:event|listen')return next++;
   if(command==='plugin:sql|load')return 'fixture';
   if(command==='plugin:sql|select')return [];
   if(command==='plugin:sql|execute')return {rowsAffected:0,lastInsertId:0};
   if(command==='plugin:window|scale_factor')return 1;
   if(command==='plugin:window|inner_size')return {width:innerWidth,height:innerHeight};
   if(command==='plugin:image|new')return next++;
   if(command==='plugin:menu|new'){window.menuOptions=args;menuActions[args.options?.id]=args.handler;return [next++,args.options?.id||'fixture-menu']}
   if(command==='plugin:menu|popup')return null;
   if(command.includes('list_')||command.includes('get_all'))return [];
   return null;
  }};
 },{packs:testPacks});
 await page.route('**/api/**',route=>route.fulfill({json:{capabilities:Array.from({length:12},(_,i)=>({id:'workflow'+i,name:'工作流 '+(i+1),description:'整理近期素材和笔记，保留来源和引用。',type:'workflow',enabled:true}))}}));
}
(async()=>{
 const server=http.createServer((req,res)=>{const p=path.resolve(dist,'.'+decodeURIComponent(req.url.split('?')[0]));if(!p.startsWith(dist+path.sep)&&p!==dist){res.writeHead(403).end();return}const file=fs.existsSync(p)&&fs.statSync(p).isFile()?p:path.join(dist,'index.html');const ext=path.extname(file);res.setHeader('Content-Type',({'.js':'application/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'})[ext]||'application/octet-stream');res.end(fs.readFileSync(file))});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();await boot(page);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/#community');
  await page.getByText('页面示例台',{exact:true}).first().waitFor();
  await page.mouse.move(1420,880);
  await page.screenshot({animations:'disabled',path:path.join(out,'shell-community-dark.png')});
  await page.getByRole('tab',{name:'模板/工作流',exact:true}).click();
  await page.getByText('Research note',{exact:true}).first().waitFor();
  await page.screenshot({animations:'disabled',path:path.join(out,'shell-templates.png')});
  const geometry=await page.evaluate(()=>{const tabs=document.querySelector('.community-tabs');return {tabs:tabs.getBoundingClientRect().toJSON(),page:document.querySelector('#page-community').getBoundingClientRect().toJSON(),children:[...document.querySelector('#page-community').children].map(x=>({class:x.className,height:x.getBoundingClientRect().height,shrink:getComputedStyle(x).flexShrink}))}});
  fs.writeFileSync(path.join(out,'geometry.json'),JSON.stringify({geometry,errors,calls:await page.evaluate(()=>[...new Set(window.nativeCalls.map(x=>x.command))])},null,2));
  if(process.env.LUCKYRAY_BASELINE){console.log('Captured full-shell baseline',geometry.tabs.height);return}
  assert.ok(geometry.tabs.height>=40,'Tabs must retain a usable height under long template content');
  await page.locator('.community-library-content').evaluate(node=>node.scrollTop=node.scrollHeight);
  for(const name of ['插件','主题','模板/工作流','技能','工具','插件']){await page.getByRole('tab',{name,exact:true}).click();const rect=await page.getByRole('tab',{name,exact:true}).boundingBox();assert.ok(rect.height>=30&&rect.y>0&&rect.y+rect.height<900)}
  await page.getByRole('checkbox',{name:/显示.*侧栏|侧栏.*显示/}).first().check();
  await page.locator('.sidebar').getByText('示例看板',{exact:true}).waitFor();
  await page.locator('.sidebar').getByText('示例看板',{exact:true}).click();
  await page.locator('.plugin-output').waitFor();
  assert.deepEqual(await page.locator('.sidebar .nav-item.active .nav-label').allTextContents(),['示例看板']);
  await page.mouse.move(1420,880);
  let width=(await page.locator('.plugin-page').boundingBox()).width;assert.ok(width>850);
  assert.equal(await page.locator('.plugin-round').count(),0);assert.equal(await page.locator('.plugin-logs').count(),0);
  await page.screenshot({animations:'disabled',path:path.join(out,'shell-plugin-board.png')});
  await page.evaluate(()=>location.hash='#plugins/example.page-desk/about');
  await page.getByText('这是一个声明了两个 page 入口的验证样例。当前页：about。',{exact:true}).waitFor();
  assert.equal(await page.locator('.sidebar .nav-item.active').count(),0,'Unpinned about page must not select board or Community');
  assert.equal((await page.locator('.plugin-page').boundingBox()).width,width);
  await page.screenshot({animations:'disabled',path:path.join(out,'shell-plugin-about.png')});
  await page.reload();await page.locator('.sidebar').getByText('示例看板',{exact:true}).waitFor();
  await page.evaluate(()=>location.hash='#community');await page.getByRole('tab',{name:'插件',exact:true}).waitFor();
  const card=page.locator('.plugin-card').filter({hasText:'页面示例台'});
  await card.getByRole('button',{name:'停用',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.sidebar [title="页面示例台 · 示例看板"]'));
  assert.ok(await page.evaluate(()=>JSON.parse(JSON.parse(localStorage.getItem('luckyray-settings-v1'))['extensions.sidebarPages']).includes('example.page-desk/board')),'Disable preserves chosen sidebar preference');
  await card.getByRole('button',{name:'启用',exact:true}).click();
  await page.locator('.sidebar').getByText('示例看板',{exact:true}).waitFor();
  await page.getByRole('searchbox',{name:'搜索名称或 ID'}).fill('no-such-package');await page.getByText('没有匹配的扩展包。',{exact:true}).waitFor();
  await page.screenshot({animations:'disabled',path:path.join(out,'shell-empty.png')});
  await page.getByRole('searchbox',{name:'搜索名称或 ID'}).fill('');
  await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('luckyray-settings-v1'));s['general.theme']='light';localStorage.setItem('luckyray-settings-v1',JSON.stringify(s));location.reload()});
  await page.getByText('页面示例台',{exact:true}).first().waitFor();await page.screenshot({animations:'disabled',path:path.join(out,'shell-community-light.png')});
  await page.setViewportSize({width:1180,height:720});await page.getByRole('tab',{name:'模板/工作流',exact:true}).click();await page.screenshot({animations:'disabled',path:path.join(out,'shell-templates-narrow.png')});
  assert.ok((await page.getByRole('tab',{name:'插件',exact:true}).boundingBox()).height>=30);
  await page.evaluate(()=>location.hash='#ai');await page.getByRole('button',{name:'LSH 工具',exact:true}).waitFor();
  await page.waitForFunction(()=>window.nativeCalls.some(x=>x.command==='dsh_native_surface_show'));
  await page.evaluate(()=>window.nativeCalls=[]);
  for(let i=0;i<5;i++)await page.getByRole('button',{name:'LSH 工具',exact:true}).click();
  const calls=await page.evaluate(()=>window.nativeCalls);assert.equal(calls.filter(x=>/dsh_native_surface_(hide|open|restart|close)|dsh_host_(retry|probe)/.test(x.command)).length,0);
  assert.equal(await page.locator('.dsh-native-surface-loading-mark').count(),0);
  assert.ok(calls.some(x=>x.command==='plugin:menu|popup'));
  const dialogs={};for(const id of ['lsh-about','lsh-check']) {
   await page.evaluate(()=>window.nativeCalls=[]);
   await page.evaluate(id=>window.menuAction(id),id);
   await page.getByRole('dialog').waitFor();
   assert.equal(await page.locator('.dsh-native-surface-loading-mark').count(),0);
   await page.screenshot({animations:'disabled',path:path.join(out,`${id}-dialog-control.png`)});
   await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();
   await page.waitForFunction(()=>window.nativeCalls.some(x=>x.command==='dsh_native_surface_show'));
   const dialogCalls=await page.evaluate(()=>window.nativeCalls.map(x=>x.command));
   dialogs[id]=dialogCalls;
   assert.equal(dialogCalls.filter(x=>/dsh_native_surface_(open|restart|close)|dsh_host_(retry|probe)/.test(x)).length,0);
   assert.equal(dialogCalls.filter(x=>x==='dsh_native_surface_hide').length,1);
   assert.equal(dialogCalls.filter(x=>x==='dsh_native_surface_show').length,1);
   assert.equal(await page.locator('.dsh-native-surface-loading-mark').count(),0);
  }
  const manyPacks=structuredClone(packs);
  manyPacks[0].package.resource.contributions.push(...Array.from({length:4},(_,i)=>({id:`extra-${i}`,label:`附加页面 ${i+1}`,kind:'page'})));
  const many=await browser.newContext({viewport:{width:1180,height:720}}),manyPage=await many.newPage();await boot(manyPage,manyPacks);
  await manyPage.goto('http://127.0.0.1:'+server.address().port+'/#community');
  await manyPage.getByText('页面示例台',{exact:true}).first().waitFor();await manyPage.mouse.move(1160,700);
  assert.equal(await manyPage.locator('.plugin-page-entry').count(),3);
  await manyPage.screenshot({animations:'disabled',path:path.join(out,'shell-many-pages-collapsed.png')});
  await manyPage.getByRole('button',{name:'查看全部 6 个入口',exact:true}).click();
  assert.equal(await manyPage.locator('.plugin-page-entry').count(),6);
  await manyPage.mouse.move(1160,700);await manyPage.screenshot({animations:'disabled',path:path.join(out,'shell-many-pages-expanded.png')});
  await manyPage.getByRole('button',{name:'收起入口',exact:true}).click();assert.equal(await manyPage.locator('.plugin-page-entry').count(),3);await many.close();
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:true,geometry,errors,nativeMenuCommands:calls.map(x=>x.command),dialogs,manyPages:{collapsed:3,expanded:6},boundary:'Production frontend; synthetic native transport. Dialog screenshots do not include actual native child content.'},null,2));
  console.log('PASS complete production shell geometry, navigation, page width, persisted sidebar and menu lifecycle transport');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1});
