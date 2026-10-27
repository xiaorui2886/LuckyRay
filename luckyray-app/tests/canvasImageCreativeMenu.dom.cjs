const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'https://qa.invalid' });
for (const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','navigator']) Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
const React=require('react'),{createRoot}=require('react-dom/client');
const {CanvasImageCreativeMenu,CanvasCreativeRecipeEditor}=require(require('node:path').resolve(process.argv[2]));
const delay=()=>new Promise(r=>setTimeout(r,30));
(async()=>{
 const root=createRoot(document.getElementById('root'));let selected=[],updates=[];
 root.render(React.createElement(CanvasImageCreativeMenu,{onSelect:r=>selected.push(r)}));await delay();
 assert.equal(document.querySelectorAll('[data-creative-action]').length,9);
 assert.equal(document.querySelectorAll('section').length,4);
 const action=document.querySelector('[data-creative-action="story-grid"]');
 assert.ok(action.title.includes('分镜'));action.click();action.click();await delay();
 assert.equal(selected.length,1);assert.deepEqual(selected[0],{version:1,id:'story-grid',options:{grid:'2x2'}});
 function Harness(){const [recipe,setRecipe]=React.useState(selected[0]);return React.createElement(React.Fragment,null,React.createElement('textarea',{defaultValue:'保持我写的补充提示词'}),React.createElement(CanvasCreativeRecipeEditor,{value:recipe,onChange:r=>{updates.push(r);setRecipe(r)}}));}
 root.render(React.createElement(Harness));await delay();
 assert.equal(document.querySelector('select'),null);assert.equal(document.querySelector('[aria-expanded]').getAttribute('aria-expanded'),'false');
 document.querySelector('[aria-expanded]').click();await delay();
 assert.equal(document.querySelectorAll('option').length,3);
 const select=document.querySelector('select');select.value='5x5';select.dispatchEvent(new Event('change',{bubbles:true}));await delay();
 assert.equal(updates[0].options.grid,'5x5');assert.match(document.querySelector('.canvas-creative-recipe-options p').textContent,/一张图/);
 assert.equal(document.querySelector('textarea').value,'保持我写的补充提示词');
 document.querySelector('[aria-label="移除创作预设"]').click();await delay();
 assert.equal(updates[1],undefined);assert.equal(document.querySelector('.canvas-creative-recipe'),null);assert.equal(document.querySelector('textarea').value,'保持我写的补充提示词');
 root.render(React.createElement(CanvasCreativeRecipeEditor,{value:{version:1,id:'time-shift',options:{seconds:3,direction:'after'}},onChange:r=>updates.push(r),english:true}));await delay();
 document.querySelector('[aria-expanded]').click();await delay();
 assert.equal(document.querySelectorAll('select').length,2);const seconds=document.querySelectorAll('select')[1];seconds.value='5';seconds.dispatchEvent(new Event('change',{bubbles:true}));await delay();assert.equal(updates[2].options.seconds,5);
 root.render(React.createElement(CanvasCreativeRecipeEditor,{value:{version:999,id:'story-grid',options:{}},onChange:r=>updates.push(r)}));await delay();assert.match(document.querySelector('.canvas-creative-recipe').textContent,/移除不支持/);document.querySelector('.canvas-creative-recipe button').click();assert.equal(updates.at(-1),undefined);
 root.render(React.createElement(CanvasImageCreativeMenu,{onSelect:()=>{},english:true}));await delay();assert.match(document.body.textContent,/Nine camera angles/);

 // A blank draft keeps every preset actionable and explains image-only inputs.
 for (const id of ['time-shift', 'relight', 'cinematic-grade']) {
  root.render(React.createElement(CanvasImageCreativeMenu,{key:id,onSelect:r=>selected.push(r),context:'draft',currentId:'story-grid',hasImageReference:false}));await delay();
  assert.match(document.querySelector('.canvas-image-creative-menu-title').textContent,/创作预设/);
  assert.equal(document.querySelectorAll('[data-creative-action]').length,9);
  assert.equal(document.querySelectorAll('[data-creative-action]:disabled').length,0);
  assert.equal(document.querySelectorAll('[data-creative-action][aria-pressed="true"]').length,1);
  assert.equal(document.querySelector('[data-creative-action="story-grid"]').getAttribute('aria-pressed'),'true');
  assert.equal(document.querySelectorAll('.canvas-image-creative-action-copy small').length,3);
  const imageOnlyAction=document.querySelector(`[data-creative-action="${id}"]`);assert.match(imageOnlyAction.title,/生成前请添加参考图/);
  imageOnlyAction.click();await delay();assert.equal(selected.at(-1).id,id);
 }
 root.render(React.createElement(CanvasImageCreativeMenu,{key:'derive',onSelect:()=>{},context:'derive',currentId:'relight'}));await delay();
 assert.match(document.querySelector('.canvas-image-creative-menu-title').textContent,/基于图片创作/);
 assert.equal(document.querySelectorAll('.canvas-image-creative-action-copy small').length,0);
 root.render(React.createElement(CanvasImageCreativeMenu,{key:'ready',onSelect:()=>{},context:'draft',hasImageReference:true,english:true}));await delay();
 assert.match(document.querySelector('.canvas-image-creative-menu-title').textContent,/Creative presets/);
 assert.equal(document.querySelectorAll('.canvas-image-creative-action-copy small').length,0);

 // The label switches recipes; the independent chevron edits options; × only removes metadata.
 let switchAnchors=[],switchChanges=[];
 const camera={enabled:true,shotSize:'close-up'};
 const rawPrompt='  保留我写的正文\n以及 @Image1';
 let latest;
 function SwitchingHarness(){
  const [data,setData]=React.useState({generationPrompt:rawPrompt,generationCinematography:camera,generationCreativeRecipe:{version:1,id:'story-grid',options:{grid:'5x5'}}});
  const [menu,setMenu]=React.useState(false);latest=data;
  return React.createElement(React.Fragment,null,
   React.createElement('textarea',{value:data.generationPrompt,readOnly:true}),
   React.createElement(CanvasCreativeRecipeEditor,{value:data.generationCreativeRecipe,onChange:r=>{switchChanges.push(r);setData(d=>({...d,generationCreativeRecipe:r}));},onSwitchRequest:anchor=>{switchAnchors.push(anchor);setMenu(true);}}),
   menu&&React.createElement(CanvasImageCreativeMenu,{context:'draft',currentId:data.generationCreativeRecipe?.id,onSelect:r=>{setData(d=>d.generationCreativeRecipe?.id===r.id?d:{...d,generationCreativeRecipe:r});setMenu(false);}}));
 }
 root.render(React.createElement(SwitchingHarness));await delay();
 assert.equal(document.querySelector('.canvas-creative-recipe-chip').querySelectorAll('button').length,3);
 const switchButton=document.querySelector('.canvas-creative-recipe-switch');
 assert.equal(switchButton.hasAttribute('aria-expanded'),false);
 assert.equal(document.querySelector('.canvas-creative-recipe-settings').getAttribute('aria-expanded'),'false');
 switchButton.click();await delay();
 assert.equal(switchAnchors[0],switchButton);assert.equal(switchChanges.length,0);
 assert.equal(document.querySelector('.canvas-creative-recipe-options'),null);
 document.querySelector('[data-creative-action="story-grid"]').click();await delay();
 assert.equal(latest.generationCreativeRecipe.options.grid,'5x5');
 document.querySelector('.canvas-creative-recipe-settings').click();await delay();
 assert.equal(switchAnchors.length,1);assert.equal(document.querySelector('select').value,'5x5');
 document.querySelector('.canvas-creative-recipe-switch').click();await delay();
 assert.equal(document.querySelector('.canvas-creative-recipe-options'),null);
 document.querySelector('[data-creative-action="character-sheet"]').click();await delay();
 assert.deepEqual(latest.generationCreativeRecipe,{version:1,id:'character-sheet',options:{}});
 assert.match(document.querySelector('.canvas-creative-recipe-switch').textContent,/角色设定板/);
 assert.equal(latest.generationPrompt,rawPrompt);assert.equal(latest.generationCinematography,camera);
 assert.equal(document.querySelector('.canvas-creative-recipe-settings').getAttribute('aria-label'),'查看创作预设说明');
 document.querySelector('.canvas-creative-recipe-settings').click();await delay();
 assert.equal(document.querySelector('select'),null);assert.match(document.querySelector('.canvas-creative-recipe-options').textContent,/一张图/);
 document.querySelector('.canvas-creative-recipe-switch').click();await delay();
 document.querySelector('[data-creative-action="time-shift"]').click();await delay();
 document.querySelector('.canvas-creative-recipe-settings').click();await delay();
 const timeSelect=document.querySelectorAll('select')[1];timeSelect.value='5';timeSelect.dispatchEvent(new Event('change',{bubbles:true}));await delay();
 assert.equal(switchChanges.at(-1).options.seconds,5);assert.equal(typeof latest.generationCreativeRecipe.options.seconds,'number');
 document.querySelector('.canvas-creative-recipe-remove').click();await delay();
 assert.equal(latest.generationCreativeRecipe,undefined);assert.equal(document.querySelector('.canvas-creative-recipe'),null);
 assert.equal(latest.generationPrompt,rawPrompt);assert.equal(latest.generationCinematography,camera);assert.equal(document.querySelector('textarea').value,rawPrompt);
 root.unmount();console.log('Creative menu/editor: legacy controls, blank draft selection, selected-state, split chip switching, typed options and removal PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
