import test from 'node:test';
import assert from 'node:assert/strict';
import {submitNoteTagSelection} from '../src/features/notes/noteTagSelection';
import type {DocumentState} from '../src/workspace/documentSession';
import type {NoteParentAction} from '../src/features/notes/NoteRuntime';
const authority={vaultId:'vault',sourceId:'source-one',documentId:'note'},viewId='view';
const baseline={authority,viewId,revision:'r1',content:'---\ntags: [a]\n---\nText'};
const state:DocumentState={content:baseline.content,revision:'r1',dirty:false,status:'ready',error:null,remote:null};
test('tag set reviewed before another window adds b cannot overwrite the newer revision',async()=>{
 let invoked=0;await assert.rejects(()=>submitNoteTagSelection(()=>({...state,revision:'r2',content:'---\ntags: [a, b]\n---\nText'}),baseline,['a'],async()=>{invoked++;return {kind:'acknowledged'};},{authority,viewId}),{code:'stale-result'});assert.equal(invoked,0);
});
test('dirty local input, source regrant, and another view cannot reuse an old tag review',async()=>{
 for(const [current,identity] of [[{...state,dirty:true},{authority,viewId}],[state,{authority:{...authority,sourceId:'source-two'},viewId}],[state,{authority,viewId:'other'}]] as const){let invoked=0;await assert.rejects(()=>submitNoteTagSelection(()=>current,baseline,[],async()=>{invoked++;return {kind:'acknowledged'};},identity),{code:'stale-result'});assert.equal(invoked,0);}
});
test('unchanged reviewed baseline permits explicit full tag replacement, including user-cleared tags',async()=>{
 let action:NoteParentAction|undefined;await submitNoteTagSelection(()=>state,baseline,[],async value=>{action=value;return {kind:'acknowledged'};},{authority,viewId});assert.deepEqual(action,{kind:'apply-document-tags',mode:'replace',names:[]});
});
