const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ui=require('../src-tauri/dsh-host/luckyray-dsh-lightseek-ui/client.js');
const css=ui.MOBILE_PRESENTATION_CSS;
function rule(selector){const start=css.indexOf(selector+' {');assert(start>=0,selector);return css.slice(start,css.indexOf('}',start)+1);}
function overlay(){const entries=[];ui.registerMobileConversation({layout:{toggleSidebar(){},selectPanel(){}},slots:{inject:(_,f)=>f(),register:(s,c)=>{entries.push(c);return()=>{}}}},()=>({useEffect(){}}),(type,props)=>({type,props}));return entries[0]({useSessions:f=>f({byId:{}}),usePanelInfo:f=>f({activePanelId:null})});}
test('navigation uses decorative original sidebar SVG and labeled refresh without visible text',()=>{
 const buttons=overlay().props.children[2].props.children;
 for(const b of buttons){assert.equal(b.type,'button');assert(b.props['aria-label']);assert(b.props.title);assert.equal(b.props.children.type,'svg');assert.equal(b.props.children.props['aria-hidden'],true);assert.equal(b.props.children.props.focusable,false);}
 assert.equal(buttons[0].props.children.props.children[1].props.d,'M5.5 1.5V14.5');
 assert.equal(buttons[1].props['aria-label'],'刷新界面');
});
test('both sides share top and target height, title row cannot establish an offset containing block',()=>{
 const tools=rule('.lr-mobile-tools'),corner=rule('html[data-luckyray-mobile="1"] .wSkVaW_headerCorner');
 for(const r of [tools,corner])assert.match(r,/top:6px/);
 assert.match(corner,/height:40px/);assert.match(rule('.lr-mobile-tools button'),/height:40px/);
 assert.match(rule('html[data-luckyray-mobile="1"] .wSkVaW_titleRow'),/container-type:normal/);
 assert.match(rule('html[data-luckyray-mobile="1"] .wSkVaW_header'),/position:relative/);
});
test('sidebar content fills through official slot wrappers and outer border stays inside drawer width',()=>{
 assert.match(rule('html[data-luckyray-mobile="1"] .pI_x6G_sidebarCol .hHd-Xa_root'),/width:100%!important; max-width:100%/);
 assert.doesNotMatch(css,/sidebarCol > \.hHd-Xa_root/);
 assert.match(rule('html[data-luckyray-mobile="1"] .pI_x6G_sidebarCol'),/box-sizing:border-box/);
 assert.match(rule('.lr-mobile-sidebar-backdrop'),/var\(--lr-mobile-drawer-width\)/);
});
test('sidebar brand shares hero tint only in mobile mode; official account rendering remains untouched',()=>{
 assert.match(css,/html\[data-luckyray-mobile="1"\] \.hHd-Xa_brandMark img,\.lr-mobile-brand \{ filter:brightness\(0\)/);
 assert.doesNotMatch(css,/avatar|ZCYJYW|yHnPSG/);
});
test('client remains below existing 128KiB cap and SHA pin matches exact delivered bytes',()=>{
 const b=fs.readFileSync(path.join(__dirname,'../src-tauri/dsh-host/luckyray-dsh-lightseek-ui/client.js'));
 assert(b.length<=131072);const hash=crypto.createHash('sha256').update(b).digest('hex');
 assert(fs.readFileSync(path.join(__dirname,'../src-tauri/src/dsh_host.rs'),'utf8').includes(hash));
});
