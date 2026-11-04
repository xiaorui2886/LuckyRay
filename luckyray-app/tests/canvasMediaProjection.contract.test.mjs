// Source architecture checks only. Native behavioral coverage is in
// src-tauri/src/companion_gateway/canvas_media_tests.rs and requires cargo test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const moduleUrl = new URL('../src-tauri/src/companion_gateway/canvas_media.rs', import.meta.url);
const source = readFileSync(moduleUrl, 'utf8');
const nativeTests = readFileSync(new URL('../src-tauri/src/companion_gateway/canvas_media_tests.rs', import.meta.url), 'utf8');

test('display projection is explicitly marked and is not a canonical save DTO', () => {
  assert.match(source, /display\.insert\("remoteProjectionVersion"\.into\(\), json!\(1\)\)/);
  assert.match(source, /if display != &self\.display \{ return Err\(ProjectionError::ReadOnly\); \}/);
  assert.match(source, /Ok\(self\.canonical\.clone\(\)\)/);
  assert.match(source, /json!\(normalized\.revision\)/);
  assert.match(source, /display\.insert\("remoteUnavailableMediaCount"\.into\(\), json!\(projector\.unavailable\)\)/);
  assert.match(source, /json!\(normalized\.content_digest\)/);
  assert.doesNotMatch(source, /derive\([^\n]*(?:Serialize|Deserialize)/);
});
test('catalog proof is narrow and scope is frozen without a global path search', () => {
  assert.match(source, /referenced_asset_ids\(canonical\)/);
  assert.match(source, /catalog\.library_scope_key\(\)/);
  assert.match(source, /catalog\.for_library\(&scope\)/);
  assert.match(source, /catalog\.get_ordinary_export_asset\(&id\)/);
  assert.match(source, /catalog\.companion_resource\(&id, false\)/);
  assert.doesNotMatch(source, /\.list_assets\(|\.list_assets_scoped\(|\.for_attachment_projection\(/);
  assert.doesNotMatch(source, /File::open\(|std::fs::read\(|reqwest::|SafeHttpClient|Url::parse/);
});
test('all real schema media families are explicitly projected', () => {
  for (const field of ['refMediaUrl','refThumbnailUrl','resultMediaUrl','resultThumbnailUrl','resultMediaItems',
    'sourceGenerationMediaUrl','generationReferences','generationTask','materialGenerationProvenance',
    'outputMediaUrl','outputThumbnailUrl','outputMediaItems','referenceMediaUrl','storyboardShot','chosenResult']) {
    assert.ok(source.includes(`"${field}"`), field);
  }
  assert.match(source, /out\.insert\("references"\.into\(\), self\.references/);
  assert.match(source, /generation_history/);
  assert.match(source, /root_field\(root, "canvasId", "canvas_id"\)/);
});
test('opaque IDs are session-bound HMACs and media accepts only a fixed opaque token', () => {
  assert.match(source, /const MEDIA_PREFIX: &str = "\/canvas\/media\/"/);
  assert.match(source, /Hmac::<Sha256>::new_from_slice/);
  assert.match(source, /if !self\.session\.same\(session\)/);
  assert.match(source, /if !hex_id\(id\)/);
  assert.match(source, /self\.sources\.get\(id\)/);
  assert.match(source, /current\.revision != source\.revision/);
});
test('unknown nested objects are never recursively copied into display JSON', () => {
  const projector = source.slice(source.indexOf("impl Projector<'_>"), source.indexOf('const EDGE_ROLES'));
  assert.doesNotMatch(projector, /(?:value|data|input|item|chosen)\.clone\(\)|\.extend\(.*(?:data|input)|\.iter\(\).*collect::<Object>/);
  assert.match(source, /REMOTE_DETAIL_UNAVAILABLE/);
  assert.match(source, /MAX_DOCUMENT_BYTES: usize = 8 \* 1024 \* 1024/);
  assert.match(source, /depth > MAX_DEPTH/);
});
test('native tests exercise the actual catalog, preservation and hostile inputs', () => {
  assert.match(nativeTests, /MaterialCatalog::new_for_test_at/);
  assert.match(nativeTests, /catalog\.import_bytes/);
  assert.match(nativeTests, /projection\.open_media/);
  assert.match(nativeTests, /projection\.restore_unchanged/);
  assert.match(nativeTests, /\/etc\/passwd/);
  assert.match(nativeTests, /session\('b'\)/);
  assert.match(nativeTests, /DO_NOT_LEAK/);
});

test('groups and storyboard URL-derived keys use their display identities', () => {
  assert.match(source, /Some\("group"\) \{ "group" \} else \{ "spike" \}/);
  assert.match(source, /json!\(\[node_id, kind, url\]\)\.to_string\(\)/);
  assert.match(source, /safe\.entry\("label"\)/);
});

test('required timestamps use bounded RFC3339 validation without widening opaque identities', () => {
  assert.match(source, /const MAX_TIMESTAMP_BYTES: usize = 64/);
  assert.match(source, /chrono::DateTime::parse_from_rfc3339\(value\)\.is_ok\(\)/);
  assert.match(source, /filter\(\|value\| rfc3339_timestamp\(value\)\)\.ok_or\(ProjectionError::InvalidDocument\)/);
  assert.doesNotMatch(source, /copy_ids\([^\n]*(?:createdAt|updatedAt|selectedAt|refUpdatedAt)/);
  const identity = source.slice(source.indexOf('fn identity('), source.indexOf('fn hex_id('));
  assert.doesNotMatch(identity, /b'\+'/);
  assert.match(nativeTests, /FixedOffset::east_opt\(offset\)/);
  assert.match(nativeTests, /\[8 \* 60 \* 60, 0, -7 \* 60 \* 60\]/);
});
test('projection rejects missing required source values and gates the complete display contract', () => {
  assert.match(source, /validate_display_contract\(&display\)\?/);
  assert.match(source, /required_array\(root\.get\("nodes"\), MAX_NODES\)/);
  assert.match(source, /required_array\(root\.get\("edges"\), MAX_EDGES\)/);
  assert.match(source, /normalized\.revision > MAX_JS_SAFE_INTEGER/);
  assert.match(source, /zoom > 0\.0/);
  assert.match(nativeTests, /missing_or_invalid_required_source_values_fail_instead_of_emitting_partial_details/);
});
