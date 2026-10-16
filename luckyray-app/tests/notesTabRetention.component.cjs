// Execute the production publisher, titlebar subscriber and page-exit effect
// with React's real Activity / StrictMode lifecycle, not simulated cleanups.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const ts = require('typescript');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(root + '/node_modules/vite')] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');

function sourceAst(file) {
  return ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const notesAst = sourceAst('src/features/notes/NotesPage.tsx');
const titlebarAst = sourceAst('src/app/AppSidebar.tsx');
function extract(ast, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(matches.length, 1, 'exactly one production declaration/effect must match');
  return matches[0].getText(ast);
}
const declaration = name => 'const ' + extract(notesAst, node => ts.isVariableDeclaration(node) && node.name.getText(notesAst) === name) + ';';
const effect = (ast, marker) => extract(ast, node => ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes(marker)) + ';';
const publisher = [
  declaration('publishedTabsRef'),
  declaration('publishTabs'),
  effect(notesAst, 'publishTabs(openTabs, selectedNoteId || activeEmptyTabId)'),
  effect(notesAst, 'title: notesExitTitleRef.current'),
].join('\n');
const subscriber = effect(titlebarAst, 'setNoteTabs(Array.isArray(detail.tabs) ? detail.tabs : [])');

test('notes titlebar survives retained page lifecycles without resetting document state', async t => {
  const built = await esbuild.build({
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React, { Activity, StrictMode, useCallback, useEffect, useRef, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      const t = key => key;
      const noteTitle = note => note.title;
      window.events = [];
      window.flushes = [];
      window.addEventListener('luckyray:notes-tabs', event => window.events.push(event.detail));
      function Titlebar() {
        const [noteTabs, setNoteTabs] = useState([]);
        const [activeNoteId, setActiveNoteId] = useState(null);
        ${subscriber}
        return <div id="titlebar" data-active={activeNoteId}>{noteTabs.map(tab => <span key={tab.id} data-tab={tab.id}>{tab.title}</span>)}</div>;
      }
      function NotesLifecycle() {
        const [openTabs, setOpenTabs] = useState([{ id: 'A', kind: 'note' }]);
        const [selectedNoteId, setSelectedNoteId] = useState('A');
        const [activeEmptyTabId, setActiveEmptyTabId] = useState(null);
        const [editTitle, setEditTitle] = useState('Alpha');
        const [notes, setNotes] = useState([{ id: 'A', title: 'Alpha' }, { id: 'B', title: 'Beta' }]);
        const notesPaneLayout = null;
        const notesPaneViewsRef = useRef({ get: (paneId, tabId) => paneId + ":" + tabId });
        const [draft, setDraft] = useState('original draft');
        const owner = useRef({});
        const flushPendingSaveRef = useRef(() => {});
        flushPendingSaveRef.current = () => window.flushes.push(draft);
        const notesExitTitleRef = useRef('Knowledge');
        window.notesState = { openTabs, selectedNoteId, activeEmptyTabId, draft, owner: owner.current };
        window.setDraft = setDraft;
        window.setTitle = setEditTitle;
        window.setTabs = (tabs, activeId) => {
          setOpenTabs(tabs);
          const isEmpty = tabs.find(tab => tab.id === activeId)?.kind === 'empty';
          setSelectedNoteId(isEmpty ? null : activeId);
          setActiveEmptyTabId(isEmpty ? activeId : null);
        };
        window.renameNotes = setNotes;
        ${publisher}
        return <textarea id="draft" value={draft} onChange={event => setDraft(event.target.value)}/>;
      }
      function Fixture() {
        const [visible, setVisible] = useState(true);
        window.showNotes = setVisible;
        return <><Titlebar/><Activity mode={visible ? 'visible' : 'hidden'}><NotesLifecycle/></Activity></>;
      }
      const app = <Fixture/>;
      createRoot(document.getElementById('root')).render(location.search.includes('strict') ? <StrictMode>{app}</StrictMode> : app);
    ` },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
  });
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', req.url === '/app.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/app.js' ? built.outputFiles[0].text : '<div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.LUCKYRAY_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.LUCKYRAY_CHROMIUM_EXECUTABLE_PATH }
        : { channel: 'msedge' }),
    });
    const url = 'http://127.0.0.1:' + server.address().port;
    async function fixture(strict = false) {
      const page = await browser.newPage();
      page.setDefaultTimeout(2500);
      await page.goto(url + (strict ? '/?strict' : '/'));
      await page.waitForFunction(() => window.notesState && window.events.length);
      await settle(page);
      return page;
    }
    async function settle(page) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    async function tabs(page) {
      return page.locator('#titlebar [data-tab]').evaluateAll(nodes => nodes.map(node => node.dataset.tab));
    }
    async function roundTrip(page, expected) {
      await page.evaluate(() => window.showNotes(false));
      await page.locator('#draft').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => window.events.at(-1).tabs.length === 0);
      assert.deepEqual(await tabs(page), [], 'hidden notes clear their titlebar projection');
      await page.evaluate(() => window.showNotes(true));
      await page.locator('#draft').waitFor({ state: 'visible' });
      await settle(page);
      assert.deepEqual(await tabs(page), expected, 'show must replay the unchanged retained tab state');
    }

    await t.test('first entry including StrictMode effect replay', async () => {
      for (const strict of [false, true]) {
        const page = await fixture(strict);
        try {
          assert.deepEqual(await tabs(page), ['A']);
          assert.equal(await page.locator('#titlebar').getAttribute('data-active'), 'A');
        } finally { await page.close(); }
      }
    });
    await t.test('single and multiple tabs survive repeated Activity hide/show with the same draft and owner', async () => {
      const page = await fixture();
      try {
        await page.locator('#draft').fill('unsaved retained draft');
        await page.evaluate(() => { window.originalOwner = window.notesState.owner; });
        for (let i = 0; i < 3; i++) await roundTrip(page, ['A']);
        await page.evaluate(() => window.setTabs([{ id: 'A', kind: 'note' }, { id: 'B', kind: 'note' }], 'B'));
        await settle(page);
        for (let i = 0; i < 3; i++) await roundTrip(page, ['A', 'B']);
        assert.equal(await page.locator('#titlebar').getAttribute('data-active'), 'B');
        assert.equal(await page.locator('#draft').inputValue(), 'unsaved retained draft');
        assert.equal(await page.evaluate(() => window.notesState.owner === window.originalOwner), true);
        assert.equal(await page.evaluate(() => window.flushes.every(value => value === 'unsaved retained draft')), true);
      } finally { await page.close(); }
    });
    await t.test('empty tabs, a fully closed strip and later opening never resurrect stale tabs', async () => {
      const page = await fixture();
      try {
        await page.evaluate(() => window.setTabs([{ id: 'empty-1', kind: 'empty' }], 'empty-1'));
        await settle(page);
        await roundTrip(page, ['empty-1']);
        assert.equal(await page.locator('#titlebar').getAttribute('data-active'), 'empty-1');
        await page.evaluate(() => window.setTabs([], null));
        await settle(page);
        await roundTrip(page, []);
        await page.evaluate(() => window.setTabs([{ id: 'B', kind: 'note' }], 'B'));
        await settle(page);
        await roundTrip(page, ['B']);
      } finally { await page.close(); }
    });
    await t.test('visible callback changes stay deduplicated and latest titles replay after hiding', async () => {
      const page = await fixture();
      try {
        const count = await page.evaluate(() => window.events.length);
        for (let i = 0; i < 5; i++) {
          await page.evaluate(i => window.setTitle('unused active fallback ' + i), i);
          await settle(page);
        }
        assert.equal(await page.evaluate(() => window.events.length), count, 'ordinary callback churn must not republish');
        await page.evaluate(() => window.renameNotes([{ id: 'A', title: 'Renamed Alpha' }]));
        await settle(page);
        await roundTrip(page, ['A']);
        assert.equal(await page.locator('#titlebar [data-tab="A"]').textContent(), 'Renamed Alpha');
      } finally { await page.close(); }
    });
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
