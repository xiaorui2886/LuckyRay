//! Use the installed Apple SDK for the public legacy Keychain/CSSM ABI.
//! No compiler or link changes are applied to non-macOS targets.
use std::path::Path;
use std::process::Command;

pub fn compile(manifest: &Path, target: &str) {
    if !target.ends_with("-apple-darwin") { return; }
    let architecture = match target.split('-').next() {
        Some("aarch64") => "arm64",
        Some("x86_64") => "x86_64",
        _ => panic!("macos-keychain-guard-target-unsupported"),
    };
    let source = "src/companion_gateway/macos_keychain_guard.c";
    println!("cargo:rerun-if-changed={source}");
    println!("cargo:rerun-if-env-changed=SDKROOT");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let object = output.join("macos_keychain_guard.o");
    let archive = output.join("libluckyray_macos_keychain_guard.a");
    let compiled = Command::new("/usr/bin/xcrun")
        .current_dir(manifest)
        .args(["--sdk", "macosx", "clang", "-std=c11", "-arch", architecture,
            "-mmacosx-version-min=15.0", "-O2", "-fvisibility=hidden",
            "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-c", source, "-o"])
        .arg(&object).status().expect("macos-keychain-guard-compiler-unavailable");
    assert!(compiled.success(), "macos-keychain-guard-compile-failed");
    let archived = Command::new("/usr/bin/xcrun")
        .args(["--sdk", "macosx", "ar", "crs"]).arg(&archive).arg(&object)
        .status().expect("macos-keychain-guard-archiver-unavailable");
    assert!(archived.success(), "macos-keychain-guard-archive-failed");
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=luckyray_macos_keychain_guard");
    println!("cargo:rustc-link-lib=framework=Security");
    println!("cargo:rustc-link-lib=framework=CoreFoundation");
}
