import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
test('playback implementation is restored to the pre-R8 version requested by the user',()=>{
  for(const file of ['src/core/services/graphPlayback.ts']){
  const original=execFileSync('git',['show','6fc8e29:luckyray-app/'+file],{encoding:'utf8'});
  assert.equal(readFileSync(file,'utf8').replaceAll('\r\n','\n'),original.replaceAll('\r\n','\n'));
  }
});
test('label polish preserves original playback activation, timing, camera and cleanup',()=>{
  const path='src/features/graph/GraphPage.tsx';
  const original=execFileSync('git',['show','6fc8e29:luckyray-app/'+path],{encoding:'utf8'});
  const functions=['cancelGraphReveal','advanceGraphReveal','activateGraphRevealNodes','updatePlaybackCamera','togglePlaying'];
  const extract=(source:string)=>{
    const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),found=new Map<string,string>();
    const visit=(node:ts.Node)=>{
      if(ts.isVariableDeclaration(node)&&functions.includes(node.name.getText(ast)))found.set(node.name.getText(ast),node.getText(ast).replaceAll('\r\n','\n'));
      ts.forEachChild(node,visit);
    };visit(ast);assert.equal(found.size,functions.length);return found;
  };
  assert.deepEqual(extract(readFileSync(path,'utf8')),extract(original));
});
