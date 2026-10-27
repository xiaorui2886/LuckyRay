import {createServer} from 'vite';
const server=await createServer({configFile:false,root:process.cwd(),cacheDir:'node_modules/.vite-notes-production-fixture',esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:1437,strictPort:true},plugins:[{
 name:'notes-production-fixture-bridge',enforce:'pre',resolveId(id,importer){if(id==='./App'&&importer?.endsWith('/luckyrayBridge.ts'))return '\0notes-bridge';},load(id){if(id==='\0notes-bridge')return 'export function buildLuckyRayBridge(){return window.__LUCKYRAY__}';}
}]});
await server.listen();console.log('Production Notes fixture http://127.0.0.1:1437/tests/fixtures/notes-production.html');
