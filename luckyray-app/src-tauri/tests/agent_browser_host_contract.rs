#![cfg(all(windows, debug_assertions, feature = "browser-host-poc-fixture"))]

use luckyray_app_lib::agent_browser::test_support::AgentBrowserGatewayFixture;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, UdpSocket};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::HWND,
        UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, FindWindowExW, GetParent,
            GetWindowLongPtrW, PeekMessageW, TranslateMessage, GWL_STYLE, MSG, PM_REMOVE,
            WS_DISABLED, WS_OVERLAPPEDWINDOW,
        },
    },
};

static WEBVIEW_TEST_GUARD: Mutex<()> = Mutex::new(());

struct HiddenSurfaceParent {
    hwnd: HWND,
    stopping: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl HiddenSurfaceParent {
    fn create() -> Self {
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let stopping = Arc::new(AtomicBool::new(false));
        let thread_stopping = Arc::clone(&stopping);
        let thread = std::thread::spawn(move || {
            let hwnd = unsafe {
                CreateWindowExW(
                    Default::default(),
                    w!("STATIC"),
                    w!("LuckyRay Agent Surface Fixture"),
                    WS_OVERLAPPEDWINDOW,
                    0,
                    0,
                    800,
                    600,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .unwrap();
            ready_tx.send(hwnd.0 as isize).unwrap();
            let mut message = MSG::default();
            while !thread_stopping.load(Ordering::Acquire) {
                unsafe {
                    while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            let _ = unsafe { DestroyWindow(hwnd) };
        });
        let hwnd = HWND(ready_rx.recv_timeout(Duration::from_secs(5)).unwrap() as _);
        Self {
            hwnd,
            stopping,
            thread: Some(thread),
        }
    }

    fn child(&self) -> HWND {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(child) = unsafe {
                FindWindowExW(
                    Some(self.hwnd),
                    None,
                    w!("LuckyRayPersonalBrowserHost"),
                    PCWSTR::null(),
                )
            } {
                return child;
            }
            assert!(Instant::now() < deadline, "agent surface child missing");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for HiddenSurfaceParent {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[test]
fn agent_readonly_host_uses_the_authenticated_parent_gateway_for_its_first_document() {
    let _guard = WEBVIEW_TEST_GUARD
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = listener.local_addr().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let server_hits = Arc::clone(&hits);
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    server_hits.fetch_add(1, Ordering::SeqCst);
                    let mut request = [0u8; 4096];
                    let read = stream.read(&mut request).unwrap_or(0);
                    let request_line = String::from_utf8_lossy(&request[..read])
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_owned();
                    if request_line.contains("GET /dynamic ") {
                        stream
                            .write_all(
                                b"HTTP/1.1 302 Found\r\nLocation: /article\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            )
                            .unwrap();
                        continue;
                    }
                    let body = b"<!doctype html><title>Agent fixture</title><main><h1>dynamic-ready</h1><article>visible article</article><a href='/next?PRIVATE=query'>next page</a><table><tr><th>Name</th></tr><tr><td>LuckyRay</td></tr></table></main>";
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .unwrap();
                    stream.write_all(body).unwrap();
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return,
            }
        }
    });
    let gateway = AgentBrowserGatewayFixture::start_exact_loopback(origin).unwrap();
    let parent = HiddenSurfaceParent::create();
    let profile = std::env::temp_dir()
        .join("LuckyRay")
        .join("AgentBrowser")
        .join("v1")
        .join(format!("gateway-tracer-{}", std::process::id()));
    let _ = fs::remove_dir_all(&profile);
    fs::create_dir_all(&profile).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_luckyray-browser-host"))
        .args(["--agent-readonly", "--test-window-hidden"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "version": 1,
            "id": "agent-init",
            "command": "initialize",
            "challenge": "agent-challenge",
            "testFixtureHidden": true,
            "testFixturePort": origin.port(),
            "testFixtureId": "agent-browser-gateway-tracer",
            "agentGatewayPort": gateway.address().port(),
            "agentGatewayToken": gateway.control_token(),
            "agentProfileRoot": profile.to_string_lossy(),
            "embedParentWindow": parent.hwnd.0 as isize as i64,
            "embedViewport": {"x":0,"y":0,"width":640,"height":420,"visible":false},
        })
    )
    .unwrap();
    let mut line = String::new();
    assert!(
        stdout.read_line(&mut line).unwrap() > 0,
        "host closed before ready"
    );
    let ready: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["event"], "session-ready", "{ready}");
    assert_eq!(ready["controlMode"], "agent-readonly");
    assert_eq!(ready["networkIsolation"], "parent-gateway");
    let nonce = ready["sessionNonce"].as_str().unwrap();
    let surface = parent.child();
    assert_eq!(unsafe { GetParent(surface) }, Ok(parent.hwnd));
    assert_ne!(
        unsafe { GetWindowLongPtrW(surface, GWL_STYLE) } & WS_DISABLED.0 as isize,
        0
    );

    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "version":1,"id":"agent-surface-visible","command":"set-viewport",
            "sessionNonce":nonce,"expectedGeneration":0,
            "viewport":{"x":8,"y":10,"width":620,"height":390,"visible":true}
        })
    )
    .unwrap();
    line.clear();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let surface_ready: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(
        surface_ready["event"], "viewport-updated",
        "{surface_ready}"
    );
    assert_ne!(
        unsafe { GetWindowLongPtrW(surface, GWL_STYLE) } & WS_DISABLED.0 as isize,
        0
    );

    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "version":1,"id":"agent-open","command":"navigate",
            "sessionNonce":nonce,"expectedGeneration":0,
            "url":format!("http://{origin}/dynamic")
        })
    )
    .unwrap();
    line.clear();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let navigating: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(navigating["event"], "navigating", "{navigating}");
    let mut generation = navigating["generation"].as_u64().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let loaded = loop {
        writeln!(stdin, "{}", serde_json::json!({"version":1,"id":"agent-status","command":"status","sessionNonce":nonce,"expectedGeneration":generation})).unwrap();
        line.clear();
        assert!(stdout.read_line(&mut line).unwrap() > 0);
        let status: Value = serde_json::from_str(&line).unwrap();
        generation = status["generation"].as_u64().unwrap();
        if status["status"] == "loaded" || status["status"] == "error" {
            break status;
        }
        assert!(Instant::now() < deadline, "status timeout: {status}");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(loaded["status"], "loaded", "{loaded}");
    assert_eq!(hits.load(Ordering::SeqCst), 2, "{loaded}");
    let document_token = loaded["documentToken"].as_str().unwrap();
    assert!(document_token.starts_with("src-b-") && document_token.len() == 70);

    writeln!(stdin, "{}", serde_json::json!({"version":1,"id":"agent-read","command":"read","sessionNonce":nonce,"expectedGeneration":generation})).unwrap();
    line.clear();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let read: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(read["event"], "read-completed", "{read}");
    assert!(read["result"]["visibleText"]
        .as_str()
        .unwrap()
        .contains("dynamic-ready"));
    assert!(line.len() < 60 * 1024);

    writeln!(stdin, "{}", serde_json::json!({"version":1,"id":"agent-headings","command":"extract","sessionNonce":nonce,"expectedGeneration":generation,"kind":"headings"})).unwrap();
    line.clear();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let headings: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(headings["event"], "extract-completed", "{headings}");
    assert_eq!(headings["result"]["items"][0]["text"], "dynamic-ready");

    writeln!(stdin, "{}", serde_json::json!({"version":1,"id":"agent-links","command":"extract","sessionNonce":nonce,"expectedGeneration":generation,"kind":"links"})).unwrap();
    line.clear();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let links: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(links["result"]["items"][0]["label"], "next page");
    assert!(links["result"]["items"][0]["url"]
        .as_str()
        .unwrap()
        .contains("PRIVATE=query"));

    writeln!(stdin, "{}", serde_json::json!({"version":1,"id":"agent-table","command":"extract","sessionNonce":nonce,"expectedGeneration":generation,"kind":"table","index":0})).unwrap();
    line.clear();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let table: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(table["result"]["rows"][1][0], "LuckyRay");

    writeln!(stdin, "{}", serde_json::json!({"version":1,"id":"agent-close","command":"close","sessionNonce":nonce,"expectedGeneration":generation})).unwrap();
    line.clear();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    drop(stdin);
    assert!(child.wait().unwrap().success());
    drop(gateway);
    server.join().unwrap();
    assert!(
        !profile.exists(),
        "agent profile must be removed after close"
    );
}

#[test]
fn agent_readonly_host_rejects_page_script_navigation_outside_the_issued_document() {
    let _guard = WEBVIEW_TEST_GUARD
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = listener.local_addr().unwrap();
    let root_hits = Arc::new(AtomicUsize::new(0));
    let server_root_hits = Arc::clone(&root_hits);
    let stopping = Arc::new(AtomicBool::new(false));
    let server_stopping = Arc::clone(&stopping);
    let server = std::thread::spawn(move || {
        while !server_stopping.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut request = [0u8; 4096];
                    let read = stream.read(&mut request).unwrap_or(0);
                    let line = String::from_utf8_lossy(&request[..read])
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_owned();
                    let body = if line.contains("GET /article ") {
                        b"<!doctype html><title>Issued article</title><main>issued-article</main><script>location.replace('/')</script>".as_slice()
                    } else {
                        server_root_hits.fetch_add(1, Ordering::SeqCst);
                        b"<!doctype html><title>Homepage</title><main>homepage-not-issued</main>"
                            .as_slice()
                    };
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .unwrap();
                    stream.write_all(body).unwrap();
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return,
            }
        }
    });
    let gateway = AgentBrowserGatewayFixture::start_exact_loopback(origin).unwrap();
    let profile = std::env::temp_dir()
        .join("LuckyRay")
        .join("AgentBrowser")
        .join("v1")
        .join(format!("navigation-policy-tracer-{}", std::process::id()));
    let _ = fs::remove_dir_all(&profile);
    fs::create_dir_all(&profile).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_luckyray-browser-host"))
        .args(["--agent-readonly", "--test-window-hidden"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(stdin, "{}", serde_json::json!({
        "version":1,"id":"policy-init","command":"initialize","challenge":"policy-challenge",
        "testFixtureHidden":true,"testFixturePort":origin.port(),"testFixtureId":"agent-navigation-policy-tracer",
        "agentGatewayPort":gateway.address().port(),"agentGatewayToken":gateway.control_token(),
        "agentProfileRoot":profile.to_string_lossy()
    })).unwrap();
    let mut line = String::new();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let ready: Value = serde_json::from_str(&line).unwrap();
    let nonce = ready["sessionNonce"].as_str().unwrap();
    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "version":1,"id":"policy-open","command":"navigate","sessionNonce":nonce,
            "expectedGeneration":0,"url":format!("http://{origin}/article")
        })
    )
    .unwrap();
    line.clear();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let navigating: Value = serde_json::from_str(&line).unwrap();
    let mut generation = navigating["generation"].as_u64().unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    let final_status = loop {
        writeln!(
            stdin,
            "{}",
            serde_json::json!({
                "version":1,"id":"policy-status","command":"status","sessionNonce":nonce,
                "expectedGeneration":generation
            })
        )
        .unwrap();
        line.clear();
        assert!(stdout.read_line(&mut line).unwrap() > 0);
        let status: Value = serde_json::from_str(&line).unwrap();
        generation = status["generation"].as_u64().unwrap();
        if status["status"] == "error" || generation > 1 || root_hits.load(Ordering::SeqCst) > 0 {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "navigation policy timeout: {status}"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(final_status["status"], "error", "{final_status}");
    assert!(root_hits.load(Ordering::SeqCst) <= 1);

    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "version":1,"id":"policy-close","command":"close","sessionNonce":nonce,
            "expectedGeneration":generation
        })
    )
    .unwrap();
    line.clear();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    drop(stdin);
    assert!(child.wait().unwrap().success());
    stopping.store(true, Ordering::Release);
    server.join().unwrap();
    drop(gateway);
    assert!(!profile.exists());
}

#[test]
fn agent_readonly_webview_cannot_bypass_the_gateway_for_dynamic_subresources_or_private_targets() {
    let _guard = WEBVIEW_TEST_GUARD
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let private = TcpListener::bind("127.0.0.1:0").unwrap();
    private.set_nonblocking(true).unwrap();
    let private_address = private.local_addr().unwrap();
    let private_hits = Arc::new(AtomicUsize::new(0));
    let private_requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let private_stopping = Arc::new(AtomicBool::new(false));
    let private_hits_server = Arc::clone(&private_hits);
    let private_requests_server = Arc::clone(&private_requests);
    let private_stopping_server = Arc::clone(&private_stopping);
    let private_server = std::thread::spawn(move || {
        while !private_stopping_server.load(Ordering::Acquire) {
            match private.accept() {
                Ok((mut stream, _)) => {
                    private_hits_server.fetch_add(1, Ordering::SeqCst);
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
                    let mut bytes = [0u8; 2048];
                    let read = stream.read(&mut bytes).unwrap_or(0);
                    private_requests_server
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .push(
                            String::from_utf8_lossy(&bytes[..read])
                                .lines()
                                .next()
                                .unwrap_or("empty")
                                .to_owned(),
                        );
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return,
            }
        }
    });
    let private_udp = UdpSocket::bind("127.0.0.1:0").unwrap();
    private_udp.set_nonblocking(true).unwrap();
    let private_udp_address = private_udp.local_addr().unwrap();
    let private_udp_hits = Arc::new(AtomicUsize::new(0));
    let private_udp_stopping = Arc::new(AtomicBool::new(false));
    let private_udp_hits_server = Arc::clone(&private_udp_hits);
    let private_udp_stopping_server = Arc::clone(&private_udp_stopping);
    let private_udp_server = std::thread::spawn(move || {
        let mut buffer = [0u8; 2048];
        while !private_udp_stopping_server.load(Ordering::Acquire) {
            match private_udp.recv_from(&mut buffer) {
                Ok(_) => {
                    private_udp_hits_server.fetch_add(1, Ordering::SeqCst);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return,
            }
        }
    });
    let poison = TcpListener::bind("127.0.0.1:0").unwrap();
    poison.set_nonblocking(true).unwrap();
    let poison_address = poison.local_addr().unwrap();
    let poison_hits = Arc::new(AtomicUsize::new(0));
    let poison_stopping = Arc::new(AtomicBool::new(false));
    let poison_hits_server = Arc::clone(&poison_hits);
    let poison_stopping_server = Arc::clone(&poison_stopping);
    let poison_server = std::thread::spawn(move || {
        while !poison_stopping_server.load(Ordering::Acquire) {
            match poison.accept() {
                Ok((_stream, _)) => {
                    poison_hits_server.fetch_add(1, Ordering::SeqCst);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return,
            }
        }
    });

    let allowed = TcpListener::bind("127.0.0.1:0").unwrap();
    allowed.set_nonblocking(true).unwrap();
    let allowed_address = allowed.local_addr().unwrap();
    let allowed_stopping = Arc::new(AtomicBool::new(false));
    let allowed_stopping_server = Arc::clone(&allowed_stopping);
    let allowed_hits = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
    let allowed_hits_server = Arc::clone(&allowed_hits);
    let direct_browser_headers = Arc::new(AtomicUsize::new(0));
    let direct_headers_server = Arc::clone(&direct_browser_headers);
    let allowed_server = std::thread::spawn(move || {
        while !allowed_stopping_server.load(Ordering::Acquire) {
            match allowed.accept() {
                Ok((mut stream, _)) => {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 4096];
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                    while request.len() < 32 * 1024 {
                        match stream.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(read) => {
                                request.extend_from_slice(&buffer[..read]);
                                if request.windows(4).any(|value| value == b"\r\n\r\n") {
                                    break;
                                }
                            }
                        }
                    }
                    let text = String::from_utf8_lossy(&request);
                    let first = text.lines().next().unwrap_or_default();
                    let path = first.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    *allowed_hits_server
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .entry(path.clone())
                        .or_default() += 1;
                    let lower = text.to_ascii_lowercase();
                    if lower.contains("sec-fetch-") || lower.contains("cookie:") {
                        direct_headers_server.fetch_add(1, Ordering::SeqCst);
                    }
                    let (status, content_type, body, extra) = match path.as_str() {
                        "/page" => {
                            let body = format!(
                                r#"<!doctype html><title>Network gate</title><main>dynamic-gateway-ready</main><script src='/allowed-script'></script><script>
                              const networkApisBlocked=typeof RTCPeerConnection==='undefined' && typeof webkitRTCPeerConnection==='undefined' && typeof WebTransport==='undefined';
                              document.querySelector('main').append(networkApisBlocked?' network-apis-blocked':' network-apis-exposed');
                              fetch('/allowed-fetch').catch(()=>null);
                              const xhr=new XMLHttpRequest();xhr.open('GET','/allowed-xhr');xhr.send();
                              const image=new Image();image.src='/allowed-image';document.body.append(image);
                              const frame=document.createElement('iframe');frame.src='/allowed-frame';document.body.append(frame);
                              fetch('/redirect-private').catch(()=>null);
                              fetch('/post-denied',{{method:'POST',body:'blocked'}}).catch(()=>null);
                              fetch('http://{private_address}/private-fetch').catch(()=>null);
                              const px=new XMLHttpRequest();px.open('GET','http://{private_address}/private-xhr');px.send();
                              const pi=new Image();pi.src='http://{private_address}/private-image';document.body.append(pi);
                              const ps=document.createElement('script');ps.src='http://{private_address}/private-script';document.body.append(ps);
                              const pf=document.createElement('iframe');pf.src='http://{private_address}/private-frame';document.body.append(pf);
                              try{{new WebSocket('ws://{private_address}/private-ws')}}catch{{}}
                              try{{new WebSocket('wss://{private_address}/private-wss')}}catch{{}}
                              try{{const pc=new RTCPeerConnection({{iceServers:[{{urls:'stun:{private_udp_address}'}}]}});pc.createDataChannel('blocked');pc.createOffer().then(offer=>pc.setLocalDescription(offer)).catch(()=>null)}}catch{{}}
                            </script>"#
                            );
                            (200, "text/html; charset=utf-8", body.into_bytes(), "")
                        }
                        "/allowed-fetch" | "/allowed-xhr" => {
                            (200, "text/plain", b"ok".to_vec(), "")
                        }
                        "/allowed-image" => (200, "image/gif", vec![b'G', b'I', b'F'], ""),
                        "/allowed-script" => (
                            200,
                            "text/javascript",
                            b"window.allowedScript=true".to_vec(),
                            "",
                        ),
                        "/allowed-frame" => (
                            200,
                            "text/html",
                            b"<main>frame</main><script>if(typeof RTCPeerConnection!=='undefined'||typeof WebTransport!=='undefined'){fetch('/frame-network-apis-exposed').catch(()=>null)}</script>".to_vec(),
                            "",
                        ),
                        "/redirect-private" => (302, "text/plain", Vec::new(), "redirect"),
                        _ => (404, "text/plain", b"missing".to_vec(), ""),
                    };
                    let mut headers = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
                        body.len()
                    );
                    if extra == "redirect" {
                        headers.push_str(&format!(
                            "Location: http://{private_address}/redirect-target\r\n"
                        ));
                    }
                    headers.push_str("\r\n");
                    let _ = stream.write_all(headers.as_bytes());
                    let _ = stream.write_all(&body);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return,
            }
        }
    });

    let gateway = AgentBrowserGatewayFixture::start_exact_loopback(allowed_address).unwrap();
    let profile = std::env::temp_dir()
        .join("LuckyRay")
        .join("AgentBrowser")
        .join("v1")
        .join(format!("network-gate-{}", std::process::id()));
    let _ = fs::remove_dir_all(&profile);
    fs::create_dir_all(&profile).unwrap();
    let poisoned_proxy = format!("http://{poison_address}");
    let mut child = Command::new(env!("CARGO_BIN_EXE_luckyray-browser-host"))
        .args(["--agent-readonly", "--test-window-hidden"])
        .env("HTTP_PROXY", &poisoned_proxy)
        .env("HTTPS_PROXY", &poisoned_proxy)
        .env("ALL_PROXY", &poisoned_proxy)
        .env("NO_PROXY", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    writeln!(stdin, "{}", serde_json::json!({
        "version":1,"id":"gate-init","command":"initialize","challenge":"gate-challenge",
        "testFixtureHidden":true,"testFixturePort":allowed_address.port(),"testFixtureId":"agent-network-gate",
        "agentGatewayPort":gateway.address().port(),"agentGatewayToken":gateway.control_token(),
        "agentProfileRoot":profile.to_string_lossy()
    })).unwrap();
    let mut line = String::new();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let ready: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["event"], "session-ready", "{ready}");
    let nonce = ready["sessionNonce"].as_str().unwrap();
    writeln!(stdin, "{}", serde_json::json!({"version":1,"id":"gate-open","command":"navigate","sessionNonce":nonce,"expectedGeneration":0,"url":format!("http://{allowed_address}/page")})).unwrap();
    line.clear();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let mut state: Value = serde_json::from_str(&line).unwrap();
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        let generation = state["generation"].as_u64().unwrap_or(0);
        writeln!(stdin, "{}", serde_json::json!({"version":1,"id":"gate-status","command":"status","sessionNonce":nonce,"expectedGeneration":generation})).unwrap();
        line.clear();
        assert!(stdout.read_line(&mut line).unwrap() > 0);
        state = serde_json::from_str(&line).unwrap();
        let counts = allowed_hits
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if [
            "/page",
            "/allowed-fetch",
            "/allowed-xhr",
            "/allowed-image",
            "/allowed-script",
            "/allowed-frame",
        ]
        .iter()
        .all(|path| counts.get(*path).copied().unwrap_or(0) >= 1)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "state={state}, counts={counts:?}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    loop {
        let generation = state["generation"].as_u64().unwrap_or(0);
        writeln!(
            stdin,
            "{}",
            serde_json::json!({
                "version":1,"id":"gate-loaded-status","command":"status","sessionNonce":nonce,
                "expectedGeneration":generation
            })
        )
        .unwrap();
        line.clear();
        assert!(stdout.read_line(&mut line).unwrap() > 0);
        state = serde_json::from_str(&line).unwrap();
        if matches!(state["status"].as_str(), Some("loaded" | "error")) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "navigation completion timeout: {state}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(state["status"], "loaded", "{state}");
    std::thread::sleep(Duration::from_millis(300));
    let counts = allowed_hits
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    assert_eq!(
        counts.get("/post-denied").copied().unwrap_or(0),
        0,
        "{counts:?}"
    );
    assert_eq!(
        private_hits.load(Ordering::SeqCst),
        0,
        "{:?}",
        private_requests
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    );
    assert_eq!(private_udp_hits.load(Ordering::SeqCst), 0);
    assert_eq!(poison_hits.load(Ordering::SeqCst), 0);
    assert_eq!(direct_browser_headers.load(Ordering::SeqCst), 0);
    assert_eq!(
        counts
            .get("/frame-network-apis-exposed")
            .copied()
            .unwrap_or(0),
        0,
        "{counts:?}"
    );

    let generation = state["generation"].as_u64().unwrap_or(0);
    writeln!(stdin, "{}", serde_json::json!({"version":1,"id":"gate-read","command":"read","sessionNonce":nonce,"expectedGeneration":generation})).unwrap();
    line.clear();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    let read: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(read["event"], "read-completed", "{read}");
    assert!(
        read["result"]["visibleText"]
            .as_str()
            .unwrap_or_default()
            .contains("network-apis-blocked"),
        "{read}"
    );

    let before_drop = counts.values().copied().sum::<usize>();
    drop(gateway);
    let generation = read["generation"].as_u64().unwrap_or(generation);
    writeln!(stdin, "{}", serde_json::json!({"version":1,"id":"after-gateway-drop","command":"navigate","sessionNonce":nonce,"expectedGeneration":generation,"url":format!("http://{allowed_address}/after-drop")})).unwrap();
    line.clear();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    std::thread::sleep(Duration::from_millis(300));
    let after_drop = allowed_hits
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .values()
        .copied()
        .sum::<usize>();
    assert_eq!(
        after_drop, before_drop,
        "gateway failure must not fall back to direct networking"
    );

    let close_generation: Value = serde_json::from_str(&line).unwrap();
    writeln!(stdin, "{}", serde_json::json!({"version":1,"id":"gate-close","command":"close","sessionNonce":nonce,"expectedGeneration":close_generation["generation"].as_u64().unwrap_or(generation)})).unwrap();
    line.clear();
    assert!(stdout.read_line(&mut line).unwrap() > 0);
    drop(stdin);
    assert!(child.wait().unwrap().success());
    allowed_stopping.store(true, Ordering::Release);
    private_stopping.store(true, Ordering::Release);
    private_udp_stopping.store(true, Ordering::Release);
    poison_stopping.store(true, Ordering::Release);
    allowed_server.join().unwrap();
    private_server.join().unwrap();
    private_udp_server.join().unwrap();
    poison_server.join().unwrap();
    assert!(!profile.exists());
}
