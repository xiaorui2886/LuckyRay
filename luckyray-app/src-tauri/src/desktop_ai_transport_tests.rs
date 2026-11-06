//! Local-only API 2 intake checks against the real host transport.
use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

fn loopback(
    response: &'static str,
    content_type: &'static str,
) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind synthetic loopback");
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().expect("accept synthetic request");
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let header_end = loop {
            let mut buffer = [0u8; 2048];
            let count = socket.read(&mut buffer).expect("read request headers");
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            assert!(bytes.len() < 64 * 1024);
            if let Some(pos) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                break pos + 4;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        while bytes.len() < header_end + length {
            let mut buffer = [0u8; 2048];
            let count = socket.read(&mut buffer).expect("read request body");
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            assert!(bytes.len() < 64 * 1024);
        }
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len()).unwrap();
        socket.write_all(response.as_bytes()).unwrap();
        String::from_utf8(bytes).unwrap()
    });
    (format!("http://{address}"), server)
}

fn request() -> AiChatRequest {
    AiChatRequest {
        messages: vec![AiChatRequestMessage {
            role: "user".into(),
            content: serde_json::json!("synthetic prompt"),
        }],
        system_prompt: None,
        temperature: None,
        max_tokens: Some(16),
        model: None,
    }
}

#[test]
fn default_provider_endpoints_are_derived_without_contacting_a_provider() {
    assert_eq!(
        build_ai_endpoint("openai", "openai-compatible", None),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        build_ai_endpoint("anthropic", "anthropic-messages", None),
        "https://api.anthropic.com/v1/messages"
    );
}

#[tokio::test]
async fn plugin_completion_uses_real_openai_and_anthropic_loopback_transport() {
    for anthropic in [false, true] {
        let (base, server) = loopback(
            if anthropic {
                r#"{"content":[{"type":"text","text":"fixture-ok"}]}"#
            } else {
                r#"{"choices":[{"message":{"content":"fixture-ok"}}]}"#
            },
            "application/json",
        );
        let config = AiModelConfig {
            provider: if anthropic { "anthropic" } else { "openai" }.into(),
            protocol: if anthropic {
                "anthropic-messages"
            } else {
                "openai-compatible"
            }
            .into(),
            api_key: "synthetic-fixture-key".into(),
            model: "synthetic-model".into(),
            custom_url: Some(format!("{base}/v1")),
        };
        let result = plugin_ai_complete_transport(config, request(), Duration::from_secs(5))
            .await
            .unwrap();
        let raw = server.join().unwrap();
        assert!(
            result.success,
            "synthetic response rejected: {:?}",
            result.error_kind
        );
        assert_eq!(result.content.as_deref(), Some("fixture-ok"));
        let lower = raw.to_ascii_lowercase();
        if anthropic {
            assert!(raw.starts_with("POST /v1/messages "));
            assert!(lower.contains("x-api-key: synthetic-fixture-key"));
            assert!(lower.contains("anthropic-version: 2023-06-01"));
            assert!(!lower.contains("authorization: bearer"));
        } else {
            assert!(raw.starts_with("POST /v1/chat/completions "));
            assert!(lower.contains("authorization: bearer synthetic-fixture-key"));
        }
        assert!(raw.contains("synthetic prompt"));
    }
}

#[tokio::test]
async fn pinned_plugin_stream_uses_real_loopback_transport() {
    let (base, server) = loopback(
        concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"fixture-stream\"}}]}\n\n",
            "data: [DONE]\n\n"
        ),
        "text/event-stream",
    );
    let config = AiModelConfig {
        provider: "openai".into(),
        protocol: "openai-compatible".into(),
        api_key: "synthetic-fixture-key".into(),
        model: "synthetic-model".into(),
        custom_url: Some(format!("{base}/v1")),
    };
    let request = AiChatStreamRequest {
        stream_id: "desktop-api2-synthetic-stream".into(),
        messages: vec![AiChatRequestMessage {
            role: "user".into(),
            content: serde_json::json!("synthetic prompt"),
        }],
        system_prompt: None,
        temperature: None,
        max_tokens: Some(16),
    };
    let mut chunks = String::new();
    let result = ai_chat_stream_with_config(config, request, true, |event| {
        if let Some(delta) = event.delta {
            chunks.push_str(&delta);
        }
    })
    .await
    .unwrap();
    let raw = server.join().unwrap();
    assert!(raw.starts_with("POST /v1/chat/completions "));
    assert!(
        result.success,
        "synthetic stream rejected: {:?}",
        result.error_kind
    );
    assert_eq!(chunks, "fixture-stream");
    assert_eq!(result.content.as_deref(), Some("fixture-stream"));
}

#[tokio::test]
async fn pinned_anthropic_stream_uses_messages_endpoint() {
    let (base, server) = loopback(concat!(
        "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"fixture-anthropic\"}}\n\n",
        "data: {\"type\":\"message_stop\"}\n\n"), "text/event-stream");
    let config = AiModelConfig {
        provider: "anthropic".into(),
        protocol: "anthropic-messages".into(),
        api_key: "synthetic-fixture-key".into(),
        model: "synthetic-model".into(),
        custom_url: Some(format!("{base}/v1")),
    };
    let request = AiChatStreamRequest {
        stream_id: "desktop-api2-anthropic-stream".into(),
        messages: vec![AiChatRequestMessage {
            role: "user".into(),
            content: serde_json::json!("synthetic prompt"),
        }],
        system_prompt: None,
        temperature: None,
        max_tokens: Some(16),
    };
    let mut chunks = String::new();
    let result = ai_chat_stream_with_config(config, request, true, |event| {
        if let Some(delta) = event.delta {
            chunks.push_str(&delta);
        }
    })
    .await
    .unwrap();
    let raw = server.join().unwrap();
    assert!(raw.starts_with("POST /v1/messages "));
    assert!(raw
        .to_ascii_lowercase()
        .contains("x-api-key: synthetic-fixture-key"));
    assert!(result.success);
    assert_eq!(chunks, "fixture-anthropic");
}

#[tokio::test]
async fn pinned_plugin_stream_does_not_follow_redirect() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    target.set_nonblocking(true).unwrap();
    let target_address = target.local_addr().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_server = stop.clone();
    let target_server = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !stop_server.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
            match target.accept() {
                Ok((mut socket, _)) => {
                    let body = "data: [DONE]\n\n";
                    let _ = write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    return true;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(error) => panic!("synthetic redirect listener: {error}"),
            }
        }
        false
    });
    let redirector = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = redirector.local_addr().unwrap();
    let redirect_server = std::thread::spawn(move || {
        let (mut socket, _) = redirector.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut request = [0u8; 4096];
        assert!(socket.read(&mut request).unwrap() > 0);
        write!(socket,"HTTP/1.1 302 Found\r\nLocation: http://{target_address}/unexpected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });
    let config = AiModelConfig {
        provider: "openai".into(),
        protocol: "openai-compatible".into(),
        api_key: "synthetic-fixture-key".into(),
        model: "synthetic-model".into(),
        custom_url: Some(format!("http://{address}/v1")),
    };
    let request = AiChatStreamRequest {
        stream_id: "desktop-api2-redirect".into(),
        messages: vec![AiChatRequestMessage {
            role: "user".into(),
            content: serde_json::json!("synthetic prompt"),
        }],
        system_prompt: None,
        temperature: None,
        max_tokens: Some(16),
    };
    let result = ai_chat_stream_with_config(config, request, true, |_| {})
        .await
        .unwrap();
    stop.store(true, Ordering::Release);
    redirect_server.join().unwrap();
    assert!(
        !target_server.join().unwrap(),
        "pinned stream followed a redirect"
    );
    assert!(!result.success);
}
