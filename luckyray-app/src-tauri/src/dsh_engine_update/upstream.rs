//! Public discovery is evidence, never authority to install. No credentials,
//! profile writes, package installation or fallback to a Desktop wrapper.
use super::{update_client, ArtifactError, Candidate};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::io::Read;

const REPO: &str = "deepseek-ai/deepseek-harness";
const API: &str = "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases";
const MAX_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OfficialAssetIdentity {
    pub(crate) repository: String,
    pub(crate) tag: String,
    pub(crate) release_id: u64,
    pub(crate) asset_id: u64,
    pub(crate) name: String,
}

#[derive(Clone, Debug, Deserialize)]
struct Release {
    id: u64,
    tag_name: String,
    html_url: String,
    draft: bool,
    published_at: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Clone, Debug, Deserialize)]
struct Asset {
    id: u64,
    name: String,
    size: u64,
    browser_download_url: String,
    digest: Option<String>,
    state: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Discovery {
    pub(crate) version: String,
    pub(crate) tag: String,
    pub(crate) release_id: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DiscoveryError {
    Network,
    Identity,
}

fn request(url: &str) -> Result<Vec<u8>, DiscoveryError> {
    let client = update_client(15).map_err(|_| DiscoveryError::Network)?;
    let response = client
        .get(url)
        .header("User-Agent", "LuckyRay-engine-discovery")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|_| DiscoveryError::Network)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err(DiscoveryError::Network);
    }
    let mut bytes = Vec::new();
    response
        .take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| DiscoveryError::Network)?;
    if bytes.len() > MAX_BYTES {
        return Err(DiscoveryError::Identity);
    }
    Ok(bytes)
}

fn release_version(release: &Release) -> Option<Version> {
    if release.draft || release.published_at.is_none() || release.id == 0 {
        return None;
    }
    let version = Version::parse(release.tag_name.strip_prefix("dsh-v")?).ok()?;
    if !version.build.is_empty()
        || release.html_url
            != format!(
                "https://github.com/{REPO}/releases/tag/{}",
                release.tag_name
            )
    {
        return None;
    }
    Some(version)
}

fn parse_discovery(bytes: &[u8]) -> Result<Discovery, DiscoveryError> {
    let releases: Vec<Release> =
        serde_json::from_slice(bytes).map_err(|_| DiscoveryError::Identity)?;
    if releases.len() > 20 {
        return Err(DiscoveryError::Identity);
    }
    // The preview channel includes released prereleases. /latest excludes
    // them, so it is not the appropriate discovery endpoint for this channel.
    let (version, release) = releases
        .iter()
        .filter_map(|r| release_version(r).map(|v| (v, r)))
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .ok_or(DiscoveryError::Identity)?;
    Ok(Discovery {
        version: version.to_string(),
        tag: release.tag_name.clone(),
        release_id: release.id,
    })
}

pub(crate) fn discover() -> Result<Discovery, DiscoveryError> {
    parse_discovery(&request(&format!("{API}?per_page=20"))?)
}

pub(crate) fn is_newer(upstream: &str, installed: &str) -> bool {
    match (Version::parse(upstream), Version::parse(installed)) {
        (Ok(upstream), Ok(installed)) => upstream > installed,
        _ => false,
    }
}

pub(crate) fn validate_asset(candidate: &Candidate) -> Result<(), ()> {
    let identity = candidate.upstream.as_ref().ok_or(())?;
    if identity.repository != REPO
        || identity.tag != format!("dsh-v{}", candidate.version)
        || identity.release_id == 0
        || identity.asset_id == 0
        || identity.name.is_empty()
        || identity.name.len() > 160
        || !identity.name.ends_with(".zip")
        || !identity
            .name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
        || candidate.artifact_url
            != format!(
                "https://github.com/{REPO}/releases/download/{}/{}",
                identity.tag, identity.name
            )
    {
        return Err(());
    }
    Ok(())
}

/// A catalog signature alone cannot turn a mirror or renamed Desktop asset
/// into an upstream runtime. Match the exact published release/asset again.
pub(crate) fn resolve_asset(candidate: &Candidate) -> Result<(), DiscoveryError> {
    validate_asset(candidate).map_err(|_| DiscoveryError::Identity)?;
    let identity = candidate
        .upstream
        .as_ref()
        .ok_or(DiscoveryError::Identity)?;
    let release: Release =
        serde_json::from_slice(&request(&format!("{API}/{}", identity.release_id))?)
            .map_err(|_| DiscoveryError::Identity)?;
    match_asset(candidate, &release)
}

fn match_asset(candidate: &Candidate, release: &Release) -> Result<(), DiscoveryError> {
    let identity = candidate
        .upstream
        .as_ref()
        .ok_or(DiscoveryError::Identity)?;
    if release_version(release).map(|v| v.to_string()).as_deref()
        != Some(candidate.version.as_str())
        || release.tag_name != identity.tag
        || release.id != identity.release_id
        || !release.assets.iter().any(|asset| {
            asset.id == identity.asset_id
                && asset.name == identity.name
                && asset.state == "uploaded"
                && asset.size == candidate.artifact_bytes
                && asset.browser_download_url == candidate.artifact_url
                && asset
                    .digest
                    .as_ref()
                    .is_none_or(|digest| digest == &format!("sha256:{}", candidate.artifact_sha256))
        })
    {
        return Err(DiscoveryError::Identity);
    }
    Ok(())
}

pub(crate) fn redirect_allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com")
        )
}

/// Resolve again at download time without delaying cancellation behind a
/// blocking metadata request. This public client has no authentication.
pub(crate) async fn require_resolved(
    candidate: &Candidate,
    client: &reqwest::Client,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(), ArtifactError> {
    use std::sync::atomic::Ordering;
    let Some(identity) = candidate.upstream.as_ref() else {
        return Ok(());
    };
    validate_asset(candidate).map_err(|_| ArtifactError::Invalid)?;
    let request = client
        .get(format!("{API}/{}", identity.release_id))
        .header("User-Agent", "LuckyRay-engine-discovery")
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(std::time::Duration::from_secs(15))
        .send();
    tokio::pin!(request);
    let mut response = loop {
        tokio::select! {
            response = &mut request => break response.map_err(|_| ArtifactError::Io)?,
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                if cancel.load(Ordering::Acquire) { return Err(ArtifactError::Io); }
            }
        }
    };
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err(ArtifactError::Invalid);
    }
    let mut bytes = Vec::new();
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(ArtifactError::Io);
        }
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk.map_err(|_| ArtifactError::Io)?,
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => continue,
        };
        let Some(chunk) = chunk else {
            break;
        };
        if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Err(ArtifactError::Invalid);
        }
        bytes.extend_from_slice(&chunk);
    }
    let release: Release = serde_json::from_slice(&bytes).map_err(|_| ArtifactError::Invalid)?;
    match_asset(candidate, &release).map_err(|_| ArtifactError::Invalid)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_includes_preview_but_rejects_mirror_draft_and_wrong_family() {
        let row = |tag: &str, repo: &str, draft: bool| {
            serde_json::json!({
                "id": 10, "tag_name": tag, "html_url": format!("https://github.com/{repo}/releases/tag/{tag}"),
                "draft": draft, "published_at": "2026-09-28T00:00:00Z", "assets": []
            })
        };
        let bytes = serde_json::to_vec(&vec![
            row("dsh-v0.1.7-rc.2", REPO, false),
            row("dsh-v0.2.0-rc.1", REPO, false),
            row("dsh-v99.0.0", "mirror/desktop", false),
            row("dsh-v98.0.0", REPO, true),
            row("desktop-v97.0.0", REPO, false),
        ])
        .unwrap();
        assert_eq!(parse_discovery(&bytes).unwrap().version, "0.2.0-rc.1");
        assert!(is_newer("0.2.0-rc.1", "0.1.7-rc.2"));
        assert!(!is_newer("invalid", "0.1.7-rc.2"));
        assert!(!is_newer("0.1.7-rc.2", "0.1.7-rc.2"));
    }
    #[test]
    fn redirect_targets_are_exact_public_asset_hosts() {
        for url in [
            "http://objects.githubusercontent.com/a",
            "https://objects.githubusercontent.com.evil/a",
            "https://user@objects.githubusercontent.com/a",
            "https://127.0.0.1/a",
            "https://objects.githubusercontent.com:444/a",
        ] {
            assert!(!redirect_allowed(&reqwest::Url::parse(url).unwrap()));
        }
        assert!(redirect_allowed(
            &reqwest::Url::parse(
                "https://release-assets.githubusercontent.com/a?signature=temporary"
            )
            .unwrap()
        ));
    }
    #[test]
    #[ignore = "public upstream network discovery; no installation or profile writes"]
    fn live_official_discovery() {
        let found = discover().unwrap();
        println!(
            "OFFICIAL_DISCOVERY version={} tag={} release={}",
            found.version, found.tag, found.release_id
        );
    }
}
