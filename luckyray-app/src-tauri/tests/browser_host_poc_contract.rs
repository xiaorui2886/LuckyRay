#![cfg(feature = "browser-host-poc")]

use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(debug_assertions)]
use std::io::{BufRead, BufReader};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
#[cfg(debug_assertions)]
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

static WORKSPACE_NONCE: AtomicU64 = AtomicU64::new(1);
static WEBVIEW_TEST_GUARD: Mutex<()> = Mutex::new(());

fn webview_test_guard() -> std::sync::MutexGuard<'static, ()> {
    WEBVIEW_TEST_GUARD
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn unique_workspace(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let sequence = WORKSPACE_NONCE.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{nanos}-{sequence}", std::process::id())
}

fn spawn_host(input: &[u8]) -> (std::process::ExitStatus, Vec<u8>, Vec<u8>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_luckyray-browser-host-poc"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    (output.status, output.stdout, output.stderr)
}

fn spawn_fixture_host(input: &[u8]) -> (std::process::ExitStatus, Vec<u8>, Vec<u8>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_luckyray-browser-host-poc"))
        .arg("--test-fixture")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    eprintln!("hidden browser-host POC pid={}", child.id());
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    (output.status, output.stdout, output.stderr)
}

#[cfg(debug_assertions)]
#[test]
fn production_host_initializes_reports_safe_state_and_closes_over_strict_stdio() {
    let _guard = webview_test_guard();
    let fixture_id = "production-init-test";
    remove_production_profile(fixture_id);
    let mut child = Command::new(env!("CARGO_BIN_EXE_luckyray-browser-host"))
        .arg("--test-window-hidden")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(stdin, "{{\"version\":1,\"id\":\"init-production\",\"command\":\"initialize\",\"challenge\":\"production-challenge\",\"testFixtureHidden\":true,\"testFixtureId\":\"production-init-test\"}}").unwrap();
    let mut line = String::new();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let initialized: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(initialized["event"], "session-ready");
    assert_eq!(initialized["status"], "idle");
    assert_eq!(initialized["origin"], Value::Null);
    assert_eq!(initialized["title"], Value::Null);
    assert_eq!(initialized["canGoBack"], false);
    assert_eq!(initialized["canGoForward"], false);
    assert_eq!(initialized["generation"], 0);
    assert_eq!(initialized["challenge"], "production-challenge");
    assert!(initialized.get("profilePath").is_none());
    let nonce = initialized["sessionNonce"].as_str().unwrap();

    line.clear();
    writeln!(stdin, "{{\"version\":1,\"id\":\"status-production\",\"command\":\"status\",\"sessionNonce\":\"{nonce}\",\"expectedGeneration\":0}}").unwrap();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let status: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(status["event"], "status");
    assert_eq!(status["status"], "idle");

    line.clear();
    writeln!(stdin, "{{\"version\":1,\"id\":\"close-production\",\"command\":\"close\",\"sessionNonce\":\"{nonce}\",\"expectedGeneration\":0}}").unwrap();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let closed: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(closed["event"], "closed");
    assert_eq!(closed["status"], "closed");
    drop(stdin);
    assert!(child.wait().unwrap().success());
    remove_production_profile(fixture_id);
}

#[cfg(debug_assertions)]
#[test]
fn production_host_navigates_history_reload_and_stop_with_safe_state_only() {
    let _guard = webview_test_guard();
    let fixture_id = "production-navigation-test";
    remove_production_profile(fixture_id);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let redirect_target = TcpListener::bind("127.0.0.1:0").unwrap();
    redirect_target.set_nonblocking(true).unwrap();
    let redirect_target_port = redirect_target.local_addr().unwrap().port();
    let redirect_target_hits = Arc::new(AtomicUsize::new(0));
    let redirect_hits = Arc::clone(&redirect_target_hits);
    let redirect_target_server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            match redirect_target.accept() {
                Ok((mut stream, _)) => {
                    if !read_request(&mut stream).is_empty() {
                        redirect_hits.fetch_add(1, Ordering::SeqCst);
                    }
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(_) => break,
            }
        }
    });
    let resource_target = TcpListener::bind("127.0.0.1:0").unwrap();
    resource_target.set_nonblocking(true).unwrap();
    let resource_target_port = resource_target.local_addr().unwrap().port();
    let resource_target_hits = Arc::new(AtomicUsize::new(0));
    let resource_target_request = Arc::new(Mutex::new(Vec::<u8>::new()));
    let resource_hits = Arc::clone(&resource_target_hits);
    let resource_request = Arc::clone(&resource_target_request);
    let resource_target_server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            match resource_target.accept() {
                Ok((mut stream, _)) => {
                    let request = read_request(&mut stream);
                    if !request.is_empty() {
                        *resource_request.lock().unwrap() = request;
                        resource_hits.fetch_add(1, Ordering::SeqCst);
                    }
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(_) => break,
            }
        }
    });
    let security_report = Arc::new(Mutex::new(None::<Value>));
    let popup_hits = Arc::new(AtomicUsize::new(0));
    let download_hits = Arc::new(AtomicUsize::new(0));
    let server_report = Arc::clone(&security_report);
    let server_popup_hits = Arc::clone(&popup_hits);
    let server_download_hits = Arc::clone(&download_hits);
    let (stop_tx, stop_rx) = mpsc::channel();
    let server = std::thread::spawn(move || loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let server_report = Arc::clone(&server_report);
                let server_popup_hits = Arc::clone(&server_popup_hits);
                let server_download_hits = Arc::clone(&server_download_hits);
                std::thread::spawn(move || {
                    let request = read_request(&mut stream);
                    let text = String::from_utf8_lossy(&request);
                    let path = text
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or_default()
                        .split('?')
                        .next()
                        .unwrap_or_default();
                    if path == "/report" {
                        if let Some(body) = text.split("\r\n\r\n").nth(1) {
                            if let Ok(report) = serde_json::from_str(body) {
                                *server_report.lock().unwrap() = Some(report);
                            }
                        }
                        let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        return;
                    }
                    if path == "/popup-target" {
                        server_popup_hits.fetch_add(1, Ordering::SeqCst);
                    }
                    if path == "/download-target" {
                        server_download_hits.fetch_add(1, Ordering::SeqCst);
                    }
                    if path == "/redirect-private" {
                        let response = format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{redirect_target_port}/blocked\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        let _ = stream.write_all(response.as_bytes());
                        return;
                    }
                    let (title, delay) = match path {
                        "/fixture_prod_one" => ("One", false),
                        "/fixture_prod_two" => ("Two", false),
                        "/fixture_prod_slow" => ("Slow", true),
                        _ => ("Missing", false),
                    };
                    if delay {
                        std::thread::sleep(Duration::from_secs(2));
                    }
                    let body = format!(
                        r#"<!doctype html><title>{title}</title><main>{title}</main><script>
                    (async()=>{{
                      const popup = window.open('/popup-target', '_blank');
                      const link = document.createElement('a'); link.href='/download-target'; link.download='blocked.txt'; link.click();
                      await fetch('http://127.0.0.1:{resource_target_port}/private-subresource').catch(()=>null);
                      let permissionDenied = false;
                      try {{ await navigator.mediaDevices.getUserMedia({{audio:true}}); }} catch {{ permissionDenied = true; }}
                      await fetch('/report', {{method:'POST',body:JSON.stringify({{
                        tauri: typeof window.__TAURI__, internals: typeof window.__TAURI_INTERNALS__, ipc: typeof window.__TAURI_IPC__,
                        popupDenied: popup === null, permissionDenied
                      }})}});
                    }})();
                    </script>"#
                    );
                    let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    let _ = stream.write_all(headers.as_bytes());
                    let _ = stream.write_all(body.as_bytes());
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_luckyray-browser-host"))
        .arg("--test-window-hidden")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(stdin, "{{\"version\":1,\"id\":\"init\",\"command\":\"initialize\",\"challenge\":\"navigation-challenge\",\"testFixtureHidden\":true,\"testFixturePort\":{port},\"testFixtureId\":\"{fixture_id}\"}}").unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let initialized: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(initialized["event"], "session-ready", "{initialized}");
    assert_eq!(initialized["controlMode"], "user-only");
    assert_eq!(initialized["agentAutomation"], "unavailable");
    assert_eq!(initialized["networkIsolation"], "top-level-only");
    assert_eq!(
        initialized["privateSubresourcePrevention"],
        "not-guaranteed"
    );
    let nonce = initialized["sessionNonce"].as_str().unwrap();
    let mut generation = 0u64;

    let private_initial = send_production_command(
        &mut stdin,
        &mut stdout,
        nonce,
        &mut generation,
        "private-initial",
        "navigate",
        Some(format!(
            "http://127.0.0.1:{resource_target_port}/private-initial"
        )),
    );
    assert_eq!(private_initial["code"], "browser-navigation-private-target");
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(resource_target_hits.load(Ordering::SeqCst), 0);

    let first = send_production_command(
        &mut stdin,
        &mut stdout,
        nonce,
        &mut generation,
        "navigate-one",
        "navigate",
        Some(format!(
            "http://127.0.0.1:{port}/fixture_prod_one?private=never-return#fragment"
        )),
    );
    assert_eq!(first["event"], "navigating", "{first}");
    assert_eq!(first["origin"], format!("http://127.0.0.1:{port}"));
    assert!(!first.to_string().contains("private=never-return"));
    let loaded_one = wait_for_production_loaded(
        &mut stdin,
        &mut stdout,
        nonce,
        &mut generation,
        "status-one",
    );
    assert_eq!(loaded_one["title"], "One");
    let report_deadline = Instant::now() + Duration::from_secs(5);
    while security_report.lock().unwrap().is_none() && Instant::now() < report_deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let report = security_report
        .lock()
        .unwrap()
        .clone()
        .expect("security report");
    assert_eq!(report["tauri"], "undefined");
    assert_eq!(report["internals"], "undefined");
    assert_eq!(report["ipc"], "undefined");
    assert_eq!(report["popupDenied"], true);
    assert_eq!(report["permissionDenied"], true);
    assert_eq!(popup_hits.load(Ordering::SeqCst), 0);
    assert_eq!(
        download_hits.load(Ordering::SeqCst),
        1,
        "download request begins before WebView2 raises the cancellation event"
    );
    let resource_deadline = Instant::now() + Duration::from_secs(5);
    while resource_target_hits.load(Ordering::SeqCst) == 0 && Instant::now() < resource_deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        resource_target_hits.load(Ordering::SeqCst),
        1,
        "ordinary Chromium subresource networking is not a pre-connect boundary"
    );
    let private_request =
        String::from_utf8_lossy(&resource_target_request.lock().unwrap()).to_ascii_lowercase();
    for forbidden in [
        "authorization:",
        "proxy-authorization:",
        "cookie:",
        "bearer",
        "luckyray",
        "vault",
    ] {
        assert!(
            !private_request.contains(forbidden),
            "forbidden header marker {forbidden}"
        );
    }

    let redirect = send_production_command(
        &mut stdin,
        &mut stdout,
        nonce,
        &mut generation,
        "redirect-private",
        "navigate",
        Some(format!("http://127.0.0.1:{port}/redirect-private")),
    );
    assert_eq!(redirect["status"], "loading", "{redirect}");
    let redirect_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let current = send_production_command(
            &mut stdin,
            &mut stdout,
            nonce,
            &mut generation,
            "redirect-status",
            "status",
            None,
        );
        if current["status"] == "error" {
            break;
        }
        assert!(
            Instant::now() < redirect_deadline,
            "redirect status={current}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(redirect_target_hits.load(Ordering::SeqCst), 0);

    let second = send_production_command(
        &mut stdin,
        &mut stdout,
        nonce,
        &mut generation,
        "navigate-two",
        "navigate",
        Some(format!("http://127.0.0.1:{port}/fixture_prod_two")),
    );
    assert_eq!(second["event"], "navigating");
    let loaded_two = wait_for_production_loaded(
        &mut stdin,
        &mut stdout,
        nonce,
        &mut generation,
        "status-two",
    );
    assert_eq!(loaded_two["title"], "Two");
    assert_eq!(loaded_two["canGoBack"], true);

    for (id, action, expected_title) in [
        ("back", "back", "One"),
        ("forward", "forward", "Two"),
        ("reload", "reload", "Two"),
    ] {
        assert_eq!(
            send_production_command(
                &mut stdin,
                &mut stdout,
                nonce,
                &mut generation,
                id,
                action,
                None,
            )["event"],
            "navigating"
        );
        assert_eq!(
            wait_for_production_loaded(
                &mut stdin,
                &mut stdout,
                nonce,
                &mut generation,
                &format!("status-{id}"),
            )["title"],
            expected_title
        );
    }

    let slow = send_production_command(
        &mut stdin,
        &mut stdout,
        nonce,
        &mut generation,
        "navigate-slow",
        "navigate",
        Some(format!("http://127.0.0.1:{port}/fixture_prod_slow")),
    );
    assert_eq!(slow["status"], "loading");
    let stopped = send_production_command(
        &mut stdin,
        &mut stdout,
        nonce,
        &mut generation,
        "stop",
        "stop",
        None,
    );
    assert_eq!(stopped["event"], "stopped");
    assert_ne!(stopped["status"], "loading");
    assert_eq!(
        send_production_command(
            &mut stdin,
            &mut stdout,
            nonce,
            &mut generation,
            "close",
            "close",
            None,
        )["event"],
        "closed"
    );
    drop(stdin);
    assert!(child.wait().unwrap().success());
    let _ = stop_tx.send(());
    server.join().unwrap();
    redirect_target_server.join().unwrap();
    resource_target_server.join().unwrap();
    remove_production_profile(fixture_id);
}

fn read_request(stream: &mut TcpStream) -> Vec<u8> {
    stream
        .set_read_timeout(Some(Duration::from_millis(250)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                bytes.extend_from_slice(&chunk[..read]);
                let header_end = bytes.windows(4).position(|part| part == b"\r\n\r\n");
                if let Some(header_end) = header_end {
                    let headers = String::from_utf8_lossy(&bytes[..header_end]);
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("Content-Length: "))
                        .and_then(|value| value.parse::<usize>().ok())
                        .unwrap_or(0);
                    if bytes.len() >= header_end + 4 + length {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
    bytes
}

fn fixture_html() -> &'static str {
    r#"<!doctype html><meta charset="utf-8"><script>
window.__luckyrayStartSecurityProbe = async () => {
  const probe = {
    tauriAbsent: typeof window.__TAURI__ === 'undefined',
    internalsAbsent: typeof window.__TAURI_INTERNALS__ === 'undefined',
    tauriIpcAbsent: typeof window.__TAURI_IPC__ === 'undefined',
    wryIpcAbsent: typeof window.ipc === 'undefined',
    externalInvokeAbsent: !(window.external && typeof window.external.invoke === 'function')
  };
  window.open('/popup-denied');
  let permissionProbe = Promise.resolve();
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    permissionProbe = navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
  }
  const download = document.createElement('a');
  download.href = '/download-denied';
  download.download = 'blocked.txt';
  document.body.append(download);
  download.click();
  const external = document.createElement('a');
  external.href = 'https://example.invalid/blocked';
  document.body.append(external);
  external.click();
  await permissionProbe;
  window.__luckyrayPocProbeComplete = probe;
  await fetch('/report', { method: 'POST', body: JSON.stringify(probe) });
};
</script>"#
}

fn profile_path(workspace: &str) -> std::path::PathBuf {
    let digest = Sha256::digest(workspace.as_bytes());
    let key: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    std::env::temp_dir()
        .join("luckyray-browser-host-poc-tests-v1")
        .join("personal")
        .join(key)
}

fn production_profile_path(fixture_id: &str) -> std::path::PathBuf {
    let digest = Sha256::digest(fixture_id.as_bytes());
    let key: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    std::env::temp_dir()
        .join("luckyray-browser-host-production-tests-v1")
        .join("personal")
        .join(key)
}

fn remove_production_profile(fixture_id: &str) {
    let path = production_profile_path(fixture_id);
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match std::fs::remove_dir_all(&path) {
            Ok(()) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => panic!("production test profile cleanup failed: {error}"),
        }
    }
}

fn send_production_command(
    stdin: &mut impl Write,
    stdout: &mut impl BufRead,
    nonce: &str,
    generation: &mut u64,
    id: &str,
    kind: &str,
    url: Option<String>,
) -> Value {
    let mut request = serde_json::json!({
        "version": 1,
        "id": id,
        "command": kind,
        "sessionNonce": nonce,
        "expectedGeneration": *generation,
    });
    if let Some(url) = url {
        request["url"] = Value::String(url);
    }
    writeln!(stdin, "{}", request).unwrap();
    let mut line = String::new();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let response: Value = serde_json::from_str(&line).unwrap();
    *generation = response["generation"].as_u64().unwrap();
    response
}

fn wait_for_production_loaded(
    stdin: &mut impl Write,
    stdout: &mut impl BufRead,
    nonce: &str,
    generation: &mut u64,
    label: &str,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let response =
            send_production_command(stdin, stdout, nonce, generation, label, "status", None);
        if response["status"] == "loaded" {
            return response;
        }
        assert!(Instant::now() < deadline, "status={response}");
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(debug_assertions)]
fn remove_test_profile(workspace: &str) {
    let path = profile_path(workspace);
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match std::fs::remove_dir_all(&path) {
            Ok(()) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => panic!("test profile cleanup failed: {error}"),
        }
    }
}

#[cfg(debug_assertions)]
fn start_simple_server(html: &'static str) -> (u16, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut reported = false;
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let request = read_request(&mut stream);
                    let text = String::from_utf8_lossy(&request);
                    let path = text
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or_default();
                    if path == "/report" {
                        reported = true;
                        let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    } else if path.starts_with("/fixture_") {
                        let bytes = html.as_bytes();
                        let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len());
                        let _ = stream.write_all(headers.as_bytes());
                        let _ = stream.write_all(bytes);
                    } else {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                    if reported {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
    });
    (port, handle)
}

#[cfg(debug_assertions)]
fn spawn_storage_host(workspace: &str, port: u16, token: &str, mode: &str) -> Value {
    let input = format!(
        "{{\"version\":1,\"id\":\"init-storage\",\"command\":\"initialize\",\"challenge\":\"storage-challenge\",\"workspaceId\":\"{workspace}\",\"testFixtureUrl\":\"http://127.0.0.1:{port}/{token}\",\"testFixtureExpectSecurity\":true,\"testFixtureStorage\":\"{mode}\"}}\n"
    );
    let (status, stdout, stderr) = spawn_fixture_host(input.as_bytes());
    assert!(
        status.success(),
        "workspace={workspace} mode={mode} stdout={} stderr={}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    );
    serde_json::from_slice(&stdout).unwrap()
}

#[cfg(debug_assertions)]
#[test]
fn close_is_generation_guarded_and_idempotent_before_eof() {
    let _guard = webview_test_guard();
    let (port, server) = start_simple_server(fixture_html());
    let workspace = unique_workspace("close-workspace");
    let mut child = Command::new(env!("CARGO_BIN_EXE_luckyray-browser-host-poc"))
        .arg("--test-fixture")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(stdin, "{{\"version\":1,\"id\":\"init-close\",\"command\":\"initialize\",\"challenge\":\"close-challenge\",\"workspaceId\":\"{workspace}\",\"testFixtureUrl\":\"http://127.0.0.1:{port}/fixture_close_1234567890\",\"testFixtureExpectSecurity\":true}}").unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let initialized: Value = serde_json::from_str(&line).unwrap();
    let nonce = initialized["sessionNonce"].as_str().unwrap();
    writeln!(stdin, "{{\"version\":1,\"id\":\"close-wrong-nonce\",\"command\":\"close\",\"sessionNonce\":\"wrong-session-nonce\",\"expectedGeneration\":0}}").unwrap();
    stdin.flush().unwrap();
    line.clear();
    stdout.read_line(&mut line).unwrap();
    let wrong_nonce: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(wrong_nonce["code"], "browser-session-invalid");
    assert_eq!(wrong_nonce["generation"], 0);
    writeln!(stdin, "{{\"version\":1,\"id\":\"close-stale\",\"command\":\"close\",\"sessionNonce\":\"{nonce}\",\"expectedGeneration\":9}}").unwrap();
    stdin.flush().unwrap();
    line.clear();
    stdout.read_line(&mut line).unwrap();
    let stale: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(stale["code"], "browser-generation-stale");
    assert_eq!(stale["generation"], 0);
    writeln!(stdin, "{{\"version\":1,\"id\":\"close-ok\",\"command\":\"close\",\"sessionNonce\":\"{nonce}\",\"expectedGeneration\":0}}").unwrap();
    stdin.flush().unwrap();
    line.clear();
    stdout.read_line(&mut line).unwrap();
    let closed: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(closed["event"], "closed", "{closed}");
    assert_eq!(closed["generation"], 1);
    writeln!(stdin, "{{\"version\":1,\"id\":\"close-again\",\"command\":\"close\",\"sessionNonce\":\"{nonce}\",\"expectedGeneration\":1}}").unwrap();
    stdin.flush().unwrap();
    line.clear();
    stdout.read_line(&mut line).unwrap();
    let again: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(again["event"], "closed");
    assert_eq!(again["generation"], 1);
    drop(stdin);
    assert!(child.wait().unwrap().success());
    server.join().unwrap();
    remove_test_profile(&workspace);
}

#[cfg(debug_assertions)]
#[test]
fn profile_lease_allows_real_webview_writes_but_blocks_external_replacement_until_close() {
    let _guard = webview_test_guard();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let (release_tx, release_rx) = mpsc::channel();
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if release_rx.try_recv().is_ok() {
                break;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let request = read_request(&mut stream);
                    let text = String::from_utf8_lossy(&request);
                    let path = text
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or_default();
                    if path == "/fixture_lease_1234567890" {
                        let html = fixture_html().as_bytes();
                        let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", html.len());
                        let _ = stream.write_all(headers.as_bytes());
                        let _ = stream.write_all(html);
                    } else if path == "/report" {
                        let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    } else if path == "/download-denied" {
                        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Disposition: attachment; filename=blocked.txt\r\nContent-Length: 7\r\nConnection: close\r\n\r\nblocked");
                    } else {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(_) => break,
            }
        }
    });
    let workspace = unique_workspace("lease-workspace");
    let profile = profile_path(&workspace);
    let moved = profile.with_extension("moved");
    let outside = profile.with_extension("outside");
    let _ = std::fs::remove_dir_all(&profile);
    let _ = std::fs::remove_dir_all(&moved);
    let _ = std::fs::remove_dir_all(&outside);
    std::fs::create_dir_all(&outside).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_luckyray-browser-host-poc"))
        .arg("--test-fixture")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(stdin, "{{\"version\":1,\"id\":\"init-lease\",\"command\":\"initialize\",\"challenge\":\"lease-challenge\",\"workspaceId\":\"{workspace}\",\"testFixtureUrl\":\"http://127.0.0.1:{port}/fixture_lease_1234567890\",\"testFixtureExpectSecurity\":true}}").unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let initialized: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(initialized["event"], "session-ready", "{initialized}");
    assert_eq!(initialized["phase"], "session-ready", "{initialized}");
    assert_eq!(initialized["code"], "ok", "{initialized}");
    assert!(profile.exists());
    assert!(
        std::fs::read_dir(&profile).unwrap().next().is_some(),
        "WebView2 must write the UDF while the lease is held"
    );
    let script = format!(
        r#"$ErrorActionPreference='SilentlyContinue'; $p='{}'; $m='{}'; $o='{}'; [IO.File]::WriteAllText((Join-Path $p 'lease-child.txt'),'ok'); $write=$?; Move-Item -LiteralPath $p -Destination $m -ErrorAction SilentlyContinue; $move=$?; Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue; cmd /c mklink /J "$p" "$o" *> $null; $replace=$?; [Console]::Out.Write((@{{write=$write;move=$move;replace=$replace;exists=(Test-Path -LiteralPath $p)}}|ConvertTo-Json -Compress))"#,
        profile.display().to_string().replace('\'', "''"),
        moved.display().to_string().replace('\'', "''"),
        outside.display().to_string().replace('\'', "''")
    );
    let attack = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .unwrap();
    let result: Value = serde_json::from_slice(&attack.stdout).unwrap();
    assert_eq!(result["write"], true);
    assert_eq!(result["move"], false);
    assert_eq!(result["replace"], false);
    assert_eq!(result["exists"], true);
    let nonce = initialized["sessionNonce"].as_str().unwrap();
    writeln!(stdin, "{{\"version\":1,\"id\":\"close-lease\",\"command\":\"close\",\"sessionNonce\":\"{nonce}\",\"expectedGeneration\":0}}").unwrap();
    stdin.flush().unwrap();
    line.clear();
    stdout.read_line(&mut line).unwrap();
    let closed: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(closed["event"], "closed", "{closed}");
    drop(stdin);
    assert!(child.wait().unwrap().success());
    release_tx.send(()).unwrap();
    server.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        match std::fs::rename(&profile, &moved) {
            Ok(()) => break,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => panic!("profile must become movable after close: {error}"),
        }
    }
    assert!(moved.exists());
    std::fs::remove_dir_all(moved).unwrap();
    std::fs::remove_dir_all(outside).unwrap();
}

#[cfg(debug_assertions)]
#[test]
fn forced_child_termination_releases_the_profile_for_a_clean_restart() {
    let _guard = webview_test_guard();
    let workspace = unique_workspace("crash-workspace");
    remove_test_profile(&workspace);
    let (port, server) = start_simple_server(fixture_html());
    let mut child = Command::new(env!("CARGO_BIN_EXE_luckyray-browser-host-poc"))
        .arg("--test-fixture")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(stdin, "{{\"version\":1,\"id\":\"init-crash\",\"command\":\"initialize\",\"challenge\":\"crash-challenge\",\"workspaceId\":\"{workspace}\",\"testFixtureUrl\":\"http://127.0.0.1:{port}/fixture_crash_1234567890\",\"testFixtureExpectSecurity\":true}}").unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["code"], "ok");
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
    server.join().unwrap();
    drop(stdin);
    drop(stdout);

    let (restart_port, restart_server) = start_simple_server(fixture_html());
    let input = format!(
        "{{\"version\":1,\"id\":\"init-restart\",\"command\":\"initialize\",\"challenge\":\"restart-challenge\",\"workspaceId\":\"{workspace}\",\"testFixtureUrl\":\"http://127.0.0.1:{restart_port}/fixture_restart_1234567890\",\"testFixtureExpectSecurity\":true}}\n"
    );
    let (status, stdout, stderr) = spawn_fixture_host(input.as_bytes());
    restart_server.join().unwrap();
    assert!(status.success(), "{}", String::from_utf8_lossy(&stderr));
    assert_eq!(
        serde_json::from_slice::<Value>(&stdout).unwrap()["code"],
        "ok"
    );
    remove_test_profile(&workspace);
}

#[cfg(debug_assertions)]
#[test]
fn persistent_personal_profiles_are_workspace_isolated_and_a_fresh_context_sees_no_state() {
    let _guard = webview_test_guard();
    let suffix = unique_workspace("storage");
    let workspace_a = format!("storage-a-{suffix}");
    let workspace_b = format!("storage-b-{suffix}");
    let fresh_agent_like = format!("storage-fresh-{suffix}");
    for workspace in [&workspace_a, &workspace_b, &fresh_agent_like] {
        let _ = std::fs::remove_dir_all(profile_path(workspace));
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let (server_stop_tx, server_stop_rx) = mpsc::channel();
    let server = std::thread::spawn(move || loop {
        match server_stop_rx.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                std::thread::spawn(move || {
                    let request = read_request(&mut stream);
                    let text = String::from_utf8_lossy(&request);
                    let path = text
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or_default();
                    if path.starts_with("/fixture_storage_") {
                        let body = fixture_html().as_bytes();
                        let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        let _ = stream.write_all(headers.as_bytes());
                        let _ = stream.write_all(body);
                    } else if path == "/report" {
                        let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    } else if path == "/download-denied" {
                        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Disposition: attachment; filename=blocked.txt\r\nContent-Length: 7\r\nConnection: close\r\n\r\nblocked");
                    }
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5))
            }
            Err(_) => break,
        }
    });
    let first_a = spawn_storage_host(&workspace_a, port, "fixture_storage_a_set_123456", "set");
    assert_eq!(
        first_a["testStorage"],
        serde_json::json!({"before": null, "after": "workspace-a-value"})
    );
    let b = spawn_storage_host(&workspace_b, port, "fixture_storage_b_read_12345", "read");
    assert_eq!(b["testStorage"], Value::Null);
    let fresh = spawn_storage_host(
        &fresh_agent_like,
        port,
        "fixture_storage_fresh_123456",
        "read",
    );
    assert_eq!(fresh["testStorage"], Value::Null);
    let reopened_a = spawn_storage_host(&workspace_a, port, "fixture_storage_a_read_12345", "read");
    assert_eq!(reopened_a["testStorage"], "workspace-a-value");
    server_stop_tx.send(()).unwrap();
    server.join().unwrap();
    assert_ne!(profile_path(&workspace_a), profile_path(&workspace_b));
    assert_ne!(profile_path(&workspace_a), profile_path(&fresh_agent_like));
    for workspace in [&workspace_a, &workspace_b, &fresh_agent_like] {
        remove_test_profile(workspace);
    }
}

#[cfg(debug_assertions)]
#[test]
fn raw_webview2_fixture_has_no_tauri_or_wry_bridge_and_denies_browser_effects() {
    let _guard = webview_test_guard();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let token = "fixture_token_1234567890";
    let report = Arc::new(Mutex::new(None::<Value>));
    let paths = Arc::new(Mutex::new(Vec::<String>::new()));
    let server_report = Arc::clone(&report);
    let server_paths = Arc::clone(&paths);
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let request = read_request(&mut stream);
                    let text = String::from_utf8_lossy(&request);
                    let first = text.lines().next().unwrap_or_default();
                    let path = first
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or_default()
                        .to_owned();
                    server_paths.lock().unwrap().push(path.clone());
                    if path == "/report" {
                        if let Some(index) = request.windows(4).position(|part| part == b"\r\n\r\n")
                        {
                            *server_report.lock().unwrap() =
                                serde_json::from_slice(&request[index + 4..]).ok();
                        }
                        let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    } else if path == format!("/{token}") {
                        let body = fixture_html().as_bytes();
                        let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                        let _ = stream.write_all(headers.as_bytes());
                        let _ = stream.write_all(body);
                    } else if path == "/download-denied" {
                        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Disposition: attachment; filename=blocked.txt\r\nContent-Length: 7\r\nConnection: close\r\n\r\nblocked");
                    } else {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                    if server_report.lock().unwrap().is_some() {
                        std::thread::sleep(Duration::from_millis(1500));
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
    });
    let workspace = unique_workspace("bridge-workspace");
    let input = format!(
        "{{\"version\":1,\"id\":\"init-2\",\"command\":\"initialize\",\"challenge\":\"parent-challenge-2\",\"workspaceId\":\"{workspace}\",\"testFixtureUrl\":\"http://127.0.0.1:{port}/{token}\",\"testFixtureExpectSecurity\":true}}\n"
    );
    let (status, stdout, stderr) = spawn_fixture_host(input.as_bytes());
    server.join().unwrap();
    assert!(
        status.success(),
        "status={status:?} stderr={}",
        String::from_utf8_lossy(&stderr)
    );
    assert!(stderr.is_empty());
    let response: Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(response["code"], "ok");
    assert_eq!(response["security"]["popupDenied"], 1);
    assert_eq!(response["security"]["downloadDenied"], 1);
    assert!(response["security"]["permissionDenied"].as_u64().unwrap() >= 1);
    assert!(response["security"]["navigationDenied"].as_u64().unwrap() >= 1);
    assert_eq!(
        report.lock().unwrap().as_ref().unwrap(),
        &serde_json::json!({
            "tauriAbsent": true,
            "internalsAbsent": true,
            "tauriIpcAbsent": true,
            "wryIpcAbsent": true,
            "externalInvokeAbsent": true
        })
    );
    assert!(!paths
        .lock()
        .unwrap()
        .iter()
        .any(|path| path == "/popup-denied"));
    remove_test_profile(&workspace);
}

#[cfg(debug_assertions)]
#[test]
fn fixture_urls_and_redirects_use_exact_structured_loopback_origins() {
    let _guard = webview_test_guard();
    let invalid_urls = [
        "http://127.0.0.1:80@evil.example/fixture_invalid_123456",
        "http://localhost:32123/fixture_invalid_123456",
        "http://127.0.0.1.:32123/fixture_invalid_123456",
        "http://2130706433:32123/fixture_invalid_123456",
        "http://0177.0.0.1:32123/fixture_invalid_123456",
        "http://127.1:32123/fixture_invalid_123456",
        "http://[::1]:32123/fixture_invalid_123456",
        "http://[::ffff:127.0.0.1]:32123/fixture_invalid_123456",
        "http://127.0.0.1:32123/fixture_invalid_123456#fragment",
        "http://127.0.0.1:321230/fixture_invalid_123456",
    ];
    for (index, url) in invalid_urls.iter().enumerate() {
        let workspace = unique_workspace(&format!("invalid-url-{index}"));
        let input = format!(
            "{{\"version\":1,\"id\":\"invalid-url-{index}\",\"command\":\"initialize\",\"challenge\":\"invalid-url-challenge\",\"workspaceId\":\"{workspace}\",\"testFixtureUrl\":\"{url}\",\"testFixtureExpectSecurity\":true}}\n"
        );
        let (status, stdout, stderr) = spawn_fixture_host(input.as_bytes());
        assert_eq!(status.code(), Some(70), "url={url}");
        assert!(stderr.is_empty());
        let failure: Value = serde_json::from_slice(&stdout).unwrap();
        assert_eq!(failure["event"], "session-failed", "{failure}");
        assert_eq!(failure["phase"], "fixture-url", "{failure}");
        assert_eq!(failure["code"], "browser-host-fixture-url-invalid");
        assert!(!profile_path(&workspace).exists());
    }

    let allowed = TcpListener::bind("127.0.0.1:0").unwrap();
    allowed.set_nonblocking(true).unwrap();
    let allowed_port = allowed.local_addr().unwrap().port();
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    target.set_nonblocking(true).unwrap();
    let target_port = target.local_addr().unwrap().port();
    let target_hits = Arc::new(AtomicUsize::new(0));
    let observed_target_hits = Arc::clone(&target_hits);
    let target_requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let observed_target_requests = Arc::clone(&target_requests);
    let (target_stop_tx, target_stop_rx) = mpsc::channel();
    let target_server = std::thread::spawn(move || loop {
        if target_stop_rx.try_recv().is_ok() {
            break;
        }
        match target.accept() {
            Ok((mut stream, _)) => {
                observed_target_hits.fetch_add(1, Ordering::SeqCst);
                let request = read_request(&mut stream);
                observed_target_requests
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&request).into_owned());
                let _ = stream.write_all(
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    });
    let (allowed_stop_tx, allowed_stop_rx) = mpsc::channel();
    let allowed_server = std::thread::spawn(move || loop {
        match allowed_stop_rx.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        match allowed.accept() {
            Ok((mut stream, _)) => {
                std::thread::spawn(move || {
                    let request = read_request(&mut stream);
                    let text = String::from_utf8_lossy(&request);
                    let path = text
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or_default();
                    if let Some(redirect_path) = path.strip_prefix("/fixture_redirects_") {
                        let redirect_path = redirect_path.trim_end_matches("_1234567890");
                        let initial = format!(
                            r#"<!doctype html><script>
window.__luckyrayStartSecurityProbe = async () => {{
  window.open('/popup-denied');
  let permissionProbe=Promise.resolve();
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) permissionProbe=navigator.mediaDevices.getUserMedia({{audio:true}}).catch(()=>{{}});
  const download=document.createElement('a');download.href='/download-denied';download.download='blocked.txt';document.body.append(download);download.click();
  const external=document.createElement('a');external.href='https://example.invalid/blocked';document.body.append(external);external.click();
  await permissionProbe;
  window.__luckyrayPocProbeComplete={{tauriAbsent:true,internalsAbsent:true,tauriIpcAbsent:true,wryIpcAbsent:true,externalInvokeAbsent:true}};
  setTimeout(()=>location.href='/redirect-{redirect_path}',100);
}};
</script>"#
                        );
                        let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", initial.len());
                        let _ = stream.write_all(headers.as_bytes());
                        let _ = stream.write_all(initial.as_bytes());
                    } else {
                        match path {
                            "/redirect-userinfo" => {
                                let location = format!(
                                    "http://127.0.0.1:{allowed_port}@127.0.0.1:{target_port}/userinfo"
                                );
                                let response = format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                                let _ = stream.write_all(response.as_bytes());
                            }
                            "/redirect-port" => {
                                let location = format!("http://127.0.0.1:{target_port}/other-port");
                                let response = format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                                let _ = stream.write_all(response.as_bytes());
                            }
                            "/redirect-external" => {
                                let _ = stream.write_all(b"HTTP/1.1 308 Permanent Redirect\r\nLocation: http://evil.example/blocked\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                            }
                            "/download-denied" => {
                                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Disposition: attachment; filename=blocked.txt\r\nContent-Length: 7\r\nConnection: close\r\n\r\nblocked");
                            }
                            _ => {
                                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                            }
                        }
                    }
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    });
    for redirect in ["userinfo", "port", "external"] {
        let workspace = unique_workspace(&format!("redirect-{redirect}"));
        let input = format!(
            "{{\"version\":1,\"id\":\"redirect-{redirect}\",\"command\":\"initialize\",\"challenge\":\"redirect-challenge\",\"workspaceId\":\"{workspace}\",\"testFixtureUrl\":\"http://127.0.0.1:{allowed_port}/fixture_redirects_{redirect}_1234567890\",\"testFixtureExpectSecurity\":true,\"testFixtureExpectedNavigationDenials\":2}}\n"
        );
        let (status, stdout, stderr) = spawn_fixture_host(input.as_bytes());
        assert!(
            status.success(),
            "redirect={redirect} stdout={} stderr={}",
            String::from_utf8_lossy(&stdout),
            String::from_utf8_lossy(&stderr)
        );
        assert!(stderr.is_empty());
        let ready: Value = serde_json::from_slice(&stdout).unwrap();
        assert_eq!(ready["event"], "session-ready", "{ready}");
        assert!(ready["security"]["navigationDenied"].as_u64().unwrap() >= 2);
        remove_test_profile(&workspace);
    }
    allowed_stop_tx.send(()).unwrap();
    allowed_server.join().unwrap();
    let _ = target_stop_tx.send(());
    target_server.join().unwrap();
    assert_eq!(
        target_hits.load(Ordering::SeqCst),
        0,
        "{:?}",
        target_requests.lock().unwrap()
    );
}

#[test]
fn standalone_host_strictly_binds_the_first_pipe_frame_without_tauri_runtime() {
    let input = b"{\"version\":1,\"id\":\"init-1\",\"command\":\"initialize\",\"challenge\":\"parent-challenge-1\",\"workspaceId\":\"workspace-a\"}\n";
    let (status, stdout, stderr) = spawn_host(input);
    assert!(status.success());
    assert!(stderr.is_empty());
    let response: Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(response["version"], 1);
    assert_eq!(response["id"], "init-1");
    assert_eq!(response["challenge"], "parent-challenge-1");
    assert_eq!(response["availability"], "poc-only");
    assert_eq!(
        response["code"],
        "browser-host-remote-navigation-unavailable"
    );
    assert!(response["sessionNonce"].as_str().unwrap().len() >= 32);
}

#[test]
fn malformed_duplicate_unknown_and_oversize_frames_fail_closed_without_output() {
    let cases = [
        b"not-json\n".to_vec(),
        b"{\"version\":1,\"version\":1,\"id\":\"x\",\"command\":\"initialize\",\"challenge\":\"x\",\"workspaceId\":\"x\"}\n".to_vec(),
        b"{\"version\":1,\"id\":\"x\",\"command\":\"initialize\",\"challenge\":\"x\",\"workspaceId\":\"x\",\"root\":\"C:/escape\"}\n".to_vec(),
        b"{\"version\":2,\"id\":\"x\",\"command\":\"initialize\",\"challenge\":\"x\",\"workspaceId\":\"x\"}\n".to_vec(),
        b"{\"version\":1,\"id\":\"x\",\"command\":\"initialize\",\"challenge\":\"x\",\"workspaceId\":\"x\",\"testFixtureUrl\":\"http://127.0.0.1:9/fixture_not_enabled\"}\n".to_vec(),
        vec![b'x'; 64 * 1024 + 2],
    ];
    for input in cases {
        let (status, stdout, stderr) = spawn_host(&input);
        assert!(!status.success());
        assert!(stdout.is_empty());
        assert!(stderr.is_empty());
    }
}

#[cfg(not(debug_assertions))]
#[test]
fn release_fixture_mode_is_compiled_fail_closed() {
    let _guard = webview_test_guard();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let server_hits = Arc::clone(&hits);
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    server_hits.fetch_add(1, Ordering::SeqCst);
                    let _ = read_request(&mut stream);
                    let body = fixture_html().as_bytes();
                    let headers = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(headers.as_bytes());
                    let _ = stream.write_all(body);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
    });
    let workspace = unique_workspace("release-gate");
    let profile = profile_path(&workspace);
    let _ = std::fs::remove_dir_all(&profile);
    let input = format!(
        "{{\"version\":1,\"id\":\"release-gate\",\"command\":\"initialize\",\"challenge\":\"release-challenge\",\"workspaceId\":\"{workspace}\",\"testFixtureUrl\":\"http://127.0.0.1:{port}/fixture_release_1234567890\",\"testFixtureExpectSecurity\":true}}\n"
    );
    let (status, stdout, stderr) = spawn_fixture_host(input.as_bytes());
    server.join().unwrap();

    assert_eq!(status.code(), Some(64));
    assert!(stdout.is_empty());
    assert!(stderr.is_empty());
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    assert!(!profile.exists());
}
