// Explicit evidence scope: omission always retains the original full-chain checks.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

export function preservationPolicy(context){
  const mode=context.evidenceMode??'full-integration';
  assert.ok(['full-integration','dsh-only'].includes(mode),'unknown evidence scope');
  if(mode==='full-integration'){
    const {originalGrant,originalAuthorityBytes,authorityFingerprints}=context;
    assert.ok(originalGrant&&originalAuthorityBytes&&typeof authorityFingerprints==='function','full integration requires real grant evidence');
    return {mode,result:{settingsAndGrantPreserved:true},verify:async invoke=>{
      const grant=await invoke('community_mcp_status');assert.equal(grant.authorized,true);assert.deepEqual(grant.grant,originalGrant);
      assert.deepEqual(await authorityFingerprints(),originalAuthorityBytes);
    }};
  }
  for(const key of ['originalGrant','originalAuthorityBytes','authorityFingerprints'])assert.equal(Object.hasOwn(context,key),false,'DSH-only must not accept manufactured grant evidence');
  const verify=async()=>{
    assert.equal(existsSync(join(context.paths.local,'com.luckyray.desktop/community-web-mcp-v1')),false,'DSH-only must not initialize or authorize community MCP');
  };
  return {mode,verify,result:{evidenceMode:mode,settingsPreserved:true,communityMcpAuthorization:'NOT_APPLICABLE_TO_DSH_ONLY',desktopAtoB:'NOT_RUN'}};
}
