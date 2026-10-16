// Verification-only executable, never bundled with LuckyRay. This imports the
// real native record admission implementation instead of duplicating its hash
// policy in a test. It reads only an explicitly supplied isolated runtime root.
#[allow(dead_code)]
#[path = "../../src-tauri/src/dsh_runtime_seal.rs"]
mod dsh_runtime_seal;

fn main() {
    if let Err(code) = verify() {
        eprintln!("{code}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
fn verify() -> Result<(), &'static str> {
    let version = dsh_runtime_seal::bundled_runtime_version()
        .ok_or("embedded-runtime-record-seal-invalid")?;
    if version != "0.1.7-rc.2" {
        return Err("unexpected-bundled-runtime-version");
    }
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() > 1 {
        return Err("at-most-one-isolated-runtime-root-required");
    }
    if let Some(root) = arguments.first() {
        let root = std::path::PathBuf::from(root);
        if !root.is_absolute() {
            return Err("explicit-absolute-runtime-root-required");
        }
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let control = dsh_runtime_seal::RuntimeSealControl::new(&cancelled);
        let lease = dsh_runtime_seal::RuntimeIdentityLease::acquire(&root, &control)
            .map_err(|_| "actual-runtime-critical-identity-invalid")?;
        lease.revalidate(&control).map_err(|_| "actual-runtime-revalidation-failed")?;
        println!("PASS_NATIVE_EMBEDDED_RECORDS_AND_ACTUAL_CRITICAL_IDENTITY");
    } else {
        println!("PASS_NATIVE_EMBEDDED_RUNTIME_RECORDS");
    }
    Ok(())
}

#[cfg(not(windows))]
fn verify() -> Result<(), &'static str> {
    Err("native-windows-runtime-record-verifier-required")
}
