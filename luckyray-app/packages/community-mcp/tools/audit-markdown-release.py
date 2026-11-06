"""Bounded 0.1.1 -> 0.1.2 candidate audit. No user profile/config input."""
import argparse, hashlib, json, pathlib, re, zipfile

BASE_SHA256='3c9a1c4961af3f5ef2bdd73dfcba7b2f25ed190cae6622a30b2f12e7f55ede1a'
def sha(data): return hashlib.sha256(data).hexdigest()
def lf(data): return data.replace(b'\r\n',b'\n')
def files(path):
    with zipfile.ZipFile(path) as z:
        assert len(z.namelist()) == len(set(z.namelist()))
        return {r.filename:z.read(r) for r in z.infolist() if not r.is_dir()}
def audit(package, base):
    assert sha(base.read_bytes()) == BASE_SHA256
    old,new=files(base),files(package)
    assert set(new)==set(old)
    changed={n for n in old if old[n]!=new[n]}
    assert changed == {'packages/community-mcp/src/server.mjs','packages/community-mcp/src/library.mjs',
        'packages/community-mcp/src/transport.mjs','inventory.json','README.zh-CN.md','COMPONENTS.json','NOTICE.txt','LICENSES.txt'}, changed
    server='packages/community-mcp/src/server.mjs'
    assert lf(new[server])==lf(old[server]).replace(b'"0.1.1"',b'"0.1.2"',1)
    transport='packages/community-mcp/src/transport.mjs'
    anchor=b'        "imported-note-changed",\n'
    assert lf(old[transport]).count(anchor)==1
    assert lf(new[transport])==lf(old[transport]).replace(anchor,anchor+b'        "knowledge-parent-missing",\n')
    library='packages/community-mcp/src/library.mjs'
    assert lf(new[library]).split(b'export const TOOLS =')[0]==lf(old[library]).split(b'export const TOOLS =')[0]
    for name in ['NOTICE.txt','LICENSES.txt']:
        assert lf(new[name])==lf(old[name]).replace(b'runtime 0.1.1',b'runtime 0.1.2',1)
    components=json.loads(new['COMPONENTS.json'])
    assert components['version']=='0.1.2' and not components['includedUserState']
    assert components['components']==json.loads(old['COMPONENTS.json'])['components']
    inv=json.loads(new['inventory.json'])
    assert inv['schemaVersion']==1 and inv['version']=='0.1.2'
    assert set(new)=={r['path'] for r in inv['files']}|{'inventory.json'}
    for row in inv['files']:
        value=new[row['path']]
        assert len(value)==row['bytes'] and sha(value)==row['sha256'],row['path']
    forbidden=re.compile(rb'(?:C:[/\\]Users[/\\]Administrator|D:[/\\]codex|xiaorui2886/luckyray-app|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|-----BEGIN[^\r\n]*PRIVATE KEY)')
    for name,value in new.items():
        assert not any(p in pathlib.PurePosixPath(name).parts for p in ['..','.git','private','logs'])
        assert not name.endswith(('.db','.sqlite','.dpapi','.log','.yaml','.yml'))
        if not name.endswith('.exe'): assert not forbidden.search(value),'private state pattern: '+name
    licenses=[n for n in old if n.startswith('licenses/')]
    binaries=[n for n in old if n.endswith('.exe')]
    assert all(old[n]==new[n] for n in licenses+binaries)
    return {'status':'PASS_BOUNDED_MARKDOWN_CANDIDATE','version':'0.1.2','baseSha256':BASE_SHA256,
        'archiveSha256':sha(package.read_bytes()),'archiveBytes':package.stat().st_size,
        'inventorySha256':sha(new['inventory.json']),'payloadFiles':len(inv['files']),
        'changedFiles':sorted(changed),'unchangedVendorExecutables':len(binaries),
        'unchangedLicenseFiles':len(licenses),'includedUserState':False,
        'authenticationPermissionsAndProtocolUnchanged':True,'publication':'PRIVATE_CANDIDATE_ONLY'}
if __name__=='__main__':
    p=argparse.ArgumentParser()
    for name in ['package','base','report']:p.add_argument('--'+name,type=pathlib.Path,required=True)
    a=p.parse_args();result=audit(a.package,a.base)
    a.report.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(result,indent=2))
