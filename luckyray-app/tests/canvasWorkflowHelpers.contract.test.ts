import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendPromptStarter, preparePromptStarter, matchesGenerationHistory, PROMPT_STARTERS } from '../src/core/canvas/workflowHelpers.ts';
const entry={prompt:'咖啡 产品 CAFE\u0301',model:'Agnes-image',outputText:'Bright studio'};
test('history query is local NFC/case insensitive and AND across words',()=>{
 assert.equal(matchesGenerationHistory(entry,'咖啡 AGNES café'),true);
 assert.equal(matchesGenerationHistory(entry,'bright 缺失'),false);
 assert.equal(matchesGenerationHistory(entry,' \n '),true);
});
test('history never interprets regex or searches unknown fields',()=>{
 assert.equal(matchesGenerationHistory(entry,'.*'),false);
 assert.equal(matchesGenerationHistory({...entry,apiKey:'NEVER',errorDetail:'NEVER',outputMediaUrl:'NEVER'} as typeof entry,'NEVER'),false);
});
test('starter preserves complete existing prompt and is idempotent',()=>{
 const original='用户自己的描述\n和精确要求。';
 const next=appendPromptStarter(original,'product','image');
 assert.ok(next.startsWith(original+'\n\n'));assert.ok(next.includes('柔和棚拍光'));
 assert.equal(appendPromptStarter(next,'product','image'),next);
});
test('wrong-kind and unknown starter cannot modify the draft',()=>{
 assert.equal(appendPromptStarter('original','push','image'),'original');
 assert.equal(appendPromptStarter('original','unknown','video'),'original');
});
test('English variants stay English; blank input has no leading separator',()=>{
 const result=appendPromptStarter('','steady','video',true);
 assert.ok(result.startsWith('Use a steady'));assert.equal(result.includes('\n\n'),false);
});
test('over-budget insertion never truncates the user draft',()=>{
 const original='中'.repeat(22000);assert.equal(appendPromptStarter(original,'product','image'),original);
});
test('all stable IDs are unique and both generation kinds have choices',()=>{
 assert.equal(new Set(PROMPT_STARTERS.map(x=>x.id)).size,PROMPT_STARTERS.length);
 assert.ok(PROMPT_STARTERS.some(x=>x.kind==='image'));assert.ok(PROMPT_STARTERS.some(x=>x.kind==='video'));
});
test('legacy starter stays inert and production composer no longer exposes it',()=>{
 const component=readFileSync(new URL('../src/features/canvas/PromptStarterSelect.tsx',import.meta.url),'utf8');
 assert.match(component,/onInsert\(next\)/);assert.doesNotMatch(component,/invoke\(|fetch\(|onSubmit|submitGeneration|apiKey|localStorage/);
 const app=readFileSync(new URL('../src/CanvasSpike.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(app,/<PromptStarterSelect/); // User removed this UI; generation and history remain independent.
 assert.match(app,/matchesGenerationHistory\(entry, generationHistoryQuery\)/);
});

test('insertion explains duplicate and byte-limit no-ops without changing the draft',()=>{
 const existing=appendPromptStarter('我的正文','product','image');
 assert.deepEqual(preparePromptStarter(existing,'product','image'),{prompt:existing,status:'already-present'});
 const large='中'.repeat(22000);
 assert.deepEqual(preparePromptStarter(large,'product','image'),{prompt:large,status:'too-long'});
 assert.deepEqual(preparePromptStarter('原文','unknown','image'),{prompt:'原文',status:'unavailable'});
 assert.equal(preparePromptStarter('原文','steady','video').status,'inserted');
});
