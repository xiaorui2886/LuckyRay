import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('storyboard image picker escapes canvas stacking context while ordinary pickers keep the canvas host',()=>{
 const source=readFileSync(path.join(app,'src/CanvasSpike.tsx'),'utf8');
 const assets=source.slice(source.indexOf('{showAssetPicker ? ('),source.indexOf('{showNotePicker ? ('));
 assert.match(assets,/portalHost=\{creativePanel\?\.kind === ['"]storyboard['"] \? undefined : editorBodyRef\.current\}/);
 assert.match(assets,/onPick=\{pickAsset\}/);
 const notes=source.slice(source.indexOf('{showNotePicker ? ('),source.indexOf('{materialDestinationRequest ?'));
 assert.match(notes,/portalHost=\{editorBodyRef\.current\}/);
 const picker=readFileSync(path.join(app,'src/features/canvas/CanvasLibraryPicker.tsx'),'utf8');
 assert.match(picker, /portalHost \|\| document\.body/);
});
