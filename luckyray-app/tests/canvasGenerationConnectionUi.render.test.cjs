// Server-rendered UI contract: no browser, credentials, login or provider requests.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const file=path.resolve('src/features/canvas/CanvasMediaProfilesPanel.tsx');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(path.resolve('node_modules/vite'))]}));
const source=fs.readFileSync(file,'utf8').replace('import { useI18n } from "../../core/i18n/index";','const useI18n=()=>({locale:"en-US"});');
const built=esbuild.buildSync({stdin:{contents:source,resolveDir:path.dirname(file),loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic'});
const loaded={exports:{}};new Function('module','exports','require',built.outputFiles[0].text)(loaded,loaded.exports,id=>id==='@tauri-apps/api/core'?{invoke(){throw Error('SSR must not invoke native commands');}}:require(id));
const render=profile=>renderToStaticMarkup(React.createElement(loaded.exports.CanvasMediaProfilesPanel,{snapshot:{version:1,activeProfileId:profile.id,profiles:[profile]},onChange(){}}));
test('retired Doubao stays explicit without login, secret or paid-provider fallback controls',()=>{
 const html=render({id:'doubao-default',name:'Doubao',baseUrl:'https://www.doubao.com',imageProtocol:'doubao-image',videoProtocol:'doubao-video',imageModel:'',videoModel:'',revision:1,textProtocol:'disabled'});
 assert.match(html,/connection is retired/);assert.match(html,/no automatic provider switch/);
 assert.doesNotMatch(html,/Add account|Refresh \/ resume status|type="password"|Doubao parallel tasks/);
 assert.match(html,/Parallel generation/);assert.equal((html.match(/type="number"/g)||[]).length,5);
});
test('API connection remains single settings area and does not expose Doubao login',()=>{
 const html=render({id:'api',name:'API',baseUrl:'https://example.test/v1',imageProtocol:'openai-image',videoProtocol:'disabled',imageModel:'x',videoModel:'',revision:1});
 assert.doesNotMatch(html,/Add account/);assert.match(html,/Parallel generation/);
});
