use serde_json::Value;
use std::process::Command;
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

fn temp_dir(label: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "luckyray-cli-contract-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn cli_binary_exposes_a_json_usage_contract() {
    let output = Command::new(env!("CARGO_BIN_EXE_luckyray-cli"))
        .output()
        .expect("CLI process should start");

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    let error: Value = serde_json::from_slice(&output.stderr).expect("stderr should be JSON");
    assert_eq!(error["ok"], false);
    assert_eq!(error["error"]["code"], "cli-usage-invalid");
}

#[test]
fn cli_reports_app_unavailable_without_printing_environment_details() {
    let app_data = temp_dir("offline");
    let sentinel = "PRIVATE-APPDATA-PATH-SENTINEL";
    let output = Command::new(env!("CARGO_BIN_EXE_luckyray-cli"))
        .args(["tools", "list"])
        .env("APPDATA", app_data.join(sentinel))
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(3));
    assert!(output.stdout.is_empty());
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["code"], "app-unavailable");
    assert!(!String::from_utf8_lossy(&output.stderr).contains(sentinel));
}

#[test]
fn cli_help_version_and_subcommand_help_work_without_an_app() {
    let app_data = temp_dir("discovery-offline");
    for args in [
        vec!["--help"],
        vec!["tools", "run", "--help"],
        vec!["--version"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_luckyray-cli"))
            .args(args)
            .env("APPDATA", app_data.join("PRIVATE-APPDATA-PATH-SENTINEL"))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert!(String::from_utf8_lossy(&output.stdout).contains("luckyray-cli"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE-APPDATA-PATH-SENTINEL"));
    }
    for command in ["--help", "--version"] {
        let output = Command::new(env!("CARGO_BIN_EXE_luckyray-cli"))
            .args([command, "--json"])
            .env("APPDATA", &app_data)
            .output()
            .unwrap();
        assert!(output.status.success());
        let data: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(data["ok"], true);
        assert_eq!(data["version"], env!("CARGO_PKG_VERSION"));
    }
    fs::remove_dir_all(app_data).unwrap();
}

#[test]
fn cli_describe_diagnostics_and_underscore_ids_parse_before_connection() {
    let app_data = temp_dir("commands-offline");
    for args in [
        vec!["status"],
        vec!["doctor", "--json"],
        vec!["tools", "describe", "knowledge.set_tags"],
        vec!["tools", "run", "knowledge.set_tags", "--input", "{}"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_luckyray-cli"))
            .args(args)
            .env("APPDATA", &app_data)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(3));
        assert!(output.stdout.is_empty());
        let data: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(data["error"]["code"], "app-unavailable");
    }
    fs::remove_dir_all(app_data).unwrap();
}
