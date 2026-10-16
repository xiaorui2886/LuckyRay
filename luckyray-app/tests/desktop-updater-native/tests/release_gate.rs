use base64::{engine::general_purpose::STANDARD,Engine};
use std::{fs,process::Command};
#[test]
fn offline_cli_authenticates_exact_package_and_signature_without_persisting_private_key(){
    let root=std::env::temp_dir().join(format!("lr-release-test-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir(&root).unwrap();
    let pair=minisign::KeyPair::generate_unencrypted_keypair().unwrap();
    let bytes=b"MZ synthetic bytes; never executed";
    let file=root.join("LuckyRay_2.0.0_x64-setup.exe");let sig=root.join("installer.sig");let trust=root.join("trust.json");
    fs::write(&file,bytes).unwrap();
    let signature=STANDARD.encode(minisign::sign(Some(&pair.pk),&pair.sk,&bytes[..],Some("timestamp:1\tfile:LuckyRay_2.0.0_x64-setup.exe"),None).unwrap().to_string());
    fs::write(&sig,&signature).unwrap();
    let key=STANDARD.encode(pair.pk.to_box().unwrap().to_string());
    let mut config=serde_json::json!({"enabled":true,"identifier":"com.luckyray.desktop","publicKey":key,"manifestUrl":"https://github.com/xiaorui2886/LuckyRay/releases/latest/download/latest.json"});
    fs::write(&trust,serde_json::to_vec(&config).unwrap()).unwrap();
    let run=||Command::new(env!("CARGO_BIN_EXE_luckyray-update-verify")).args([file.to_str().unwrap(),sig.to_str().unwrap(),trust.to_str().unwrap(),"2.0.0"]).output().unwrap();
    let good=run();assert!(good.status.success(),"{:?}",good.stderr);
    let result:serde_json::Value=serde_json::from_slice(&good.stdout).unwrap();assert_eq!(result["verified"],true);assert_eq!(result["signatureSha256"].as_str().unwrap().len(),64);
    fs::write(&file,b"MZ tampered").unwrap();assert!(!run().status.success());fs::write(&file,bytes).unwrap();
    config["enabled"]=false.into();fs::write(&trust,serde_json::to_vec(&config).unwrap()).unwrap();assert!(!run().status.success());
    fs::remove_dir_all(root).unwrap();
}
