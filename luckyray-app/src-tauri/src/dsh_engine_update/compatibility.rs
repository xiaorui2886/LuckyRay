//! Versioned, semantic host interfaces. Source hashes remain audit evidence;
//! they are still admission constraints for schema1 signed manifests only.
use super::AdmissionError;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Compatibility {
    pub(crate) schema: u8,
    pub(crate) adapter_protocol: u64,
    pub(crate) resource_protocol: u64,
    pub(crate) minimum_host_version: String,
    pub(crate) maximum_host_version_exclusive: String,
    pub(crate) required_capabilities: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostInterfaces {
    schema: u8,
    adapter_protocol: u64,
    resource_protocol: u64,
    capabilities: Vec<String>,
}

fn implements_capability(name: &str) -> bool {
    // These interfaces require the actual Windows host implementation. A
    // declaration file alone cannot enable them in a differently built host.
    if !cfg!(all(windows, target_arch = "x86_64", feature = "browser-host-runtime")) {
        return false;
    }
    match name {
        "authenticated-host-frames-v1" | "native-surface-loopback-v1"
        | "resource-intents-v1" | "plugin-quarantine-v1" | "signed-closure-switch-v1" => true,
        "closure-budget-40000-v1" => super::MAX_CLOSURE_FILE_COUNT == 40_000,
        "loader-login-relay-ready-v1" => crate::dsh_host::UPDATE_LOGIN_RELAY_READY_PROTOCOL == 1,
        _ => false,
    }
}

impl Compatibility {
    pub(crate) fn validate(&self) -> Result<(), AdmissionError> {
        let minimum = Version::parse(&self.minimum_host_version)
            .map_err(|_| AdmissionError::InvalidManifest)?;
        let maximum = Version::parse(&self.maximum_host_version_exclusive)
            .map_err(|_| AdmissionError::InvalidManifest)?;
        let mut seen = HashSet::new();
        if self.schema != 1 || self.adapter_protocol == 0 || self.resource_protocol == 0
            || minimum >= maximum || !minimum.pre.is_empty() || !maximum.pre.is_empty()
            || !minimum.build.is_empty() || !maximum.build.is_empty()
            || self.required_capabilities.is_empty() || self.required_capabilities.len() > 32
            || self.required_capabilities.iter().any(|value| value.is_empty() || value.len() > 96
                || !value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                || !seen.insert(value))
        {
            return Err(AdmissionError::InvalidManifest);
        }
        Ok(())
    }

    pub(crate) fn admit(&self, host_version: &str) -> Result<(), AdmissionError> {
        let host: HostInterfaces = serde_json::from_str(include_str!("../../../config/dsh-host-compatibility.json"))
            .map_err(|_| AdmissionError::InvalidManifest)?;
        self.admit_with_interfaces(host_version, &host)
    }

    fn admit_with_interfaces(&self, host_version: &str, host: &HostInterfaces) -> Result<(), AdmissionError> {
        self.validate()?;
        // Bind the declaration to the versions actually used by native frame
        // authentication and resource dispatch, not an independent constant.
        if host.schema != 1 || host.adapter_protocol != crate::dsh_host::UPDATE_ADAPTER_PROTOCOL
            || host.resource_protocol != u64::from(crate::dsh_resource_broker::UPDATE_RESOURCE_PROTOCOL)
        {
            return Err(AdmissionError::InvalidManifest);
        }
        let current = Version::parse(host_version).map_err(|_| AdmissionError::InvalidManifest)?;
        let minimum = Version::parse(&self.minimum_host_version).unwrap();
        let maximum = Version::parse(&self.maximum_host_version_exclusive).unwrap();
        if current < minimum || current >= maximum || !current.pre.is_empty() || !current.build.is_empty()
            || self.adapter_protocol != host.adapter_protocol || self.resource_protocol != host.resource_protocol
            || self.required_capabilities.iter().any(|value| !host.capabilities.contains(value) || !implements_capability(value))
        {
            return Err(AdmissionError::RequiresHost);
        }
        Ok(())
    }
}

#[cfg(all(test, windows, target_arch = "x86_64", feature = "browser-host-runtime"))]
mod tests {
    use super::*;

    #[test]
    fn new_engine_requires_real_capabilities_not_the_same_198_version_label() {
        let mut candidate = fixture();
        candidate.required_capabilities.extend([
            "closure-budget-40000-v1".into(), "loader-login-relay-ready-v1".into(),
        ]);
        // Exact declaration exported by Main e604209f, not an invented older
        // version number. The production gate is shared by both comparisons.
        let old: HostInterfaces = serde_json::from_str(include_str!(
            "../../../tests/fixtures/dshHost198LegacyInterfaces.json")).unwrap();
        assert_eq!(candidate.admit_with_interfaces("1.9.8", &old), Err(AdmissionError::RequiresHost));
        assert_eq!(candidate.admit("1.9.8"), Ok(()));
        for missing in ["closure-budget-40000-v1", "loader-login-relay-ready-v1"] {
            let mut host: HostInterfaces = serde_json::from_str(include_str!(
                "../../../config/dsh-host-compatibility.json")).unwrap();
            host.capabilities.retain(|value| value != missing);
            assert_eq!(candidate.admit_with_interfaces("1.9.8", &host), Err(AdmissionError::RequiresHost));
        }
    }
}

#[cfg(test)]
pub(crate) fn fixture() -> Compatibility {
    Compatibility { schema: 1, adapter_protocol: 1, resource_protocol: 1,
        minimum_host_version: "1.9.4".into(), maximum_host_version_exclusive: "2.0.0".into(),
        required_capabilities: vec!["authenticated-host-frames-v1".into(), "native-surface-loopback-v1".into(),
            "resource-intents-v1".into(), "plugin-quarantine-v1".into(), "signed-closure-switch-v1".into()] }
}
