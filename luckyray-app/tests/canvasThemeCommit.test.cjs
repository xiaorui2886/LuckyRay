const assert=require('node:assert/strict');const commit=require('./canvasThemeCommit.browser.cjs');
const root={dataset:{},tagName:'HTML',parentElement:null},panel={className:'panel',parentElement:root},other={className:'unrelated'};
global.matchMedia=()=>({matches:true});global.getComputedStyle=el=>({color:root.dataset.theme==='light'?'light':'dark',backgroundColor:'bg'});
let frames=0;global.requestAnimationFrame=cb=>setImmediate(()=>{frames++;cb();});
global.document={documentElement:root,querySelectorAll:sel=>sel==='html'?[root]:[panel]};
const page={evaluate:(fn,arg)=>fn(arg)};
(async()=>{
 root.getAnimations=()=>{const unrelated={effect:{target:other,getTiming:()=>({iterations:1,duration:99999})},playState:'running',finished:new Promise(()=>{})};if(frames>=8)return [unrelated];return [unrelated,{constructor:{name:'CSSTransition'},transitionProperty:'color',effect:{target:panel,getTiming:()=>({iterations:1,duration:.01})},playState:'running',finished:Promise.resolve()}];};
 const good=await commit(page,'light',['html','.panel']);assert.equal(good.failure,undefined);assert.ok(frames>=9);assert.ok(good.animations.length>=8);assert.ok(good.animations.every(a=>a.target==='panel'));console.log('PASS >4 inherited frames settle; unrelated never-ending animation ignored');
 root.getAnimations=()=>[{effect:{target:panel,getTiming:()=>({iterations:1,duration:5000})},playState:'running',finished:new Promise(()=>{})}];
 const before=Date.now(),bad=await commit(page,'dark',['html','.panel']);assert.match(bad.failure,/1000ms/);assert.ok(Date.now()-before>=950&&Date.now()-before<1400);console.log('PASS relevant stuck transition fails at real 1s deadline, diagnostic retained');
})().catch(e=>{console.error(e);process.exitCode=1;});
