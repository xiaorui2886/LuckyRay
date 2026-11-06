"""One-time, hash-pinned projection from the already-public release source asset."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tempfile
import urllib.request
import zipfile

URL = 'https://github.com/xiaorui2886/LuckyRay/releases/download/v1.9.10/LuckyRay-1.9.10-source.zip'
SHA256 = '8abc9578b6699bcfbb53549081c614774994fde2619187ba3b7c496a6a1679f0'
PREFIX = 'LuckyRay-1.9.10/'
root = Path.cwd()
assert (root / '.git').is_dir()
assert subprocess.check_output(['git', 'status', '--porcelain'], text=True) == ''
public_only = ['tests/publicBuildInputs.test.mjs', 'tests/formal-update/installed-chain.mjs',
 'tests/formal-update/Remove-ApprovedEphemeralHttps.ps1', 'tests/formal-update/check-frozen-inputs.mjs',
 'tests/formal-update/Prepare-ApprovedEphemeralHttps.ps1', 'tests/formal-update/Observe-PassiveInstaller.ps1',
 'tests/formal-update/windows-native-encoding.test.mjs', 'tests/formal-update/frozen-inputs.json']
preserved = {name: (root / 'luckyray-app' / name).read_bytes() for name in public_only}
old_modes = {line.split('\t', 1)[1]: line.split(' ', 1)[0] for line in subprocess.check_output(['git', 'ls-files', '-s'], text=True).splitlines()}
with tempfile.TemporaryDirectory(prefix='luckyray-release-source-') as tmp:
    archive = Path(tmp) / 'source.zip'
    urllib.request.urlretrieve(URL, archive)
    data = archive.read_bytes()
    assert len(data) == 157353006
    assert hashlib.sha256(data).hexdigest() == SHA256
    with zipfile.ZipFile(archive) as z:
        assert len(z.namelist()) == len(set(z.namelist()))
        products = []
        materials = []
        for item in z.infolist():
            assert item.filename.startswith(PREFIX)
            relative = item.filename[len(PREFIX):]
            path = PurePosixPath(relative)
            assert not path.is_absolute() and '..' not in path.parts and '\\' not in relative and ':' not in relative
            assert stat.S_IFMT(item.external_attr >> 16) != stat.S_IFLNK
            if item.is_dir() or not relative.startswith('luckyray-app/'):
                continue
            if relative.startswith('luckyray-app/src-tauri/native-video/'):
                materials.append(item)
            else:
                products.append((relative, item))
        assert len(products) == 3390 and len(materials) == 43
        # This is a fresh runner checkout, never an installed or user-data directory.
        shutil.rmtree(root / 'luckyray-app')
        for relative, item in products:
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(item))
            if old_modes.get(relative) == '100755':
                target.chmod(0o755)
for relative, data in preserved.items():
    target = root / 'luckyray-app' / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)

# Remove only private historical review links, leaving the recorded technical scope.
note = root / 'luckyray-app/dsh-host/UPGRADE-0.1.7-rc.2.md'
text = note.read_text()
text, count = re.subn(r'https://github\.com/xiaorui2886/luckyray-app/(?:pull|issues)/[0-9]+#issuecomment-[0-9]+', '#historical-review-scope', text)
assert count == 2
text += '\n## Historical review scope\n\nNon-public historical review links are omitted from this public projection. The recorded candidate results are not a current release approval.\n'
note.write_text(text)

# Synthetic preflight fixture keeps exact-scope validation without publishing a private review URL.
fixture = root / 'luckyray-app/scripts/lsh-reviewed-signing-entry.test.mjs'
text = fixture.read_text()
old = 'writeFileSync(entry, readFileSync(fileURLToPath(new URL("./Start-LshReviewedSigning.ps1", import.meta.url))));'
new = 'writeFileSync(entry, readFileSync(fileURLToPath(new URL("./Start-LshReviewedSigning.ps1", import.meta.url)), "utf8").replace("xiaorui2886/luckyray-app/issues/195", "example/luckyray/issues/195"));'
assert old in text
text = text.replace(old, new)
text, count = re.subn(r'https://github\.com/xiaorui2886/luckyray-app/issues/195#issuecomment-123', 'https://github.com/example/luckyray/issues/195#issuecomment-123', text)
assert count == 1
fixture.write_text(text)
assert json.loads((root / 'luckyray-app/package.json').read_text())['version'] == '1.9.10'
assert json.loads((root / 'luckyray-app/src-tauri/tauri.conf.json').read_text())['version'] == '1.9.10'
subprocess.run(['git', 'add', '-A', 'luckyray-app'], check=True)
subprocess.run(['node', 'scripts/check-public-source.mjs'], check=True)
print(json.dumps({'status': 'PASS', 'productFiles': 3390, 'materialFilesKeptInRelease': 43, 'publicHelpersPreserved': len(preserved), 'publicProjectionAdaptedFiles': 2}))
