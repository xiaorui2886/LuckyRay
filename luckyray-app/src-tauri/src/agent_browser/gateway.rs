use crate::web_tools::SafeHttpClient;
use rand::{distributions::Alphanumeric, Rng};
use serde::Deserialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const CONTROL_PATH: &str = "/__luckyray_agent_fetch";
const MAX_CONTROL_HEADER_BYTES: usize = 32 * 1024;
const MAX_CONTROL_BODY_BYTES: usize = 8 * 1024;
const MAX_RESOURCE_BYTES: usize = 2 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const IO_SLICE: Duration = Duration::from_millis(250);

pub(super) struct GatewayPolicy {
    allow_test_loopback: bool,
    allowed_test_origin: Option<SocketAddr>,
}

impl GatewayPolicy {
    pub(super) fn production() -> Self {
        Self {
            allow_test_loopback: false,
            allowed_test_origin: None,
        }
    }

    #[cfg(any(test, feature = "browser-host-poc-fixture"))]
    pub(super) fn exact_loopback_for_fixture(origin: SocketAddr) -> Self {
        Self {
            allow_test_loopback: true,
            allowed_test_origin: Some(origin),
        }
    }
}

pub(super) struct ValidatingGateway {
    address: SocketAddr,
    control_token: String,
    stopping: Arc<AtomicBool>,
    accept_thread: Option<JoinHandle<()>>,
    connection_threads: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl ValidatingGateway {
    pub(super) fn start(policy: GatewayPolicy) -> Result<Self, &'static str> {
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|_| "agent-browser-gateway-unavailable")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "agent-browser-gateway-unavailable")?;
        let address = listener
            .local_addr()
            .map_err(|_| "agent-browser-gateway-unavailable")?;
        let control_token: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(48)
            .map(char::from)
            .collect();
        let stopping = Arc::new(AtomicBool::new(false));
        let connection_threads = Arc::new(Mutex::new(Vec::new()));
        let accept_stopping = Arc::clone(&stopping);
        let accept_connections = Arc::clone(&connection_threads);
        let policy = Arc::new(policy);
        let accepted_token = control_token.clone();
        let accept_thread = std::thread::Builder::new()
            .name("luckyray-agent-browser-gateway".into())
            .spawn(move || {
                while !accept_stopping.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let policy = Arc::clone(&policy);
                            let token = accepted_token.clone();
                            let connection_stopping = Arc::clone(&accept_stopping);
                            if let Ok(handle) = std::thread::Builder::new()
                                .name("luckyray-agent-browser-gateway-connection".into())
                                .spawn(move || {
                                    let _ = handle_connection(
                                        stream,
                                        &policy,
                                        &token,
                                        &connection_stopping,
                                    );
                                })
                            {
                                accept_connections
                                    .lock()
                                    .unwrap_or_else(|value| value.into_inner())
                                    .push(handle);
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|_| "agent-browser-gateway-unavailable")?;
        Ok(Self {
            address,
            control_token,
            stopping,
            accept_thread: Some(accept_thread),
            connection_threads,
        })
    }

    pub(super) fn address(&self) -> SocketAddr {
        self.address
    }

    pub(super) fn control_token(&self) -> &str {
        &self.control_token
    }

    fn stop(&mut self) {
        if self.stopping.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(100));
        if let Some(handle) = self.accept_thread.take() {
            let _ = handle.join();
        }
        let handles = std::mem::take(
            &mut *self
                .connection_threads
                .lock()
                .unwrap_or_else(|value| value.into_inner()),
        );
        for handle in handles {
            // A permit-winning request may still be inside the bounded blocking
            // client when Stop wins. Never make the Stop path wait on it: the
            // stopping flag prevents every later request and finished workers
            // are reaped here; unfinished bounded workers are detached.
            if handle.is_finished() {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for ValidatingGateway {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FetchRequest {
    method: String,
    url: String,
}

fn handle_connection(
    mut stream: TcpStream,
    policy: &GatewayPolicy,
    control_token: &str,
    stopping: &AtomicBool,
) -> Result<(), ()> {
    stream.set_read_timeout(Some(IO_SLICE)).map_err(|_| ())?;
    stream.set_write_timeout(Some(IO_SLICE)).map_err(|_| ())?;
    let (header, mut body) = read_control_request(&mut stream, stopping)?;
    let header_text = std::str::from_utf8(&header).map_err(|_| ())?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or(())?;
    if request_line != format!("POST {CONTROL_PATH} HTTP/1.1") {
        return write_status(&mut stream, 403, "Forbidden");
    }
    let mut authorized = false;
    let mut content_length = None;
    let mut content_type_valid = false;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return write_status(&mut stream, 400, "Bad Request");
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("authorization") {
            authorized = value == format!("Bearer {control_token}");
        } else if name.eq_ignore_ascii_case("content-length") {
            content_length = value.parse::<usize>().ok();
        } else if name.eq_ignore_ascii_case("content-type") {
            content_type_valid = value.eq_ignore_ascii_case("application/json");
        }
    }
    if !authorized {
        return write_status(&mut stream, 401, "Unauthorized");
    }
    let Some(content_length) = content_length.filter(|value| *value <= MAX_CONTROL_BODY_BYTES)
    else {
        return write_status(&mut stream, 400, "Bad Request");
    };
    if !content_type_valid {
        return write_status(&mut stream, 400, "Bad Request");
    }
    while body.len() < content_length {
        if stopping.load(Ordering::Acquire) {
            return Err(());
        }
        let mut buffer = [0u8; 2048];
        let remaining = content_length - body.len();
        let take = remaining.min(buffer.len());
        match stream.read(&mut buffer[..take]) {
            Ok(0) => return Err(()),
            Ok(read) => body.extend_from_slice(&buffer[..read]),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return Err(()),
        }
    }
    if body.len() != content_length {
        return write_status(&mut stream, 400, "Bad Request");
    }
    let request: FetchRequest = serde_json::from_slice(&body).map_err(|_| ())?;
    if !matches!(request.method.as_str(), "GET" | "HEAD") {
        return write_status(&mut stream, 405, "Method Not Allowed");
    }
    if let Some(expected) = policy.allowed_test_origin {
        let parsed = match reqwest::Url::parse(&request.url) {
            Ok(value) => value,
            Err(_) => return write_status(&mut stream, 403, "Forbidden"),
        };
        if parsed.scheme() != "http"
            || parsed.host_str() != Some(expected.ip().to_string().as_str())
            || parsed.port_or_known_default() != Some(expected.port())
        {
            return write_status(&mut stream, 403, "Forbidden");
        }
    }
    let client = if policy.allow_test_loopback {
        #[cfg(any(test, feature = "browser-host-poc-fixture"))]
        {
            SafeHttpClient::exact_loopback_for_test(
                policy.allowed_test_origin.ok_or(())?,
                FETCH_TIMEOUT,
            )
        }
        #[cfg(not(any(test, feature = "browser-host-poc-fixture")))]
        {
            return write_status(&mut stream, 403, "Forbidden");
        }
    } else {
        SafeHttpClient::production(FETCH_TIMEOUT)
    };
    let deadline = Instant::now().checked_add(FETCH_TIMEOUT).ok_or(())?;
    let fetched = match client.get(&request.url, deadline, 5, "*/*") {
        Ok(value) => value,
        Err(error) => {
            let status = if error.code == "web-network-denied" {
                403
            } else {
                502
            };
            return write_status(
                &mut stream,
                status,
                if status == 403 {
                    "Forbidden"
                } else {
                    "Bad Gateway"
                },
            );
        }
    };
    let status = fetched.response.status().as_u16();
    let content_type = fetched
        .response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.as_bytes().len() <= 256)
        .unwrap_or("application/octet-stream")
        .to_owned();
    let final_url = fetched.final_url.as_str().to_owned();
    let mut bytes = Vec::new();
    if request.method == "GET" {
        fetched
            .response
            .take((MAX_RESOURCE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() > MAX_RESOURCE_BYTES {
            return write_status(&mut stream, 413, "Payload Too Large");
        }
    }
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nX-LuckyRay-Origin-Status: {status}\r\nX-LuckyRay-Origin-Content-Type: {}\r\nX-LuckyRay-Final-Url: {}\r\nConnection: close\r\n\r\n",
        bytes.len(),
        encode_header_value(&content_type),
        encode_header_value(&final_url),
    );
    stream.write_all(response.as_bytes()).map_err(|_| ())?;
    stream.write_all(&bytes).map_err(|_| ())
}

fn read_control_request(
    stream: &mut TcpStream,
    stopping: &AtomicBool,
) -> Result<(Vec<u8>, Vec<u8>), ()> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 2048];
    while bytes.len() <= MAX_CONTROL_HEADER_BYTES + MAX_CONTROL_BODY_BYTES {
        if stopping.load(Ordering::Acquire) {
            return Err(());
        }
        match stream.read(&mut buffer) {
            Ok(0) => return Err(()),
            Ok(read) => {
                bytes.extend_from_slice(&buffer[..read]);
                if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let body = bytes.split_off(index + 4);
                    bytes.truncate(index + 4);
                    if bytes.len() > MAX_CONTROL_HEADER_BYTES {
                        return Err(());
                    }
                    return Ok((bytes, body));
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return Err(()),
        }
    }
    Err(())
}

fn encode_header_value(value: &str) -> String {
    value
        .bytes()
        .filter(|byte| byte.is_ascii_graphic() || *byte == b' ')
        .take(4096)
        .map(char::from)
        .collect()
}

fn write_status(stream: &mut TcpStream, status: u16, reason: &str) -> Result<(), ()> {
    let response =
        format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    stream.write_all(response.as_bytes()).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn serve_once(listener: TcpListener, hits: Arc<AtomicUsize>) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        hits.fetch_add(1, Ordering::SeqCst);
                        let mut request = [0u8; 4096];
                        let _ = stream.read(&mut request);
                        let _ = stream.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        );
                        return;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => return,
                }
            }
        })
    }

    fn proxy_request(proxy: SocketAddr, request: &str) -> String {
        let mut stream = TcpStream::connect_timeout(&proxy, Duration::from_secs(1)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn authenticated_fetch(proxy: SocketAddr, token: &str, method: &str, target: &str) -> String {
        let body = serde_json::json!({"method":method,"url":target}).to_string();
        proxy_request(
            proxy,
            &format!(
                "POST {CONTROL_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
        )
    }

    #[test]
    fn gateway_is_fail_closed_and_only_authenticated_fetch_can_reach_a_validated_target() {
        let allowed_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let allowed = allowed_listener.local_addr().unwrap();
        let allowed_hits = Arc::new(AtomicUsize::new(0));
        let allowed_server = serve_once(allowed_listener, Arc::clone(&allowed_hits));

        let blocked_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        blocked_listener.set_nonblocking(true).unwrap();
        let blocked = blocked_listener.local_addr().unwrap();

        let gateway = ValidatingGateway::start(GatewayPolicy::exact_loopback_for_fixture(allowed))
            .expect("gateway starts");
        let untrusted_proxy_request = proxy_request(
            gateway.address(),
            &format!(
                "GET http://{allowed}/page HTTP/1.1\r\nHost: {allowed}\r\nConnection: close\r\n\r\n"
            ),
        );
        assert!(
            untrusted_proxy_request.starts_with("HTTP/1.1 403"),
            "{untrusted_proxy_request}"
        );
        assert_eq!(allowed_hits.load(Ordering::SeqCst), 0);

        let accepted = authenticated_fetch(
            gateway.address(),
            gateway.control_token(),
            "GET",
            &format!("http://{allowed}/page"),
        );
        assert!(accepted.starts_with("HTTP/1.1 200"), "{accepted}");
        assert!(accepted.ends_with("ok"), "{accepted}");
        assert_eq!(allowed_hits.load(Ordering::SeqCst), 1);

        let rejected_method = authenticated_fetch(
            gateway.address(),
            gateway.control_token(),
            "POST",
            &format!("http://{allowed}/page"),
        );
        assert!(
            rejected_method.starts_with("HTTP/1.1 405"),
            "{rejected_method}"
        );
        assert_eq!(allowed_hits.load(Ordering::SeqCst), 1);

        let rejected_target = authenticated_fetch(
            gateway.address(),
            gateway.control_token(),
            "GET",
            &format!("http://{blocked}/private"),
        );
        assert!(
            rejected_target.starts_with("HTTP/1.1 403"),
            "{rejected_target}"
        );
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            matches!(blocked_listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );

        drop(gateway);
        allowed_server.join().unwrap();
    }
}
