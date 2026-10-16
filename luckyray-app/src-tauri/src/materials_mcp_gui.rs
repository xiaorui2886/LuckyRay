//! GUI-only installation of the existing scoped MCP client. No HTTP authorization
//! bootstrap, shell command interpolation, native master credential, or database access.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
use zeroize::Zeroize;

static WRITER: Mutex<()> = Mutex::new(());
const NODE_SHA: &str = "995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362";
const LICENSE_SHA: &str = "339c50294da6a84322dcbe7285b57b248123bd4d9e37a2f72d68d5abf2574783";
const STORE: &str = include_str!("../../packages/materials-mcp/src/store-gui-pairing.ps1");
const FILES: &[(&str, &[u8])] = &[
    (
        "server.mjs",
        include_bytes!("../../packages/materials-mcp/src/server.mjs"),
    ),
    (
        "transport.mjs",
        include_bytes!("../../packages/materials-mcp/src/transport.mjs"),
    ),
    (
        "materials.mjs",
        include_bytes!("../../packages/materials-mcp/src/materials.mjs"),
    ),
    (
        "verify-profile.ps1",
        include_bytes!("../../packages/materials-mcp/src/verify-profile.ps1"),
    ),
    (
        "read-credential.ps1",
        include_bytes!("../../packages/materials-mcp/src/read-credential.ps1"),
    ),
];
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn safe_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("local-path-required".into());
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        // Tauri's resource directory can be a canonical \\?\C:\... path.
        // Accept only drive paths, including that spelling; UNC and device
        // namespaces remain forbidden, and all ancestors are checked below.
        match path.components().next() {
            Some(Component::Prefix(p))
                if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) => {}
            _ => return Err("local-path-required".into()),
        }
    }
    for parent in path.ancestors() {
        match fs::symlink_metadata(parent) {
            Ok(meta) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err("linked-path-refused".into());
                    }
                }
                if meta.file_type().is_symlink() {
                    return Err("linked-path-refused".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("path-unavailable".into()),
        }
    }
    Ok(())
}
fn small_read(path: &Path) -> Result<String, String> {
    safe_path(path)?;
    if !path.exists() {
        return Ok(String::new());
    }
    if fs::metadata(path).map_err(|_| "file-unavailable")?.len() > 2 * 1024 * 1024 {
        return Err("file-too-large".into());
    }
    fs::read_to_string(path).map_err(|_| "file-unavailable".into())
}
fn new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    safe_path(path)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "file-create-failed")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "file-save-failed".into())
}
fn immutable_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    safe_path(path)?;
    if path.exists() {
        if fs::read(path).map_err(|_| "runtime-unavailable")? != bytes {
            return Err("runtime-integrity-mismatch".into());
        }
        Ok(())
    } else {
        new_file(path, bytes)
    }
}
pub(crate) fn run(
    exe: &Path,
    args: &[String],
    input: Option<&[u8]>,
    seconds: u64,
) -> Result<(bool, String, String), String> {
    let mut command = Command::new(exe);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|_| "client-process-start-failed")?;
    if let Some(mut stdin) = child.stdin.take() {
        if let Some(bytes) = input {
            if stdin.write_all(bytes).is_err() {
                let _ = child.kill();
                let _ = child.wait();
                return Err("client-input-failed".into());
            }
        }
    }
    let stdout = child.stdout.take().ok_or("client-output-failed")?;
    let stderr = child.stderr.take().ok_or("client-output-failed")?;
    let out = std::thread::spawn(move || {
        let mut b = String::new();
        let _ = stdout.take(65536).read_to_string(&mut b);
        b
    });
    let err = std::thread::spawn(move || {
        let mut b = String::new();
        let _ = stderr.take(4096).read_to_string(&mut b);
        b
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("client-process-failed".into());
            }
        }
        if start.elapsed() > Duration::from_secs(seconds) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("client-check-timeout".into());
        }
        std::thread::sleep(Duration::from_millis(30));
    };
    Ok((
        status.success(),
        out.join().unwrap_or_default(),
        err.join().unwrap_or_default(),
    ))
}
#[derive(Clone)]
struct Paths {
    root: PathBuf,
    config: PathBuf,
    runtime: PathBuf,
    helper: PathBuf,
    key: String,
}
fn paths(app: &tauri::AppHandle) -> Result<Paths, String> {
    let transport = app.state::<crate::local_transport::LocalTransportHandle>();
    let profile = transport.materials_profile_root()?;
    let key = format!(
        "luckyray_materials_{}",
        &hash(profile.to_lowercase().as_bytes())[..12]
    );
    let local = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "local-data-unavailable")?;
    let root = local.join("materials-mcp-gui-v1");
    let home = match std::env::var_os("CODEX_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => app
            .path()
            .home_dir()
            .map_err(|_| "home-unavailable")?
            .join(".codex"),
    };
    let config = home.join("config.toml");
    safe_path(&root)?;
    safe_path(&config)?;
    let resource = app
        .path()
        .resource_dir()
        .map_err(|_| "runtime-unavailable")?;
    let mut runtime = resource.join("deepseek-harness/node");
    #[cfg(debug_assertions)]
    if !runtime.join("node.exe").is_file() {
        runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dsh/node");
    }
    Ok(Paths {
        root,
        config,
        runtime,
        helper: local.join("materials-mcp-store-gui-v1.ps1"),
        key,
    })
}
fn runtime_verify(p: &Paths) -> Result<(), String> {
    for (name, expected) in [("node.exe", NODE_SHA), ("LICENSE", LICENSE_SHA)] {
        let file = p.runtime.join(name);
        safe_path(&file)?;
        if hash(&fs::read(file).map_err(|_| "bundled-runtime-missing")?) != expected {
            return Err("runtime-integrity-mismatch".into());
        }
    }
    Ok(())
}
fn ps_store(p: &Paths, input: Option<&[u8]>) -> Result<(), String> {
    let mut args = vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-File".into(),
        p.helper.to_string_lossy().into_owned(),
        "-Directory".into(),
        p.root.to_string_lossy().into_owned(),
    ];
    if input.is_none() {
        args.push("-InitializeOnly".into());
    }
    let exe = PathBuf::from(std::env::var_os("SystemRoot").ok_or("windows-runtime-missing")?)
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    if !run(&exe, &args, input, 20)?.0 {
        return Err("private-binding-save-failed".into());
    }
    Ok(())
}
fn provision(p: &Paths) -> Result<(), String> {
    runtime_verify(p)?;
    fs::create_dir_all(p.helper.parent().ok_or("path-unavailable")?)
        .map_err(|_| "local-data-unavailable")?;
    immutable_file(&p.helper, STORE.as_bytes())?;
    ps_store(p, None)?;
    for (name, bytes) in FILES {
        immutable_file(&p.root.join(name), bytes)?;
    }
    for name in ["node.exe", "LICENSE"] {
        immutable_file(
            &p.root.join(name),
            &fs::read(p.runtime.join(name)).map_err(|_| "runtime-unavailable")?,
        )?;
    }
    Ok(())
}
fn block(p: &Paths) -> String {
    let quote = |v: &Path| toml::Value::String(v.to_string_lossy().into_owned()).to_string();
    format!("\n# LuckyRay managed {} begin\n[mcp_servers.{}]\ncommand = {}\nargs = [{}, \"--config\", {}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 180\n# LuckyRay managed {} end\n",p.key,p.key,quote(&p.root.join("node.exe")),quote(&p.root.join("server.mjs")),quote(&p.root.join("connection.json")),p.key)
}
fn add_block(old: &str, p: &Paths) -> Result<String, String> {
    let before = old
        .parse::<toml::Value>()
        .map_err(|_| "client-config-invalid")?;
    if before
        .get("mcp_servers")
        .and_then(|v| v.get(&p.key))
        .is_some()
    {
        return Err("client-entry-exists".into());
    }
    let result = format!("{old}{}", block(p));
    let mut after = result
        .parse::<toml::Value>()
        .map_err(|_| "client-config-shape-unsupported")?;
    if let Some(t) = after.get_mut("mcp_servers").and_then(|v| v.as_table_mut()) {
        t.remove(&p.key);
    }
    if before.get("mcp_servers").is_none() {
        after
            .as_table_mut()
            .ok_or("client-config-invalid")?
            .remove("mcp_servers");
    }
    if before != after {
        return Err("client-config-preservation-failed".into());
    }
    Ok(result)
}
// Deny concurrent writes/deletes on Windows while compare/write/rollback runs.
// Never replace the entire file on disconnect: remove only our exact owned block.
fn change_config(path: &Path, expected: &str, next: &str) -> Result<(), String> {
    safe_path(path)?;
    fs::create_dir_all(path.parent().ok_or("client-config-unavailable")?)
        .map_err(|_| "client-config-unavailable")?;
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if path.exists() {
        options.create(false);
    } else {
        options.create_new(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let mut f = options.open(path).map_err(|_| "client-config-busy")?;
    let mut current = String::new();
    Read::by_ref(&mut f)
        .take(2 * 1024 * 1024 + 1)
        .read_to_string(&mut current)
        .map_err(|_| "client-config-unavailable")?;
    if current != expected {
        return Err("client-config-changed-review-again".into());
    }
    let write = |file: &mut File, bytes: &[u8]| -> std::io::Result<()> {
        file.seek(SeekFrom::Start(0))?;
        file.write_all(bytes)?;
        file.set_len(bytes.len() as u64)?;
        file.sync_all()
    };
    if write(&mut f, next.as_bytes()).is_err() {
        if write(&mut f, current.as_bytes()).is_err() {
            return Err("client-config-restore-required".into());
        }
        return Err("client-config-write-failed-restored".into());
    }
    Ok(())
}
fn record(p: &Paths) -> Result<Option<Value>, String> {
    let text = small_read(&p.root.join("binding.json"))?;
    if text.is_empty() {
        Ok(None)
    } else {
        serde_json::from_str(&text)
            .map(Some)
            .map_err(|_| "binding-record-invalid".into())
    }
}
fn prepare(app: &tauri::AppHandle) -> Result<Value, String> {
    let p = paths(app)?;
    runtime_verify(&p)?;
    let old = small_read(&p.config)?;
    let existing = record(&p)?;
    if existing.is_none() {
        add_block(&old, &p)?;
    }
    Ok(
        json!({"client":"Codex","configPath":p.config,"configHash":hash(old.as_bytes()),"serverKey":p.key,"runtimeReady":true,"binding":existing,"configPresent":old.contains(&block(&p))}),
    )
}
#[tauri::command]
pub(crate) async fn materials_mcp_client_prepare(
    caller: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    crate::require_main_caller(&caller)?;
    tauri::async_runtime::spawn_blocking(move || prepare(&app))
        .await
        .map_err(|_| "client-operation-failed".to_owned())?
}
#[tauri::command]
pub(crate) async fn materials_mcp_client_connect(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    library_id: String,
    config_hash: String,
    confirmed: bool,
) -> Result<Value, String> {
    crate::require_main_caller(&caller)?;
    if !confirmed {
        return Err("confirmation-required".into());
    }
    tauri::async_runtime::spawn_blocking(move||{
        let _guard=WRITER.try_lock().map_err(|_|"client-operation-busy")?;
        let p=paths(&app)?; if record(&p)?.is_some(){return Err("binding-exists-revoke-first".into());}
        if ["credential.dpapi","connection.json"].iter().any(|name|p.root.join(name).exists()){return Err("binding-files-exist-review-required".into());}
        crate::material_catalog_for_app(&app)?.for_library(&library_id).map_err(|_|"library-unavailable")?;
        let old=small_read(&p.config)?;if hash(old.as_bytes())!=config_hash{return Err("client-config-changed-review-again".into());}
        let next=add_block(&old,&p)?;
        provision(&p)?;
        // The config backup may contain unrelated secrets; it inherits the private ACL.
        let backup=p.root.join(format!("client-config-before-{}.toml",chrono::Utc::now().timestamp_millis()));
        new_file(&backup,old.as_bytes())?;
        let transport=app.state::<crate::local_transport::LocalTransportHandle>();
        let exe=std::env::current_exe().map_err(|_|"instance-path-unavailable")?;
        let profile=transport.materials_profile_root()?;
        let mut pair=transport.pair_materials("Codex — LuckyRay 素材",&library_id)?;
        pair["desktopExe"]=json!(exe);pair["profileRoot"]=json!(profile);
        pair["profileProofVersion"]=json!(2);
        let id=pair["clientId"].as_str().ok_or("pairing-invalid")?.to_owned();
        let receipt=json!({"clientId":id,"libraryId":library_id,"expiresAt":pair["expiresAt"],"client":"Codex","configPath":p.config,"serverKey":p.key});
        let result=(||{
            // Save public recovery identity first so interruption is visible in GUI.
            new_file(&p.root.join("binding.json"),serde_json::to_string(&receipt).map_err(|_|"binding-invalid")?.as_bytes())?;
            let mut secret=serde_json::to_vec(&pair).map_err(|_|"pairing-invalid")?;
            let saved=ps_store(&p,Some(&secret));secret.zeroize();saved?;
            pair.as_object_mut().ok_or("pairing-invalid")?.remove("credential");
            pair["credentialFile"]=json!(p.root.join("credential.dpapi"));
            new_file(&p.root.join("connection.json"),serde_json::to_string(&pair).map_err(|_|"pairing-invalid")?.as_bytes())?;
            change_config(&p.config,&old,&next)?;
            Ok::<_,String>(receipt)
        })();
        if result.is_err(){
            if transport.revoke_materials(&id).is_err(){return Err("authorization-rollback-required".into());}
            for name in ["credential.dpapi","connection.json","binding.json"]{let _=fs::remove_file(p.root.join(name));}
        }
        result
    }).await.map_err(|_|"client-operation-failed".to_owned())?
}
#[tauri::command]
pub(crate) async fn materials_mcp_client_test(
    caller: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    crate::require_main_caller(&caller)?;
    tauri::async_runtime::spawn_blocking(move||{
        let _guard=WRITER.try_lock().map_err(|_|"client-operation-busy")?;
        let p=paths(&app)?;let binding=record(&p)?.ok_or("not-authorized")?;
        let transport=app.state::<crate::local_transport::LocalTransportHandle>();
        let now=chrono::Utc::now().timestamp();
        if binding["expiresAt"].as_i64().unwrap_or(0)<=now{return Err("pairing-expired".into());}
        if !transport.list_materials_grants()?.iter().any(|g|Some(g.id.as_str())==binding["clientId"].as_str()){return Err("pairing-revoked".into());}
        if !small_read(&p.config)?.contains(&block(&p)){return Err("client-config-changed".into());}
        for (name,bytes) in FILES {immutable_file(&p.root.join(name),bytes)?;}
        if hash(&fs::read(p.root.join("node.exe")).map_err(|_|"bundled-runtime-missing")?)!=NODE_SHA{return Err("runtime-integrity-mismatch".into());}
        let (ok,stdout,stderr)=run(&p.root.join("node.exe"),&[p.root.join("server.mjs").to_string_lossy().into_owned(),"--config".into(),p.root.join("connection.json").to_string_lossy().into_owned(),"--check".into()],None,60)?;
        if !ok {let code=stderr.trim();return Err(if code.len()<80&&code.chars().all(|c|c.is_ascii_lowercase()||c=='-'){code.to_owned()}else{"client-check-failed".into()});}
        let status:Value=serde_json::from_str(&stdout).map_err(|_|"client-response-invalid")?;
        Ok(json!({"desktopReady":status["ready"],"clientLoaded":"not-observed","libraryId":status["libraryId"],"expiresAt":status["expiresAt"]}))
    }).await.map_err(|_|"client-operation-failed".to_owned())?
}
#[tauri::command]
pub(crate) async fn materials_mcp_client_disconnect(
    caller: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    crate::require_main_caller(&caller)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = WRITER.try_lock().map_err(|_| "client-operation-busy")?;
        let p = paths(&app)?;
        let binding = record(&p)?.ok_or("not-authorized")?;
        let id = binding["clientId"]
            .as_str()
            .ok_or("binding-record-invalid")?;
        let transport = app.state::<crate::local_transport::LocalTransportHandle>();
        if transport
            .list_materials_grants()?
            .iter()
            .any(|g| g.id == id)
        {
            transport.revoke_materials(id)?;
        }
        let old = small_read(&p.config)?;
        let owned = block(&p);
        if old.contains(&owned) {
            let next = old.replacen(&owned, "", 1);
            next.parse::<toml::Value>()
                .map_err(|_| "client-config-invalid")?;
            change_config(&p.config, &old, &next)?;
        } else if old
            .parse::<toml::Value>()
            .map_err(|_| "client-config-invalid")?
            .get("mcp_servers")
            .and_then(|v| v.get(&p.key))
            .is_some()
        {
            return Err("revoked-config-edited-remove-entry".into());
        }
        for name in ["credential.dpapi", "connection.json", "binding.json"] {
            let path = p.root.join(name);
            safe_path(&path)?;
            if path.exists() {
                fs::remove_file(path).map_err(|_| "revoked-local-cleanup-required")?;
            }
        }
        Ok(json!({"revoked":true,"configRemoved":true}))
    })
    .await
    .map_err(|_| "client-operation-failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn local_drive_and_canonical_paths_keep_network_and_device_paths_blocked() {
        let t = tempfile::tempdir().unwrap();
        assert!(safe_path(t.path()).is_ok());
        assert!(safe_path(&fs::canonicalize(t.path()).unwrap()).is_ok());
        for path in [r"\\server\share\file", r"\\?\UNC\server\share\file", r"\\.\C:\file", r"C:relative", r"relative"] {
            assert_eq!(safe_path(Path::new(path)), Err("local-path-required".into()));
        }
    }
    fn p(root: &Path) -> Paths {
        Paths {
            root: root.join("中文 空格"),
            config: root.join("config.toml"),
            runtime: root.into(),
            helper: root.join("helper.ps1"),
            key: "luckyray_materials_test".into(),
        }
    }
    #[test]
    fn config_preserves_comments_secrets_and_other_servers() {
        let t = tempfile::tempdir().unwrap();
        let p = p(t.path());
        let old="# retain\nmodel = 'existing'\n[mcp_servers.other]\ncommand='original'\n[mcp_servers.other.env]\nSECRET='synthetic'\n";
        let result = add_block(old, &p).unwrap();
        assert!(result.starts_with(old));
        assert_eq!(result.replacen(&block(&p), "", 1), old);
        assert!(add_block(&result, &p).is_err());
        assert!(result.contains("中文 空格"));
    }
    #[test]
    fn config_refuses_invalid_and_preserves_unrelated_edits() {
        let t = tempfile::tempdir().unwrap();
        let p = p(t.path());
        assert!(add_block("invalid = [", &p).is_err());
        fs::write(&p.config, "# new external edit\n").unwrap();
        assert!(change_config(&p.config, "", "changed").is_err());
        assert_eq!(
            fs::read_to_string(&p.config).unwrap(),
            "# new external edit\n"
        );
    }
    #[test]
    fn connect_then_remove_block_is_exact_roundtrip() {
        let t = tempfile::tempdir().unwrap();
        let p = p(t.path());
        let old = "model = 'keep'\n";
        fs::write(&p.config, old).unwrap();
        let added = add_block(old, &p).unwrap();
        change_config(&p.config, old, &added).unwrap();
        let external = format!("{}\n# another application edit\n", added);
        fs::write(&p.config, &external).unwrap();
        let next = external.replacen(&block(&p), "", 1);
        change_config(&p.config, &external, &next).unwrap();
        assert_eq!(
            fs::read_to_string(&p.config).unwrap(),
            format!("{old}\n# another application edit\n")
        );
    }
    #[test]
    #[cfg(windows)]
    fn bundled_runtime_installs_without_global_node_or_real_grant() {
        let t = tempfile::tempdir().unwrap();
        let mut p = p(t.path());
        p.runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dsh/node");
        provision(&p).unwrap();
        let mut command = Command::new(p.root.join("node.exe"));
        command
            .arg(p.root.join("server.mjs"))
            .arg("--help")
            .env("PATH", "");
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        let output = command.output().unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("Local stdio only"));
        assert!(!p.root.join("credential.dpapi").exists());
        assert!(!p.config.exists());
    }
}
