// Browser regression for the actual TagDialog/create callback and FolderTree.
// No desktop bridge or user storage: all documents/tags are disposable fixtures.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const ts = require('typescript');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(root + '/node_modules/vite')] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');
const baseline = process.argv.includes('--baseline');
const source = baseline
  ? execFileSync('git', ['show', '797e186:luckyray-app/src/features/notes/NotesPage.tsx'], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(root + '/src/features/notes/NotesPage.tsx', 'utf8');
const ast = ts.createSourceFile('NotesPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function extract(name) {
  let found;
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(ast) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, name);
  return ts.isFunctionDeclaration(found) ? found.getText(ast) : `const ${found.getText(ast)};`;
}
(async () => {
  const entry = `import React, {useState,useCallback,useRef} from 'react';
    import {createRoot} from 'react-dom/client';
    import {FolderTree} from './src/features/folders/FolderTree';
    import {useI18n,I18nProvider} from './src/core/i18n/index';
    const REAL_VAULT_TAG_PREFIX = 'real-vault-tag:';
    ${['normalizeMarkdownTagName','realVaultTagId','realVaultTagNameFromId','IconClose','TagDialog'].map(extract).join('\n')}
    const rows = Array.from({length:40},(_,i)=>({id:'real-vault:'+i+'.md', title:'Fixture '+i}));
    const nested = {id:'parent',name:'Parent',children:[{id:'parent/child',name:'Child',children:[]}]};
    function App(){
      const [dialog,setDialog]=useState(null), [tags]=useState([{id:realVaultTagId('已有'),name:'已有',noteCount:1}]);
      const [status,setStatus]=useState('');
      const knowledgeStorageMode='real-vault', realVaultTags=tags, allTags=tags, bridge=null,loadTags=()=>{},t=k=>k;
      ${extract('createAndSelectTag')}
      const [folderDocumentReveal,setFolderDocumentReveal]=useState(null);
      const selectedNoteIdRef=useRef(null), vaultRef=useRef('A'), sessionRef=useRef(1);
      const vaultSessionRef={current:{latest:()=>sessionRef.current}};
      const readActiveKnowledgeWriteSource=()=>({vaultId:vaultRef.current});
      const setRealVaultForceOpenFolderIds=()=>{};
      const isRealVaultNoteId=id=>id.startsWith('real-vault:');
      const realVaultRelativePathFromNoteId=id=>id.slice(11),normalizeVaultRelativePath=p=>p;
      ${extract('revealDocumentInFolderTree')}
      const [treeReady,setTreeReady]=useState(false),[visible,setVisible]=useState(true),[version,setVersion]=useState(0),[vault,setVault]=useState('A');
      window.fixture={
        openTags:()=>setDialog({kind:'tag',selected:[]}),
        reveal:(id)=>{selectedNoteIdRef.current=id;revealDocumentInFolderTree(id);},
        ready:()=>setTreeReady(true),refresh:()=>setVersion(v=>v+1),visible:setVisible,
        switchVault:()=>{vaultRef.current='B';sessionRef.current++;setVault('B');setTreeReady(false);},
        clear:()=>setFolderDocumentReveal(null),
      };
      const validRequest=folderDocumentReveal?.vaultId===vault && folderDocumentReveal?.session===sessionRef.current ? folderDocumentReveal : null;
      return <><button onClick={()=>window.fixture.openTags()}>Edit tags</button><output id="saved"/>
        <div className="notes-index-folder-section" style={{width:320,height:300,marginTop:20}}>
        {visible && <FolderTree key={vault} folders={treeReady?[{...nested}]:[]} selectedId={null} onSelect={()=>{}} onCreate={()=>{}} hideHeader showAllItem={false} showUncategorized={false} scope="notes" nativeExternalDropEnabled={false}
          uncategorizedDocuments={treeReady?rows:[]} documentsByFolderId={treeReady?{'parent/child':[{id:'real-vault:parent/child/target.md',title:'Nested target '+vault}]}:{}}
          selectedDocumentId={selectedNoteIdRef.current} documentRevealRequest={validRequest}/>}</div>
        <div id="editor" style={{height:120,overflow:'auto',marginTop:20}}><div style={{height:2000}}>Untouched editor fixture</div></div>
        {dialog && <TagDialog tags={tags} selected={dialog.selected} onChange={selected=>setDialog({kind:'tag',selected})} onCreateTag={createAndSelectTag} onClose={()=>setDialog(null)} onSave={()=>{window.saved=dialog.selected;document.getElementById('saved').textContent=JSON.stringify(dialog.selected);setDialog(null);}}/>}
      </>;
    }
    createRoot(document.getElementById('root')).render(<I18nProvider locale="zh-CN"><App/></I18nProvider>);`;
  const built = await esbuild.build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:'out',plugins:baseline?[{name:'baseline-folder-tree',setup(build){build.onLoad({filter:/FolderTree[.]tsx$/},()=>({contents:execFileSync('git',['show','797e186:luckyray-app/src/features/folders/FolderTree.tsx'],{cwd:root,encoding:'utf8'}),loader:'tsx',resolveDir:path.join(root,'src/features/folders')}));}}]:[],loader:{'.woff2':'dataurl','.woff':'dataurl'},define:{'process.env.NODE_ENV':'"test"'}});
  const js = built.outputFiles.find(f=>f.path.endsWith('.js')).text;
  const css = built.outputFiles.find(f=>f.path.endsWith('.css'))?.text || '';
  const server = http.createServer((req,res)=>{
    if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(js);return;}
    if(req.url==='/fixture.css'){res.setHeader('Content-Type','text/css');res.end(css+'\n'+fs.readFileSync(root+'/src/features/notes/notes.css','utf8'));return;}
    res.setHeader('Content-Type','text/html');res.end('<meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>:root{--bg-primary:#101012;--bg-secondary:#18181b;--bg-tertiary:#222228;--text-primary:#eee;--text-secondary:#bbb;--text-muted:#888;--accent:#8b80ef;--border-color:#333}body{background:#101012;color:#eee;font-family:Arial;margin:20px}.modal-overlay-react{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0008}.modal-box-react{background:#18181b;width:500px;border-radius:12px}.modal-header-react,.modal-body-react{padding:16px}.modal-header-react{display:flex;justify-content:space-between}.notes-dialog-input{box-sizing:border-box;width:100%;background:transparent;color:inherit}.folder-list{max-height:300px;overflow:auto}</style><div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1000,height:800}});
  page.setDefaultTimeout(2500); page.on('pageerror', e=>console.error('PAGE',e.message));
  const failures=[];
  async function check(name,fn){try{await fn();console.log('PASS',name);}catch(e){failures.push(name);console.log('FAIL',name,e.message);}}
  try {
    const base='http://127.0.0.1:'+server.address().port;
    await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
    await page.goto(base); await page.waitForFunction(()=>window.fixture);
    await check('new draft visible, selected during another search, deselectable; no false empty',async()=>{
      await page.getByText('Edit tags',{exact:true}).click();
      await page.locator('.notes-dialog-input').fill('  #1111  ');
      assert.equal(await page.locator('.notes-empty-inline').count(),0);
      await page.locator('.create-tag').click();
      const draft=page.locator('.notes-tag-picker button').filter({hasText:'1111'});
      await draft.waitFor({timeout:1200}); assert.equal(await draft.getAttribute('aria-pressed'),'true');
      await page.locator('.notes-dialog-input').fill('中文');
      assert.equal(await draft.count(),1);
      await page.locator('.create-tag').click();
      await draft.click(); assert.equal(await draft.count(),0);
      await page.locator('.notes-dialog-actions .primary').click();
      assert.deepEqual(await page.evaluate(()=>window.saved),['real-vault-tag:%E4%B8%AD%E6%96%87']);
    });
    // Reset modal independently so baseline failures don't prevent B verification.
    await page.evaluate(()=>document.querySelector('.modal-close-react')?.click());
    await check('normalized duplicate and IME composition do not create or save; cancel discards draft',async()=>{
      await page.evaluate(()=>{window.saved=null;window.fixture.openTags();});
      const input=page.locator('.notes-dialog-input');
      await input.fill(' #已有 ');assert.equal(await page.locator('.create-tag').count(),0);
      await input.fill('测试');
      await input.dispatchEvent('compositionstart');await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});await input.dispatchEvent('compositionend',{data:'测试'});
      assert.equal(await page.locator('.notes-tag-picker .active').count(),0);
      await page.locator('.create-tag').click();await page.locator('.modal-close-react').click();
      assert.equal(await page.evaluate(()=>window.saved),null);
      await page.evaluate(()=>window.fixture.openTags());assert.equal(await page.locator('.notes-tag-picker .active').count(),0);
      await page.locator('.modal-close-react').click();
    });
    await check('delayed tree opens nested ancestors; only list scrolls',async()=>{
      await page.evaluate(()=>{document.getElementById('editor').scrollTop=70;window.fixture.reveal('real-vault:parent/child/target.md');});
      await page.waitForTimeout(500);await page.evaluate(()=>window.fixture.ready());
      const target=page.locator('[data-folder-document-id="real-vault:parent/child/target.md"]');await target.waitFor({timeout:1200});
      await page.waitForFunction(()=>{const r=document.querySelector('[data-folder-document-id="real-vault:parent/child/target.md"]')?.getBoundingClientRect(),c=document.querySelector('.folder-list')?.getBoundingClientRect();return r&&c&&r.bottom<=c.bottom+1;},{},{timeout:1200});
      assert.equal(await page.evaluate(()=>document.getElementById('editor').scrollTop),70);assert.equal(await page.evaluate(()=>scrollY),0);
    });
    await check('already visible and index refresh do not repeat scrolling',async()=>{
      await page.evaluate(()=>window.fixture.reveal('real-vault:39.md'));await page.waitForTimeout(80);
      const before=await page.locator('.folder-list').evaluate(e=>e.scrollTop);
      await page.evaluate(()=>window.fixture.reveal('real-vault:39.md'));await page.waitForTimeout(80);
      assert.equal(await page.locator('.folder-list').evaluate(e=>e.scrollTop),before);
      await page.locator('.folder-list').evaluate(e=>e.scrollTop=0);await page.evaluate(()=>window.fixture.refresh());await page.waitForTimeout(100);
      assert.equal(await page.locator('.folder-list').evaluate(e=>e.scrollTop),0);
    });
    await check('latest target survives hidden view and late data; old vault request rejected',async()=>{
      await page.evaluate(()=>window.fixture.visible(false));await page.waitForTimeout(30);
      await page.evaluate(()=>{window.fixture.reveal('real-vault:parent/child/target.md');window.fixture.reveal('real-vault:0.md');});
      await page.waitForTimeout(500);await page.evaluate(()=>window.fixture.visible(true));await page.waitForTimeout(80);
      assert.equal(await page.locator('.folder-list').evaluate(e=>e.scrollTop),0);
      await page.evaluate(()=>window.fixture.reveal('real-vault:parent/child/target.md'));await page.waitForTimeout(80);
      await page.evaluate(()=>window.fixture.switchVault());await page.waitForTimeout(30);await page.evaluate(()=>window.fixture.ready());await page.waitForTimeout(80);
      assert.equal(await page.locator('.folder-list').evaluate(e=>e.scrollTop),0);
      assert.equal(await page.locator('[data-folder-document-id="real-vault:parent/child/target.md"]').count(),0);
      await page.evaluate(()=>window.fixture.reveal('real-vault:parent/child/target.md'));await page.waitForTimeout(80);
      assert.match(await page.locator('[data-folder-document-id="real-vault:parent/child/target.md"]').innerText(),/Nested target B/);
    });
    if(!baseline){
      const out=path.join(root,'output/playwright/notes136');fs.mkdirSync(out,{recursive:true});
      await page.screenshot({path:path.join(out,'folder-reveal.png')});
      await page.evaluate(()=>window.fixture.openTags());await page.locator('.notes-dialog-input').fill('新建标签');await page.locator('.create-tag').click();
      await page.screenshot({path:path.join(out,'tag-created.png')});
    }
    assert.equal(failures.length,0,failures.join('; '));
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
