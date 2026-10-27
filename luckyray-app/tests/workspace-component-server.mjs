import {createServer} from 'vite';
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'node_modules/.vite-workspace-fixture',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:1427,strictPort:true},plugins:[{
 name:'workspace-fixture-bridge',enforce:'pre',resolveId(id,importer){if(id==='./App'&&importer?.endsWith('/luckyrayBridge.ts'))return '\0workspace-bridge';},load(id){if(id==='\0workspace-bridge')return 'export function buildLuckyRayBridge(){return window.__LUCKYRAY__}';}
}]});
await server.listen();console.log('Workspace fixture ready http://127.0.0.1:1427/tests/fixtures/workspace-component.html');
