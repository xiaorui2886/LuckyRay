const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require(process.env.LUCKYRAY_TEST_DOM_MODULE || 'jsdom');

test('data desk waits for user actions and uses selected note, library and cancellation signal', async () => {
  const dom = new JSDOM('<!doctype html><body><main></main></body>', { url: 'http://fixture.invalid/' });
  const oldDocument = globalThis.document;
  globalThis.document = dom.window.document;
  const source = fs.readFileSync(path.join(process.cwd(), '../docs/review-evidence/community-closeout-20261103/extension/main.js'));
  const { activate } = await import('data:text/javascript;base64,' + source.toString('base64'));
  const calls = [], views = new Map(), hooks = [];
  const note = { title: '合成笔记甲', documentRef: { vaultId: 'synthetic', relativePath: 'a.md' }, content: '合成正文甲' };
  const asset = { id: 'asset-a', name: '合成素材甲', kind: 'text', description: '' };
  const api = {
    workspace: { registerView: item => views.set(item.id, item), openView() {}, closeView() {} },
    commands: { register() {} }, menus: { register() {} }, lifecycle: { add: fn => hooks.push(fn) },
    editor: { modules: { view: { EditorView: { updateListener: { of: fn => fn } } } }, registerExtension() {},
      current: () => ({ id: 'synthetic/a.md', view: { state: { selection: { main: { from: 0, to: 0 } } }, dispatch: change => calls.push(['edit', change.changes.insert]) } }),
      list: () => [1] },
    events: { on: async () => () => {} },
    knowledge: { search: async value => { calls.push(['search', value]); return [note]; }, read: async ref => { calls.push(['read', ref.relativePath]); return note; } },
    materials: { libraries: () => ({ libraryId: 'synthetic-library' }), library: id => {
      assert.equal(id, 'synthetic-library');
      return { listAssets: async () => { calls.push(['list', id]); return [asset]; },
        updateAsset: async (assetId, patch) => { calls.push(['update', assetId]); asset.description = patch.description; },
        getAssetsByIds: async () => [asset],
        importAssets: async options => { calls.push(['import', options.paths[0]]); return {assets:[asset]}; } };
    } },
    network: { request: (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))) },
    ai: { generate: async (prompt, { signal, onChunk }) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      calls.push(['ai', prompt]);
      if (prompt === 'controlled wait') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      onChunk('模拟'); return {text:'模拟答复'};
    } },
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const click = label => { const b = [...document.querySelectorAll('button')].find(node => node.textContent === label); assert(b, label); b.click(); };
  try {
    activate(api);
    assert.deepEqual(calls, [], 'activation must not read or write domain data');
    const dispose = views.get('board').mount(document.querySelector('main'));
    document.querySelector('[aria-label="搜索笔记"]').value = '动态查询甲';
    document.querySelector('[aria-label="素材备注"]').value = '动态备注甲';
    click('搜索笔记'); await tick(); click(note.title); await tick();
    assert(document.querySelector('output').textContent.includes(note.content));
    click('列出当前素材'); await tick(); click('保存备注'); await tick();
    assert.equal(asset.description, '动态备注甲');
    click('插入选中的搜索词'); await tick();
    assert.deepEqual(calls.map(value => value[0]), ['search', 'read', 'list', 'update', 'edit']);
    document.querySelector('[aria-label="待导入素材路径"]').value = 'synthetic-file';
    click('导入指定素材'); await tick();
    assert.deepEqual(calls.at(-1), ['import', 'synthetic-file']);
    click('开始本机取消测试'); await tick(); click('取消本机请求'); await tick();
    assert.match(document.querySelector('output').textContent, /本机请求已取消/);
    click('AI 预取消（不发送）'); await tick();
    assert.match(document.querySelector('output').textContent, /AI 请求在发送前取消/);
    document.querySelector('[aria-label="AI 合成提示"]').value = 'controlled prompt';
    click('发起 AI 合成请求'); await tick();
    assert.match(document.querySelector('output').textContent, /模拟答复/);
    document.querySelector('[aria-label="AI 合成提示"]').value = 'controlled wait';
    click('发起 AI 合成请求'); await tick(); click('取消 AI 合成请求'); await tick();
    assert.match(document.querySelector('output').textContent, /AI 合成请求已取消/);
    dispose(); hooks.forEach(fn => fn());
  } finally { globalThis.document = oldDocument; dom.window.close(); }
});
