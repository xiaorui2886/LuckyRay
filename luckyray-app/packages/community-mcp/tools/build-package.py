#!/usr/bin/env python3
"""Build a deterministic optional Windows package. Does not publish or install.
Vendor ZIPs must match the pinned official release bytes. Inputs never include
user profiles, private gateway configuration, credentials, notes or databases.
"""
import argparse, hashlib, json, pathlib, zipfile
VERSION='0.1.3'
ARTIFACT_URL='https://github.com/xiaorui2886/LuckyRay/releases/download/mcp-v0.1.3/luckyray-web-mcp-0.1.3-windows-x64.zip'
BASE_SHA256='ec8ecfb6c73af6d2d807d1ff00fdfcdafaed79e6ae86c332dfbd04279049cfa2'
NODE='node-v24.14.1-win-x64.zip'
TUNNEL='tunnel-client-runtime-cloudflared-v0.0.16-windows-amd64.zip'
PINS={NODE:'6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70',TUNNEL:'02346814ccd0a9a7a4e6d3d494e225c2befb095ede0c46cbe8d71a8d952acfcc'}
def sha(data):return hashlib.sha256(data).hexdigest()
def zip_members(path):
    raw=path.read_bytes()
    if sha(raw)!=PINS[path.name]:raise ValueError('vendor checksum mismatch: '+path.name)
    with zipfile.ZipFile(path) as z:
        files={}
        for i in z.infolist():
            p=pathlib.PurePosixPath(i.filename)
            if p.is_absolute() or '..' in p.parts or '\\' in i.filename:raise ValueError('unsafe vendor ZIP')
            if i.is_dir():continue
            if i.file_size>160*1024*1024:raise ValueError('oversize vendor entry')
            files[i.filename]=z.read(i)
        return files

def vendor_payload(vendor):
    node=zip_members(vendor/NODE);tunnel=zip_members(vendor/TUNNEL)
    payload={}
    def single(files,suffix):
        matches=[(n,b) for n,b in files.items() if n==suffix or n.endswith('/'+suffix)]
        if len(matches)!=1:raise ValueError('missing/ambiguous vendor file: '+suffix)
        return matches[0][1]
    payload['node.exe']=single(node,'node.exe')
    payload['tunnel-client-runtime-cloudflared.exe']=single(tunnel,'tunnel-client-runtime-cloudflared.exe')
    payload['cloudflared.exe']=single(tunnel,'cloudflared.exe')
    payload['licenses/node-LICENSE.txt']=node['node-v24.14.1-win-x64/LICENSE']
    # Preserve all shipped notices, licenses, companion identity and SBOMs. The
    # matching provenance evidence must be reviewed before public distribution.
    for name,data in tunnel.items():
        basename=pathlib.PurePosixPath(name).name
        if basename.endswith('.exe'):continue
        if 'license' in basename.lower() or 'notice' in basename.lower() or basename.endswith('.spdx.json'):
            payload['licenses/tunnel-'+basename]=data
        else:
            # Official companion metadata stays beside the binary, never guessed.
            if basename in payload:raise ValueError('duplicate companion metadata')
            payload[basename]=data
    evidence=json.loads((vendor/'licenses-evidence.json').read_text())
    if len(evidence)!=108 or any(not item.get('sha256') or item.get('error') for item in evidence):
        raise ValueError('incomplete upstream third-party license collection')
    payload['licenses/THIRD_PARTY_LICENSES.txt']=(vendor/'THIRD_PARTY_LICENSES.txt').read_bytes()
    payload['licenses/licenses-evidence.json']=(vendor/'licenses-evidence.json').read_bytes()
    return payload

def build(vendor,source,out,base_package=None):
    if base_package is not None:
        # Reuse the exact reviewed candidate's vendor bytes and license evidence.
        # This is a maintainer build input, never an installation bypass.
        raw=base_package.read_bytes()
        if sha(raw)!=BASE_SHA256:raise ValueError('base candidate checksum mismatch')
        with zipfile.ZipFile(base_package) as z:
            payload={i.filename:z.read(i) for i in z.infolist() if not i.is_dir() and i.filename!='inventory.json'}
    else:
        payload=vendor_payload(vendor)
    for name in ['server.mjs','library.mjs','transport.mjs','protocol.mjs','secret-store.ps1']:
        path='packages/community-mcp/src/'+name;data=(source/path).read_bytes()
        if base_package is None or payload[path].replace(b'\r\n',b'\n')!=data.replace(b'\r\n',b'\n'):
            payload[path]=data.replace(b'\r\n',b'\n')
    for name in ['server.mjs','transport.mjs','materials.mjs','read-credential.ps1','verify-profile.ps1']:
        path='packages/materials-mcp/src/'+name;data=(source/path).read_bytes()
        if base_package is not None:
            if name=='transport.mjs':
                # 0.1.3 narrows the changed shared helper to numeric OS listener
                # discovery. The release audit checks the exact bounded region.
                payload[path]=data.replace(b'\r\n',b'\n')
            elif payload[path].replace(b'\r\n',b'\n')!=data.replace(b'\r\n',b'\n'):
                raise ValueError('base materials implementation changed: '+path)
            # Preserve the existing local client's exact packaged bytes, even
            # when Git checked its unchanged source out with Windows CRLF.
        else:payload[path]=data
    for name in ['LICENSES.txt','NOTICE.txt','COMPONENTS.json','README.zh-CN.md']:
        payload[name]=(source/'packages/community-mcp/distribution'/name).read_bytes().replace(b'\r\n',b'\n')
    inventory={'schemaVersion':1,'version':VERSION,'files':[{'path':n,'bytes':len(b),'sha256':sha(b)} for n,b in sorted(payload.items())]}
    inv=json.dumps(inventory,ensure_ascii=False,separators=(',',':')).encode()
    payload['inventory.json']=inv
    if len(payload)>129 or sum(map(len,payload.values()))>268435456:raise ValueError('package budget exceeded')
    out.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for n,b in sorted(payload.items()):
            info=zipfile.ZipInfo(n,(2026,10,16,0,0,0));info.external_attr=0o100644<<16;info.compress_type=zipfile.ZIP_DEFLATED
            z.writestr(info,b)
    report={'schemaVersion':1,'id':'luckyray.official.web-mcp','version':VERSION,'platform':'windows-x86_64','artifactUrl':ARTIFACT_URL,'artifactSha256':sha(out.read_bytes()),'inventorySha256':sha(inv),'downloadBytes':out.stat().st_size,'maxUnpackedBytes':268435456,'vendorPins':PINS,'publication':'version-pinned optional runtime; verify anonymous readback before desktop release'}
    out.with_suffix('.manifest.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
if __name__=='__main__':
    p=argparse.ArgumentParser();g=p.add_mutually_exclusive_group(required=True);g.add_argument('--vendor',type=pathlib.Path);g.add_argument('--base-package',type=pathlib.Path);p.add_argument('--source',type=pathlib.Path,required=True);p.add_argument('--out',type=pathlib.Path,required=True);a=p.parse_args();build(a.vendor,a.source,a.out,a.base_package)
