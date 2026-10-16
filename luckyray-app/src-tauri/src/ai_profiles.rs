use crate::backend::BackendServices;
use futures_util::StreamExt;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

const CATALOG_VERSION: u32 = 1;
const MAX_PROFILES: usize = 32;
const PROFILE_SECRET_PREFIX: &str = "aiProfileApiKey.";
const ACTIVE_PROFILE_KEY: &str = "aiActiveProfileId";
const MAX_DISCOVERED_MODELS: usize = 256;
const MAX_MODEL_RESPONSE_BYTES: usize = 512 * 1024;

fn default_protocol() -> String {
    "openai-compatible".to_owned()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProfile {
    id: String,
    name: String,
    provider: String,
    #[serde(default = "default_protocol")]
    protocol: String,
    base_url: String,
    model: String,
    #[serde(default)]
    available_models: Vec<String>,
    temperature: f64,
    max_output_tokens: u32,
    context_window_tokens: u32,
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    model_capabilities: Vec<StoredModelCapability>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredModelCapability {
    id: String,
    input: Vec<String>,
    input_state: String,
    tool_calls: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCatalog {
    version: u32,
    active_profile_id: String,
    profiles: Vec<StoredProfile>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AiModelProfileInput {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) provider: String,
    #[serde(default = "default_protocol")]
    pub(crate) protocol: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) available_models: Vec<String>,
    pub(crate) temperature: f64,
    pub(crate) max_output_tokens: u32,
    pub(crate) context_window_tokens: u32,
    pub(crate) enabled: bool,
    #[serde(default)]
    pub(crate) api_key: Option<String>,
    #[serde(default)]
    pub(crate) clear_api_key: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiModelProfileView {
    id: String,
    name: String,
    provider: String,
    protocol: String,
    base_url: String,
    model: String,
    available_models: Vec<String>,
    temperature: f64,
    max_output_tokens: u32,
    context_window_tokens: u32,
    enabled: bool,
    api_key_configured: bool,
    agent_compatible: bool,
    source_identity: Option<String>,
    source_provider: Option<String>,
    model_capabilities: Vec<StoredModelCapability>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiModelProfilesSnapshot {
    version: u32,
    active_profile_id: String,
    profiles: Vec<AiModelProfileView>,
}

#[derive(Clone, Debug)]
pub(crate) struct LightSeekModelImport {
    pub(crate) id: String,
    pub(crate) input: Vec<String>,
    pub(crate) input_state: String,
    pub(crate) tool_calls: String,
    pub(crate) max_output_tokens: Option<u32>,
    pub(crate) context_window_tokens: Option<u32>,
}

#[derive(Clone, Debug)]
pub(crate) struct LightSeekProfileImport {
    pub(crate) source_identity: String,
    pub(crate) source_provider: String,
    pub(crate) display_name: String,
    pub(crate) protocol: String,
    pub(crate) base_url: String,
    pub(crate) models: Vec<LightSeekModelImport>,
    pub(crate) api_key: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LightSeekImportedProfileView {
    pub(crate) source_identity: String,
    pub(crate) profile_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LightSeekBatchSyncResult {
    pub(crate) snapshot: AiModelProfilesSnapshot,
    pub(crate) imports: Vec<LightSeekImportedProfileView>,
}

pub(crate) fn list(backend: &BackendServices) -> Result<AiModelProfilesSnapshot, &'static str> {
    let catalog = load_or_migrate(backend)?;
    project_snapshot(backend.db_path(), catalog)
}

pub(crate) fn upsert(
    backend: &BackendServices,
    input: AiModelProfileInput,
) -> Result<AiModelProfilesSnapshot, &'static str> {
    if input.id == "lightseek-sync" || input.id.starts_with("lightseek-") {
        return Err("ai-model-profile-reserved");
    }
    let mut catalog = load_or_migrate(backend)?;
    let profile = validate_profile(StoredProfile {
        id: input.id,
        name: input.name,
        provider: input.provider,
        protocol: input.protocol,
        base_url: input.base_url,
        model: input.model,
        available_models: input.available_models,
        temperature: input.temperature,
        max_output_tokens: input.max_output_tokens,
        context_window_tokens: input.context_window_tokens,
        enabled: input.enabled,
        source_identity: None,
        source_provider: None,
        model_capabilities: Vec::new(),
    })?;
    let existing = catalog
        .profiles
        .iter()
        .position(|item| item.id == profile.id);
    if existing.is_none() && catalog.profiles.len() >= MAX_PROFILES {
        return Err("ai-model-profile-capacity");
    }
    if let Some(index) = existing {
        let old_origin = reqwest::Url::parse(&catalog.profiles[index].base_url).map_err(|_| "ai-model-profile-invalid")?.origin();
        let new_origin = reqwest::Url::parse(&profile.base_url).map_err(|_| "ai-model-profile-invalid")?.origin();
        if old_origin != new_origin && !input.clear_api_key
            && !input.api_key.as_deref().is_some_and(|value| !value.trim().is_empty())
            && secret_configured(backend.db_path(), &profile.id)? {
            return Err("ai-model-profile-origin-key-required");
        }
        catalog.profiles[index] = profile.clone();
    } else {
        catalog.profiles.push(profile.clone());
    }
    if catalog.active_profile_id.is_empty() {
        catalog.active_profile_id = profile.id.clone();
    }
    update_secret(
        backend.db_path(),
        &profile.id,
        input.api_key.as_deref(),
        input.clear_api_key,
    )?;
    if catalog.active_profile_id == profile.id {
        apply_active_profile(backend.db_path(), &profile)?;
    }
    write_catalog(&catalog_path(backend.app_data_dir()), &catalog)?;
    project_snapshot(backend.db_path(), catalog)
}

pub(crate) fn activate(
    backend: &BackendServices,
    profile_id: &str,
) -> Result<AiModelProfilesSnapshot, &'static str> {
    let mut catalog = load_or_migrate(backend)?;
    let profile = catalog
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id && profile.enabled)
        .cloned()
        .ok_or("ai-model-profile-unavailable")?;
    if profile.provider != "ollama" && !secret_configured(backend.db_path(), &profile.id)? {
        return Err("ai-model-profile-key-required");
    }
    apply_active_profile(backend.db_path(), &profile)?;
    catalog.active_profile_id = profile.id.clone();
    write_catalog(&catalog_path(backend.app_data_dir()), &catalog)?;
    project_snapshot(backend.db_path(), catalog)
}

fn lightseek_profile_id(source_identity: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(source_identity.as_bytes()));
    format!("lightseek-{}", &digest[..24])
}

fn validate_lightseek_models(
    models: Vec<LightSeekModelImport>,
) -> Result<(Vec<String>, Vec<StoredModelCapability>, u32, u32), &'static str> {
    if models.is_empty() || models.len() > MAX_DISCOVERED_MODELS {
        return Err("lightseek-model-sync-invalid");
    }
    let mut ids = Vec::with_capacity(models.len());
    let mut capabilities = Vec::with_capacity(models.len());
    for model in &models {
        let id = model.id.trim().to_owned();
        if invalid_text(&id, 128) || ids.contains(&id) {
            return Err("lightseek-model-sync-invalid");
        }
        let mut input = Vec::new();
        for modality in &model.input {
            if !matches!(modality.as_str(), "text" | "image") || input.contains(modality) {
                return Err("lightseek-model-sync-invalid");
            }
            input.push(modality.clone());
        }
        if !matches!(model.input_state.as_str(), "declared" | "unknown")
            || model.input_state == "unknown" && !input.is_empty()
            || !matches!(
                model.tool_calls.as_str(),
                "supported" | "unsupported" | "unknown"
            )
        {
            return Err("lightseek-model-sync-invalid");
        }
        ids.push(id.clone());
        capabilities.push(StoredModelCapability {
            id,
            input,
            input_state: model.input_state.clone(),
            tool_calls: model.tool_calls.clone(),
        });
    }
    let selected = &models[0];
    Ok((
        ids,
        capabilities,
        selected
            .max_output_tokens
            .unwrap_or(32_768)
            .clamp(64, 32_768),
        selected
            .context_window_tokens
            .unwrap_or(128_000)
            .clamp(1_024, 2_000_000),
    ))
}

pub(crate) fn sync_from_lightseek_batch(
    backend: &BackendServices,
    inputs: Vec<LightSeekProfileImport>,
    default_source_identity: Option<&str>,
) -> Result<LightSeekBatchSyncResult, &'static str> {
    if inputs.len() > MAX_PROFILES {
        return Err("lightseek-model-sync-invalid");
    }
    let mut catalog = load_or_migrate(backend)?;
    let mut imported_sources = Vec::with_capacity(inputs.len());
    let mut imports = Vec::with_capacity(inputs.len());
    let mut prepared = Vec::with_capacity(inputs.len());
    let legacy_id = catalog
        .profiles
        .iter()
        .find(|profile| profile.id == "lightseek-sync" && profile.source_identity.is_none())
        .map(|profile| profile.id.clone());
    let mut legacy_used = false;

    for input in inputs {
        let source_identity = input.source_identity.trim().to_owned();
        let source_provider = input.source_provider.trim().to_owned();
        let display_name = input.display_name.trim().to_owned();
        let api_key = input.api_key.trim().to_owned();
        if invalid_text(&source_identity, 256)
            || invalid_text(&source_provider, 128)
            || invalid_text(&display_name, 256)
            || api_key.is_empty()
            || api_key.len() > 8192
            || api_key.chars().any(char::is_control)
            || imported_sources.contains(&source_identity)
        {
            return Err("lightseek-model-sync-invalid");
        }
        let (available_models, model_capabilities, max_output_tokens, context_window_tokens) =
            validate_lightseek_models(input.models)?;
        let model = available_models[0].clone();
        let existing_id = catalog
            .profiles
            .iter()
            .find(|profile| profile.source_identity.as_deref() == Some(&source_identity))
            .map(|profile| profile.id.clone());
        let profile_id = if let Some(id) = existing_id {
            id
        } else if !legacy_used
            && default_source_identity == Some(source_identity.as_str())
            && legacy_id.is_some()
        {
            legacy_used = true;
            legacy_id.clone().expect("checked legacy id")
        } else {
            lightseek_profile_id(&source_identity)
        };
        let profile = validate_profile(StoredProfile {
            id: profile_id,
            name: format!("LightSeek · {display_name}"),
            provider: "custom".to_owned(),
            protocol: input.protocol,
            base_url: input.base_url,
            model,
            available_models,
            temperature: 0.7,
            max_output_tokens,
            context_window_tokens,
            enabled: true,
            source_identity: Some(source_identity.clone()),
            source_provider: Some(source_provider),
            model_capabilities,
        })?;
        if let Some(index) = catalog
            .profiles
            .iter()
            .position(|candidate| candidate.id == profile.id)
        {
            let existing_source = catalog.profiles[index].source_identity.as_deref();
            if existing_source != Some(source_identity.as_str())
                && !(profile.id == "lightseek-sync" && existing_source.is_none())
            {
                return Err("lightseek-model-sync-conflict");
            }
        } else if catalog.profiles.len() + prepared.len() >= MAX_PROFILES {
            return Err("ai-model-profile-capacity");
        }
        imported_sources.push(source_identity.clone());
        imports.push(LightSeekImportedProfileView {
            source_identity,
            profile_id: profile.id.clone(),
        });
        prepared.push((profile, api_key));
    }

    // All descriptors are validated before either the profile catalog or the
    // existing backend secret owner is mutated. A malformed later descriptor
    // therefore cannot leave a partially imported batch.
    for (profile, _) in &prepared {
        if let Some(index) = catalog
            .profiles
            .iter()
            .position(|candidate| candidate.id == profile.id)
        {
            catalog.profiles[index] = profile.clone();
        } else {
            catalog.profiles.push(profile.clone());
        }
    }
    for (profile, api_key) in &prepared {
        update_secret(backend.db_path(), &profile.id, Some(api_key), false)?;
    }

    for profile in &mut catalog.profiles {
        if profile.source_identity.is_some()
            && !imported_sources
                .iter()
                .any(|source| profile.source_identity.as_deref() == Some(source.as_str()))
        {
            profile.enabled = false;
        }
    }
    if let Some(default_source) = default_source_identity {
        if let Some(profile) = catalog
            .profiles
            .iter()
            .find(|profile| {
                profile.source_identity.as_deref() == Some(default_source) && profile.enabled
            })
            .cloned()
        {
            apply_active_profile(backend.db_path(), &profile)?;
            catalog.active_profile_id = profile.id;
        }
    }
    if !catalog
        .profiles
        .iter()
        .any(|profile| profile.id == catalog.active_profile_id && profile.enabled)
    {
        let replacement = catalog
            .profiles
            .iter()
            .find(|profile| {
                profile.enabled
                    && secret_configured(backend.db_path(), &profile.id).unwrap_or(false)
            })
            .cloned()
            .ok_or("ai-model-profile-key-required")?;
        apply_active_profile(backend.db_path(), &replacement)?;
        catalog.active_profile_id = replacement.id;
    }
    write_catalog(&catalog_path(backend.app_data_dir()), &catalog)?;
    Ok(LightSeekBatchSyncResult {
        snapshot: project_snapshot(backend.db_path(), catalog)?,
        imports,
    })
}

pub(crate) fn select_model(
    backend: &BackendServices,
    profile_id: &str,
    model: &str,
) -> Result<AiModelProfilesSnapshot, &'static str> {
    let mut catalog = load_or_migrate(backend)?;
    let profile = catalog
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id && profile.enabled)
        .ok_or("ai-model-profile-unavailable")?;
    let model = model.trim();
    if invalid_text(model, 128) || !profile.available_models.iter().any(|item| item == model) {
        return Err("ai-model-profile-model-unavailable");
    }
    if profile.provider != "ollama" && !secret_configured(backend.db_path(), profile_id)? {
        return Err("ai-model-profile-key-required");
    }
    profile.model = model.to_owned();
    let selected = profile.clone();
    catalog.active_profile_id = profile_id.to_owned();
    apply_active_profile(backend.db_path(), &selected)?;
    write_catalog(&catalog_path(backend.app_data_dir()), &catalog)?;
    project_snapshot(backend.db_path(), catalog)
}

pub(crate) async fn test_connection(
    backend: &BackendServices,
    profile_id: &str,
) -> Result<AiModelProfilesSnapshot, &'static str> {
    let mut catalog = load_or_migrate(backend)?;
    let index = catalog
        .profiles
        .iter()
        .position(|profile| profile.id == profile_id && profile.enabled)
        .ok_or("ai-model-profile-unavailable")?;
    let api_key = read_secret(backend.db_path(), profile_id)?;
    if api_key.is_empty() && catalog.profiles[index].provider != "ollama" {
        return Err("ai-model-profile-key-required");
    }
    let models = discover_models(&catalog.profiles[index], &api_key).await?;
    if models.is_empty() {
        return Err("ai-model-profile-model-list-empty");
    }
    catalog.profiles[index].available_models = models;
    if !catalog.profiles[index]
        .available_models
        .contains(&catalog.profiles[index].model)
    {
        catalog.profiles[index].model = catalog.profiles[index].available_models[0].clone();
    }
    if catalog.active_profile_id == profile_id {
        apply_active_profile(backend.db_path(), &catalog.profiles[index])?;
    }
    write_catalog(&catalog_path(backend.app_data_dir()), &catalog)?;
    project_snapshot(backend.db_path(), catalog)
}

pub(crate) fn remove(
    backend: &BackendServices,
    profile_id: &str,
) -> Result<AiModelProfilesSnapshot, &'static str> {
    let mut catalog = load_or_migrate(backend)?;
    if catalog.profiles.len() <= 1 {
        return Err("ai-model-profile-last-profile");
    }
    let old_len = catalog.profiles.len();
    catalog.profiles.retain(|profile| profile.id != profile_id);
    if catalog.profiles.len() == old_len {
        return Err("ai-model-profile-not-found");
    }
    delete_secret(backend.db_path(), profile_id)?;
    if catalog.active_profile_id == profile_id {
        let replacement = catalog
            .profiles
            .iter()
            .find(|profile| {
                profile.enabled
                    && secret_configured(backend.db_path(), &profile.id).unwrap_or(false)
            })
            .cloned()
            .ok_or("ai-model-profile-key-required")?;
        apply_active_profile(backend.db_path(), &replacement)?;
        catalog.active_profile_id = replacement.id;
    }
    write_catalog(&catalog_path(backend.app_data_dir()), &catalog)?;
    project_snapshot(backend.db_path(), catalog)
}

fn catalog_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("ai").join("model-profiles.json")
}

fn load_or_migrate(backend: &BackendServices) -> Result<StoredCatalog, &'static str> {
    let path = catalog_path(backend.app_data_dir());
    if path.exists() {
        let bytes = std::fs::read(&path).map_err(|_| "ai-model-profiles-unavailable")?;
        if bytes.len() > 256 * 1024 {
            return Err("ai-model-profiles-invalid");
        }
        let catalog: StoredCatalog =
            serde_json::from_slice(&bytes).map_err(|_| "ai-model-profiles-invalid")?;
        return validate_catalog(catalog);
    }
    let catalog = migrate_legacy_settings(backend.db_path())?;
    write_catalog(&path, &catalog)?;
    Ok(catalog)
}

fn migrate_legacy_settings(db_path: &Path) -> Result<StoredCatalog, &'static str> {
    let connection = Connection::open(db_path).map_err(|_| "ai-model-profiles-unavailable")?;
    let read = |key: &str| -> Option<String> {
        connection
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .ok()
    };
    let provider = read("aiProvider")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "deepseek".to_owned());
    let model = read("aiModel")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "deepseek-chat".to_owned());
    let base_url = read("aiBaseURL")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_base_url(&provider).to_owned());
    let temperature = read("temperature")
        .or_else(|| read("aiTemperature"))
        .and_then(|value| value.parse().ok())
        .unwrap_or(0.7);
    let max_output_tokens = read("maxTokens")
        .or_else(|| read("aiMaxTokens"))
        .and_then(|value| value.parse().ok())
        .unwrap_or(2048);
    let profile = validate_profile(StoredProfile {
        id: "default".to_owned(),
        name: format!("{} · {}", provider_label(&provider), model),
        provider,
        protocol: read("aiProtocol").unwrap_or_else(default_protocol),
        base_url,
        model,
        available_models: Vec::new(),
        temperature,
        max_output_tokens,
        context_window_tokens: 128_000,
        enabled: true,
        source_identity: None,
        source_provider: None,
        model_capabilities: Vec::new(),
    })?;
    if let Some(key) = read("aiApiKey").filter(|value| !value.trim().is_empty()) {
        write_setting(&connection, &secret_key(&profile.id), &key)?;
    }
    write_setting(&connection, ACTIVE_PROFILE_KEY, &profile.id)?;
    Ok(StoredCatalog {
        version: CATALOG_VERSION,
        active_profile_id: profile.id.clone(),
        profiles: vec![profile],
    })
}

fn validate_catalog(mut catalog: StoredCatalog) -> Result<StoredCatalog, &'static str> {
    if catalog.version != CATALOG_VERSION
        || catalog.profiles.is_empty()
        || catalog.profiles.len() > MAX_PROFILES
    {
        return Err("ai-model-profiles-invalid");
    }
    let mut validated = Vec::with_capacity(catalog.profiles.len());
    for profile in catalog.profiles {
        let profile = validate_profile(profile)?;
        if validated
            .iter()
            .any(|item: &StoredProfile| item.id == profile.id)
        {
            return Err("ai-model-profiles-invalid");
        }
        validated.push(profile);
    }
    if !validated
        .iter()
        .any(|profile| profile.id == catalog.active_profile_id)
    {
        return Err("ai-model-profiles-invalid");
    }
    catalog.profiles = validated;
    Ok(catalog)
}

fn validate_profile(mut profile: StoredProfile) -> Result<StoredProfile, &'static str> {
    profile.id = profile.id.trim().to_ascii_lowercase();
    profile.name = profile.name.trim().to_owned();
    profile.provider = profile.provider.trim().to_ascii_lowercase();
    profile.protocol = profile.protocol.trim().to_ascii_lowercase();
    profile.base_url = profile.base_url.trim().trim_end_matches('/').to_owned();
    profile.model = profile.model.trim().to_owned();
    profile.available_models = validate_models(profile.available_models)?;
    if let Some(source) = profile.source_identity.as_mut() {
        *source = source.trim().to_owned();
    }
    if let Some(provider) = profile.source_provider.as_mut() {
        *provider = provider.trim().to_owned();
    }
    if !profile
        .available_models
        .iter()
        .any(|model| model == &profile.model)
    {
        profile.available_models.insert(0, profile.model.clone());
        profile.available_models.truncate(MAX_DISCOVERED_MODELS);
    }
    let mut capability_ids = Vec::with_capacity(profile.model_capabilities.len());
    let duplicate_capability = profile.model_capabilities.iter().any(|capability| {
        if capability_ids.contains(&capability.id) {
            true
        } else {
            capability_ids.push(capability.id.clone());
            false
        }
    });
    if profile.id.is_empty()
        || profile.id.len() > 64
        || !profile.id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
        || invalid_text(&profile.name, 80)
        || invalid_text(&profile.model, 128)
        || !matches!(
            profile.provider.as_str(),
            "deepseek" | "openai" | "anthropic" | "minimax" | "ollama" | "custom" | "twelveai" | "gemini" | "zhipu" | "qwen"
        )
        || !matches!(
            profile.protocol.as_str(),
            "openai-compatible" | "anthropic-messages"
        )
        || !profile.temperature.is_finite()
        || !(0.0..=2.0).contains(&profile.temperature)
        || !(64..=32_768).contains(&profile.max_output_tokens)
        || !(1_024..=2_000_000).contains(&profile.context_window_tokens)
        || !valid_base_url(&profile.provider, &profile.base_url)
        || profile
            .source_identity
            .as_deref()
            .is_some_and(|source| invalid_text(source, 256))
        || profile
            .source_provider
            .as_deref()
            .is_some_and(|provider| invalid_text(provider, 128))
        || profile.source_identity.is_some() != profile.source_provider.is_some()
        || profile.source_identity.is_some() && !profile.id.starts_with("lightseek-")
        || duplicate_capability
        || profile.model_capabilities.iter().any(|capability| {
            invalid_text(&capability.id, 128)
                || !profile.available_models.contains(&capability.id)
                || !matches!(capability.input_state.as_str(), "declared" | "unknown")
                || capability.input_state == "unknown" && !capability.input.is_empty()
                || capability
                    .input
                    .iter()
                    .any(|item| !matches!(item.as_str(), "text" | "image"))
                || !matches!(
                    capability.tool_calls.as_str(),
                    "supported" | "unsupported" | "unknown"
                )
        })
    {
        return Err("ai-model-profile-invalid");
    }
    Ok(profile)
}

fn invalid_text(value: &str, max: usize) -> bool {
    value.is_empty() || value.len() > max || value.chars().any(char::is_control)
}

fn validate_models(models: Vec<String>) -> Result<Vec<String>, &'static str> {
    let mut validated = Vec::new();
    for model in models {
        let model = model.trim().to_owned();
        if invalid_text(&model, 128) {
            return Err("ai-model-profile-invalid");
        }
        if !validated.contains(&model) {
            if validated.len() >= MAX_DISCOVERED_MODELS {
                return Err("ai-model-profile-invalid");
            }
            validated.push(model);
        }
    }
    Ok(validated)
}

fn valid_base_url(_provider: &str, raw: &str) -> bool {
    if raw.len() > 2048
        || raw
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || raw.contains('\\')
    {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    if url.scheme() == "https" {
        return true;
    }
    url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "::1" | "localhost"))
}

fn project_snapshot(
    db_path: &Path,
    catalog: StoredCatalog,
) -> Result<AiModelProfilesSnapshot, &'static str> {
    let mut profiles = Vec::with_capacity(catalog.profiles.len());
    for profile in catalog.profiles {
        profiles.push(AiModelProfileView {
            api_key_configured: profile.provider == "ollama"
                || secret_configured(db_path, &profile.id)?,
            agent_compatible: matches!(
                profile.protocol.as_str(),
                "openai-compatible" | "anthropic-messages"
            ),
            source_identity: profile.source_identity.clone(),
            source_provider: profile.source_provider.clone(),
            model_capabilities: profile.model_capabilities.clone(),
            id: profile.id,
            name: profile.name,
            provider: profile.provider,
            protocol: profile.protocol,
            base_url: profile.base_url,
            model: profile.model,
            available_models: profile.available_models,
            temperature: profile.temperature,
            max_output_tokens: profile.max_output_tokens,
            context_window_tokens: profile.context_window_tokens,
            enabled: profile.enabled,
        });
    }
    Ok(AiModelProfilesSnapshot {
        version: CATALOG_VERSION,
        active_profile_id: catalog.active_profile_id,
        profiles,
    })
}

fn update_secret(
    db_path: &Path,
    profile_id: &str,
    api_key: Option<&str>,
    clear: bool,
) -> Result<(), &'static str> {
    if clear && api_key.is_some() {
        return Err("ai-model-profile-invalid");
    }
    let connection = Connection::open(db_path).map_err(|_| "ai-model-profiles-unavailable")?;
    if clear {
        connection
            .execute(
                "DELETE FROM settings WHERE key = ?1",
                params![secret_key(profile_id)],
            )
            .map_err(|_| "ai-model-profiles-unavailable")?;
    } else if let Some(value) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        if value.len() > 8192 || value.chars().any(char::is_control) {
            return Err("ai-model-profile-invalid");
        }
        write_setting(&connection, &secret_key(profile_id), value)?;
    }
    Ok(())
}

fn delete_secret(db_path: &Path, profile_id: &str) -> Result<(), &'static str> {
    let connection = Connection::open(db_path).map_err(|_| "ai-model-profiles-unavailable")?;
    connection
        .execute(
            "DELETE FROM settings WHERE key = ?1",
            params![secret_key(profile_id)],
        )
        .map_err(|_| "ai-model-profiles-unavailable")?;
    Ok(())
}

fn secret_configured(db_path: &Path, profile_id: &str) -> Result<bool, &'static str> {
    let connection = Connection::open(db_path).map_err(|_| "ai-model-profiles-unavailable")?;
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![secret_key(profile_id)],
            |row| row.get(0),
        )
        .ok();
    Ok(value.is_some_and(|value| !value.trim().is_empty()))
}

fn read_secret(db_path: &Path, profile_id: &str) -> Result<String, &'static str> {
    let connection = Connection::open(db_path).map_err(|_| "ai-model-profiles-unavailable")?;
    let value = connection
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![secret_key(profile_id)],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();
    let value = value.trim().to_owned();
    if value.len() > 8192 || value.chars().any(char::is_control) {
        return Err("ai-model-profile-invalid");
    }
    Ok(value)
}

fn models_endpoint(profile: &StoredProfile) -> Result<String, &'static str> {
    let mut base = profile.base_url.trim_end_matches('/').to_owned();
    let lower = base.to_ascii_lowercase();
    for suffix in ["/chat/completions", "/messages", "/models"] {
        if lower.ends_with(suffix) {
            base.truncate(base.len() - suffix.len());
            break;
        }
    }
    let lower = base.to_ascii_lowercase();
    if profile.protocol == "anthropic-messages" {
        if lower.ends_with("/v1") {
            Ok(format!("{base}/models"))
        } else {
            Ok(format!("{base}/v1/models"))
        }
    } else if profile.provider == "deepseek" && lower == "https://api.deepseek.com" {
        Ok("https://api.deepseek.com/models".to_owned())
    } else if lower.ends_with("/v1") || lower.ends_with("/v2") {
        Ok(format!("{base}/models"))
    } else {
        Ok(format!("{base}/models"))
    }
}

async fn discover_models(
    profile: &StoredProfile,
    api_key: &str,
) -> Result<Vec<String>, &'static str> {
    let endpoint = models_endpoint(profile)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "ai-model-profile-connection")?;
    let mut request = client.get(endpoint);
    if profile.protocol == "anthropic-messages" {
        request = request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01");
    } else if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "ai-model-profile-timeout"
        } else {
            "ai-model-profile-connection"
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "ai-model-profile-unauthorized",
            429 => "ai-model-profile-rate-limited",
            _ => "ai-model-profile-provider-error",
        });
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_MODEL_RESPONSE_BYTES as u64)
    {
        return Err("ai-model-profile-invalid-response");
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "ai-model-profile-invalid-response")?;
        let projected = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or("ai-model-profile-invalid-response")?;
        if projected > MAX_MODEL_RESPONSE_BYTES {
            return Err("ai-model-profile-invalid-response");
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "ai-model-profile-invalid-response")?;
    let rows = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or("ai-model-profile-invalid-response")?;
    let models = rows
        .iter()
        .filter_map(|row| row.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_owned)
        .collect();
    validate_models(models).map_err(|_| "ai-model-profile-invalid-response")
}

fn apply_active_profile(db_path: &Path, profile: &StoredProfile) -> Result<(), &'static str> {
    let connection = Connection::open(db_path).map_err(|_| "ai-model-profiles-unavailable")?;
    let api_key: String = connection
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![secret_key(&profile.id)],
            |row| row.get(0),
        )
        .unwrap_or_default();
    let transaction = connection
        .unchecked_transaction()
        .map_err(|_| "ai-model-profiles-unavailable")?;
    for (key, value) in [
        ("aiProvider", profile.provider.clone()),
        ("aiProtocol", profile.protocol.clone()),
        ("aiApiKey", api_key),
        ("aiBaseURL", profile.base_url.clone()),
        ("aiModel", profile.model.clone()),
        ("aiTemperature", profile.temperature.to_string()),
        ("temperature", profile.temperature.to_string()),
        ("aiMaxTokens", profile.max_output_tokens.to_string()),
        ("maxTokens", profile.max_output_tokens.to_string()),
        (ACTIVE_PROFILE_KEY, profile.id.clone()),
    ] {
        transaction.execute("INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value]).map_err(|_| "ai-model-profiles-unavailable")?;
    }
    transaction
        .commit()
        .map_err(|_| "ai-model-profiles-unavailable")
}

fn write_setting(connection: &Connection, key: &str, value: &str) -> Result<(), &'static str> {
    connection.execute("INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value]).map_err(|_| "ai-model-profiles-unavailable")?;
    Ok(())
}

fn secret_key(profile_id: &str) -> String {
    format!("{PROFILE_SECRET_PREFIX}{profile_id}")
}

fn write_catalog(path: &Path, catalog: &StoredCatalog) -> Result<(), &'static str> {
    let parent = path.parent().ok_or("ai-model-profiles-unavailable")?;
    std::fs::create_dir_all(parent).map_err(|_| "ai-model-profiles-unavailable")?;
    let bytes = serde_json::to_vec_pretty(catalog).map_err(|_| "ai-model-profiles-invalid")?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, bytes).map_err(|_| "ai-model-profiles-unavailable")?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|_| "ai-model-profiles-unavailable")?;
    }
    std::fs::rename(temp, path).map_err(|_| "ai-model-profiles-unavailable")
}

fn provider_label(provider: &str) -> &'static str {
    match provider {
        "deepseek" => "DeepSeek",
        "openai" => "OpenAI",
        "anthropic" => "Anthropic",
        "minimax" => "MiniMax",
        "ollama" => "Ollama",
        _ => "自定义",
    }
}

fn default_base_url(provider: &str) -> &'static str {
    match provider {
        "deepseek" => "https://api.deepseek.com",
        "openai" => "https://api.openai.com/v1",
        "anthropic" => "https://api.anthropic.com",
        "minimax" => "https://api.minimax.io/v1",
        "ollama" => "http://localhost:11434",
        _ => "https://api.example.com/v1",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn backend(label: &str) -> BackendServices {
        let root = std::env::temp_dir().join(format!(
            "luckyray-ai-profiles-{label}-{}",
            rand::random::<u64>()
        ));
        BackendServices::initialize(&root).unwrap()
    }

    #[test]
    fn migrates_the_legacy_single_model_without_projecting_the_key() {
        let backend = backend("migration");
        let connection = Connection::open(backend.db_path()).unwrap();
        write_setting(&connection, "aiProvider", "minimax").unwrap();
        write_setting(&connection, "aiModel", "MiniMax-M3").unwrap();
        write_setting(&connection, "aiBaseURL", "https://api.minimax.io/v1").unwrap();
        write_setting(&connection, "aiApiKey", "PRIVATE-MIGRATION-KEY").unwrap();

        let snapshot = list(&backend).unwrap();
        assert_eq!(snapshot.active_profile_id, "default");
        assert_eq!(snapshot.profiles.len(), 1);
        assert!(snapshot.profiles[0].api_key_configured);
        let public = serde_json::to_string(&snapshot).unwrap();
        assert!(!public.contains("PRIVATE-MIGRATION-KEY"));
        let file = std::fs::read_to_string(catalog_path(backend.app_data_dir())).unwrap();
        assert!(!file.contains("PRIVATE-MIGRATION-KEY"));
    }

    #[test]
    fn activating_a_profile_mirrors_its_server_owned_secret_to_the_existing_runtime_settings() {
        let backend = backend("activation");
        let _ = list(&backend).unwrap();
        let snapshot = upsert(
            &backend,
            AiModelProfileInput {
                id: "custom-main".to_owned(),
                name: "自定义主力".to_owned(),
                provider: "custom".to_owned(),
                protocol: "openai-compatible".to_owned(),
                base_url: "https://models.example.test/v1".to_owned(),
                model: "custom-1".to_owned(),
                available_models: vec!["custom-1".to_owned(), "custom-2".to_owned()],
                temperature: 0.3,
                max_output_tokens: 4096,
                context_window_tokens: 128_000,
                enabled: true,
                api_key: Some("PRIVATE-CUSTOM-KEY".to_owned()),
                clear_api_key: false,
            },
        )
        .unwrap();
        assert!(snapshot
            .profiles
            .iter()
            .any(|profile| profile.id == "custom-main"));
        let activated = activate(&backend, "custom-main").unwrap();
        assert_eq!(activated.active_profile_id, "custom-main");
        let config = crate::load_ai_model_config(backend.db_path()).unwrap();
        assert_eq!(config.provider, "custom");
        assert_eq!(config.model, "custom-1");
        assert_eq!(config.api_key, "PRIVATE-CUSTOM-KEY");
    }

    #[test]
    fn lightseek_batch_sync_is_provider_neutral_idempotent_and_preserves_manual_profiles() {
        let backend = backend("lightseek-batch-sync");
        let _ = list(&backend).unwrap();
        upsert(
            &backend,
            AiModelProfileInput {
                id: "manual-profile".to_owned(),
                name: "用户手工连接".to_owned(),
                provider: "custom".to_owned(),
                protocol: "openai-compatible".to_owned(),
                base_url: "https://manual.example.test/v1".to_owned(),
                model: "manual-model".to_owned(),
                available_models: vec!["manual-model".to_owned()],
                temperature: 0.7,
                max_output_tokens: 4096,
                context_window_tokens: 128_000,
                enabled: true,
                api_key: Some("PRIVATE-MANUAL-KEY".to_owned()),
                clear_api_key: false,
            },
        )
        .unwrap();
        let first = sync_from_lightseek_batch(
            &backend,
            vec![
                LightSeekProfileImport {
                    source_identity: "dsh:llm-deepseek:deepseek-official:default".to_owned(),
                    source_provider: "deepseek-official".to_owned(),
                    display_name: "DeepSeek".to_owned(),
                    protocol: "openai-compatible".to_owned(),
                    base_url: "https://api.deepseek.com".to_owned(),
                    models: vec![LightSeekModelImport {
                        id: "deep-model".to_owned(),
                        input: vec!["text".to_owned()],
                        input_state: "declared".to_owned(),
                        tool_calls: "unknown".to_owned(),
                        max_output_tokens: Some(8192),
                        context_window_tokens: Some(128_000),
                    }],
                    api_key: "PRIVATE-DEEP-KEY".to_owned(),
                },
                LightSeekProfileImport {
                    source_identity: "dsh:llm-pi-ai:custom-route:custom-route".to_owned(),
                    source_provider: "custom-route".to_owned(),
                    display_name: "Custom route".to_owned(),
                    protocol: "anthropic-messages".to_owned(),
                    base_url: "https://custom.example.test/anthropic".to_owned(),
                    models: vec![
                        LightSeekModelImport {
                            id: "custom-vision".to_owned(),
                            input: vec!["text".to_owned(), "image".to_owned()],
                            input_state: "declared".to_owned(),
                            tool_calls: "unknown".to_owned(),
                            max_output_tokens: Some(16_384),
                            context_window_tokens: Some(256_000),
                        },
                        LightSeekModelImport {
                            id: "custom-unknown".to_owned(),
                            input: Vec::new(),
                            input_state: "unknown".to_owned(),
                            tool_calls: "unknown".to_owned(),
                            max_output_tokens: None,
                            context_window_tokens: None,
                        },
                    ],
                    api_key: "PRIVATE-CUSTOM-KEY".to_owned(),
                },
            ],
            Some("dsh:llm-pi-ai:custom-route:custom-route"),
        )
        .unwrap();
        assert_eq!(first.snapshot.profiles.len(), 4);
        assert!(first
            .snapshot
            .profiles
            .iter()
            .any(|profile| profile.id == "manual-profile" && profile.source_identity.is_none()));
        let active = first
            .snapshot
            .profiles
            .iter()
            .find(|profile| profile.id == first.snapshot.active_profile_id)
            .unwrap();
        assert_eq!(
            active.source_identity.as_deref(),
            Some("dsh:llm-pi-ai:custom-route:custom-route")
        );
        assert_eq!(active.model, "custom-vision");
        assert_eq!(active.model_capabilities[0].input, vec!["text", "image"]);
        assert!(!serde_json::to_string(&first).unwrap().contains("PRIVATE-"));
        let first_ids = first
            .snapshot
            .profiles
            .iter()
            .map(|profile| profile.id.clone())
            .collect::<Vec<_>>();

        let second = sync_from_lightseek_batch(
            &backend,
            first
                .imports
                .iter()
                .map(|item| item.source_identity.clone())
                .map(|source_identity| {
                    let custom = source_identity.contains("custom-route");
                    LightSeekProfileImport {
                        source_provider: if custom {
                            "custom-route"
                        } else {
                            "deepseek-official"
                        }
                        .to_owned(),
                        display_name: if custom {
                            "Custom route renamed"
                        } else {
                            "DeepSeek"
                        }
                        .to_owned(),
                        protocol: if custom {
                            "anthropic-messages"
                        } else {
                            "openai-compatible"
                        }
                        .to_owned(),
                        base_url: if custom {
                            "https://custom.example.test/anthropic"
                        } else {
                            "https://api.deepseek.com"
                        }
                        .to_owned(),
                        models: vec![LightSeekModelImport {
                            id: if custom {
                                "custom-vision"
                            } else {
                                "deep-model"
                            }
                            .to_owned(),
                            input: if custom {
                                vec!["text".to_owned(), "image".to_owned()]
                            } else {
                                vec!["text".to_owned()]
                            },
                            input_state: "declared".to_owned(),
                            tool_calls: "unknown".to_owned(),
                            max_output_tokens: Some(8192),
                            context_window_tokens: Some(128_000),
                        }],
                        api_key: if custom {
                            "PRIVATE-CUSTOM-KEY"
                        } else {
                            "PRIVATE-DEEP-KEY"
                        }
                        .to_owned(),
                        source_identity,
                    }
                })
                .collect(),
            Some("dsh:llm-pi-ai:custom-route:custom-route"),
        )
        .unwrap();
        assert_eq!(second.snapshot.profiles.len(), 4);
        assert_eq!(
            second
                .snapshot
                .profiles
                .iter()
                .map(|profile| profile.id.clone())
                .collect::<Vec<_>>(),
            first_ids
        );
        assert!(second
            .snapshot
            .profiles
            .iter()
            .any(|profile| profile.name == "LightSeek · Custom route renamed"));
        let active = crate::load_ai_model_config(backend.db_path()).unwrap();
        assert_eq!(active.api_key, "PRIVATE-CUSTOM-KEY");
        assert_eq!(active.model, "custom-vision");
    }

    #[test]
    fn lightseek_batch_disables_a_removed_source_without_deleting_manual_profiles() {
        let backend = backend("lightseek-removed-source");
        let _ = list(&backend).unwrap();
        let connection = |source_identity: &str, model: &str| LightSeekProfileImport {
            source_identity: source_identity.to_owned(),
            source_provider: source_identity.rsplit(':').next().unwrap().to_owned(),
            display_name: source_identity.to_owned(),
            protocol: "openai-compatible".to_owned(),
            base_url: "https://models.example.test/v1".to_owned(),
            models: vec![LightSeekModelImport {
                id: model.to_owned(),
                input: vec!["text".to_owned()],
                input_state: "declared".to_owned(),
                tool_calls: "supported".to_owned(),
                max_output_tokens: Some(4096),
                context_window_tokens: Some(128_000),
            }],
            api_key: format!("PRIVATE-{model}"),
        };
        let first = sync_from_lightseek_batch(
            &backend,
            vec![
                connection("dsh:source:a", "a"),
                connection("dsh:source:b", "b"),
            ],
            Some("dsh:source:a"),
        )
        .unwrap();
        assert_eq!(first.imports.len(), 2);
        let second = sync_from_lightseek_batch(
            &backend,
            vec![connection("dsh:source:a", "a")],
            Some("dsh:source:a"),
        )
        .unwrap();
        assert!(second.snapshot.profiles.iter().any(|profile| {
            profile.source_identity.as_deref() == Some("dsh:source:a") && profile.enabled
        }));
        assert!(second.snapshot.profiles.iter().any(|profile| {
            profile.source_identity.as_deref() == Some("dsh:source:b") && !profile.enabled
        }));
        assert!(second.snapshot.profiles.iter().any(|profile| {
            profile.id == "default" && profile.source_identity.is_none() && profile.enabled
        }));
    }

    #[test]
    fn lightseek_batch_validates_every_descriptor_before_writing_a_secret() {
        let backend = backend("lightseek-prevalidation");
        let _ = list(&backend).unwrap();
        let valid = LightSeekProfileImport {
            source_identity: "dsh:source:valid".to_owned(),
            source_provider: "valid".to_owned(),
            display_name: "Valid".to_owned(),
            protocol: "openai-compatible".to_owned(),
            base_url: "https://valid.example.test/v1".to_owned(),
            models: vec![LightSeekModelImport {
                id: "model-a".to_owned(),
                input: vec!["text".to_owned()],
                input_state: "declared".to_owned(),
                tool_calls: "unknown".to_owned(),
                max_output_tokens: Some(4096),
                context_window_tokens: Some(128_000),
            }],
            api_key: "PRIVATE-VALID".to_owned(),
        };
        let mut invalid = valid.clone();
        invalid.source_identity = "dsh:source:invalid".to_owned();
        invalid.models[0].input_state = "unknown".to_owned();
        assert_eq!(
            sync_from_lightseek_batch(&backend, vec![valid, invalid], None),
            Err("lightseek-model-sync-invalid")
        );
        let snapshot = list(&backend).unwrap();
        assert!(snapshot
            .profiles
            .iter()
            .all(|profile| profile.source_identity.is_none()));
        let connection = Connection::open(backend.db_path()).unwrap();
        let stored: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key LIKE 'aiProfileApiKey.lightseek-%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, 0);
    }

    #[test]
    fn model_selection_is_bound_to_the_discovered_models_of_one_api_connection() {
        let backend = backend("selection");
        let _ = list(&backend).unwrap();
        upsert(
            &backend,
            AiModelProfileInput {
                id: "custom-models".to_owned(),
                name: "一个 API".to_owned(),
                provider: "custom".to_owned(),
                protocol: "openai-compatible".to_owned(),
                base_url: "https://models.example.test/v1".to_owned(),
                model: "model-a".to_owned(),
                available_models: vec!["model-a".to_owned(), "model-b".to_owned()],
                temperature: 0.3,
                max_output_tokens: 4096,
                context_window_tokens: 128_000,
                enabled: true,
                api_key: Some("PRIVATE-CUSTOM-KEY".to_owned()),
                clear_api_key: false,
            },
        )
        .unwrap();

        let snapshot = select_model(&backend, "custom-models", "model-b").unwrap();
        assert_eq!(snapshot.active_profile_id, "custom-models");
        assert_eq!(snapshot.profiles[1].model, "model-b");
        assert_eq!(
            crate::load_ai_model_config(backend.db_path())
                .unwrap()
                .model,
            "model-b"
        );
        assert_eq!(
            select_model(&backend, "custom-models", "model-not-listed"),
            Err("ai-model-profile-model-unavailable")
        );
    }

    #[tokio::test]
    async fn connection_test_discovers_a_bounded_model_list_from_the_real_http_contract() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let read = socket.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /v1/models HTTP/1.1"));
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer fixture-key"));
            let body = br#"{"data":[{"id":"model-a"},{"id":"model-b"},{"id":"model-a"}]}"#;
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            socket.write_all(body).unwrap();
        });
        let profile = validate_profile(StoredProfile {
            id: "ollama-local".to_owned(),
            name: "本地连接".to_owned(),
            provider: "ollama".to_owned(),
            protocol: "openai-compatible".to_owned(),
            base_url: format!("http://{address}/v1"),
            model: "manual-fallback".to_owned(),
            available_models: Vec::new(),
            temperature: 0.7,
            max_output_tokens: 4096,
            context_window_tokens: 128_000,
            enabled: true,
            source_identity: None,
            source_provider: None,
            model_capabilities: Vec::new(),
        })
        .unwrap();
        assert_eq!(
            discover_models(&profile, "fixture-key").await.unwrap(),
            vec!["model-a", "model-b"]
        );
        server.join().unwrap();
    }

    #[test]
    fn deepseek_anthropic_chat_profile_is_projected_as_shared_with_agent() {
        let backend = backend("shared-deepseek");
        let _ = list(&backend).unwrap();
        let snapshot = upsert(
            &backend,
            AiModelProfileInput {
                id: "deepseek-shared".to_owned(),
                name: "DeepSeek 共用连接".to_owned(),
                provider: "deepseek".to_owned(),
                protocol: "anthropic-messages".to_owned(),
                base_url: "https://api.deepseek.com/anthropic".to_owned(),
                model: "deepseek-v4-flash".to_owned(),
                available_models: vec!["deepseek-v4-flash".to_owned()],
                temperature: 0.7,
                max_output_tokens: 4096,
                context_window_tokens: 128_000,
                enabled: true,
                api_key: Some("fixture-key".to_owned()),
                clear_api_key: false,
            },
        )
        .unwrap();
        let profile = snapshot
            .profiles
            .iter()
            .find(|profile| profile.id == "deepseek-shared")
            .unwrap();
        assert!(profile.agent_compatible);
    }
}
