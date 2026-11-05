#!/usr/bin/env python3
"""T52 S2: build and attest the Linux product sidecars (Linux-only tool).

Mirrors scripts/prepare-native-host.ps1 -Release for x86_64-unknown-linux-gnu
without touching it. The records written here are exactly what the unchanged
build.rs validators (validate_registered_cli_contract and
validate_registered_sidecar_origin_contract) accept; `verify` re-checks them
offline and the CI gate then lets build.rs itself decide.

  sidecars.py build  <src-tauri> <binaries-dir>   cargo build + stage + records
  sidecars.py attest <src-tauri> <binaries-dir>   records for already-staged ELFs
  sidecars.py verify <src-tauri> <binaries-dir>   offline re-check, exit 1 on any mismatch
"""
import base64, hashlib, json, os, shutil, subprocess, sys
from pathlib import Path

TARGET = "x86_64-unknown-linux-gnu"
SIDECARS = ("luckyray-native-host", "luckyray-cli", "luckyray-mcp", "luckyray-browser-host")
CLI_PROTOCOL = "luckyray-cli-contract-v1"
HARDENING = "release-path-remap-v1"
CHANNEL = "private-release-v1"
CLI_INPUTS = ("src/tool_cli.rs", "src/sidecars/luckyray-cli.rs", "Cargo.toml", "Cargo.lock")
ORIGIN_RECORD = "luckyray-sidecars.origin.identity.json"
CLI_FIELDS = ("schemaVersion", "protocol", "identity", "target", "binarySha256",
              "sourceHead", "cargoLockSha256", "profile", "hardening")
ORIGIN_FIELDS = ("schemaVersion", "profile", "target", "origins", "originFingerprint",
                 "canonicalConfigSha256", "manifestPublicKeySha256", "cargoLockSha256", "binaries")


class Refused(Exception):
    pass


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def is_hex64(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def name_for(sidecar):
    return f"{sidecar}-{TARGET}"


def cli_contract_identity(src_tauri):
    """Same digest as build.rs cli_contract_identity."""
    h = hashlib.sha256(b"luckyray-cli-contract-v1\0")
    for rel in CLI_INPUTS:
        data = (Path(src_tauri) / rel).read_bytes()
        h.update(rel.encode() + b"\0" + len(data).to_bytes(8, "little") + data)
    return h.hexdigest()


def canonical_origin(value):
    if not isinstance(value, str) or value.strip() != value or value != value.lower():
        raise Refused("release-extension-origin-invalid")
    origin = value[:-1] if value.endswith("/") else value
    if not origin.startswith("chrome-extension://"):
        raise Refused("release-extension-origin-invalid")
    ext = origin[len("chrome-extension://"):]
    if len(ext) != 32 or any(c not in "abcdefghijklmnop" for c in ext):
        raise Refused("release-extension-origin-invalid")
    return origin


def release_origins(app_root):
    """Same result as release_extension_origins::load_canonical_release_origins
    plus resolve_release_origins with no override (Linux takes no override)."""
    if "LUCKYRAY_EXTENSION_ORIGINS" in os.environ:
        raise Refused("Linux sidecar preparation takes no extension origin override")
    raw = (Path(app_root) / "config/release-extension-origins.json").read_bytes()
    config = json.loads(raw)
    if (not isinstance(config, dict) or set(config) != {"schemaVersion", "channel", "origins", "publicKeySha256"}
            or config["schemaVersion"] != 1 or config["channel"] != CHANNEL
            or not is_hex64(config["publicKeySha256"])):
        raise Refused("release-extension-origins-schema-invalid")
    items = config["origins"]
    if not isinstance(items, list) or not items:
        raise Refused("release-extension-origin-empty")
    origins = sorted(canonical_origin(o) for o in items)
    if len(set(origins)) != len(origins):
        raise Refused("release-extension-origin-duplicate")
    if origins != items:
        raise Refused("release-extension-origins-noncanonical")
    manifest = json.loads((Path(app_root) / "browser-extension-prototype/manifest.json").read_bytes())
    key = manifest.get("key") if isinstance(manifest, dict) else None
    try:
        public = base64.b64decode(key, validate=True) if isinstance(key, str) else b""
    except ValueError:
        public = b""
    if len(public) < 128 or base64.b64encode(public).decode() != key:
        raise Refused("release-extension-manifest-key-invalid")
    key_sha = hashlib.sha256(public).hexdigest()
    ext_id = "".join("abcdefghijklmnop"[b >> 4] + "abcdefghijklmnop"[b & 15]
                     for b in hashlib.sha256(public).digest()[:16])
    if config["publicKeySha256"] != key_sha or origins != [f"chrome-extension://{ext_id}"]:
        raise Refused("release-extension-origins-manifest-mismatch")
    fingerprint = hashlib.sha256(b"".join(o.encode() + b"\0" for o in origins)).hexdigest()
    return {"origins": origins, "originFingerprint": fingerprint,
            "canonicalConfigSha256": hashlib.sha256(raw).hexdigest(), "manifestPublicKeySha256": key_sha}


def assert_elf(path, name):
    with open(path, "rb") as f:
        head = f.read(20)
    # ELF, 64-bit, little-endian, x86-64 (e_machine 0x3e).
    if len(head) < 20 or head[:4] != b"\x7fELF" or head[4] != 2 or head[5] != 1 or head[18:20] != b"\x3e\x00":
        raise Refused(f"built sidecar is not an x86-64 ELF: {name}")
    if os.path.islink(path) or not os.access(path, os.X_OK):
        raise Refused(f"built sidecar is not an executable regular file: {name}")


def forbidden_paths(app_root):
    out = {str(Path(app_root).resolve()), "/home/runner/"}
    home = os.environ.get("HOME", "")
    if len(home) > 1:
        out.add(home.rstrip("/") + "/")
    return sorted(out)


def assert_hygiene(path, app_root):
    data = Path(path).read_bytes()
    for needle in forbidden_paths(app_root):
        if needle.encode() in data:
            raise Refused("release luckyray-cli contains a disallowed user or build absolute path")


def write_json(path, value):
    stage = Path(str(path) + f".stage-{os.getpid()}")
    stage.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(stage, 0o644)
    os.replace(stage, path)


def publish(source, destination):
    stage = Path(str(destination) + f".stage-{os.getpid()}")
    shutil.copyfile(source, stage)
    os.chmod(stage, 0o755)
    if sha256(stage) != sha256(source):
        stage.unlink()
        raise Refused(f"staged sidecar hash mismatch: {Path(destination).name}")
    os.replace(stage, destination)
    return sha256(destination)


def source_head(app_root):
    head = subprocess.run(["git", "-C", str(app_root), "rev-parse", "HEAD"], check=True,
                          capture_output=True, text=True).stdout.strip()
    if len(head) != 40:
        raise Refused("source head unavailable")
    return head


def cli_identity_from_binary(cli):
    out = subprocess.run([str(cli), "protocol", "identity"], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise Refused("built luckyray-cli did not accept the fixed protocol identity command")
    try:
        value = json.loads(out.stdout)
    except ValueError:
        raise Refused("built luckyray-cli returned an invalid protocol identity")
    if value.get("ok") is not True or value.get("protocol") != CLI_PROTOCOL or not is_hex64(value.get("identity")):
        raise Refused("built luckyray-cli returned an invalid protocol identity")
    return value["identity"]


def attest(src_tauri, binaries, identity_of=cli_identity_from_binary, head=None):
    src_tauri, binaries = Path(src_tauri).resolve(), Path(binaries)
    app_root = src_tauri.parent
    origins = release_origins(app_root)
    expected = cli_contract_identity(src_tauri)
    shas = {}
    for sidecar in SIDECARS:
        path = binaries / name_for(sidecar)
        assert_elf(path, sidecar)
        shas[sidecar] = sha256(path)
    cli = binaries / name_for("luckyray-cli")
    assert_hygiene(cli, app_root)
    identity = identity_of(cli)
    if identity != expected:
        raise Refused("built luckyray-cli identity does not match the current source contract")
    lock = sha256(src_tauri / "Cargo.lock")
    write_json(binaries / (name_for("luckyray-cli") + ".identity.json"), {
        "schemaVersion": 1, "protocol": CLI_PROTOCOL, "identity": identity, "target": TARGET,
        "binarySha256": shas["luckyray-cli"], "sourceHead": head or source_head(app_root),
        "cargoLockSha256": lock, "profile": "release", "hardening": HARDENING})
    write_json(binaries / ORIGIN_RECORD, {
        "schemaVersion": 1, "profile": "release", "target": TARGET, **origins, "cargoLockSha256": lock,
        "binaries": [{"name": n, "sha256": shas[n]} for n in sorted(SIDECARS)]})
    return shas


def verify(src_tauri, binaries):
    src_tauri, binaries = Path(src_tauri).resolve(), Path(binaries)
    app_root = src_tauri.parent
    origins = release_origins(app_root)
    lock = sha256(src_tauri / "Cargo.lock")
    expected = {name_for(s) for s in SIDECARS} | {name_for("luckyray-cli") + ".identity.json", ORIGIN_RECORD}
    present = {p.name for p in binaries.iterdir() if p.name != ".gitignore"}
    if present != expected:
        raise Refused("binaries directory must hold exactly the four sidecars and two records")
    shas = {}
    for sidecar in SIDECARS:
        path = binaries / name_for(sidecar)
        assert_elf(path, sidecar)
        shas[sidecar] = sha256(path)
    assert_hygiene(binaries / name_for("luckyray-cli"), app_root)
    cli = json.loads((binaries / (name_for("luckyray-cli") + ".identity.json")).read_text())
    if (not isinstance(cli, dict) or tuple(cli) != CLI_FIELDS or cli["schemaVersion"] != 1
            or cli["protocol"] != CLI_PROTOCOL or cli["identity"] != cli_contract_identity(src_tauri)
            or cli["target"] != TARGET or cli["binarySha256"] != shas["luckyray-cli"]
            or cli["cargoLockSha256"] != lock or cli["profile"] != "release" or cli["hardening"] != HARDENING
            or not (isinstance(cli["sourceHead"], str) and len(cli["sourceHead"]) == 40)):
        raise Refused("luckyray-cli identity record does not match")
    rec = json.loads((binaries / ORIGIN_RECORD).read_text())
    want = {"schemaVersion": 1, "profile": "release", "target": TARGET, **origins, "cargoLockSha256": lock,
            "binaries": [{"name": n, "sha256": shas[n]} for n in sorted(SIDECARS)]}
    if not isinstance(rec, dict) or tuple(rec) != ORIGIN_FIELDS or rec != want:
        raise Refused("sidecar origin attestation does not match")
    return shas


def build_env(app_root, base=None):
    env = dict(os.environ if base is None else base)
    if "LUCKYRAY_EXTENSION_ORIGINS" in env:
        raise Refused("Linux sidecar preparation takes no extension origin override")
    root = str(Path(app_root).resolve())
    home = env.get("HOME", "").rstrip("/")
    maps = ([f"{home}=."] if len(home) > 1 else []) + [f"{root}=."]
    # Last matching remap wins in rustc, so the source root (more specific) is last.
    flags = ["-C", "strip=symbols"] + [f"--remap-path-prefix={m}" for m in maps]
    prior = env.get("CARGO_ENCODED_RUSTFLAGS", "")
    env["CARGO_ENCODED_RUSTFLAGS"] = "\x1f".join(([prior] if prior else []) + flags)
    cflags = ["-DNDEBUG"] + [f"-ffile-prefix-map={m}" for m in maps]
    for var in ("CFLAGS_x86_64_unknown_linux_gnu", "CFLAGS"):
        env[var] = " ".join(filter(None, [env.get(var, "")] + cflags))
    env["TAURI_CONFIG"] = '{"build":{"frontendDist":"../dist"},"bundle":{"externalBin":[],"resources":[]}}'
    env["LUCKYRAY_SIDECAR_PREPARE"] = "1"  # only this controlled compilation skips the record preflight
    return env


def cargo_args():
    args = ["cargo", "build", "--locked", "--release", "--features", "sidecar-binaries", "--target", TARGET]
    for sidecar in SIDECARS:
        args += ["--bin", sidecar]
    return args


def build(src_tauri, binaries):
    src_tauri, binaries = Path(src_tauri).resolve(), Path(binaries)
    if not (src_tauri / "media-engine/runtime-manifest.json").is_file():
        raise Refused("release sidecar compilation needs the prepared media engine")
    env = build_env(src_tauri.parent)
    subprocess.run(cargo_args(), cwd=src_tauri, env=env, check=True)
    target_dir = Path(env.get("CARGO_TARGET_DIR") or src_tauri / "target")
    if not target_dir.is_absolute():
        target_dir = src_tauri / target_dir
    binaries.mkdir(parents=True, exist_ok=True)
    for sidecar in SIDECARS:
        source = target_dir / TARGET / "release" / sidecar
        assert_elf(source, sidecar)
        publish(source, binaries / name_for(sidecar))
    return attest(src_tauri, binaries)


def main(argv):
    if len(argv) != 4 or argv[1] not in ("build", "attest", "verify"):
        print(__doc__, file=sys.stderr)
        return 2
    try:
        shas = {"build": build, "attest": attest, "verify": verify}[argv[1]](argv[2], argv[3])
    except (Refused, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"linux sidecars refused: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"status": "PASS", "target": TARGET, "sidecars": shas}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
