//! Build the vault-scoped worker only for macOS; Windows sidecars are unchanged.
use std::path::Path;
use std::process::Command;

pub fn compile(manifest: &Path, target: &str) {
    if !target.ends_with("-apple-darwin") { return; }
    let architecture = match target.split('-').next() {
        Some("aarch64") => "arm64",
        Some("x86_64") => "x86_64",
        _ => panic!("macos-folder-helper-target-unsupported"),
    };
    let source = "src/macos_folder_helper.c";
    println!("cargo:rerun-if-changed={source}");
    println!("cargo:rerun-if-env-changed=SDKROOT");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let object = output.join("macos_folder_helper.o");
    let archive = output.join("libluckyray_macos_folder_helper.a");
    let standalone = output.join("luckyray-macos-folder-helper-test");
    let flags = ["--sdk", "macosx", "clang", "-std=c11", "-arch", architecture,
        "-mmacosx-version-min=15.0", "-O2", "-fvisibility=hidden", "-Wall", "-Wextra",
        "-Werror", "-Wno-deprecated-declarations"];
    let compiled = Command::new("/usr/bin/xcrun").current_dir(manifest)
        .args(flags).args(["-c", source, "-o"]).arg(&object)
        .status().expect("macos-folder-helper-compiler-unavailable");
    assert!(compiled.success(), "macos-folder-helper-compile-failed");
    let archived = Command::new("/usr/bin/xcrun")
        .args(["--sdk", "macosx", "ar", "crs"]).arg(&archive).arg(&object)
        .status().expect("macos-folder-helper-archiver-unavailable");
    assert!(archived.success(), "macos-folder-helper-archive-failed");
    // Native tests exercise the identical C entry point without launching the
    // Rust test harness as if it were the application. This executable stays
    // in OUT_DIR; the packaged app runs its own early worker entry instead.
    let linked = Command::new("/usr/bin/xcrun").current_dir(manifest)
        .args(flags).args(["-DLUCKYRAY_FOLDER_HELPER_STANDALONE", source,
            "-framework", "CoreServices", "-framework", "CoreFoundation", "-o"]).arg(&standalone)
        .status().expect("macos-folder-helper-test-compiler-unavailable");
    assert!(linked.success(), "macos-folder-helper-test-link-failed");
    println!("cargo:rustc-env=LUCKYRAY_MACOS_FOLDER_HELPER={}", standalone.display());
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=luckyray_macos_folder_helper");
    println!("cargo:rustc-link-lib=framework=CoreServices");
    println!("cargo:rustc-link-lib=framework=CoreFoundation");
}
