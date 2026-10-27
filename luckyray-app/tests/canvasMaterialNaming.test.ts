import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasMaterialDefaultNames, validateCanvasMaterialNames } from '../src/core/canvas/materialNaming.ts';
import type { CanvasGenerationLibraryCandidate } from '../src/core/canvas/generationHistory.ts';
const item = (prompt = '', kind: 'image' | 'video' = 'image'): CanvasGenerationLibraryCandidate => ({historyId:'h',taskId:'t',kind,mediaUrl:'/a.png',prompt,model:'m',createdAt:''});
test('names use first prompt line and deterministic batch suffixes without altering candidates', () => {
 const candidates = [item('  雨夜  街道\nmore context'), item('  雨夜  街道')], before=structuredClone(candidates);
 assert.deepEqual(canvasMaterialDefaultNames(candidates), ['雨夜 街道 01', '雨夜 街道 02']);
 assert.deepEqual(candidates,before);
 assert.deepEqual(canvasMaterialDefaultNames([item('', 'video')],true),['Generated video']);
 assert.deepEqual(canvasMaterialDefaultNames([item()]),['生成图片']);
 assert.ok(canvasMaterialDefaultNames([item('a'.repeat(500))])[0].length <= 120);
});
test('validation rejects blank, mismatched, overlong and control-character names', () => {
 assert.equal(validateCanvasMaterialNames([' 自定义名称 '],1),null);
 assert.equal(validateCanvasMaterialNames([' '],1),'empty');
 assert.equal(validateCanvasMaterialNames(['name'],2),'count');
 assert.equal(validateCanvasMaterialNames([],0),'count');
 assert.equal(validateCanvasMaterialNames(['a'.repeat(121)],1),'long');
 assert.equal(validateCanvasMaterialNames(['a\nb'],1),'control');
 assert.equal(validateCanvasMaterialNames(['a/b: scene'],1),null);
});
