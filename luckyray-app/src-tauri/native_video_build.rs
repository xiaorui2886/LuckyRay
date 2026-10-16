//! Separate from the frozen media-engine resource inventory. Not a release path.
pub fn stage(manifest_dir: &std::path::Path, profile: &str) {
    let source = manifest_dir.join("native-video");
    println!("cargo:rerun-if-changed=native-video/runtime-manifest.json");
    println!("cargo:rerun-if-changed=native-video/libmpv-2.dll");
    if !source.exists() {
        return;
    }
    assert_eq!(profile,"debug","native-video redistribution audit is pending; local development runtime cannot enter a non-debug build");
    let spec_path = manifest_dir.join("../third_party/native-video/manifest.json");
    println!("cargo:rerun-if-changed=../third_party/native-video/manifest.json");
    let expected = std::fs::read(&spec_path).expect("native video source manifest");
    assert_eq!(
        std::fs::read(source.join("runtime-manifest.json")).expect("native video runtime manifest"),
        expected,
        "native video provenance mismatch"
    );
    let spec: serde_json::Value =
        serde_json::from_slice(&expected).expect("native video manifest JSON");
    assert_eq!(spec["redistributionApproved"], false);
    let dll = source.join("libmpv-2.dll");
    assert_eq!(
        std::fs::metadata(&dll).expect("native video DLL").len(),
        spec["dll"]["size"].as_u64().unwrap()
    );
    assert_eq!(
        super::sha256_file(&dll),
        spec["dll"]["sha256"].as_str().unwrap()
    );
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let destination = output
        .ancestors()
        .nth(3)
        .expect("Cargo profile directory")
        .join("native-video");
    std::fs::create_dir_all(&destination).expect("native video dev resource directory");
    for name in ["libmpv-2.dll", "runtime-manifest.json", "README.md"] {
        let from = source.join(name);
        let to = destination.join(name);
        if to.is_file() && super::sha256_file(&from) == super::sha256_file(&to) {
            continue;
        }
        assert!(
            !to.exists(),
            "native-video dev resource differs; preserve it and prepare explicitly while stopped"
        );
        std::fs::copy(from, to).expect("stage native video dev resource");
    }
}
