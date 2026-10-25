//! Narrow browser escape for the official DSH account authorization page.
pub(crate) const INITIALIZATION_SCRIPT: &str = include_str!("dsh_login_browser.js");

pub(crate) fn is_official_authorize_url(target: &url::Url) -> bool {
    target.scheme() == "https"
        && target.host_str() == Some("platform.deepseek.com")
        && target.port_or_known_default() == Some(443)
        && target.path() == "/dsh/authorize"
        && target.username().is_empty()
        && target.password().is_none()
        && target.fragment().is_none()
}

#[cfg(test)]
mod tests {
    use super::is_official_authorize_url;

    #[test]
    fn allows_only_official_https_authorization_page() {
        for value in [
            "https://platform.deepseek.com/dsh/authorize?authorize_id=synthetic&theme=dark",
            "https://platform.deepseek.com:443/dsh/authorize?authorize_id=synthetic",
        ] {
            assert!(is_official_authorize_url(&value.parse().unwrap()));
        }
        for value in [
            "http://platform.deepseek.com/dsh/authorize",
            "https://platform.deepseek.com:8443/dsh/authorize",
            "https://platform.deepseek.com.evil.test/dsh/authorize",
            "https://evil.test/dsh/authorize",
            "https://platform.deepseek.com/dsh/authorize/",
            "https://platform.deepseek.com/dsh/complete",
            "https://platform.deepseek.com/dsh/%61uthorize",
            "https://user@platform.deepseek.com/dsh/authorize",
            "https://user:password@platform.deepseek.com/dsh/authorize",
            "https://platform.deepseek.com/dsh/authorize#fragment",
            "http://127.0.0.1:9999/dsh/authorize",
            "about:blank",
            "javascript:alert(1)",
            "file:///tmp/authorize",
        ] {
            assert!(!is_official_authorize_url(&value.parse().unwrap()), "{value}");
        }
    }
}
