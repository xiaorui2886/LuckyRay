//! Public-only check of the two actual isolated NSIS packages, not installed acceptance.
#[path = "../../../src-tauri/src/desktop_app_update/verification.rs"]
mod verification;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::fs::canonicalize(std::env::args().nth(1).ok_or("fixture-root-required")?)?;
    let allowed = Path::new(r"D:\codex\luckyray\_delivery\auto-update-next-20261011\windows-fixture\generation-r2");
    if root != std::fs::canonicalize(allowed)? { return Err("fixture-root-only".into()); }
    let public: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("public-signing.json"))?)?;
    if public["privateKeyPersisted"] != false { return Err("fixture-public-record-invalid".into()); }
    let key = public["publicKey"].as_str().ok_or("fixture-public-key-missing")?;
    let mut rows = Vec::new();
    for (label, version) in [("A", "0.0.101"), ("B", "0.0.102")] {
        let identity: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join(format!("build-{label}-identity.json")))?)?;
        let signatures: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join(format!("signature-{label}-public.json")))?)?;
        let artifact = root.join(format!("LuckyRay_{version}_x64-setup.exe"));
        let mut bytes = std::fs::read(&artifact)?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        if identity["installerSha256"] != hash || identity["version"] != version || !bytes.starts_with(b"MZ") { return Err("fixture-package-identity-invalid".into()); }
        let signature = signatures["signature"].as_str().ok_or("fixture-signature-missing")?;
        verification::verify_package(&bytes, signature, key, version)?;
        let mut wrong_key_rejected = None;
        if label == "B" {
            let wrong = signatures["wrongSignature"].as_str().ok_or("fixture-wrong-signature-missing")?;
            let wrong_text = String::from_utf8(STANDARD.decode(wrong)?)?;
            // Independently ensure the negative is a well-formed different-key signature,
            // not a malformed terminal-readback response masquerading as that case.
            minisign_verify::Signature::decode(&wrong_text)?;
            let key_text = String::from_utf8(STANDARD.decode(key)?)?;
            let key_packet = STANDARD.decode(key_text.lines().nth(1).ok_or("public-key-line-missing")?)?;
            let wrong_packet = STANDARD.decode(wrong_text.lines().nth(1).ok_or("signature-line-missing")?)?;
            if key_packet.get(2..10) == wrong_packet.get(2..10) { return Err("fixture-wrong-key-not-distinct".into()); }
            if verification::verify_package(&bytes, wrong, key, version) != Err("update-signature-invalid") { return Err("wrong-key-not-rejected".into()); }
            wrong_key_rejected = Some(true);
            if verification::verify_package(&bytes, signature, key, "0.0.101") != Err("update-signed-version-mismatch") { return Err("signed-version-not-bound".into()); }
        }
        bytes[100] ^= 1; // Memory-only tamper; canonical package is never rewritten.
        if verification::verify_package(&bytes, signature, key, version) != Err("update-signature-invalid") { return Err("tamper-not-rejected".into()); }
        rows.push(serde_json::json!({"version":version,"bytes":bytes.len(),"sha256":hash,"correctSignature":true,"tamperRejected":true,"wrongKeyRejected":wrong_key_rejected}));
    }
    println!("{}", serde_json::json!({"passed":true,"testOnly":true,"productionTrustChanged":false,"installedAcceptance":false,"packages":rows}));
    Ok(())
}
