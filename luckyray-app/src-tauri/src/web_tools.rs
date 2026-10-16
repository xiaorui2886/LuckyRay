use crate::backend::BackendServices;
use dom_query::Document;
use hmac::{Hmac, Mac};
use rand::RngCore;
use reqwest::blocking::{Client, Response};
use reqwest::header::{AUTHORIZATION, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, LOCATION};
use reqwest::redirect::Policy;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SEARCH_SETTING_KEY: &str = "agentWebSearxngEndpoint";
const NETWORK_ENABLED_SETTING_KEY: &str = "agentWebEnabled";
const SEARCH_PROVIDER_SETTING_KEY: &str = "agentWebProvider";
const TAVILY_KEY_SETTING_KEY: &str = "agentWebTavilyApiKey";
const SEARXNG_LOCAL_SETTING_KEY: &str = "agentWebSearxngAllowLocal";
const MAX_URL_BYTES: usize = 4096;
const MAX_QUERY_BYTES: usize = 1024;
const MAX_SEARCH_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_SEARCH_RESULTS: usize = 8;
const MIN_SEARCH_RESULTS: usize = 5;
const MAX_FETCH_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_FETCH_TEXT_BYTES: usize = 48 * 1024;
const MAX_REDIRECTS: usize = 5;
const MAX_TITLE_BYTES: usize = 512;
const MAX_SNIPPET_BYTES: usize = 2048;
const MAX_PERCENT_DECODE_LAYERS: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const DNS_TIMEOUT: Duration = Duration::from_secs(3);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_SCOPES: usize = 32;
const MAX_REFS_PER_SCOPE: usize = 20;
const MAX_SEARCH_CALLS_PER_SCOPE: usize = 3;
const MAX_FETCH_CALLS_PER_SCOPE: usize = 6;
const MAX_OUTPUT_BYTES_PER_SCOPE: usize = 256 * 1024;
const SCOPE_TTL: Duration = Duration::from_secs(120);
const FETCH_REF_DOMAIN: &[u8] = b"luckyray-agent-web-ref-v1\0";
const SOURCE_TOKEN_DOMAIN: &[u8] = b"luckyray-agent-web-source-v1\0";
const TAVILY_ENDPOINT: &str = "https://api.tavily.com/search";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WebToolError {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

/// A small, reusable HTTP boundary for callers that need the same SSRF
/// protections as `web.fetch` without inheriting its HTML/text projection.
/// The client deliberately owns redirect handling so every hop is validated,
/// DNS-pinned, proxy-free, and bounded by one shared deadline.
#[derive(Clone, Debug)]
pub(crate) struct SafeHttpClient {
    allow_test_loopback: bool,
    test_exact_origin: Option<SocketAddr>,
    io_timeout: Duration,
}

pub(crate) struct SafeHttpResponse {
    pub(crate) response: SafeHttpBody,
    pub(crate) final_url: Url,
}

pub(crate) struct SafeHttpBody {
    runtime: tokio::runtime::Runtime,
    response: reqwest::Response,
    deadline: Instant,
    io_timeout: Duration,
    pending: Vec<u8>,
    pending_offset: usize,
}

impl SafeHttpBody {
    fn new(
        runtime: tokio::runtime::Runtime,
        response: reqwest::Response,
        deadline: Instant,
        io_timeout: Duration,
    ) -> Self {
        Self {
            runtime,
            response,
            deadline,
            io_timeout,
            pending: Vec::new(),
            pending_offset: 0,
        }
    }

    pub(crate) fn status(&self) -> reqwest::StatusCode {
        self.response.status()
    }

    pub(crate) fn headers(&self) -> &reqwest::header::HeaderMap {
        self.response.headers()
    }
}

impl Read for SafeHttpBody {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if Instant::now() >= self.deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "safe HTTP deadline exceeded",
            ));
        }
        if self.pending_offset >= self.pending.len() {
            let timeout = self.io_timeout.min(self.deadline.saturating_duration_since(Instant::now()));
            let response = &mut self.response;
            let chunk = self
                .runtime
                .block_on(async { tokio::time::timeout(timeout, response.chunk()).await })
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "safe HTTP body idle timeout"))?
                .map_err(std::io::Error::other)?;
            let Some(chunk) = chunk else {
                return Ok(0);
            };
            self.pending.clear();
            self.pending.extend_from_slice(&chunk);
            self.pending_offset = 0;
        }
        let available = &self.pending[self.pending_offset..];
        let read = available.len().min(buffer.len());
        buffer[..read].copy_from_slice(&available[..read]);
        self.pending_offset += read;
        Ok(read)
    }
}

impl SafeHttpClient {
    pub(crate) fn production(io_timeout: Duration) -> Self {
        Self {
            allow_test_loopback: false,
            test_exact_origin: None,
            io_timeout,
        }
    }

    #[cfg(test)]
    pub(crate) fn loopback_for_test(io_timeout: Duration) -> Self {
        Self {
            allow_test_loopback: true,
            test_exact_origin: None,
            io_timeout,
        }
    }

    #[cfg(any(test, feature = "browser-host-poc-fixture"))]
    pub(crate) fn exact_loopback_for_test(origin: SocketAddr, io_timeout: Duration) -> Self {
        Self {
            allow_test_loopback: true,
            test_exact_origin: Some(origin),
            io_timeout,
        }
    }

    pub(crate) fn get(
        &self,
        raw_url: &str,
        deadline: Instant,
        max_redirects: usize,
        accept: &str,
    ) -> Result<SafeHttpResponse, WebToolError> {
        let url = validate_fetch_url(raw_url, self.allow_test_loopback)?;
        self.validate_test_origin(&url)?;
        self.get_validated(url, deadline, max_redirects, accept)
    }

    pub(crate) fn get_relative(
        &self,
        base: &Url,
        raw_reference: &str,
        deadline: Instant,
        max_redirects: usize,
        accept: &str,
    ) -> Result<SafeHttpResponse, WebToolError> {
        if raw_reference.as_bytes().len() > MAX_URL_BYTES
            || raw_reference
                .chars()
                .any(|character| character.is_control() || character.is_whitespace())
            || raw_reference.contains('\\')
        {
            return Err(network_denied());
        }
        validate_raw_reference_path(raw_reference).map_err(|_| network_denied())?;
        let joined = base.join(raw_reference).map_err(|_| network_denied())?;
        let url = validate_fetch_url(joined.as_str(), self.allow_test_loopback)?;
        self.validate_test_origin(&url)?;
        self.get_validated(url, deadline, max_redirects, accept)
    }

    fn get_validated(
        &self,
        mut url: Url,
        deadline: Instant,
        max_redirects: usize,
        accept: &str,
    ) -> Result<SafeHttpResponse, WebToolError> {
        for redirect_count in 0..=max_redirects {
            let io_timeout = self.io_timeout.min(remaining_before(deadline)?);
            let (runtime, client) =
                build_safe_async_client(&url, self.allow_test_loopback, deadline, io_timeout)?;
            let response = runtime
                .block_on(async {
                    client
                        .get(url.clone())
                        .header("Accept", accept)
                        .header("Accept-Encoding", "identity")
                        .send()
                        .await
                })
                .map_err(|error| {
                    // Classify without logging URL, headers, cookies or TLS data.
                    eprintln!("[safe-http] stage=response-headers timeout={} connect={}", error.is_timeout(), error.is_connect());
                    network_failed()
                })?;
            if !response.status().is_redirection() {
                return Ok(SafeHttpResponse {
                    response: SafeHttpBody::new(runtime, response, deadline, io_timeout),
                    final_url: url,
                });
            }
            if redirect_count >= max_redirects {
                return Err(WebToolError::new(
                    "web-redirect-denied",
                    "Web redirect is not allowed",
                ));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .filter(|value| value.as_bytes().len() <= MAX_URL_BYTES)
                .ok_or_else(|| {
                    WebToolError::new("web-redirect-denied", "Web redirect is not allowed")
                })?;
            validate_raw_reference_path(location).map_err(|_| {
                WebToolError::new("web-redirect-denied", "Web redirect is not allowed")
            })?;
            let next = url.join(location).map_err(|_| {
                WebToolError::new("web-redirect-denied", "Web redirect is not allowed")
            })?;
            if url.scheme() == "https" && next.scheme() != "https" {
                return Err(WebToolError::new(
                    "web-redirect-denied",
                    "Web redirect is not allowed",
                ));
            }
            url = validate_fetch_url(next.as_str(), self.allow_test_loopback)?;
            self.validate_test_origin(&url)?;
        }
        Err(WebToolError::new(
            "web-redirect-denied",
            "Web redirect is not allowed",
        ))
    }

    fn validate_test_origin(&self, url: &Url) -> Result<(), WebToolError> {
        let Some(expected) = self.test_exact_origin else {
            return Ok(());
        };
        let expected_host = expected.ip().to_string();
        if url.scheme() != "http"
            || url.host_str() != Some(expected_host.as_str())
            || url.port_or_known_default() != Some(expected.port())
        {
            return Err(network_denied());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SearchSettingsUpdate {
    pub(crate) enabled: bool,
    pub(crate) provider: String,
    #[serde(default)]
    pub(crate) tavily_api_key: Option<String>,
    #[serde(default)]
    pub(crate) clear_tavily_api_key: bool,
    #[serde(default)]
    pub(crate) searxng_endpoint: Option<String>,
    #[serde(default)]
    pub(crate) clear_searxng_endpoint: bool,
    #[serde(default)]
    pub(crate) searxng_allow_local: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchSettingsStatus {
    pub(crate) enabled: bool,
    pub(crate) provider: String,
    pub(crate) selected_provider: String,
    pub(crate) tavily_configured: bool,
    pub(crate) searxng_endpoint: Option<String>,
    pub(crate) searxng_allow_local: bool,
    pub(crate) ready: bool,
    pub(crate) code: &'static str,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchConnectionResult {
    pub(crate) ok: bool,
    pub(crate) provider: String,
    pub(crate) code: &'static str,
    pub(crate) label: &'static str,
}

impl WebToolError {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

#[derive(Clone)]
pub(crate) struct WebToolService {
    inner: Arc<WebToolInner>,
}

struct WebToolInner {
    secret: [u8; 32],
    state: Mutex<WebToolState>,
    tavily_endpoint: Url,
    allow_test_tavily_loopback: bool,
    allow_test_result_loopback: AtomicBool,
}

#[derive(Default)]
struct WebToolState {
    scopes: HashMap<[u8; 32], WebScope>,
}

struct WebScope {
    refs: HashMap<String, WebRef>,
    order: VecDeque<String>,
    last_used: Instant,
    search_snapshot: Option<Result<SearchProviderSnapshot, WebToolError>>,
    active: bool,
    in_flight: usize,
    deadline: Instant,
    search_calls: usize,
    fetch_calls: usize,
    output_bytes: usize,
    limits: WebScopeLimits,
}

#[derive(Clone, Copy)]
struct WebScopeLimits {
    max_refs: usize,
    max_search_calls: usize,
    max_fetch_calls: usize,
    max_output_bytes: usize,
    ttl: Duration,
}

impl WebScopeLimits {
    const fn standard() -> Self {
        Self {
            max_refs: MAX_REFS_PER_SCOPE,
            max_search_calls: MAX_SEARCH_CALLS_PER_SCOPE,
            max_fetch_calls: MAX_FETCH_CALLS_PER_SCOPE,
            max_output_bytes: MAX_OUTPUT_BYTES_PER_SCOPE,
            ttl: SCOPE_TTL,
        }
    }

    const fn research_v1() -> Self {
        Self {
            max_refs: 60,
            max_search_calls: 8,
            max_fetch_calls: 42,
            max_output_bytes: 512 * 1024,
            ttl: Duration::from_secs(15 * 60),
        }
    }
}

struct WebRef {
    url: Url,
    source_token: String,
}

struct RawSearchSettings {
    enabled: bool,
    selected_provider: String,
    tavily_api_key: Option<String>,
    searxng_endpoint: Option<String>,
    searxng_allow_local: bool,
}

impl WebToolService {
    pub(crate) fn new() -> Self {
        let mut secret = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut secret);
        Self {
            inner: Arc::new(WebToolInner {
                secret,
                state: Mutex::new(WebToolState::default()),
                tavily_endpoint: Url::parse(TAVILY_ENDPOINT)
                    .expect("the fixed Tavily endpoint must be a valid URL"),
                allow_test_tavily_loopback: false,
                allow_test_result_loopback: AtomicBool::new(false),
            }),
        }
    }

    #[cfg(test)]
    fn new_for_test_tavily(endpoint: Url) -> Self {
        let mut service = Self::new();
        let inner = Arc::get_mut(&mut service.inner).expect("fresh service has one owner");
        inner.tavily_endpoint = endpoint;
        inner.allow_test_tavily_loopback = true;
        inner
            .allow_test_result_loopback
            .store(true, Ordering::Release);
        service
    }

    #[cfg(test)]
    pub(crate) fn enable_result_loopback_for_test(&self) {
        self.inner
            .allow_test_result_loopback
            .store(true, Ordering::Release);
    }

    pub(crate) fn navigation_url(
        &self,
        scope: [u8; 32],
        fetch_ref: &str,
    ) -> Result<String, WebToolError> {
        let (url, _) = self.resolve_ref(scope, fetch_ref)?;
        Ok(url.to_string())
    }

    pub(crate) fn research_origin_key(
        &self,
        scope: [u8; 32],
        fetch_ref: &str,
    ) -> Result<String, WebToolError> {
        let (url, _) = self.resolve_ref(scope, fetch_ref)?;
        let mut digest = Sha256::new();
        digest.update(b"luckyray-agent-browser-source-v1\0");
        digest.update(url.as_str().as_bytes());
        Ok(format!("src-b-{:x}", digest.finalize()))
    }

    pub(crate) fn settings_status(
        &self,
        backend: &BackendServices,
    ) -> Result<SearchSettingsStatus, WebToolError> {
        let settings = load_search_settings(backend)?;
        let tavily_configured = settings
            .tavily_api_key
            .as_deref()
            .is_some_and(|value| validate_tavily_key(value).is_ok());
        let safe_searxng_endpoint = settings
            .searxng_endpoint
            .as_deref()
            .and_then(|value| validate_searxng_endpoint(value, settings.searxng_allow_local).ok())
            .map(|value| value.to_string());
        let configured = match settings.selected_provider.as_str() {
            "tavily" => tavily_configured,
            "searxng" => safe_searxng_endpoint.is_some(),
            _ => false,
        };
        let ready = settings.enabled && configured;
        Ok(SearchSettingsStatus {
            enabled: settings.enabled,
            provider: if settings.enabled {
                settings.selected_provider.clone()
            } else {
                "off".to_owned()
            },
            selected_provider: settings.selected_provider,
            tavily_configured,
            searxng_endpoint: safe_searxng_endpoint,
            searxng_allow_local: settings.searxng_allow_local,
            ready,
            code: if !settings.enabled {
                "web-network-disabled"
            } else if configured {
                "ready"
            } else {
                "web-search-unavailable"
            },
        })
    }

    pub(crate) fn update_settings(
        &self,
        backend: &BackendServices,
        update: SearchSettingsUpdate,
    ) -> Result<SearchSettingsStatus, WebToolError> {
        if !matches!(update.provider.as_str(), "tavily" | "searxng")
            || (update.clear_tavily_api_key && update.tavily_api_key.is_some())
            || (update.clear_searxng_endpoint && update.searxng_endpoint.is_some())
        {
            return Err(config_invalid());
        }
        let key = update
            .tavily_api_key
            .as_deref()
            .map(validate_tavily_key)
            .transpose()?;
        let endpoint = update
            .searxng_endpoint
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| validate_searxng_endpoint(value, update.searxng_allow_local))
            .transpose()?;
        let mut connection = backend.open_write().map_err(|_| config_invalid())?;
        let transaction = connection.transaction().map_err(|_| config_invalid())?;
        write_setting(
            &transaction,
            NETWORK_ENABLED_SETTING_KEY,
            if update.enabled { "true" } else { "false" },
        )?;
        write_setting(&transaction, SEARCH_PROVIDER_SETTING_KEY, &update.provider)?;
        write_setting(
            &transaction,
            SEARXNG_LOCAL_SETTING_KEY,
            if update.searxng_allow_local {
                "true"
            } else {
                "false"
            },
        )?;
        if let Some(endpoint) = endpoint {
            write_setting(&transaction, SEARCH_SETTING_KEY, endpoint.as_str())?;
        } else if update.clear_searxng_endpoint {
            delete_setting(&transaction, SEARCH_SETTING_KEY)?;
        }
        if let Some(key) = key {
            write_setting(&transaction, TAVILY_KEY_SETTING_KEY, &key)?;
        } else if update.clear_tavily_api_key {
            delete_setting(&transaction, TAVILY_KEY_SETTING_KEY)?;
        }
        transaction.commit().map_err(|_| config_invalid())?;
        self.settings_status(backend)
    }

    pub(crate) fn test_connection(&self, backend: &BackendServices) -> SearchConnectionResult {
        let status = match self.settings_status(backend) {
            Ok(status) => status,
            Err(error) => return connection_result(false, "off", error.code),
        };
        if !status.ready {
            return connection_result(false, &status.provider, status.code);
        }
        let mut scope = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut scope);
        let lease = match self.bind_scope(backend, scope) {
            Ok(lease) => lease,
            Err(error) => return connection_result(false, &status.provider, error.code),
        };
        let result = self.search(
            backend,
            scope,
            &json!({"query":"LuckyRay connection test","limit":5}),
        );
        drop(lease);
        match result {
            Ok(_) => connection_result(true, &status.provider, "ready"),
            Err(error) => connection_result(false, &status.provider, error.code),
        }
    }

    pub(crate) fn search(
        &self,
        backend: &BackendServices,
        scope: [u8; 32],
        input: &Value,
    ) -> Result<Value, WebToolError> {
        execute_web_search(self, backend, scope, input)
    }

    pub(crate) fn fetch(&self, scope: [u8; 32], input: &Value) -> Result<Value, WebToolError> {
        execute_web_fetch(self, scope, input)
    }

    pub(crate) fn clear_scope(&self, scope: [u8; 32]) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.scopes.remove(&scope);
        }
    }

    pub(crate) fn cancel_scope(&self, scope: [u8; 32]) {
        if let Ok(mut state) = self.inner.state.lock() {
            if let Some(entry) = state.scopes.get_mut(&scope) {
                entry.active = false;
                entry.refs.clear();
                entry.order.clear();
                entry.last_used = Instant::now();
            }
        }
    }

    pub(crate) fn bind_scope(
        &self,
        backend: &BackendServices,
        scope: [u8; 32],
    ) -> Result<WebScopeLease, WebToolError> {
        self.bind_scope_with_limits(backend, scope, WebScopeLimits::standard())
    }

    pub(crate) fn bind_research_scope(
        &self,
        backend: &BackendServices,
        scope: [u8; 32],
    ) -> Result<WebScopeLease, WebToolError> {
        self.bind_scope_with_limits(backend, scope, WebScopeLimits::research_v1())
    }

    fn bind_scope_with_limits(
        &self,
        backend: &BackendServices,
        scope: [u8; 32],
        limits: WebScopeLimits,
    ) -> Result<WebScopeLease, WebToolError> {
        let snapshot = self.load_search_snapshot(backend);
        let mut state =
            self.inner.state.lock().map_err(|_| {
                WebToolError::new("web-capacity", "Web tool capacity is unavailable")
            })?;
        prune_scopes(&mut state);
        if !state.scopes.contains_key(&scope) && state.scopes.len() >= MAX_SCOPES {
            return Err(WebToolError::new(
                "web-capacity",
                "Web tool capacity is unavailable",
            ));
        }
        let entry = state.scopes.entry(scope).or_insert_with(|| WebScope {
            refs: HashMap::new(),
            order: VecDeque::new(),
            last_used: Instant::now(),
            search_snapshot: None,
            active: true,
            in_flight: 0,
            deadline: Instant::now() + limits.ttl,
            search_calls: 0,
            fetch_calls: 0,
            output_bytes: 0,
            limits,
        });
        if entry.search_snapshot.is_some() {
            return Err(WebToolError::new(
                "web-scope-bound",
                "Web tool scope is already active",
            ));
        }
        entry.search_snapshot = Some(snapshot);
        entry.active = true;
        entry.last_used = Instant::now();
        Ok(WebScopeLease {
            service: self.clone(),
            scope,
        })
    }

    fn scope_search_snapshot(
        &self,
        scope: [u8; 32],
    ) -> Result<SearchProviderSnapshot, WebToolError> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| WebToolError::new("web-ref-expired", "Web reference expired"))?;
        prune_scopes(&mut state);
        let entry = state.scopes.get_mut(&scope).ok_or_else(|| {
            WebToolError::new("web-search-unavailable", "Web search is unavailable")
        })?;
        if !entry.active || Instant::now() >= entry.deadline {
            entry.active = false;
            return Err(turn_stopped());
        }
        entry.last_used = Instant::now();
        entry.search_snapshot.as_ref().cloned().unwrap_or_else(|| {
            Err(WebToolError::new(
                "web-search-unavailable",
                "Web search is unavailable",
            ))
        })
    }

    pub(crate) fn scope_search_ready(&self, scope: [u8; 32]) -> Result<(), WebToolError> {
        self.scope_search_snapshot(scope).map(|_| ())
    }

    #[cfg(test)]
    pub(crate) fn issue_ref_for_test(
        &self,
        scope: [u8; 32],
        raw_url: &str,
    ) -> Result<String, WebToolError> {
        let url = validate_fetch_url(raw_url, true)?;
        self.remember_url(scope, url)
            .map(|(reference, _)| reference)
    }

    pub(crate) fn issue_explicit_user_ref(
        &self,
        scope: [u8; 32],
        raw_url: &str,
    ) -> Result<String, WebToolError> {
        self.scope_search_ready(scope)?;
        let url = validate_fetch_url(raw_url, cfg!(test))?;
        self.remember_url(scope, url)
            .map(|(reference, _)| reference)
    }

    #[cfg(test)]
    pub(crate) fn retained_scope_count(&self) -> usize {
        self.inner
            .state
            .lock()
            .map(|state| state.scopes.len())
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub(crate) fn expire_scope_for_test(&self, scope: [u8; 32]) {
        if let Ok(mut state) = self.inner.state.lock() {
            if let Some(entry) = state.scopes.get_mut(&scope) {
                entry.deadline = Instant::now();
            }
        }
    }

    fn remember_url(&self, scope: [u8; 32], url: Url) -> Result<(String, String), WebToolError> {
        let canonical = url.as_str();
        let fetch_ref = self.hmac_value("wref-", FETCH_REF_DOMAIN, &scope, canonical)?;
        let source_token = self.hmac_value("src-w-", SOURCE_TOKEN_DOMAIN, &scope, canonical)?;
        let mut state =
            self.inner.state.lock().map_err(|_| {
                WebToolError::new("web-capacity", "Web tool capacity is unavailable")
            })?;
        prune_scopes(&mut state);
        if !state.scopes.contains_key(&scope) && state.scopes.len() >= MAX_SCOPES {
            return Err(WebToolError::new(
                "web-capacity",
                "Web tool capacity is unavailable",
            ));
        }
        let entry = state.scopes.entry(scope).or_insert_with(|| WebScope {
            refs: HashMap::new(),
            order: VecDeque::new(),
            last_used: Instant::now(),
            search_snapshot: None,
            active: true,
            in_flight: 0,
            deadline: Instant::now() + WebScopeLimits::standard().ttl,
            search_calls: 0,
            fetch_calls: 0,
            output_bytes: 0,
            limits: WebScopeLimits::standard(),
        });
        if !entry.active || Instant::now() >= entry.deadline {
            entry.active = false;
            return Err(turn_stopped());
        }
        entry.last_used = Instant::now();
        if !entry.refs.contains_key(&fetch_ref) {
            while entry.refs.len() >= entry.limits.max_refs {
                if let Some(oldest) = entry.order.pop_front() {
                    entry.refs.remove(&oldest);
                } else {
                    break;
                }
            }
            entry.order.push_back(fetch_ref.clone());
            entry.refs.insert(
                fetch_ref.clone(),
                WebRef {
                    url,
                    source_token: source_token.clone(),
                },
            );
        }
        Ok((fetch_ref, source_token))
    }

    fn resolve_ref(&self, scope: [u8; 32], value: &str) -> Result<(Url, String), WebToolError> {
        if !valid_prefixed_digest(value, "wref-") {
            return Err(WebToolError::new(
                "web-ref-invalid",
                "Web reference is invalid",
            ));
        }
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| WebToolError::new("web-ref-expired", "Web reference expired"))?;
        prune_scopes(&mut state);
        let entry = state
            .scopes
            .get_mut(&scope)
            .ok_or_else(|| WebToolError::new("web-ref-expired", "Web reference expired"))?;
        if !entry.active || Instant::now() >= entry.deadline {
            entry.active = false;
            return Err(turn_stopped());
        }
        entry.last_used = Instant::now();
        let record = entry
            .refs
            .get(value)
            .ok_or_else(|| WebToolError::new("web-ref-expired", "Web reference expired"))?;
        Ok((record.url.clone(), record.source_token.clone()))
    }

    fn begin_network(&self, scope: [u8; 32]) -> Result<WebNetworkPermit, WebToolError> {
        let mut state =
            self.inner.state.lock().map_err(|_| {
                WebToolError::new("web-capacity", "Web tool capacity is unavailable")
            })?;
        let entry = state.scopes.get_mut(&scope).ok_or_else(turn_stopped)?;
        if !entry.active || Instant::now() >= entry.deadline {
            entry.active = false;
            return Err(turn_stopped());
        }
        entry.in_flight = entry
            .in_flight
            .checked_add(1)
            .ok_or_else(|| WebToolError::new("web-capacity", "Web tool capacity is unavailable"))?;
        entry.last_used = Instant::now();
        Ok(WebNetworkPermit {
            service: self.clone(),
            scope,
        })
    }

    fn reserve_tool_call(&self, scope: [u8; 32], search: bool) -> Result<(), WebToolError> {
        let mut state =
            self.inner.state.lock().map_err(|_| {
                WebToolError::new("web-capacity", "Web tool capacity is unavailable")
            })?;
        let entry = state.scopes.get_mut(&scope).ok_or_else(turn_stopped)?;
        if !entry.active || Instant::now() >= entry.deadline {
            entry.active = false;
            return Err(turn_stopped());
        }
        let counter = if search {
            &mut entry.search_calls
        } else {
            &mut entry.fetch_calls
        };
        let limit = if search {
            entry.limits.max_search_calls
        } else {
            entry.limits.max_fetch_calls
        };
        if *counter >= limit {
            return Err(WebToolError::new(
                "web-budget-exhausted",
                "Web tool budget is exhausted",
            ));
        }
        *counter = counter
            .checked_add(1)
            .ok_or_else(|| WebToolError::new("web-capacity", "Web tool capacity is unavailable"))?;
        Ok(())
    }

    fn record_output(&self, scope: [u8; 32], value: &Value) -> Result<(), WebToolError> {
        let bytes = serde_json::to_vec(value)
            .map_err(|_| WebToolError::new("web-capacity", "Web tool capacity is unavailable"))?
            .len();
        let mut state =
            self.inner.state.lock().map_err(|_| {
                WebToolError::new("web-capacity", "Web tool capacity is unavailable")
            })?;
        let entry = state.scopes.get_mut(&scope).ok_or_else(turn_stopped)?;
        if !entry.active || Instant::now() >= entry.deadline {
            entry.active = false;
            return Err(turn_stopped());
        }
        let projected = entry
            .output_bytes
            .checked_add(bytes)
            .ok_or_else(|| WebToolError::new("web-capacity", "Web tool capacity is unavailable"))?;
        if projected > entry.limits.max_output_bytes {
            return Err(WebToolError::new(
                "web-budget-exhausted",
                "Web tool budget is exhausted",
            ));
        }
        entry.output_bytes = projected;
        Ok(())
    }

    fn ensure_scope_active(&self, scope: [u8; 32]) -> Result<(), WebToolError> {
        let mut state =
            self.inner.state.lock().map_err(|_| {
                WebToolError::new("web-capacity", "Web tool capacity is unavailable")
            })?;
        match state.scopes.get_mut(&scope) {
            Some(entry) if entry.active && Instant::now() < entry.deadline => Ok(()),
            Some(entry) => {
                entry.active = false;
                Err(turn_stopped())
            }
            None => Err(turn_stopped()),
        }
    }

    fn hmac_value(
        &self,
        prefix: &str,
        domain: &[u8],
        scope: &[u8; 32],
        value: &str,
    ) -> Result<String, WebToolError> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.inner.secret)
            .map_err(|_| WebToolError::new("web-capacity", "Web tool capacity is unavailable"))?;
        mac.update(domain);
        mac.update(scope);
        mac.update(b"\0");
        mac.update(value.as_bytes());
        let digest = mac.finalize().into_bytes();
        let mut value = String::with_capacity(prefix.len() + digest.len() * 2);
        value.push_str(prefix);
        for byte in digest {
            use std::fmt::Write as _;
            write!(&mut value, "{byte:02x}").map_err(|_| {
                WebToolError::new("web-capacity", "Web tool capacity is unavailable")
            })?;
        }
        Ok(value)
    }
}

fn prune_scopes(state: &mut WebToolState) {
    let now = Instant::now();
    state.scopes.retain(|_, scope| {
        scope.active
            || scope.in_flight > 0
            || now.saturating_duration_since(scope.last_used) <= scope.limits.ttl
    });
}

fn valid_prefixed_digest(value: &str, prefix: &str) -> bool {
    value.len() == prefix.len() + 64
        && value.starts_with(prefix)
        && value[prefix.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

trait WebSearchAdapter {
    fn search(&self, endpoint: &Url, query: &str, limit: usize) -> Result<Value, WebToolError>;
}

#[derive(Clone)]
enum SearchProviderSnapshot {
    Tavily {
        api_key: String,
        endpoint: Url,
        allow_test_loopback: bool,
    },
    Searxng {
        endpoint: Url,
        allow_local: bool,
        allow_result_loopback: bool,
    },
}

pub(crate) struct WebScopeLease {
    service: WebToolService,
    scope: [u8; 32],
}

struct WebNetworkPermit {
    service: WebToolService,
    scope: [u8; 32],
}

impl Drop for WebNetworkPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.service.inner.state.lock() {
            if let Some(entry) = state.scopes.get_mut(&self.scope) {
                entry.in_flight = entry.in_flight.saturating_sub(1);
                entry.last_used = Instant::now();
            }
        }
    }
}

impl Drop for WebScopeLease {
    fn drop(&mut self) {
        self.service.clear_scope(self.scope);
    }
}

struct TavilySearchAdapter {
    api_key: String,
    allow_test_loopback: bool,
    total_timeout: Duration,
}

struct SearxngSearchAdapter {
    allow_endpoint_loopback: bool,
    allow_result_loopback: bool,
}

#[derive(Deserialize)]
struct SearxngResponse {
    #[serde(default)]
    results: Vec<SearxngResult>,
}

#[derive(Deserialize)]
struct SearxngResult {
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default, alias = "content")]
    content: String,
}

impl WebToolService {
    fn load_search_snapshot(
        &self,
        backend: &BackendServices,
    ) -> Result<SearchProviderSnapshot, WebToolError> {
        let settings = load_search_settings(backend)?;
        if !settings.enabled {
            return Err(WebToolError::new(
                "web-network-disabled",
                "Agent web access is disabled",
            ));
        }
        match settings.selected_provider.as_str() {
            "tavily" => Ok(SearchProviderSnapshot::Tavily {
                api_key: validate_tavily_key(&settings.tavily_api_key.ok_or_else(|| {
                    WebToolError::new("web-search-unavailable", "Web search is unavailable")
                })?)?,
                endpoint: self.inner.tavily_endpoint.clone(),
                allow_test_loopback: self.inner.allow_test_tavily_loopback,
            }),
            "searxng" => {
                let raw = settings.searxng_endpoint.ok_or_else(|| {
                    WebToolError::new("web-search-unavailable", "Web search is unavailable")
                })?;
                Ok(SearchProviderSnapshot::Searxng {
                    endpoint: validate_searxng_endpoint(&raw, settings.searxng_allow_local)?,
                    allow_local: settings.searxng_allow_local,
                    allow_result_loopback: self
                        .inner
                        .allow_test_result_loopback
                        .load(Ordering::Acquire),
                })
            }
            _ => Err(WebToolError::new(
                "web-search-unavailable",
                "Web search is unavailable",
            )),
        }
    }
}

pub(crate) fn execute_web_search(
    service: &WebToolService,
    _backend: &BackendServices,
    scope: [u8; 32],
    input: &Value,
) -> Result<Value, WebToolError> {
    let query = input
        .get("query")
        .and_then(Value::as_str)
        .ok_or_else(|| WebToolError::new("tool-input-invalid", "Web search input is invalid"))?;
    if query.is_empty()
        || query.as_bytes().len() > MAX_QUERY_BYTES
        || query.chars().any(char::is_control)
    {
        return Err(WebToolError::new(
            "tool-input-invalid",
            "Web search input is invalid",
        ));
    }
    let limit = input
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .clamp(MIN_SEARCH_RESULTS as u64, MAX_SEARCH_RESULTS as u64) as usize;
    let snapshot = service.scope_search_snapshot(scope)?;
    service.reserve_tool_call(scope, true)?;
    let network_permit = service.begin_network(scope)?;
    let result = match snapshot {
        SearchProviderSnapshot::Tavily {
            api_key,
            endpoint,
            allow_test_loopback,
        } => TavilySearchAdapter {
            api_key,
            allow_test_loopback,
            total_timeout: TOTAL_TIMEOUT,
        }
        .search(&endpoint, query, limit)?,
        SearchProviderSnapshot::Searxng {
            endpoint,
            allow_local,
            allow_result_loopback,
        } => SearxngSearchAdapter {
            allow_endpoint_loopback: allow_local,
            allow_result_loopback,
        }
        .search(&endpoint, query, limit)?,
    };
    drop(network_permit);
    service.ensure_scope_active(scope)?;
    let mut projected = Vec::new();
    for item in result
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(raw_url) = item.get("url").and_then(Value::as_str) else {
            continue;
        };
        let url = validate_result_url(raw_url, cfg!(test))?;
        let (fetch_ref, source_token) = service.remember_url(scope, url)?;
        projected.push(json!({
            "id": fetch_ref,
            "fetchRef": fetch_ref,
            "sourceToken": source_token,
            "displayUrl": item.get("displayUrl").cloned().unwrap_or(Value::Null),
            "host": item.get("host").cloned().unwrap_or(Value::Null),
            "title": item.get("title").cloned().unwrap_or(Value::Null),
            "snippet": item.get("snippet").cloned().unwrap_or(Value::Null),
        }));
    }
    let adapter = result
        .get("adapter")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "tavily" | "searxng"))
        .ok_or_else(search_response_invalid)?;
    let output = json!({"adapter":adapter,"results":projected});
    service.record_output(scope, &output)?;
    Ok(output)
}

pub(crate) fn execute_web_fetch(
    service: &WebToolService,
    scope: [u8; 32],
    input: &Value,
) -> Result<Value, WebToolError> {
    execute_web_fetch_with_timeout(service, scope, input, TOTAL_TIMEOUT)
}

fn execute_web_fetch_with_timeout(
    service: &WebToolService,
    scope: [u8; 32],
    input: &Value,
    total_timeout: Duration,
) -> Result<Value, WebToolError> {
    let fetch_ref = input
        .get("fetchRef")
        .and_then(Value::as_str)
        .ok_or_else(|| WebToolError::new("tool-input-invalid", "Web fetch input is invalid"))?;
    if input.as_object().is_none_or(|value| value.len() != 1) {
        return Err(WebToolError::new(
            "tool-input-invalid",
            "Web fetch input is invalid",
        ));
    }
    service.reserve_tool_call(scope, false)?;
    let (mut url, _) = service.resolve_ref(scope, fetch_ref)?;
    let deadline = Instant::now()
        .checked_add(total_timeout)
        .ok_or_else(network_failed)?;
    for redirect_count in 0..=MAX_REDIRECTS {
        let network_permit = service.begin_network(scope)?;
        let remaining = remaining_before(deadline)?;
        let client = build_pinned_client(&url, cfg!(test), deadline)?;
        let response = client
            .get(url.clone())
            .timeout(remaining)
            .header(
                "Accept",
                "text/html, application/xhtml+xml, text/plain;q=0.9",
            )
            .header("Accept-Encoding", "identity")
            .send()
            .map_err(|_| network_failed())?;
        if response.status().is_redirection() {
            if redirect_count >= MAX_REDIRECTS {
                return Err(WebToolError::new(
                    "web-redirect-denied",
                    "Web redirect is not allowed",
                ));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .filter(|value| value.as_bytes().len() <= MAX_URL_BYTES)
                .ok_or_else(|| {
                    WebToolError::new("web-redirect-denied", "Web redirect is not allowed")
                })?;
            validate_raw_reference_path(location).map_err(|_| {
                WebToolError::new("web-redirect-denied", "Web redirect is not allowed")
            })?;
            let next = url.join(location).map_err(|_| {
                WebToolError::new("web-redirect-denied", "Web redirect is not allowed")
            })?;
            if url.scheme() == "https" && next.scheme() != "https" {
                return Err(WebToolError::new(
                    "web-redirect-denied",
                    "Web redirect is not allowed",
                ));
            }
            url = validate_fetch_url(next.as_str(), cfg!(test))?;
            drop(network_permit);
            continue;
        }
        if !response.status().is_success() {
            return Err(WebToolError::new(
                "web-fetch-unavailable",
                "Web page is unavailable",
            ));
        }
        reject_non_identity_encoding(&response)?;
        let content_type = selected_content_type(&response)?;
        let bytes = read_bounded(response, MAX_FETCH_RESPONSE_BYTES)?;
        drop(network_permit);
        service.ensure_scope_active(scope)?;
        let body = String::from_utf8(bytes).map_err(|_| {
            WebToolError::new("web-fetch-invalid-response", "Web page text is invalid")
        })?;
        let (title, text, truncated) = if content_type == "text/plain" {
            let (text, truncated) = normalize_plain_text(&body, MAX_FETCH_TEXT_BYTES);
            (String::new(), text, truncated)
        } else {
            extract_html(&body)
        };
        let host = url
            .host_str()
            .and_then(safe_host_projection)
            .ok_or_else(search_response_invalid)?;
        let display_url = display_url(&url)?;
        // Redirect targets are distinct sources. Re-issuing from the final URL
        // keeps the public token and its private provenance aligned.
        let (issued_ref, source_token) = service.remember_url(scope, url.clone())?;
        let output = json!({
            "id": issued_ref,
            "fetchRef": issued_ref,
            "sourceToken": source_token,
            "displayUrl": display_url,
            "host": host,
            "title": title,
            "text": text,
            "contentType": content_type,
            "truncated": truncated,
        });
        service.record_output(scope, &output)?;
        return Ok(output);
    }
    Err(WebToolError::new(
        "web-redirect-denied",
        "Web redirect is not allowed",
    ))
}

impl WebSearchAdapter for SearxngSearchAdapter {
    fn search(&self, endpoint: &Url, query: &str, limit: usize) -> Result<Value, WebToolError> {
        let deadline = Instant::now()
            .checked_add(TOTAL_TIMEOUT)
            .ok_or_else(network_failed)?;
        let client = build_pinned_client(endpoint, self.allow_endpoint_loopback, deadline)?;
        let response = client
            .post(endpoint.clone())
            .timeout(remaining_before(deadline)?)
            .header("Accept", "application/json")
            .header("Accept-Encoding", "identity")
            .form(&[("q", query), ("format", "json")])
            .send()
            .map_err(|_| {
                WebToolError::new("web-search-unavailable", "Web search is unavailable")
            })?;
        if !response.status().is_success() {
            return Err(WebToolError::new(
                "web-search-unavailable",
                "Web search is unavailable",
            ));
        }
        reject_non_identity_encoding(&response)?;
        require_content_type(&response, &["application/json"])?;
        let bytes = read_bounded(response, MAX_SEARCH_RESPONSE_BYTES)?;
        let response: SearxngResponse = serde_json::from_slice(&bytes).map_err(|_| {
            WebToolError::new(
                "web-search-invalid-response",
                "Web search returned invalid data",
            )
        })?;
        project_adapter_results(
            "searxng",
            response.results,
            limit,
            self.allow_result_loopback,
        )
    }
}

impl WebSearchAdapter for TavilySearchAdapter {
    fn search(&self, endpoint: &Url, query: &str, limit: usize) -> Result<Value, WebToolError> {
        let deadline = Instant::now()
            .checked_add(self.total_timeout)
            .ok_or_else(network_failed)?;
        let client = build_pinned_client(endpoint, self.allow_test_loopback, deadline)?;
        let response = client
            .post(endpoint.clone())
            .timeout(remaining_before(deadline)?)
            .header(AUTHORIZATION, format!("Bearer {}", self.api_key))
            .header("Accept", "application/json")
            .header("Accept-Encoding", "identity")
            .json(&json!({
                "query": query,
                "search_depth": "basic",
                "max_results": limit,
                "include_answer": false,
                "include_raw_content": false,
            }))
            .send()
            .map_err(map_search_transport_error)?;
        match response.status().as_u16() {
            200..=299 => {}
            401 | 403 => {
                return Err(WebToolError::new(
                    "web-search-unauthorized",
                    "Web search authorization failed",
                ))
            }
            429 => {
                return Err(WebToolError::new(
                    "web-search-rate-limited",
                    "Web search is temporarily rate limited",
                ))
            }
            _ => {
                return Err(WebToolError::new(
                    "web-search-unavailable",
                    "Web search is unavailable",
                ))
            }
        }
        reject_non_identity_encoding(&response)?;
        require_content_type(&response, &["application/json"])?;
        let bytes = read_bounded(response, MAX_SEARCH_RESPONSE_BYTES)?;
        let response: SearxngResponse = serde_json::from_slice(&bytes).map_err(|_| {
            WebToolError::new(
                "web-search-invalid-response",
                "Web search returned invalid data",
            )
        })?;
        project_adapter_results("tavily", response.results, limit, self.allow_test_loopback)
    }
}

fn project_adapter_results(
    adapter: &'static str,
    items: Vec<SearxngResult>,
    limit: usize,
    allow_test_loopback: bool,
) -> Result<Value, WebToolError> {
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    for item in items.into_iter().take(MAX_SEARCH_RESULTS * 2) {
        if results.len() >= limit {
            break;
        }
        let Ok(url) = validate_result_url(&item.url, allow_test_loopback) else {
            continue;
        };
        let canonical = url.as_str().to_owned();
        if !seen.insert(canonical.clone()) {
            continue;
        }
        let Some(host) = url.host_str().and_then(safe_host_projection) else {
            continue;
        };
        results.push(json!({
            "id": canonical,
            "url": url.as_str(),
            "displayUrl": display_url(&url)?,
            "host": host,
            "title": safe_web_title(&item.title),
            "snippet": bounded_text(&item.content, MAX_SNIPPET_BYTES),
        }));
    }
    if results.is_empty() {
        return Err(WebToolError::new(
            "web-search-empty",
            "Web search returned no results",
        ));
    }
    Ok(json!({"adapter":adapter,"results":results}))
}

fn map_search_transport_error(error: reqwest::Error) -> WebToolError {
    if error.is_timeout() {
        WebToolError::new("web-search-timeout", "Web search timed out")
    } else {
        WebToolError::new("web-search-unavailable", "Web search is unavailable")
    }
}

fn validate_tavily_key(raw: &str) -> Result<String, WebToolError> {
    if raw.is_empty()
        || raw.as_bytes().len() > 1024
        || raw.trim() != raw
        || !raw
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'"' | b'\'' | b'\\'))
    {
        return Err(config_invalid());
    }
    Ok(raw.to_owned())
}

fn validate_searxng_endpoint(raw: &str, allow_local: bool) -> Result<Url, WebToolError> {
    if raw.as_bytes().len() > MAX_URL_BYTES
        || raw
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || raw.contains('\\')
    {
        return Err(config_invalid());
    }
    validate_raw_reference_path(raw).map_err(|_| config_invalid())?;
    let url = Url::parse(raw).map_err(|_| config_invalid())?;
    let host = url.host_str().ok_or_else(config_invalid)?;
    let parsed_host_ip = parse_url_host_ip(host);
    let local_http = allow_local
        && url.scheme() == "http"
        && parsed_host_ip.is_some_and(|address| address.is_loopback());
    let remote_https = url.scheme() == "https"
        && parsed_host_ip.is_none_or(|address| !is_forbidden_ip(address))
        && url.port().is_none_or(|port| port == 443);
    if (!local_http && !remote_https)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || validate_url_path(url.path()).is_err()
    {
        return Err(config_invalid());
    }
    Ok(url)
}

fn write_setting(
    transaction: &rusqlite::Transaction<'_>,
    key: &str,
    value: &str,
) -> Result<(), WebToolError> {
    transaction
        .execute(
            "INSERT INTO settings(key,value) VALUES (?1,?2) \
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![key, value],
        )
        .map(|_| ())
        .map_err(|_| config_invalid())
}

fn delete_setting(transaction: &rusqlite::Transaction<'_>, key: &str) -> Result<(), WebToolError> {
    transaction
        .execute("DELETE FROM settings WHERE key=?1", [key])
        .map(|_| ())
        .map_err(|_| config_invalid())
}

fn load_search_settings(backend: &BackendServices) -> Result<RawSearchSettings, WebToolError> {
    let connection = backend.open_read().map_err(|_| config_invalid())?;
    let (enabled, provider, tavily_key, endpoint, allow_local): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = connection
        .query_row(
            "SELECT \
             MAX(CASE WHEN key='agentWebEnabled' THEN value END), \
             MAX(CASE WHEN key='agentWebProvider' THEN value END), \
             MAX(CASE WHEN key='agentWebTavilyApiKey' THEN value END), \
             MAX(CASE WHEN key='agentWebSearxngEndpoint' THEN value END), \
             MAX(CASE WHEN key='agentWebSearxngAllowLocal' THEN value END) \
             FROM settings",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|_| config_invalid())?;
    Ok(RawSearchSettings {
        enabled: enabled.is_some_and(|value| value == "true" || value == "1"),
        selected_provider: provider
            .filter(|value| matches!(value.as_str(), "tavily" | "searxng"))
            .unwrap_or_else(|| "tavily".to_owned()),
        tavily_api_key: tavily_key,
        searxng_endpoint: endpoint.filter(|value| !value.trim().is_empty()),
        searxng_allow_local: allow_local.is_some_and(|value| value == "true" || value == "1"),
    })
}

pub(crate) fn validate_fetch_url(
    raw: &str,
    allow_test_loopback: bool,
) -> Result<Url, WebToolError> {
    if raw.as_bytes().len() > MAX_URL_BYTES
        || raw
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || raw.contains('\\')
    {
        return Err(network_denied());
    }
    validate_raw_reference_path(raw).map_err(|_| network_denied())?;
    let mut url = Url::parse(raw).map_err(|_| network_denied())?;
    let loopback_http = allow_test_loopback
        && url.scheme() == "http"
        && url.host_str().is_some_and(|host| host == "127.0.0.1");
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || (!loopback_http
            && url.port().is_some_and(|port| {
                (url.scheme() == "http" && port != 80) || (url.scheme() == "https" && port != 443)
            }))
        || validate_url_path(url.path()).is_err()
        || url
            .query()
            .is_some_and(|query| query.chars().any(char::is_control) || query.contains('\\'))
    {
        return Err(network_denied());
    }
    url.set_fragment(None);
    Ok(url)
}

fn config_invalid() -> WebToolError {
    WebToolError::new(
        "web-search-config-invalid",
        "Web search configuration is invalid",
    )
}

fn turn_stopped() -> WebToolError {
    WebToolError::new("web-turn-stopped", "Web turn is no longer active")
}

fn connection_result(ok: bool, provider: &str, code: &'static str) -> SearchConnectionResult {
    let label = match code {
        "ready" => "连接成功",
        "web-network-disabled" => "联网搜索未启用",
        "web-search-unauthorized" => "搜索服务授权失败",
        "web-search-rate-limited" => "搜索服务请求过于频繁",
        "web-search-timeout" => "搜索服务连接超时",
        "web-search-config-invalid" => "搜索服务配置无效",
        "web-search-empty" => "搜索服务未返回结果",
        _ => "搜索服务暂不可用",
    };
    SearchConnectionResult {
        ok,
        provider: if matches!(provider, "tavily" | "searxng") {
            provider.to_owned()
        } else {
            "off".to_owned()
        },
        code,
        label,
    }
}

fn validate_result_url(raw: &str, allow_test_loopback: bool) -> Result<Url, WebToolError> {
    if raw.as_bytes().len() > MAX_URL_BYTES
        || raw.chars().any(char::is_control)
        || raw.contains('\\')
    {
        return Err(search_response_invalid());
    }
    validate_raw_reference_path(raw).map_err(|_| search_response_invalid())?;
    let url = Url::parse(raw).map_err(|_| search_response_invalid())?;
    let parsed_host_ip = url.host_str().and_then(parse_url_host_ip);
    let loopback_http = allow_test_loopback
        && url.scheme() == "http"
        && parsed_host_ip.is_some_and(|address| address.is_loopback());
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || parsed_host_ip.is_some_and(|address| is_forbidden_ip(address) && !loopback_http)
        || (!loopback_http
            && url.port().is_some_and(|port| {
                (url.scheme() == "http" && port != 80) || (url.scheme() == "https" && port != 443)
            }))
        || validate_url_path(url.path()).is_err()
    {
        return Err(search_response_invalid());
    }
    Ok(url)
}

fn parse_url_host_ip(host: &str) -> Option<IpAddr> {
    host.strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
        .parse()
        .ok()
}

fn search_response_invalid() -> WebToolError {
    WebToolError::new(
        "web-search-invalid-response",
        "Web search returned invalid data",
    )
}

fn build_pinned_client(
    url: &Url,
    allow_test_loopback: bool,
    deadline: Instant,
) -> Result<Client, WebToolError> {
    let host = url.host_str().ok_or_else(network_denied)?;
    let port = url.port_or_known_default().ok_or_else(network_denied)?;
    let addresses = resolve_validated(host, port, allow_test_loopback, deadline)?;
    build_client_for_addresses(url, &addresses, deadline)
}

fn build_client_for_addresses(
    url: &Url,
    addresses: &[SocketAddr],
    deadline: Instant,
) -> Result<Client, WebToolError> {
    let host = url.host_str().ok_or_else(network_denied)?;
    if addresses.is_empty() {
        return Err(network_denied());
    }
    let builder = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(CONNECT_TIMEOUT.min(remaining_before(deadline)?))
        .timeout(remaining_before(deadline)?);
    let builder = if host.parse::<IpAddr>().is_ok() {
        builder
    } else {
        builder.resolve_to_addrs(host, addresses)
    };
    builder.build().map_err(|_| network_failed())
}

fn build_safe_async_client(
    url: &Url,
    allow_test_loopback: bool,
    deadline: Instant,
    io_timeout: Duration,
) -> Result<(tokio::runtime::Runtime, reqwest::Client), WebToolError> {
    let host = url.host_str().ok_or_else(network_denied)?;
    let port = url.port_or_known_default().ok_or_else(network_denied)?;
    let addresses = resolve_validated(host, port, allow_test_loopback, deadline)?;
    if addresses.is_empty() {
        return Err(network_denied());
    }
    let connect_timeout = CONNECT_TIMEOUT.min(remaining_before(deadline)?);
    // Reqwest's initial read timeout starts before connection/TLS/headers, not
    // just body reads. Preserve the existing connection budget here; the body
    // independently enforces the shorter idle timeout in SafeHttpBody::read.
    let read_timeout = CONNECT_TIMEOUT.max(io_timeout).min(remaining_before(deadline)?);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| network_failed())?;
    let client = {
        let _runtime_guard = runtime.enter();
        let builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(connect_timeout)
            .read_timeout(read_timeout);
        let builder = if host.parse::<IpAddr>().is_ok() {
            builder
        } else {
            builder.resolve_to_addrs(host, &addresses)
        };
        builder.build().map_err(|_| network_failed())?
    };
    Ok((runtime, client))
}

pub(crate) fn resolve_validated(
    host: &str,
    port: u16,
    allow_test_loopback: bool,
    deadline: Instant,
) -> Result<Vec<SocketAddr>, WebToolError> {
    let remaining = DNS_TIMEOUT.min(remaining_before(deadline)?);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|_| network_failed())?;
    let mut addresses = runtime
        .block_on(async {
            tokio::time::timeout(remaining, tokio::net::lookup_host((host, port))).await
        })
        .map_err(|_| network_failed())?
        .map_err(|_| network_failed())?
        .collect::<Vec<_>>();
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty()
        || addresses.iter().any(|address| {
            is_forbidden_ip(address.ip()) && !(allow_test_loopback && address.ip().is_loopback())
        })
    {
        return Err(network_denied());
    }
    Ok(addresses)
}

fn remaining_before(deadline: Instant) -> Result<Duration, WebToolError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(network_failed)
}

fn network_denied() -> WebToolError {
    WebToolError::new("web-network-denied", "Web network target is not allowed")
}

fn network_failed() -> WebToolError {
    WebToolError::new("web-network-failed", "Web network request failed")
}

fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_forbidden_ipv4(ip),
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_forbidden_ipv4(mapped);
            }
            let segments = ip.segments();
            ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_multicast()
                || ipv6_prefix_matches(ip, "::".parse().expect("static IPv6"), 96)
                || ipv6_prefix_matches(ip, "64:ff9b::".parse().expect("static IPv6"), 96)
                || ipv6_prefix_matches(ip, "64:ff9b:1::".parse().expect("static IPv6"), 48)
                || ipv6_prefix_matches(ip, "100::".parse().expect("static IPv6"), 64)
                || ipv6_prefix_matches(ip, "2001::".parse().expect("static IPv6"), 23)
                || ipv6_prefix_matches(ip, "2001:db8::".parse().expect("static IPv6"), 32)
                || ipv6_prefix_matches(ip, "2002::".parse().expect("static IPv6"), 16)
                || ipv6_prefix_matches(ip, "3fff::".parse().expect("static IPv6"), 20)
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xffc0) == 0xfec0
                || (segments[0] == 0x0064 && segments[1] == 0xff9b)
                || (segments[0] == 0x2001 && segments[1] == 0)
                || (segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0010)
                || (segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0020)
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || segments[0] == 0x2002
                || (segments[0] == 0x0100
                    && segments[1] == 0
                    && segments[2] == 0
                    && segments[3] == 0)
        }
    }
}

fn ipv6_prefix_matches(address: std::net::Ipv6Addr, network: std::net::Ipv6Addr, bits: u8) -> bool {
    let shift = 128u32.saturating_sub(bits as u32);
    (u128::from(address) >> shift) == (u128::from(network) >> shift)
}

fn is_forbidden_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _d] = ip.octets();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip == Ipv4Addr::BROADCAST
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
}

fn validate_url_path(path: &str) -> Result<(), ()> {
    if path.as_bytes().len() > MAX_URL_BYTES || path.chars().any(char::is_control) {
        return Err(());
    }
    let mut current = path.as_bytes().to_vec();
    for _ in 0..MAX_PERCENT_DECODE_LAYERS {
        validate_decoded_path(&current)?;
        let (decoded, changed) = percent_decode_once(&current)?;
        if !changed {
            return Ok(());
        }
        if decoded.iter().any(|byte| *byte == b'\\') {
            return Err(());
        }
        current = decoded;
    }
    validate_decoded_path(&current)?;
    if current.contains(&b'%') {
        return Err(());
    }
    Ok(())
}

fn validate_raw_reference_path(value: &str) -> Result<(), ()> {
    let end = value
        .char_indices()
        .find_map(|(index, character)| matches!(character, '?' | '#').then_some(index))
        .unwrap_or(value.len());
    let authority_and_path = &value[..end];
    let path = if let Some(scheme_end) = authority_and_path.find("://") {
        let after_authority = &authority_and_path[scheme_end + 3..];
        after_authority
            .find('/')
            .map(|index| &after_authority[index..])
            .unwrap_or("")
    } else if let Some(after_authority) = authority_and_path.strip_prefix("//") {
        after_authority
            .find('/')
            .map(|index| &after_authority[index..])
            .unwrap_or("")
    } else {
        authority_and_path
    };
    if path.is_empty() {
        Ok(())
    } else {
        validate_url_path(path)
    }
}

fn validate_decoded_path(path: &[u8]) -> Result<(), ()> {
    if path
        .iter()
        .any(|byte| *byte == b'\\' || byte.is_ascii_control())
    {
        return Err(());
    }
    for segment in path.split(|byte| *byte == b'/') {
        if segment == b"." || segment == b".." {
            return Err(());
        }
    }
    Ok(())
}

fn percent_decode_once(input: &[u8]) -> Result<(Vec<u8>, bool), ()> {
    let mut output = Vec::with_capacity(input.len());
    let mut changed = false;
    let mut index = 0usize;
    while index < input.len() {
        if input[index] != b'%' {
            output.push(input[index]);
            index += 1;
            continue;
        }
        if index + 2 >= input.len() {
            return Err(());
        }
        let high = hex_value(input[index + 1]).ok_or(())?;
        let low = hex_value(input[index + 2]).ok_or(())?;
        let decoded = (high << 4) | low;
        if matches!(decoded, b'/' | b'\\') {
            return Err(());
        }
        output.push(decoded);
        changed = true;
        index += 3;
    }
    std::str::from_utf8(&output).map_err(|_| ())?;
    Ok((output, changed))
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn require_content_type(response: &Response, allowed: &[&str]) -> Result<(), WebToolError> {
    let raw = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    validate_utf8_charset(raw)?;
    let content_type = raw.split(';').next().map(str::trim).unwrap_or_default();
    if allowed.contains(&content_type) {
        Ok(())
    } else {
        Err(WebToolError::new(
            "web-content-type-denied",
            "Web response type is not allowed",
        ))
    }
}

fn selected_content_type(response: &Response) -> Result<&'static str, WebToolError> {
    let raw = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    validate_utf8_charset(raw)?;
    let value = raw.split(';').next().map(str::trim).unwrap_or_default();
    match value {
        "text/html" => Ok("text/html"),
        "text/plain" => Ok("text/plain"),
        "application/xhtml+xml" => Ok("application/xhtml+xml"),
        _ => Err(WebToolError::new(
            "web-content-type-denied",
            "Web response type is not allowed",
        )),
    }
}

fn validate_utf8_charset(content_type: &str) -> Result<(), WebToolError> {
    for parameter in content_type.split(';').skip(1) {
        let Some((name, value)) = parameter.trim().split_once('=') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("charset")
            && !value.trim().trim_matches('"').eq_ignore_ascii_case("utf-8")
        {
            return Err(WebToolError::new(
                "web-content-type-denied",
                "Web response type is not allowed",
            ));
        }
    }
    Ok(())
}

fn reject_non_identity_encoding(response: &Response) -> Result<(), WebToolError> {
    if response
        .headers()
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| !value.eq_ignore_ascii_case("identity"))
    {
        return Err(WebToolError::new(
            "web-content-encoding-denied",
            "Encoded web responses are not supported",
        ));
    }
    Ok(())
}

fn read_bounded(mut response: Response, limit: usize) -> Result<Vec<u8>, WebToolError> {
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > limit as u64)
    {
        return Err(WebToolError::new(
            "web-response-too-large",
            "Web response exceeds the safe limit",
        ));
    }
    let mut bytes = Vec::with_capacity(limit.min(16 * 1024));
    response
        .by_ref()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| network_failed())?;
    if bytes.len() > limit {
        return Err(WebToolError::new(
            "web-response-too-large",
            "Web response exceeds the safe limit",
        ));
    }
    Ok(bytes)
}

fn safe_host_projection(host: &str) -> Option<String> {
    if host.is_empty()
        || host.as_bytes().len() > 253
        || host.chars().any(|character| {
            character.is_control()
                || !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
        })
    {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

fn display_url(url: &Url) -> Result<String, WebToolError> {
    let mut safe = url.clone();
    safe.set_query(None);
    safe.set_fragment(None);
    let value = safe.to_string();
    if value.as_bytes().len() <= MAX_URL_BYTES {
        Ok(value)
    } else {
        Err(search_response_invalid())
    }
}

fn bounded_text(value: &str, limit: usize) -> String {
    let mut output = String::new();
    for character in value.chars() {
        if character.is_control() && !matches!(character, '\n' | '\t' | '\r') {
            continue;
        }
        let next = output.len().saturating_add(character.len_utf8());
        if next > limit {
            break;
        }
        output.push(character);
    }
    output
}

fn extract_html(value: &str) -> (String, String, bool) {
    let document = Document::from(value);
    let title = safe_web_title(document.select_single("title").text().as_ref());
    document
        .select("script,style,noscript,form,meta,head,iframe,template,object,embed,svg,canvas")
        .remove();
    let body = document.select_single("body");
    let text = if body.is_empty() {
        document.root().text()
    } else {
        body.text()
    };
    let (text, truncated) = normalize_plain_text(text.as_ref(), MAX_FETCH_TEXT_BYTES);
    (title, text, truncated)
}

fn normalize_plain_text(value: &str, limit: usize) -> (String, bool) {
    let mut output = String::new();
    let mut pending_space = false;
    let mut truncated = false;
    for character in value.chars() {
        if character.is_whitespace() || character.is_control() {
            pending_space = !output.is_empty();
            continue;
        }
        let needed = character.len_utf8() + usize::from(pending_space);
        if output
            .len()
            .checked_add(needed)
            .is_none_or(|next| next > limit)
        {
            truncated = true;
            break;
        }
        if pending_space {
            output.push(' ');
            pending_space = false;
        }
        output.push(character);
    }
    (output, truncated)
}

fn safe_web_title(value: &str) -> String {
    if value.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\u{061c}'
                    | '\u{200b}'..='\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
                    | '\u{feff}'
            )
    }) {
        return String::new();
    }
    let (value, _) = normalize_plain_text(value, MAX_TITLE_BYTES);
    let lower = value.to_ascii_lowercase();
    if value
        .chars()
        .any(|character| matches!(character, '\\' | '?' | '#'))
        || lower.contains("://")
        || lower.contains("token=")
        || lower.contains("authorization:")
    {
        String::new()
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn isolated_backend(label: &str) -> BackendServices {
        let root = std::env::temp_dir().join(format!(
            "luckyray-web-router-{label}-{}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        BackendServices::initialize(&root).unwrap()
    }

    #[test]
    fn reusable_safe_http_boundary_revalidates_redirects_and_denies_production_loopback() {
        let denied = match SafeHttpClient::production(Duration::from_secs(1)).get(
            "http://127.0.0.1/private?token=secret",
            Instant::now() + Duration::from_secs(1),
            1,
            "video/*",
        ) {
            Err(error) => error,
            Ok(_) => panic!("production safe HTTP accepted loopback"),
        };
        assert_eq!(denied.code, "web-network-denied");

        let target_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target_address = target_listener.local_addr().unwrap();
        let target = std::thread::spawn(move || {
            let (mut socket, _) = target_listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        });
        let redirect_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let redirect_address = redirect_listener.local_addr().unwrap();
        let redirect = std::thread::spawn(move || {
            let (mut socket, _) = redirect_listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            write!(
                socket,
                "HTTP/1.1 302 Found\r\nLocation: http://{target_address}/media\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        let response = SafeHttpClient::loopback_for_test(Duration::from_secs(1))
            .get(
                &format!("http://{redirect_address}/start"),
                Instant::now() + Duration::from_secs(2),
                1,
                "video/*",
            )
            .unwrap();
        assert_eq!(response.final_url.path(), "/media");
        redirect.join().unwrap();
        target.join().unwrap();
    }

    #[test]
    fn reusable_safe_http_header_wait_does_not_use_body_idle_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            socket.read(&mut request).unwrap();
            std::thread::sleep(Duration::from_millis(250));
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc");
        });
        let result = SafeHttpClient::loopback_for_test(Duration::from_millis(80))
            .get(&format!("http://{address}/slow-headers"), Instant::now() + Duration::from_secs(2), 0, "video/*");
        server.join().unwrap();
        let mut response = result.expect("connection/header budget must outlive body idle timeout").response;
        let mut bytes = Vec::new();
        response.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"abc");
    }

    #[test]
    fn reusable_safe_http_header_and_body_waits_remain_bounded() {
        for stall_headers in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = [0u8; 1024];
                socket.read(&mut request).unwrap();
                if !stall_headers {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\na").unwrap();
                }
                std::thread::sleep(Duration::from_millis(400));
            });
            let began = Instant::now();
            let result = SafeHttpClient::loopback_for_test(Duration::from_millis(80))
                .get(&format!("http://{address}/bounded-wait"), began + Duration::from_millis(180), 0, "video/*");
            if stall_headers {
                assert!(result.is_err());
                assert!(began.elapsed() >= Duration::from_millis(140));
            } else {
                let mut response = result.unwrap().response;
                let mut bytes = Vec::new();
                assert!(response.read_to_end(&mut bytes).is_err());
                assert_eq!(bytes, b"a");
            }
            assert!(began.elapsed() < Duration::from_millis(350), "must not wait for the stalled server");
            server.join().unwrap();
        }
    }

    #[test]
    fn reusable_safe_http_boundary_bounds_stalls_without_capping_progressing_downloads() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n")
                .unwrap();
            for byte in b"abcde" {
                socket.write_all(&[*byte]).unwrap();
                socket.flush().unwrap();
                std::thread::sleep(Duration::from_millis(60));
            }
        });
        let started = Instant::now();
        let mut response = SafeHttpClient::loopback_for_test(Duration::from_millis(120))
            .get(
                &format!("http://{address}/slow-but-progressing"),
                Instant::now() + Duration::from_secs(2),
                0,
                "application/octet-stream",
            )
            .unwrap()
            .response;
        let mut body = Vec::new();
        response.read_to_end(&mut body).unwrap();
        assert_eq!(body, b"abcde");
        assert!(started.elapsed() > Duration::from_millis(200));
        server.join().unwrap();
    }

    #[test]
    fn search_router_reports_tavily_configuration_without_reading_back_the_key() {
        let backend = isolated_backend("tavily-write-only");
        let service = backend.web_tools();
        let status = service
            .update_settings(
                &backend,
                SearchSettingsUpdate {
                    enabled: true,
                    provider: "tavily".to_owned(),
                    tavily_api_key: Some("tvly-PRIVATE-KEY".to_owned()),
                    clear_tavily_api_key: false,
                    searxng_endpoint: None,
                    clear_searxng_endpoint: false,
                    searxng_allow_local: false,
                },
            )
            .unwrap();
        assert_eq!(status.provider, "tavily");
        assert!(status.tavily_configured);
        assert_eq!(status.searxng_endpoint, None);
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains("PRIVATE"));
        assert!(!serialized.contains("tvly-"));
    }

    #[test]
    fn clearing_the_searxng_endpoint_removes_the_previous_server_owned_value() {
        let backend = isolated_backend("searxng-clear");
        let service = backend.web_tools();
        let configured = service
            .update_settings(
                &backend,
                SearchSettingsUpdate {
                    enabled: true,
                    provider: "searxng".to_owned(),
                    tavily_api_key: None,
                    clear_tavily_api_key: false,
                    searxng_endpoint: Some("https://search.example.test/search".to_owned()),
                    clear_searxng_endpoint: false,
                    searxng_allow_local: false,
                },
            )
            .unwrap();
        assert!(configured.searxng_endpoint.is_some());
        let cleared = service
            .update_settings(
                &backend,
                SearchSettingsUpdate {
                    enabled: false,
                    provider: "searxng".to_owned(),
                    tavily_api_key: None,
                    clear_tavily_api_key: false,
                    searxng_endpoint: None,
                    clear_searxng_endpoint: true,
                    searxng_allow_local: false,
                },
            )
            .unwrap();
        assert_eq!(cleared.searxng_endpoint, None);
        assert!(!cleared.ready);
    }

    #[test]
    fn status_never_projects_an_unvalidated_searxng_endpoint_from_storage() {
        let backend = isolated_backend("searxng-status-projection");
        let connection = backend.open_write().unwrap();
        for (key, value) in [
            (NETWORK_ENABLED_SETTING_KEY, "true"),
            (SEARCH_PROVIDER_SETTING_KEY, "searxng"),
            (SEARXNG_LOCAL_SETTING_KEY, "false"),
        ] {
            connection
                .execute(
                    "INSERT OR REPLACE INTO settings(key,value) VALUES (?1,?2)",
                    rusqlite::params![key, value],
                )
                .unwrap();
        }
        for invalid in [
            "https://user:PRIVATE@search.example.test/search",
            "https://search.example.test/search?token=PRIVATE",
            "https://search.example.test/search#PRIVATE",
            "https://192.168.1.9/search",
            "https://search.example.test/%2e%2e/PRIVATE",
            "https://search.example.test/search\nPRIVATE",
        ] {
            connection
                .execute(
                    "INSERT OR REPLACE INTO settings(key,value) VALUES (?1,?2)",
                    rusqlite::params![SEARCH_SETTING_KEY, invalid],
                )
                .unwrap();
            let status = backend.web_tools().settings_status(&backend).unwrap();
            assert_eq!(status.searxng_endpoint, None);
            assert!(!status.ready);
            let serialized = serde_json::to_string(&status).unwrap();
            assert!(!serialized.contains("PRIVATE"));
            assert!(!serialized.contains(invalid));
        }

        connection
            .execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES (?1,?2)",
                rusqlite::params![SEARCH_SETTING_KEY, "https://search.example.test/search"],
            )
            .unwrap();
        let valid = backend.web_tools().settings_status(&backend).unwrap();
        assert_eq!(
            valid.searxng_endpoint.as_deref(),
            Some("https://search.example.test/search")
        );
        assert!(valid.ready);
    }

    #[test]
    fn searxng_endpoint_policy_separates_remote_https_from_explicit_local_loopback() {
        assert!(validate_searxng_endpoint("https://search.example.test/search", false).is_ok());
        assert!(validate_searxng_endpoint("http://search.example.test/search", false).is_err());
        assert!(validate_searxng_endpoint("http://127.0.0.1:8888/search", false).is_err());
        assert!(validate_searxng_endpoint("http://127.0.0.1:8888/search", true).is_ok());
        assert!(validate_searxng_endpoint("http://[::1]:8888/search", true).is_ok());
        assert!(validate_searxng_endpoint("http://localhost:8888/search", true).is_err());
        assert!(validate_searxng_endpoint("http://192.168.1.9:8888/search", true).is_err());
        assert!(validate_searxng_endpoint("https://127.0.0.1/search", true).is_err());
        assert!(
            validate_searxng_endpoint("https://search.example.test/search?PRIVATE=1", false)
                .is_err()
        );
    }

    #[test]
    fn local_searxng_results_do_not_inherit_the_endpoint_loopback_exception() {
        let error = project_adapter_results(
            "searxng",
            vec![SearxngResult {
                url: "http://127.0.0.1/private".to_owned(),
                title: "Private".to_owned(),
                content: "Private".to_owned(),
            }],
            5,
            false,
        )
        .unwrap_err();
        assert_eq!(error.code, "web-search-empty");
    }

    #[test]
    fn tavily_router_uses_bearer_basic_once_and_returns_fetch_refs() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = socket.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if let Some(header_end) = request.windows(4).position(|value| value == b"\r\n\r\n")
                {
                    let headers = String::from_utf8_lossy(&request[..header_end + 4]);
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("Content-Length: "))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or_default();
                    if request.len() >= header_end + 4 + length {
                        break;
                    }
                }
            }
            let body = format!(
                "{{\"results\":[{{\"url\":\"http://127.0.0.1:{}/article?token=PRIVATE\",\"title\":\"Safe title\",\"content\":\"Safe snippet\"}}]}}",
                address.port()
            );
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        let backend = isolated_backend("tavily-network");
        let service = WebToolService::new_for_test_tavily(
            Url::parse(&format!("http://{address}/search")).unwrap(),
        );
        service
            .update_settings(
                &backend,
                SearchSettingsUpdate {
                    enabled: true,
                    provider: "tavily".to_owned(),
                    tavily_api_key: Some("tvly-PRIVATE-KEY".to_owned()),
                    clear_tavily_api_key: false,
                    searxng_endpoint: None,
                    clear_searxng_endpoint: false,
                    searxng_allow_local: false,
                },
            )
            .unwrap();
        let _lease = service.bind_scope(&backend, [41u8; 32]).unwrap();
        let result = service
            .search(
                &backend,
                [41u8; 32],
                &json!({"query":"bounded query","limit":5}),
            )
            .unwrap();
        let request = server.join().unwrap();
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer tvly-private-key"));
        assert!(request.contains("\"search_depth\":\"basic\""));
        assert!(request.contains("\"max_results\":5"));
        assert!(request.contains("\"query\":\"bounded query\""));
        assert_eq!(result["adapter"], "tavily");
        assert!(valid_prefixed_digest(
            result["results"][0]["fetchRef"].as_str().unwrap(),
            "wref-"
        ));
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("PRIVATE"));
        assert!(!serialized.contains("bounded query"));
    }

    #[test]
    fn tavily_transport_matrix_is_single_request_bounded_and_privacy_safe() {
        fn run_case(
            status: Option<u16>,
            content_type: &str,
            body: Vec<u8>,
            timeout: Duration,
            stall: bool,
        ) -> (Result<Value, WebToolError>, usize) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let content_type = content_type.to_owned();
            let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let count = accepted.clone();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                count.fetch_add(1, Ordering::SeqCst);
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request);
                if stall {
                    std::thread::sleep(Duration::from_millis(80));
                    return;
                }
                if let Some(status) = status {
                    let reason = if status == 200 { "OK" } else { "Error" };
                    write!(
                        socket,
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .unwrap();
                    socket.write_all(&body).unwrap();
                }
            });
            let result = TavilySearchAdapter {
                api_key: "tvly-PRIVATE-KEY".to_owned(),
                allow_test_loopback: true,
                total_timeout: timeout,
            }
            .search(
                &Url::parse(&format!("http://{address}/search")).unwrap(),
                "safe query",
                5,
            );
            server.join().unwrap();
            (result, accepted.load(Ordering::SeqCst))
        }

        for (status, expected) in [
            (401, "web-search-unauthorized"),
            (403, "web-search-unauthorized"),
            (429, "web-search-rate-limited"),
            (500, "web-search-unavailable"),
        ] {
            let (result, calls) = run_case(
                Some(status),
                "text/plain",
                b"PRIVATE https://provider.invalid/?token=PRIVATE C:\\private\\stack".to_vec(),
                Duration::from_secs(1),
                false,
            );
            let error = result.unwrap_err();
            assert_eq!(error.code, expected);
            assert_eq!(calls, 1);
            assert!(!format!("{error:?}").contains("PRIVATE"));
        }

        for (body, expected) in [
            (b"not-json".to_vec(), "web-search-invalid-response"),
            (b"{\"results\":[]}".to_vec(), "web-search-empty"),
            (
                vec![b'x'; MAX_SEARCH_RESPONSE_BYTES + 1],
                "web-response-too-large",
            ),
        ] {
            let (result, calls) = run_case(
                Some(200),
                "application/json",
                body,
                Duration::from_secs(1),
                false,
            );
            assert_eq!(result.unwrap_err().code, expected);
            assert_eq!(calls, 1);
        }

        let (reset, reset_calls) = run_case(
            None,
            "application/json",
            Vec::new(),
            Duration::from_secs(1),
            false,
        );
        assert_eq!(reset.unwrap_err().code, "web-search-unavailable");
        assert_eq!(reset_calls, 1);
        let (timed_out, timeout_calls) = run_case(
            None,
            "application/json",
            Vec::new(),
            Duration::from_millis(20),
            true,
        );
        assert_eq!(timed_out.unwrap_err().code, "web-search-timeout");
        assert_eq!(timeout_calls, 1);
    }

    #[test]
    fn cancelled_turn_scope_denies_a_new_provider_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let service = WebToolService::new_for_test_tavily(
            Url::parse(&format!("http://{address}/search")).unwrap(),
        );
        let backend = isolated_backend("web-cancel-scope");
        service
            .update_settings(
                &backend,
                SearchSettingsUpdate {
                    enabled: true,
                    provider: "tavily".to_owned(),
                    tavily_api_key: Some("tvly-test-key".to_owned()),
                    clear_tavily_api_key: false,
                    searxng_endpoint: None,
                    clear_searxng_endpoint: false,
                    searxng_allow_local: false,
                },
            )
            .unwrap();
        let scope = [52u8; 32];
        let lease = service.bind_scope(&backend, scope).unwrap();
        service.cancel_scope(scope);

        let error = service
            .search(&backend, scope, &json!({"query":"cancelled","limit":5}))
            .unwrap_err();
        assert_eq!(error.code, "web-turn-stopped");
        assert!(matches!(
            listener.accept(),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
        ));
        drop(lease);
        assert_eq!(service.retained_scope_count(), 0);
    }

    #[test]
    fn enabled_search_scope_can_issue_a_bound_fetch_ref_for_an_explicit_user_url() {
        let backend = isolated_backend("explicit-user-url-ref");
        let service = backend.web_tools();
        service
            .update_settings(
                &backend,
                SearchSettingsUpdate {
                    enabled: true,
                    provider: "tavily".to_owned(),
                    tavily_api_key: Some("tvly-test-key".to_owned()),
                    clear_tavily_api_key: false,
                    searxng_endpoint: None,
                    clear_searxng_endpoint: false,
                    searxng_allow_local: false,
                },
            )
            .unwrap();
        let scope = [53u8; 32];
        let _lease = service.bind_scope(&backend, scope).unwrap();
        let reference = service
            .issue_explicit_user_ref(scope, "https://example.com/xuexi/15677.html?from=user")
            .unwrap();
        assert!(reference.starts_with("wref-") && reference.len() == 69);
        assert_eq!(
            service.navigation_url(scope, &reference).unwrap(),
            "https://example.com/xuexi/15677.html?from=user"
        );
    }

    #[test]
    fn turn_search_budget_denies_the_first_over_limit_request_before_network() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let observer = listener.try_clone().unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for index in 0..MAX_SEARCH_CALLS_PER_SCOPE {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request).unwrap();
                let body = format!(
                    "{{\"results\":[{{\"url\":\"https://example.test/{index}\",\"title\":\"Result {index}\",\"content\":\"safe\"}}]}}"
                );
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        let backend = isolated_backend("web-search-budget");
        let service = WebToolService::new_for_test_tavily(
            Url::parse(&format!("http://{address}/search")).unwrap(),
        );
        service
            .update_settings(
                &backend,
                SearchSettingsUpdate {
                    enabled: true,
                    provider: "tavily".to_owned(),
                    tavily_api_key: Some("tvly-test-key".to_owned()),
                    clear_tavily_api_key: false,
                    searxng_endpoint: None,
                    clear_searxng_endpoint: false,
                    searxng_allow_local: false,
                },
            )
            .unwrap();
        let scope = [53u8; 32];
        let _lease = service.bind_scope(&backend, scope).unwrap();
        for _ in 0..MAX_SEARCH_CALLS_PER_SCOPE {
            service
                .search(&backend, scope, &json!({"query":"bounded","limit":5}))
                .unwrap();
        }
        server.join().unwrap();
        observer.set_nonblocking(true).unwrap();

        let error = service
            .search(&backend, scope, &json!({"query":"over limit","limit":5}))
            .unwrap_err();
        assert_eq!(error.code, "web-budget-exhausted");
        assert!(matches!(
            observer.accept(),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
        ));
    }

    #[test]
    fn research_scope_gets_only_the_fixed_server_owned_web_limits() {
        let backend = isolated_backend("research-web-limits");
        let service = backend.web_tools();
        let scope = [54u8; 32];
        let _lease = service.bind_research_scope(&backend, scope).unwrap();

        for _ in 0..8 {
            service.reserve_tool_call(scope, true).unwrap();
        }
        assert_eq!(
            service.reserve_tool_call(scope, true).unwrap_err().code,
            "web-budget-exhausted"
        );
        for _ in 0..42 {
            service.reserve_tool_call(scope, false).unwrap();
        }
        assert_eq!(
            service.reserve_tool_call(scope, false).unwrap_err().code,
            "web-budget-exhausted"
        );
    }

    #[test]
    fn research_origin_digest_is_stable_only_for_a_bound_ref_in_the_same_scope() {
        let backend = isolated_backend("research-origin");
        let service = backend.web_tools();
        service
            .update_settings(
                &backend,
                SearchSettingsUpdate {
                    enabled: true,
                    provider: "tavily".to_owned(),
                    tavily_api_key: Some("tvly-test-key".to_owned()),
                    clear_tavily_api_key: false,
                    searxng_endpoint: None,
                    clear_searxng_endpoint: false,
                    searxng_allow_local: false,
                },
            )
            .unwrap();
        let scope = [55u8; 32];
        let _lease = service.bind_research_scope(&backend, scope).unwrap();
        let reference = service
            .issue_explicit_user_ref(scope, "https://example.com/article?private=value")
            .unwrap();
        let first = service.research_origin_key(scope, &reference).unwrap();
        let repeated = service.research_origin_key(scope, &reference).unwrap();

        assert_eq!(first, repeated);
        assert!(first.starts_with("src-b-"));
        assert!(!first.contains("example.com"));
        assert!(service.research_origin_key([56u8; 32], &reference).is_err());
    }

    #[test]
    fn turn_scope_keeps_the_original_search_snapshot_after_settings_change() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let read = socket.read(&mut request).unwrap();
            let body = format!(
                "{{\"results\":[{{\"url\":\"https://example.test/article\",\"title\":\"Snapshot A\",\"content\":\"safe\"}}]}}"
            );
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });
        let backend = isolated_backend("immutable-snapshot");
        let service = backend.web_tools();
        service
            .update_settings(
                &backend,
                SearchSettingsUpdate {
                    enabled: true,
                    provider: "searxng".to_owned(),
                    tavily_api_key: None,
                    clear_tavily_api_key: false,
                    searxng_endpoint: Some(format!("http://{address}/search")),
                    clear_searxng_endpoint: false,
                    searxng_allow_local: true,
                },
            )
            .unwrap();
        let scope = [42u8; 32];
        let _lease = service.bind_scope(&backend, scope).unwrap();
        service
            .update_settings(
                &backend,
                SearchSettingsUpdate {
                    enabled: false,
                    provider: "tavily".to_owned(),
                    tavily_api_key: None,
                    clear_tavily_api_key: false,
                    searxng_endpoint: None,
                    clear_searxng_endpoint: false,
                    searxng_allow_local: false,
                },
            )
            .unwrap();
        let result = service
            .search(
                &backend,
                scope,
                &json!({"query":"snapshot query","limit":5}),
            )
            .unwrap();
        assert_eq!(result["adapter"], "searxng");
        assert_eq!(result["results"][0]["title"], "Snapshot A");
        let request = server.join().unwrap();
        assert!(request.contains("snapshot+query") || request.contains("snapshot%20query"));
    }

    #[test]
    fn url_path_validation_rejects_encoded_traversal_layers() {
        for path in [
            "/../private",
            "/%2e%2e/private",
            "/%252e%252e/private",
            "/%252Fprivate",
            "/%255cprivate",
        ] {
            assert!(validate_url_path(path).is_err(), "accepted {path}");
        }
        assert!(validate_url_path("/search%20endpoint").is_ok());
    }

    #[test]
    fn production_fetch_ingress_rejects_traversal_before_url_normalization() {
        for raw in [
            "https://example.test/../private",
            "https://example.test/%2e%2e/private",
            "https://example.test/%252e%252e/private",
            "https://example.test/%252Fprivate",
            "https://example.test/%255Cprivate",
            "https://example.test/a/%2E%2e/private",
        ] {
            assert!(
                validate_fetch_url(raw, false).is_err(),
                "normalized unsafe URL: {raw}"
            );
        }
        assert!(validate_fetch_url("https://example.test/a%20b/page", false).is_ok());
    }

    #[test]
    fn private_and_reserved_addresses_are_denied() {
        for address in [
            "0.0.0.0",
            "127.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.0.1",
            "198.18.0.1",
            "224.0.0.1",
            "240.0.0.1",
            "::1",
            "::127.0.0.1",
            "::192.168.1.1",
            "64:ff9b:1::c0a8:1",
            "100::1",
            "2001:2::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "3fff::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                is_forbidden_ip(address.parse().unwrap()),
                "accepted {address}"
            );
        }
        assert!(!is_forbidden_ip("93.184.216.34".parse().unwrap()));
        assert!(!is_forbidden_ip(
            "2606:2800:220:1:248:1893:25c8:1946".parse().unwrap()
        ));
    }

    #[test]
    fn web_titles_are_single_line_and_reject_directional_or_url_like_content() {
        assert_eq!(safe_web_title("  Safe   title  "), "Safe title");
        for title in [
            "Safe\nForged status",
            "Safe\tForged status",
            "Safe\u{202e}txt",
            "https://example.test/private",
            "Authorization: PRIVATE",
        ] {
            assert!(safe_web_title(title).is_empty(), "accepted {title:?}");
        }
    }

    #[test]
    fn validated_dns_addresses_are_the_only_connection_targets() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, peer) = listener.accept().unwrap();
            let mut request = [0u8; 2048];
            let read = socket.read(&mut request).unwrap();
            let body = b"pinned";
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(body).unwrap();
            (peer, String::from_utf8_lossy(&request[..read]).into_owned())
        });
        let url = Url::parse(&format!(
            "http://pinning.invalid:{}/fixture",
            address.port()
        ))
        .unwrap();
        let deadline = Instant::now() + TOTAL_TIMEOUT;
        let client = build_client_for_addresses(&url, &[address], deadline).unwrap();
        let response = client.get(url).send().unwrap();
        assert_eq!(read_bounded(response, 16).unwrap(), b"pinned");
        let (peer, request) = server.join().unwrap();
        assert_eq!(peer.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert!(request
            .to_ascii_lowercase()
            .contains(&format!("host: pinning.invalid:{}", address.port())));
    }

    #[test]
    fn redirects_reissue_source_identity_for_the_validated_final_url() {
        let target_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target_address = target_listener.local_addr().unwrap();
        let target = std::thread::spawn(move || {
            let (mut socket, _) = target_listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            let body = b"final page";
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(body).unwrap();
        });
        let redirect_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let redirect_address = redirect_listener.local_addr().unwrap();
        let redirect = std::thread::spawn(move || {
            let (mut socket, _) = redirect_listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            write!(
                socket,
                "HTTP/1.1 302 Found\r\nLocation: http://{target_address}/final?PRIVATE=query\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        let service = WebToolService::new();
        let scope = [31u8; 32];
        let (initial_ref, initial_token) = service
            .remember_url(
                scope,
                Url::parse(&format!("http://{redirect_address}/start")).unwrap(),
            )
            .unwrap();
        let result = execute_web_fetch(&service, scope, &json!({"fetchRef":initial_ref})).unwrap();
        assert_ne!(result["sourceToken"], initial_token);
        assert_eq!(
            result["displayUrl"],
            format!("http://{target_address}/final")
        );
        redirect.join().unwrap();
        target.join().unwrap();
    }

    #[test]
    fn one_deadline_bounds_the_complete_redirect_chain() {
        let target_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target_address = target_listener.local_addr().unwrap();
        let target = std::thread::spawn(move || {
            let (mut socket, _) = target_listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            std::thread::sleep(Duration::from_millis(250));
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        });
        let redirect_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let redirect_address = redirect_listener.local_addr().unwrap();
        let redirect = std::thread::spawn(move || {
            let (mut socket, _) = redirect_listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            write!(
                socket,
                "HTTP/1.1 302 Found\r\nLocation: http://{target_address}/slow\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        let service = WebToolService::new();
        let scope = [32u8; 32];
        let (reference, _) = service
            .remember_url(
                scope,
                Url::parse(&format!("http://{redirect_address}/start")).unwrap(),
            )
            .unwrap();
        let started = Instant::now();
        let error = execute_web_fetch_with_timeout(
            &service,
            scope,
            &json!({"fetchRef":reference}),
            Duration::from_millis(100),
        )
        .unwrap_err();
        assert_eq!(error.code, "web-network-failed");
        assert!(started.elapsed() < Duration::from_secs(1));
        redirect.join().unwrap();
        target.join().unwrap();
    }
}
