//! Linux Agent Browser host policy (slice 1 of T55).
//!
//! The Windows host (`browser_host_poc/mod.rs`, WebView2) keeps its navigation,
//! private-target, extraction and result-budget rules inside its
//! `cfg(windows)` module. The Linux host drives a different engine, so it
//! cannot call them; this file carries the same rules unchanged, and
//! `same_rules_as_windows_host` fails if either copy drifts. Nothing here
//! touches the Personal Browser, the runtime, or `dsh_resource_broker`; the
//! runtime stays unavailable on Linux until the engine slice lands.
#![allow(dead_code)]

use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::net::{Ipv4Addr, Ipv6Addr};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HostFailure {
    pub(crate) code: &'static str,
    pub(crate) phase: &'static str,
}

impl HostFailure {
    const fn new(code: &'static str, phase: &'static str) -> Self {
        Self { code, phase }
    }
}

/// Same switch as the Windows host: the loopback exception exists only in a
/// debug build of the explicit fixture feature.
fn fixture_runtime_enabled() -> bool {
    cfg!(all(feature = "browser-host-poc-fixture", debug_assertions))
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AgentExtractKind {
    Main,
    Article,
    Headings,
    Links,
    Table,
}

/// The Windows Agent host's extra WebView2 browser arguments, as argv. On
/// Linux the same flags are passed to the engine process; the gateway proxy
/// and resolver lockout stay a backstop behind per-request mediation.
pub(crate) fn agent_browser_arguments(gateway_port: u16) -> Vec<String> {
    vec![
        format!("--proxy-server=http://127.0.0.1:{gateway_port}"),
        "--proxy-bypass-list=<-loopback>".into(),
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1".into(),
        "--disable-quic".into(),
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into(),
        "--disable-background-networking".into(),
        "--disable-component-update".into(),
        "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication".into(),
    ]
}

// --- BEGIN same-as-windows region 1 ---
const AGENT_NETWORK_LOCKDOWN_SCRIPT: &str = r#"(()=>{
  'use strict';
  const disable=(target,name,value=undefined)=>{
    try{
      Object.defineProperty(target,name,{value,writable:false,configurable:false,enumerable:false});
    }catch(_error){
      throw new Error('luckyray-agent-network-lockdown');
    }
  };
  disable(globalThis,'RTCPeerConnection');
  disable(globalThis,'webkitRTCPeerConnection');
  disable(globalThis,'WebTransport');
})();"#;

#[derive(Default)]
struct AgentTopLevelPolicy {
    allowed_urls: HashSet<String>,
}

impl AgentTopLevelPolicy {
    fn begin(&mut self, target: &url::Url) {
        self.allowed_urls.clear();
        self.allowed_urls.insert(target.as_str().to_owned());
    }

    fn allow_gateway_final(&mut self, target: &str) {
        self.allowed_urls.insert(target.to_owned());
    }

    fn permits(&self, target: &url::Url) -> bool {
        self.allowed_urls.contains(target.as_str())
    }
}
// --- END same-as-windows region 1 ---

// --- BEGIN same-as-windows region 2 ---
fn bounded_title(value: &str) -> Option<String> {
    let title: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(256)
        .collect();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

const AGENT_READ_SCRIPT: &str = r#"(()=>{
  const clean=(value)=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  const clip=(value,max)=>{const text=clean(value);const enc=new TextEncoder();if(enc.encode(text).length<=max)return text;let lo=0,hi=text.length;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(enc.encode(text.slice(0,mid)).length<=max)lo=mid;else hi=mid-1;}return text.slice(0,lo).trimEnd();};
  const visible=clip(document.body?.innerText||'',24576);
  return {kind:'read',host:location.hostname.toLowerCase(),title:clip(document.title,512),visibleText:visible,characterCount:[...visible].length};
})()"#;

fn agent_extract_script(
    kind: AgentExtractKind,
    index: Option<usize>,
) -> std::result::Result<String, HostFailure> {
    let body = match kind {
        AgentExtractKind::Main => {
            if index.is_some() {
                return Err(HostFailure::new("browser-extract-invalid", "extract-input"));
            }
            "const root=document.querySelector('main')||document.body;return {kind:'main',host:location.hostname.toLowerCase(),title:clip(document.title,512),visibleText:clip(root?.innerText||'',24576)};".to_owned()
        }
        AgentExtractKind::Article => {
            if index.is_some() {
                return Err(HostFailure::new("browser-extract-invalid", "extract-input"));
            }
            "const root=document.querySelector('article')||document.querySelector('main')||document.body;return {kind:'article',host:location.hostname.toLowerCase(),title:clip(document.title,512),visibleText:clip(root?.innerText||'',24576)};".to_owned()
        }
        AgentExtractKind::Headings => {
            if index.is_some() {
                return Err(HostFailure::new("browser-extract-invalid", "extract-input"));
            }
            "const items=[...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0,64).map(node=>({level:Number(node.tagName.slice(1)),text:clip(node.innerText||node.textContent||'',512)})).filter(item=>item.text);return {kind:'headings',host:location.hostname.toLowerCase(),items};".to_owned()
        }
        AgentExtractKind::Links => {
            if index.is_some() {
                return Err(HostFailure::new("browser-extract-invalid", "extract-input"));
            }
            "const items=[];for(const node of [...document.querySelectorAll('a[href]')]){if(items.length>=64)break;try{const target=new URL(node.href,location.href);if(!['http:','https:'].includes(target.protocol)||target.username||target.password)continue;const label=clip(node.innerText||node.getAttribute('aria-label')||'',512);if(!label)continue;items.push({label,host:target.hostname.toLowerCase(),url:target.href});}catch{}}return {kind:'links',host:location.hostname.toLowerCase(),items};".to_owned()
        }
        AgentExtractKind::Table => {
            let index = index.unwrap_or(0);
            if index > 15 {
                return Err(HostFailure::new("browser-extract-invalid", "extract-input"));
            }
            format!("const table=document.querySelectorAll('table')[{index}];const rows=table?[...table.rows].slice(0,40).map(row=>[...row.cells].slice(0,20).map(cell=>clip(cell.innerText||cell.textContent||'',512))):[];return {{kind:'table',host:location.hostname.toLowerCase(),index:{index},rows}};")
        }
    };
    Ok(format!(
        r#"(()=>{{
      const clean=(value)=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').replace(/[ \t]+/g,' ').replace(/\n{{3,}}/g,'\n\n').trim();
      const clip=(value,max)=>{{const text=clean(value);const enc=new TextEncoder();if(enc.encode(text).length<=max)return text;let lo=0,hi=text.length;while(lo<hi){{const mid=Math.ceil((lo+hi)/2);if(enc.encode(text.slice(0,mid)).length<=max)lo=mid;else hi=mid-1;}}return text.slice(0,lo).trimEnd();}};
      {body}
    }})()"#
    ))
}

fn sanitize_agent_result(mut value: Value) -> std::result::Result<Value, HostFailure> {
    fn visit(value: &mut Value, depth: usize) -> bool {
        if depth > 6 {
            return false;
        }
        match value {
            Value::String(text) => {
                let mut clean = String::new();
                for character in text.chars() {
                    if character.is_control() && !matches!(character, '\n' | '\r' | '\t') {
                        continue;
                    }
                    if matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') {
                        continue;
                    }
                    if clean.len().saturating_add(character.len_utf8()) > 24 * 1024 {
                        break;
                    }
                    clean.push(character);
                }
                *text = clean;
                true
            }
            Value::Array(items) => {
                if items.len() > 128 {
                    return false;
                }
                items.iter_mut().all(|item| visit(item, depth + 1))
            }
            Value::Object(object) => {
                if object.len() > 16 {
                    return false;
                }
                object.values_mut().all(|item| visit(item, depth + 1))
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => true,
        }
    }
    if !visit(&mut value, 0) {
        return Err(HostFailure::new(
            "browser-result-too-large",
            "result-budget",
        ));
    }
    if let Some(object) = value.as_object_mut() {
        if object.contains_key("characterCount") {
            let count = object
                .get("visibleText")
                .and_then(Value::as_str)
                .map(|text| text.chars().count())
                .ok_or_else(|| HostFailure::new("browser-result-invalid", "result-shape"))?;
            object.insert("characterCount".into(), Value::from(count));
        }
    }
    if serde_json::to_vec(&value)
        .map(|bytes| bytes.len() > 60 * 1024)
        .unwrap_or(true)
    {
        return Err(HostFailure::new(
            "browser-result-too-large",
            "result-budget",
        ));
    }
    Ok(value)
}

fn safe_origin(target: &url::Url) -> Option<String> {
    let origin = target.origin().ascii_serialization();
    if origin == "null" || origin.len() > 512 {
        None
    } else {
        Some(origin)
    }
}

fn validated_top_level_url(
    value: &str,
    test_fixture_port: Option<u16>,
) -> std::result::Result<url::Url, HostFailure> {
    if value.is_empty()
        || value.len() > 8192
        || value.chars().any(|character| character.is_control())
    {
        return Err(HostFailure::new(
            "browser-navigation-invalid",
            "navigation-validate",
        ));
    }
    let target = url::Url::parse(value)
        .map_err(|_| HostFailure::new("browser-navigation-invalid", "navigation-validate"))?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err(HostFailure::new(
            "browser-navigation-scheme-denied",
            "navigation-policy",
        ));
    }
    if !target.username().is_empty() || target.password().is_some() {
        return Err(HostFailure::new(
            "browser-navigation-userinfo-denied",
            "navigation-policy",
        ));
    }
    let host = target
        .host()
        .ok_or_else(|| HostFailure::new("browser-navigation-invalid", "navigation-validate"))?;
    if let (Some(allowed_port), url::Host::Ipv4(address)) = (test_fixture_port, host.clone()) {
        if fixture_runtime_enabled()
            && target.scheme() == "http"
            && address == Ipv4Addr::LOCALHOST
            && target.port() == Some(allowed_port)
        {
            return Ok(target);
        }
    }
    if host_is_forbidden(host) {
        return Err(HostFailure::new(
            "browser-navigation-private-target",
            "navigation-policy",
        ));
    }
    Ok(target)
}

fn subresource_target_is_forbidden(value: &str, test_fixture_port: Option<u16>) -> bool {
    let Ok(target) = url::Url::parse(value) else {
        return true;
    };
    if matches!(target.scheme(), "data" | "blob") {
        return false;
    }
    if !matches!(target.scheme(), "http" | "https") {
        return true;
    }
    validated_top_level_url(value, test_fixture_port).is_err()
}

fn host_is_forbidden(host: url::Host<&str>) -> bool {
    match host {
        url::Host::Domain(domain) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            domain == "localhost" || domain.ends_with(".localhost")
        }
        url::Host::Ipv4(address) => ipv4_is_forbidden(address),
        url::Host::Ipv6(address) => ipv6_is_forbidden(address),
    }
}

fn ipv4_is_forbidden(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
}

fn ipv6_is_forbidden(address: Ipv6Addr) -> bool {
    if address.is_unspecified() || address.is_loopback() || address.is_multicast() {
        return true;
    }
    let segments = address.segments();
    if (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
    {
        return true;
    }
    if segments[..5] == [0, 0, 0, 0, 0] && (segments[5] == 0 || segments[5] == 0xffff) {
        let mapped = Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            segments[6] as u8,
            (segments[7] >> 8) as u8,
            segments[7] as u8,
        );
        return ipv4_is_forbidden(mapped);
    }
    false
}
// --- END same-as-windows region 2 ---

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOWS_HOST: &str = include_str!("../browser_host_poc/mod.rs");
    const THIS: &str = include_str!("linux_host_policy.rs");

    fn compact(value: &str) -> String {
        value.chars().filter(|character| !character.is_whitespace()).collect()
    }

    fn slice<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
        let from = text.find(start).expect("start marker");
        let to = from + text[from..].find(end).expect("end marker");
        &text[from..to]
    }

    #[test]
    fn same_rules_as_windows_host() {
        let windows_1 = slice(WINDOWS_HOST, "const AGENT_NETWORK_LOCKDOWN_SCRIPT", "struct AgentFetchJob");
        let windows_2 = slice(WINDOWS_HOST, "fn bounded_title", "#[cfg(test)]\n    mod production_policy_tests");
        let linux_1 = slice(THIS, "const AGENT_NETWORK_LOCKDOWN_SCRIPT", "// --- END same-as-windows region 1");
        let linux_2 = slice(THIS, "fn bounded_title", "// --- END same-as-windows region 2");
        assert_eq!(compact(linux_1), compact(windows_1));
        assert_eq!(compact(linux_2), compact(windows_2));
        // The argv form carries exactly the Windows argument string's flags.
        let windows_args = slice(WINDOWS_HOST, "fn agent_browser_arguments", "fn pump_messages");
        let windows_args = slice(windows_args, "\"--proxy-server", "\"\n");
        let windows_flags: Vec<String> = windows_args
            .trim_start_matches('"')
            .replace("\\\n", " ")
            .replace("\\\"", "\u{1}")
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>()
            .join(" ")
            .split(" --")
            .map(|flag| flag.trim_start_matches("--").replace('\u{1}', ""))
            .collect();
        let linux_flags: Vec<String> = agent_browser_arguments(4321)
            .iter()
            .map(|flag| flag.trim_start_matches("--").to_owned())
            .collect();
        assert_eq!(
            linux_flags,
            windows_flags
                .iter()
                .map(|flag| flag.replace("{gateway_port}", "4321"))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn linux_policy_rejects_local_credentials_controls_and_non_http_schemes() {
        for target in [
            "http://127.0.0.1/",
            "http://localhost/",
            "http://service.localhost/",
            "http://10.0.0.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "https://user:password@example.com/",
            "file:///secret",
            "data:text/plain,secret",
            "javascript:alert(1)",
            "https://example.com/\u{0}hidden",
        ] {
            assert!(validated_top_level_url(target, None).is_err(), "target={target:?}");
        }
        assert!(validated_top_level_url("https://example.com/page", None).is_ok());
        // Without the debug fixture build the loopback exception never opens.
        if !fixture_runtime_enabled() {
            assert!(validated_top_level_url("http://127.0.0.1:32123/page", Some(32123)).is_err());
        }
        assert!(subresource_target_is_forbidden("http://192.168.1.1/x.png", None));
        assert!(!subresource_target_is_forbidden("data:image/png;base64,AA==", None));
        let mut policy = AgentTopLevelPolicy::default();
        let first = url::Url::parse("https://example.com/a").unwrap();
        policy.begin(&first);
        assert!(policy.permits(&first));
        assert!(!policy.permits(&url::Url::parse("https://example.com/b").unwrap()));
        assert!(agent_extract_script(AgentExtractKind::Table, Some(16)).is_err());
        assert!(agent_extract_script(AgentExtractKind::Links, Some(0)).is_err());
    }
}
