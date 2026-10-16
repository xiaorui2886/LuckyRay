//! Opt-in debug-only native evidence. Never run the normal application setup.
use crate::{
    extension_broker::{Broker, KnowledgeScope, Scope},
    extension_packages_store::{self as store, Request},
    knowledge::{KnowledgeCreateInput, KnowledgeVaultRegistration},
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
fn sample(root: &Path, text: &str) {
    let package: store::Package = serde_json::from_str(text).unwrap();
    let id = package.manifest.id.clone();
    let r = store::script(&package).unwrap();
    let state = store::manage(root, "1.9.2", Request::List).unwrap();
    let state = store::manage(
        root,
        "1.9.2",
        Request::Install {
            package,
            expected_revision: state.revision,
        },
    )
    .unwrap();
    let grants = r
        .required_permissions
        .into_iter()
        .chain(r.optional_permissions)
        .collect();
    let state = store::manage(
        root,
        "1.9.2",
        Request::Grant {
            id: id.clone(),
            grants,
            expected_revision: state.revision,
        },
    )
    .unwrap();
    store::manage(
        root,
        "1.9.2",
        Request::Enable {
            id,
            expected_revision: state.revision,
        },
    )
    .unwrap();
}
fn run(root: &Path, id: &str, scope: Scope, contribution: &str, action: &str) -> Value {
    let mut b = Broker::default();
    let token = b
        .start(
            root,
            "1.9.2",
            &std::env::current_exe().unwrap(),
            id,
            scope,
            json!({"contribution":contribution,"action":action,"fields":{}}),
        )
        .unwrap();
    let start = Instant::now();
    loop {
        assert!(start.elapsed() < Duration::from_secs(12));
        let message = b.poll(root, "1.9.2", &token).unwrap();
        match message["kind"].as_str() {
            Some("pending") => std::thread::sleep(Duration::from_millis(5)),
            Some("call") => {
                b.dispatch(root, "1.9.2", &token, None, |s, c| {
                    crate::extension_domains::dispatch(root, s, c)
                })
                .unwrap();
            }
            Some("result") => return message,
            _ => panic!("protocol"),
        }
    }
}
pub fn run_domain_fixture() {
    let root = std::env::temp_dir().join(format!(
        "luckyray-v1-native-{:032x}",
        rand::random::<u128>()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let backend = Arc::new(crate::backend::BackendServices::initialize(&root).unwrap());
    assert!(crate::BACKEND_SERVICES.set(backend.clone()).is_ok());
    sample(
        &root,
        include_str!("../../plugin-sdk/examples/palette/example.palette.lrpack.json"),
    );
    sample(
        &root,
        include_str!("../../plugin-sdk/examples/outline/example.outline.lrpack.json"),
    );
    sample(
        &root,
        include_str!("../../plugin-sdk/examples/canvas-export/example.canvas-export.lrpack.json"),
    );
    crate::extension_broker::verify_material_authorization_fixture(&root, &std::env::current_exe().unwrap());
    // Optional Knowledge consent absent: material-only functionality must still work.
    let state = store::manage(&root, "1.9.2", Request::List).unwrap();
    store::manage(
        &root,
        "1.9.2",
        Request::Grant {
            id: "example.palette".into(),
            grants: vec![
                "materials.read".into(),
                "materials.image".into(),
                "materials.tags".into(),
            ],
            expected_revision: state.revision,
        },
    )
    .unwrap();
    let mut assets = Vec::new();
    for mode in ["managed", "source", "linked"] {
        let path = root.join(format!("{mode}.png"));
        image::RgbaImage::from_pixel(8, 8, image::Rgba([200, 40, 60, 255]))
            .save(&path)
            .unwrap();
        backend
            .material_catalog()
            .import_paths(
                &[path],
                &crate::materials::MaterialImportOptions {
                    storage_mode: mode.into(),
                    ..Default::default()
                },
            )
            .unwrap();
    }
    for a in backend
        .material_catalog()
        .list_assets(&Default::default())
        .unwrap()
    {
        assets.push(a.id);
    }
    assert_eq!(assets.len(), 3);
    let scope = Scope {
        material_ids: assets.clone(),
        writes: true,
        ..Default::default()
    };
    let palette = run(&root, "example.palette", scope.clone(), "palette", "run");
    assert_eq!(palette["result"]["ok"], true, "{palette}");
    assert!(palette["result"]["value"]["text"]
        .as_str()
        .unwrap()
        .contains("#c8283c"));
    let tagged = run(&root, "example.palette", scope.clone(), "palette", "tags");
    assert_eq!(tagged["result"]["ok"], true, "{tagged}");
    for id in &assets {
        assert!(!backend
            .material_catalog()
            .get_asset_tags(id)
            .unwrap()
            .is_empty());
    }
    let vault = root.join("vault");
    std::fs::create_dir_all(vault.join(".luckyray")).unwrap();
    let registration = KnowledgeVaultRegistration {
        id: "fixture-vault".into(),
        name: "Fixture".into(),
        root_path: vault.to_string_lossy().to_string(),
        mode: "vault-bound".into(),
        created_at: "2026-09-17T00:00:00Z".into(),
        last_opened_at: "2026-09-17T00:00:00Z".into(),
        schema_version: 1,
        link_update_policy: Default::default(),
    };
    std::fs::write(
        vault.join(".luckyray/vault.json"),
        serde_json::to_vec(&registration).unwrap(),
    )
    .unwrap();
    let knowledge = backend.knowledge();
    knowledge.register_current_vault(&registration).unwrap();
    let active = knowledge.activate_ui_source(&registration.id).unwrap();
    let note = knowledge
        .create_document_from_ui(
            active.source_epoch,
            &KnowledgeCreateInput {
                title: "Seed".into(),
                content: "# Evidence\n\nFirst finding\nSecond finding".into(),
                parent_relative_path: None,
            },
        )
        .unwrap();
    let scope = Scope {
        writes: true,
        knowledge: Some(KnowledgeScope {
            allow_create: true,
            vault_id: registration.id.clone(),
            source_epoch: active.source_epoch,
            documents: vec![note.summary.relative_path.clone()],
            parent_relative_path: None,
        }),
        ..Default::default()
    };
    let created = run(&root, "example.outline", scope.clone(), "outline", "create");
    assert_eq!(created["result"]["ok"], true, "{created}");
    assert!(
        std::fs::read_dir(&vault)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|e| e == "md"))
            .count()
            >= 2
    );
    let inserted = run(&root, "example.outline", scope.clone(), "outline", "insert");
    assert_eq!(inserted["result"]["ok"], true, "{inserted}");
    let body = std::fs::read_to_string(vault.join(&note.summary.relative_path)).unwrap();
    assert!(body.contains("结构提纲"));
    knowledge
        .companion_set_desktop_drafts(
            active.source_epoch,
            1,
            vec![note.summary.relative_path.clone()],
        )
        .unwrap();
    let dirty = run(&root, "example.outline", scope.clone(), "outline", "insert");
    assert_eq!(dirty["result"]["ok"], false);
    assert_eq!(
        body,
        std::fs::read_to_string(vault.join(&note.summary.relative_path)).unwrap()
    );
    knowledge
        .companion_set_desktop_drafts(active.source_epoch, 2, vec![])
        .unwrap();
    let mut cross = scope.clone();
    cross.material_ids = assets;
    let denied_cross = run(&root, "example.palette", cross.clone(), "palette", "note");
    assert_eq!(denied_cross["result"]["ok"], false);
    let state = store::manage(&root, "1.9.2", Request::List).unwrap();
    store::manage(
        &root,
        "1.9.2",
        Request::Grant {
            id: "example.palette".into(),
            grants: vec![
                "materials.read".into(),
                "materials.image".into(),
                "materials.tags".into(),
                "knowledge.create".into(),
            ],
            expected_revision: state.revision,
        },
    )
    .unwrap();
    let crossed = run(&root, "example.palette", cross, "palette", "note");
    assert_eq!(crossed["result"]["ok"], true, "{crossed}");
    knowledge.activate_ui_source(&registration.id).unwrap();
    let stale = run(&root, "example.outline", scope, "outline", "create");
    assert_eq!(stale["result"]["ok"], false);
    let canvas:crate::canvas_agent::CanvasDocument=serde_json::from_value(json!({"schema_version":1,"canvas_id":"fixture-graph","name":"Graph <safe>","created_at":"2026-09-17","updated_at":"2026-09-17","nodes":[{"id":"a","type":"text","position":{"x":0,"y":0},"data":{"title":"Start"}},{"id":"b","type":"text","position":{"x":250,"y":120},"data":{"title":"End"}}],"edges":[{"id":"ab","source":"a","target":"b"}],"viewport":{"x":0,"y":0,"zoom":1},"generation_history":[]})).unwrap();
    backend.canvas_agent().create_normal_canvas(canvas).unwrap();
    let export = root.join("graph.svg");
    let graph = run(
        &root,
        "example.canvas-export",
        Scope {
            canvas_ids: vec!["fixture-graph".into()],
            writes: true,
            export_path: Some(export.to_string_lossy().to_string()),
            ..Default::default()
        },
        "export",
        "export",
    );
    assert_eq!(graph["result"]["ok"], true, "{graph}");
    let svg = std::fs::read_to_string(&export).unwrap();
    assert!(
        svg.contains("Graph &lt;safe&gt;")
            && svg.contains("Start")
            && svg.contains("End")
            && svg.contains("marker-end")
    );
    let report = json!({"root":root,"passed":["three material storage modes image pixel read","real catalog tag writes","real note create and insert","native dirty and stale source refusal","optional Knowledge absent preserves material-only work; cross-module denied until separately granted","real saved canvas SVG export"],"runtime":"actual application child process and production domain services","webview":"not part of this native fixture"});
    std::fs::write(
        root.join("report.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{report}");
}

#[tauri::command]
pub(crate) fn extension_fixture_done(app: tauri::AppHandle, report: Value) {
    use tauri::Manager;
    let root = app.path().app_data_dir().unwrap();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("webview-report.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{}", json!({"root":root,"report":report}));
    app.exit(if report["ok"] == true { 0 } else { 1 });
}
pub fn run_webview_fixture() {
    use tauri::Manager;
    let script =
        std::fs::read_to_string(std::env::args().nth(2).expect("fixture JS bundle required"))
            .unwrap();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "com.luckyray.extensionfixture.p{:032x}",
        rand::random::<u128>()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    let html=format!("<!doctype html><meta charset=utf-8><title>Extension IPC fixture</title><script>{}</script>",script.replace("</script>",r"<\/script>"));
    tauri::Builder::default()
        .register_uri_scheme_protocol("fixture", move |_, _| {
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(html.clone().into_bytes())
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            crate::extension_packages::manage_extension_packages,
            crate::extension_runtime::extension_runtime,
            extension_fixture_done
        ])
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            std::fs::create_dir_all(&root)?;
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External("fixture://localhost/".parse().unwrap()),
            )
            .visible(false)
            .data_directory(root.join("webview"))
            .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(45));
                eprintln!("WebView fixture timed out");
                handle.exit(2);
            });
            Ok(())
        })
        .run(context)
        .expect("WebView fixture failed");
}

// ---------------------------------------------------------------------------
// Community fixture: the production Community surface on a fresh, random,
// fixture-only profile. Compiled only for debug + `extension-runtime-fixture`;
// never routed through `run()`/`setup()`, never reads or writes a real profile.
// ---------------------------------------------------------------------------
pub struct CommunityFixture {
    pub assets: PathBuf,
    pub identifier: String,
    pub timeout: Duration,
}
const FIXTURE_IDENTIFIER_PREFIX: &str = "com.luckyray.extensionfixture.p";
/// Content-Security-Policy for the served page: Tauri IPC only. Any ordinary
/// HTTP(S) request — including the localApi fallback to a daily backend port —
/// is refused by the WebView and reported through `extension_fixture_csp_violation`.
/// Tauri serves custom schemes as `http://<scheme>.localhost` on Windows and `<scheme>://localhost` elsewhere; both spellings are listed.
const FIXTURE_CSP: &str = "default-src 'none'; script-src http://fixture.localhost fixture://localhost 'unsafe-inline'; style-src http://fixture.localhost fixture://localhost 'unsafe-inline'; img-src http://fixture.localhost fixture://localhost data: blob:; font-src http://fixture.localhost fixture://localhost data:; connect-src ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
pub fn community_fixture_config() -> Result<CommunityFixture, String> {
    let assets = PathBuf::from(
        std::env::args()
            .nth(2)
            .ok_or("usage: --extension-community-fixture <assets-dir> (index.html + app.js)")?,
    );
    if !assets.join("index.html").is_file() || !assets.join("app.js").is_file() {
        return Err(format!(
            "community fixture assets missing index.html/app.js in {}",
            assets.display()
        ));
    }
    let assets = assets.canonicalize().map_err(|e| e.to_string())?;
    if let Ok(profile) = std::env::var(crate::runtime_profile::PROFILE_ENV) {
        if matches!(profile.trim(), "development" | "production") {
            return Err(format!(
                "{}={} refused: the community fixture never runs inside a real profile shell",
                crate::runtime_profile::PROFILE_ENV,
                profile.trim()
            ));
        }
    }
    let timeout = std::env::var("LUCKYRAY_FIXTURE_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|s| s.clamp(30, 7200))
        .unwrap_or(1800);
    // Tests may pin the nonce (still under the fixture prefix) to prove that an
    // existing root is refused; production/development identifiers can never result.
    let nonce = std::env::var("LUCKYRAY_FIXTURE_NONCE")
        .ok()
        .filter(|v| v.len() == 32 && v.chars().all(|c| c.is_ascii_hexdigit()))
        .unwrap_or_else(|| format!("{:032x}", rand::random::<u128>()));
    Ok(CommunityFixture {
        assets,
        identifier: format!("{FIXTURE_IDENTIFIER_PREFIX}{nonce}"),
        timeout: Duration::from_secs(timeout),
    })
}
fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}
/// Serves only files inside the assets directory; every response carries the fixture CSP.
pub fn serve_fixture_asset(
    assets: &Path,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let requested = request.uri().path().trim_start_matches('/');
    let requested = if requested.is_empty() { "index.html" } else { requested };
    let file = assets.join(requested);
    let body = file
        .canonicalize()
        .ok()
        .filter(|resolved| resolved.starts_with(assets) && resolved.is_file())
        .and_then(|resolved| std::fs::read(&resolved).ok().map(|bytes| (resolved, bytes)));
    match body {
        Some((resolved, bytes)) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", content_type(&resolved))
            .header("Content-Security-Policy", FIXTURE_CSP)
            .header("Cache-Control", "no-store")
            .body(bytes)
            .unwrap(),
        None => tauri::http::Response::builder()
            .status(404)
            .header("Content-Security-Policy", FIXTURE_CSP)
            .body(b"fixture asset not found".to_vec())
            .unwrap(),
    }
}
fn seed_community_data(root: &Path, backend: &crate::backend::BackendServices) -> Result<Value, String> {
    let mut materials = Vec::new();
    for (name, mode, rgba) in [
        ("fixture-hero.png", "managed", [200u8, 40, 60, 255]),
        ("fixture-logo.png", "managed", [40u8, 90, 200, 255]),
        ("fixture-linked.png", "linked", [40u8, 160, 80, 255]),
    ] {
        let path = root.join("seed").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        image::RgbaImage::from_pixel(16, 16, image::Rgba(rgba))
            .save(&path)
            .map_err(|e| e.to_string())?;
        backend
            .material_catalog()
            .import_paths(
                &[path],
                &crate::materials::MaterialImportOptions {
                    storage_mode: mode.into(),
                    ..Default::default()
                },
            )
            .map_err(|e| format!("{e:?}"))?;
    }
    for asset in backend
        .material_catalog()
        .list_assets(&Default::default())
        .map_err(|e| format!("{e:?}"))?
    {
        materials.push(json!({"id":asset.id,"name":asset.name}));
    }
    let vault = root.join("vault");
    std::fs::create_dir_all(vault.join(".luckyray")).map_err(|e| e.to_string())?;
    let registration = KnowledgeVaultRegistration {
        id: "fixture-vault".into(),
        name: "Fixture vault".into(),
        root_path: vault.to_string_lossy().to_string(),
        mode: "vault-bound".into(),
        created_at: "2026-09-17T00:00:00Z".into(),
        last_opened_at: "2026-09-17T00:00:00Z".into(),
        schema_version: 1,
        link_update_policy: Default::default(),
    };
    std::fs::write(
        vault.join(".luckyray/vault.json"),
        serde_json::to_vec(&registration).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let knowledge = backend.knowledge();
    knowledge
        .register_current_vault(&registration)
        .map_err(|e| format!("{e:?}"))?;
    let active = knowledge
        .activate_ui_source(&registration.id)
        .map_err(|e| format!("{e:?}"))?;
    let note = knowledge
        .create_document_from_ui(
            active.source_epoch,
            &KnowledgeCreateInput {
                title: "Fixture seed".into(),
                content: "# Fixture seed\n\nIsolated note for plugin tests.".into(),
                parent_relative_path: None,
            },
        )
        .map_err(|e| format!("{e:?}"))?;
    Ok(json!({
        "materials": materials,
        "vault": {"id": registration.id, "root": vault},
        "seedNote": note.summary.relative_path,
    }))
}
/// Fresh-root guard + isolated domain services + visible fixture window. Nothing here
/// touches DSH, browser broker, companion gateway, tray or LocalTransport.
pub fn community_fixture_setup(
    app: &mut tauri::App,
    fixture: &CommunityFixture,
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    let identifier = app.config().identifier.clone();
    if identifier != fixture.identifier
        || !identifier.starts_with(FIXTURE_IDENTIFIER_PREFIX)
        || identifier == crate::runtime_profile::DEVELOPMENT_IDENTIFIER
        || identifier == crate::runtime_profile::PRODUCTION_IDENTIFIER
    {
        return Err(format!("community fixture identifier refused: {identifier}").into());
    }
    let root = app.path().app_data_dir()?;
    if root.file_name().and_then(|n| n.to_str()) != Some(identifier.as_str()) {
        return Err(format!("fixture root does not end with its identifier: {}", root.display()).into());
    }
    if root.exists() {
        return Err(format!("fixture root already exists, refusing to reuse it: {}", root.display()).into());
    }
    let parent = root.parent().ok_or("fixture root has no parent")?;
    if std::fs::symlink_metadata(parent)?.file_type().is_symlink() {
        return Err("fixture parent directory is a reparse point; refusing".into());
    }
    for real in [
        crate::runtime_profile::DEVELOPMENT_IDENTIFIER,
        crate::runtime_profile::PRODUCTION_IDENTIFIER,
    ] {
        if root.starts_with(parent.join(real)) {
            return Err("fixture root would live inside a real profile; refusing".into());
        }
    }
    // Atomic leaf creation: a root that appeared between the check and here is refused too.
    std::fs::create_dir(&root).map_err(|e| format!("fixture root could not be created exclusively ({}): {e}", root.display()))?;
    let backend = Arc::new(
        crate::backend::BackendServices::initialize(&root).map_err(|e| format!("{e:?}"))?,
    );
    crate::BACKEND_SERVICES
        .set(backend.clone())
        .map_err(|_| "backend services already initialized")?;
    let seeded = seed_community_data(&root, &backend)?;
    let webview_dir = root.join("webview");
    let manifest = json!({
        "kind": "luckyray-extension-community-fixture",
        "identifier": identifier,
        "root": root,
        "webviewDataDirectory": webview_dir,
        "executable": std::env::current_exe().ok(),
        "pid": std::process::id(),
        "debugBuild": cfg!(debug_assertions),
        "feature": "extension-runtime-fixture",
        "assets": fixture.assets,
        "hostVersion": app.package_info().version.to_string(),
        "startedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        "timeoutSecs": fixture.timeout.as_secs(),
        "csp": FIXTURE_CSP,
        "seeded": seeded,
        "notStarted": ["dsh-host", "browser-broker", "companion-gateway", "local-transport", "tray", "canvas-generation", "cli-sidecar", "lsh"],
    });
    std::fs::write(root.join("fixture-manifest.json"), serde_json::to_vec_pretty(&manifest)?)?;
    println!("{}", json!({"event":"community-fixture-ready","identifier":identifier,"root":root}));
    let short = &identifier[identifier.len().saturating_sub(8)..];
    tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::External("fixture://localhost/index.html".parse().unwrap()),
    )
    .title(format!("LuckyRay 插件隔离测试实例 · {short}"))
    .inner_size(1120.0, 900.0)
    .visible(true)
    .data_directory(webview_dir)
    .build()?;
    let handle = app.handle().clone();
    let timeout = fixture.timeout;
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        eprintln!("community fixture timed out after {}s", timeout.as_secs());
        handle.exit(2);
    });
    Ok(())
}
fn fixture_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !root
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with(FIXTURE_IDENTIFIER_PREFIX))
    {
        return Err("not a fixture root".into());
    }
    Ok(root)
}
#[tauri::command]
pub(crate) async fn extension_fixture_add_child(app: tauri::AppHandle, caller: tauri::Webview) -> Result<(), String> {
    use tauri::Manager;
    let root = fixture_root(&app)?;
    if caller.label() != "main" { return Err("fixture-main-required".into()); }
    let window = app.get_window("main").ok_or("fixture-main-missing")?;
    let child = window.add_child(
        tauri::webview::WebviewBuilder::new("fixture-native-child", tauri::WebviewUrl::External("fixture://localhost/child.html".parse().unwrap()))
            .data_directory(root.join("child-webview")),
        tauri::LogicalPosition::new(0.0, 0.0), tauri::LogicalSize::new(1.0, 1.0),
    ).map_err(|e| e.to_string())?;
    child.hide().map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub(crate) fn extension_fixture_status(app: tauri::AppHandle) -> Result<Value, String> {
    let root = fixture_root(&app)?;
    let text = std::fs::read_to_string(root.join("fixture-manifest.json")).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn extension_fixture_report(app: tauri::AppHandle, name: String, report: Value) -> Result<String, String> {
    let root = fixture_root(&app)?;
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("report name must be [A-Za-z0-9-]{1,64}".into());
    }
    let dir = root.join("reports");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}
#[tauri::command]
pub(crate) fn extension_fixture_csp_violation(app: tauri::AppHandle, detail: Value) -> Result<(), String> {
    use std::io::Write;
    let root = fixture_root(&app)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("csp-violations.log"))
        .map_err(|e| e.to_string())?;
    writeln!(file, "{detail}").map_err(|e| e.to_string())
}
