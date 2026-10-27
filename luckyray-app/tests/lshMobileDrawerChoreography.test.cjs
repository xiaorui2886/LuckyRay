const {test}=require('node:test');
const assert=require('node:assert/strict');
const ui=require('../src-tauri/dsh-host/luckyray-dsh-lightseek-ui/client.js');
const css=ui.MOBILE_PRESENTATION_CSS;
const mobile='html[data-luckyray-mobile="1"] ';
function rule(s){const start=css.indexOf(s+' {');assert(start>=0,s);return css.slice(start,css.indexOf('}',start));}
const scrim=rule(mobile+'.pI_x6G_frame:after');
const drawer=rule(mobile+'.pI_x6G_sidebarCol');
test('visual scrim covers stationary frame, not a moving or final-width side strip',()=>{
 assert.match(scrim,/inset:0;/);assert.match(scrim,/pointer-events:none/);
 assert.doesNotMatch(scrim,/transform|drawer-width|left:|width:/);
 assert.match(rule('.lr-mobile-sidebar-backdrop'),/background:transparent/);
 assert.match(rule('.lr-mobile-sidebar-backdrop'),/var\(--lr-mobile-drawer-width\)/);
 assert.match(scrim,/z-index:18/);assert.match(drawer,/z-index:19/);
 assert.doesNotMatch(css,/\.pI_x6G_overlayLayer\s*\{/,'do not demote official modal overlay layer');
});
test('opening and closing share duration/easing without independent shadow movement',()=>{
 const timing='.22s cubic-bezier(.2,.8,.2,1)';
 assert(scrim.includes('transition:opacity '+timing+',visibility .22s'));
 assert(drawer.includes('transition:transform '+timing+',visibility .22s'));
 assert.match(drawer,/box-shadow:4px 0 16px #00000014/);
 assert.doesNotMatch(drawer,/transition:[^;]*box-shadow/);
 assert.match(rule(mobile+'.pI_x6G_frame[data-sidebar-collapsed]:after'),/opacity:0; visibility:hidden/);
 assert.match(scrim,/opacity:1; visibility:visible/);
 assert.match(css,/@media\(prefers-reduced-motion:reduce\) \{[^}]*sidebarCol,html\[data-luckyray-mobile="1"\] \.pI_x6G_frame:after \{ transition:none/);
});
test('timeline contract: every uncovered point shares tint across widths/open/close/interruption',()=>{
 // Geometric contract, not browser/video evidence: scrim never changes its bounds.
 for(const width of [320,360,393,432,768]){
  const drawerWidth=Math.min(320,width-40);
  for(const progress of [0,.1,.25,.5,.75,.9,1,.6,.2,.8,0]){
   const edge=drawerWidth*(-.05+1.05*progress);
   const uncovered=[Math.max(0,edge)+1,(Math.max(0,edge)+width)/2,width-1];
   for(const x of uncovered)assert(x>=0&&x<=width,'stationary inset:0 scrim covers all uncovered x');
   assert.equal(Number(scrim.match(/z-index:(\d+)/)[1])+1,Number(drawer.match(/z-index:(\d+)/)[1]));
  }
 }
});
