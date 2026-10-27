const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', {paths: [fs.realpathSync(root + '/node_modules/vite')]}));
const source = fs.readFileSync(root + '/src/features/notes/NotesPage.tsx', 'utf8').replace(/\r\n/g, '\n');
function declaration(name) {
  const from = source.indexOf(`function ${name}(`);
  const to = source.indexOf('\n}\n', from);
  assert(from >= 0 && to > from);
  return source.slice(from, to + 2);
}
const from = source.indexOf('const publishedTabsRef =');
const to = source.indexOf('\n  useEffect(', from);
const code = esbuild.transformSync([
  declaration('markdownTitleFromPath'), declaration('noteFromKnowledgeDocument'),
  declaration('buildRealVaultUiTree'), declaration('noteTitle'), source.slice(from, to),
  'return {buildRealVaultUiTree, noteFromKnowledgeDocument, publishTabs};',
].join('\n'), {loader:'ts'}).code;
const events = [];
const context = {
  realVaultNoteId: path => `vault:${path}`, realVaultParentPath: () => null,
  shortDate: () => '', useRef: current => ({current}), useCallback: fn => fn,
  notes: [], editTitle: '', t: key => key,
  window: {dispatchEvent: event => events.push(event.detail)},
  CustomEvent: class {constructor(name, {detail}) {this.detail = detail;}},
};
const api = new Function('context', `with(context){${code}}`)(context);
const tabs = [{id: 'vault:folder/笔记.md', kind:'note'}];
for (let i=0;i<30;i++) {
  const tree = api.buildRealVaultUiTree([{id:'folder/笔记.md',relativePath:'folder/笔记.md',kind:'document',title:'笔记.md',updatedAt:String(i)}], 'zh-CN', '未命名');
  assert.equal(tree.uncategorizedDocuments[0].title, '笔记.md', 'keep the index filename presentation');
  api.publishTabs(tabs, tabs[0].id, tree.notes);
  const saved = api.noteFromKnowledgeDocument({id:'folder/笔记.md',relativePath:'folder/笔记.md',source:'real-vault',title:'笔记',contentText:'saved body ' + i});
  api.publishTabs(tabs, tabs[0].id, [saved]);
}
assert.equal(events.length, 1, '60 index/read-save echoes must not republish identical titlebar data');
assert.equal(events[0].tabs[0].title, '笔记');
api.publishTabs(tabs, tabs[0].id, [{id:tabs[0].id,title:'重命名'}]);
assert.equal(events.at(-1).tabs[0].title, '重命名', 'real renames still publish');
api.publishTabs([...tabs,{id:'empty',kind:'empty'}], 'empty', []);
assert.equal(events.at(-1).activeId, 'empty', 'active tab changes still publish');

const moduleObject = {exports:{}};
new Function('module','exports',esbuild.transformSync(fs.readFileSync(root+'/src/core/markdown/materialBlockInsertion.ts','utf8'),{loader:'ts',format:'cjs'}).code)(moduleObject,moduleObject.exports);
const {materialBlockInsertion,materialBlockSelection} = moduleObject.exports;
for (const newline of ['\n','\r\n']) {
  for (const suffix of ['',newline,newline.repeat(2),newline.repeat(3),'after',newline.repeat(2)+'after']) {
    const text = `before${newline}${suffix}`, range = {start:6+newline.length,end:6+newline.length};
    const replacement = materialBlockInsertion(text,'![[a.svg]]',range);
    const output = text.slice(0,range.start)+replacement+text.slice(range.end);
    const caret = materialBlockSelection(text,replacement,range).start;
    assert(output.slice(0,caret).endsWith(newline), 'caret leaves attachment token before typing');
    assert(caret <= output.length);
    assert.equal((output.match(/!\[\[a.svg\]\]/g)||[]).length,1);
    assert(output.includes(`![[a.svg]]${newline}`), 'media owns its line without creating an empty paragraph');
  }
}
for (const newline of ['\n','\r\n']) {
  let text = '';
  let range = {start:0,end:0};
  // Seed CRLF detection without changing surrounding author whitespace.
  if (newline === '\r\n') {text='intro\r\n';range={start:text.length,end:text.length};}
  for (let i=0;i<3;i++) {
    const replacement=materialBlockInsertion(text,'![[a.svg]]',range);
    const next=materialBlockSelection(text,replacement,range);
    text=text.slice(0,range.start)+replacement+text.slice(range.end);
    range=next;
  }
  assert(text.endsWith(('![[a.svg]]'+newline).repeat(3)), 'consecutive inserts must not accumulate blank paragraphs');
  assert.equal(range.start,text.length);
}
console.log('PASS: titlebar echo dedup/rename/navigation, unchanged tree filenames, LF/CRLF material landing separators');
