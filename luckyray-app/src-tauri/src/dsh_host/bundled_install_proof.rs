//! Explicit local, no-model proof using the resources extracted from the final
//! installer and a marked synthetic profile. Never used by the application.
use super::*;
use std::fs;
use std::os::windows::process::CommandExt;
use sha2::{Digest, Sha256};

#[test]
#[ignore = "requires final packaged resources and a marked synthetic profile; never a user profile"]
fn packaged_rc3_selects_and_reopens_in_synthetic_profile() {
    let resource = PathBuf::from(std::env::var_os("DSH_BUNDLE_PROOF_RESOURCES").unwrap());
    let data = PathBuf::from(std::env::var_os("DSH_BUNDLE_PROOF_PROFILE").unwrap());
    assert!(resource.is_absolute() && data.is_absolute());
    assert!(data.starts_with(std::env::temp_dir()));
    let marker = fs::read(data.join("isolated-desktop-rc3-proof.json")).unwrap();
    assert_eq!(marker, br#"{"synthetic":true,"modelRequests":false}"#);
    assert!(!data.join("luckyray.db").exists(), "never use an existing desktop profile");
    let service = DshHostService::production(&resource, &data);
    assert_eq!(service.status().stage, DshHostStage::BundledVerified);
    let descriptor = service.descriptor.get().unwrap();
    assert_eq!(descriptor.root, resource.join(installation::BUNDLE_SLOT).join("deepseek-harness"));
    assert!(descriptor.dynamic_candidate.is_none(), "old active must not mask the bundle");
    let package = descriptor.root.join("host/node_modules/@deepseek-ai/dsh/package.json");
    let package: serde_json::Value = serde_json::from_slice(&fs::read(package).unwrap()).unwrap();
    assert_eq!(package["version"], "0.2.1-rc.3");
    let output = std::process::Command::new(descriptor.root.join("node/node.exe"))
        .arg(descriptor.root.join("host/node_modules/@deepseek-ai/dsh/lib/bin.js"))
        .arg("--version").creation_flags(0x08000000).output().unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0.2.1-rc.3");
    let result = service.probe(DshHostAction::Probe).expect("local fixed-response provider, never a model");
    assert!(result.latest_probe_passed);
    let (surface, _) = service.open_native_surface().expect("real official carrier");
    assert_eq!(surface.stage, DshNativeSurfaceStage::CarrierReady);
    assert!(surface.owned_direct_process_count >= 2);
    assert_eq!(service.plugin_compat_check(false).unwrap()["checked"], true);
    let pid = service.host.lock().unwrap().as_ref().unwrap().process_id().unwrap();
    let binary = format!("{:x}", Sha256::digest(fs::read(std::env::current_exe().unwrap()).unwrap()));
    let evidence = serde_json::json!({"status":"PASS", "selected":"0.2.1-rc.3",
        "packagedResources":resource, "syntheticProfile":data, "hostPid":pid,
        "ownedProcesses":surface.owned_direct_process_count, "hostTestBinarySha256":binary,
        "nativeProbe":true,"carrierReady":true,"pluginGate":true,
        "webviewVisualTest":false,"realModelRequests":0});
    service.close_native_surface().unwrap();
    assert!(service.shutdown(), "only the isolated owned process tree is stopped");
    drop(service);
    println!("BUNDLED_RC3_PROOF {evidence}");
}
