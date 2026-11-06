import test from 'node:test';
import assert from 'node:assert/strict';
import {inventory, selectTarget} from '../src/transport.mjs';

test('Windows discovery maps only numeric IPv4 loopback listeners to the exact Unicode process generation', {skip:process.platform!=='win32'}, async()=>{
  const exe='C:\\合成 软件-é-😀\\luckyray-app.exe';
  const created='2026-10-17T00:00:00.0000000Z';
  const run=async(command)=>command.toLowerCase().endsWith('netstat.exe')?{stdout:[
    '  Proto  Local Address  Foreign Address  State  PID',
    '  TCP  127.0.0.1:37419  0.0.0.0:0  LISTENING  42',
    '  TCP  127.0.0.1:37419  0.0.0.0:0  LISTENING  42',
    '  TCP  127.0.0.1:37420  0.0.0.0:0  LISTENING  99',
    '  TCP  127.0.0.1:37421  127.0.0.1:100  ESTABLISHED  42',
    '  TCP  0.0.0.0:37422  0.0.0.0:0  LISTENING  42',
    '  TCP  [::1]:37423  [::]:0  LISTENING  42',
    '  TCP  127.0.0.1:65536  0.0.0.0:0  LISTENING  42',
    '  TCP  127.0.0.1:37424  0.0.0.0:0  BOUND  42',
    '  TCP  127.0.0.1:37425  0.0.0.0:0  LISTENING  not-a-pid',
  ].join('\r\n')}:{stdout:JSON.stringify([{pid:42,exe,created}])};
  const found=selectTarget({desktopExe:exe},await inventory({exec:run}));
  assert.deepEqual(found,{pid:42,exe,created,ports:[37419]});
});
