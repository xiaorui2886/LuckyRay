#!/usr/bin/env python3
"""Audit only the selected runtime ZIP and pinned public upstream archives.

Never reads user profiles or credential files. The report contains hashes,
public upstream identities and counts, not the contents of runtime files.
"""
import argparse, hashlib, json, pathlib, re, zipfile

def digest(b):
    return hashlib.sha256(b).hexdigest()

def files(path):
    with zipfile.ZipFile(path) as z:
        assert len(z.namelist()) == len(set(z.namelist()))
        return {i.filename: z.read(i) for i in z.infolist() if not i.is_dir()}

def audit(package, candidate, vendor):
    current, previous = files(package), files(candidate)
    assert digest(candidate.read_bytes()) == '2de19de0eca2c2a1af4f12523c8f1217ba4de56723a63678ed654825fb3384e6'
    node_zip = vendor/'node-v24.14.1-win-x64.zip'
    tunnel_zip = vendor/'tunnel-client-runtime-cloudflared-v0.0.16-windows-amd64.zip'
    assert digest(node_zip.read_bytes()) == '6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70'
    assert digest(tunnel_zip.read_bytes()) == '02346814ccd0a9a7a4e6d3d494e225c2befb095ede0c46cbe8d71a8d952acfcc'
    node, tunnel = files(node_zip), files(tunnel_zip)
    assert current['node.exe'] == node['node-v24.14.1-win-x64/node.exe']
    assert current['licenses/node-LICENSE.txt'] == node['node-v24.14.1-win-x64/LICENSE']
    for name in ['tunnel-client-runtime-cloudflared.exe', 'cloudflared.exe', 'cloudflared-manifest.json']:
        assert current[name] == tunnel[name]
    for name in ['LICENSE', 'NOTICE', 'tunnel-client-runtime-cloudflared-v0.0.16-windows-amd64-licenses.txt', 'tunnel-client-runtime-cloudflared-v0.0.16-windows-amd64.spdx.json']:
        assert current['licenses/tunnel-'+name] == tunnel[name]
    runtime = [n for n in previous if n.endswith(('.exe', '.mjs', '.ps1'))]
    for name in runtime:
        assert current[name] == previous[name], name
    inv = json.loads(current['inventory.json'])
    assert inv['version'] == '0.1.0'
    assert set(current) == {r['path'] for r in inv['files']} | {'inventory.json'}
    for row in inv['files']:
        data = current[row['path']]
        assert row['bytes'] == len(data) and row['sha256'] == digest(data), row['path']
    # The reviewed runtime allowlist plus the four distribution documents is
    # complete: no profiles, .git, databases, development logs or extra files.
    assert set(current) == set(previous) | {'NOTICE.txt', 'COMPONENTS.json', 'README.zh-CN.md'}
    forbidden = re.compile(rb'(?:C:[/\\]Users[/\\]Administrator|D:[/\\]codex|xiaorui2886/luckyray-app|tunnel_6ad09d|sk-(?:proj-)?[A-Za-z0-9_-]{24,})')
    for name, data in current.items():
        assert not any(p in pathlib.PurePosixPath(name).parts for p in ['..', '.git', 'private', 'logs'])
        assert not name.endswith(('.db', '.sqlite', '.dpapi', '.log', '.yaml', '.yml'))
        if not name.endswith('.exe'):
            assert not forbidden.search(data), 'private state pattern in '+name
    rows = json.loads(current['licenses/licenses-evidence.json'])
    report = current['licenses/tunnel-tunnel-client-runtime-cloudflared-v0.0.16-windows-amd64-licenses.txt'].decode()
    expected = set(line.split('|')[4] for line in report.splitlines() if line.count('|') == 5 and not line.startswith('DEPENDENCY'))
    assert len(rows) == 108 and {r['path'] for r in rows} == expected
    texts = current['licenses/THIRD_PARTY_LICENSES.txt'].decode().replace('\r\n', '\n')
    # collect-licenses.py joins exact upstream texts with two newlines.
    for index, row in enumerate(rows):
        start = '===== '+row['path']+' =====\nSource: '+row['url']+'\n\n'
        offset = texts.index(start)+len(start)
        end = texts.index('\n\n===== ', offset) if index+1 < len(rows) else len(texts)
        assert digest(texts[offset:end].encode()) == row['sha256'], row['path']
    return {'outcome':'DISTRIBUTION_CONTENT_AND_VENDOR_AUDIT_PASS', 'version':inv['version'],
        'archiveBytes':package.stat().st_size, 'archiveSha256':digest(package.read_bytes()),
        'inventorySha256':digest(current['inventory.json']), 'payloadFiles':len(inv['files']),
        'unchangedAcceptedRuntimeFiles':len(runtime), 'vendorArchivesByteMatched':True,
        'fullDependencyLicenseTextsVerified':len(rows), 'extraUserStateFiles':0,
        'sourceTreeOrDatabaseIncluded':False}

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    for arg in ['package','candidate','vendor','report']:
        p.add_argument('--'+arg, type=pathlib.Path, required=True)
    a = p.parse_args()
    result = audit(a.package, a.candidate, a.vendor)
    a.report.write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(result, indent=2))
