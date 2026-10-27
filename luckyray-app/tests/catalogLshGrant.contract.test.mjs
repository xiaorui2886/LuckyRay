// Source boundary contract only; does not replace Rust/SQLite runtime tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src-tauri/src/companion_gateway/services.rs',import.meta.url),'utf8');
test('catalog never applies content grants to dedicated LSH operation',()=>{
 const gate=source.match(/if ([^\n]+) && state == "implemented" \{\s*if let Some\(class\)/)?.[1];
 assert.ok(gate, 'locate production generic grant gate');
 const helper=source.match(/fn operation_uses_content_grant\(id: &str, legacy: bool, explicit_policy: bool\) -> bool \{\s*([^\n]+)\s*\}/)?.[1];
 const predicate=helper || gate;
 const evaluate=(id,legacy,explicit_policy)=>Function('id','legacy','explicit_policy',`return ${predicate};`)(id,legacy,explicit_policy);
 for(const legacy of [true,false]) for(const explicit of [true,false]) assert.equal(evaluate('lsh.session',legacy,explicit),false);
 assert.equal(evaluate('materials.detailV1',false,true),true);
 assert.equal(evaluate('knowledge.registeredList',false,false),true);
 assert.equal(evaluate('materials.list',true,false),false);
 assert.equal(evaluate('materials.list',true,true),true);
});
