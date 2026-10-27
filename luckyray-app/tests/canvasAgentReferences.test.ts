import test from 'node:test';
import assert from 'node:assert/strict';
import {appendAgentReferences} from '../src/core/canvas/agent/references.ts';
test('node clicks append in order, deduplicate, and preserve references when clicking blank canvas',()=>{
 const live=new Set(['a','b','c']);
 assert.deepEqual(appendAgentReferences(['a'],['b','b'],live),{ids:['a','b'],overflow:false});
 assert.deepEqual(appendAgentReferences(['a','b'],[],live),{ids:['a','b'],overflow:false});
});
test('deleted nodes excluded, reference limit is explicit, originals not mutated',()=>{
 const current=['a','deleted'];const live=new Set(['a','b','c']);
 assert.deepEqual(appendAgentReferences(current,['b','c'],live,2),{ids:['a','b'],overflow:true});
 assert.deepEqual(current,['a','deleted']);
});
