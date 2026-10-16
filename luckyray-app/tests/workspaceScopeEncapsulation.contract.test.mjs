import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';

const sourceRoot=new URL('../src-tauri/src/',import.meta.url);
const knowledge=readFileSync(new URL('knowledge/mod.rs',sourceRoot),'utf8');
const windows=readFileSync(new URL('workspace_windows.rs',sourceRoot),'utf8');

test('captured Knowledge registration stays private with a borrowed read-only root accessor',()=>{
 const fields=knowledge.match(/pub\(crate\) struct WorkspaceScopeRecord\s*\{([^}]+)\}/)?.[1];
 assert.ok(fields);assert.doesNotMatch(fields,/\bpub\b/);
 const accessor=knowledge.match(/impl WorkspaceScopeRecord\s*\{[\s\S]*?pub\(crate\) fn root_path\(&self\) -> &Path\s*\{([^}]+)\}/)?.[1];
 assert.ok(accessor);assert.match(accessor,/Path::new\(&self\.registration\.root_path\)/);
 assert.doesNotMatch(accessor,/&mut|clone\(|current_vault|serde_json|invoke/);
});

test('native retirement paths and their Rust regression use the accessor, including cfg(test)',()=>{
 assert.match(windows,/guard_main_path_retirement\(record\.root_path\(\),&relative,false\)/);
 assert.match(windows,/record\.root_path\(\)\.canonicalize\(\)/);
 assert.match(windows,/let root=record\.root_path\(\);\s*assert_eq!\(root,temp\.path\(\)\.join\("vault"\)\.canonicalize\(\)\.unwrap\(\)\.as_path\(\)\)/);
 for(const name of readdirSync(sourceRoot).filter(name=>name.startsWith('workspace_')&&name.endsWith('.rs'))){
  const source=readFileSync(new URL(name,sourceRoot),'utf8');
  assert.doesNotMatch(source,/\brecord\.registration\b/,name+' must not bypass Knowledge field privacy');
 }
});
