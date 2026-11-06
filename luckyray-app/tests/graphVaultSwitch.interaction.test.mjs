// Actual GraphPage + KnowledgeStore + graph builder; synthetic vaults only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer, transformWithEsbuild } from 'vite';

test('retained graph tabs follow committed vaults without admitting an earlier vault', async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = await import(pathToFileURL(process.env.LUCKYRAY_QA_PLAYWRIGHT || require.resolve('playwright')).href);
  const root = process.cwd();
  let source = readFileSync(path.join(root, 'src/features/graph/GraphPage.tsx'), 'utf8').replaceAll('\r\n', '\n');
  const seam = '  const loadGraphData = useCallback(async';
  assert.ok(source.includes(seam));
  source = source.replace(seam, `  const q = (window as any).__vaultTest;
  q.readers[paneId] = () => ({
    vault: mainGraphSourceRef.current?.vault.id || null,
    keys: graphSeedRef.current.nodes.map(n => n.key),
    renderedKeys: sceneCacheRef.current.visibleNodes.map(n => n.key),
    sceneCurrent: sceneSeedRef.current === graphSeedRef.current,
    viewportWidth: viewportRef.current.width,
    scope: searchScopeNodeKeysRef.current ? [...searchScopeNodeKeysRef.current] : null,
    camera: {scale: paramsRef.current.scale, panX: paramsRef.current.panX, panY: paramsRef.current.panY},
  });
  q.scope = () => { searchScopeNodeKeysRef.current = new Set(graphSeedRef.current.nodes.map(n => n.key));
    setGraphSearchScope({kind: 'folder', label: 'Synthetic folder', nodeKeys: [...searchScopeNodeKeysRef.current]});
    markGraphDirty('scene'); };
  useEffect(() => { q.mounts[paneId] = (q.mounts[paneId] || 0) + 1; }, []);
` + seam);
  const entry = `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import GraphPage from '/src/features/graph/GraphPage.tsx';
    import {I18nProvider} from '/src/core/i18n/index.ts';
    import {KnowledgeStore, knowledgeStore} from '/src/core/services/knowledgeStore.ts';
    import {activateKnowledgeWritesForVault} from '/src/core/services/knowledgeSource.ts';
    import {graphDataProvider, readGraphSeedProvenance} from '/src/core/services/graph.ts';
    import {materialStore} from '/src/core/services/materialStore.ts';
    import {graphSessionStore} from '/src/features/graph/graphSessionStore.ts';
    import '/src/core/theme/themeTokens.css';
    const q = window.__vaultTest;
    let name = 'A', version = 1, releaseIndex, releaseSeed, releasePreviousIndex;
    const vault = () => ({id: 'vault-'+name, rootPath: 'X:/synthetic/'+name, name: 'Synthetic '+name});
    const store = new KnowledgeStore(async () => {
      const v = vault(), n = name, rev = version;
      if (q.holdIndex) { q.holdIndex = false; await new Promise(r => releaseIndex = r); }
      return {mode: 'real-vault', vault: v,
        root: {kind:'folder',name:v.name,relativePath:'',children:[]},
        markdownIndex: {vaultId:v.id,rootPath:v.rootPath,version:rev,generation:rev,stale:false,refreshError:null,
          generatedAt:'2026-11-03T00:00:00Z',errors:[],documents: [1,2].map(i => ({
            relativePath:n+i+'.md',fileName:n+i+'.md',title:n+i,revision:n+rev,headings:[],embeds:[],
            wikiLinks: i===1 ? [{target:n+'2'}] : [],frontmatterTags:[],inlineTags:[],tags:[],plainText:'',excerpt:'',contentLength:0,
          }))}};
    }, () => window.__LUCKYRAY__);
    // No filesystem watcher/native bridge in this isolated fixture.
    store.ensureVaultWatch = () => {};
    for (const key of ['getSnapshot','subscribe','ensureSnapshot','revalidate']) knowledgeStore[key] = store[key].bind(store);
    window.__LUCKYRAY__ = {};
    materialStore.ensureSnapshot = async () => ({...materialStore.getSnapshot(), allAssets:[]});
    materialStore.retainChangeProtocol = () => () => {};
    const build = graphDataProvider.buildSeed;
    graphDataProvider.buildSeed = async () => {
      const seed = await build();
      q.builds.push(readGraphSeedProvenance(seed)?.vault.id || null);
      if (q.holdSeed) { q.holdSeed = false; await new Promise(r => releaseSeed = r); }
      return seed;
    };
    q.begin = next => { name = next; version=1; q.holdIndex=true;
      activateKnowledgeWritesForVault({mode:'real-vault',vaultId:vault().id,rootPath:vault().rootPath});
      q.pending = store.revalidate({reason:'synthetic-switch'}); };
    q.commit = async () => { releaseIndex(); await q.pending; };
    q.refresh = async () => { version++; await store.revalidate({reason:'synthetic-index',force:true}); };
    q.deferSeed = () => { q.holdSeed=true; window.dispatchEvent(new CustomEvent('luckyray:notes-vault-index-changed')); };
    q.releaseSeed = () => releaseSeed();
    q.background = () => { q.holdIndex=true; store.revalidate({reason:'synthetic-old-background'}); releasePreviousIndex=releaseIndex; };
    q.releasePrevious = () => releasePreviousIndex();
    q.activateOnly = next => {name=next;version=1;activateKnowledgeWritesForVault({mode:'real-vault',vaultId:vault().id,rootPath:vault().rootPath});};
    q.readIndex = () => store.revalidate({reason:'synthetic-new-source'});
    q.tabs = () => Object.keys(graphSessionStore.getSnapshot().views);
    q.addTab = () => graphSessionStore.add();
    q.selectTab = id => graphSessionStore.select(id);
    await store.revalidate({reason:'synthetic-bootstrap'});
    function App() {const [visible, setVisible] = useState(true); q.visible = setVisible;
      return <I18nProvider locale="zh-CN"><main style={{display:visible?'contents':'none'}}><GraphPage visible={visible}/></main></I18nProvider>;}
    createRoot(document.getElementById('root')).render(<App/>);`;
  const server = await createServer({root, configFile:false, logLevel:'error', esbuild:{jsx:'automatic'},
    cacheDir:path.join(root,'output/playwright/graph-vault-switch/vite-cache'),server:{host:'127.0.0.1',port:0},
    plugins:[{name:'graph-vault-switch-fixture',enforce:'pre',
      resolveId(id){if(id==='/vault-entry.js')return '\0vault-entry';},
      async load(id){if(id==='\0vault-entry')return (await transformWithEsbuild(entry,'entry.tsx',{loader:'tsx',jsx:'transform'})).code;},
      transform(code,id){if(id.replaceAll('\\','/').split('?')[0].endsWith('/src/features/graph/GraphPage.tsx'))return source;},
      configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url!=='/vault-test')return next();
        res.setHeader('Content-Type','text/html');res.end('<style>html,body,#root{margin:0;width:100%;height:100%;display:flex}#root{flex-direction:column}</style><div id="root"></div><script type="module" src="/vault-entry.js"></script>');});},
    }],
  });
  let browser;
  try {
    await server.listen(); browser = await chromium.launch({channel:'msedge',headless:true});
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      const q=window.__vaultTest={readers:{},mounts:{},builds:[],pendingViewportObservers:new Map()};
      const NativeResizeObserver=window.ResizeObserver;
      // Replay the observed WebView order: the parent layout measures the shown
      // viewport before its retained inner ResizeObserver notification arrives.
      window.ResizeObserver=class {
        constructor(callback){this.observer=new NativeResizeObserver(entries=>{
          const deliver=()=>callback(entries,this);
          if(q.holdViewportObserver && entries.some(e=>e.target.classList.contains('graph-container'))) q.pendingViewportObservers.set(this,deliver);
          else deliver();
        });}
        observe(...args){this.observer.observe(...args);}
        unobserve(...args){this.observer.unobserve(...args);}
        disconnect(){this.observer.disconnect();q.pendingViewportObservers.delete(this);}
      };
      q.flushViewportObservers=()=>{q.holdViewportObserver=false;for(const deliver of q.pendingViewportObservers.values())deliver();q.pendingViewportObservers.clear();};
    });
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/vault-test');
    const current=()=>page.evaluate(()=>Object.values(window.__vaultTest.readers).map(read=>read()));
    const waitVault=async (id)=>page.waitForFunction(id=>Object.values(window.__vaultTest.readers).every(read=>read().vault===id),id,{timeout:5000});
    await waitVault('vault-A');
    const canvas=page.locator('.graph-canvas').first(), canvasHandle=await canvas.elementHandle();
    const originalTabs=await page.evaluate(()=>window.__vaultTest.tabs());
    await page.evaluate(()=>window.__vaultTest.begin('B'));
    await page.waitForTimeout(60); // Let the early source-change read resolve, before B is committed.
    const pending=await current();
    console.log(JSON.stringify({stage:'switch-pending',views:pending}));
    assert.ok(pending.every(v=>v.vault!=='vault-A' && v.keys.length===0), 'old vault must not be shown as the new source while its index is loading');
    await page.evaluate(()=>window.__vaultTest.commit());
    await waitVault('vault-B');
    assert.deepEqual(await page.evaluate(()=>window.__vaultTest.tabs()),originalTabs,'switching vaults must keep the existing graph tabs');
    assert.equal(await canvasHandle.evaluate(node=>node.isConnected),true,'the existing canvas must not remount to refresh');
    const loadedB=await current();console.log(JSON.stringify({stage:'switch-committed',views:loadedB}));
    assert.ok(loadedB.every(v=>v.keys.length===2 && v.vault==='vault-B'));

    await page.waitForTimeout(240);
    await page.evaluate(()=>window.__vaultTest.scope());
    await page.evaluate(()=>window.__vaultTest.visible(false));
    await page.waitForFunction(()=>Object.values(window.__vaultTest.readers).every(read=>read().viewportWidth===0));
    await page.evaluate(()=>{window.__vaultTest.holdViewportObserver=true;});
    await page.evaluate(()=>window.__vaultTest.begin('C'));
    await page.evaluate(()=>window.__vaultTest.commit());
    await waitVault('vault-C');
    assert.ok((await current()).every(v=>v.scope===null),'a previous-vault search scope cannot filter the new vault to zero nodes');
    await page.waitForTimeout(400); // Finish hidden-source work before returning, as in the desktop repro.
    await page.evaluate(()=>window.__vaultTest.visible(true));
    await page.waitForFunction(()=>Object.values(window.__vaultTest.readers).every(read=>read().viewportWidth>0));
    await page.evaluate(()=>window.__vaultTest.flushViewportObservers());
    await page.waitForFunction(()=>Object.values(window.__vaultTest.readers).every(read=>read().sceneCurrent && read().renderedKeys.length===2),null,{timeout:5000});

    // A deferred old build completes last; it must never replace the current vault.
    await page.waitForTimeout(250);
    const before=await page.evaluate(()=>window.__vaultTest.builds.length);
    await page.evaluate(()=>window.__vaultTest.deferSeed());
    await page.waitForFunction(before=>window.__vaultTest.builds.length>before,before);
    await page.evaluate(()=>window.__vaultTest.begin('D'));
    await page.evaluate(()=>window.__vaultTest.commit());
    await waitVault('vault-D');
    await page.evaluate(()=>window.__vaultTest.releaseSeed());
    await page.waitForTimeout(250);assert.ok((await current()).every(v=>v.vault==='vault-D'));

    // New and retained tabs share D; an ordinary same-vault refresh retains search/camera.
    await page.evaluate(()=>window.__vaultTest.addTab());await waitVault('vault-D');
    await page.evaluate(()=>window.__vaultTest.selectTab('graph-1'));
    await page.waitForTimeout(240);
    await page.evaluate(()=>window.__vaultTest.scope());
    const stable=await current();await page.evaluate(()=>window.__vaultTest.refresh());
    await page.waitForTimeout(300);
    assert.deepEqual((await current()).map(v=>v.scope),stable.map(v=>v.scope));

    // Notes uses a non-forced read on switch. It must not join a read from D
    // that started before native activation of E, even with the same index version.
    await page.evaluate(()=>window.__vaultTest.background());
    await page.evaluate(()=>window.__vaultTest.begin('E'));
    await page.evaluate(()=>window.__vaultTest.commit());
    await waitVault('vault-E');
    await page.evaluate(()=>window.__vaultTest.releasePrevious());
    await page.waitForTimeout(240);
    assert.ok((await current()).every(v=>v.vault==='vault-E'),'the old index read cannot restore D after switching to E');

    await page.evaluate(()=>window.__vaultTest.background());
    await page.evaluate(()=>window.__vaultTest.activateOnly('F'));
    await page.evaluate(()=>window.__vaultTest.releasePrevious());
    await page.waitForTimeout(80);
    assert.ok((await current()).every(v=>v.vault===null && v.keys.length===0),'an old index completing between activation and the new read must stay retired');
    await page.evaluate(()=>window.__vaultTest.readIndex());await waitVault('vault-F');
    await page.evaluate(()=>window.__vaultTest.selectTab('graph-2'));
    await page.waitForFunction(()=>window.__vaultTest.readers['graph-2']().sceneCurrent);
    await page.evaluate(()=>window.__vaultTest.selectTab('graph-1'));
    await page.waitForFunction(()=>window.__vaultTest.readers['graph-1']().sceneCurrent);
    assert.deepEqual(await page.evaluate(()=>window.__vaultTest.mounts),{'graph-1':1,'graph-2':1});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({earlySwitch:pending,final:await current(),tabs:await page.evaluate(()=>window.__vaultTest.tabs()),mounts:await page.evaluate(()=>window.__vaultTest.mounts),profileWrites:0,modelRequests:0}));
  } finally {await browser?.close();await server.close();}
});
