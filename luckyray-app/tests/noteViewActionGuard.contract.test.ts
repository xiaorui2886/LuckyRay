import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNoteViewActionCurrent,type NoteViewActionCapture} from '../src/features/notes/noteViewActionGuard';
import type {NoteParentAction} from '../src/features/notes/NoteRuntime';
const capture:NoteViewActionCapture={epoch:1,mode:'live',selection:{start:3,end:7}};
test('deferred file, clipboard, material and AI insertions reject caret movement without a text change',()=>{
 const actions:NoteParentAction[]=[{kind:'insert-files',files:[],selection:capture.selection},{kind:'insert-clipboard-image',source:{kind:'data-url',value:'data:image/png;base64,AA=='},selection:capture.selection},{kind:'insert-existing-attachment',assetId:'verified-asset',selection:capture.selection},{kind:'write-ai',action:'rewrite',selection:capture.selection}];
 for(const action of actions){assert.doesNotThrow(()=>assertNoteViewActionCurrent(action,capture,{...capture}));assert.throws(()=>assertNoteViewActionCurrent(action,capture,{...capture,selection:{start:8,end:8}}),{code:'stale-result'});}
});
test('view epoch and mode transitions invalidate replies while non-insert actions ignore caret',()=>{
 assert.throws(()=>assertNoteViewActionCurrent({kind:'ask-ai'},capture,{...capture,epoch:2}),{code:'stale-result'});
 assert.throws(()=>assertNoteViewActionCurrent({kind:'ask-ai'},capture,{...capture,mode:'source'}),{code:'stale-result'});
 assert.doesNotThrow(()=>assertNoteViewActionCurrent({kind:'set-favorite',favorite:true},capture,{...capture,selection:{start:0,end:0}}));
});
