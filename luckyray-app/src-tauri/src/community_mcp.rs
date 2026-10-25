//! Official optional web-MCP community controller. No Codex/Agent configuration.
//! Every mutating entry point is Main-only and uses a revision/consent check.
use crate::{community_mcp_package as package, community_mcp_process as process};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
use zeroize::Zeroize;
static ACTION: Mutex<()> = Mutex::new(());
static RUNTIME: Mutex<Runtime> = Mutex::new(Runtime::empty());
static MONITOR: AtomicBool = AtomicBool::new(false);
static EXITING: AtomicBool = AtomicBool::new(false);
const STORE: &str = include_str!("../../packages/community-mcp/src/secret-store.ps1");
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    version: Option<String>,
    tunnel_id: Option<String>,
    connect_on_launch: bool,
    binding: Option<Binding>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    client_id: String,
    library_id: String,
    vault_id: String,
    expires_at: u64,
}
struct Runtime {
    child: Option<process::OwnedProcess>,
    phase: &'static str,
    error: Option<String>,
    attempts: u8,
    retry: Option<Instant>,
    started: Option<Instant>,
    desktop_ready: bool,
}
impl Runtime {
    const fn empty() -> Self {
        Self {
            child: None,
            phase: "stopped",
            error: None,
            attempts: 0,
            retry: None,
            started: None,
            desktop_ready: false,
        }
    }
}
struct Paths {
    root: PathBuf,
    helper: PathBuf,
    secret: PathBuf,
    state: PathBuf,
    connection: PathBuf,
    health: PathBuf,
    activity: PathBuf,
}
fn paths(app: &tauri::AppHandle) -> Result<Paths, String> {
    let local = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "plugin-data-unavailable")?;
    let root = local.join("community-web-mcp-v1");
    package::safe_path(&root)?;
    Ok(Paths {
        helper: local.join("community-mcp-secret-store-v1.ps1"),
        secret: root.join("private"),
        state: root.join("settings.json"),
        connection: root.join("connection.json"),
        health: root.join("health-url.txt"),
        activity: root.join("web-activity.json"),
        root,
    })
}
fn settings(p: &Paths) -> Result<Settings, String> {
    Ok(package::read_json(&p.state)?.unwrap_or_default())
}
fn revision(s: &Settings) -> String {
    package::hash(&serde_json::to_vec(s).unwrap_or_default())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_secs())
        .unwrap_or(0)
}
fn initialize_storage(p: &Paths) -> Result<(), String> {
    package::safe_path(&p.helper)?;
    fs::create_dir_all(p.helper.parent().ok_or("plugin-path-invalid")?)
        .map_err(|_| "plugin-data-unavailable")?;
    if p.helper.exists() {
        if fs::read(&p.helper).map_err(|_| "plugin-helper-unavailable")? != STORE.as_bytes() {
            return Err("plugin-helper-integrity-failed".into());
        }
    } else {
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&p.helper)
            .map_err(|_| "plugin-helper-unavailable")?;
        f.write_all(STORE.as_bytes())
            .and_then(|_| f.sync_all())
            .map_err(|_| "plugin-helper-unavailable")?;
    }
    fs::create_dir_all(&p.root).map_err(|_| "plugin-data-unavailable")?;
    secret(p, "initialize", "tunnel-key", None)?;
    Ok(())
}
fn secret(p: &Paths, action: &str, name: &str, input: Option<&[u8]>) -> Result<String, String> {
    package::safe_path(&p.helper)?;
    package::safe_path(&p.secret)?;
    if fs::read(&p.helper).map_err(|_| "plugin-helper-unavailable")? != STORE.as_bytes() {
        return Err("plugin-helper-integrity-failed".into());
    }
    let exe = PathBuf::from(std::env::var_os("SystemRoot").ok_or("plugin-platform-unsupported")?)
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let args = vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-File".into(),
        p.helper.to_string_lossy().into_owned(),
        "-Directory".into(),
        p.secret.to_string_lossy().into_owned(),
        "-Action".into(),
        action.into(),
        "-Name".into(),
        name.into(),
    ];
    let (ok, out, mut err) = process::run(&exe, &args, input, 20)?;
    err.zeroize();
    if !ok {
        return Err("private-secret-storage-failed".into());
    }
    Ok(out)
}
fn grant_valid(app: &tauri::AppHandle, s: &Settings) -> bool {
    let Some(binding) = &s.binding else {
        return false;
    };
    binding.expires_at > now()
        && app
            .state::<crate::local_transport::LocalTransportHandle>()
            .list_materials_grants()
            .is_ok_and(|grants| {
                grants.iter().any(|g| {
                    g.id == binding.client_id
                        && g.public_metadata()["libraryId"].as_str()
                            == Some(binding.library_id.as_str())
                        && g.public_metadata()["vaultId"].as_str()
                            == Some(binding.vault_id.as_str())
                })
            })
}
fn payload(p: &Paths, s: &Settings) -> Result<PathBuf, String> {
    let v = s.version.as_deref().ok_or("plugin-not-installed")?;
    if v.is_empty()
        || !v
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err("plugin-version-invalid".into());
    }
    Ok(p.root.join("versions").join(v))
}
fn readiness(p: &Paths) -> bool {
    let Ok(meta) = fs::metadata(&p.health) else {
        return false;
    };
    if meta.len() > 256 {
        return false;
    }
    if package::safe_path(&p.health).is_err() {
        return false;
    }
    let Ok(raw) = fs::read_to_string(&p.health) else {
        return false;
    };
    let Ok(mut url) = reqwest::Url::parse(raw.trim()) else {
        return false;
    };
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    url.set_path("/readyz");
    reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .ok()
        .and_then(|c| c.get(url).send().ok())
        .is_some_and(|r| r.status().as_u16() == 200)
}
fn stop_runtime(runtime: &mut Runtime) -> Result<(), String> {
    runtime.retry = None;
    runtime.attempts = 0;
    runtime.desktop_ready = false;
    if let Some(mut child) = runtime.child.take() {
        child.stop()?;
        drop(child);
    }
    runtime.phase = "stopped";
    runtime.error = None;
    runtime.started = None;
    Ok(())
}
fn start_runtime(
    app: &tauri::AppHandle,
    p: &Paths,
    s: &Settings,
    r: &mut Runtime,
) -> Result<(), String> {
    if s.version.as_deref() != Some(package::catalog()?.version.as_str()) {
        return Err("plugin-update-required".into());
    }
    if EXITING.load(Ordering::Acquire) {
        return Err("application-closing".into());
    }
    if r.child.as_ref().is_some_and(|c| c.running()) {
        return Err("plugin-already-running".into());
    }
    r.child.take();
    if !grant_valid(app, s) {
        return Err("library-grant-invalid".into());
    }
    let id = s
        .tunnel_id
        .as_deref()
        .ok_or("tunnel-configuration-required")?;
    if !valid_tunnel_id(id) {
        return Err("tunnel-id-invalid".into());
    }
    // Do not overlap or terminate manually started/other-profile tunnels. This
    // conservative check avoids guessing which external YAML holds this ID.
    if process::external_tunnel_running()? {
        return Err("external-tunnel-running".into());
    }
    let dir = payload(p, s)?;
    package::verify(&dir, s.version.as_deref().unwrap())?;
    let (ok, _, _) = process::run(
        &dir.join("node.exe"),
        &[
            dir.join("packages/community-mcp/src/server.mjs")
                .to_string_lossy()
                .into_owned(),
            "--config".into(),
            p.connection.to_string_lossy().into_owned(),
            "--check".into(),
        ],
        None,
        35,
    )?;
    if !ok {
        return Err("desktop-binding-check-failed".into());
    }
    let mut key = secret(p, "read", "tunnel-key", None)?;
    if key.is_empty() || key.len() > 4096 || key.chars().any(char::is_control) {
        key.zeroize();
        return Err("tunnel-key-invalid".into());
    }
    for f in [&p.health, &p.activity] {
        package::safe_path(f)?;
        if f.exists() {
            fs::remove_file(f).map_err(|_| "plugin-state-reset-failed")?;
        }
    }
    let command = |path: &std::path::Path| -> Result<String, String> {
        let value = path.to_string_lossy().replace('\\', "/");
        if value.contains(['"', '\n', '\r']) {
            return Err("plugin-command-path-invalid".into());
        }
        Ok(format!("\"{value}\""))
    };
    let mcp = format!(
        "{} {} --config {} --activity-file {}",
        command(&dir.join("node.exe"))?,
        command(&dir.join("packages/community-mcp/src/server.mjs"))?,
        command(&p.connection)?,
        command(&p.activity)?
    );
    let args = vec![
        "run".into(),
        "--control-plane.tunnel-id".into(),
        id.into(),
        "--control-plane.api-key".into(),
        "env:CONTROL_PLANE_API_KEY".into(),
        "--mcp.command".into(),
        mcp,
        "--mcp.stdio-send-initialized-notification".into(),
        "--health.listen-addr".into(),
        "127.0.0.1:0".into(),
        "--health.url-file".into(),
        p.health.to_string_lossy().into_owned(),
        // This stdio server uses the standard outbound OpenAI tunnel. The
        // optional Cloudflare managed mode requires separate provisioning;
        // enabling it unconditionally prevents ordinary logical tunnels from
        // starting before any MCP traffic can be carried.
        "--cloudflared.path".into(),
        dir.join("cloudflared.exe").to_string_lossy().into_owned(),
    ];
    let mut env = BTreeMap::new();
    for k in [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
    ] {
        if let Ok(v) = std::env::var(k) {
            env.insert(k.into(), v);
        }
    }
    // The bundled Node helper needs PowerShell. Build a narrow system PATH rather
    // than inheriting whichever shell/Agent launched the desktop.
    let windows = std::env::var("SystemRoot").map_err(|_| "system-runtime-unavailable")?;
    let system = PathBuf::from(windows).join("System32");
    env.insert(
        "PATH".into(),
        format!(
            "{};{};{}",
            dir.display(),
            system.display(),
            system.join("WindowsPowerShell").join("v1.0").display()
        ),
    );
    env.insert("CONTROL_PLANE_API_KEY".into(), key.clone());
    key.zeroize();
    r.child = Some(process::spawn(
        &dir.join("tunnel-client-runtime-cloudflared.exe"),
        &args,
        &dir,
        env,
    )?);
    r.phase = "starting";
    r.error = None;
    r.started = Some(Instant::now());
    r.desktop_ready = true;
    Ok(())
}
fn valid_tunnel_id(s: &str) -> bool {
    s.strip_prefix("tunnel_").is_some_and(|v| {
        v.len() == 32
            && v.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    })
}
fn launch_monitor(app: tauri::AppHandle) {
    if MONITOR.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || {
        while !EXITING.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_secs(4));
            let Ok(_action) = ACTION.try_lock() else {
                continue;
            };
            let Ok(p) = paths(&app) else {
                continue;
            };
            let Ok(s) = settings(&p) else {
                continue;
            };
            let Ok(mut r) = RUNTIME.lock() else {
                break;
            };
            if r.child.is_some() && !grant_valid(&app, &s) {
                let _ = stop_runtime(&mut r);
                r.error = Some("library-grant-invalid".into());
                r.phase = "failed";
                continue;
            }
            if r.child.as_ref().is_some_and(|c| !c.running()) {
                let failure = r.child.as_ref().and_then(|c| c.failure_code());
                r.child.take();
                r.desktop_ready = false;
                if r.attempts < 3 {
                    r.attempts += 1;
                    r.retry =
                        Some(Instant::now() + Duration::from_secs(2u64.pow(r.attempts.into()) * 2));
                    r.phase = "reconnecting";
                    r.error = Some(failure.unwrap_or("tunnel-runtime-exited").into());
                } else {
                    r.phase = "failed";
                    r.error = Some(failure.unwrap_or("tunnel-retry-exhausted").into());
                }
            }
            if r.retry.is_some_and(|at| Instant::now() >= at) {
                r.retry = None;
                if let Err(e) = start_runtime(&app, &p, &s, &mut r) {
                    r.phase = "failed";
                    r.error = Some(e);
                }
            }
            if r.child.as_ref().is_some_and(|c| c.running()) {
                if readiness(&p) {
                    r.phase = "ready";
                    // Track continuous unready time, not total process uptime.
                    r.started = None;
                } else {
                    r.phase = "reconnecting";
                    r.started.get_or_insert_with(Instant::now);
                    if r.started
                        .is_some_and(|at| at.elapsed() > Duration::from_secs(90))
                    {
                        let _ = stop_runtime(&mut r);
                        r.phase = "failed";
                        r.error = Some("tunnel-not-ready".into());
                    }
                }
            }
        }
    });
}
fn status(app: &tauri::AppHandle) -> Result<Value, String> {
    let p = paths(app)?;
    let s = settings(&p)?;
    let c = package::catalog()?;
    let libraries = crate::material_catalog_for_app(app)?
        .list_libraries(true)
        .map_err(|_| "material-libraries-unavailable")?
        .into_iter()
        .filter(|l| l.visible)
        .map(|l| json!({"id":l.id,"name":l.name}))
        .collect::<Vec<_>>();
    let service = crate::knowledge_service()?;
    let vaults = match (
        service.current_vault_id(),
        service.current_target_identity(),
    ) {
        (Ok(id), Ok(target)) => vec![json!({"id":id,"name":target.label})],
        _ => vec![],
    };
    let authorized = grant_valid(app, &s);
    let r = RUNTIME.lock().map_err(|_| "plugin-state-busy")?;
    let phase = if s.version.is_none() {
        "absent"
    } else if r.phase == "stopped" {
        "installed"
    } else {
        r.phase
    };
    let activity: Option<Value> = package::read_json(&p.activity).unwrap_or(None);
    Ok(
        json!({"revision":revision(&s),"phase":phase,"version":s.version,"availableVersion":c.version,"updateAvailable":s.version.as_ref().is_some_and(|v|v!=&c.version),"packageAvailable":package::available(&c),"downloadBytes":c.download_bytes,
        "authorized":authorized,"grant":s.binding,"configured":s.tunnel_id.is_some(),"tunnelId":s.tunnel_id,
        "hasKey":p.secret.join("tunnel-key.dpapi").is_file(),"connectOnLaunch":s.connect_on_launch,
        "desktopReady":r.desktop_ready&&authorized,"tunnelReady":r.phase=="ready",
        "lastWebCallAt":if r.phase=="ready"{activity.and_then(|v|v.get("at").cloned())}else{None},
        "errorCode":r.error,"libraries":libraries,"vaults":vaults}),
    )
}
#[tauri::command]
pub(crate) async fn community_mcp_status(
    caller: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    crate::require_main_caller(&caller)?;
    tauri::async_runtime::spawn_blocking(move || status(&app))
        .await
        .map_err(|_| "plugin-task-failed")?
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionInput {
    action: String,
    revision: String,
    #[serde(default)]
    confirmed: bool,
    library_id: Option<String>,
    vault_id: Option<String>,
    tunnel_id: Option<String>,
    api_key: Option<String>,
    connect_on_launch: Option<bool>,
}
impl Drop for ActionInput {
    fn drop(&mut self) {
        if let Some(key) = &mut self.api_key {
            key.zeroize();
        }
    }
}
#[tauri::command]
pub(crate) async fn community_mcp_action(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    input: ActionInput,
) -> Result<(), String> {
    crate::require_main_caller(&caller)?;
    tauri::async_runtime::spawn_blocking(move || act(&app, input))
        .await
        .map_err(|_| "plugin-task-failed")?
}
fn install_package(p: &Paths, s: &mut Settings) -> Result<(), String> {
    initialize_storage(p)?;
    package::install(&p.root.join("versions"))?;
    s.version = Some(package::catalog()?.version);
    package::write_json(&p.state, s)
}
fn act(app: &tauri::AppHandle, input: ActionInput) -> Result<(), String> {
    let _writer = ACTION.try_lock().map_err(|_| "plugin-operation-busy")?;
    let p = paths(app)?;
    let mut s = settings(&p)?;
    if input.revision != revision(&s) {
        return Err("plugin-state-changed".into());
    }
    if input.action == "install" {
        if RUNTIME.lock().map_err(|_| "plugin-state-busy")?.child.is_some() {
            return Err("stop-before-update".into());
        }
        install_package(&p, &mut s)?;
        // A successful update resolves any previous startup/update failure.
        // Access bindings and encrypted connection settings are unchanged.
        return stop_runtime(&mut *RUNTIME.lock().map_err(|_| "plugin-state-busy")?);
    }
    if s.version.is_none() {
        return Err("plugin-not-installed".into());
    }
    let transport = app.state::<crate::local_transport::LocalTransportHandle>();
    match input.action.as_str() {
        "authorize" => {
            if !input.confirmed {
                return Err("library-consent-required".into());
            }
            if s.binding.is_some() {
                return Err("revoke-existing-grant-first".into());
            }
            let library = input
                .library_id
                .as_deref()
                .ok_or("material-library-required")?;
            let vault = input
                .vault_id
                .as_deref()
                .ok_or("knowledge-vault-required")?;
            crate::material_catalog_for_app(app)?
                .for_library(library)
                .map_err(|_| "material-library-unavailable")?;
            let captured = crate::knowledge_service()?
                .capture_workspace_scope(vault)
                .map_err(|_| "knowledge-vault-changed")?;
            let scope = captured
                .workspace_recovery_record()
                .map_err(|_| "knowledge-vault-unavailable")?;
            let exe = std::env::current_exe().map_err(|_| "desktop-identity-unavailable")?;
            let profile = transport.materials_profile_root()?;
            let mut pair = transport.pair_libraries(library, vault, scope)?;
            let id = pair["clientId"]
                .as_str()
                .ok_or("pairing-invalid")?
                .to_owned();
            pair["desktopExe"] = json!(exe.to_string_lossy());
            pair["profileRoot"] = json!(profile);
            let result = (|| -> Result<(), String> {
                let mut raw = serde_json::to_vec(&pair).map_err(|_| "pairing-invalid")?;
                let saved = secret(&p, "write", "credential", Some(&raw));
                raw.zeroize();
                saved?;
                pair.as_object_mut()
                    .ok_or("pairing-invalid")?
                    .remove("credential");
                pair["credentialFile"] = json!(p.secret.join("credential.dpapi").to_string_lossy());
                package::write_json(&p.connection, &pair)?;
                s.binding = Some(Binding {
                    client_id: id.clone(),
                    library_id: library.into(),
                    vault_id: vault.into(),
                    expires_at: pair["expiresAt"].as_u64().ok_or("pairing-invalid")?,
                });
                package::write_json(&p.state, &s)
            })();
            if result.is_err() {
                transport.revoke_materials(&id)?;
                let _ = secret(&p, "remove", "credential", None);
            }
            result
        }
        "revoke" | "uninstall" => {
            if input.action == "uninstall" && !input.confirmed {
                return Err("uninstall-confirmation-required".into());
            }
            stop_runtime(&mut *RUNTIME.lock().map_err(|_| "plugin-state-busy")?)?;
            if let Some(binding) = &s.binding {
                if transport
                    .list_materials_grants()?
                    .iter()
                    .any(|g| g.id == binding.client_id)
                {
                    transport.revoke_materials(&binding.client_id)?;
                }
            }
            s.binding = None;
            s.connect_on_launch = false;
            package::write_json(&p.state, &s)?;
            secret(&p, "remove", "credential", None)?;
            if p.connection.exists() {
                package::safe_path(&p.connection)?;
                fs::remove_file(&p.connection).map_err(|_| "plugin-config-remove-failed")?;
            }
            if input.action == "uninstall" {
                secret(&p, "remove", "tunnel-key", None)?;
                // Delete only the verified plugin payload, never vault/library roots.
                let dir = payload(&p, &s)?;
                package::verify(&dir, s.version.as_deref().unwrap())?;
                fs::remove_dir_all(&dir).map_err(|_| "plugin-uninstall-failed")?;
                s = Settings::default();
                package::write_json(&p.state, &s)?;
            }
            Ok(())
        }
        "configure" => {
            if !input.confirmed {
                return Err("configuration-consent-required".into());
            }
            if RUNTIME
                .lock()
                .map_err(|_| "plugin-state-busy")?
                .child
                .is_some()
            {
                return Err("stop-before-configure".into());
            }
            let id = input.tunnel_id.as_deref().ok_or("tunnel-id-required")?;
            if !valid_tunnel_id(id) {
                return Err("tunnel-id-invalid".into());
            }
            if let Some(key) = &input.api_key {
                if key.is_empty() || key.len() > 4096 || key.chars().any(char::is_control) {
                    return Err("tunnel-key-invalid".into());
                }
                secret(&p, "write", "tunnel-key", Some(key.as_bytes()))?;
            } else if !p.secret.join("tunnel-key.dpapi").is_file() {
                return Err("tunnel-key-required".into());
            }
            s.tunnel_id = Some(id.into());
            package::write_json(&p.state, &s)
        }
        "preferences" => {
            if !input.confirmed {
                return Err("autoconnect-consent-required".into());
            }
            s.connect_on_launch = input.connect_on_launch.ok_or("input-invalid")?;
            if s.connect_on_launch && (!grant_valid(app, &s) || s.tunnel_id.is_none()) {
                return Err("connection-setup-required".into());
            }
            package::write_json(&p.state, &s)
        }
        "connect" => {
            let mut r = RUNTIME.lock().map_err(|_| "plugin-state-busy")?;
            r.attempts = 0;
            r.retry = None;
            match start_runtime(app, &p, &s, &mut r) {
                Ok(()) => {
                    launch_monitor(app.clone());
                    Ok(())
                }
                Err(e) => {
                    r.phase = "failed";
                    r.error = Some(e.clone());
                    Err(e)
                }
            }
        }
        "disconnect" => stop_runtime(&mut *RUNTIME.lock().map_err(|_| "plugin-state-busy")?),
        _ => Err("operation-denied".into()),
    }
}
pub(crate) fn initialize(app: tauri::AppHandle) {
    // Optional feature must never delay ordinary desktop startup or require a download.
    std::thread::spawn(move || {
        let Ok(p) = paths(&app) else {
            return;
        };
        let Ok(s) = settings(&p) else {
            return;
        };
        if !s.connect_on_launch || s.version.is_none() {
            return;
        }
        let Ok(_writer) = ACTION.lock() else {
            return;
        };
        let Ok(mut r) = RUNTIME.lock() else {
            return;
        };
        if let Err(e) = start_runtime(&app, &p, &s, &mut r) {
            r.phase = "failed";
            r.error = Some(e);
        } else {
            launch_monitor(app);
        }
    });
}
pub(crate) fn shutdown() {
    EXITING.store(true, Ordering::Release);
    if let Ok(mut r) = RUNTIME.try_lock() {
        let _ = stop_runtime(&mut r);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn windows_private_store_roundtrip_and_replacement_use_dpapi() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("中文 连接");
        let p = Paths { helper: temp.path().join("store.ps1"), secret: root.join("private"),
            state: root.join("settings.json"), connection: root.join("connection.json"),
            health: root.join("health-url.txt"), activity: root.join("web-activity.json"), root };
        initialize_storage(&p).unwrap();
        for value in ["synthetic-not-a-real-key-中文", "synthetic-replacement-key"] {
            secret(&p, "write", "tunnel-key", Some(value.as_bytes())).unwrap();
            assert_eq!(secret(&p, "read", "tunnel-key", None).unwrap(), value);
            assert!(!fs::read_to_string(p.secret.join("tunnel-key.dpapi")).unwrap().contains(value));
        }
        secret(&p, "remove", "tunnel-key", None).unwrap();
        assert!(!p.secret.join("tunnel-key.dpapi").exists());
    }
    #[test]
    #[cfg(windows)]
    #[ignore = "Requires the verified distribution ZIP; isolated upgrade acceptance only"]
    fn distribution_upgrade_preserves_existing_authority_and_ciphertext() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("已配置 中文插件");
        let p = Paths { helper: temp.path().join("store.ps1"), secret: root.join("private"),
            state: root.join("settings.json"), connection: root.join("connection.json"),
            health: root.join("health-url.txt"), activity: root.join("web-activity.json"), root };
        initialize_storage(&p).unwrap();
        secret(&p, "write", "tunnel-key", Some(b"synthetic-distribution-test-only")).unwrap();
        secret(&p, "write", "credential", Some(b"synthetic-scoped-credential-only")).unwrap();
        fs::write(&p.connection, br#"{"synthetic":true,"libraryId":"isolated-library","vaultId":"isolated-vault"}"#).unwrap();
        let connection = fs::read(&p.connection).unwrap();
        let key = fs::read(p.secret.join("tunnel-key.dpapi")).unwrap();
        let credential = fs::read(p.secret.join("credential.dpapi")).unwrap();
        let mut s = Settings { version: Some("0.1.0".into()),
            tunnel_id: Some("tunnel_0123456789abcdef0123456789abcdef".into()), connect_on_launch: true,
            binding: Some(Binding { client_id:"isolated-client".into(), library_id:"isolated-library".into(),
                vault_id:"isolated-vault".into(), expires_at: now()+86400 }) };
        let mut expected = s.clone();
        expected.version = Some(package::catalog().unwrap().version);
        package::write_json(&p.state, &s).unwrap();
        install_package(&p, &mut s).unwrap();
        assert_eq!(serde_json::to_value(settings(&p).unwrap()).unwrap(), serde_json::to_value(expected).unwrap());
        assert_eq!(fs::read(&p.connection).unwrap(), connection);
        assert_eq!(fs::read(p.secret.join("tunnel-key.dpapi")).unwrap(), key);
        assert_eq!(fs::read(p.secret.join("credential.dpapi")).unwrap(), credential);
        assert_eq!(secret(&p, "read", "tunnel-key", None).unwrap(), "synthetic-distribution-test-only");
        assert_eq!(secret(&p, "read", "credential", None).unwrap(), "synthetic-scoped-credential-only");
    }
    #[test]
    fn tunnel_identity_is_exact() {
        assert!(valid_tunnel_id("tunnel_0123456789abcdef0123456789abcdef"));
        // Official pinned runtime accepts all lowercase ASCII letters/digits,
        // not just hexadecimal characters (runtimeconfig/config.go).
        assert!(valid_tunnel_id(&format!("tunnel_{}", "g".repeat(32))));
        for value in ["g".repeat(31), "g".repeat(33), "G".repeat(32), "_".repeat(32)] {
            assert!(!valid_tunnel_id(&format!("tunnel_{value}")));
        }
        for s in [
            "tunnel_123",
            "https://example.com",
            "tunnel_ABCDEF0123456789abcdef0123456789",
        ] {
            assert!(!valid_tunnel_id(s));
        }
    }
    #[test]
    fn revision_changes_with_authority_settings() {
        let mut s = Settings::default();
        let old = revision(&s);
        s.connect_on_launch = true;
        assert_ne!(old, revision(&s));
    }
}
