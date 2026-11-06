import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readSource, loadTypeScript } from './harnessPaths.mjs';
const ts=loadTypeScript();
const app=readSource('src/App.tsx');
const privacy=readSource('src/core/services/aiSettingsPrivacy.ts');
function fn(name){const match=new RegExp('(?:async )?function '+name+'\\(').exec(app);assert.ok(match);const tail=app.slice(match.index);return tail.slice(0,tail.indexOf('\n}',tail.indexOf('{'))+2);}
function harness({native=true,db=null,stored={}}={}) {
 const raw=JSON.stringify(stored),memory=new Map([['settings',raw]]),calls=[];
 const defaults={aiApiKey:null,aiImageApiKey:null,aiTemperature:0.7,aiMaxTokens:2048,...stored};
 const context=vm.createContext({isTauri:()=>native,getDb:async()=>db,getStoredSettings:async()=>({...defaults}),getSettings:async()=>({aiApiKey:null,aiImageApiKey:null,aiApiKeyConfigured:true}),readTemperature:s=>s.aiTemperature,readMaxTokens:s=>s.aiMaxTokens,FALLBACK_SETTINGS_KEY:'settings',localStorage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)},invoke:async(command,args)=>{calls.push({command,args});return {};}});
 const source=privacy.replace(/export /g,'')+'\n'+fn('saveFallbackSettings')+'\n'+fn('setSettings');
 vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
 return {context,memory,raw,calls};
}
test('failed native migration plus ordinary settings save preserves the sole browser keys and rejects success',async()=>{const h=harness({stored:{aiApiKey:'synthetic-old-text',aiImageApiKey:'synthetic-old-image',aiModel:'old'}});await assert.rejects(h.context.setSettings({aiModel:'new'}),/ai-secret-storage-unavailable/);assert.equal(h.memory.get('settings'),h.raw);assert.equal(h.calls.length,0);});
for(const key of ['aiApiKey','aiImageApiKey'])for(const value of ['synthetic-replacement',''])test(`unavailable storage rejects ${key} ${value?'replacement':'explicit clear'} without modifying old copy`,async()=>{const h=harness({stored:{[key]:'synthetic-old'}});await assert.rejects(h.context.setSettings({[key]:value}),/ai-secret-storage-unavailable/);assert.equal(h.memory.get('settings'),h.raw);assert.equal(h.calls.length,0);});
test('native database failure does not claim even a metadata save succeeded',async()=>{const h=harness();await assert.rejects(h.context.setSettings({aiModel:'new'}),/ai-secret-storage-unavailable/);assert.equal(h.memory.get('settings'),h.raw);});
test('browser preview keeps non-secret preferences usable',async()=>{const h=harness({native:false});await h.context.setSettings({aiModel:'preview-model'});assert.equal(JSON.parse(h.memory.get('settings')).aiModel,'preview-model');});
test('browser preview cannot silently discard old keys or pretend to store new keys',async()=>{for(const stored of [{},{aiApiKey:'synthetic-old'}]){const h=harness({native:false,stored});await assert.rejects(h.context.setSettings(stored.aiApiKey?{aiModel:'new'}:{aiApiKey:'synthetic-new'}),/ai-secret-storage-unavailable/);assert.equal(h.memory.get('settings'),h.raw);}});
test('available native store still distinguishes omitted, replacement and explicit-clear values',async()=>{for(const patch of [{aiModel:'new'},{aiApiKey:'synthetic-new'},{aiApiKey:''},{aiImageApiKey:''}]){const writes=[];const h=harness({db:{execute:async(...args)=>writes.push(args)}});await h.context.setSettings(patch);assert.equal(h.calls.length,1);assert.equal(h.calls[0].command,'ai_settings_secret_update');assert.equal(h.calls[0].args.apiKey,patch.aiApiKey??null);assert.equal(h.calls[0].args.imageApiKey,patch.aiImageApiKey??null);assert.equal(h.memory.get('settings'),h.raw);assert(writes.every(([,values])=>!['aiApiKey','aiImageApiKey'].includes(values[0])));}});
