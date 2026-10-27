import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
const css=readFileSync('src/canvas-spike-scroll.css','utf8');
test('ratio glyph layout adds no independent colour, background, border or shadow',()=>{
 const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m=>m[1].includes('.canvas-aspect-options'));
 for(const rule of rules){
   if(rule[1].includes(':focus-visible'))continue;
   assert.doesNotMatch(rule[2],/(?:^|;)\s*(?:background(?:-color)?|color|border(?:-color)?|box-shadow)\s*:/);
 }
 assert.match(css,/\.canvas-composer-setting button\.is-selected/);
 assert.match(css,/\.canvas-aspect-glyph[^}]*stroke:currentColor/);
});
test('send glyph has explicit foreground independent from inherited hover colour',()=>{
 assert.match(css,/\.canvas-composer-submit \{[^}]*--canvas-submit-foreground: #1b1b1e;/);
 assert.match(css,/\.canvas-editor-root \.canvas-composer-submit svg path[^}]*stroke: var\(--canvas-submit-foreground\)/);
 assert.match(css,/\.canvas-composer-submit:hover:not\(:disabled\)[^}]*color: #1b1b1e/);
 assert.match(css,/\.canvas-composer-submit \{[^}]*--canvas-submit-foreground: #ffffff;/);
});
test('profile command bar stays sticky and confirmation uses explicit spacing and font',()=>{
 assert.match(css,/\.canvas-media-profile-command-bar[^}]*position:sticky;top:0/);
 assert.match(css,/\.canvas-media-profile-command-bar \.canvas-media-profile-actions[^}]*gap:8px/);
 assert.match(css,/\.canvas-media-profile-delete-confirm p[^}]*font-size:12px[^}]*font-weight:400/);
 assert.match(css,/\.canvas-media-profiles \.canvas-media-profile-actions \.is-danger[^}]*color:#e57384/);
});
test('EasyCLI preset uses per-model automatic routing and no embedded credential',()=>{
 const source=readFileSync('src/core/services/canvasMediaProfiles.ts','utf8');
 const start=source.indexOf('export const CANVAS_MEDIA_PRESETS'),end=source.indexOf('export function projectCanvas',start);
 const code=transformSync(source.slice(start,end).replace('export const','const'),{loader:'ts'}).code;
 const presets=Function(code+';return CANVAS_MEDIA_PRESETS;')();
 assert.equal(presets.easycli.baseUrl,'http://127.0.0.1:8317/v1');assert.equal(presets.easycli.imageProtocol,'easycli-auto');assert.equal(presets.easycli.imageModel,'gemini-3.1-flash-image');assert.equal(presets.easycli.videoProtocol,'disabled');assert.equal(presets.easycli.apiKey,undefined);
});
