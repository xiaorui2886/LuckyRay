use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialFilter {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default, alias = "tag_ids")]
    pub tag_ids: Vec<String>,
    #[serde(default, alias = "folder_id")]
    pub folder_id: Option<String>,
    #[serde(default, alias = "recent_only")]
    pub recent_only: bool,
    #[serde(default, alias = "date_from")]
    pub date_from: Option<String>,
    #[serde(default, alias = "date_to")]
    pub date_to: Option<String>,
    #[serde(default, alias = "rating_min")]
    pub rating_min: Option<i64>,
    #[serde(default, alias = "dominant_color")]
    pub dominant_color: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialAsset {
    pub id: String,
    pub name: String,
    pub original_path: String,
    pub library_path: Option<String>,
    pub storage_mode: String,
    pub kind: String,
    pub mime_type: String,
    pub size_bytes: Option<i64>,
    pub thumbnail_url: String,
    pub description: String,
    pub rating: Option<i64>,
    pub dominant_color: Option<String>,
    pub folder_id: Option<String>,
    pub imported_at: String,
    pub updated_at: String,
    pub content_hash: Option<String>,
}

/// Capture provenance is deliberately separate from the shared MaterialAsset
/// projection. Legacy assets have no row and therefore no claimed page URL.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialSourcePage {
    pub asset_id: String,
    pub page_url: String,
    pub page_kind: String,
    pub title: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MaterialSourcePageInput {
    pub page_url: String,
    pub page_kind: String,
    pub title: Option<String>,
}

impl MaterialSourcePageInput {
    pub(crate) fn from_parts(url: &str, kind: &str, title: Option<&str>) -> Option<Self> {
        let raw = url.trim();
        if raw.is_empty() || raw.len() > 2048 || raw.chars().any(char::is_control)
            || raw.contains('\\') || !matches!(kind, "work-page" | "capture-page") {
            return None;
        }
        let parsed = reqwest::Url::parse(raw).ok()?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none() || !parsed.username().is_empty()
            || parsed.password().is_some() {
            return None;
        }
        let path = parsed.path().to_ascii_lowercase();
        if [".avif", ".gif", ".jpg", ".jpeg", ".m3u8", ".mp4", ".mpd", ".png", ".webm", ".webp"]
            .iter().any(|suffix| path.ends_with(suffix)) {
            return None;
        }
        if parsed.query_pairs().any(|(key, _)| source_secret_key(&key))
            || parsed.fragment().is_some_and(source_fragment_has_secret) {
            return None;
        }
        let normalized = parsed.to_string();
        if normalized.len() > 2048 { return None; }
        let title = title
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 240
                && !value.chars().any(char::is_control))
            .map(str::to_owned);
        Some(Self { page_url: normalized, page_kind: kind.to_owned(), title })
    }
}

pub(super) fn source_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.starts_with("x-amz-") || matches!(key.as_str(),
        "access_token" | "api_key" | "apikey" | "auth" | "authorization"
            | "bearer" | "cookie" | "secret" | "sig" | "signature" | "token")
}

pub(super) fn source_fragment_has_secret(fragment: &str) -> bool {
    let mut decoded = fragment.to_owned();
    for _ in 0..2 {
        let Some(next) = decode_source_fragment(&decoded) else { return true; };
        decoded = next;
    }
    decoded.split(['?', '&', ';']).any(|part| {
        source_secret_key(part.split('=').next().unwrap_or_default())
    })
}

fn decode_source_fragment(fragment: &str) -> Option<String> {
    let bytes = fragment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() { return None; }
            let encoded = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            let value = u8::from_str_radix(encoded, 16).ok()?;
            decoded.push(value);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).ok()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialAssetSearchHit {
    pub asset: MaterialAsset,
    pub snippet: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialFolder {
    pub id: String,
    pub scope: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub sort_order: i64,
    pub open: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub children: Vec<MaterialFolder>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialTag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub asset_count: i64,
    pub note_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialChange {
    pub version: i64,
    pub reason: String,
    pub affected_ids: Vec<String>,
    pub folders_changed: bool,
    pub occurred_at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialAssetPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub rating: PatchValue<i64>,
    #[serde(default)]
    pub dominant_color: PatchValue<String>,
    pub original_path: Option<String>,
    #[serde(default)]
    pub library_path: PatchValue<String>,
    pub storage_mode: Option<String>,
    pub kind: Option<String>,
    pub mime_type: Option<String>,
    #[serde(default)]
    pub size_bytes: PatchValue<i64>,
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    pub folder_id: PatchValue<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub(crate) enum PatchValue<T> {
    Missing,
    Value(Option<T>),
}

impl<T> Default for PatchValue<T> {
    fn default() -> Self {
        Self::Missing
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for PatchValue<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<T>::deserialize(deserializer).map(Self::Value)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialFolderInput {
    pub parent_id: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialFolderMove {
    pub id: String,
    pub target_id: Option<String>,
    pub position: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialTagPatch {
    pub name: Option<String>,
    #[serde(default)]
    pub color: PatchValue<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialImportOptions {
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default = "default_storage_mode")]
    pub storage_mode: String,
    #[serde(default)]
    pub managed_library_dir: Option<String>,
    #[serde(default = "default_true")]
    pub preserve_folder_structure: bool,
    #[serde(default = "default_true")]
    pub recursive: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialRelocateOptions {
    #[serde(default)]
    pub allow_source_content_change: bool,
    #[serde(default)]
    pub expected_source_content_hash: Option<String>,
}

impl Default for MaterialImportOptions {
    fn default() -> Self {
        Self {
            folder_id: None,
            storage_mode: default_storage_mode(),
            managed_library_dir: None,
            preserve_folder_structure: true,
            recursive: true,
        }
    }
}

fn default_storage_mode() -> String {
    "managed".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialImportError {
    pub file: String,
    pub code: String,
    pub error: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct MaterialLibraryMigrationError {
    pub file: String,
    pub error: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub(crate) struct MaterialLibraryMigrationResult {
    pub moved_count: u32,
    pub skipped_count: u32,
    pub failed_count: u32,
    pub failed_items: Vec<MaterialLibraryMigrationError>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialImportResult {
    pub assets: Vec<MaterialAsset>,
    pub imported_count: u32,
    pub skipped_duplicate_count: u32,
    pub failed_count: u32,
    pub failed_items: Vec<MaterialImportError>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialBytesInput {
    pub name: String,
    pub original_path: String,
    pub mime_type: String,
    #[serde(default)]
    pub description: Option<String>,
    pub bytes: Vec<u8>,
}

/// An app-owned, fully downloaded file handed from the media-transfer service
/// to the catalog. This type is intentionally not serializable: callers over
/// LocalTransport refer to a transfer id and never supply a filesystem path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MaterialStagedFileInput {
    pub path: PathBuf,
    pub name: String,
    pub original_source: String,
    pub mime_type: String,
    pub description: Option<String>,
    pub expected_size_bytes: u64,
    pub expected_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MissingMaterialAsset {
    pub id: String,
    pub name: String,
    pub library_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoveMaterialResult {
    pub success: bool,
    pub file_still_exists: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialTagMergeResult {
    pub target_name: String,
    pub source_names: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MaterialNamedTag {
    pub name: String,
    pub color: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MaterialAssetTagNames {
    pub asset_id: String,
    pub tags: Vec<MaterialNamedTag>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CatalogOutcome<T> {
    pub value: T,
    pub change: Option<MaterialChange>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialDeleteResult {
    pub success: bool,
    pub cleanup_pending: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingDeletionCleanupResult {
    pub cleaned: u32,
    pub pending: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl std::fmt::Display for MaterialError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for MaterialError {}

pub(crate) type MaterialResult<T> = Result<T, MaterialError>;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialQueryScope {
    #[serde(default)] pub scope: String,
    pub vault_id: Option<String>,
    #[serde(default)] pub include_unreferenced: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteAttachmentRefInput { pub asset_id: String, pub target: String }
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteAttachmentReference { pub vault_id: String, pub note_path: String, pub target: String, pub absolute_path: String }
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteAttachmentDetails {
    pub asset_id: String, pub ordinary: bool, pub absolute_path: Option<String>,
    pub reference_count: usize, pub references: Vec<NoteAttachmentReference>,
}

#[derive(Clone,Debug,Serialize,Deserialize,PartialEq)]
#[serde(rename_all="camelCase")]
pub(crate) struct NoteAttachmentMoveCandidate {
    pub asset_id:String,
    pub previous_path:String,
    pub new_path:String,
}
