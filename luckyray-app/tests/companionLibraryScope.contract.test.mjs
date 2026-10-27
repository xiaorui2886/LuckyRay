import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const gateway = read('src-tauri/src/companion_gateway.rs');
const scopes = read('src-tauri/src/companion_gateway/scopes.rs');
const content = read('src-tauri/src/companion_gateway/content.rs');
const services = read('src-tauri/src/companion_gateway/services.rs');

test('saved library wire is additive and unsupported operations remain unsupported', () => {
  const protocol = JSON.parse(read('protocol/companion-v1/services-v1/operations.json'));
  assert.equal(protocol.scopeSelectionVersion, 1);
  assert.equal(protocol.operations.find(op => op.id === 'libraries.list').path, '/v1/services/libraries');
  assert.equal(protocol.operations.find(op => op.id === 'materials.restore').path, null);
  assert.equal(protocol.operations.some(op => op.id.startsWith('runs.')), false);
  assert.match(scopes, /x-luckyray-material-library/);
  assert.match(scopes, /x-luckyray-knowledge-vault/);
  assert.match(scopes, /SCOPE_MISMATCH/);
});

test('request selection shares authority and never changes desktop selection', () => {
  for (const name of ['transition', 'pending_controls', 'generation', 'connections', 'content_state']) {
    assert.match(gateway, new RegExp(`${name}: Arc<`));
  }
  assert.match(scopes, /let mut scoped = self\.clone\(\)/);
  assert.match(scopes, /for_saved_scope\(id\)/);
  assert.doesNotMatch(scopes, /\.select_library\(|\.register_current_vault\(/);
  assert.match(content, /gateway\.scope_for_request\(request\)/);
  assert.match(services, /gateway\.scope_for_request\(request\)/);
});

test('material raw mutations and favorites use existing scoped transaction context', () => {
  const mutations = services.slice(services.indexOf('fn material_patch('), services.indexOf('fn catalog('));
  assert.equal((mutations.match(/companion_open_write\(\)/g) || []).length, 2);
  assert.match(mutations, /op_id, &target_key, &hash/);
  assert.match(read('src-tauri/src/companion_gateway/content/materials.rs'), /catalog\.companion_open_write\(\)/);
  assert.match(content, /material_catalog\(\)\.companion_open_read\(\)/);
});

test('old devices retain only legacy default mode and private catalog filters apply', () => {
  assert.match(scopes, /scopeSelectionVersion":0,"mode":"legacyDefaultOnly"/);
  assert.match(scopes, /if !services::granted\(&scope,&device.device_id,"content.read","catalog",""\)\? \{ continue; \}/);
  assert.match(scopes, /if !services::granted\(self,&device.device_id,"content.read","vault",&vault.vault_key\)\? \{ continue; \}/);
  assert.match(content, /trust_policy::has_policy/);
  assert.match(content, /let _chunk_guard = gateway\.try_transition/);
  assert.match(content, /gateway\.validate_request_scope\(\)\?/);
});

test('search cursors, relation cursors and ingestion bind the original material scope', () => {
  const search = read('src-tauri/src/companion_gateway/services/search.rs');
  const knowledge = read('src-tauri/src/companion_gateway/services/knowledge.rs');
  const ingest = read('src-tauri/src/companion_gateway/services/ingest.rs');
  assert.match(search, /query_scope\.push_str.*materials:/);
  assert.match(knowledge, /knowledge-material-references.*materials:/);
  assert.match(ingest, /manifest\["target"\]\.get\("libraryId"\)\.and_then\(Value::as_str\) != gateway\.material_scope_id\(\)/);
  assert.match(ingest, /manifest\["target"\]\["libraryId"\] = json!\(scope\)/);
});
