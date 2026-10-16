#[path = "src/release_extension_origins.rs"]
mod release_extension_origins;
#[allow(dead_code)]
#[path = "src/dsh_update_metadata_policy.rs"]
mod dsh_update_metadata_policy;
mod native_video_build;

const PRODUCT_SIDECARS: [&str; 4] = [
    "luckyray-native-host",
    "luckyray-cli",
    "luckyray-mcp",
    "luckyray-browser-host",
];
const CLI_PROTOCOL: &str = "luckyray-cli-contract-v1";
const CLI_RELEASE_HARDENING: &str = "release-path-remap-v1";
const DEV_SIDECAR_PLACEHOLDER: &[u8] =
    b"MZ\nLuckyRay debug sidecar placeholder. Run pnpm.cmd build:sidecars before bundling.\n";

fn sha256_file(path: &std::path::Path) -> String {
    use sha2::Digest;
    let bytes = std::fs::read(path).expect("read agent engine identity file");
    format!("{:x}", sha2::Sha256::digest(bytes))
}

fn dsh_update_contract_fingerprint(
    root: &std::path::Path,
    domain: &[u8],
    files: &[&str],
) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(domain);
    digest.update([0]);
    for relative in files {
        let path = root.join(relative);
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = std::fs::read(&path).expect("read DSH update contract source");
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    format!("{:x}", digest.finalize())
}

fn configure_dsh_update_trust(profile: &str) {
    let config_path = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"))
        .parent().expect("application root").join("config/dsh-production-update-source.json");
    println!("cargo:rerun-if-changed={}", config_path.display());
    let config: serde_json::Value = serde_json::from_slice(&std::fs::read(&config_path).expect("production source config"))
        .expect("production source config JSON");
    let environment: Vec<_> = ["LUCKYRAY_DSH_UPDATE_FEED", "LUCKYRAY_DSH_UPDATE_PUBLIC_KEY", "LUCKYRAY_DEV_DSH_UPDATE_FEED",
        "LUCKYRAY_DEV_DSH_UPDATE_PUBLIC_KEY", "LUCKYRAY_DEV_DSH_UPDATE_CA_PEM"].into_iter()
        .filter(|name| std::env::var_os(name).is_some()).collect();
    let approved = dsh_update_metadata_policy::reviewed_production_key(&config, &environment)
        .expect("reviewed production source configuration");
    println!("cargo:rerun-if-env-changed=LUCKYRAY_DEV_DSH_UPDATE_CA_PEM");
    let (feed_name, key_name, trust_class) = if profile == "release" {
        (
            "LUCKYRAY_DSH_UPDATE_FEED",
            "LUCKYRAY_DSH_UPDATE_PUBLIC_KEY",
            "production",
        )
    } else {
        (
            "LUCKYRAY_DEV_DSH_UPDATE_FEED",
            "LUCKYRAY_DEV_DSH_UPDATE_PUBLIC_KEY",
            "development",
        )
    };
    for name in [
        "LUCKYRAY_DSH_UPDATE_FEED",
        "LUCKYRAY_DSH_UPDATE_PUBLIC_KEY",
        "LUCKYRAY_DEV_DSH_UPDATE_FEED",
        "LUCKYRAY_DEV_DSH_UPDATE_PUBLIC_KEY",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    if let Some(key) = approved {
        for name in ["LUCKYRAY_DSH_UPDATE_FEED", "LUCKYRAY_DSH_UPDATE_PUBLIC_KEY", "LUCKYRAY_DEV_DSH_UPDATE_FEED",
            "LUCKYRAY_DEV_DSH_UPDATE_PUBLIC_KEY", "LUCKYRAY_DEV_DSH_UPDATE_CA_PEM"] {
            assert!(std::env::var_os(name).is_none(), "reviewed production source cannot mix environment trust or development CA");
        }
        println!("cargo:rustc-env=LUCKYRAY_DSH_UPDATE_TRUST_CLASS=production");
        println!("cargo:rustc-env=LUCKYRAY_DSH_UPDATE_FEED={}", dsh_update_metadata_policy::FEED);
        println!("cargo:rustc-env=LUCKYRAY_DSH_UPDATE_PUBLIC_KEY={key}");
        return;
    }
    // Production trust is source-reviewed and identical in ordinary debug and
    // release builds. Environment overrides cannot invent a production root.
    if std::env::var_os("LUCKYRAY_DSH_UPDATE_FEED").is_some() || std::env::var_os("LUCKYRAY_DSH_UPDATE_PUBLIC_KEY").is_some() {
        panic!("production update trust requires reviewed source configuration");
    }
    if profile == "release"
        && (std::env::var_os("LUCKYRAY_DEV_DSH_UPDATE_FEED").is_some()
            || std::env::var_os("LUCKYRAY_DEV_DSH_UPDATE_PUBLIC_KEY").is_some()
            || std::env::var_os("LUCKYRAY_DEV_DSH_UPDATE_CA_PEM").is_some())
    {
        panic!("release builds reject development DSH update trust configuration");
    }
    if profile != "release"
        && (std::env::var_os("LUCKYRAY_DSH_UPDATE_FEED").is_some()
            || std::env::var_os("LUCKYRAY_DSH_UPDATE_PUBLIC_KEY").is_some())
    {
        panic!("development builds reject production DSH update trust configuration");
    }
    let feed = std::env::var(feed_name).ok();
    let key = std::env::var(key_name).ok();
    match (feed, key) {
        (None, None) => {
            if std::env::var_os("LUCKYRAY_DEV_DSH_UPDATE_CA_PEM").is_some() {
                panic!("development DSH CA requires a configured development feed");
            }
            println!("cargo:rustc-env=LUCKYRAY_DSH_UPDATE_TRUST_CLASS=unconfigured");
        }
        (Some(feed), Some(key)) => {
            if !feed.starts_with("https://")
                || feed.len() > 512
                || feed.bytes().any(|c| c == b'\r' || c == b'\n')
                || key.len() != 43
                || !key
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            {
                panic!("DSH update trust configuration has an invalid public feed or key");
            }
            println!("cargo:rustc-env=LUCKYRAY_DSH_UPDATE_TRUST_CLASS={trust_class}");
            println!("cargo:rustc-env=LUCKYRAY_DSH_UPDATE_FEED={feed}");
            println!("cargo:rustc-env=LUCKYRAY_DSH_UPDATE_PUBLIC_KEY={key}");
            if profile != "release" {
                if let Some(path) = std::env::var_os("LUCKYRAY_DEV_DSH_UPDATE_CA_PEM") {
                    if !feed.starts_with("https://127.0.0.1:")
                        && !feed.starts_with("https://localhost:") {
                        panic!("development DSH CA is only allowed for a loopback feed");
                    }
                    use base64::Engine as _;
                    let bytes = std::fs::read(&path).expect("read development DSH CA PEM");
                    if bytes.is_empty() || bytes.len() > 16 * 1024
                        || !bytes.starts_with(b"-----BEGIN CERTIFICATE-----") {
                        panic!("development DSH CA PEM is invalid");
                    }
                    println!("cargo:rerun-if-changed={}", std::path::Path::new(&path).display());
                    println!("cargo:rustc-env=LUCKYRAY_DSH_UPDATE_DEV_CA_B64={}",
                        base64::engine::general_purpose::STANDARD.encode(bytes));
                }
            }
        }
        _ => panic!("DSH update trust feed and public key must be configured together"),
    }
}

/// A deterministic source/build binding for the only app-owned CLI sidecar
/// protocol exposed to R8.  The value is compiled into both the desktop
/// Backend and `luckyray-cli`; a registered binary produced from a different
/// command surface or lockfile cannot silently satisfy the protocol gate.
fn cli_contract_identity(manifest_dir: &std::path::Path) -> String {
    use sha2::{Digest, Sha256};

    let mut digest = Sha256::new();
    digest.update(b"luckyray-cli-contract-v1\0");
    for relative in [
        "src/tool_cli.rs",
        "src/sidecars/luckyray-cli.rs",
        "Cargo.toml",
        "Cargo.lock",
    ] {
        let path = manifest_dir.join(relative);
        let bytes = std::fs::read(&path).expect("read LuckyRay CLI contract input");
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    format!("{:x}", digest.finalize())
}

/// Release/package builds cannot merely check that a PE exists. The registered
/// CLI externalBin must have been staged from the exact source command surface
/// and Cargo.lock used to compile this Backend. Runtime performs the matching
/// no-side-effect handshake again before it accepts a verifier result.
fn validate_registered_cli_contract(
    manifest_dir: &std::path::Path,
    target: &str,
    expected_identity: &str,
) {
    let binary_name = format!("luckyray-cli-{target}.exe");
    let binary = manifest_dir.join("binaries").join(&binary_name);
    let record = manifest_dir
        .join("binaries")
        .join(format!("{binary_name}.identity.json"));
    let raw = std::fs::read_to_string(&record).unwrap_or_else(|_| {
        panic!(
            "release builds require a prepared {binary_name} identity record; run the controlled sidecar preparation"
        )
    });
    let value: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|_| panic!("release builds require a valid {binary_name} identity record"));
    if !binary.is_file() {
        panic!(
            "release builds require the prepared registered {binary_name}; run the controlled sidecar preparation"
        );
    }
    let expected_binary_sha = sha256_file(&binary);
    let valid = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        == Some(1)
        && value.get("protocol").and_then(serde_json::Value::as_str) == Some(CLI_PROTOCOL)
        && value.get("identity").and_then(serde_json::Value::as_str) == Some(expected_identity)
        && value.get("target").and_then(serde_json::Value::as_str) == Some(target)
        && value
            .get("binarySha256")
            .and_then(serde_json::Value::as_str)
            == Some(expected_binary_sha.as_str())
        && value.get("profile").and_then(serde_json::Value::as_str) == Some("release")
        && value.get("hardening").and_then(serde_json::Value::as_str)
            == Some(CLI_RELEASE_HARDENING);
    if !valid {
        panic!(
            "release {binary_name} does not match the current LuckyRay CLI protocol/build identity; rerun controlled sidecar preparation"
        );
    }
}

/// A release sidecar has its own compile-time LocalTransport allowlist. This
/// generated attestation is not a second source of configuration: it proves
/// that every registered externalBin was staged under the exact canonical
/// config/override that this desktop build resolved independently.
fn validate_registered_sidecar_origin_contract(
    manifest_dir: &std::path::Path,
    target: &str,
    canonical: &release_extension_origins::CanonicalReleaseOrigins,
    effective: &release_extension_origins::EffectiveReleaseOrigins,
) {
    use std::collections::BTreeSet;

    let binaries_dir = manifest_dir.join("binaries");
    let record = binaries_dir.join("luckyray-sidecars.origin.identity.json");
    let raw = std::fs::read_to_string(&record).unwrap_or_else(|_| {
        panic!(
            "release builds require a prepared sidecar origin attestation; run the controlled sidecar preparation"
        )
    });
    let value: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|_| panic!("release builds require a valid sidecar origin attestation"));
    const FIELDS: [&str; 9] = [
        "schemaVersion",
        "profile",
        "target",
        "origins",
        "originFingerprint",
        "canonicalConfigSha256",
        "manifestPublicKeySha256",
        "cargoLockSha256",
        "binaries",
    ];
    let Some(object) = value.as_object() else {
        panic!("release sidecar origin attestation has an invalid schema");
    };
    if object.len() != FIELDS.len() || FIELDS.iter().any(|field| !object.contains_key(*field)) {
        panic!("release sidecar origin attestation has an invalid schema");
    }
    let origins = object
        .get("origins")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .map(serde_json::Value::as_str)
                .collect::<Option<Vec<_>>>()
        });
    let expected_origins = effective
        .origins
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let mut names = BTreeSet::new();
    let binaries_valid = object
        .get("binaries")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|items| {
            items.len() == PRODUCT_SIDECARS.len()
                && items.iter().all(|item| {
                    let Some(entry) = item.as_object() else {
                        return false;
                    };
                    if entry.len() != 2 {
                        return false;
                    }
                    let Some(name) = entry.get("name").and_then(serde_json::Value::as_str) else {
                        return false;
                    };
                    let Some(expected_sha) =
                        entry.get("sha256").and_then(serde_json::Value::as_str)
                    else {
                        return false;
                    };
                    if !PRODUCT_SIDECARS.contains(&name) || !names.insert(name) {
                        return false;
                    }
                    let binary = binaries_dir.join(format!("{name}-{target}.exe"));
                    binary.is_file() && sha256_file(&binary) == expected_sha
                })
        })
        && names.len() == PRODUCT_SIDECARS.len();
    let valid = object
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        == Some(1)
        && object.get("profile").and_then(serde_json::Value::as_str) == Some("release")
        && object.get("target").and_then(serde_json::Value::as_str) == Some(target)
        && origins.as_deref() == Some(expected_origins.as_slice())
        && object
            .get("originFingerprint")
            .and_then(serde_json::Value::as_str)
            == Some(effective.origin_fingerprint.as_str())
        && object
            .get("canonicalConfigSha256")
            .and_then(serde_json::Value::as_str)
            == Some(canonical.config_sha256.as_str())
        && object
            .get("manifestPublicKeySha256")
            .and_then(serde_json::Value::as_str)
            == Some(canonical.manifest_public_key_sha256.as_str())
        && object
            .get("cargoLockSha256")
            .and_then(serde_json::Value::as_str)
            == Some(sha256_file(&manifest_dir.join("Cargo.lock")).as_str())
        && binaries_valid;
    if !valid {
        panic!(
            "release sidecars do not match the current canonical extension-origin configuration; rerun controlled sidecar preparation"
        );
    }
}

fn tree_shape(root: &std::path::Path) -> Option<(u64, u64)> {
    let mut count = 0u64;
    let mut bytes = 0u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory).ok()? {
            let entry = entry.ok()?;
            let metadata = std::fs::symlink_metadata(entry.path()).ok()?;
            if metadata.file_type().is_symlink() {
                return None;
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                count = count.checked_add(1)?;
                bytes = bytes.checked_add(metadata.len())?;
            } else {
                return None;
            }
        }
    }
    Some((count, bytes))
}

fn copy_tree(source: &std::path::Path, destination: &std::path::Path) {
    std::fs::create_dir(destination).expect("create staged resource root");
    for entry in std::fs::read_dir(source).expect("read staged resource root") {
        let entry = entry.expect("read staged resource entry");
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata =
            std::fs::symlink_metadata(&source_path).expect("inspect staged resource entry");
        if metadata.file_type().is_symlink() {
            panic!("staged resource cannot contain symlinks");
        }
        if metadata.is_dir() {
            copy_tree(&source_path, &destination_path);
        } else if metadata.is_file() {
            std::fs::copy(&source_path, &destination_path).expect("copy staged resource file");
        } else {
            panic!("staged resource contains unsupported entry");
        }
    }
}

fn stage_dev_media_engine(manifest_dir: &std::path::Path) -> Option<String> {
    let source = manifest_dir.join("media-engine");
    let source_manifest = source.join("runtime-manifest.json");
    if !source_manifest.is_file() {
        return None;
    }
    let source_manifest_sha = sha256_file(&source_manifest);
    let source_shape = tree_shape(&source).expect("inspect repo-local dev media engine");
    let out_dir = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let profile_dir = out_dir
        .parent()
        .and_then(std::path::Path::parent)
        .and_then(std::path::Path::parent)
        .expect("derive Cargo profile directory from OUT_DIR");
    let destination = profile_dir.join("media-engine");
    let destination_matches = destination.join("runtime-manifest.json").is_file()
        && sha256_file(&destination.join("runtime-manifest.json")) == source_manifest_sha
        && tree_shape(&destination) == Some(source_shape);
    if !destination_matches {
        let stage = profile_dir.join(format!(".media-engine-stage-{}", std::process::id()));
        if stage.exists() {
            std::fs::remove_dir_all(&stage).expect("remove stale dev media engine stage");
        }
        copy_tree(&source, &stage);
        if tree_shape(&stage) != Some(source_shape) {
            let _ = std::fs::remove_dir_all(&stage);
            panic!("staged dev media engine shape mismatch");
        }
        if destination.exists() {
            std::fs::remove_dir_all(&destination).expect("replace stale dev media engine");
        }
        std::fs::rename(stage, destination).expect("activate staged dev media engine");
    }
    println!("cargo:rerun-if-changed=media-engine/runtime-manifest.json");
    Some(source_manifest_sha)
}

fn main() {
    println!("cargo:rerun-if-env-changed=LUCKYRAY_EXTENSION_ORIGINS");
    println!("cargo:rerun-if-env-changed=LUCKYRAY_DEV_EXTENSION_ORIGINS");
    println!("cargo:rerun-if-env-changed=LUCKYRAY_MEDIA_ENGINE_MANIFEST_SHA256");
    println!("cargo:rerun-if-env-changed=LUCKYRAY_SIDECAR_PREPARE");
    let profile = std::env::var("PROFILE").unwrap_or_default();
    configure_dsh_update_trust(&profile);
    let manifest_dir =
        std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .expect("derive LuckyRay repository root from Cargo manifest directory");
    let adapter_fingerprint = dsh_update_contract_fingerprint(
        repo_root,
        b"luckyray-dsh-host-adapter-v1",
        &[
            "src-tauri/dsh-host/luckyray-dsh-host.mjs",
            "src-tauri/src/dsh_host.rs",
            "src-tauri/src/lib.rs",
            "src-tauri/src/dsh_resource_broker.rs",
        ],
    );
    let resource_gate = dsh_update_contract_fingerprint(
        repo_root,
        b"luckyray-dsh-resource-gate-v1",
        &[
            "src/core/services/openInLightSeek.ts",
            "src/features/ai/DshNativeSurfacePage.tsx",
            "src/features/ai/LightSeekContentBrowser.tsx",
            "tests/openInLightSeek.contract.test.ts",
            "tests/dshNativeSurfaceImageIntent.contract.test.mjs",
        ],
    );
    println!("cargo:rustc-env=LUCKYRAY_DSH_ADAPTER_FINGERPRINT={adapter_fingerprint}");
    println!("cargo:rustc-env=LUCKYRAY_DSH_RESOURCE_GATE_SHA256={resource_gate}");
    let release_origin_config = repo_root.join("config/release-extension-origins.json");
    let extension_manifest = repo_root.join("browser-extension-prototype/manifest.json");
    println!("cargo:rerun-if-changed={}", release_origin_config.display());
    println!("cargo:rerun-if-changed={}", extension_manifest.display());
    let release_origins = if profile == "release" {
        let canonical = release_extension_origins::load_canonical_release_origins(
            &release_origin_config,
            &extension_manifest,
        )
        .unwrap_or_else(|code| panic!("release extension origin configuration is invalid: {code}"));
        let explicit_override = match std::env::var("LUCKYRAY_EXTENSION_ORIGINS") {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => None,
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("release extension origin override is invalid")
            }
        };
        let effective = release_extension_origins::resolve_release_origins(
            &canonical,
            explicit_override.as_deref(),
        )
        .unwrap_or_else(|code| panic!("release extension origin override is invalid: {code}"));
        println!(
            "cargo:rustc-env=LUCKYRAY_EXTENSION_ORIGINS={}",
            effective.origins.join(",")
        );
        println!(
            "cargo:rustc-env=LUCKYRAY_RELEASE_EXTENSION_ORIGINS_CONFIG_SHA256={}",
            canonical.config_sha256
        );
        println!(
            "cargo:rustc-env=LUCKYRAY_RELEASE_EXTENSION_ORIGINS_FINGERPRINT={}",
            effective.origin_fingerprint
        );
        Some((canonical, effective))
    } else {
        if std::env::var_os("LUCKYRAY_EXTENSION_ORIGINS").is_some() {
            panic!(
                "debug builds reject LUCKYRAY_EXTENSION_ORIGINS; use LUCKYRAY_DEV_EXTENSION_ORIGINS or the explicit debug fallback"
            );
        }
        match std::env::var("LUCKYRAY_DEV_EXTENSION_ORIGINS") {
            Ok(value) => {
                let origins = release_extension_origins::canonicalize_extension_origins(&value)
                    .unwrap_or_else(|code| {
                        panic!("debug extension origin override is invalid: {code}")
                    });
                println!(
                    "cargo:rustc-env=LUCKYRAY_EXTENSION_ORIGINS={}",
                    origins.join(",")
                );
            }
            Err(std::env::VarError::NotPresent) => {}
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("debug extension origin override is invalid")
            }
        }
        None
    };
    let target = std::env::var("TARGET").expect("TARGET");
    let cli_contract_identity = cli_contract_identity(&manifest_dir);
    println!("cargo:rerun-if-changed=src/tool_cli.rs");
    println!("cargo:rerun-if-changed=src/sidecars/luckyray-cli.rs");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rustc-env=LUCKYRAY_CLI_CONTRACT_SHA256={cli_contract_identity}");
    println!("cargo:rustc-env=LUCKYRAY_BUILD_TARGET={target}");
    println!("cargo:rerun-if-changed=binaries/luckyray-cli-{target}.exe.identity.json");
    println!("cargo:rerun-if-changed=binaries/luckyray-cli-{target}.exe");
    println!("cargo:rerun-if-changed=binaries/luckyray-sidecars.origin.identity.json");
    let sidecar_paths = PRODUCT_SIDECARS.map(|name| {
        manifest_dir
            .join("binaries")
            .join(format!("{name}-{target}.exe"))
    });

    // Tauri validates every externalBin during ordinary debug checks/tests,
    // before the product sidecars can be built. Ignored MZ placeholders keep
    // those developer commands reproducible. Only the debug profile may create
    // or accept them; packaging must supply real binaries through the sidecar
    // preparation script.
    if profile == "debug" {
        std::fs::create_dir_all(manifest_dir.join("media-engine"))
            .expect("create debug media engine resource root");
        std::fs::create_dir_all(manifest_dir.join("binaries"))
            .expect("create debug sidecar directory");
        for sidecar in sidecar_paths {
            if !sidecar.exists() {
                std::fs::write(&sidecar, DEV_SIDECAR_PLACEHOLDER)
                    .expect("write debug sidecar placeholder");
            }
        }
    } else {
        if !manifest_dir
            .join("media-engine/runtime-manifest.json")
            .is_file()
        {
            panic!("non-debug builds require a prepared app-owned media engine");
        }
        let sidecar_prepare =
            std::env::var("LUCKYRAY_SIDECAR_PREPARE").ok().as_deref() == Some("1");
        if !sidecar_prepare {
            for sidecar in sidecar_paths {
                if std::fs::read(&sidecar).is_ok_and(|bytes| bytes == DEV_SIDECAR_PLACEHOLDER) {
                    panic!(
                        "non-debug builds require a real {} sidecar; debug placeholders are forbidden",
                        sidecar
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("product")
                    );
                }
            }
            validate_registered_cli_contract(&manifest_dir, &target, &cli_contract_identity);
            let (canonical, effective) = release_origins
                .as_ref()
                .expect("release builds always resolve extension origins");
            validate_registered_sidecar_origin_contract(
                &manifest_dir,
                &target,
                canonical,
                effective,
            );
        }
    }
    let media_manifest = manifest_dir.join("media-engine/runtime-manifest.json");
    if media_manifest.is_file() {
        println!(
            "cargo:rustc-env=LUCKYRAY_MEDIA_ENGINE_MANIFEST_SHA256={}",
            sha256_file(&media_manifest)
        );
    }
    native_video_build::stage(&manifest_dir, &profile);
    tauri_build::build();
    if profile == "debug" {
        let _ = stage_dev_media_engine(&manifest_dir);
    }
}
