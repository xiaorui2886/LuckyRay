//! Offline release gate, outside Tauri's implicit src/bin runtime discovery.
//! Accepts public trust only; never reads or generates private keys.
#[path = "../desktop_app_update/verification.rs"]
mod verification;
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};
fn bounded(path: &str, max: usize) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > max as u64 {
        return Err("release-input-too-large".into());
    }
    let mut bytes = Vec::new();
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > max {
        return Err("release-input-too-large".into());
    }
    Ok(bytes)
}
fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 4 {
        return Err("usage: INSTALLER SIG TRUST_JSON VERSION".into());
    }
    verification::stable_version(&args[3]).map_err(str::to_owned)?;
    if Path::new(&args[0]).file_name().and_then(|s| s.to_str())
        != Some(&format!("LuckyRay_{}_x64-setup.exe", args[3]))
    {
        return Err("update-installer-name-invalid".into());
    }
    let trust: serde_json::Value =
        serde_json::from_slice(&bounded(&args[2], 32768)?).map_err(|e| e.to_string())?;
    if trust["enabled"] != true
        || trust["identifier"] != "com.luckyray.desktop"
        || trust["manifestUrl"]
            != "https://github.com/xiaorui2886/LuckyRay/releases/latest/download/latest.json"
    {
        return Err("production-update-trust-not-approved".into());
    }
    let public_key = trust["publicKey"].as_str().ok_or("update-trust-invalid")?;
    let signature =
        String::from_utf8(bounded(&args[1], 16384)?).map_err(|_| "update-signature-invalid")?;
    let bytes = bounded(&args[0], verification::MAX_PACKAGE_BYTES)?;
    if !bytes.starts_with(b"MZ") {
        return Err("update-installer-not-windows-executable".into());
    }
    verification::verify_package(&bytes, &signature, public_key, &args[3])
        .map_err(str::to_owned)?;
    println!(
        "{}",
        serde_json::json!({"verified":true,"version":args[3],"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"signatureSha256":format!("{:x}",Sha256::digest(signature.as_bytes()))})
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
