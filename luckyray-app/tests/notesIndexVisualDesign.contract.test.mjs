import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const css = read('src/features/notes/notes.css');
const attachments = read('src/features/notes/vaultAttachments.css');
const page = read('src/features/notes/NotesPage.tsx');
const rule = (selector, source = css) => {
  const start = source.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, selector);
  return source.slice(start, source.indexOf('}', start) + 1);
};

test('V2 index chrome uses the current theme, and does not define a new palette', () => {
  for (const selector of ['.backlinks-inner', '.backlinks-tabs', '.backlinks-tab.active', '.notes-vault-entry', '.notes-vault-settings', '.notes-vault-summary-card', '.notes-vault-section', '.notes-index-tools button.notes-index-new-note']) {
    const value = rule(selector);
    assert.match(value, /var\(--(?:theme-|accent)/);
    assert.doesNotMatch(value, /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
  }
  assert.doesNotMatch(attachments, /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i);
  assert.match(rule('.backlinks-inner'), /box-shadow: var\(--theme-shadow-sm\)/);
  assert.match(rule('.backlinks-inner'), /width: calc\(var\(--notes-index-width\) - 16px\)/);
});

test('root and nested documents retain compact no-icon rows, tree lines and date text', () => {
  assert.match(rule('.notes-index-folder-section .folder-document-icon'), /display: none/);
  assert.match(rule('.notes-index-folder-section .folder-document-item'), /min-height: 34px/);
  assert.match(rule('.notes-index-folder-section .folder-document-item'), /background: transparent/);
  assert.match(rule('.notes-index-folder-section .folder-documents'), /border-left: 1px solid/);
  assert.match(rule('.notes-index-folder-section .folder-document-subtitle'), /font-size: 9px/);
  const tree = read('src/features/folders/FolderTree.tsx');
  assert.match(tree, /folder-documents folder-root-documents/);
  assert.match(tree, /folder-document-subtitle/);
  assert.match(tree, /onPointerDown|onPointerDragStart/);
  assert.match(page, /onSelectDocument=\{notesIndexSelectDocument\}/);
});

test('four tabs still fit the resizable index; new-note is an existing action with a visible label', () => {
  assert.match(page, /\["backlinks", "outline", "notes", "assets"\]/);
  assert.match(rule('.backlinks-tab'), /flex: 1 1 0/);
  assert.doesNotMatch(rule('.backlinks-tabs'), /overflow-x: auto/);
  assert.match(page, /className="notes-index-new-note" onClick=\{\(\) => openCreateDocumentDialog\(\)\}/);
  assert.match(rule('.notes-index-new-note .notes-index-tool-label'), /position: static/);
});

test('settings and confirmation dialogs reserve fixed chrome and scroll only bounded content', () => {
  assert.match(rule('.notes-vault-dialog'), /grid-template-rows: auto minmax\(0, 1fr\) auto/);
  assert.match(rule('.notes-vault-dialog-body'), /min-height: 0/);
  assert.match(rule('.notes-vault-page'), /overflow-y: auto/);
  assert.match(page, /className="editorial-dialog-footer notes-vault-dialog-footer">\s*<button type="button" onClick=\{onClose\}/);
  assert.match(rule('.modal-box-react.small.vault-link-update-dialog', attachments), /max-height: min\(560px, calc\(100dvh - 48px\)\)/);
  assert.match(attachments, /@media \(max-width: 620px\)/);
});

test('modal isolation, immediate preferences, import readiness and running restrictions remain in production components', () => {
  assert.match(page, /useApplicationModalSurface<HTMLDivElement>\(true, onClose\)/);
  const link = read('src/features/notes/VaultLinkUpdateDialog.tsx');
  assert.match(link, /closeOnBackdrop: !flow.running, closeOnEscape: !flow.running/);
  assert.match(link, /disabled=\{flow.running \|\| !plan.files.length\}/);
  assert.match(link, /onKeyDown=\{surface.onSurfaceKeyDown\}/);
  const importing = read('src/features/notes/AttachmentImportDialog.tsx');
  assert.match(importing, /disabled=\{!ready\}/);
  assert.match(importing, /onImport\(true\)/);
  assert.match(importing, /onImport\(false\)/);
  const settings = read('src/features/notes/VaultAttachmentsPanel.tsx');
  assert.match(settings, /onChange=\{event=>void changeLinkPolicy/);
  assert.match(settings, /workflow.confirm\(hasUnsavedChanges\)/);
  assert.doesNotMatch(page, /查看链接更新弹窗（演示）|光影与空间的记录|保存全部/);
});

test('Windows forced-colors keeps a persistent selected-tab indicator', () => {
  assert.match(css, /@media \(forced-colors: active\)\s*\{\s*\.backlinks-inner \.backlinks-tab\.active\s*\{[^}]*outline: 2px solid Highlight;[^}]*outline-offset: -2px;/s);
});
