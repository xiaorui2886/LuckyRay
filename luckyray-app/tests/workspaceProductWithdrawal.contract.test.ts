import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPresentation, decodePresentation, spaceControls} from '../src/workspace/presentation.ts';
import {navigationEntries} from '../src/workspace/navigationVisibility.ts';
import {LayoutStore} from '../src/workspace/layoutStore.ts';
import {nativeWorkspaceWindowRole} from '../src/workspace/windowBootstrap.ts';
import {normalizeRetiredWorkspaceRoute} from '../src/app/shellRouteSelection.ts';
import {readFile, access} from 'node:fs/promises';

test('retired Workspace Experience is not offered in navigation or layout display settings', () => {
  assert.equal(spaceControls.includes('workspace'), false);
  assert.equal(navigationEntries.some(entry => String(entry.id) === 'workspace'), false);
  assert.equal(defaultPresentation().navigation.space.order.includes('workspace'), false);
});

test('reading an old layout preserves saved bytes and all retained navigation preferences', () => {
  const old = defaultPresentation();
  old.navigation.space.order = ['graph', 'workspace', 'notes', 'materials', 'canvas', 'community', 'ai'];
  old.navigation.space.hidden = ['canvas'];
  const decoded = decodePresentation(old)!;
  assert.deepEqual(decoded.navigation.space.order, ['graph', 'notes', 'materials', 'canvas', 'community', 'ai']);
  assert.deepEqual(decoded.navigation.space.hidden, ['canvas']);
  const views = {
    note: {id:'note', kind:'note', title:'Synthetic note', library:{kind:'knowledge', id:'synthetic-vault'}, resourceId:'Synthetic.md'},
    graph: {id:'graph', kind:'graph', title:'Synthetic graph', library:{kind:'knowledge', id:'synthetic-vault'}},
  };
  const root = {kind:'split', id:'split', axis:'row', ratio:.4, first:{kind:'group', id:'left', tabs:['note'], active:'note'}, second:{kind:'group', id:'right', tabs:['graph'], active:'graph'}};
  const raw = JSON.stringify({version:1, windowId:'main', root, views, focusedGroup:'right', presentation:old});
  let writes = 0;
  const store = new LayoutStore('main', {getItem:()=>raw, setItem:()=>{writes++;}});
  assert.deepEqual(store.getSnapshot().root, root);
  assert.deepEqual({...store.getSnapshot().views}, views);
  assert.equal(store.getSnapshot().focusedGroup, 'right');
  assert.equal(writes, 0, 'withdrawal must not clear or rewrite saved layouts on read');
});

test('old experience bookmarks resolve to Notes without changing any retained route', () => {
  for (const route of ['workspace', 'workspace?view=old', 'workspace/note']) assert.equal(normalizeRetiredWorkspaceRoute(route), 'notes');
  for (const route of ['notes', 'graph', 'materials', 'canvas', 'settings', 'ai', 'plugins/synthetic/page', 'workspace-other']) assert.equal(normalizeRetiredWorkspaceRoute(route), route);
});

test('production entry does not mount the old experience, transfer broker or recovery startup', async () => {
  const source = async (path:string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const main = await source('src/main.tsx');
  const shell = await source('src/app/AppShell.tsx');
  const sidebar = await source('src/app/AppSidebar.tsx');
  const notes = await source('src/features/notes/NotesPage.tsx');
  const graph = await source('src/features/graph/GraphPage.tsx');
  const lifecycle = await source('src/workspace/windowLifecycle.ts');
  const build = await source('vite.config.ts');
  assert.doesNotMatch(main, /installWorkspaceProductionMain|\bWorkspaceWindow\b/);
  assert.doesNotMatch(shell, /WorkspacePage|WorkspaceProductionMain|workspace:\s*\{/);
  assert.doesNotMatch(sidebar, /requestNotesNativeDetach|requestGraphNativeDetach|openNativeTabMenu/);
  assert.doesNotMatch(notes, /requestNotesNativeDetach|onNativeWindow/);
  assert.doesNotMatch(graph, /requestGraphNativeDetach/);
  assert.doesNotMatch(lifecycle, /restorePreviousWindows|WindowRecovery|location\.hash\s*=\s*['"]#workspace/);
  assert.doesNotMatch(build, /workspace-child|workspaceChild/);
  await assert.rejects(access(new URL('../workspace-child.html', import.meta.url)), {code:'ENOENT'});
  await assert.rejects(access(new URL('../src/workspace/WorkspacePage.tsx', import.meta.url)), {code:'ENOENT'});
  // Keep the actual page/presentation adapters and the Main saved-draft barrier.
  assert.match(sidebar, /IntegratedLayoutManager/);
  assert.match(notes, /beginNotesTabPointerDrag/);
  assert.match(graph, /splitCurrentView\("row"\)/);
  assert.match(lifecycle, /registerWorkspaceFlush/);
  assert.match(lifecycle, /op:'quitAck',id,saved/);
  assert.match(main, /preloadDshBackgroundAtStartup\(nativeWindowLabel\)/);
});

test('native rejection occurs before host/note dispatch, state or recovery IO, and window construction', async () => {
  const native = await readFile(new URL('../src-tauri/src/workspace_windows.rs', import.meta.url), 'utf8');
  const entry = native.slice(native.indexOf('pub(crate) async fn workspace_window_command'), native.indexOf('    match request {', native.indexOf('pub(crate) async fn workspace_window_command')));
  assert.ok(entry.indexOf('product_request_allowed') < entry.indexOf('app.state::<WorkspaceWindows>'));
  assert.ok(entry.indexOf('PRODUCT_WINDOWS_WITHDRAWN') < entry.indexOf('host_dispatch::dispatch'));
  assert.ok(entry.indexOf('PRODUCT_WINDOWS_WITHDRAWN') < entry.indexOf('note_dispatch::dispatch'));
  const build = native.slice(native.indexOf('fn build_window('));
  assert.ok(build.indexOf('fixture_windows_enabled') < build.indexOf('WebviewWindowBuilder::new'));
  const product = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.doesNotMatch(product, /register_asynchronous_uri_scheme_protocol\("workspace-attachment"/);
});

test('only Main can boot the product entry; a saved child identity cannot launch its document', () => {
  assert.equal(nativeWorkspaceWindowRole('main'), 'main');
  for (const label of ['workspace-saved-note', 'workspace-saved-graph', 'workspace-', 'unknown']) {
    assert.throws(() => nativeWorkspaceWindowRole(label));
  }
});
