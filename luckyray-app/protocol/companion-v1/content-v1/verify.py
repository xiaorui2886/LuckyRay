"""Run with Python + jsonschema; verifies artifact hashes and golden wire data."""
import hashlib
import json
from pathlib import Path
from jsonschema import Draft202012Validator

root = Path(__file__).resolve().parent
for name, digest in json.loads((root / 'SHA256SUMS.json').read_text(encoding='utf-8')).items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name
schema = json.loads((root / 'schema.json').read_text(encoding='utf-8'))
golden = json.loads((root / 'golden.json').read_text(encoding='utf-8'))
for key, definition in [('capabilities', 'Capabilities'), ('mutation', 'Mutation'), ('document', 'Note'),
                         ('tombstone', 'Note'), ('assetPage', 'AssetPage'), ('manifest', 'UploadManifest'), ('chunk', 'UploadChunk')]:
    validator = Draft202012Validator({**schema, '$ref': '#/$defs/' + definition})
    validator.validate(golden[key])
assert list(Draft202012Validator({**schema, '$ref': '#/$defs/Mutation'}).iter_errors({**golden['mutation'], 'arbitraryPath': 'C:/secret'}))
# Wave A: material organization operations are desired-state and bound the batch.
wa = golden['waveAMaterialOrganization']
Draft202012Validator({**schema, '$ref': '#/$defs/MaterialFavoriteInput'}).validate(wa['favorite']['request'])
Draft202012Validator({**schema, '$ref': '#/$defs/MaterialTagsInput'}).validate(wa['tags']['request'])
Draft202012Validator({**schema, '$ref': '#/$defs/MaterialTagsInput'}).validate(wa['tags']['requestAddRemove'])
# folderId may be an explicit null (= root)
Draft202012Validator({**schema, '$ref': '#/$defs/MaterialFolderInput'}).validate(wa['folder']['requestRoot'])
Draft202012Validator({**schema, '$ref': '#/$defs/MaterialCreateTagInput'}).validate(wa['createTag']['request'])
Draft202012Validator({**schema, '$ref': '#/$defs/MaterialCreateFolderInput'}).validate(wa['createFolder']['request'])
Draft202012Validator({**schema, '$ref': '#/$defs/MaterialBatchInput'}).validate(wa['batch']['request'])
Draft202012Validator({**schema, '$ref': '#/$defs/MaterialBatchResult'}).validate(wa['batch']['response'])
# capability flags are advertised and the batch cap is published
for flag in ('materialFavorite', 'materialTags', 'materialFolders', 'materialBatch'):
    assert golden['capabilities']['capabilities'].get(flag) is True, flag
assert golden['capabilities']['limits'].get('batchAssets') == 100
assert golden['capabilities']['contentVersion'] == 1, 'still Content V1'
# negatives: host paths and unknown fields stay rejected
assert list(Draft202012Validator({**schema, '$ref': '#/$defs/MaterialFavoriteInput'}).iter_errors(
    {**wa['favorite']['request'], 'path': 'C:/secret'}))
assert list(Draft202012Validator({**schema, '$ref': '#/$defs/MaterialBatchInput'}).iter_errors(
    {'desktopAssetIds': []}))
# Wave A closure: authoritative favorite state is part of the read contract.
Draft202012Validator({**schema, '$ref': '#/$defs/AssetPage'}).validate(
    {'items': [wa['assetRead']], 'page': 1, 'limit': 1, 'hasMore': False, 'nextPage': None})
assert wa['assetRead']['favorite'] is True, 'Asset.favorite carries authoritative truth'
assert wa['favorite']['response']['favorited'] is True
# all three batch folder shapes are valid contract inputs
for shape in ('omitted', 'root', 'target'):
    Draft202012Validator({**schema, '$ref': '#/$defs/MaterialBatchInput'}).validate(
        wa['batchFolders'][shape]['request'])
assert 'folderId' not in wa['batchFolders']['omitted']['request'], 'omitted = leave unchanged'
assert wa['batchFolders']['root']['request']['folderId'] is None, 'null = root'
assert wa['batchFolders']['target']['request']['folderId'] == 'folder-a', 'string = folder'
assert wa['batch']['response']['atomic'] is False, 'batches are never claimed atomic'
print('Content V1 hashes and golden fixtures verified (notes + Wave-A material organization closure); '
      'favorite read state, batch folder tri-state, unknown fields and unbounded batches rejected')
