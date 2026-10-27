const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const appRoot = path.resolve(__dirname, '../../..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(appRoot, 'node_modules/vite'))] }));
const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, 'canvasTextEditing.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' });
const loaded = { exports: {} }; new Function('module', 'exports', out.outputFiles[0].text)(loaded, loaded.exports);
const { formatCanvasText, canvasTextOutline, canvasScriptTemplate } = loaded.exports;
const apply = (value, edit) => value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
test('selected Chinese text receives reversible Markdown formatting without changing neighbors', () => {
  const source = '开场：你好，世界。\n下一镜';
  const first = formatCanvasText(source, 3, 8, 'bold');
  const next = apply(source, first);
  assert.equal(next, '开场：**你好，世界**。\n下一镜');
  assert.equal(apply(next, formatCanvasText(next, first.anchor, first.head, 'bold')), source);
});
test('empty selection leaves caret inside inserted markers', () => {
  const edit = formatCanvasText('abc', 1, 1, 'italic');
  assert.equal(apply('abc', edit), 'a**bc'); assert.equal(edit.anchor, 2); assert.equal(edit.head, 2);
});
test('italic applied to bold content does not remove one bold delimiter', () => {
  assert.equal(apply('**内容**', formatCanvasText('**内容**', 2, 4, 'italic')), '***内容***');
});
test('heading replacement and paragraph removal preserve content', () => {
  const value = '# 标题\n正文';
  assert.equal(apply(value, formatCanvasText(value, 2, 4, 'h2')), '## 标题\n正文');
  assert.equal(apply(value, formatCanvasText(value, 2, 4, 'paragraph')), '标题\n正文');
});
test('multiline selection ending at a newline does not format the next line', () => {
  const value = '甲\n乙\n丙';
  assert.equal(apply(value, formatCanvasText(value, 0, 4, 'bullet')), '- 甲\n- 乙\n丙');
});
test('blank first line and reverse selections remain within bounds', () => {
  assert.equal(apply('\n正文', formatCanvasText('\n正文', 0, 0, 'h1')), '# \n正文');
  assert.equal(apply('甲乙丙', formatCanvasText('甲乙丙', 3, 1, 'strike')), '甲~~乙丙~~');
});
test('list toggles and conversion preserve text', () => {
  assert.equal(apply('- 甲\n- 乙', formatCanvasText('- 甲\n- 乙', 0, 9, 'bullet')), '甲\n乙');
  assert.equal(apply('- 甲\n- 乙', formatCanvasText('- 甲\n- 乙', 0, 9, 'number')), '1. 甲\n2. 乙');
});
test('outline ignores headings in fenced code and records exact source positions', () => {
  const value = '# 总览\n```md\n# 代码\n```\n## 人物\n~~~\n# 不显示\n~~~\n### 场景';
  const result = canvasTextOutline(value);
  assert.deepEqual(result.map(x => x.text), ['总览', '人物', '场景']);
  result.forEach(x => assert.equal(value[x.from], '#'));
});
test('script template is explicit, editable Markdown with all core chapters', () => {
  const template = canvasScriptTemplate();
  assert.deepEqual(canvasTextOutline(template).filter(x => x.level === 1).map(x => x.text), ['故事大纲', '人物小传', '场景设计']);
  assert.match(canvasScriptTemplate(true), /# Characters/);
});
test('component avoids HTML injection and initializes editor only for active nodes', () => {
  const source = fs.readFileSync(path.join(__dirname, 'CanvasTextDocument.tsx'), 'utf8');
  assert.ok(!source.includes('dangerouslySetInnerHTML')); assert.match(source, /if \(!active \|\| !host.current\) return/);
  assert.match(source, /savedState.current = editor.state/); assert.match(source, /editor.destroy\(\)/);
  assert.match(source, /liveMarkdownPreview/);
  assert.match(source, /const composing = \(\) => !!view\.current\?\.compositionStarted/);
  assert.match(source, /const apply[\s\S]*?if \(!editor \|\| composing\(\)\) return/);
});
