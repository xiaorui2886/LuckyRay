import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export function checkoutIdentity(root) {
  return createHash('sha256').update(realpathSync(root).replaceAll('\\', '/').toLowerCase()).digest('hex');
}
export function classifyFrontendBindError(error) {
  return error.code === 'EACCES' ? 'denied' : error.code === 'EADDRINUSE' ? 'occupied' : 'unavailable';
}
export function frontendDiagnostic(status, port = 1420) {
  const diagnostics = {
    ready: { exitCode: 0, message: '' },
    free: { exitCode: 3, message: '' },
    occupied: { exitCode: 4, message: 'Port 1420 has a listener that is not a healthy verified frontend for this checkout. Inspect its owner and health; do not stop an unidentified process.' },
    denied: { exitCode: 5, message: 'The OS denied binding port 1420 (EACCES). Inspect bind policy, port reservations and logs; this does not establish that administrator privileges are needed.' },
    unavailable: { exitCode: 6, message: 'The frontend port probe failed for another reason. Inspect the environment and logs; no listener ownership or permission cause has been established.' },
  };
  const diagnostic = diagnostics[status] ?? diagnostics.unavailable;
  return { ...diagnostic, message: diagnostic.message.replaceAll('1420', String(port)) };
}
export async function frontendStatus(root, port = 1420) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__luckyray_dev`, { signal: AbortSignal.timeout(2000) });
    const data = await response.json();
    if (response.ok && data.checkout === checkoutIdentity(root)) return 'ready';
  } catch { /* distinguish a free port from an unrelated or unhealthy listener */ }
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', error => resolve(classifyFrontendBindError(error)));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(() => resolve('free')));
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--reject-bare')) {
    console.error('Unconfigured tauri dev is refused: use pnpm.cmd dev:desktop for com.luckyray.desktop.dev.');
    process.exit(1);
  }
  const portIndex = process.argv.indexOf('--port');
  const port = portIndex === -1 ? 1420 : Number(process.argv[portIndex + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('[dev] invalid explicit frontend port');
    process.exit(6);
  }
  const status = await frontendStatus(dirname(dirname(fileURLToPath(import.meta.url))), port);
  console.log(`[dev] frontend: ${status}`);
  const diagnostic = frontendDiagnostic(status, port);
  process.exitCode = diagnostic.exitCode;
  if (diagnostic.message) console.error(`[dev] ${diagnostic.message}`);
  if (status !== 'ready' && !process.argv.includes('--status')) console.error('Use pnpm.cmd dev:desktop. The frontend must be ready before Tauri starts; no process was terminated.');
}
