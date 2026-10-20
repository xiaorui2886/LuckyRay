const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2]);
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(root, 'node_modules/vite'))] }));
(async () => {
  await esbuild.build({ jsx:'automatic', entryPoints:[path.join(root,'tests/canvasAgentR7Ui.fixture.tsx')], bundle:true, outfile:path.join(out,'fixture.js'),loader:{'.css':'css'}});
  const server = http.createServer((req,res) => {
    const names = {'/':'fixture.html','/fixture.js':'fixture.js','/fixture.css':'fixture.css'};
    if(req.url === '/favicon.ico'){res.writeHead(204);res.end();return;}
    const name = names[req.url];
    if(!name){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type', name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(name==='fixture.html'?__dirname:out,name)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  fs.writeFileSync(path.join(out,'server.tmp'),JSON.stringify({pid:process.pid,url:`http://127.0.0.1:${server.address().port}/`}));
  fs.renameSync(path.join(out,'server.tmp'),path.join(out,'server.json'));
})().catch(error=>{console.error(error);process.exit(1);});
