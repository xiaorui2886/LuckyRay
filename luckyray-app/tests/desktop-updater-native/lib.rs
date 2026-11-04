#[path="../../src-tauri/src/desktop_app_update/policy.rs"]
mod policy;
#[path="../../src-tauri/src/desktop_app_update/verification.rs"]
mod verification;

// Exercise the same publicly reviewed provenance parser used by the host.
#[path="../../src-tauri/src/dsh_update_metadata_policy.rs"]
mod dsh_update_metadata_policy;

#[path="../../src-tauri/src/desktop_app_update/store.rs"]
mod store;

#[cfg(test)] mod signed_package_tests {
    use super::verification::verify_package;
    use base64::{Engine,engine::general_purpose::STANDARD};
    #[test]fn real_ephemeral_signature_rejects_tampering_and_version_substitution(){
        // In-memory test keys only. No production credential is created or persisted.
        let pair=minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let bytes=b"MZ fake installer used solely for cryptographic unit testing";
        let signature=minisign::sign(Some(&pair.pk),&pair.sk,&bytes[..],Some("timestamp:1\tfile:LuckyRay_2.0.0_x64-setup.exe"),Some("unit test")).unwrap();
        let key=STANDARD.encode(pair.pk.to_box().unwrap().to_string());
        let sig=STANDARD.encode(signature.to_string());
        assert_eq!(verify_package(bytes,&sig,&key,"2.0.0",&super::super::verification::WINDOWS_PROFILE),Ok(()));
        assert_eq!(verify_package(b"MZ tampered",&sig,&key,"2.0.0",&super::super::verification::WINDOWS_PROFILE),Err("update-signature-invalid"));
        assert_eq!(verify_package(bytes,&sig,&key,"2.0.1",&super::super::verification::WINDOWS_PROFILE),Err("update-signed-version-mismatch"));
        let altered=STANDARD.encode(signature.to_string().replace("LuckyRay_2.0.0_x64-setup.exe","LuckyRay_2.0.1_x64-setup.exe"));
        assert_eq!(verify_package(bytes,&altered,&key,"2.0.1"),Err("update-signature-invalid"));
    }
    #[test]fn the_linux_profile_signs_and_verifies_its_own_appimage_asset(){
        // In-memory test keys only; the Linux profile binds the AppImage asset
        // exactly like the Windows profile binds the nsis installer.
        let pair=minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let bytes=b"MZ fake installer used solely for cryptographic unit testing";
        let signature=minisign::sign(Some(&pair.pk),&pair.sk,&bytes[..],Some("timestamp:1\tfile:LuckyRay_2.0.0_amd64.AppImage"),Some("unit test")).unwrap();
        let key=STANDARD.encode(pair.pk.to_box().unwrap().to_string());
        let sig=STANDARD.encode(signature.to_string());
        let linux=&super::super::verification::LINUX_PROFILE;
        assert_eq!(verify_package(bytes,&sig,&key,"2.0.0",linux),Ok(()));
        assert_eq!(verify_package(b"MZ tampered",&sig,&key,"2.0.0",linux),Err("update-signature-invalid"));
        assert_eq!(verify_package(bytes,&sig,&key,"2.0.1",linux),Err("update-signed-version-mismatch"));
        // The profiles are cross-locked: a Linux signature can never satisfy the
        // Windows identity and vice versa.
        assert_eq!(verify_package(bytes,&sig,&key,"2.0.0",&super::super::verification::WINDOWS_PROFILE),Err("update-signed-version-mismatch"));
    }
    #[test]fn valid_signature_without_version_binding_is_not_enough(){
        let pair=minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let bytes=b"test fixture";
        let signature=minisign::sign(Some(&pair.pk),&pair.sk,&bytes[..],Some("timestamp:1"),None).unwrap();
        assert_eq!(verify_package(bytes,&STANDARD.encode(signature.to_string()),&STANDARD.encode(pair.pk.to_box().unwrap().to_string()),"2.0.0",&super::super::verification::WINDOWS_PROFILE),Err("update-signed-version-invalid"));
    }
}

#[path="../../src-tauri/src/desktop_app_update/feed.rs"]
mod feed;

#[path="../../src-tauri/src/dsh_update_remote_policy.rs"]
mod dsh_update_remote_policy;
