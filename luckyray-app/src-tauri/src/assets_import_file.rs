// Generic asset import entry: POST /api/v1/assets/import-file
// Body: { url, fileName?, folderId? | newFolderName? } (all strings).
// Response: the canonical import envelope (see materials::canonical_import_response).
//
// Contract agreed with the desktop-execution coordination (2026-10-08, r3):
// 1. fileName is validated BEFORE use and NEVER repaired: path separators,
//    drive letters, traversal, control chars, Windows reserved names/chars,
//    leading dots and leading/trailing whitespace are all REJECTED — the
//    catalog's own safe_file_name() transformation is then an identity for
//    every accepted name (no hidden rename anywhere in the chain).
// 2. Magic bytes identify + cross-check — NOT a whitelist: txt/md/rtf/bin
//    (no magic) import normally; known extension vs known content conflicts
//    are rejected with clear errors; classification stays in the official
//    MaterialCatalog (kind_from_name). zip central directory is scanned in
//    full up to a hard entry bound; hitting the bound without a verdict is an
//    explicit error (never a silent "plain zip" / never a wrong generated
//    extension).
// 3. Every hop (initial URL + each redirect) resolves with the REMAINING
//    total-time budget (DNS counts), validates EVERY address against
//    loopback/private/CGNAT/link-local, and PINS the connection to a
//    validated address; the protected client disables automatic proxies so
//    the pin cannot be bypassed via system proxy.
// 4. Caller-supplied URL rejections (scheme/credentials/private targets/
//    unresolvable hosts) answer 400 invalid-param — never 401, never a
//    blanket 500. Network/timeout/redirect-target failures answer 500.
// 5. Logs never carry secrets: sanitize_url_for_log() records only
//    scheme://host/path (no query, no fragment, no userinfo), and
//    redact_url_secrets() strips queries AND credentials from any URL
//    embedded in error text before it reaches a failure record.
//
// MCP alignment (LuckyRay-Agent-Gateway `import_luckyray_file`):
//   - `fileName` OPTIONAL: absent -> URL last segment if it passes the same
//     validation (percent-decoded), else a generated `import-<hash12>.<ext>`.
//   - `mimeType` OPTIONAL and advisory-only: the route ignores it entirely.
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use reqwest::Url;
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::materials::{
    self, canonical_import_response, import_downloaded_material, MaterialBytesInput,
    MaterialImportOptions, ResolvedMaterialImport,
};

const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;
const DOWNLOAD_TOTAL_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const MAX_REDIRECT_HOPS: usize = 3;
const MAX_NAME_CHARS: usize = 120;
const MAX_URL_CHARS: usize = 2048;
/// Hard bound on central-directory entries scanned for OOXML classification.
/// Real OOXML packages stay far below this; crossing the bound without a
/// verdict is an explicit refusal, so neither a legitimate-but-huge package
/// is silently misclassified nor a marker deep in the archive is missed.
pub(crate) const MAX_ZIP_ENTRIES_TOTAL: usize = 65_536;

const WINDOWS_SPECIAL_STEMS: [&str; 17] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "CONIN$",
];

/// Injectable download limits; production callers use PRODUCTION_LIMITS and
/// tests drive the real chain with small values.
pub(crate) struct DownloadLimits {
    pub max_bytes: u64,
    pub total_timeout: Duration,
    pub max_redirects: usize,
}

pub(crate) const PRODUCTION_LIMITS: DownloadLimits = DownloadLimits {
    max_bytes: MAX_DOWNLOAD_BYTES,
    total_timeout: DOWNLOAD_TOTAL_TIMEOUT,
    max_redirects: MAX_REDIRECT_HOPS,
};

/// Test-only: thread-local allowlist of loopback ports (the canned test
/// servers of THIS test). The downloader runs on the caller's thread, so the
/// scoping is airtight under parallel tests; everything else — other loopback
/// ports, private ranges — stays guarded, keeping redirect-into-loopback
/// refusals testable on the real chain.
#[cfg(test)]
thread_local! {
    static TEST_ALLOWED_LOOPBACK_PORTS: std::cell::RefCell<Vec<u16>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
struct TestLoopbackGuard;

#[cfg(test)]
impl TestLoopbackGuard {
    fn allow(ports: &[u16]) -> Self {
        TEST_ALLOWED_LOOPBACK_PORTS.with(|allowed| {
            let mut list = allowed.borrow_mut();
            list.clear();
            list.extend_from_slice(ports);
        });
        Self
    }
}

#[cfg(test)]
impl Drop for TestLoopbackGuard {
    fn drop(&mut self) {
        TEST_ALLOWED_LOOPBACK_PORTS.with(|allowed| allowed.borrow_mut().clear());
    }
}

// ---------------------------------------------------------------------------
// fileName validation (reject-only; NFC is the sole normalization)
// ---------------------------------------------------------------------------

pub(crate) fn validate_file_name(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("fileName 不能为空".to_string());
    }
    // Reject anything the official catalog would later trim or rewrite:
    // leading/trailing whitespace and leading dots must not survive here,
    // otherwise materials::safe_file_name would rename the asset silently.
    if raw.trim() != raw {
        return Err("fileName 首尾含空白".to_string());
    }
    if raw.starts_with('.') {
        return Err("fileName 不能以点开头(会被目录清洗悄悄改名)".to_string());
    }
    let name: String = raw.nfc().collect();
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("fileName 超过 {MAX_NAME_CHARS} 字符上限"));
    }
    if name.chars().any(|c| c.is_control() || c == '\u{7f}') {
        return Err("fileName 含控制字符".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("fileName 含路径分隔符".to_string());
    }
    if name.contains(':') {
        return Err("fileName 含冒号(盘符/备用数据流)".to_string());
    }
    for forbidden in ['<', '>', '"', '|', '?', '*'] {
        if name.contains(forbidden) {
            return Err(format!("fileName 含 Windows 保留字符 {forbidden:?}"));
        }
    }
    if name == "." || name == ".." {
        return Err("fileName 不能是路径当前/上级目录".to_string());
    }
    if name.ends_with('.') {
        return Err("fileName 不能以点结尾".to_string());
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if WINDOWS_SPECIAL_STEMS.contains(&stem.as_str()) {
        return Err(format!("fileName 是 Windows 保留设备名 ({stem})"));
    }
    Ok(name)
}

// ---------------------------------------------------------------------------
// Content sniffing (identification + conflict checks, never a whitelist)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MagicFamily {
    Png,
    Jpeg,
    Gif,
    Webp,
    Pdf,
    Mp4,
    Zip,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OoxmlFamily {
    Presentation, // .pptx
    Word,         // .docx
    Sheet,        // .xlsx
    PlainZip,     // zip container without a recognized OOXML payload
}

pub(crate) fn sniff_magic(bytes: &[u8]) -> Option<MagicFamily> {
    if bytes.len() >= 8 && bytes[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some(MagicFamily::Png);
    }
    if bytes.len() >= 3 && bytes[..3] == [0xff, 0xd8, 0xff] {
        return Some(MagicFamily::Jpeg);
    }
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        return Some(MagicFamily::Gif);
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(MagicFamily::Webp);
    }
    if bytes.len() >= 5 && &bytes[..5] == b"%PDF-" {
        return Some(MagicFamily::Pdf);
    }
    if bytes.len() >= 8 && &bytes[4..8] == b"ftyp" {
        return Some(MagicFamily::Mp4);
    }
    if bytes.len() >= 4
        && (&bytes[..4] == [0x50, 0x4b, 0x03, 0x04]
            || &bytes[..4] == [0x50, 0x4b, 0x05, 0x06]
            || &bytes[..4] == [0x50, 0x4b, 0x07, 0x08])
    {
        return Some(MagicFamily::Zip);
    }
    None
}

/// Classify a zip container from its central directory only: entry NAMES are
/// scanned (never extracted, never decompressed). The scan covers the WHOLE
/// directory up to `max_entries`; crossing the bound without an OOXML marker
/// is an explicit error — no silent "plain zip", no mislabelled generated
/// extension for real-but-large packages.
pub(crate) fn classify_zip_central_directory_bounded(
    bytes: &[u8],
    max_entries: usize,
) -> Result<OoxmlFamily, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|error| format!("zip 中央目录读取失败: {error}"))?;
    let total = archive.len() as usize;
    if total > max_entries {
        return Err(format!(
            "zip 条目数({total})超过检查上限({max_entries}),无法在限定资源内安全判定类型;已拒绝"
        ));
    }
    let mut has_content_types = false;
    let mut family: Option<OoxmlFamily> = None;
    for entry in archive.file_names() {
        let normalized = entry.replace('\\', "/");
        if normalized.eq_ignore_ascii_case("[Content_Types].xml") {
            has_content_types = true;
        }
        if family.is_none() {
            if normalized.starts_with("ppt/") {
                family = Some(OoxmlFamily::Presentation);
            } else if normalized.starts_with("word/") {
                family = Some(OoxmlFamily::Word);
            } else if normalized.starts_with("xl/") {
                family = Some(OoxmlFamily::Sheet);
            }
        }
        if has_content_types && family.is_some() {
            break;
        }
    }
    Ok(match (has_content_types, family) {
        (true, Some(family)) => family,
        _ => OoxmlFamily::PlainZip,
    })
}

pub(crate) fn classify_zip_central_directory(bytes: &[u8]) -> Result<OoxmlFamily, String> {
    classify_zip_central_directory_bounded(bytes, MAX_ZIP_ENTRIES_TOTAL)
}

/// What a known extension promises about its content.
fn expectation_for_ext(ext: &str) -> Option<(Option<MagicFamily>, Option<OoxmlFamily>)> {
    match ext {
        "png" => Some((Some(MagicFamily::Png), None)),
        "jpg" | "jpeg" => Some((Some(MagicFamily::Jpeg), None)),
        "gif" => Some((Some(MagicFamily::Gif), None)),
        "webp" => Some((Some(MagicFamily::Webp), None)),
        "pdf" => Some((Some(MagicFamily::Pdf), None)),
        "mp4" | "m4v" | "mov" => Some((Some(MagicFamily::Mp4), None)),
        "pptx" => Some((Some(MagicFamily::Zip), Some(OoxmlFamily::Presentation))),
        "docx" => Some((Some(MagicFamily::Zip), Some(OoxmlFamily::Word))),
        "xlsx" => Some((Some(MagicFamily::Zip), Some(OoxmlFamily::Sheet))),
        "zip" => Some((Some(MagicFamily::Zip), None)),
        _ => None, // txt/md/rtf/bin/unknown extensions carry no promise
    }
}

pub(crate) fn check_extension_content_conflict(
    ext: &str,
    magic: Option<MagicFamily>,
    ooxml: Option<OoxmlFamily>,
) -> Result<(), String> {
    let Some((expected_magic, expected_ooxml)) = expectation_for_ext(ext) else {
        return Ok(());
    };
    let ext_label = if ext.is_empty() { "(无扩展名)" } else { ext };
    match (expected_magic, magic) {
        (Some(expected), Some(actual)) if expected != actual => {
            return Err(format!(
                "扩展名 .{ext_label} 与内容不符(内容识别为 {actual:?});已拒绝,不做静默改名"
            ));
        }
        (Some(_), None) => {
            return Err(format!(
                "扩展名 .{ext_label} 与内容不符(内容无法识别为该类型);已拒绝"
            ));
        }
        _ => {}
    }
    if expected_magic == Some(MagicFamily::Zip) {
        if let (Some(expected), Some(actual)) = (expected_ooxml, ooxml) {
            if expected != actual {
                return Err(format!(
                    "扩展名 .{ext_label} 与内容不符(zip 内容为 {actual:?});已拒绝,不做静默改名"
                ));
            }
        }
    }
    Ok(())
}

fn trusted_mime_for(ext: &str, magic: Option<MagicFamily>, ooxml: Option<OoxmlFamily>) -> String {
    match magic {
        Some(MagicFamily::Png) => return "image/png".to_string(),
        Some(MagicFamily::Jpeg) => return "image/jpeg".to_string(),
        Some(MagicFamily::Gif) => return "image/gif".to_string(),
        Some(MagicFamily::Webp) => return "image/webp".to_string(),
        Some(MagicFamily::Pdf) => return "application/pdf".to_string(),
        Some(MagicFamily::Mp4) => return "video/mp4".to_string(),
        Some(MagicFamily::Zip) => {
            return match ooxml {
                Some(OoxmlFamily::Presentation) => {
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                        .to_string()
                }
                Some(OoxmlFamily::Word) => {
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        .to_string()
                }
                Some(OoxmlFamily::Sheet) => {
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string()
                }
                _ => "application/zip".to_string(),
            };
        }
        None => {}
    }
    match ext {
        "txt" => "text/plain",
        "md" => "text/markdown",
        "rtf" => "application/rtf",
        "csv" => "text/csv",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
    .to_string()
}

// ---------------------------------------------------------------------------
// URL + redirect safety (initial target and every hop; DNS inside budget)
// ---------------------------------------------------------------------------

pub(crate) fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_loopback()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_private()
                || v4.is_link_local()
                || o[0] == 0
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 100 && (64..=127).contains(&o[1])) // CGNAT 100.64/10
                || (o[0] == 192 && o[1] == 0 && o[2] == 2) // TEST-NET-1
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
                || o[0] >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (v6.segments()[0] & 0xffc0) == 0xfe80) // link local fe80::/10
        }
    }
}

/// How a guard rejection classifies: caller-URL problems are parameter
/// errors; budget exhaustion is a runtime failure.
#[derive(Debug)]
enum GuardError {
    Param(String),
    Failed(String),
}

impl GuardError {
    fn message(&self) -> &str {
        match self {
            GuardError::Param(message) | GuardError::Failed(message) => message,
        }
    }
}

/// Blocking DNS with the REMAINING total-time budget — resolution time counts
/// against the download deadline, so a hanging resolver cannot stall the
/// handler beyond its cap.
fn resolve_with_deadline(
    domain: &str,
    port: u16,
    deadline: Instant,
) -> Result<Vec<SocketAddr>, GuardError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(GuardError::Failed("DNS 解析超过总时长上限".to_string()));
    }
    let (sender, receiver) = std::sync::mpsc::channel();
    let owned = domain.to_string();
    std::thread::spawn(move || {
        let _ = sender.send((owned.as_str(), port).to_socket_addrs().map(|it| it.collect::<Vec<_>>()));
    });
    match receiver.recv_timeout(remaining) {
        Ok(Ok(list)) if !list.is_empty() => Ok(list),
        Ok(Ok(_)) => Err(GuardError::Param(format!("url 主机名没有解析结果 ({domain})"))),
        Ok(Err(_)) => Err(GuardError::Param(format!("url 主机名解析失败 ({domain})"))),
        Err(_) => Err(GuardError::Failed("DNS 解析超过总时长上限".to_string())),
    }
}

/// Validate the URL and return its resolved, checked addresses. The
/// downloader PINS its connection to an address from this list, so no second
/// resolution can bypass the check (DNS-rebinding guard).
pub(crate) fn validated_socket_addrs(
    url: &Url,
    deadline: Instant,
) -> Result<Vec<SocketAddr>, GuardError> {
    if url.as_str().len() > MAX_URL_CHARS {
        return Err(GuardError::Param("url 超过长度上限".to_string()));
    }
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(GuardError::Param(format!(
            "url 协议必须是 http/https(当前 {})",
            url.scheme()
        )));
    }
    if url.username() != "" || url.password().is_some() {
        return Err(GuardError::Param("url 不能携带用户名/密码".to_string()));
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let host = url.host_str().ok_or_else(|| GuardError::Param("url 缺少主机名".to_string()))?;
    #[cfg(test)]
    let address_permitted = |address: &SocketAddr| -> bool {
        if is_public_ip(address.ip()) {
            return true;
        }
        address.ip().is_loopback()
            && TEST_ALLOWED_LOOPBACK_PORTS.with(|allowed| allowed.borrow().contains(&address.port()))
    };
    #[cfg(not(test))]
    let address_permitted = |address: &SocketAddr| -> bool { is_public_ip(address.ip()) };
    match url.host() {
        Some(url::Host::Domain(domain)) => {
            let resolved = resolve_with_deadline(domain, port, deadline)?;
            for address in &resolved {
                if !address_permitted(address) {
                    return Err(GuardError::Param(format!(
                        "url 主机解析到非公网地址 ({address});禁止回环/内网/链路本地目标"
                    )));
                }
            }
            Ok(resolved)
        }
        Some(url::Host::Ipv4(ip)) if address_permitted(&SocketAddr::from((ip, port))) => {
            Ok(vec![SocketAddr::from((ip, port))])
        }
        Some(url::Host::Ipv6(ip)) if address_permitted(&SocketAddr::from((ip, port))) => {
            Ok(vec![SocketAddr::from((ip, port))])
        }
        _ => Err(GuardError::Param(format!(
            "url 主机不是可访问的公网地址 ({host})"
        ))),
    }
}

/// String-level checks incl. resolution validation (unit-test surface).
pub(crate) fn validate_public_http_url(url: &Url) -> Result<(), String> {
    validated_socket_addrs(url, Instant::now() + Duration::from_secs(30))
        .map(|_| ())
        .map_err(|error| error.message().to_string())
}

/// One manual redirect hop: cap check, Location resolution against the
/// current URL, and full re-validation of the next target inside the budget.
pub(crate) fn next_redirect_hop(
    current: &Url,
    location: &str,
    hops_taken: usize,
    max_redirects: usize,
    deadline: Instant,
) -> Result<Url, GuardError> {
    if hops_taken >= max_redirects {
        return Err(GuardError::Failed(format!("重定向次数超过上限 {max_redirects}")));
    }
    let next = current
        .join(location)
        .map_err(|_| GuardError::Failed("重定向 Location 无效".to_string()))?;
    validated_socket_addrs(&next, deadline)?;
    Ok(next)
}

// ---------------------------------------------------------------------------
// Download: pinned hops, manual redirects, no proxy, byte/time caps
// ---------------------------------------------------------------------------

pub(crate) fn download_with_limits(
    raw_url: &str,
    limits: &DownloadLimits,
) -> Result<Vec<u8>, ImportFileError> {
    let started = Instant::now();
    let deadline = started + limits.total_timeout;
    let mut current = Url::parse(raw_url)
        .map_err(|_| ImportFileError::param("url 不是合法 URL"))?;
    let mut hops_taken = 0usize;
    loop {
        // Validate AND pin; on hop 0 a rejection is a caller parameter error,
        // on later hops it is a runtime failure of the redirect target.
        let pinned = validated_socket_addrs(&current, deadline).map_err(|error| match error {
            GuardError::Param(message) if hops_taken == 0 => ImportFileError::param(message),
            GuardError::Param(message) => {
                ImportFileError::failed(format!("重定向目标被拒: {message}"))
            }
            GuardError::Failed(message) => ImportFileError::failed(message),
        })?;
        let mut builder = Client::builder()
            .redirect(Policy::none())
            // The protected chain must not be rerouted through a system or
            // environment proxy: a proxy hop would bypass the pinned address.
            .no_proxy()
            .user_agent("LuckyRay/asset-import-file");
        if let Some(url::Host::Domain(domain)) = current.host() {
            builder = builder.resolve(domain, pinned[0]);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ImportFileError::failed("下载总时长超过上限"));
        }
        let client = builder
            .timeout(remaining)
            .build()
            .map_err(|error| ImportFileError::failed(format!("HTTP 客户端构建失败: {error}")))?;
        let response = client.get(current.clone()).send().map_err(|error| {
            ImportFileError::failed(format!(
                "下载失败: {}",
                redact_url_secrets(&error.to_string())
            ))
        })?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| ImportFileError::failed("重定向响应缺少 Location"))?;
            current = next_redirect_hop(&current, location, hops_taken, limits.max_redirects, deadline)
                .map_err(|error| match error {
                    GuardError::Param(message) => {
                        ImportFileError::failed(format!("重定向目标被拒: {message}"))
                    }
                    GuardError::Failed(message) => ImportFileError::failed(message),
                })?;
            hops_taken += 1;
            continue;
        }
        if !status.is_success() {
            return Err(ImportFileError::failed(format!("下载失败: HTTP {status}")));
        }
        if let Some(length) = response.content_length() {
            if length > limits.max_bytes {
                return Err(ImportFileError::failed(format!(
                    "文件声明大小 {length} 超过上限 {} 字节",
                    limits.max_bytes
                )));
            }
        }
        let mut limited = response.take(limits.max_bytes + 1);
        let mut bytes = Vec::new();
        limited
            .read_to_end(&mut bytes)
            .map_err(|error| ImportFileError::failed(format!("下载中断: {error}")))?;
        if bytes.len() as u64 > limits.max_bytes {
            return Err(ImportFileError::failed(format!(
                "文件超过上限 {} 字节",
                limits.max_bytes
            )));
        }
        if bytes.is_empty() {
            return Err(ImportFileError::failed("下载内容为空"));
        }
        return Ok(bytes);
    }
}

pub(crate) fn download_with_guards(raw_url: &str) -> Result<Vec<u8>, ImportFileError> {
    download_with_limits(raw_url, &PRODUCTION_LIMITS)
}

// ---------------------------------------------------------------------------
// Log redaction (no queries, no signatures, no credentials)
// ---------------------------------------------------------------------------

/// Strip query strings AND userinfo credentials from any http(s) URL embedded
/// in a log/failure string. Text without URLs is returned unchanged.
pub(crate) fn redact_url_secrets(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(position) = rest.find("://") {
        let scheme_start = rest[..position]
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.'))
            .map(|index| index + 1)
            .unwrap_or(0);
        output.push_str(&rest[..scheme_start]);
        let tail = &rest[scheme_start..];
        let url_end = tail
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ')' || c == ',')
            .unwrap_or(tail.len());
        let (url, remainder) = tail.split_at(url_end);
        match url.split_once('?') {
            Some((before, _)) => {
                output.push_str(&strip_userinfo(before));
                output.push_str("(已去除查询参数)");
            }
            None => output.push_str(&strip_userinfo(url)),
        }
        rest = remainder;
    }
    output.push_str(rest);
    output
}

fn strip_userinfo(url: &str) -> String {
    match (url.find("://"), url.rfind('@')) {
        (Some(scheme_end), Some(at)) if at > scheme_end => {
            format!("{}{}", &url[..scheme_end + 3], &url[at + 1..])
        }
        _ => url.to_string(),
    }
}

/// Canonical form for logging a caller-supplied URL: scheme://host/path —
/// query strings, fragments AND credentials are never recorded.
pub(crate) fn sanitize_url_for_log(raw: &str) -> String {
    match Url::parse(raw) {
        Ok(mut url) => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.as_str().to_string()
        }
        Err(_) => "(invalid-url)".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Name resolution (explicit > URL-derived > generated)
// ---------------------------------------------------------------------------

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(value) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                output.push(value);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn derive_name_from_url(url: &Url) -> Option<String> {
    let segment = url.path_segments()?.last()?;
    if segment.is_empty() {
        return None;
    }
    let decoded = percent_decode(segment);
    validate_file_name(&decoded).ok()
}

fn generated_name(bytes: &[u8], magic: Option<MagicFamily>, ooxml: Option<OoxmlFamily>) -> String {
    let digest = Sha256::digest(bytes);
    let suffix = match ooxml {
        Some(OoxmlFamily::Presentation) => "pptx",
        Some(OoxmlFamily::Word) => "docx",
        Some(OoxmlFamily::Sheet) => "xlsx",
        _ => match magic {
            Some(MagicFamily::Png) => "png",
            Some(MagicFamily::Jpeg) => "jpg",
            Some(MagicFamily::Gif) => "gif",
            Some(MagicFamily::Webp) => "webp",
            Some(MagicFamily::Pdf) => "pdf",
            Some(MagicFamily::Mp4) => "mp4",
            Some(MagicFamily::Zip) => "zip",
            None => "bin",
        },
    };
    let head = digest
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("import-{head}.{suffix}")
}

// ---------------------------------------------------------------------------
// Handler with explicit error classes
// ---------------------------------------------------------------------------

/// Parameter-level problems (bad fileName/url, content conflicts, zip-cap
/// refusals) answer 400 invalid-param; system/download failures answer 500.
/// Authentication is never involved in either class.
#[derive(Debug)]
pub(crate) struct ImportFileError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl ImportFileError {
    pub(crate) fn param(message: impl Into<String>) -> Self {
        Self { status: 400, code: "invalid-param", message: message.into() }
    }
    pub(crate) fn failed(message: impl Into<String>) -> Self {
        Self { status: 500, code: "import-failed", message: message.into() }
    }
}

/// HTTP mapping used by the lib.rs dispatch seam (unit-tested here).
pub(crate) fn error_response(error: &ImportFileError) -> (u16, String) {
    error_response_parts(error.status, error.code, &error.message)
}

/// Same mapping for the dispatch seam, which redacts the message first.
pub(crate) fn error_response_parts(status: u16, code: &str, message: &str) -> (u16, String) {
    let body = serde_json::json!({
        "error": { "code": code, "message": message }
    })
    .to_string();
    (status, body)
}

/// Everything before the folder/catalog write, exercised end-to-end by the
/// real-chain tests (real TCP download + sniff + classification + naming).
#[derive(Debug)]
pub(crate) struct PreparedImport {
    pub bytes: Vec<u8>,
    pub name: String,
    pub mime: String,
    pub magic: Option<MagicFamily>,
    pub ooxml: Option<OoxmlFamily>,
}

pub(crate) fn prepare_import(
    raw_url: &str,
    explicit_file_name: Option<&str>,
    limits: &DownloadLimits,
) -> Result<PreparedImport, ImportFileError> {
    if raw_url.is_empty() {
        return Err(ImportFileError::param("url 不能为空"));
    }
    if raw_url.len() > MAX_URL_CHARS {
        return Err(ImportFileError::param("url 超过长度上限"));
    }
    // Explicit names are validated RAW — no trim, no repair; whitespace-only
    // and empty values are rejections, not fallbacks.
    let explicit_name = match explicit_file_name {
        Some(name) => Some(
            validate_file_name(name)
                .map_err(|error| ImportFileError::param(format!("fileName 非法: {error}")))?,
        ),
        None => None,
    };
    // Download and content checks happen first; folder creation and any
    // library writes only after the payload is fully validated (zero-write
    // on failure, same ordering as the existing import-media route).
    let bytes = download_with_limits(raw_url, limits)?;
    let magic = sniff_magic(&bytes);
    let ooxml = if magic == Some(MagicFamily::Zip) {
        Some(classify_zip_central_directory(&bytes).map_err(ImportFileError::param)?)
    } else {
        None
    };
    let parsed_url = Url::parse(raw_url).map_err(|_| ImportFileError::param("url 不是合法 URL"))?;
    let name = match explicit_name {
        Some(name) => name,
        None => derive_name_from_url(&parsed_url)
            .unwrap_or_else(|| generated_name(&bytes, magic, ooxml)),
    };
    let ext = name
        .rsplit_once('.')
        .map(|(_, tail)| tail.to_ascii_lowercase())
        .unwrap_or_default();
    check_extension_content_conflict(&ext, magic, ooxml)
        .map_err(|error| ImportFileError::param(format!("内容与扩展名冲突: {error}")))?;
    let mime = trusted_mime_for(&ext, magic, ooxml);
    Ok(PreparedImport { bytes, name, mime, magic, ooxml })
}

pub(crate) fn handle_import_file(body: &Value) -> Result<String, ImportFileError> {
    let raw_url = body
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let file_name = body.get("fileName").and_then(Value::as_str);
    let prepared = prepare_import(raw_url, file_name, &PRODUCTION_LIMITS)?;
    let folder_id = body.get("folderId").and_then(Value::as_str).map(str::to_string);
    let new_folder_name = body
        .get("newFolderName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty());

    // Folder creation follows the official flow shared with import-image.
    let effective_folder_id = if let Some(new_name) = new_folder_name {
        let folder_body = serde_json::json!({ "name": new_name, "parentId": folder_id.as_deref() });
        let response = crate::handle_api_create_folder(&folder_body).map_err(ImportFileError::failed)?;
        let parsed: Value = serde_json::from_str(&response)
            .map_err(|error| ImportFileError::failed(format!("创建素材文件夹失败: {error}")))?;
        parsed
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
    } else {
        folder_id
    };

    let catalog = crate::material_catalog_for_http().map_err(ImportFileError::failed)?;
    let imported: ResolvedMaterialImport = materials::import_downloaded_material(
        &catalog,
        MaterialBytesInput {
            name: prepared.name,
            original_path: raw_url.to_string(),
            mime_type: prepared.mime,
            description: None,
            bytes: prepared.bytes,
        },
        &MaterialImportOptions {
            folder_id: effective_folder_id,
            storage_mode: "managed".to_string(),
            ..Default::default()
        },
    )
    .map_err(|error| ImportFileError::failed(error.message))?;
    crate::publish_catalog_change_global(&imported.change);
    Ok(canonical_import_response(&imported).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    // ---- fileName validation: reject, never repair ----

    #[test]
    fn file_name_accepts_legal_unicode_names() {
        assert_eq!(validate_file_name("素材 A.pptx").unwrap(), "素材 A.pptx");
        assert_eq!(validate_file_name("hello world.txt").unwrap(), "hello world.txt");
        assert_eq!(validate_file_name("图.png").unwrap(), "图.png");
        assert_eq!(validate_file_name("a..b.png").unwrap(), "a..b.png");
    }

    #[test]
    fn file_name_rejects_path_components_instead_of_stripping() {
        for bad in [
            "a/b.png",
            "a\\b.png",
            "C:\\x.png",
            "C:x.png",
            "\\\\?\\C:\\x.png",
            "..",
            "...",
            ".",
            ".hidden.png",
        ] {
            assert!(validate_file_name(bad).is_err(), "应拒绝: {bad:?}");
        }
    }

    #[test]
    fn file_name_rejects_windows_rules() {
        for bad in [
            "CON.png",
            "com1.bin",
            "NUL",
            "lpt1",
            "a<b.png",
            "a>b.png",
            "a\"b.png",
            "a|b.png",
            "a?b.png",
            "a*b.png",
            "a.png.",
            "a.png ",
            " a.png",
            "\ta.png",
            "   ",
            "",
        ] {
            assert!(validate_file_name(bad).is_err(), "应拒绝: {bad:?}");
        }
        let control = format!("a{}\u{0007}.png", char::from(0x01));
        assert!(validate_file_name(&control).is_err());
        assert!(validate_file_name(&"x".repeat(121)).is_err());
    }

    #[test]
    fn file_name_normalizes_nfc_but_preserves_content() {
        let composed = "café.png";
        let decomposed = "cafe\u{301}.png";
        assert_eq!(
            validate_file_name(decomposed).unwrap(),
            validate_file_name(composed).unwrap()
        );
    }

    /// The official catalog later applies materials::safe_file_name (replace
    /// reserved chars with '_', trim spaces and leading/trailing dots). Every
    /// name accepted here must be a fixed point of that transformation —
    /// otherwise the library would silently rename the asset.
    #[test]
    fn accepted_names_are_fixed_points_of_catalog_safe_file_name() {
        fn catalog_safe_file_name(name: &str) -> String {
            // mirrors materials/catalog.rs::safe_file_name
            let value: String = name
                .chars()
                .map(|c| match c {
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
                    _ => c,
                })
                .collect();
            let trimmed = value.trim().trim_matches('.');
            if trimmed.is_empty() {
                "untitled".to_string()
            } else {
                trimmed.to_string()
            }
        }
        for legal in ["素材 A.pptx", "hello world.txt", "图.png", "a..b.png", "café.png", "b.md"] {
            let accepted = validate_file_name(legal).unwrap();
            assert_eq!(catalog_safe_file_name(&accepted), accepted, "catalog 会改名: {legal:?}");
        }
    }

    // ---- sniffing ----

    #[test]
    fn sniff_magic_identifies_common_families() {
        assert_eq!(sniff_magic(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1]), Some(MagicFamily::Png));
        assert_eq!(sniff_magic(&[0xff, 0xd8, 0xff, 0xe0]), Some(MagicFamily::Jpeg));
        assert_eq!(sniff_magic(b"GIF89a...."), Some(MagicFamily::Gif));
        assert_eq!(
            sniff_magic(b"RIFF\x00\x00\x00\x00WEBP"),
            Some(MagicFamily::Webp)
        );
        assert_eq!(sniff_magic(b"%PDF-1.7"), Some(MagicFamily::Pdf));
        assert_eq!(sniff_magic(b"\x00\x00\x00\x20ftypisom"), Some(MagicFamily::Mp4));
        assert_eq!(sniff_magic(&[0x50, 0x4b, 0x03, 0x04, 0x00]), Some(MagicFamily::Zip));
        assert_eq!(sniff_magic(b"plain text"), None);
    }

    // ---- zip central directory: full scan within a hard bound ----

    #[test]
    fn zip_classification_uses_central_directory_names() {
        let content_types = b"<Types/>";
        let pptx = zip_bytes(&[
            ("[Content_Types].xml", content_types),
            ("ppt/presentation.xml", b"<p/>"),
        ]);
        assert_eq!(
            classify_zip_central_directory(&pptx).unwrap(),
            OoxmlFamily::Presentation
        );
        let docx = zip_bytes(&[
            ("[Content_Types].xml", content_types),
            ("word/document.xml", b"<w/>"),
        ]);
        assert_eq!(classify_zip_central_directory(&docx).unwrap(), OoxmlFamily::Word);
        let xlsx = zip_bytes(&[
            ("[Content_Types].xml", content_types),
            ("xl/workbook.xml", b"<x/>"),
        ]);
        assert_eq!(classify_zip_central_directory(&xlsx).unwrap(), OoxmlFamily::Sheet);
        let plain = zip_bytes(&[("readme.txt", b"hello")]);
        assert_eq!(
            classify_zip_central_directory(&plain).unwrap(),
            OoxmlFamily::PlainZip
        );
    }

    #[test]
    fn zip_late_marker_is_found_by_full_scan() {
        // Marker beyond any early-window assumption: the full central
        // directory scan still classifies it — no false refusal for a real
        // (if unusually structured) PPTX.
        let padding: Vec<(String, Vec<u8>)> = (0..1200)
            .map(|index| (format!("ppt/slides/slide{index}.xml"), vec![0u8; 8]))
            .collect();
        let mut entries: Vec<(&str, &[u8])> = Vec::new();
        for (name, data) in &padding {
            entries.push((name.as_str(), data.as_slice()));
        }
        entries.push(("[Content_Types].xml", b"<Types/>"));
        let late_pptx = zip_bytes(&entries);
        assert_eq!(
            classify_zip_central_directory(&late_pptx).unwrap(),
            OoxmlFamily::Presentation
        );
    }

    #[test]
    fn zip_entry_bound_is_an_explicit_refusal() {
        // Crossing the hard bound without a verdict fails closed — never a
        // silent plain-zip, never a wrong generated extension.
        let padding: Vec<(String, Vec<u8>)> = (0..9)
            .map(|index| (format!("padding/{index}.bin"), vec![0u8; 4]))
            .collect();
        let entries: Vec<(&str, &[u8])> = padding
            .iter()
            .map(|(name, data)| (name.as_str(), data.as_slice()))
            .collect();
        let big = zip_bytes(&entries);
        let error = classify_zip_central_directory_bounded(&big, 8).unwrap_err();
        assert!(error.contains("检查上限"), "{error}");
    }

    #[test]
    fn corrupted_zip_reports_clear_error() {
        assert!(classify_zip_central_directory(&[0x50, 0x4b, 0x03, 0x04, 0xff, 0xff]).is_err());
    }

    // ---- extension vs content conflicts ----

    #[test]
    fn known_extensions_must_match_content() {
        let zip = Some(MagicFamily::Zip);
        assert!(check_extension_content_conflict("png", zip, None).is_err());
        assert!(check_extension_content_conflict(
            "pptx",
            zip,
            Some(OoxmlFamily::Word)
        )
        .is_err());
        assert!(check_extension_content_conflict(
            "pptx",
            zip,
            Some(OoxmlFamily::Presentation)
        )
        .is_ok());
        assert!(check_extension_content_conflict("zip", zip, Some(OoxmlFamily::Word)).is_ok());
        assert!(check_extension_content_conflict("png", None, None).is_err());
    }

    #[test]
    fn magic_less_extensions_import_without_whitelist() {
        assert!(check_extension_content_conflict("txt", Some(MagicFamily::Png), None).is_ok());
        assert!(check_extension_content_conflict("md", None, None).is_ok());
        assert!(check_extension_content_conflict("rtf", None, None).is_ok());
        assert!(check_extension_content_conflict("bin", Some(MagicFamily::Zip), None).is_ok());
        assert!(check_extension_content_conflict("", Some(MagicFamily::Png), None).is_ok());
    }

    #[test]
    fn trusted_mime_mapping() {
        assert_eq!(
            trusted_mime_for("pptx", Some(MagicFamily::Zip), Some(OoxmlFamily::Presentation)),
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        );
        assert_eq!(trusted_mime_for("txt", None, None), "text/plain");
        assert_eq!(trusted_mime_for("bin", None, None), "application/octet-stream");
        assert_eq!(
            trusted_mime_for("png", Some(MagicFamily::Png), None),
            "image/png"
        );
    }

    // ---- URL / redirect safety ----

    #[test]
    fn url_guard_blocks_non_http_and_private_targets() {
        assert!(validate_public_http_url(&Url::parse("ftp://example.com/x").unwrap()).is_err());
        assert!(validate_public_http_url(&Url::parse("http://user:pw@example.com/x").unwrap()).is_err());
        for blocked in [
            "http://127.0.0.1/x",
            "http://10.0.0.1/x",
            "http://192.168.1.1/x",
            "http://172.16.0.1/x",
            "http://172.31.255.1/x",
            "http://169.254.1.1/x",
            "http://0.0.0.0/x",
            "http://[::1]/x",
            "http://[fe80::1]/x",
            "http://[fc00::1]/x",
            "http://localhost/x",
        ] {
            assert!(
                validate_public_http_url(&Url::parse(blocked).unwrap()).is_err(),
                "应拦截: {blocked}"
            );
        }
        assert!(validate_public_http_url(&Url::parse("https://8.8.8.8/x").unwrap()).is_ok());
    }

    #[test]
    fn url_guard_accepts_private_range_boundaries_correctly() {
        assert!(is_public_ip(IpAddr::V4(Ipv4Addr::new(172, 15, 0, 1))));
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(172, 31, 255, 1))));
        assert!(is_public_ip(IpAddr::V4(Ipv4Addr::new(172, 32, 0, 1))));
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)))); // CGNAT也视为内网
    }

    #[test]
    fn redirect_hop_enforces_cap_and_target_checks() {
        let public = Url::parse("https://8.8.8.8/x").unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        assert_eq!(
            next_redirect_hop(&public, "/y", 0, 3, deadline).unwrap().as_str(),
            "https://8.8.8.8/y"
        );
        assert_eq!(
            next_redirect_hop(&public, "https://9.9.9.9/z", 1, 3, deadline)
                .unwrap()
                .as_str(),
            "https://9.9.9.9/z"
        );
        assert!(next_redirect_hop(&public, "/w", 3, 3, deadline).is_err());
        assert!(next_redirect_hop(&public, "http://127.0.0.1/x", 0, 3, deadline).is_err());
        assert!(next_redirect_hop(&public, "http://10.0.0.1/x", 0, 3, deadline).is_err());
        assert!(next_redirect_hop(&public, "http://[::1", 0, 3, deadline).is_err());
    }

    #[test]
    fn validated_socket_addrs_pin_the_checked_addresses() {
        let url = Url::parse("https://8.8.8.8:8443/x").unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let pinned = validated_socket_addrs(&url, deadline).unwrap();
        assert_eq!(pinned, vec!["8.8.8.8:8443".parse().unwrap()]);
        assert!(validated_socket_addrs(&Url::parse("http://127.0.0.1/x").unwrap(), deadline).is_err());
        assert!(validated_socket_addrs(&Url::parse("http://localhost/x").unwrap(), deadline).is_err());
        assert!(validated_socket_addrs(&Url::parse("https://u:p@8.8.8.8/x").unwrap(), deadline).is_err());
    }

    #[test]
    fn log_redaction_strips_queries_signatures_and_credentials() {
        assert_eq!(
            sanitize_url_for_log("https://example.com/a/b.png?Expires=123&Signature=abc"),
            "https://example.com/a/b.png"
        );
        assert_eq!(
            sanitize_url_for_log("https://user:secret@example.com/a.png?sig=x#frag"),
            "https://example.com/a.png"
        );
        assert_eq!(sanitize_url_for_log("not a url"), "(invalid-url)");
        let redacted = redact_url_secrets(
            "error sending request for url (https://example.com/f.bin?sig=SECRET) after 2 hops",
        );
        assert!(!redacted.contains("SECRET"), "{redacted}");
        assert!(redacted.contains("https://example.com/f.bin(已去除查询参数)"), "{redacted}");
        let with_creds = redact_url_secrets("connect to https://alice:hunter2@example.com/x.bin failed");
        assert!(!with_creds.contains("hunter2"), "{with_creds}");
        assert!(!with_creds.contains("alice:"), "{with_creds}");
        assert!(with_creds.contains("https://example.com/x.bin"), "{with_creds}");
        assert_eq!(redact_url_secrets("plain text"), "plain text");
        assert_eq!(
            redact_url_secrets("see https://example.com/x.bin end"),
            "see https://example.com/x.bin end"
        );
    }

    #[test]
    fn error_response_classes_param_versus_system() {
        let (status, body) = error_response(&ImportFileError::param("fileName 非法: 含路径分隔符"));
        assert_eq!(status, 400);
        assert!(body.contains("invalid-param"), "{body}");
        let (status, body) = error_response(&ImportFileError::failed("下载失败: HTTP 503"));
        assert_eq!(status, 500);
        assert!(body.contains("import-failed"), "{body}");
    }

    // ---- name fallback chain ----

    #[test]
    fn name_falls_back_to_url_segment_then_generated() {
        let with_name = Url::parse("https://example.com/files/%E7%B4%A0%E6%9D%90.png").unwrap();
        assert_eq!(derive_name_from_url(&with_name).unwrap(), "素材.png");
        let bare = Url::parse("https://example.com/files/").unwrap();
        assert!(derive_name_from_url(&bare).is_none());
        let traversal = Url::parse("https://example.com/a%2Fb.png").unwrap();
        assert!(derive_name_from_url(&traversal).is_none());
        let leading_space = Url::parse("https://example.com/%20a.png").unwrap();
        assert!(derive_name_from_url(&leading_space).is_none());
        let generated = generated_name(&[0u8; 8], Some(MagicFamily::Png), None);
        assert!(generated.starts_with("import-") && generated.ends_with(".png"));
        let generated_zip = generated_name(
            &[0x50, 0x4b, 0x03, 0x04],
            Some(MagicFamily::Zip),
            Some(OoxmlFamily::Presentation),
        );
        assert!(generated_zip.ends_with(".pptx"));
    }

    // ---- real-chain tests: actual TCP downloads through the full guard ----

    use std::io::Read as _;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::sync::Mutex;

    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    /// Minimal canned HTTP server: each accepted connection receives the next
    /// response. Bodies are served with correct Content-Length; extra raw
    /// headers may carry a Location for redirects.
    fn serve_responses(responses: Vec<(u16, Vec<(String, String)>, Vec<u8>)>) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            for (status, headers, body) in responses {
                let Ok((mut stream, _)) = listener.accept() else { return };
                // drain the request head (and any body) with a small timeout
                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer);
                let mut response = format!("HTTP/1.1 {status} x\r\nContent-Length: {}\r\n", body.len());
                for (name, value) in headers {
                    response.push_str(&format!("{name}: {value}\r\n"));
                }
                response.push_str("Connection: close\r\n\r\n");
                stream.write_all(response.as_bytes()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        (port, handle)
    }

    fn small_limits() -> DownloadLimits {
        DownloadLimits {
            max_bytes: 1024 * 1024,
            total_timeout: Duration::from_secs(10),
            max_redirects: 3,
        }
    }

    fn png_payload() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend(std::iter::repeat(0x11).take(256));
        bytes
    }

    #[test]
    fn real_download_succeeds_without_proxy() {
        let (port, server) = serve_responses(vec![(200, vec![], png_payload())]);
        let _guard = TestLoopbackGuard::allow(&[port]);
        let _env = ProxyEnvGuard::set_dead_proxy();
        let url = format!("http://127.0.0.1:{port}/pic.png");
        let bytes = download_with_limits(&url, &small_limits()).expect("真实下载应成功(直连,不走代理)");
        assert_eq!(bytes, png_payload());
        server.join().unwrap();
    }

    fn serve_redirect_chain(location: &str) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let location = location.to_string();
        let handle = std::thread::spawn(move || {
            let mut buffer = [0u8; 2048];
            // hop 1: redirect — emit the 302 and exit; the payload is served
            // by the separate final server. Waiting for a second accept here
            // would deadlock the test's join.
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = stream.read(&mut buffer);
            let head = format!(
                "HTTP/1.1 302 x\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(head.as_bytes()).unwrap();
        });
        (port, handle)
    }

    #[test]
    fn real_download_follows_validated_redirect_chain() {
        // The redirect target is a SECOND canned server (different port), so
        // the hop genuinely re-validates + re-pins before connecting.
        let (final_port, final_server) = serve_responses(vec![(200, vec![], png_payload())]);
        let final_url = format!("http://127.0.0.1:{final_port}/final.png");
        let (port, server) = serve_redirect_chain(&final_url);
        let _guard = TestLoopbackGuard::allow(&[port, final_port]);
        let start = format!("http://127.0.0.1:{port}/first");
        let bytes = download_with_limits(&start, &small_limits()).expect("重定向链应成功");
        assert_eq!(bytes, png_payload());
        server.join().unwrap();
        final_server.join().unwrap();
    }

    #[test]
    fn real_download_rejects_redirect_into_foreign_loopback() {
        // Redirect points at 127.0.0.1:9 (discard port) — outside the
        // test-allowed ports, so the real chain refuses the hop.
        let (port, server) = serve_redirect_chain("http://127.0.0.1:9/evil.png");
        let _guard = TestLoopbackGuard::allow(&[port]);
        let start = format!("http://127.0.0.1:{port}/start");
        let error = download_with_limits(&start, &small_limits()).unwrap_err();
        assert_eq!(error.status, 500);
        assert!(error.message.contains("重定向目标被拒"), "{}", error.message);
        server.join().unwrap();
    }

    #[test]
    fn real_download_enforces_byte_cap() {
        let (port, server) = serve_responses(vec![(200, vec![], vec![0x41u8; 64])]);
        let _guard = TestLoopbackGuard::allow(&[port]);
        let url = format!("http://127.0.0.1:{port}/big.bin");
        let limits = DownloadLimits {
            max_bytes: 8,
            total_timeout: Duration::from_secs(10),
            max_redirects: 3,
        };
        let error = download_with_limits(&url, &limits).unwrap_err();
        assert_eq!(error.status, 500);
        assert!(error.message.contains("上限"), "{}", error.message);
        server.join().unwrap();
    }

    #[test]
    fn real_download_enforces_total_timeout() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let _guard = TestLoopbackGuard::allow(&[port]);
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_secs(5));
            let _ = stream.write_all(b"HTTP/1.1 200 x\r\nContent-Length: 1\r\n\r\nA");
        });
        let url = format!("http://127.0.0.1:{port}/slow.bin");
        let limits = DownloadLimits {
            max_bytes: 1024,
            total_timeout: Duration::from_secs(1),
            max_redirects: 3,
        };
        let error = download_with_limits(&url, &limits).unwrap_err();
        assert!(error.message.contains("失败") || error.message.contains("时长"), "{}", error.message);
        drop(handle);
    }

    #[test]
    fn rejected_caller_urls_are_param_errors_without_credentials_in_logs() {
        for bad in [
            "ftp://example.com/x",
            "https://alice:hunter2@example.com/x.png",
            "http://127.0.0.1/x",
            "http://nonexistent.invalid./x",
        ] {
            let error = download_with_limits(bad, &small_limits()).unwrap_err();
            assert_eq!(error.status, 400, "{bad} -> {error:?}");
            assert_eq!(error.code, "invalid-param");
            assert!(!error.message.contains("hunter2"), "{}", error.message);
            assert!(!error.message.contains("alice:"), "{}", error.message);
        }
    }

    #[test]
    fn dns_resolution_deadline_is_enforced() {
        // An already-expired budget fails immediately instead of blocking on
        // the resolver.
        let error = resolve_with_deadline("example.com", 80, Instant::now() - Duration::from_secs(1));
        assert!(error.is_err());
    }

    #[test]
    fn prepare_import_runs_the_real_chain() {
        let (port, server) = serve_responses(vec![(200, vec![], png_payload()), (200, vec![], png_payload())]);
        {
            let _guard = TestLoopbackGuard::allow(&[port]);
            let _env = ProxyEnvGuard::set_dead_proxy();
            let url = format!("http://127.0.0.1:{port}/pic.png");

            // explicit legal name is used verbatim
            let prepared = prepare_import(&url, Some("素材 A.png"), &small_limits()).unwrap();
            assert_eq!(prepared.name, "素材 A.png");
            assert_eq!(prepared.mime, "image/png");
            assert_eq!(prepared.magic, Some(MagicFamily::Png));
            assert_eq!(prepared.bytes, png_payload());

            // explicit illegal name (leading space) is a param error, not repaired
            let error = prepare_import(&url, Some(" a.png"), &small_limits()).unwrap_err();
            assert_eq!(error.status, 400);

            // extension/content conflict on the real chain
            let error3 = prepare_import(&url.replace("pic.png", "x.pptx"), None, &small_limits()).unwrap_err();
            assert_eq!(error3.status, 400);
            assert!(error3.message.contains("冲突") || error3.message.contains("不符"), "{}", error3.message);
        }
        server.join().unwrap();

        // bare URL path: generated name from sniffed content
        let (port2, server2) = serve_responses(vec![(200, vec![], png_payload())]);
        {
            let _guard = TestLoopbackGuard::allow(&[port2]);
            let url2 = format!("http://127.0.0.1:{port2}/files/");
            let prepared2 = prepare_import(&url2, None, &small_limits()).unwrap();
            assert!(prepared2.name.starts_with("import-"), "{}", prepared2.name);
            assert!(prepared2.name.ends_with(".png"));
        }
        server2.join().unwrap();
    }

    /// Points HTTP(S)_PROXY/ALL_PROXY at a discard port; downloads that
    /// accidentally honor a proxy would fail against it.
    struct ProxyEnvGuard {
        saved: Vec<(String, Option<std::ffi::OsString>)>,
    }

    impl ProxyEnvGuard {
        fn set_dead_proxy() -> Self {
            let names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
            let saved = names
                .iter()
                .map(|name| (name.to_string(), std::env::var_os(name)))
                .collect::<Vec<_>>();
            for name in names {
                std::env::set_var(name, "http://127.0.0.1:9");
            }
            Self { saved }
        }
    }

    impl Drop for ProxyEnvGuard {
        fn drop(&mut self) {
            for (name, value) in self.saved.drain(..) {
                match value {
                    Some(value) => std::env::set_var(&name, value),
                    None => std::env::remove_var(&name),
                }
            }
        }
    }

    // ---- external route admission (unchanged behaviour, re-verified) ----

    use crate::local_transport::{
        start_server, AdapterResponse, CapabilityTier, LocalTransportHandle, ServerConfig,
        TransportAdapter,
    };
    use std::path::PathBuf;
    use std::sync::Arc;

    struct RouteProbeAdapter {
        calls: Mutex<Vec<(String, String)>>,
    }

    impl TransportAdapter for RouteProbeAdapter {
        fn dispatch(&self, method: &str, path: &str, _body: Option<&str>) -> AdapterResponse {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), path.to_string()));
            AdapterResponse {
                status: 200,
                body: r#"{"ok":true,"probe":true}"#.to_string(),
            }
        }
        fn collect(&self, _body: &Value) -> Result<Value, String> {
            Ok(serde_json::json!({}))
        }
    }

    fn probe_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lr-import-file-{}-{}", label, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn raw_http(port: u16, request: &str) -> String {
        // Mirrors the transport suite's own `request` helper.
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let _ = stream.shutdown(std::net::Shutdown::Write);
        let mut response = String::new();
        if let Err(error) = stream.read_to_string(&mut response) {
            assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
        }
        response
    }

    fn response_status(response: &str) -> u16 {
        response.split_whitespace().nth(1).unwrap().parse().unwrap()
    }

    fn start_probe_server(label: &str) -> (LocalTransportHandle, Arc<RouteProbeAdapter>, PathBuf) {
        let dir = probe_temp_dir(label);
        let mut config = ServerConfig::test(dir.clone());
        config.read_timeout = Duration::from_secs(5);
        config.write_timeout = Duration::from_secs(5);
        config.granted_tier = CapabilityTier::Dangerous;
        let adapter = Arc::new(RouteProbeAdapter { calls: Mutex::new(Vec::new()) });
        let handle = start_server(config, adapter.clone()).unwrap();
        (handle, adapter, dir)
    }

    #[test]
    fn import_file_route_admission_end_to_end() {
        let (server, adapter, dir) = start_probe_server("admission");
        let port: u16 = server.base_url().rsplit(':').next().unwrap().parse().unwrap();
        let credential = server.client_config().credential;
        let body = r#"{"url":"https://example.com/a.png","fileName":"a.png"}"#;
        let sep: &str = "\r\n";

        let no_auth = [
            "POST /api/v1/assets/import-file HTTP/1.1".to_string(),
            format!("Host: 127.0.0.1:{port}"),
            "Content-Type: application/json".to_string(),
            format!("Content-Length: {}", body.len()),
            "Connection: close".to_string(),
            String::new(),
            body.to_string(),
        ].join(sep);
        assert_eq!(response_status(&raw_http(port, &no_auth)), 401);

        let with_auth = [
            "POST /api/v1/assets/import-file HTTP/1.1".to_string(),
            format!("Host: 127.0.0.1:{port}"),
            format!("Authorization: Bearer {credential}"),
            "Content-Type: application/json".to_string(),
            format!("Content-Length: {}", body.len()),
            "Connection: close".to_string(),
            String::new(),
            body.to_string(),
        ].join(sep);
        let ok = raw_http(port, &with_auth);
        assert_eq!(response_status(&ok), 200, "{ok}");
        assert!(ok.contains("\"probe\":true"));
        let calls = adapter.calls.lock().unwrap();
        assert_eq!(calls.last().unwrap(), &("POST".to_string(), "/api/assets/import-file".to_string()));

        let get = [
            "GET /api/v1/assets/import-file HTTP/1.1".to_string(),
            format!("Host: 127.0.0.1:{port}"),
            format!("Authorization: Bearer {credential}"),
            "Connection: close".to_string(),
            String::new(),
            String::new(),
        ].join(sep);
        assert_eq!(response_status(&raw_http(port, &get)), 405);

        let huge = "x".repeat(1024 * 1024 + 16);
        let oversized = [
            "POST /api/v1/assets/import-file HTTP/1.1".to_string(),
            format!("Host: 127.0.0.1:{port}"),
            format!("Authorization: Bearer {credential}"),
            "Content-Type: application/json".to_string(),
            format!("Content-Length: {}", huge.len()),
            "Connection: close".to_string(),
            String::new(),
            huge.clone(),
        ].join(sep);
        assert_eq!(response_status(&raw_http(port, &oversized)), 413);

        drop(server);
        drop(calls);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn import_file_route_requires_dangerous_tier() {
        let dir = probe_temp_dir("read-tier");
        let mut config = ServerConfig::test(dir.clone());
        config.read_timeout = Duration::from_secs(5);
        config.write_timeout = Duration::from_secs(5);
        config.granted_tier = crate::local_transport::CapabilityTier::Read;
        let adapter = Arc::new(RouteProbeAdapter { calls: Mutex::new(Vec::new()) });
        let server = start_server(config, adapter.clone()).unwrap();
        let port: u16 = server.base_url().rsplit(':').next().unwrap().parse().unwrap();
        let credential = server.client_config().credential;
        let body = r#"{"url":"https://example.com/a.png"}"#;
        let sep: &str = "\r\n";
        let request = [
            "POST /api/v1/assets/import-file HTTP/1.1".to_string(),
            format!("Host: 127.0.0.1:{port}"),
            format!("Authorization: Bearer {credential}"),
            "Content-Type: application/json".to_string(),
            format!("Content-Length: {}", body.len()),
            "Connection: close".to_string(),
            String::new(),
            body.to_string(),
        ].join(sep);
        let response = raw_http(port, &request);
        assert_eq!(response_status(&response), 403, "{response}");
        assert!(adapter.calls.lock().unwrap().is_empty());
        drop(server);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
