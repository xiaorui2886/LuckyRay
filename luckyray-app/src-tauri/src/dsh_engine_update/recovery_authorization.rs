//! Optional authority for one sealed pending-health recovery, inside the same
//! production-signed candidate. Ordinary fromVersions is insufficient for this.
use super::{hex64, AdmissionError, Candidate};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryAuthorization {
    pub(crate) schema: u8,
    pub(crate) purpose: String,
    pub(crate) profile_identifier: String,
    pub(crate) predecessor_phase: String,
    pub(crate) predecessor_version: String,
    pub(crate) predecessor_artifact_sha256: String,
    pub(crate) predecessor_active_sha256: String,
    pub(crate) predecessor_journal_sha256: String,
    pub(crate) snapshot_manifest_sha256: String,
    pub(crate) data_qualification_sha256: String,
}

impl RecoveryAuthorization {
    pub(crate) fn validate(&self, target: &str, from: &[String]) -> Result<(), AdmissionError> {
        let old = semver::Version::parse(&self.predecessor_version)
            .map_err(|_| AdmissionError::InvalidManifest)?;
        let new = semver::Version::parse(target).map_err(|_| AdmissionError::InvalidManifest)?;
        if self.schema != 1 || self.purpose != "sealed-code-only-pending-recovery"
            || self.predecessor_phase != "activated_pending_health" || new <= old
            || !from.iter().any(|v| v == &self.predecessor_version)
            || self.profile_identifier.is_empty() || self.profile_identifier.len() > 128
            || !self.profile_identifier.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
            || [&self.predecessor_artifact_sha256, &self.predecessor_active_sha256,
                &self.predecessor_journal_sha256, &self.snapshot_manifest_sha256,
                &self.data_qualification_sha256].iter().any(|v| !hex64(v))
        { return Err(AdmissionError::InvalidManifest); }
        Ok(())
    }

    pub(super) fn matches_predecessor(&self, old: &Candidate, active: &[u8], journal: &[u8]) -> bool {
        self.predecessor_version == old.version && self.predecessor_artifact_sha256 == old.artifact_sha256
            && self.predecessor_active_sha256 == format!("{:x}", Sha256::digest(active))
            && self.predecessor_journal_sha256 == format!("{:x}", Sha256::digest(journal))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> RecoveryAuthorization {
        serde_json::from_value(serde_json::json!({
            "schema":1,"purpose":"sealed-code-only-pending-recovery",
            "profileIdentifier":"com.luckyray.desktop.dev.ui-empty",
            "predecessorPhase":"activated_pending_health","predecessorVersion":"0.2.0-rc.2",
            "predecessorArtifactSha256":"a".repeat(64),"predecessorActiveSha256":"b".repeat(64),
            "predecessorJournalSha256":"c".repeat(64),"snapshotManifestSha256":"d".repeat(64),
            "dataQualificationSha256":"e".repeat(64)
        })).unwrap()
    }

    #[test]
    fn authorization_names_the_pending_phase_profile_snapshot_and_qualification() {
        let a = fixture();
        assert_eq!(a.validate("0.2.2-rc.1", &["0.2.0-rc.2".into()]), Ok(()));
        for field in ["schema", "purpose", "profileIdentifier", "predecessorPhase", "predecessorVersion",
            "predecessorArtifactSha256", "predecessorActiveSha256", "predecessorJournalSha256",
            "snapshotManifestSha256", "dataQualificationSha256"] {
            let mut value = serde_json::to_value(&a).unwrap();
            value[field] = if field == "schema" { serde_json::json!(2) } else { serde_json::json!("invalid/field") };
            let changed: RecoveryAuthorization = serde_json::from_value(value).unwrap();
            assert_eq!(changed.validate("0.2.2-rc.1", &["0.2.0-rc.2".into()]), Err(AdmissionError::InvalidManifest), "{field}");
        }
        assert!(a.validate("0.2.0-rc.2", &["0.2.0-rc.2".into()]).is_err());
        assert!(a.validate("0.2.2-rc.1", &["0.1.7-rc.2".into()]).is_err());
        let mut unknown = serde_json::to_value(a).unwrap();
        unknown["ignoreVersionChecks"] = serde_json::json!(true);
        assert!(serde_json::from_value::<RecoveryAuthorization>(unknown).is_err());
    }
}
