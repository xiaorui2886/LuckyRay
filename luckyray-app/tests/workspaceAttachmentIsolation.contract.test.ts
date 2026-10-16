import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { attachmentPreviewError, childAttachmentMedia } from '../src/workspace/attachmentMedia.ts';
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('child attachment conversion uses only an opaque token and explicit bounded protocol', () => {
  const token = 'a'.repeat(64);
  const calls: string[][] = [];
  const media = childAttachmentMedia({status: 'resolved', token, version: 'digest', mediaKind: 'video', expiresInMs: 600000}, (...args) => {calls.push(args); return 'opaque-media';});
  assert.deepEqual(media, {source: 'opaque-media', kind: 'video'});
  assert.deepEqual(calls, [[token, 'workspace-attachment']]);
  for (const invalid of ['/etc/passwd', 'C:\\secret.png', '../image.png', 'a?label=main', 'a'.repeat(63), 'A'.repeat(64), `${token}?viewId=other`]) {
    assert.throws(() => childAttachmentMedia({status: 'resolved', token: invalid, version: '', mediaKind: 'image', expiresInMs: 1}, () => 'never'), /invalid-capability/);
  }
});

test('unpersisted-reference rejection is surfaced rather than silently using a file URL', () => {
  assert.match(attachmentPreviewError('workspace-attachment-save-reference-first'), /先保存/);
  assert.doesNotMatch(attachmentPreviewError('C:\\private\\file.png'), /private|file.png/);
  assert.match(attachmentPreviewError('workspace-attachment-main-grant-required'), /主窗口/);
});

test('the dedicated child HTML enforces its policy before any script or image', async () => {
  const html = await read('workspace-child.html');
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(policy);
  assert.ok(html.indexOf('http-equiv="Content-Security-Policy"') < html.indexOf('<script'));
  const directives = new Map(policy.split(';').map(value => value.trim().split(/\s+/)).filter(parts => parts[0]).map(([key, ...values]) => [key, values]));
  for (const key of ['default-src', 'base-uri', 'form-action', 'frame-src', 'object-src', 'child-src', 'worker-src']) assert.deepEqual(directives.get(key), ["'none'"]);
  for (const key of ['img-src', 'media-src', 'connect-src']) {
    assert.ok(directives.get(key)?.includes('workspace-attachment:'));
    for (const source of directives.get(key) || []) assert.doesNotMatch(source, /^(asset:|https?:\/\/asset\.localhost|\*|https?:)$/);
  }
  assert.doesNotMatch(html, /on_web_resource_request/);
  const main = JSON.parse(await read('src-tauri/tauri.conf.json'));
  assert.equal(main.app.security.csp, null, 'Main policy remains unchanged');
});

test('native reads use trusted caller identity, live exact-view scope and saved reference checks', async () => {
  const token = await read('src-tauri/src/workspace_attachments.rs');
  const readScope = await read('src-tauri/src/knowledge/workspace_attachment_reads.rs');
  assert.match(token, /grant\.label == caller/);
  assert.match(token, /registry\.attachment_scope\(caller, &grant\.view\.id\)/);
  assert.match(token, /view != grant\.view/);
  assert.match(token, /Sha256::digest\(&bytes\)\) != grant\.digest/);
  assert.match(token, /expires > now/);
  assert.match(token, /MAX_ATTACHMENT_BYTES: usize = 64 \* 1024 \* 1024/);
  assert.match(readScope, /attachment_links\(&content\)\.iter\(\)\.any\(\|link\| link\.destination == destination && link\.syntax == syntax\)/);
  assert.match(readScope, /sha256_hex\(&note_bytes\) != revision/);
  assert.match(readScope, /read_scoped_attachment_bytes\(&vault\.root, &relative\)/);
  assert.match(readScope, /assert_expected_target_unlocked/);
  assert.match(readScope, /relative != allowed_identity/);
  assert.match(token, /expected_reference\(caller, &view, destination, wiki\)/);
  assert.match(token, /if caller == "main"[\s\S]*workspace_attachment_references/);
  assert.doesNotMatch(readScope.split('#[cfg(test)]')[0], /approved\.iter|activate_ui_source|register_current_vault\(/);
});

test('native navigation guard pins the CSP entry, origin, hash and absence of query', async () => {
  const native = await read('src-tauri/src/workspace_attachments.rs');
  const guard = native.slice(native.indexOf('pub(crate) fn child_navigation_allowed'), native.indexOf('#[derive(Clone)]'));
  assert.match(guard, /url\.path\(\) != "\/workspace-child\.html"/);
  assert.match(guard, /url\.fragment\(\) != Some\("workspace"\)/);
  assert.match(guard, /url\.query\(\)\.is_some\(\)/);
  assert.match(guard, /url\.origin\(\) == dev_url\.origin\(\)/);
  assert.match(guard, /\("tauri", Some\("localhost"\)\)/);
  assert.doesNotMatch(guard, /return true/);
});

test('production wiring emits the child entry, pins navigation and uses trusted scheme context', async () => {
  const native = await read('src-tauri/src/lib.rs');
  const windows = await read('src-tauri/src/workspace_windows.rs');
  const vite = await read('vite.config.ts');
  assert.match(vite, /workspaceChild:\s*"workspace-child\.html"/);
  assert.match(native, /register_asynchronous_uri_scheme_protocol\("workspace-attachment", \|context, request, responder\|[\s\S]*?context\.webview_label\(\)[\s\S]*?workspace_attachments::serve\(&app, &label, request\)/);
  assert.match(windows, /workspace_attachments::CHILD_ENTRY/);
  assert.match(windows, /workspace_attachments::child_navigation_allowed\(url, dev_url\.as_ref\(\)\)/);
  assert.match(windows, /\.on_new_window\(\|_, _\| tauri::webview::NewWindowResponse::Deny\)/);
  assert.match(windows, /\.on_download\(\|_, _\| false\)/);
  const resolution = windows.slice(windows.indexOf('WindowRequest::ResolveAttachment {'), windows.indexOf('WindowRequest::Dirty {'));
  assert.match(resolution, /caller\.label\(\) != "main"[\s\S]*?workspace_attachments::issue[\s\S]*?return serde_json::to_value\(result\)/);
  assert.match(resolution, /resolve_vault_attachment/);
});

test('child writes and recovery cannot widen the original Main-granted attachment baseline', async () => {
  const windows = await read('src-tauri/src/workspace_windows.rs');
  const attachments = await read('src-tauri/src/workspace_attachments.rs');
  const recovery = await read('src-tauri/src/workspace_recovery.rs');
  const write = windows.slice(windows.indexOf('WindowRequest::WriteNote {'), windows.indexOf('WindowRequest::Bind {'));
  assert.doesNotMatch(write, /outgoing_baseline|register_baseline|workspace_attachment_references/);
  const restore = windows.slice(windows.indexOf('WindowRequest::RestoreWindow {'), windows.indexOf('WindowRequest::BeginDrag {'));
  assert.match(restore, /entry\.attachments[\s\S]*register_baseline/);
  assert.doesNotMatch(restore, /outgoing_baseline|workspace_attachment_references/);
  assert.match(attachments, /if let Some\(baseline\) = self\.saved_baseline\(caller, view\)\? \{ return Ok\(baseline\); \}/);
  assert.match(attachments, /Legacy recovery[\s\S]*references: vec!\[\]/);
  assert.match(windows, /source_baseline\.for_view\(&view\)/);
  assert.match(recovery, /#\[serde\(default\)\] pub attachments:Option/);
  assert.match(recovery, /baseline\.valid_for\(view\)/);
});

test('native fixture has the real serving and adversarial probes, with identical child CSP', async () => {
  const native = await read('src-tauri/src/workspace_fixture.rs');
  const fixture = await read('tests/fixtures/workspace-native.tsx');
  const child = await read('workspace-child.html');
  const fixtureChild = await read('tests/fixtures/workspace-native-child.html');
  assert.equal(child.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1], fixtureChild.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]);
  assert.match(native, /register_asynchronous_uri_scheme_protocol\("workspace-attachment"[\s\S]*workspace_attachments::serve\(&app, &label, request\)/);
  assert.match(fixture, /Range:'bytes=0-3'/);
  for (const probe of ['attachmentCrossWindowDenied', 'attachmentForgedScopeDenied', 'attachmentSelfExpansionDenied', 'attachmentStaleTokenDenied', 'attachmentRecoveryBaselinePreserved', 'childAssetCspBlocked', 'childNavigationPinned', 'childPopupDenied']) {
    assert.ok(fixture.includes(probe), probe);
    assert.ok(native.includes(`"${probe}"`), `required native report: ${probe}`);
  }
  assert.match(fixture, /securitypolicyviolation/);
  assert.match(fixture, /location\.assign/);
  assert.match(fixture, /window\.open/);
});
