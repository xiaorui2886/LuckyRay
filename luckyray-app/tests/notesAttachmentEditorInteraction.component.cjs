const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/features/notes/NotesPage.tsx'), 'utf8').replace(/\r\n/g, '\n');
const esbuild = require(require.resolve('esbuild', {paths: [fs.realpathSync(path.join(root, 'node_modules/vite'))]}));
const {chromium} = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');

function block(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `missing production block: ${start}`);
  return source.slice(first, last);
}
const sameSelection = block('function sameAttachmentSelection(', '\n}\n') + '\n}';
const paneBlock = block('const [activeNotesSplitPane, setActiveNotesSplitPaneState]', 'const [editTitle');
const modeBlock = block('const [editorMode, setEditorModeState]', 'const [sourceContentDraft');
const editorAccessors = block('const readActiveEditorValue = useCallback(', 'const focusOutlineLine');
const insertionHelpers = block('const materialInsertionUiRef = useRef(', '// All material pickers');
const publishExisting = block('const publishExistingAssetMarkdown = useCallback(', 'const rememberPublishedAttachment');
const replaceRange = block('const replaceEditorRange = useCallback(', 'const applyAutocompleteItem');
const insertFiles = block('const insertDroppedFilesAsAssets = useCallback(', 'const insertClipboardImageAsAsset');
const insertMaterial = block('const insertExistingAssetReference = useCallback(', 'const createLinkedNote');
const entry = `
import React, {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {EditorView} from '@codemirror/view';
import {undo,redo} from '@codemirror/commands';
import {LiveMarkdownEditor} from './src/features/notes/editor/LiveMarkdownEditor';
import {createSerialAttachmentInserts} from './src/features/notes/editor/serialAttachmentInserts';
import {materialBlockInsertion,materialBlockSelection} from './src/core/markdown/materialBlockInsertion';
import {replaceEditorContent} from './src/core/services/editor';

window.probe = {copied:0,status:[],hold:false,release:null,blockStarted:false,releaseQueue:null};
const readActiveKnowledgeWriteSource = () => window.source;
const isRealVaultNoteId = () => true;
const realVaultRelativePathFromNoteId = id => id + '.md';
const captureAttachmentContext = async () => ({});
const attachmentContextIsCurrent = () => true;
const publishVaultAttachment = async () => {
  window.probe.copied += 1;
  if (window.probe.hold) await new Promise(resolve => {window.probe.release = resolve});
  return {markdown:'![[fixture.png]]'};
};
const preparePublishedAttachment = async (_context, result) => ({
  markdown:result.markdown,
  asset:{id:'fixture-asset',name:'fixture.png',kind:'image',previewUrl:'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='},
  embed:{targetName:'fixture.png',assetId:'fixture-asset',isMissing:0},
});
window.source = {mode:'real-vault',vaultId:'fixture-vault'};
${sameSelection}
function Fixture() {
  const [editContent,setEditContent] = useState('');
  const [selectedNoteId,setSelectedNoteId] = useState('fixture-note');
  const selectedNote = {id:selectedNoteId};
  const selectedNoteIdRef = useRef(selectedNoteId);
  selectedNoteIdRef.current = selectedNoteId;
  const noteLoadRequestRef = useRef(1);
  const liveEditorRef = useRef(null);
  const textareaRef = useRef(null);
  ${paneBlock}
  ${modeBlock}
  const [sourceContentDraft,setSourceContentDraft] = useState(null);
  const insertPicker = null, autocomplete = null, allAssets = [], bridge = null;
  const currentVault = {id:'fixture-vault',rootPath:'fixture'};
  const t = key => key;
  const setStatus = value => window.probe.status.push(value);
  const setAllAssets = () => {};
  const buildDroppedAssetMarkdown = () => '';
  const handleContentChange = useCallback(value => setEditContent(value), []);
  const publishActiveNoteContext = () => {};
  const rememberPublishedAttachment = () => {};
  ${editorAccessors}
  ${insertionHelpers}
  ${publishExisting}
  ${replaceRange}
  ${insertFiles}
  ${insertMaterial}
  const sourceTextareaValue = editorMode === 'source' && sourceContentDraft !== null ? sourceContentDraft : editContent;
  window.actions = {
    mode: editorMode,
    content: () => readActiveEditorValue(),
    selection: () => readActiveEditorSelection(),
    select: range => setActiveEditorSelection(range),
    blockQueue: () => {
      void serialAttachmentInsertsRef.current(() => true, () => {
        window.probe.blockStarted = true;
        return new Promise(resolve => {window.probe.releaseQueue = resolve});
      });
    },
    switchPane: () => setActiveNotesSplitPane('notes-pane-2'),
    switchNote: () => {noteLoadRequestRef.current += 1; selectedNoteIdRef.current = 'other-note'; setSelectedNoteId('other-note'); setEditContent('other');},
    switchVault: () => {window.source = {mode:'real-vault',vaultId:'another-vault'};},
    selectStart: () => setActiveEditorSelection({start:0,end:0}),
    liveUndo: () => undo(EditorView.findFromDOM(document.querySelector('.cm-editor'))),
    liveRedo: () => redo(EditorView.findFromDOM(document.querySelector('.cm-editor'))),
  };
  const addFile = () => void insertDroppedFilesAsAssets([new File(['x'],'fixture.png',{type:'image/png'})],readActiveEditorSelection());
  const addMaterial = () => void insertExistingAssetReference({id:'fixture-asset',name:'fixture.png'},readActiveEditorSelection());
  return <div>
    <button id="live" onClick={() => setEditorMode('live')}>Live</button>
    <button id="source" onClick={() => setEditorMode('source')}>Source</button>
    <button id="preview" onClick={() => setEditorMode('preview')}>Preview</button>
    <button id="pane" onClick={() => window.actions.switchPane()}>Pane</button>
    <button id="note" onClick={() => window.actions.switchNote()}>Note</button>
    <button id="file" onClick={addFile}>Insert file</button>
    <button id="material" onClick={addMaterial}>Insert material</button>
    <output id="mode">{editorMode}</output>
    {editorMode === 'live' ? <LiveMarkdownEditor ref={liveEditorRef} currentNoteId={selectedNoteId} value={editContent} assets={[]} notes={[]} tags={[]} noteLinks={[]} noteEmbeds={[]} onChange={handleContentChange}/> :
     editorMode === 'source' ? <textarea ref={textareaRef} value={sourceTextareaValue} onChange={event => {if(selectedNote?.id!==selectedNoteIdRef.current)return;setSourceContentDraft(event.target.value);handleContentChange(event.target.value)}}/> :
     <p id="preview-content">{editContent}</p>}
  </div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;

(async () => {
  const built = await esbuild.build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',loader:{'.css':'empty'}});
  const server = http.createServer((request,response) => {
    response.setHeader('Content-Type',request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/fixture.js' ? built.outputFiles[0].text : '<div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({channel:'msedge',headless:true});
    const context = await browser.newContext();
    const base = `http://127.0.0.1:${server.address().port}`;
    await context.route('**/*', route => route.request().url().startsWith(base) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror',error => errors.push(error.message));
    const open = async () => {await page.goto(base);await page.locator('#file').waitFor();await page.waitForFunction(() => window.actions?.mode === 'live')};
    const refs = () => page.evaluate(() => window.actions.content().match(/!\[\[fixture\.png\]\]/g)?.length || 0);
    const waitRefs = async count => {
      try {await page.waitForFunction(count => (window.actions.content().match(/!\[\[fixture\.png\]\]/g)?.length || 0) === count,count);}
      catch (error) {throw new Error(`${error.message}; state=${JSON.stringify(await page.evaluate(() => ({mode:window.actions.mode,content:window.actions.content(),selection:window.actions.selection(),copied:window.probe.copied,status:window.probe.status,dom:document.querySelector('.cm-content')?.textContent})))}`);}
    };
    await open();
    await page.locator('#file').click();
    await page.locator('#file').click();
    await waitRefs(2);
    assert.equal(await refs(),2,'Live editor accepts two serialized attachments');
    assert.deepEqual(await page.evaluate(() => window.probe.status), [], 'successful attachment insertion stays silent');
    assert.equal(await page.evaluate(() => window.actions.content()), '![[fixture.png]]\n![[fixture.png]]\n', 'consecutive publication does not insert empty paragraphs');
    await page.evaluate(() => window.actions.liveUndo());
    await page.waitForFunction(() => (window.actions.content().match(/!\[\[fixture\.png\]\]/g)?.length || 0) < 2);
    await page.evaluate(() => window.actions.liveRedo());
    await waitRefs(2);

    await open();
    await page.locator('#source').click();
    await page.locator('textarea').waitFor();
    await page.locator('#file').click();
    await page.locator('#file').click();
    await waitRefs(2);
    await page.waitForFunction(() => {const box=document.querySelector('textarea');return box && box.value === window.actions.content() && box.selectionStart === box.value.length && box.selectionEnd === box.value.length});
    assert.equal(await page.locator('textarea').inputValue(),await page.evaluate(() => window.actions.content()),'Source textarea DOM reflects both committed attachments');

    // Existing separators must use the same landing position in the editor
    // and the serialized insertion receipt, otherwise the second copy is stale.
    for (const mode of ['live','source']) {
      await open();
      if (mode === 'source') await page.locator('#source').click();
      await page.locator(mode === 'live' ? '.cm-content' : 'textarea').fill('before\n\nafter');
      await page.evaluate(() => window.actions.select({start:6,end:6}));
      await page.evaluate(() => window.actions.blockQueue());
      await page.waitForFunction(() => window.probe.blockStarted);
      await page.locator('#file').click();
      await page.locator('#file').click();
      await page.evaluate(() => window.probe.releaseQueue());
      await waitRefs(2);
      const selection = await page.evaluate(() => window.actions.selection());
      const content = await page.evaluate(() => window.actions.content());
      assert(content.slice(0,selection.start).endsWith('\n'), `${mode}: safe text landing after queued copies`);
      assert(content.endsWith('after'), `${mode}: surrounding text retained`);
    }

    for (const startMode of ['live','source']) {
      for (const stage of ['queued','publishing']) {
        for (const change of [startMode === 'live' ? 'source' : 'live','preview','pane','note']) {
        await open();
        if (startMode === 'source') {await page.locator('#source').click();await page.locator('textarea').waitFor();}
        if (stage === 'queued') {
          await page.evaluate(() => window.actions.blockQueue());
          await page.waitForFunction(() => window.probe.blockStarted);
        } else await page.evaluate(() => {window.probe.hold=true});
        await page.locator('#file').click();
        if (stage === 'publishing') await page.waitForFunction(() => window.probe.copied === 1);
        await page.locator(`#${change}`).click();
        await page.evaluate(stage => {if(stage==='queued')window.probe.releaseQueue();else window.probe.release()},stage);
        await page.waitForFunction(() => window.probe.status.length > 0);
        assert.equal(await page.evaluate(() => window.probe.copied),stage === 'queued' ? 0 : 1,`${startMode}/${stage}/${change}: copy count`);
        assert.equal(await refs(),0,`${startMode}/${stage}/${change}: stale insertion blocked in actual editor`);
        }
      }
    }
    for (const mode of ['live','source']) {
      await open();
      if (mode === 'source') {
        await page.locator('#source').click();
        await page.locator('textarea').fill('abc');
        await page.locator('textarea').evaluate(box => box.setSelectionRange(3,3));
      } else {
        await page.locator('.cm-content').fill('abc');
        await page.locator('.cm-content').press('End');
      }
      await page.evaluate(() => window.actions.blockQueue());
      await page.waitForFunction(() => window.probe.blockStarted);
      await page.locator('#file').click();
      if (mode === 'source') await page.locator('textarea').evaluate(box => box.setSelectionRange(0,0));
      else await page.evaluate(() => window.actions.selectStart());
      await page.evaluate(() => window.probe.releaseQueue());
      await page.waitForFunction(() => window.probe.status.length > 0);
      assert.equal(await page.evaluate(() => window.probe.copied),0,`${mode}: changed editor cursor rejects queued publication`);
    }
    assert.deepEqual(errors,[],'no browser runtime errors');
    console.log('PASS: real CodeMirror/source textarea serialized insertions, source DOM/caret, live undo/redo, queued/in-flight session invalidation');
  } finally {if(browser)await browser.close();await new Promise(resolve => server.close(resolve));}
})().catch(error => {console.error(error);process.exitCode=1});
