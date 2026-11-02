use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryVersion {
    pub slot: String,
    pub revision: String,
    pub bytes: u64,
    pub preview: Option<String>,
    pub changed_since_record: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryItem {
    pub record_path: String,
    pub original_path: String,
    pub kind: String,
    pub pending: bool,
    pub token: String,
    pub can_restore: bool,
    pub versions: Vec<RecoveryVersion>,
    pub unavailable_versions: usize,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryIssue {
    pub record_path: String,
    pub code: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoverySnapshot {
    pub supported: bool,
    pub startup_blocked: bool,
    pub records: Vec<RecoveryItem>,
    pub issues: Vec<RecoveryIssue>,
    pub scan_incomplete: bool,
}
