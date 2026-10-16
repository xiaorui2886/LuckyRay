import test from 'node:test';import assert from 'node:assert/strict';
import {applySourceListEnter,applySourceListBackspace,applySourceListIndent,detectAutocompleteTrigger,findSourceEditorTokenAt,toggleMarkdownTaskAtBodyLine} from '../src/features/notes/sourceNoteEditor';
test('shared source list editing keeps continuation, task exit and renumbering',()=>{
 assert.deepEqual(applySourceListEnter('- one',5,5),{value:'- one\n- ',selectionStart:8,selectionEnd:8});
 assert.deepEqual(applySourceListEnter('- [ ] ',6,6),{value:'',selectionStart:0,selectionEnd:0});
 assert.equal(applySourceListEnter('1. one\n2. two',6,6)?.value,'1. one\n2. \n3. two');
 assert.equal(applySourceListBackspace('- one',2,2)?.value,'one');
 assert.equal(applySourceListIndent('- one\n- two',0,11,'indent')?.value,'  - one\n  - two');
});
test('shared source task toggles count body lines after frontmatter',()=>{
 assert.equal(toggleMarkdownTaskAtBodyLine('---\ntags: [x]\n---\n- [ ] task',0),'---\ntags: [x]\n---\n- [x] task');
 assert.equal(toggleMarkdownTaskAtBodyLine('# Heading',0),'# Heading');
});
test('shared source completion excludes code and keeps note/tag/anchor syntax',()=>{
 assert.equal(detectAutocompleteTrigger('`[[peer',7),null);
 assert.equal(detectAutocompleteTrigger('[[peer',6)?.kind,'note');
 assert.equal(detectAutocompleteTrigger('![[media',8)?.kind,'asset');
 assert.equal(detectAutocompleteTrigger('[[#head',7)?.kind,'anchor');
 assert.equal(detectAutocompleteTrigger('#tag',4)?.kind,'tag');
});
test('source same-note tokens retain actual document identity independent of view id',()=>{
 const token=findSourceEditorTokenAt('[[#Heading]]',5,{currentNoteId:'real-vault:Note.md',notes:[],assets:[],tags:[],noteEmbeds:[],noteLinks:[]});
 assert.equal(token?.noteId,'real-vault:Note.md');assert.deepEqual(token?.openOptions,{headingPath:'Heading',blockId:null});
});
