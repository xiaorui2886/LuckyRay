//! Declarative package authority. Resources stay inside one SQLite transaction;
//! no archive extraction, resource filesystem paths, or executable loader.
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path, time::Duration};

pub const MAX_PACKAGE_BYTES: usize = 131_072;
const MAX_STATE_BYTES: usize = 4_500_000;
const TOKENS: &[&str] = &[
    "--theme-app-bg",
    "--theme-sidebar-bg",
    "--theme-titlebar-bg",
    "--theme-surface-base",
    "--theme-surface-raised",
    "--theme-surface-panel",
    "--theme-card-bg",
    "--theme-hover",
    "--theme-selected",
    "--theme-border-subtle",
    "--theme-border-strong",
    "--theme-dialog-border",
    "--theme-text-muted",
    "--text-primary",
    "--text-secondary",
];
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u8,
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub entry: String,
    pub min_host_version: String,
    pub api_version: u8,
    pub required_modules: Vec<String>,
    pub optional_modules: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Package {
    pub manifest: Manifest,
    pub resource: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Installed {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grants: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<PluginData>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub epoch: u64,
    pub package: Package,
    pub enabled: bool,
    pub digest: String,
}
fn is_zero(value: &u64) -> bool {
    *value == 0
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginData {
    pub schema_version: u32,
    pub revision: u64,
    pub settings: Value,
    pub cache: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contribution {
    pub id: String,
    pub label: String,
    pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptResource {
    pub code: String,
    pub required_permissions: Vec<String>,
    pub optional_permissions: Vec<String>,
    pub data_version: u32,
    pub contributions: Vec<Contribution>,
}
pub const PERMISSIONS: &[&str] = &[
    "materials.read",
    "materials.image",
    "materials.tags",
    "knowledge.read",
    "knowledge.create",
    "knowledge.insert",
    "canvas.read",
    "canvas.export",
];
pub fn script(package: &Package) -> Result<ScriptResource, String> {
    serde_json::from_value(package.resource.clone()).map_err(|_| "extension-invalid-script".into())
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub revision: u64,
    pub packages: Vec<Installed>,
    #[serde(default)]
    pub host_version: String,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    List,
    Grant {
        id: String,
        grants: Vec<String>,
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
    },
    Data {
        id: String,
        data: PluginData,
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
    },
    Install {
        package: Package,
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
    },
    Update {
        package: Package,
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
    },
    Enable {
        id: String,
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
    },
    Disable {
        id: String,
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
    },
    Uninstall {
        id: String,
        #[serde(rename = "expectedRevision")]
        expected_revision: u64,
    },
}
fn fail<T>(code: &str) -> Result<T, String> {
    Err(format!("extension-{code}"))
}
fn version(s: &str) -> Option<[u64; 3]> {
    let v: Vec<_> = s.split('.').collect();
    if v.len() != 3
        || v.iter().any(|p| {
            p.is_empty()
                || p.len() > 9
                || !p.bytes().all(|c| c.is_ascii_digit())
                || (p.len() > 1 && p.starts_with('0'))
        })
    {
        return None;
    }
    Some([v[0].parse().ok()?, v[1].parse().ok()?, v[2].parse().ok()?])
}
fn module_available(s: &str) -> bool {
    ["knowledge", "materials", "canvas"].contains(&s)
}
pub fn compatible(p: &Package, host: &str) -> bool {
    ((p.manifest.kind == "script" && p.manifest.api_version == 1)
        || (p.manifest.kind != "script" && p.manifest.api_version == 0))
        && version(&p.manifest.min_host_version)
            .zip(version(host))
            .map(|(a, b)| a <= b)
            .unwrap_or(false)
        && p.manifest
            .required_modules
            .iter()
            .all(|m| module_available(m))
}
pub fn validate(p: &Package) -> Result<(), String> {
    let m = &p.manifest;
    if serde_json::to_vec(p)
        .map_err(|_| "extension-invalid-json")?
        .len()
        > MAX_PACKAGE_BYTES
    {
        return fail("package-too-large");
    }
    if (m.kind == "script" && (m.schema_version != 1 || m.api_version != 1))
        || (m.kind != "script" && (m.schema_version != 0 || m.api_version != 0))
    {
        return fail("unsupported-api");
    }
    if m.id.len() < 3
        || m.id.len() > 80
        || !m.id.as_bytes()[0].is_ascii_lowercase()
        || !m
            .id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-')
        || m.id.contains("..")
    {
        return fail("invalid-id");
    }
    if m.name.trim().is_empty()
        || m.name.len() > 160
        || m.name.chars().any(char::is_control)
        || version(&m.version).is_none()
        || version(&m.min_host_version).is_none()
    {
        return fail("invalid-manifest");
    }
    if m.required_modules.len() + m.optional_modules.len() > 16
        || m.required_modules
            .iter()
            .chain(&m.optional_modules)
            .any(|x| {
                x.is_empty()
                    || x.len() > 40
                    || !x.bytes().all(|c| c.is_ascii_lowercase() || c == b'-')
            })
    {
        return fail("invalid-modules");
    }
    match m.kind.as_str() {
        "script" => {
            if m.entry != "main.js" {
                return fail("invalid-entry");
            }
            let r = script(p)?;
            if r.code.is_empty()
                || r.code.len() > 120000
                || r.data_version == 0
                || r.required_permissions.len() + r.optional_permissions.len() > 16
                || r.contributions.is_empty()
                || r.contributions.len() > 16
            {
                return fail("invalid-script");
            }
            for permission in r.required_permissions.iter().chain(&r.optional_permissions) {
                if !PERMISSIONS.contains(&permission.as_str()) {
                    return fail("unsupported-permission");
                }
                let module = permission.split('.').next().unwrap();
                if !m
                    .required_modules
                    .iter()
                    .chain(&m.optional_modules)
                    .any(|x| x == module)
                {
                    return fail("permission-module-required");
                }
            }
            let mut ids = std::collections::HashSet::new();
            for c in &r.contributions {
                if c.id.is_empty()
                    || c.id.len() > 64
                    || !c.id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    || !ids.insert(&c.id)
                    || c.label.is_empty()
                    || c.label.len() > 120
                    || c.label.chars().any(char::is_control)
                    || !["command", "menu", "panel", "settings", "page"].contains(&c.kind.as_str())
                {
                    return fail("invalid-contribution");
                }
            }
        }
        "theme" => {
            if m.entry != "theme.json" {
                return fail("invalid-entry");
            }
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Theme {
                base: String,
                tokens: BTreeMap<String, String>,
            }
            let theme: Theme = serde_json::from_value(p.resource.clone())
                .map_err(|_| "extension-invalid-theme")?;
            if !["dark", "light"].contains(&theme.base.as_str())
                || theme.tokens.iter().any(|(k, v)| {
                    !TOKENS.contains(&k.as_str())
                        || v.len() != 7
                        || !v.starts_with('#')
                        || !v[1..].bytes().all(|c| c.is_ascii_hexdigit())
                })
            {
                return fail("invalid-theme");
            }
        }
        "template" => {
            if m.entry != "template.json" || !m.required_modules.iter().any(|x| x == "knowledge") {
                return fail("template-knowledge-required");
            }
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Template {
                markdown: String,
                parameters: BTreeMap<String, String>,
            }
            let t: Template = serde_json::from_value(p.resource.clone())
                .map_err(|_| "extension-invalid-template")?;
            if t.markdown.len() > 65536
                || t.parameters.len() > 12
                || t.markdown.contains('<')
                || t.markdown.contains("![")
                || t.markdown.contains("![[")
                || t.markdown.contains("](")
                || t.markdown.contains('\0')
            {
                return fail("unsafe-template-resource");
            }
            if t.parameters.iter().any(|(k, v)| {
                k.is_empty()
                    || k.len() > 32
                    || !k
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
                    || v.len() > 500
                    || v.chars().any(char::is_control)
            }) {
                return fail("invalid-parameters");
            }
            let mut rest = t.markdown.as_str();
            while let Some(pos) = rest.find("{{") {
                let tail = &rest[pos + 2..];
                let end = tail.find("}}").ok_or("extension-invalid-placeholder")?;
                if !t.parameters.contains_key(&tail[..end]) {
                    return fail("unknown-parameter");
                }
                rest = &tail[end + 2..];
            }
        }
        _ => return fail("unsupported-type"),
    }
    Ok(())
}
fn digest(p: &Package) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(p).expect("serializable package"))
    )
}
fn safe_existing(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return fail("unsafe-storage-path");
                    }
                }
                if meta.file_type().is_symlink() {
                    return fail("unsafe-storage-path");
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return fail("storage-unavailable"),
        }
    }
    Ok(())
}
/// app_data is supplied by Tauri's path resolver, never package input.
pub fn manage(app_data: &Path, host: &str, request: Request) -> Result<State, String> {
    let root = app_data.join("extension-packages-v0");
    safe_existing(&root)?;
    fs::create_dir_all(&root).map_err(|_| "extension-storage-unavailable")?;
    let db = root.join("packages.sqlite3");
    for name in [
        "packages.sqlite3",
        "packages.sqlite3-journal",
        "packages.sqlite3-wal",
        "packages.sqlite3-shm",
    ] {
        safe_existing(&root.join(name))?;
    }
    let mut connection = Connection::open(&db).map_err(|_| "extension-storage-unavailable")?;
    connection
        .busy_timeout(Duration::from_secs(3))
        .map_err(|_| "extension-storage-busy")?;
    connection.execute_batch("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL);").map_err(|_|"extension-storage-unavailable")?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| "extension-storage-busy")?;
    let mut state = match tx.query_row(
        "SELECT payload FROM state WHERE singleton=1 AND length(payload)<=4500000",
        [],
        |r| r.get::<_, String>(0),
    ) {
        Ok(json) => {
            serde_json::from_str::<State>(&json).map_err(|_| "extension-storage-corrupt")?
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            let count: i64 = tx
                .query_row("SELECT count(*) FROM state", [], |r| r.get(0))
                .map_err(|_| "extension-storage-corrupt")?;
            if count > 0 {
                return fail("storage-corrupt");
            }
            State::default()
        }
        Err(_) => return fail("storage-corrupt"),
    };
    state.host_version = host.to_string();
    for entry in &mut state.packages {
        validate(&entry.package)?;
        if digest(&entry.package) != entry.digest {
            return fail("integrity-mismatch");
        }
        if entry.package.manifest.kind == "script" {
            let resource = script(&entry.package)?;
            if entry.epoch == 0
                || entry.epoch > state.revision
                || entry.grants.len() > 16
                || entry.grants.iter().any(|g| {
                    !resource.required_permissions.contains(g)
                        && !resource.optional_permissions.contains(g)
                })
                || (entry.enabled
                    && !resource
                        .required_permissions
                        .iter()
                        .all(|p| entry.grants.contains(p)))
            {
                return fail("storage-corrupt");
            }
            if let Some(data) = &entry.data {
                if data.schema_version == 0
                    || data.schema_version > resource.data_version
                    || data.revision == 0
                    || serde_json::to_vec(data)
                        .map_err(|_| "extension-storage-corrupt")?
                        .len()
                        > 65536
                {
                    return fail("storage-corrupt");
                }
            }
        } else {
            if !entry.grants.is_empty() || entry.data.is_some() || entry.epoch > state.revision {
                return fail("storage-corrupt");
            }
            // Older Update assigned a script epoch to themes/templates, which
            // made the next read reject an otherwise valid package. They have
            // no runtime sessions; normalize only this inert legacy field in
            // memory after package/digest validation. List never rewrites DB.
            entry.epoch = 0;
        }
    }
    let expected = match &request {
        Request::List => return Ok(state),
        Request::Grant {
            expected_revision, ..
        }
        | Request::Data {
            expected_revision, ..
        }
        | Request::Install {
            expected_revision, ..
        }
        | Request::Update {
            expected_revision, ..
        }
        | Request::Enable {
            expected_revision, ..
        }
        | Request::Disable {
            expected_revision, ..
        }
        | Request::Uninstall {
            expected_revision, ..
        } => *expected_revision,
    };
    if expected != state.revision {
        return fail("revision-conflict");
    }
    let update = matches!(&request, Request::Update { .. });
    let enable = matches!(&request, Request::Enable { .. });
    let uninstall = matches!(&request, Request::Uninstall { .. });
    match request {
        Request::Grant { id, grants, .. } => {
            let entry = state
                .packages
                .iter_mut()
                .find(|x| x.package.manifest.id == id && x.package.manifest.kind == "script")
                .ok_or("extension-not-installed")?;
            let r = script(&entry.package)?;
            if grants.len() > 16
                || grants.iter().any(|p| {
                    !r.required_permissions
                        .iter()
                        .chain(&r.optional_permissions)
                        .any(|x| x == p)
                })
            {
                return fail("invalid-grant");
            }
            if !r.required_permissions.iter().all(|p| grants.contains(p)) {
                entry.enabled = false;
            }
            entry.grants = grants;
            entry.epoch = state.revision + 1;
        }
        Request::Data { id, data, .. } => {
            let entry = state
                .packages
                .iter_mut()
                .find(|x| x.package.manifest.id == id && x.package.manifest.kind == "script")
                .ok_or("extension-not-installed")?;
            let r = script(&entry.package)?;
            let old = entry.data.as_ref();
            if data.revision != old.map(|d| d.revision).unwrap_or(0) + 1
                || data.schema_version < old.map(|d| d.schema_version).unwrap_or(1)
                || data.schema_version > r.data_version
                || serde_json::to_vec(&data)
                    .map_err(|_| "extension-data-invalid")?
                    .len()
                    > 65536
            {
                return fail("data-conflict-or-limit");
            }
            entry.data = Some(data);
        }
        Request::Install { package, .. } | Request::Update { package, .. } => {
            validate(&package)?;
            if !compatible(&package, host) {
                return fail("incompatible");
            }
            let existing = state
                .packages
                .iter()
                .position(|x| x.package.manifest.id == package.manifest.id);
            if let Some(index) = existing {
                let old = &state.packages[index];
                if old.package == package {
                    return Ok(state);
                }
                if !update {
                    return fail("id-conflict");
                }
                if old.package.manifest.kind != package.manifest.kind
                    || version(&package.manifest.version) <= version(&old.package.manifest.version)
                {
                    return fail("version-conflict");
                }
                let mut enabled = old.enabled;
                let mut grants = old.grants.clone();
                let data = old.data.clone();
                if package.manifest.kind == "script" {
                    let next = script(&package)?;
                    let previous = script(&old.package)?;
                    let expanded = next
                        .required_permissions
                        .iter()
                        .chain(&next.optional_permissions)
                        .any(|p| {
                            !previous
                                .required_permissions
                                .iter()
                                .chain(&previous.optional_permissions)
                                .any(|x| x == p)
                        });
                    if expanded {
                        grants.clear();
                        enabled = false;
                    }
                    grants.retain(|p| {
                        next.required_permissions
                            .iter()
                            .chain(&next.optional_permissions)
                            .any(|x| x == p)
                    });
                    if !next.required_permissions.iter().all(|p| grants.contains(p)) {
                        enabled = false;
                    }
                    if data
                        .as_ref()
                        .is_some_and(|d| d.schema_version > next.data_version)
                    {
                        return fail("data-version-conflict");
                    }
                }
                state.packages[index] = Installed {
                    grants,
                    data,
                    epoch: if package.manifest.kind == "script" {
                        state.revision + 1
                    } else {
                        0
                    },
                    digest: digest(&package),
                    package,
                    enabled,
                };
            } else {
                if update {
                    return fail("not-installed");
                }
                if state.packages.len() >= 32 {
                    return fail("package-limit");
                }
                state.packages.push(Installed {
                    grants: Vec::new(),
                    data: None,
                    epoch: if package.manifest.kind == "script" {
                        state.revision + 1
                    } else {
                        0
                    },
                    digest: digest(&package),
                    package,
                    enabled: false,
                });
            }
        }
        Request::Enable { id, .. }
        | Request::Disable { id, .. }
        | Request::Uninstall { id, .. } => {
            let index = state
                .packages
                .iter()
                .position(|x| x.package.manifest.id == id)
                .ok_or("extension-not-installed")?;
            if uninstall {
                state.packages.remove(index);
            } else {
                if enable && !compatible(&state.packages[index].package, host) {
                    return fail("incompatible");
                }
                if enable
                    && state.packages[index].package.manifest.kind == "script"
                    && !script(&state.packages[index].package)?
                        .required_permissions
                        .iter()
                        .all(|p| state.packages[index].grants.contains(p))
                {
                    return fail("consent-required");
                }
                if state.packages[index].enabled == enable {
                    return Ok(state);
                }
                if enable && state.packages[index].package.manifest.kind == "theme" {
                    for p in &mut state.packages {
                        if p.package.manifest.kind == "theme" {
                            p.enabled = false;
                        }
                    }
                }
                state.packages[index].enabled = enable;
                if state.packages[index].package.manifest.kind == "script" {
                    state.packages[index].epoch = state.revision + 1;
                }
            }
        }
        Request::List => unreachable!(),
    }
    state.revision = state
        .revision
        .checked_add(1)
        .ok_or("extension-revision-overflow")?;
    let json = serde_json::to_string(&state).map_err(|_| "extension-invalid-json")?;
    if json.len() > MAX_STATE_BYTES {
        return fail("storage-limit");
    }
    tx.execute("INSERT INTO state(singleton,payload) VALUES(1,?1) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload",params![json]).map_err(|_|"extension-write-failed")?;
    tx.commit().map_err(|_| "extension-commit-failed")?;
    Ok(state)
}
