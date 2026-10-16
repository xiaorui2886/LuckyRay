//! Ephemeral test signer. No private key is persisted, logged, or used by production.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::io::{self, BufRead, Write};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { version: String, path: String, wrong_key: bool }

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::fs::canonicalize(std::env::args().nth(1).ok_or("test-root-required")?)?;
    if !root.to_string_lossy().contains("auto-update-next-20261011") {
        return Err("fixture-root-only".into());
    }
    let key = minisign::KeyPair::generate_unencrypted_keypair()?;
    let other = minisign::KeyPair::generate_unencrypted_keypair()?;
    println!("{}", serde_json::json!({"publicKey": STANDARD.encode(key.pk.to_box()?.to_string()), "privateKeyPersisted": false}));
    io::stdout().flush()?;
    for line in io::stdin().lock().lines() {
        let request: Request = serde_json::from_str(&line?)?;
        let version = semver::Version::parse(&request.version)?;
        if version.to_string() != request.version || version.major != 0 || !version.pre.is_empty() || !version.build.is_empty() {
            return Err("fixture-version-only".into());
        }
        let path = std::fs::canonicalize(&request.path)?;
        if !path.starts_with(&root) || path.file_name().and_then(|s|s.to_str()) != Some(&format!("LuckyRay_{version}_x64-setup.exe")) {
            return Err("fixture-package-only".into());
        }
        let bytes = std::fs::read(path)?;
        if !bytes.starts_with(b"MZ") || bytes.len() > 1024*1024*1024 { return Err("fixture-package-invalid".into()); }
        let pair = if request.wrong_key { &other } else { &key };
        let signed = minisign::sign(Some(&pair.pk), &pair.sk, &bytes[..], Some(&format!("timestamp:1\tfile:LuckyRay_{version}_x64-setup.exe")), Some("isolated Windows fixture, not a production signature"))?;
        println!("{}", serde_json::json!({"version": request.version, "signature": STANDARD.encode(signed.to_string()), "bytes": bytes.len()}));
        io::stdout().flush()?;
    }
    Ok(())
}
