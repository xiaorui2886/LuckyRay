const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const source=fs.readFileSync(root+'/src/features/notes/NotesPage.tsx','utf8').replace(/\r\n/g,'\n');
const start=source.indexOf('  prepareNoteMediaRef.current = (noteId) => {'),end=source.indexOf('\n  const currentVaultPresentation',start);
const compiled=esbuild.transformSync(source.slice(start,end),{loader:'ts'}).code;
test('production note preparation prioritizes restored viewport, warms video posters and rejects an old navigation',async()=>{
 const sourceIdentity={},batch={},session={};let request=1,revision=0,partial;const schedules=[],commits=[];
 const items=[{target:'top.png',line:1},{target:'near.png',line:205},{target:'poster.mp4',line:210},{target:'no-poster.mp4',line:212}].map(item=>({...item,assetLookupKey:item.target,wikiSyntax:true}));
 const matches=Object.fromEntries(items.map(item=>[item.target,[{exists:true,isFile:true,absolutePath:'C:/A/'+item.target,relativePath:item.target,version:'1',materialAssetId:item.target}]]));
 const context={prepareNoteMediaRef:{},currentVault:{id:'A',rootPath:'C:/A'},readActiveKnowledgeWriteSource:()=>sourceIdentity,
 vaultSessionRef:{current:{latest:()=>session,isCurrent:x=>x===session}},knowledgeSnapshot:{attachmentChanges:batch,attachmentResolutionRevision:0},knowledgeStore:{getSnapshot:()=>({attachmentChanges:batch,attachmentResolutionRevision:revision})},noteLoadRequestRef:{get current(){return request}},selectedNoteIdRef:{current:'N'},
 realVaultRelativePathFromNoteId:x=>x,mediaViewportLinesRef:{current:new Map([['N',{from:200,to:220}]])},buildRealVaultEmbedItems:()=>items,realVaultMarkdownIndex:{},allAssets:[],t:x=>x,realVaultAssetMatches:matches,
 materialAssetsById:new Map([['poster.mp4',{thumbnailUrl:'poster.png'}]]),realVaultAssetKind:p=>p.endsWith('.mp4')?'video':'image',realVaultAssetPreviewUrl:p=>p,
 resolveNoteMediaSources:asset=>({imageSource:asset.kind==='video'?asset.thumbnailUrl||'':asset.previewUrl}),scheduleAttachmentPrefetch:(entries,gate)=>schedules.push({entries,gate}),
 resolveAttachmentBatchProgressive:async(_v,_lookups,callback)=>{partial=callback;},mergeAttachmentBatch:x=>x,setRealVaultAssetMatches:fn=>commits.push(fn)};
 new Function('context','with(context){'+compiled+'}')(context);context.prepareNoteMediaRef.current('N');
 assert.deepEqual(schedules[0].entries.map(e=>e.url.split('?')[0]),['C:/A/near.png','poster.png','C:/A/top.png']);
 assert.ok(schedules[0].entries.every(e=>e.kind==='image'));
 request=2;partial({entries:[]});assert.equal(commits.length,0);assert.equal(schedules[0].gate(),false);
 request=1;revision=1;partial({entries:[]});assert.equal(commits.length,0);assert.equal(schedules[0].gate(),false);
});

test('index reconciliation drops deleted and indexed receipts while keeping unsaved references',()=>{
 const begin=source.indexOf('  useEffect(() => {\n    setPublishedDraftEmbeds(previous => {');
 const finish=source.indexOf('\n\n  const rawRealVaultEmbedItems',begin);
 assert.ok(begin>0&&finish>begin);
 let receipts=['deleted','indexed','unsaved','unloaded'].map(noteId=>({noteId,prepared:{markdown:'![x](x.png)'}}));
 const context={useEffect:fn=>fn(),setPublishedDraftEmbeds:fn=>{receipts=fn(receipts)},
 realVaultLatestContentRef:{current:new Map([['deleted','body'],['indexed','![x](x.png)'],['unsaved','![x](x.png)']])},
 realVaultRelativePathFromNoteId:x=>x,realVaultMarkdownIndex:{documents:[{relativePath:'indexed',embeds:[{raw:'![x](x.png)'}]}]}};
 new Function('context','with(context){'+source.slice(begin,finish)+'}')(context);
 assert.deepEqual(receipts.map(item=>item.noteId),['unsaved','unloaded']);
});
