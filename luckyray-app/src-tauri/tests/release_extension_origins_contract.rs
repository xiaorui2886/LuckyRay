#[path = "../src/release_extension_origins.rs"]
mod release_extension_origins;

use release_extension_origins::{
    load_canonical_release_origins, resolve_release_origins, OriginSource,
};
use std::path::{Path, PathBuf};

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repository root")
        .to_path_buf()
}

fn release_config(root: &Path) -> PathBuf {
    root.join("config/release-extension-origins.json")
}

fn extension_manifest(root: &Path) -> PathBuf {
    root.join("browser-extension-prototype/manifest.json")
}

#[test]
fn tracked_private_release_origin_is_manifest_bound_and_canonical() {
    let root = repository_root();
    let canonical =
        load_canonical_release_origins(&release_config(&root), &extension_manifest(&root))
            .expect("tracked private release origin config");
    assert_eq!(canonical.origins.len(), 1);
    assert_eq!(
        canonical.origins,
        vec![format!("chrome-extension://{}", canonical.extension_id)]
    );
    assert!(canonical
        .extension_id
        .bytes()
        .all(|byte| (b'a'..=b'p').contains(&byte)));
    assert_eq!(canonical.manifest_public_key_sha256.len(), 64);

    let default = resolve_release_origins(&canonical, None).expect("canonical default");
    assert_eq!(default.source, OriginSource::CanonicalPrivateRelease);
    assert_eq!(default.origins, canonical.origins);

    let override_value = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
    let override_result = resolve_release_origins(&canonical, Some(override_value))
        .expect("canonicalize explicit release override");
    assert_eq!(override_result.source, OriginSource::ExplicitOverride);
    assert_eq!(
        override_result.origins,
        vec!["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
    );
}

#[test]
fn missing_malformed_or_noncanonical_release_origins_fail_closed() {
    let root = repository_root();
    let manifest = extension_manifest(&root);
    let temp = tempfile::tempdir().expect("temporary config root");
    let config = temp.path().join("release-extension-origins.json");
    assert!(load_canonical_release_origins(&config, &manifest).is_err());

    for value in [
        "{}",
        r#"{"schemaVersion":1,"schemaVersion":1,"channel":"private-release-v1","origins":["chrome-extension://kjibmbcoioanaejehhfopjhdpnbkodla"],"publicKeySha256":"a981c12e8e0d0494775ef973fd1ae3b03a40c7e51f83a3fdd3bbf3037aa5436e"}"#,
        r#"{"schemaVersion":1,"channel":"private-release-v1","origins":[],"publicKeySha256":"a981c12e8e0d0494775ef973fd1ae3b03a40c7e51f83a3fdd3bbf3037aa5436e"}"#,
        r#"{"schemaVersion":1,"channel":"private-release-v1","origins":["chrome-extension://kjibmbcoioanaejehhfopjhdpnbkodla","chrome-extension://kjibmbcoioanaejehhfopjhdpnbkodla"],"publicKeySha256":"a981c12e8e0d0494775ef973fd1ae3b03a40c7e51f83a3fdd3bbf3037aa5436e"}"#,
        r#"{"schemaVersion":1,"channel":"private-release-v1","origins":["chrome-extension://pppppppppppppppppppppppppppppppp","chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"publicKeySha256":"a981c12e8e0d0494775ef973fd1ae3b03a40c7e51f83a3fdd3bbf3037aa5436e"}"#,
        r#"{"schemaVersion":1,"channel":"private-release-v1","origins":["moz-extension://kjibmbcoioanaejehhfopjhdpnbkodla"],"publicKeySha256":"a981c12e8e0d0494775ef973fd1ae3b03a40c7e51f83a3fdd3bbf3037aa5436e"}"#,
        r#"{"schemaVersion":1,"channel":"private-release-v1","origins":["chrome-extension://kjibmbcoioanaejehhfopjhdpnbkodla"],"publicKeySha256":"0000000000000000000000000000000000000000000000000000000000000000","unexpected":true}"#,
    ] {
        std::fs::write(&config, value).expect("write malformed config fixture");
        assert!(
            load_canonical_release_origins(&config, &manifest).is_err(),
            "{value}"
        );
    }

    let canonical = load_canonical_release_origins(&release_config(&root), &manifest)
        .expect("tracked canonical config");
    for override_value in [
        "",
        "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
        "moz-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,,chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ] {
        assert!(
            resolve_release_origins(&canonical, Some(override_value)).is_err(),
            "{override_value}"
        );
    }
}
