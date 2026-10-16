const test = require('node:test');
const assert = require('node:assert/strict');
require('../browser-extension-prototype/appearance.js');
const { validate, apply, accessibleAccent, cachedAppearance, createBroker } = globalThis.LuckyRayAppearance;
const tick = () => new Promise(resolve => setImmediate(resolve));
const appearance = (id='a', theme='light', revision=1, accent='#123456') => ({instanceId:id.repeat(32),theme,revision,accent});

test('finite fields reject unsafe identities and never accept CSS from a page', () => {
  assert.equal(validate({...appearance(),instanceId:'https://example.com'}),null);
  assert.equal(validate({...appearance(),revision:Infinity}),null);
  assert.deepEqual(validate({...appearance(),'theme':'url(x)',accent:'red;url(x)',credential:'secret'}), {...appearance(),theme:'dark',accent:'#7c8aff'});
  assert.equal(cachedAppearance({lastInstanceId:'b'.repeat(32),byInstance:{['b'.repeat(32)]:appearance('a')}}),null);
});
test('accent foreground meets 4.5 contrast, and all nine themes apply', () => {
  assert.notEqual(accessibleAccent('#7c8aff',['#ffffff','#f1f2f5','#e8eaf0']), '#7c8aff');
  assert.equal(accessibleAccent('#000000',['#ffffff']), '#000000');
  const themes=['dark','light','ivory-editorial','rose-tea','github-dark','white-zero','bangladesh-green','lilac-milk','blue-whisper'];
  for(const theme of themes) for(const accent of ['#000000','#ffffff','#7c8aff','#c97991','#00b884','#18181b']) {
    const properties={};const attrs={};apply({setAttribute:(k,v)=>attrs[k]=v,style:{setProperty:(k,v)=>properties[k]=v}},appearance('a',theme,1,accent));
    assert.equal(attrs['data-lr-theme'],theme);assert.equal(properties['--lr-accent'],accent);
    const rgb=accent.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
    const l=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
    const contrast=properties['--lr-accent-ink']==='#000000'?(l+.05)/.05:1.05/(l+.05);
    assert(contrast>=4.5);
  }
});
test('visible surfaces share one poll, deduplicate revisions, preserve offline cache and recover per instance', async () => {
  let next=appearance(),calls=0,scheduled=[],writes=[],offline=false;
  const broker=createBroker({read:async()=>({lastInstanceId:'a'.repeat(32),byInstance:{['a'.repeat(32)]:appearance()}}),write:async x=>writes.push(x),request:async()=>{calls++;if(offline)throw Error('offline');return next},schedule:fn=>{scheduled.push(fn);return fn},cancel:fn=>scheduled=scheduled.filter(x=>x!==fn)});
  const a=[],b=[];const stopA=broker.subscribe(x=>a.push(x));const stopB=broker.subscribe(x=>b.push(x));await tick();
  assert.equal(calls,1);assert.equal(scheduled.length,1);assert.equal(a.length,1);assert.equal(b.length,1);
  next=appearance('a','rose-tea',2,'#c97991');await scheduled.shift()();assert.equal(a.at(-1).theme,'rose-tea');assert.equal(b.at(-1).theme,'rose-tea');
  offline=true;await scheduled.shift()();assert.equal(a.at(-1).theme,'rose-tea');
  offline=false;next=appearance('b','github-dark',1,'#58a6ff');await scheduled.shift()();assert.equal(a.at(-1).instanceId,'b'.repeat(32));assert.equal(writes.at(-1).byInstance['a'.repeat(32)].theme,'rose-tea');
  const c=[];const stopC=broker.subscribe(x=>c.push(x));assert.equal(c[0].theme,'github-dark');
  stopA();stopB();stopC();assert.equal(scheduled.length,0);
});
test('closing all surfaces discards an in-flight result and cancels further polls', async () => {
  let resolve;const received=[],writes=[],scheduled=[];
  const broker=createBroker({read:async()=>null,write:async x=>writes.push(x),request:()=>new Promise(r=>resolve=r),schedule:fn=>{scheduled.push(fn);return fn},cancel:()=>{}});
  const stop=broker.subscribe(x=>received.push(x));await tick();stop();resolve(appearance());await tick();assert.deepEqual(received,[]);assert.deepEqual(writes,[]);assert.deepEqual(scheduled,[]);
});
