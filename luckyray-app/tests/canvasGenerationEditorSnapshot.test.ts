import test from 'node:test';
import assert from 'node:assert/strict';
import {captureGenerationEditorSnapshot,normalizeGenerationEditorSnapshot} from '../src/core/canvas/generationEditorSnapshot';
import {createCanvasGenerationTask} from '../src/core/canvas/generationTasks';
import {historyEntryFromTask,normalizeGenerationHistory} from '../src/core/canvas/generationHistory';
import {buildHistoryDraft} from '../src/core/canvas/generationIteration';
import {createCanvasReferencePlan,canvasReferenceSnapshots} from '../src/core/canvas/referencePlan';
import {encodeReferenceMention,encodeFocusReferenceMention,compileMentionedPrompt} from '../src/core/canvas/referenceMentions';
import {compileCanvasGenerationInputs} from '../src/core/canvas/generationInputCompiler';
import {compileCinematographyPrompt,createDefaultCinematographySettings} from '../src/core/canvas/cinematography';
import {compileCreativeRecipePrompt} from '../src/core/canvas/imageCreativeActions';

function fixture(){
 const refs:any[]=[{edgeId:'edge-image',sourceNodeId:'image',role:'reference',reference:{id:'node:image',label:'蓝色产品',kind:'image',mediaUrl:'/fixtures/product.png'}},
 {edgeId:'edge-copy',sourceNodeId:'copy',role:'promptContext',reference:{id:'node:copy',label:'品牌文案',kind:'text',text:'A unique blue product.'}}];
 const plan=createCanvasReferencePlan('image',refs,[]);
 const prompt=`保持 ${encodeReferenceMention('edge-image')}，依据 ${encodeReferenceMention('edge-copy')}；调整 ${encodeFocusReferenceMention('edge-image',{label:'金属表盘',x:.4,y:.3})} 的光照。`;
 const camera={...createDefaultCinematographySettings(),enabled:true,framing:'close-up' as const};
 const recipe={version:1 as const,id:'relight' as const,options:{lighting:'studio' as const}};
 const editor=captureGenerationEditorSnapshot(prompt,plan.map(p=>p.key),camera,recipe)!;
 const mentioned=compileMentionedPrompt(prompt,plan,{kind:'image'});
 const directed=compileCinematographyPrompt(compileCreativeRecipePrompt(mentioned.prompt,recipe,{hasImageReference:true,hasPrompt:true}),camera,'image');
 const compiled=compileCanvasGenerationInputs({kind:'image',prompt:directed,references:canvasReferenceSnapshots(plan),referenceAliases:mentioned.referenceAliases});
 const task=createCanvasGenerationTask({id:'first',sourceNodeId:'node',resultNodeId:'node',createdAt:'2026-10-18',request:{kind:'image',model:'test-model',prompt:compiled.prompt,editor,references:compiled.references,aspect:'16:9',quality:'high',resolution:'2K',count:2}});
 task.status='succeeded';return {editor,task,entry:historyEntryFromTask(task,{mediaUrl:'/result.png',mediaItems:[{url:'/result.png'},{url:'/result2.png'}]})};
}
test('complex editor survives persisted history and recompiles exactly once with inline and focus tokens',()=>{
 const {entry,task}=fixture();
 const persisted=normalizeGenerationHistory(JSON.parse(JSON.stringify([entry])))[0];
 const draft=buildHistoryDraft(persisted,'parameters')!;
 assert.equal(draft.generationPrompt,task.request.editor!.prompt);assert.equal(draft.generationReferences.length,2);
 assert.equal(draft.generationReferences[0].sourceNodeId,undefined);assert.match(draft.generationReferences[0].id,/^history:/);
 const plan=createCanvasReferencePlan('image',[],draft.generationReferences);
 assert.deepEqual(plan.map(p=>p.key),task.request.editor!.referenceKeys);
 const mentioned=compileMentionedPrompt(draft.generationPrompt,plan,{kind:'image'});
 const directed=compileCinematographyPrompt(compileCreativeRecipePrompt(mentioned.prompt,draft.generationCreativeRecipe,{hasImageReference:true,hasPrompt:true}),draft.generationCinematography,'image');
 const compiled=compileCanvasGenerationInputs({kind:'image',prompt:directed,references:canvasReferenceSnapshots(plan),referenceAliases:mentioned.referenceAliases});
 assert.equal(compiled.prompt,task.request.prompt);assert.equal((compiled.prompt.match(/A unique blue product\./g)||[]).length,1);
 assert.equal(draft.generationAspect,'16:9');assert.equal(draft.generationResolution,'2K');assert.equal(draft.generationCount,2);
});
test('snapshot and history clone editor arrays/options, without mutable node aliasing',()=>{
 const {editor,task,entry}=fixture();editor.referenceKeys[0]='changed';editor.creativeRecipe!.options.lighting='neon-night';
 assert.equal(task.request.editor!.referenceKeys[0],'edge-image');assert.equal(entry.request.editor!.creativeRecipe!.options.lighting,'studio');
 task.request.editor!.referenceKeys[0]='changed-again';assert.equal(entry.request.editor!.referenceKeys[0],'edge-image');
});
test('normalizer rejects mismatched or ambiguous mention identity and strips unexpected keys',()=>{
 assert.equal(normalizeGenerationEditorSnapshot({version:1,prompt:'x',referenceKeys:['a','a']}),undefined);
 assert.equal(normalizeGenerationEditorSnapshot({version:1,prompt:'x',referenceKeys:['a']},2),undefined);
 assert.equal(normalizeGenerationEditorSnapshot({version:2,prompt:'x',referenceKeys:[]}),undefined);
 const clean=normalizeGenerationEditorSnapshot({version:1,prompt:'x',referenceKeys:[],apiKey:'not-a-real-key',endpoint:'https://example.test'});
 assert.deepEqual(clean,{version:1,prompt:'x',referenceKeys:[]});
});
test('legacy history retains compiled prompt without duplicating historical text contexts',()=>{
 const {entry}=fixture();delete entry.request.editor;delete entry.request.sourcePrompt;
 const draft=buildHistoryDraft(entry,'parameters')!;assert.equal(draft.generationPrompt,entry.request.prompt);
 assert.equal(draft.generationReferences.length,1);assert.equal(draft.generationCinematography,undefined);assert.equal(draft.generationCreativeRecipe,undefined);
});
