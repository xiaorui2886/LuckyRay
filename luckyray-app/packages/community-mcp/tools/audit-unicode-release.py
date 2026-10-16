#!/usr/bin/env python3
"""Bounded 0.1.0 -> 0.1.1 artifact audit; no profile or credential input."""
import argparse, hashlib, json, pathlib, re, zipfile

BASE_SHA256 = 'b64a6c549c288b0c97a851082b1445852c1bd016c1e85cb390283bab6ce22b41'
def sha(data): return hashlib.sha256(data).hexdigest()
def files(path):
    with zipfile.ZipFile(path) as archive:
        assert len(archive.namelist()) == len(set(archive.namelist()))
        return {row.filename: archive.read(row) for row in archive.infolist() if not row.is_dir()}
def lf(data): return data.replace(b'\r\n', b'\n')

def audit(package, base):
    assert sha(base.read_bytes()) == BASE_SHA256, 'immutable published base required'
    old, new = files(base), files(package)
    assert set(new) == set(old), 'no new runtime, user state or files'
    transport = 'packages/materials-mcp/src/transport.mjs'
    prefix = b' const command=`$ports='
    replacement = (b' // Node decodes stdout as UTF-8. Windows PowerShell otherwise emits the local\n'
        b' // code page, corrupting non-ASCII executable paths before exact identity checks.\n'
        b' const command=`[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); $ports=')
    assert lf(old[transport]).count(prefix) == 1
    assert lf(new[transport]) == lf(old[transport]).replace(prefix, replacement), 'transport change exceeds UTF-8 fix'
    server = 'packages/community-mcp/src/server.mjs'
    assert old[server].count(b'"0.1.0-candidate.2"') == 1
    assert lf(new[server]) == lf(old[server]).replace(b'"0.1.0-candidate.2"', b'"0.1.1"'), 'server change exceeds version'
    changed = {name for name in old if old[name] != new[name]}
    assert changed == {transport, server, 'inventory.json', 'README.zh-CN.md', 'COMPONENTS.json', 'NOTICE.txt', 'LICENSES.txt'}, changed
    for name in ['NOTICE.txt', 'LICENSES.txt']:
        assert lf(new[name]) == lf(old[name]).replace(b'runtime 0.1.0', b'runtime 0.1.1', 1)
    components = json.loads(new['COMPONENTS.json'])
    assert components['version'] == '0.1.1' and not components['includedUserState']
    assert components['components'] == json.loads(old['COMPONENTS.json'])['components']
    inventory = json.loads(new['inventory.json'])
    assert inventory['schemaVersion'] == 1 and inventory['version'] == '0.1.1'
    assert set(new) == {row['path'] for row in inventory['files']} | {'inventory.json'}
    for row in inventory['files']:
        data = new[row['path']]
        assert len(data) == row['bytes'] and sha(data) == row['sha256'], row['path']
    forbidden = re.compile(rb'(?:C:[/\\]Users[/\\]Administrator|D:[/\\]codex|xiaorui2886/luckyray-app|sk-(?:proj-)?[A-Za-z0-9_-]{24,})')
    for name, data in new.items():
        assert not any(part in pathlib.PurePosixPath(name).parts for part in ['..', '.git', 'private', 'logs'])
        assert not name.endswith(('.db', '.sqlite', '.dpapi', '.log', '.yaml', '.yml'))
        if not name.endswith('.exe'): assert not forbidden.search(data), 'private state pattern: ' + name
    licenses = [name for name in old if name.startswith('licenses/')]
    assert all(new[name] == old[name] for name in licenses), 'third-party license drift'
    binaries = [name for name in old if name.endswith('.exe')]
    assert all(new[name] == old[name] for name in binaries), 'vendor binary drift'
    return {'status': 'PASS_BOUNDED_UNICODE_RELEASE', 'version': '0.1.1',
        'baseSha256': BASE_SHA256, 'archiveSha256': sha(package.read_bytes()),
        'archiveBytes': package.stat().st_size, 'inventorySha256': sha(new['inventory.json']),
        'payloadFiles': len(inventory['files']), 'changedFiles': sorted(changed),
        'unchangedVendorExecutables': len(binaries), 'unchangedLicenseFiles': len(licenses),
        'includedUserState': False, 'authenticationAndProtocolUnchanged': True}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['package', 'base', 'report']: parser.add_argument('--' + name, type=pathlib.Path, required=True)
    args = parser.parse_args()
    result = audit(args.package, args.base)
    args.report.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2))
