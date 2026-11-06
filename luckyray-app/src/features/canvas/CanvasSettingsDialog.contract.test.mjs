import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Source contracts only. Actual focus, pointer and scoped-dialog behavior must
// additionally be exercised in a supported browser/WebView.
const source = readFileSync(new URL('./CanvasSettingsDialog.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./canvasSettingsDialog.css', import.meta.url), 'utf8');

test('uses the shared canvas scope without unmounting draft children or disabling shell navigation', () => {
  assert.match(source, /<CanvasDialogPortal>/);
  assert.match(source, /hidden=\{!open\}/);
  assert.doesNotMatch(source, /showModal|document\.body\.style|\.inert\s*=/);
  assert.match(source, /\{children\}/);
  assert.doesNotMatch(source, /if\s*\(!open\)\s*return/);
  assert.doesNotMatch(source, /open\s*&&\s*\{?children/);
});
test('names the dialog and restores the connected opener', () => {
  assert.match(source, /aria-labelledby=\{titleId\}/);
  assert.match(source, /id=\{titleId\}/);
  assert.match(source, /openerRef\.current\?\.isConnected/);
  assert.match(source, /openerRef\.current\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /event.key === "Escape"/);
  assert.match(source, /event.nativeEvent.isComposing/);
});
test('consumes the pointer sequence and isolates canvas shortcuts and wheel', () => {
  const pointerDown = source.slice(source.indexOf('onPointerDown='),source.indexOf('onPointerUp='));
  assert.doesNotMatch(pointerDown, /onClose\(\)/);
  assert.match(pointerDown, /backdropPress\.current/);
  assert.match(source, /onPointerCancel=/);
  for(const name of ['onDoubleClick','onWheel','onKeyUp']) {
    assert.match(source, new RegExp(`${name}=\\{event => event\\.stopPropagation\\(\\)\\}`));
  }
});
test('offers three persistent sections with an accessible selected state', () => {
  for(const id of ['generation','connections','appearance']) assert.match(source,new RegExp(`id: "${id}"`));
  assert.match(source, /aria-current=\{section === tab\.id \? "page" : undefined\}/);
});
test('constrains the dialog to its owning canvas and makes only its content scroll', () => {
  assert.match(css, /width: min\(860px, 100%\)/);
  assert.match(css, /height: min\(700px, 100%\)/);
  assert.doesNotMatch(css, /100vw|100dvh|::backdrop/);
  assert.match(css, /\.canvas-settings-dialog-content[^}]*overflow: auto/s);
  assert.match(css, /@container canvas-dialog \(max-width: 700px\)/);
  assert.match(css, /@container canvas-dialog \(max-height: 480px\)/);
  assert.match(css, /\.canvas-settings-dialog \[hidden\] \{ display: none !important/);
});
