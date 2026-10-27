const { test } = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../src-tauri/dsh-host/luckyray-dsh-lightseek-ui/client.js');

test('mobile presentation requires an exact opt-in, never viewport sniffing', () => {
  for (const search of ['', '?luckyrayMobile=0', '?luckyrayMobile=true', '?x=1', '?luckyrayMobile=01']) assert.equal(ui.isMobilePresentation(search), false);
  assert.equal(ui.isMobilePresentation('?luckyrayMobile=1'), true);
  assert.equal(ui.isMobilePresentation('?x=1&luckyrayMobile=1'), true);
});
test('session phase uses official busy/blank/loading semantics', () => {
  const blank = { activeTargets:new Set() };
  assert.deepEqual(ui.mobilePhase(undefined, undefined, undefined), {phase:'hero',hero:true});
  assert.equal(ui.mobilePhase('s',{blank:true,openState:'loading'},blank,false).phase,'settling');
  assert.equal(ui.mobilePhase('s',{blank:true,openState:'open'},blank,true).phase,'hero');
  assert.equal(ui.mobilePhase('s',{blank:true,running:true,openState:'open'},blank,true).phase,'active');
  assert.equal(ui.mobilePhase('s',{blank:true,promptAttempted:true,openState:'open'},blank,true).phase,'active');
  assert.equal(ui.mobilePhase('s',{blank:false,openState:'open'},blank,false).phase,'active');
  assert.equal(ui.mobilePhase('s',{blank:true,openState:'open'},{activeTargets:new Set(['x'])},true).phase,'active');
  assert.equal(ui.mobilePhase('s',{blank:true,openState:'open',subagent:{address:{mode:'continuable'}}},blank,true).phase,'settling');
});
function registrations() {
  const entries=[];
  const jsx=(type,props)=>({type,props});
  const react={ useState:()=>[false,()=>{}], useEffect:()=>{} };
  const ctx={layout:{toggleSidebar(){},selectPanel(){}},slots:{inject:(_,factory)=>factory(), register:(spec,component)=>entries.push({spec,component})}};
  ui.registerMobileConversation(ctx,(name)=>{assert.equal(name,'react');return react;},jsx);
  return entries;
}
test('presentation theme accepts only native finite display values and adds no protocol API', () => {
  const styles=new Map(), nodes=new Map(); let observerCallback;
  const root={dataset:{luckyrayMobileTheme:'dark'},style:{getPropertyValue:k=>styles.get(k),setProperty:(k,v)=>styles.set(k,v)}};
  const doc={documentElement:root,head:{appendChild:n=>nodes.set(n.id,n)},getElementById:id=>nodes.get(id),createElement:()=>({}),defaultView:{location:{search:'?luckyrayMobile=1'},MutationObserver:class { constructor(fn){observerCallback=fn;} observe(){} disconnect(){} },addEventListener(){}}};
  assert.equal(ui.installMobilePresentation(doc),true);
  assert.equal(root.dataset.luckyrayMobileVersion,ui.MOBILE_PRESENTATION_VERSION);
  assert.equal(styles.get('--dsw-alias-bg-base'),'#0a0a0c');
  root.dataset.luckyrayMobileTheme='light'; observerCallback();
  assert.equal(styles.get('--dsw-alias-bg-base'),'#f1f2f5');
  root.dataset.luckyrayMobileTheme='javascript:bad'; observerCallback();
  assert.equal(styles.get('--dsw-alias-bg-base'),'#f1f2f5');
  ui.installMobilePresentation(doc); assert.equal(nodes.size,1);
  assert.match(ui.MOBILE_PRESENTATION_CSS,/prefers-reduced-motion/);
  assert.match(ui.MOBILE_PRESENTATION_CSS,/overscroll-behavior:contain/);
  assert.doesNotMatch(ui.MOBILE_PRESENTATION_CSS,/transform:\s*scale\(/);
});

test('real factory body wins the desktop 680px inherited width floor', () => {
  const rule=ui.MOBILE_PRESENTATION_CSS.match(/\.wSkVaW_root \[data-conversation-content\] \{([^}]+)\}/)[1];
  assert.match(rule,/--dsh-chat-content-width:100%/);
  assert.match(rule,/--dsh-composer-card-max-width:100%/);
  assert.match(rule,/--dsh-composer-side-clearance:12px/);
  // This selector has two class/attribute terms versus official .wSkVaW_body's one.
  assert.match(ui.MOBILE_PRESENTATION_CSS,/\.pI_x6G_frame \{ grid-template-columns:0 minmax\(0,1fr\) 0!important/);
  assert.match(ui.MOBILE_PRESENTATION_CSS,/\.pI_x6G_sidebarCol \.hHd-Xa_root \{ width:100%!important/);
  assert.match(ui.MOBILE_PRESENTATION_CSS,/data-sidebar-collapsed\] \.lr-mobile-sidebar-backdrop \{ display:none/);
});
test('native theme replaces the real body-level palette and is idempotent', () => {
  const values=new Map(), attrs=new Set(); let callback, writes=0;
  const body={style:{getPropertyValue:k=>values.get(k),setProperty:(k,v)=>{writes++;values.set(k,v);}},hasAttribute:k=>attrs.has(k),toggleAttribute:(k,on)=>on?attrs.add(k):attrs.delete(k)};
  const doc={body,documentElement:{dataset:{luckyrayMobileTheme:'dark'},style:{}},head:{appendChild(){}},getElementById:()=>null,createElement:()=>({}),defaultView:{location:{search:'?luckyrayMobile=1'},MutationObserver:class {constructor(fn){callback=fn;} observe(){} disconnect(){}},addEventListener(){}}};
  ui.installMobilePresentation(doc);
  assert(attrs.has('data-ds-dark-theme')); assert.equal(values.get('--dsw-alias-bg-base'),'#0a0a0c');
  const initial=writes;callback();assert.equal(writes,initial,'observer does not generate its own endless style mutation');
  doc.documentElement.dataset.luckyrayMobileTheme='light';callback();
  assert(!attrs.has('data-ds-dark-theme'));assert.equal(values.get('--dsw-alias-bg-base'),'#f1f2f5');
});
test('mobile navigation targets the official layout controller only', () => {
  const entries=[],calls=[];
  const jsx=(type,props)=>({type,props});
  const ctx={layout:{toggleSidebar:()=>calls.push('toggle'),selectPanel:id=>calls.push(['panel',id])},slots:{inject:(_,f)=>f(),register:(spec,component)=>entries.push({spec,component})}};
  ui.registerMobileConversation(ctx,()=>({useEffect(){},useState:()=>[false,()=>{}]}),jsx);
  const overlay=entries[0].component({useSessions:f=>f({byId:{}}),usePanelInfo:f=>f({activePanelId:'settings'})});
  assert.equal(overlay.props['data-luckyray-mobile-shell'],ui.MOBILE_PRESENTATION_VERSION);
  overlay.props.children[0].props.onClick();
  overlay.props.children[1].props.children.props.onClick();
  assert.deepEqual(calls,['toggle',['panel',null]]);
});
test('native Back collapses owned surfaces but never swallows an idle conversation', () => {
  const oldDoc=global.document,oldWindow=global.window;
  let drawer=false,right=false,modal=false,consumed=0;const calls=[],effects=[],listeners=new Map(),entries=[];
  global.document={documentElement:{dataset:{}},querySelector:()=>drawer?{}:null,querySelectorAll:()=>modal?[{getAttribute:()=>null,getClientRects:()=>[{}]}]:[],addEventListener(){},removeEventListener(){}};
  global.window={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  try {
    const ctx={layout:{toggleSidebar:()=>{drawer=false;calls.push('drawer');},selectPanel:()=>calls.push('panel')},get:()=>({isExpanded:()=>right,toggleExpanded:()=>{right=false;calls.push('right');}}),slots:{inject:(_,f)=>f(),register:(spec,component)=>entries.push({spec,component})}};
    ui.registerMobileConversation(ctx,()=>({useEffect:fn=>effects.push(fn),useState:()=>[false,()=>{}]}),(type,props)=>({type,props}));
    entries[0].component({useSessions:f=>f({byId:{}}),usePanelInfo:f=>f({activePanelId:null})});
    const disposers=effects.map(f=>f());assert.deepEqual(calls,['panel']);calls.length=0;
    const back=()=>listeners.get('luckyray-mobile-back')({defaultPrevented:false,preventDefault:()=>consumed++});
    back();assert.equal(consumed,0);
    drawer=true;back();assert.equal(consumed,1);assert.deepEqual(calls,['drawer']);
    right=true;back();assert.equal(consumed,2);assert.deepEqual(calls,['drawer','right']);
    drawer=true;modal=true;back();assert.equal(consumed,2,'official modal gets native Escape first');
    disposers.forEach(f=>f?.());assert(!listeners.has('luckyray-mobile-back'));
  } finally {global.document=oldDoc;global.window=oldWindow;}
});
test('settings reflow targets only the audited official modal shell', () => {
  assert.match(ui.MOBILE_PRESENTATION_CSS,/\.VOzbGW_panel\[data-shortcut-modal="settings"\] \{[^}]*grid-template-rows:52px auto minmax\(0,1fr\)/);
  assert.match(ui.MOBILE_PRESENTATION_CSS,/\.VOzbGW_panel \.VOzbGW_navList \{[^}]*flex-direction:row/);
  assert.match(ui.MOBILE_PRESENTATION_CSS,/\.VOzbGW_panel \.VOzbGW_options \{[^}]*overflow-y:auto/);
  assert.doesNotMatch(ui.MOBILE_PRESENTATION_CSS,/\[role=dialog\][^{]*\{[^}]*display:none/);
});

test('mobile contributes only a list overlay and a leaf brand, never redeclares official children', () => {
  const entries=registrations();
  assert.deepEqual(entries.map(e=>e.spec.name),['shell.overlay','conversation.hero.brand.mark']);
  assert(entries.every(e=>e.spec.children===undefined && e.spec.priority<0));
  assert.match(ui.MOBILE_PRESENTATION_CSS,/\.wSkVaW_widthHandle \{ display:none/);
  assert.match(ui.MOBILE_PRESENTATION_CSS,/html\[data-luckyray-mobile="1"\] \.wSkVaW_header \{/);
  assert.doesNotMatch(ui.MOBILE_PRESENTATION_CSS,/\.wSkVaW_header(?:Leading|Actions|Utilities|Corner)[^{]*\{[^}]*display:none/);
});
test('mobile tools keep same-page refresh and official sidebar action without replacing session controls', () => {
  const overlay=registrations()[0].component({useSessions:f=>f({byId:{}}),usePanelInfo:f=>f({activePanelId:null})});
  const buttons=overlay.props.children[2].props.children;
  assert.equal(buttons[0].props['aria-label'],'会话列表与设置');
  const previous=global.window; let reloads=0;
  try { global.window={location:{reload:()=>reloads++}};buttons[1].props.onClick();assert.equal(reloads,1); } finally {global.window=previous;}
});
