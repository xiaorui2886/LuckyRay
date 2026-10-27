import {createServer} from 'vite';
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: '/tmp/luckyray-graph-session-vite-cache', esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 1441, strictPort: true } });
await server.listen(); console.log('Graph retained session fixture: http://127.0.0.1:1441/tests/fixtures/graph-retained-sessions.html');
