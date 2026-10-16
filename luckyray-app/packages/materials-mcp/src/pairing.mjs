import {validateConfig,MaterialError} from './transport.mjs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Input arrives on stdin, never argv. Output deliberately excludes the credential.
export function pairingConfig(pair,credentialFile){
 if(!pair||typeof pair!=='object'||Array.isArray(pair)||!/^[a-f0-9]{64}$/.test(pair.credential||''))throw new MaterialError('pairing-invalid');
 const {credential,...metadata}=pair;
 const config=validateConfig({...metadata,credentialFile});
 if(config.expiresAt<=Date.now()/1000)throw new MaterialError('pairing-expired');
 return config;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let input='';
 process.stdin.setEncoding('utf8');
 process.stdin.on('data',chunk=>{input+=chunk;if(input.length>16384){input='';process.stderr.write('pairing-too-large\n');process.exit(1);}});
 process.stdin.on('end',()=>{try{const config=pairingConfig(JSON.parse(input.replace(/^\uFEFF/,'')),process.argv[2]);input='';process.stdout.write(JSON.stringify(config));}catch(e){process.stderr.write((e instanceof MaterialError?e.code:'pairing-invalid')+'\n');process.exitCode=1;}});
}
