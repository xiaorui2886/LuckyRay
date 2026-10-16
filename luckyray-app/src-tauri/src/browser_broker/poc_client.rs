//! Internal-only parent seam for the standalone R4-A2 host POC.
//!
//! This module is feature gated, is not a Tauri command, and never accepts an
//! executable path from a caller. Production Personal Browser commands remain
//! fail-closed in the parent module.

use rand::{distributions::Alphanumeric, Rng};
use serde::Deserialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProbeResponse {
    version: u32,
    id: String,
    event: String,
    phase: String,
    challenge: String,
    session_nonce: String,
    availability: String,
    code: String,
    profile_fingerprint: Option<String>,
    security: Option<serde_json::Value>,
    test_storage: Option<serde_json::Value>,
}

#[allow(dead_code)]
#[derive(Debug)]
pub(super) struct BrowserHostPocProbe {
    pub(super) availability: &'static str,
    pub(super) code: &'static str,
}

#[allow(dead_code)]
pub(super) struct BrowserHostPocLauncher;

impl BrowserHostPocLauncher {
    #[allow(dead_code)]
    pub(super) fn probe() -> Result<BrowserHostPocProbe, &'static str> {
        Self::probe_executable(exact_sibling_executable()?)
    }

    fn probe_executable(executable: PathBuf) -> Result<BrowserHostPocProbe, &'static str> {
        Self::probe_command(Command::new(executable))
    }

    fn probe_command(mut command: Command) -> Result<BrowserHostPocProbe, &'static str> {
        let challenge: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(48)
            .map(char::from)
            .collect();
        let request = serde_json::json!({
            "version": 1,
            "id": "parent-probe",
            "command": "initialize",
            "challenge": challenge,
            "workspaceId": "parent-probe",
        });
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "browser-host-unavailable")?;
        let mut stdin = child.stdin.take().ok_or("browser-host-terminated")?;
        serde_json::to_writer(&mut stdin, &request).map_err(|_| "browser-host-protocol-invalid")?;
        stdin
            .write_all(b"\n")
            .map_err(|_| "browser-host-terminated")?;
        drop(stdin);
        let stdout = child.stdout.take().ok_or("browser-host-terminated")?;
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        reader
            .by_ref()
            .take((MAX_RESPONSE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| "browser-host-terminated")?;
        let status = child.wait().map_err(|_| "browser-host-terminated")?;
        if !status.success() || line.is_empty() || line.len() > MAX_RESPONSE_BYTES {
            return Err("browser-host-terminated");
        }
        let response: ProbeResponse =
            serde_json::from_slice(&line).map_err(|_| "browser-host-protocol-invalid")?;
        if response.version != 1
            || response.id != "parent-probe"
            || response.event != "initialized"
            || response.phase != "unavailable"
            || response.challenge != challenge
            || response.session_nonce.len() < 32
            || response.availability != "poc-only"
            || response.code != "browser-host-remote-navigation-unavailable"
            || response.profile_fingerprint.is_some()
            || response.security.is_some()
            || response.test_storage.is_some()
        {
            return Err("browser-host-protocol-invalid");
        }
        Ok(BrowserHostPocProbe {
            availability: "poc-only",
            code: "browser-host-remote-navigation-unavailable",
        })
    }
}

fn exact_sibling_executable() -> Result<PathBuf, &'static str> {
    let current = std::env::current_exe().map_err(|_| "browser-host-unavailable")?;
    let directory = current.parent().ok_or("browser-host-unavailable")?;
    let base = if directory.file_name().and_then(|name| name.to_str()) == Some("deps") {
        directory.parent().ok_or("browser-host-unavailable")?
    } else {
        directory
    };
    let executable = base.join("luckyray-browser-host-poc.exe");
    if executable.is_file() {
        Ok(executable)
    } else {
        Err("browser-host-unavailable")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_probe_validates_the_exact_child_challenge() {
        let probe = BrowserHostPocLauncher::probe().unwrap();
        assert_eq!(probe.availability, "poc-only");
        assert_eq!(probe.code, "browser-host-remote-navigation-unavailable");
    }

    #[test]
    fn premature_child_eof_is_a_stable_terminated_error() {
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/c", "exit", "0"]);
        let error = BrowserHostPocLauncher::probe_command(command).unwrap_err();
        assert_eq!(error, "browser-host-terminated");
    }
}
