import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scopedCredential,validateConfig} from '../src/transport.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('Windows DPAPI + private ACL storage preserves sealed Unicode identity; PowerShell sources parse', {skip:process.platform!=='win32'},async()=>{
 const base=resolve(root,'../../output/materials-mcp-install');mkdirSync(base,{recursive:true});
 const run=mkdtempSync(join(base,'dpapi-'));const script=join(run,'fixture.ps1');
 writeFileSync(script,`param([string]$Root,[string]$Run)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
Get-ChildItem -LiteralPath (Join-Path $Root 'src') -Filter '*.ps1' | ForEach-Object {
 $tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'parse-failed'}
}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($sid)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
$directory=Join-Path $Run 'private';[void][IO.Directory]::CreateDirectory($directory,$acl)
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
$json=[Console]::In.ReadToEnd()
. (Join-Path $Root 'src/pairing-process.ps1')
$publicConfig=Invoke-MaterialsPairingValidation -Json $json -Node (Get-Command node.exe).Source -Entry (Join-Path $Root 'src/pairing.mjs') -CredentialFile (Join-Path $directory 'credential.dpapi')
if($publicConfig.Contains('a'*64)){throw 'public-config-leaks-credential'}
$parsed=$publicConfig | ConvertFrom-Json
if($parsed.authKind -ne 'materials-mcp-scoped-v1'){throw 'validation-failed'}
[IO.File]::WriteAllText((Join-Path $directory 'connection.json'),$publicConfig,(New-Object Text.UTF8Encoding($false)))
$secret=ConvertTo-SecureString $json -AsPlainText -Force
$path=Join-Path $directory 'credential.dpapi'
[IO.File]::WriteAllText($path,(ConvertFrom-SecureString $secret));$secret.Dispose()
if([IO.File]::ReadAllText($path).Contains('a'*64)){throw 'plaintext-stored'}
Write-Output 'SYNTHETIC_DPAPI_AND_ACL_PASS'
`);
 const pair={version:1,authKind:'materials-mcp-scoped-v1',desktopExe:join(run,'桌面.exe'),profileRoot:join(run,'资料'),baseUrl:'http://127.0.0.1:37418',clientId:'fixture-client',clientName:'素材配对测试',libraryId:'fixture-library',expiresAt:4102444800,scope:['materials.search','materials.inspect','folders.read','materials.import'],credential:'a'.repeat(64)};
 const out=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script,'-Root',root,'-Run',run],{windowsHide:true,encoding:'utf8',input:JSON.stringify(pair),timeout:15000});
 assert.equal(out.trim(),'SYNTHETIC_DPAPI_AND_ACL_PASS');
 const {credential,...metadata}=pair;
 assert.equal(await scopedCredential(validateConfig({...metadata,credentialFile:join(run,'private/credential.dpapi')})),credential);
});
