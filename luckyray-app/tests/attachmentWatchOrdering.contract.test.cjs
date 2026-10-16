const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const source=fs.readFileSync(root+'/src/core/services/knowledgeStore.ts','utf8');
const from=source.indexOf('  private queueVaultWatchRefresh()'),to=source.indexOf('\n  private startWatchFallback()',from);
const method=esbuild.transformSync('class Store {'+source.slice(from,to)+'}',{loader:'ts'}).code;
for(const stale of [false,true])test('watch publication waits for native inventory invalidation; stale='+stale,async()=>{
  let run,release;const events=[];
  const Store=new Function('setTimeout','clearTimeout','invalidateKnowledgeAttachmentInventory','markdownContentChanges','clearAttachmentResolutionReads',method+';return Store')(
    fn=>{run=fn;return 1},()=>{},async()=>{events.push('invalidate-start');await new Promise(r=>release=r);events.push('invalidate-end')},()=>null,()=>{});
  const store=new Store();store.snapshot={vault:{id:'A',rootPath:'C:/A'}};store.watchedRoot='C:/A';store.watchSession=1;store.fileChangeGeneration=0;
  store.fileChanges={drain:()=>({observations:[],reconcileRequired:true}),delay:()=>0};
  store.publish=()=>events.push('publish');store.invalidate=async()=>events.push('index');
  store.queueVaultWatchRefresh();const pending=run();
  assert.deepEqual(events,['invalidate-start'],'listeners must not resolve against the old cache');
  if(stale){store.watchSession++;store.snapshot.vault={id:'B',rootPath:'C:/B'};store.watchedRoot='C:/B'}
  release();await pending;
  assert.deepEqual(events,stale?['invalidate-start','invalidate-end']:['invalidate-start','invalidate-end','publish','index']);
});
