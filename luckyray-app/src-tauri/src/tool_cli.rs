use crate::tool_client::{ToolClient, ToolClientError};
use serde::Serialize;
use serde_json::Value;
use std::io::{self, Read, Write};
use std::path::Path;

const EXIT_OK: i32 = 0;
const EXIT_INTERNAL: i32 = 1;
const EXIT_USAGE: i32 = 2;
const EXIT_CONNECTION: i32 = 3;
const EXIT_TOOL: i32 = 4;
const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_TOOL_ID_BYTES: usize = 128;
const MAX_REQUEST_ID_BYTES: usize = 96;
const MAX_PROJECT_MANIFEST_BYTES: usize = 64 * 1024;

/// This label is deliberately separate from the content-derived identity. The
/// label tells a caller which narrow, fixed protocol it is speaking; the
/// identity proves the registered Windows externalBin was built from the same
/// CLI command surface and Cargo.lock as the Backend that will invoke it.
pub(crate) const CLI_PROTOCOL: &str = "luckyray-cli-contract-v1";

pub(crate) fn cli_protocol_identity() -> &'static str {
    option_env!("LUCKYRAY_CLI_CONTRACT_SHA256").unwrap_or("unavailable")
}

#[derive(Serialize)]
struct CliErrorEnvelope {
    ok: bool,
    error: CliError,
}

#[derive(Serialize)]
struct CliError {
    code: String,
    message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
}

#[derive(Serialize)]
struct CliProtocolEnvelope {
    ok: bool,
    protocol: &'static str,
    identity: &'static str,
}

enum CliCommand {
    List,
    Run {
        tool_id: String,
        input: Value,
        request_id: Option<String>,
    },
}

fn write_error(
    mut writer: impl Write,
    code: impl Into<String>,
    message: &'static str,
    status: Option<u16>,
) {
    let envelope = CliErrorEnvelope {
        ok: false,
        error: CliError {
            code: code.into(),
            message,
            status,
        },
    };
    let _ = serde_json::to_writer(&mut writer, &envelope);
    let _ = writer.write_all(b"\n");
}

fn parse_command(args: Vec<String>, mut stdin: impl Read) -> Result<CliCommand, &'static str> {
    match args.as_slice() {
        [namespace, action] if namespace == "tools" && action == "list" => {
            return Ok(CliCommand::List)
        }
        [namespace, action, rest @ ..] if namespace == "tools" && action == "run" => {
            if rest.is_empty() || !is_valid_tool_id(&rest[0]) {
                return Err("CLI tool id is invalid");
            }
            let tool_id = rest[0].clone();
            let mut inline = None;
            let mut use_stdin = false;
            let mut request_id = None;
            let mut index = 1;
            while index < rest.len() {
                match rest[index].as_str() {
                    "--input" if inline.is_none() && !use_stdin => {
                        let value = rest.get(index + 1).ok_or("--input requires JSON")?;
                        inline = Some(value.as_bytes().to_vec());
                        index += 2;
                    }
                    "--stdin" if inline.is_none() && !use_stdin => {
                        use_stdin = true;
                        index += 1;
                    }
                    "--request-id" if request_id.is_none() => {
                        let value = rest.get(index + 1).ok_or("--request-id requires a value")?;
                        if !is_valid_request_id(value) {
                            return Err("requestId is invalid");
                        }
                        request_id = Some(value.clone());
                        index += 2;
                    }
                    _ => return Err("CLI arguments are invalid"),
                }
            }
            let bytes = if let Some(bytes) = inline {
                bytes
            } else if use_stdin {
                let mut bytes = Vec::new();
                stdin
                    .by_ref()
                    .take((MAX_INPUT_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "CLI input could not be read")?;
                bytes
            } else {
                return Err("tools run requires --input or --stdin");
            };
            if bytes.len() > MAX_INPUT_BYTES {
                return Err("CLI input is too large");
            }
            let input = serde_json::from_slice(&bytes).map_err(|_| "CLI input is invalid JSON")?;
            return Ok(CliCommand::Run {
                tool_id,
                input,
                request_id,
            });
        }
        _ => {}
    }
    Err("Use `luckyray-cli tools list` or `luckyray-cli tools run`")
}

fn is_valid_tool_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TOOL_ID_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
        })
}

fn is_valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REQUEST_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn exit_for_error(error: &ToolClientError) -> i32 {
    match error.code() {
        "app-unavailable"
        | "authentication-unavailable"
        | "authentication-failed"
        | "protocol-incompatible"
        | "server-verification-failed"
        | "transport-failed" => EXIT_CONNECTION,
        code if error.status().is_some()
            || code.starts_with("tool-")
            || code.starts_with("knowledge-")
            || code == "request-id-conflict" =>
        {
            EXIT_TOOL
        }
        _ => EXIT_INTERNAL,
    }
}

pub(crate) fn run_with_connector(
    args: Vec<String>,
    stdin: impl Read,
    mut stdout: impl Write,
    mut stderr: impl Write,
    connect: impl FnOnce() -> Result<ToolClient, ToolClientError>,
) -> i32 {
    let command = match parse_command(args, stdin) {
        Ok(command) => command,
        Err(message) => {
            write_error(&mut stderr, "cli-usage-invalid", message, None);
            return EXIT_USAGE;
        }
    };
    let client = match connect() {
        Ok(client) => client,
        Err(error) => {
            let exit = exit_for_error(&error);
            write_error(&mut stderr, error.code(), error.message(), error.status());
            return exit;
        }
    };
    let result = match command {
        CliCommand::List => client.list_tools(),
        CliCommand::Run {
            tool_id,
            input,
            request_id,
        } => client.run_tool(&tool_id, input, request_id.as_deref()),
    };
    match result {
        Ok(data) => {
            if serde_json::to_writer(&mut stdout, &data).is_err()
                || stdout.write_all(b"\n").is_err()
            {
                write_error(&mut stderr, "cli-output-failed", "CLI output failed", None);
                EXIT_INTERNAL
            } else {
                EXIT_OK
            }
        }
        Err(error) => {
            let exit = exit_for_error(&error);
            write_error(&mut stderr, error.code(), error.message(), error.status());
            exit
        }
    }
}

pub fn run() -> i32 {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    // This is intentionally a no-side-effect handshake. It exists so the
    // desktop Backend and the registered Tauri externalBin can prove they
    // speak the exact same narrow CLI contract before a controlled verifier
    // result is accepted. It is never exposed as an Agent tool.
    if args.as_slice() == ["protocol", "identity"] {
        return write_protocol_identity(io::stdout().lock());
    }
    // This is deliberately handled before the local-transport client is
    // constructed. It is a fixed, app-owned read-only verifier, not a route
    // to the application's tool API and not a general CLI execution surface.
    if args.as_slice() == ["verify", "workspace-manifest"] {
        let current = match std::env::current_dir() {
            Ok(current) => current,
            Err(_) => {
                return write_manifest_check_result(
                    io::stdout().lock(),
                    ManifestCheckResult::failed(None, "unavailable"),
                )
            }
        };
        return run_static_manifest_check(&current, io::stdout().lock());
    }
    run_with_connector(
        args,
        io::stdin().lock(),
        io::stdout().lock(),
        io::stderr().lock(),
        ToolClient::connect,
    )
}

fn write_protocol_identity(mut stdout: impl Write) -> i32 {
    let envelope = CliProtocolEnvelope {
        ok: true,
        protocol: CLI_PROTOCOL,
        identity: cli_protocol_identity(),
    };
    if serde_json::to_writer(&mut stdout, &envelope).is_err() || stdout.write_all(b"\n").is_err() {
        EXIT_INTERNAL
    } else {
        EXIT_OK
    }
}

/// Fixed, app-owned verification recipe used only by R8's Backend-owned
/// ExecutionRecipeCatalog. There are no model-controlled arguments, no shell,
/// no project scripts, no dependency installation, and no network I/O. The
/// envelope intentionally contains no path, content, parser diagnostics, or
/// environment values.
#[derive(Clone, Copy)]
struct ManifestCheckResult {
    passed: bool,
    manifest_name: Option<&'static str>,
    reason: &'static str,
}

impl ManifestCheckResult {
    fn passed(manifest_name: &'static str) -> Self {
        Self {
            passed: true,
            manifest_name: Some(manifest_name),
            reason: "valid",
        }
    }

    fn failed(manifest_name: Option<&'static str>, reason: &'static str) -> Self {
        Self {
            passed: false,
            manifest_name,
            reason,
        }
    }
}

fn run_static_manifest_check(root: &Path, stdout: impl Write) -> i32 {
    for name in ["package.json", "Cargo.toml", "pyproject.toml"] {
        let candidate = root.join(name);
        match std::fs::symlink_metadata(&candidate) {
            Ok(_) => {
                return write_manifest_check_result(
                    stdout,
                    verify_static_manifest(&candidate, name),
                )
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return write_manifest_check_result(
                    stdout,
                    ManifestCheckResult::failed(Some(name), "unreadable"),
                )
            }
        }
    }
    write_manifest_check_result(stdout, ManifestCheckResult::failed(None, "missing"))
}

fn verify_static_manifest(path: &Path, name: &'static str) -> ManifestCheckResult {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return ManifestCheckResult::failed(Some(name), "unreadable"),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || manifest_reparse_point(&metadata)
    {
        return ManifestCheckResult::failed(Some(name), "unsafe-file");
    }
    if metadata.len() > MAX_PROJECT_MANIFEST_BYTES as u64 {
        return ManifestCheckResult::failed(Some(name), "too-large");
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return ManifestCheckResult::failed(Some(name), "unreadable"),
    };
    if file
        .take((MAX_PROJECT_MANIFEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return ManifestCheckResult::failed(Some(name), "unreadable");
    }
    if bytes.len() > MAX_PROJECT_MANIFEST_BYTES {
        return ManifestCheckResult::failed(Some(name), "too-large");
    }
    if bytes.is_empty() {
        return ManifestCheckResult::failed(Some(name), "empty");
    }
    if bytes.contains(&0) {
        return ManifestCheckResult::failed(Some(name), "encoding-invalid");
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    if bytes.is_empty() {
        return ManifestCheckResult::failed(Some(name), "empty");
    }
    let text = match std::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => return ManifestCheckResult::failed(Some(name), "encoding-invalid"),
    };
    let parsed = match name {
        "package.json" => serde_json::from_str::<serde_json::Value>(text).is_ok(),
        "Cargo.toml" => strict_toml_has_table(text, "package"),
        "pyproject.toml" => strict_toml_has_table(text, "project"),
        _ => false,
    };
    if parsed {
        ManifestCheckResult::passed(name)
    } else {
        ManifestCheckResult::failed(Some(name), "format-invalid")
    }
}

fn strict_toml_has_table(text: &str, required_table: &str) -> bool {
    let Ok(value) = toml::from_str::<toml::Value>(text) else {
        return false;
    };
    value.get(required_table).is_some_and(toml::Value::is_table)
}

#[cfg(windows)]
fn manifest_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn manifest_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn write_manifest_check_result(mut stdout: impl Write, result: ManifestCheckResult) -> i32 {
    let status = if result.passed { "passed" } else { "failed" };
    let exit_code = if result.passed { EXIT_OK } else { EXIT_TOOL };
    let envelope = serde_json::json!({
        "ok": result.passed,
        "status": status,
        "exitCode": exit_code,
        "manifestName": result.manifest_name,
        "reason": result.reason,
        "protocol": CLI_PROTOCOL,
        "protocolIdentity": cli_protocol_identity(),
    });
    if serde_json::to_writer(&mut stdout, &envelope).is_err() || stdout.write_all(b"\n").is_err() {
        EXIT_INTERNAL
    } else {
        exit_code
    }
}

#[cfg(test)]
mod tests {
    use super::{
        cli_protocol_identity, run_static_manifest_check, run_with_connector,
        write_protocol_identity, CLI_PROTOCOL, EXIT_OK, EXIT_TOOL, MAX_INPUT_BYTES,
    };
    use crate::knowledge::KnowledgeVaultRegistration;
    use crate::{
        backend::BackendServices,
        local_transport::{start_server, ServerConfig},
        tool_client::ToolClient,
        LegacyLocalTransportAdapter,
    };
    use std::fs;
    use std::io::Cursor;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "luckyray-cli-command-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[cfg(windows)]
    #[test]
    fn registered_external_cli_must_match_the_source_protocol_contract() {
        let target = option_env!("LUCKYRAY_BUILD_TARGET").expect("build target is exported");
        let binary = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("luckyray-cli-{target}.exe"));
        let output = Command::new(binary)
            .args(["protocol", "identity"])
            .output()
            .expect("registered externalBin is executable");
        assert!(
            output.status.success(),
            "registered externalBin must accept its no-side-effect protocol identity command"
        );
        let value: serde_json::Value = serde_json::from_slice(&output.stdout)
            .expect("registered externalBin returns structured identity JSON");
        assert_eq!(value["ok"], true);
        assert_eq!(value["protocol"], super::CLI_PROTOCOL);
        assert_eq!(value["identity"], super::cli_protocol_identity());
    }

    #[cfg(windows)]
    #[test]
    fn registered_external_cli_runs_fixed_verify_without_breaking_legacy_tool_commands() {
        let target = option_env!("LUCKYRAY_BUILD_TARGET").expect("build target is exported");
        let binary = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("luckyray-cli-{target}.exe"));
        let root = temp_dir("registered-verify");
        fs::write(root.join("package.json"), r#"{"name":"safe"}"#).unwrap();

        let verify = Command::new(&binary)
            .current_dir(&root)
            .args(["verify", "workspace-manifest"])
            .output()
            .expect("registered externalBin runs fixed verifier");
        assert!(verify.status.success());
        let value: serde_json::Value = serde_json::from_slice(&verify.stdout)
            .expect("fixed verifier returns structured output");
        assert_eq!(value["ok"], true);
        assert_eq!(value["status"], "passed");
        assert_eq!(value["exitCode"], EXIT_OK);
        assert_eq!(value["protocol"], CLI_PROTOCOL);
        assert_eq!(value["protocolIdentity"], cli_protocol_identity());

        for (label, manifest_name, contents) in [
            (
                "registered-malformed-cargo",
                "Cargo.toml",
                "[package]\nname = \"safe\"\nbroken = [\n",
            ),
            (
                "registered-malformed-pyproject",
                "pyproject.toml",
                "[project]\nname = \"safe\"\nbroken = {\n",
            ),
        ] {
            let malformed_root = temp_dir(label);
            fs::write(malformed_root.join(manifest_name), contents).unwrap();
            let malformed = Command::new(&binary)
                .current_dir(&malformed_root)
                .args(["verify", "workspace-manifest"])
                .output()
                .expect("registered externalBin rejects malformed TOML");
            assert_eq!(malformed.status.code(), Some(EXIT_TOOL));
            let value: serde_json::Value = serde_json::from_slice(&malformed.stdout)
                .expect("registered externalBin returns a safe TOML failure envelope");
            assert_eq!(value["status"], "failed");
            assert_eq!(value["manifestName"], manifest_name);
            assert_eq!(value["reason"], "format-invalid");
            assert_eq!(value["protocolIdentity"], cli_protocol_identity());
        }

        for args in [
            vec!["tools", "list"],
            vec!["tools", "run", "knowledge.search", "--input", "{}"],
        ] {
            let output = Command::new(&binary)
                .args(args)
                .output()
                .expect("registered externalBin retains its existing command parser");
            assert_ne!(
                output.status.code(),
                Some(2),
                "valid legacy command must not regress to cli-usage-invalid"
            );
            let rendered = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                !rendered.contains("cli-usage-invalid"),
                "valid legacy command must be parsed before any unavailable local transport: {rendered}"
            );
        }
    }

    #[test]
    fn fixed_manifest_verifier_never_accepts_arguments_or_executes_project_code() {
        let root = temp_dir("manifest-check");
        fs::write(root.join("package.json"), r#"{"name":"safe"}"#).unwrap();
        fs::write(root.join("project-script-marker"), "must not run").unwrap();
        let mut stdout = Vec::new();
        assert_eq!(run_static_manifest_check(&root, &mut stdout), 0);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&stdout).unwrap(),
            serde_json::json!({
                "ok":true,
                "status":"passed",
                "exitCode":EXIT_OK,
                "manifestName":"package.json",
                "reason":"valid",
                "protocol":CLI_PROTOCOL,
                "protocolIdentity":cli_protocol_identity(),
            })
        );
        fs::write(root.join("package.json"), b"not json").unwrap();
        stdout.clear();
        assert_eq!(run_static_manifest_check(&root, &mut stdout), 4);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&stdout).unwrap()["reason"],
            "format-invalid"
        );
        fs::write(root.join("package.json"), [0xff, 0xfe, 0xfd]).unwrap();
        stdout.clear();
        assert_eq!(run_static_manifest_check(&root, &mut stdout), 4);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&stdout).unwrap()["reason"],
            "encoding-invalid"
        );
        assert!(root.join("project-script-marker").exists());
        fs::write(
            root.join("package.json"),
            b"\xef\xbb\xbf{\"name\":\"safe-bom\"}",
        )
        .unwrap();
        stdout.clear();
        assert_eq!(run_static_manifest_check(&root, &mut stdout), 0);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&stdout).unwrap()["reason"],
            "valid",
            "one standard UTF-8 BOM is accepted before strict manifest parsing"
        );
        fs::write(root.join("package.json"), b"").unwrap();
        stdout.clear();
        assert_eq!(run_static_manifest_check(&root, &mut stdout), 4);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&stdout).unwrap(),
            serde_json::json!({
                "ok":false,
                "status":"failed",
                "exitCode":EXIT_TOOL,
                "manifestName":"package.json",
                "reason":"empty",
                "protocol":CLI_PROTOCOL,
                "protocolIdentity":cli_protocol_identity(),
            })
        );
    }

    #[test]
    fn fixed_manifest_verifier_strictly_parses_cargo_and_pyproject_toml() {
        for (label, manifest_name, malformed, valid) in [
            (
                "cargo-toml",
                "Cargo.toml",
                "[package]\nname = \"safe\"\nbroken = [\n",
                "[package]\nname = \"safe\"\nversion = \"0.1.0\"\n",
            ),
            (
                "pyproject-toml",
                "pyproject.toml",
                "[project]\nname = \"safe\"\nbroken = {\n",
                "[project]\nname = \"safe\"\nversion = \"0.1.0\"\n",
            ),
        ] {
            let root = temp_dir(label);
            fs::write(root.join(manifest_name), malformed).unwrap();
            let mut stdout = Vec::new();
            assert_eq!(run_static_manifest_check(&root, &mut stdout), EXIT_TOOL);
            let failure: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
            assert_eq!(failure["status"], "failed");
            assert_eq!(failure["manifestName"], manifest_name);
            assert_eq!(failure["reason"], "format-invalid");

            let mut valid_with_bom = vec![0xef, 0xbb, 0xbf];
            valid_with_bom.extend_from_slice(valid.as_bytes());
            fs::write(root.join(manifest_name), valid_with_bom).unwrap();
            stdout.clear();
            assert_eq!(run_static_manifest_check(&root, &mut stdout), EXIT_OK);
            let success: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
            assert_eq!(success["status"], "passed");
            assert_eq!(success["manifestName"], manifest_name);
            assert_eq!(success["reason"], "valid");
        }
    }

    #[test]
    fn fixed_manifest_verifier_rejects_nul_and_missing_required_toml_tables() {
        for (label, manifest_name, contents, reason) in [
            (
                "cargo-missing-package",
                "Cargo.toml",
                "[workspace]\nmembers = []\n",
                "format-invalid",
            ),
            (
                "pyproject-missing-project",
                "pyproject.toml",
                "[build-system]\nrequires = []\n",
                "format-invalid",
            ),
            (
                "cargo-nul",
                "Cargo.toml",
                "[package]\nname = \"safe\"\n\0",
                "encoding-invalid",
            ),
        ] {
            let root = temp_dir(label);
            fs::write(root.join(manifest_name), contents.as_bytes()).unwrap();
            let mut stdout = Vec::new();
            assert_eq!(run_static_manifest_check(&root, &mut stdout), EXIT_TOOL);
            let failure: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
            assert_eq!(failure["status"], "failed");
            assert_eq!(failure["manifestName"], manifest_name);
            assert_eq!(failure["reason"], reason);
        }
    }

    #[test]
    fn protocol_identity_is_local_structured_and_never_connects() {
        let mut stdout = Vec::new();
        assert_eq!(write_protocol_identity(&mut stdout), EXIT_OK);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&stdout).unwrap(),
            serde_json::json!({
                "ok":true,
                "protocol":CLI_PROTOCOL,
                "identity":cli_protocol_identity(),
            })
        );
    }

    #[test]
    fn cli_runs_a_write_once_and_never_persists_or_prints_its_sensitive_input() {
        let app_data = temp_dir("write-app");
        let vault_root = temp_dir("write-vault");
        fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: "vault-cli-write".to_string(),
            name: "CLI write".to_string(),
            root_path: vault_root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-16T00:00:00Z".to_string(),
            last_opened_at: "2026-07-16T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            vault_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        backend.knowledge().register_current_vault(&vault).unwrap();
        let server = start_server(
            ServerConfig::test(app_data.clone()),
            Arc::new(LegacyLocalTransportAdapter::new(backend)),
        )
        .unwrap();
        let port = server
            .client_config()
            .base_url
            .rsplit(':')
            .next()
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let sensitive = "PRIVATE-CLI-BODY-SENTINEL";
        let input = serde_json::json!({
            "expectedVaultId":vault.id,
            "relativePath":"CLI.md",
            "content":sensitive
        })
        .to_string();
        let args = vec![
            "tools".to_string(),
            "run".to_string(),
            "knowledge.create".to_string(),
            "--input".to_string(),
            input,
            "--request-id".to_string(),
            "cli-write-once".to_string(),
        ];

        let execute = || {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let code = run_with_connector(
                args.clone(),
                Cursor::new(Vec::<u8>::new()),
                &mut stdout,
                &mut stderr,
                || ToolClient::connect_with(&app_data, [port]),
            );
            (code, stdout, stderr)
        };
        let first = execute();
        let replay = execute();

        assert_eq!(first.0, 0);
        assert_eq!(replay.0, 0);
        assert_eq!(first.1, replay.1);
        assert!(first.2.is_empty());
        assert!(!String::from_utf8_lossy(&first.1).contains(sensitive));
        assert_eq!(
            fs::read_to_string(vault_root.join("CLI.md")).unwrap(),
            sensitive
        );
        assert_eq!(
            fs::read_dir(&vault_root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(
                    |entry| entry.path().extension().and_then(|value| value.to_str()) == Some("md")
                )
                .count(),
            1
        );
    }

    #[test]
    fn invalid_or_oversized_input_never_connects() {
        let calls = AtomicUsize::new(0);
        let execute = |args: Vec<String>, stdin: Vec<u8>| {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let code =
                run_with_connector(args, Cursor::new(stdin), &mut stdout, &mut stderr, || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    panic!("invalid CLI input must not discover a server")
                });
            (code, stdout, stderr)
        };

        let malformed = execute(
            vec![
                "tools".into(),
                "run".into(),
                "knowledge.search".into(),
                "--input".into(),
                "{".into(),
            ],
            Vec::new(),
        );
        let unknown = execute(
            vec!["tools".into(), "list".into(), "--extra".into()],
            Vec::new(),
        );
        let oversized = execute(
            vec![
                "tools".into(),
                "run".into(),
                "knowledge.search".into(),
                "--stdin".into(),
            ],
            vec![b'x'; MAX_INPUT_BYTES + 1],
        );

        for result in [malformed, unknown, oversized] {
            assert_eq!(result.0, 2);
            assert!(result.1.is_empty());
            let error: serde_json::Value = serde_json::from_slice(&result.2).unwrap();
            assert_eq!(error["error"]["code"], "cli-usage-invalid");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn read_runs_and_typed_tool_failures_have_distinct_machine_exit_codes() {
        let app_data = temp_dir("read-error-app");
        let backend = Arc::new(BackendServices::initialize(&app_data).unwrap());
        let server = start_server(
            ServerConfig::test(app_data.clone()),
            Arc::new(LegacyLocalTransportAdapter::new(backend.clone())),
        )
        .unwrap();
        let port = server
            .client_config()
            .base_url
            .rsplit(':')
            .next()
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let execute = |args: Vec<String>| {
            let mut stdout = Vec::new();
            let mut stderr = Vec::new();
            let code = run_with_connector(
                args,
                Cursor::new(Vec::<u8>::new()),
                &mut stdout,
                &mut stderr,
                || ToolClient::connect_with(&app_data, [port]),
            );
            (code, stdout, stderr)
        };

        let no_vault = execute(vec![
            "tools".into(),
            "run".into(),
            "knowledge.search".into(),
            "--input".into(),
            r#"{"query":"needle","limit":1}"#.into(),
        ]);
        assert_eq!(no_vault.0, 4);
        assert!(no_vault.1.is_empty());
        let failure: serde_json::Value = serde_json::from_slice(&no_vault.2).unwrap();
        assert_eq!(failure["error"]["code"], "knowledge-vault-required");

        let vault_root = temp_dir("read-vault");
        let vault = KnowledgeVaultRegistration {
            id: "vault-cli-read".to_string(),
            name: "CLI read".to_string(),
            root_path: vault_root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-16T00:00:00Z".to_string(),
            last_opened_at: "2026-07-16T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        fs::write(
            vault_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        fs::write(vault_root.join("Read.md"), "needle").unwrap();
        backend.knowledge().register_current_vault(&vault).unwrap();

        let read = execute(vec![
            "tools".into(),
            "run".into(),
            "knowledge.search".into(),
            "--input".into(),
            r#"{"query":"needle","limit":1}"#.into(),
        ]);
        assert_eq!(read.0, 0);
        assert!(read.2.is_empty());
        let result: serde_json::Value = serde_json::from_slice(&read.1).unwrap();
        assert_eq!(
            result["result"]["documents"][0]["documentRef"]["vaultId"],
            vault.id
        );
    }
}
