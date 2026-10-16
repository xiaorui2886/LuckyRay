"""Offline JSON Schema 2020-12 validation of representative synthetic responses."""
import json
import re
from pathlib import Path
import subprocess
from urllib.parse import urlsplit, parse_qsl, unquote_to_bytes

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

safe_formats = FormatChecker()

@safe_formats.checks("safe-web-url")
def safe_web_url(value):
    if not isinstance(value, str):
        return False
    if not value.strip() or len(value) > 2048 or "\\" in value or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return False
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
        return False
    if parsed.path.lower().endswith((".avif", ".gif", ".jpg", ".jpeg", ".m3u8", ".mp4", ".mpd", ".png", ".webm", ".webp")):
        return False
    sensitive = {"access_token", "api_key", "apikey", "auth", "authorization", "bearer", "cookie", "secret", "sig", "signature", "token"}
    def secret(key):
        key = key.lower()
        return key.startswith("x-amz-") or key in sensitive
    fragment = parsed.fragment
    for _ in range(2):
        if re.search(r"%(?![0-9A-Fa-f]{2})", fragment):
            return False
        try:
            fragment = unquote_to_bytes(fragment).decode("utf-8")
        except UnicodeDecodeError:
            return False
    return not any(secret(key) for key, _ in parse_qsl(parsed.query, keep_blank_values=True)) and not any(
        secret(part.split("=", 1)[0]) for part in re.split(r"[?&;]", fragment))

directory = Path(__file__).resolve().parent
schema = json.loads((directory / "schema.json").read_text(encoding="utf-8"))
content_schema = json.loads((directory.parent / "content-v1" / "schema.json").read_text(encoding="utf-8"))
registry = Registry().with_resource(content_schema["$id"], Resource.from_contents(content_schema))
Draft202012Validator.check_schema(schema)
golden = json.loads((directory / "golden.json").read_text(encoding="utf-8"))
source = next(item for item in golden["cases"] if item["name"] == "real-page-provenance")
Draft202012Validator(schema["$defs"]["SafeSource"], format_checker=safe_formats).validate(source["contains"]["source"])
bad = {"captureKind": "web", "pageUrl": "file:///C:/secret"}
assert not Draft202012Validator(schema["$defs"]["SafeSource"], format_checker=safe_formats).is_valid(bad)
secret = {"captureKind": "web", "pageUrl": "https://user:secret@example.com/art?token=private"}
assert not Draft202012Validator(schema["$defs"]["SafeSource"], format_checker=safe_formats).is_valid(secret)
assert safe_web_url("https://example.test/#/work/42")
assert safe_web_url("https://example.test/art?view=42#slide-3")
assert not safe_web_url("https://example.test/#/work?token=secret")
assert not safe_web_url("https://example.test/#/work%3Ftoken%3Dsecret")
assert not safe_web_url("https://example.test/#%ZZ")
assert not safe_web_url("https://example.test/#%FF")
assert not Draft202012Validator(schema["$defs"]["SafeSource"], format_checker=safe_formats).is_valid(
    {"captureKind": "web", "pageKind": "work-page", "siteOrigin": "https://example.test"})

probe = r"""
import { createFixture } from './fixture.mjs';
import { createHash } from 'node:crypto';
const f = createFixture();
const call = (path, options = {}) => {
  const result = f.request({ path, ...options });
  if (result.status < 200 || result.status >= 300) throw new Error(`${path}: ${JSON.stringify(result)}`);
  return result.body;
};
const samples = {
  ServiceCatalog: call('/v1/services'),
  MaterialDetail: call('/v1/services/materials/assets/asset-1'),
  MaterialChangePage: call('/v1/services/materials/changes?after=m:0'),
  VaultPage: call('/v1/services/knowledge/vaults'),
  KnowledgeNotePage: call('/v1/services/knowledge/vaults/vault-1/notes'),
  KnowledgeChangePage: call('/v1/services/knowledge/vaults/vault-1/changes'),
  KnowledgeEditingStatus: call('/v1/services/knowledge/notes/note-1/editing?vault=vault-1'),
  KnowledgeEditingLease: call('/v1/services/knowledge/notes/note-1/editing', {method:'POST',body:{vaultId:'vault-1'}}),
  KnowledgeDirectoryPage: call('/v1/services/knowledge/vaults/vault-1/directories'),
  KnowledgeRelationPage: call('/v1/services/knowledge/notes/note-1/relations?vault=vault-1'),
  KnowledgeMaterialReferencePage: call('/v1/services/knowledge/materials/asset-1/references?vault=vault-1'),
  KnowledgeUniqueReceipt: call('/v1/services/knowledge/notes', {method:'POST',body:{opId:'unique-schema',vaultId:'vault-1',kind:'create',title:'Schema note',content:'Exact text'}}),
  SearchPage: call('/v1/services/search?q=Blue'),
  PresentationReceipt: call('/v1/services/presentation/open', {method:'POST', body:{opId:'open-1',target:{domain:'materials',assetId:'asset-1'}}}),
  MaterialReceipt: call('/v1/services/materials/assets/asset-1', {method:'PATCH', body:{opId:'patch-1',expectedRevision:'asset-r1',name:'Blue'}})
};
const bytes = Buffer.from('text sample');
const sha = createHash('sha256').update(bytes).digest('hex');
const started = call('/v1/services/ingest/jobs', {method:'POST',body:{opId:'upload-1',kind:'file',target:{domain:'knowledge',vaultId:'vault-1',parentRelativePath:'Inbox'},name:'Note',mimeType:'text/plain',sizeBytes:bytes.length,sha256:sha}});
samples.IngestJob = started;
samples.EventHint = f.hints()[0];
console.log(JSON.stringify(samples));
"""
samples = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", probe], cwd=directory, text=True))
for definition, sample in samples.items():
    validator = Draft202012Validator({"$ref": f"#/$defs/{definition}", "$defs": schema["$defs"]}, format_checker=safe_formats, registry=registry)
    validator.validate(sample)
ingest_validator = Draft202012Validator({"$ref": "#/$defs/IngestBegin", "$defs": schema["$defs"]}, format_checker=safe_formats)
base_ingest = {"opId": "schema-1", "kind": "text", "target": {"domain": "materials"},
               "name": "Text", "mimeType": "text/plain", "sizeBytes": 1, "sha256": "a" * 64, "text": "x"}
ingest_validator.validate(base_ingest)
assert not ingest_validator.is_valid({key: val for key, val in base_ingest.items() if key != "text"})
assert not ingest_validator.is_valid({**base_ingest, "kind": "file"})
assert not ingest_validator.is_valid({**base_ingest, "sizeBytes": 0})
def new_validator(name):
    return Draft202012Validator({"$ref": f"#/$defs/{name}", "$defs": schema["$defs"]}, registry=registry)
creation = {"opId": "unique-schema", "vaultId": "vault-1", "kind": "create", "title": "Note", "content": "Exact bytes"}
for expected in ({}, {"expectedRevision": ""}, {"expectedRevision": None}):
    new_validator("KnowledgeUniqueCreate").validate({**creation, **expected})
assert not new_validator("KnowledgeUniqueCreate").is_valid({**creation, "expectedRevision": "old-revision"})
assert not new_validator("KnowledgeUniqueCreate").is_valid({**creation, "kind": "update"})
assert not new_validator("KnowledgeUniqueCreate").is_valid({**creation, "filesystemPath": "C:/secret"})
new_validator("KnowledgeEditingOpen").validate({"vaultId": "vault-1"})
assert not new_validator("KnowledgeEditingOpen").is_valid({"vaultId": "vault-1", "sessionId": "caller"})
editing = {"vaultId": "vault-1", "sessionId": "a" * 32, "generation": 1, "editing": True}
new_validator("KnowledgeEditingSet").validate(editing)
for generation in (0, -1, 1.5, 9007199254740992):
    assert not new_validator("KnowledgeEditingSet").is_valid({**editing, "generation": generation})
print(f"schema: PASS (draft 2020-12, {len(samples)} new response DTOs, source positive/negative)")
