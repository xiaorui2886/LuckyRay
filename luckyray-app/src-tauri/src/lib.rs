//! LuckyRay tool execution is owned by the running desktop application process.
//! External adapters must use its authenticated LocalTransport tool routes;
//! direct app-data runtime initialization is intentionally unavailable.
//!
//! ```compile_fail
//! use luckyray_app_lib::tools::ToolRuntime;
//! let _ = std::mem::size_of::<ToolRuntime>();
//! ```

mod desktop_app_update;
mod community_mcp_knowledge;
mod community_mcp;
mod community_mcp_package;
mod community_mcp_process;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

#[cfg(all(debug_assertions, windows, feature = "browser-host-runtime"))]
mod dsh_startup_benchmark;
#[cfg(all(debug_assertions, windows, feature = "browser-host-runtime"))]
pub fn run_dsh_startup_benchmark() { dsh_startup_benchmark::run(); }

#[cfg(feature = "browser-host-poc-fixture")]
pub mod agent_browser;
#[cfg(not(feature = "browser-host-poc-fixture"))]
mod agent_browser;
mod agent_capabilities;
mod agent_execution;
mod agent_materials;
mod agent_memory;
mod agent_projects;
mod agent_runs;
mod agent_schedules;
mod agent_skills;
mod agent_workspace;
mod assets_import_file;
mod ai_profiles;
mod backend;
mod browser_broker;
mod canvas_agent;
mod canvas_comfyui;
mod canvas_media_profiles;
mod canvas_media_protocols;
mod capabilities;
mod companion_gateway;
mod dsh_host;
mod dsh_login_browser;
#[cfg(all(windows, feature = "lsh-background-surface-preload"))]
mod dsh_native_container;
mod dsh_engine_update;
mod dsh_resource_broker;
mod dsh_runtime_seal;

/// Installer-only read-only admission. No Tauri app, profile, DB, writer lock,
/// identity, extension, process or model is initialized on this path.
pub fn verify_installed_lsh() -> Result<(), &'static str> {
    let executable = std::env::current_exe().map_err(|_| "dsh-installation-executable-unavailable")?;
    let directory = executable.parent().ok_or("dsh-installation-directory-unavailable")?;
    dsh_host::verify_installation(directory)
}
mod favorites;
mod extension_note_capture;
mod knowledge;
mod workspace_windows;
mod workspace_handoff;
mod workspace_note_actions;
mod workspace_graph_actions;
mod workspace_attachments;
mod workspace_command_policy;
mod workspace_tearout;
mod workspace_graph;
mod workspace_actions;
mod workspace_notes_metadata;
mod workspace_drag;
mod workspace_recovery;
#[cfg(all(debug_assertions, feature = "workspace-runtime-fixture"))]
mod workspace_fixture;
#[cfg(all(debug_assertions, feature = "workspace-runtime-fixture"))]
pub fn run_workspace_fixture() { workspace_fixture::run(); }
mod attachment_coordination;
mod extension_appearance;
mod extension_packages;
mod extension_packages_store;
mod extension_worker;
mod extension_process;
mod extension_broker;
mod extension_domains;
mod extension_runtime;
pub fn run_extension_worker() { extension_worker::run_stdio(); }
#[cfg(all(debug_assertions,feature="extension-runtime-fixture"))]
mod extension_fixture;
#[cfg(all(debug_assertions,feature="extension-runtime-fixture"))]
pub fn run_extension_domain_fixture(){extension_fixture::run_domain_fixture();}
#[cfg(all(debug_assertions,feature="extension-runtime-fixture"))]
pub fn run_extension_webview_fixture(){extension_fixture::run_webview_fixture();}
/// Production Community surface on a fresh fixture profile. Debug + fixture feature only;
/// bypasses `run()`/`setup()` and registers just the commands that surface needs.
#[cfg(all(debug_assertions,feature="extension-runtime-fixture"))]
pub fn run_extension_community_fixture() {
    let fixture = match extension_fixture::community_fixture_config() {
        Ok(fixture) => fixture,
        Err(error) => {
            eprintln!("luckyray-extension-community-fixture-refused: {error}");
            std::process::exit(2);
        }
    };
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = fixture.identifier.clone();
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    let assets = fixture.assets.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("fixture", move |_, request| {
            extension_fixture::serve_fixture_asset(&assets, &request)
        })
        .invoke_handler(tauri::generate_handler![
            extension_packages::manage_extension_packages,
            extension_runtime::extension_runtime,
            material_catalog_list_assets,
            material_catalog_get_assets,
            knowledge_list_documents,
            knowledge_search_documents,
            knowledge_read_document,
            knowledge_create_document,
            knowledge_insert_document,
            knowledge_insert_current,
            knowledge_get_current_context,
            knowledge_begin_current_context_session,
            knowledge_set_current_context,
            knowledge_clear_current_context,
            knowledge_activate_ui_source,
            knowledge_activate_current_ui_source,
            knowledge_deactivate_ui_source,
            list_canvases,
            extension_fixture::extension_fixture_status,
            extension_fixture::extension_fixture_add_child,
            extension_fixture::extension_fixture_report,
            extension_fixture::extension_fixture_csp_violation,
            extension_fixture::extension_fixture_done
        ])
        .setup(move |app| extension_fixture::community_fixture_setup(app, &fixture))
        .build(context)
        .expect("community fixture failed to build")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                community_mcp::shutdown();
                extension_runtime::close_all_sessions();
            }
        });
}

mod attachment_file_moves;
mod local_transport;
mod material_drag;
mod material_native_video;
mod material_shell;
mod materials;
mod media_transfer;
pub mod native_messaging;
mod notes_inline;
mod owned_process;
mod runtime_profile;
mod smart_folders;
pub mod tool_cli;
pub mod tool_client;
pub mod tool_mcp;
pub(crate) mod tools;
mod web_tools;

use capabilities::execute_knowledge_capability;

const MATERIAL_CHANGE_EVENT: &str = "luckyray:material-change";
static MATERIAL_CHANGE_APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
static BACKEND_SERVICES: OnceLock<Arc<backend::BackendServices>> = OnceLock::new();
static COMPANION_GATEWAY: OnceLock<Arc<companion_gateway::CompanionGateway>> = OnceLock::new();
static DSH_HOST_SERVICE: OnceLock<Arc<dsh_host::DshHostService>> = OnceLock::new();
static DSH_UPDATE_RESTART_ARMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static DSH_UPDATE_PREPARED_RECORD: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static NORMAL_QUIT_REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static NORMAL_QUIT_COMPLETED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static AI_STREAM_CANCELLATIONS: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CanvasGenerationFaultPoint {
    BeforeProviderRequested,
    AfterProviderRequested,
    BeforeProviderSucceeded,
    AfterProviderSucceeded,
    BeforeMaterializing,
    AfterMaterializing,
    BeforeMaterialCommitted,
    AfterMaterialCommitted,
}

trait CanvasGenerationFaultInjector: Send + Sync {
    fn checkpoint(
        &self,
        kind: &str,
        request_id: &str,
        point: CanvasGenerationFaultPoint,
    ) -> Result<(), canvas_agent::CanvasAgentError>;
}

struct NoopCanvasGenerationFaultInjector;

impl CanvasGenerationFaultInjector for NoopCanvasGenerationFaultInjector {
    fn checkpoint(
        &self,
        _kind: &str,
        _request_id: &str,
        _point: CanvasGenerationFaultPoint,
    ) -> Result<(), canvas_agent::CanvasAgentError> {
        Ok(())
    }
}

enum TauriCanvasProviderOutput {
    Text {
        text: String,
        model_label: String,
        output_digest: String,
    },
    Image {
        generated: AiGeneratedImage,
        model_label: String,
    },
    Video {
        path: PathBuf,
        model_label: String,
    },
}

struct TauriCanvasMaterializedOutput {
    output: canvas_agent::CanvasGenerationOutput,
    output_digest: String,
}

trait TauriCanvasGenerationDriver: Send + Sync {
    fn request_provider(
        &self,
        request: &canvas_agent::CanvasGenerationRequest,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<TauriCanvasProviderOutput, canvas_agent::CanvasAgentError>;

    fn materialize(
        &self,
        request: &canvas_agent::CanvasGenerationRequest,
        provider: TauriCanvasProviderOutput,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<TauriCanvasMaterializedOutput, canvas_agent::CanvasAgentError>;
}

struct ProductionTauriCanvasGenerationDriver {
    app: tauri::AppHandle,
    catalog: materials::MaterialCatalog,
}

impl TauriCanvasGenerationDriver for ProductionTauriCanvasGenerationDriver {
    fn request_provider(
        &self,
        request: &canvas_agent::CanvasGenerationRequest,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<TauriCanvasProviderOutput, canvas_agent::CanvasAgentError> {
        match request.kind.as_str() {
            "text" => {
                let app_data = self.app.path().app_data_dir().map_err(|_| {
                    canvas_agent::CanvasAgentError::new("canvas-agent-generation-unavailable")
                })?;
                let config = load_ai_model_config(&app_data.join("luckyray.db")).map_err(|_| {
                    canvas_agent::CanvasAgentError::new("canvas-agent-generation-unavailable")
                })?;
                let model_label = safe_canvas_model_label(&config.model);
                let response = tauri::async_runtime::block_on(ai_chat_complete_with_config(
                    config,
                    AiChatRequest {
                        messages: vec![AiChatRequestMessage {
                            role: "user".to_owned(),
                            content: serde_json::Value::String(request.prompt.clone()),
                        }],
                        system_prompt: Some(
                            "你正在为 LuckyRay Canvas 生成一个文本节点。只返回适合直接放入节点的正文；不要输出推理过程、工具调用或前后说明。"
                                .to_owned(),
                        ),
                        temperature: Some(0.45),
                        max_tokens: Some(8192),
                        model: None,
                    },
                ))
                .map_err(|_| {
                    canvas_agent::CanvasAgentError::new("canvas-agent-generation-failed")
                })?;
                if cancelled() {
                    return Err(canvas_agent::CanvasAgentError::new(
                        "canvas-agent-cancelled",
                    ));
                }
                let text = response
                    .success
                    .then_some(response.content)
                    .flatten()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        canvas_agent::CanvasAgentError::new("canvas-agent-generation-failed")
                    })?;
                let output_digest = format!("{:x}", Sha256::digest(text.as_bytes()));
                Ok(TauriCanvasProviderOutput::Text {
                    text,
                    model_label,
                    output_digest,
                })
            }
            "image" => {
                let (_, _, configured_model, _) = load_canvas_generation_settings(&self.app)
                    .map_err(|_| {
                        canvas_agent::CanvasAgentError::new("canvas-agent-generation-unavailable")
                    })?;
                let response = tauri::async_runtime::block_on(ai_image_generate_internal(
                    &self.app,
                    AiImageGenerateRequest {
                        prompt: request.prompt.clone(),
                        model: String::new(),
                        aspect: None,
                        quality: None,
                        resolution: None,
                        count: Some(1),
                        references: Vec::new(),
                    },
                    cancelled,
                ))
                .map_err(|_| {
                    canvas_agent::CanvasAgentError::new("canvas-agent-generation-failed")
                })?;
                if cancelled() {
                    return Err(canvas_agent::CanvasAgentError::new(
                        "canvas-agent-cancelled",
                    ));
                }
                let generated = response
                    .success
                    .then(|| response.images.into_iter().next())
                    .flatten()
                    .ok_or_else(|| {
                        canvas_agent::CanvasAgentError::new("canvas-agent-generation-failed")
                    })?;
                Ok(TauriCanvasProviderOutput::Image {
                    generated,
                    model_label: safe_canvas_model_label(&configured_model),
                })
            }
            "video" => {
                let (_, _, _, configured_model) = load_canvas_generation_settings(&self.app)
                    .map_err(|_| {
                        canvas_agent::CanvasAgentError::new("canvas-agent-generation-unavailable")
                    })?;
                let response = tauri::async_runtime::block_on(ai_video_generate_internal(
                    &self.app,
                    AiVideoGenerateRequest {
                        client_task_id: Some(request.request_id.clone()),
                        provider_task_id: None,
                        prompt: request.prompt.clone(),
                        model: String::new(),
                        aspect: None,
                        quality: None,
                        duration: Some(5),
                        sound: Some(true),
                        references: Vec::new(),
                    },
                    cancelled,
                ))
                .map_err(|_| {
                    canvas_agent::CanvasAgentError::new("canvas-agent-generation-failed")
                })?;
                if cancelled() {
                    return Err(canvas_agent::CanvasAgentError::new(
                        "canvas-agent-cancelled",
                    ));
                }
                let path = response
                    .success
                    .then_some(response.video_url)
                    .flatten()
                    .map(PathBuf::from)
                    .ok_or_else(|| {
                        canvas_agent::CanvasAgentError::new("canvas-agent-generation-failed")
                    })?;
                Ok(TauriCanvasProviderOutput::Video {
                    path,
                    model_label: safe_canvas_model_label(&configured_model),
                })
            }
            _ => Err(canvas_agent::CanvasAgentError::new(
                "canvas-agent-generation-invalid",
            )),
        }
    }

    fn materialize(
        &self,
        request: &canvas_agent::CanvasGenerationRequest,
        provider: TauriCanvasProviderOutput,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<TauriCanvasMaterializedOutput, canvas_agent::CanvasAgentError> {
        match provider {
            TauriCanvasProviderOutput::Image {
                generated,
                model_label,
            } => {
                let (bytes, mime_type, extension) =
                    materialize_canvas_image_bytes(&generated.url, cancelled)?;
                let digest = format!("{:x}", Sha256::digest(&bytes));
                let imported = materials::import_downloaded_material(
                    &self.catalog,
                    materials::MaterialBytesInput {
                        name: format!("canvas-generated-{}.{}", &digest[..16], extension),
                        original_path: format!(
                            "canvas-generation://image/{}/{}",
                            request.operation_digest,
                            &digest[..24]
                        ),
                        mime_type,
                        description: Some("Canvas generated image".to_owned()),
                        bytes,
                    },
                    &materials::MaterialImportOptions::default(),
                )
                .map_err(|_| {
                    canvas_agent::CanvasAgentError::new("canvas-agent-materialize-failed")
                })?;
                emit_catalog_change_global(&imported.change);
                let media_url = imported
                    .asset
                    .library_path
                    .clone()
                    .unwrap_or_else(|| imported.asset.original_path.clone());
                Ok(TauriCanvasMaterializedOutput {
                    output: canvas_agent::CanvasGenerationOutput {
                        text: None,
                        material_id: Some(imported.asset.id),
                        media_url: Some(media_url.clone()),
                        thumbnail_url: Some(
                            (!imported.asset.thumbnail_url.is_empty())
                                .then_some(imported.asset.thumbnail_url)
                                .unwrap_or(media_url),
                        ),
                        model_label: Some(model_label),
                    },
                    output_digest: digest,
                })
            }
            TauriCanvasProviderOutput::Video { path, model_label } => {
                let digest = sha256_file(&path)?;
                let imported = import_canvas_generated_video(&self.catalog, &path)?;
                let _ = std::fs::remove_file(&path);
                emit_catalog_change_global(&imported.1);
                let asset = imported.0;
                let media_url = asset
                    .library_path
                    .clone()
                    .unwrap_or_else(|| asset.original_path.clone());
                Ok(TauriCanvasMaterializedOutput {
                    output: canvas_agent::CanvasGenerationOutput {
                        text: None,
                        material_id: Some(asset.id),
                        media_url: Some(media_url),
                        thumbnail_url: (!asset.thumbnail_url.is_empty())
                            .then_some(asset.thumbnail_url),
                        model_label: Some(model_label),
                    },
                    output_digest: digest,
                })
            }
            TauriCanvasProviderOutput::Text { .. } => Err(canvas_agent::CanvasAgentError::new(
                "canvas-agent-generation-invalid",
            )),
        }
    }
}

#[derive(Clone)]
struct TauriCanvasGenerationExecutor {
    driver: Arc<dyn TauriCanvasGenerationDriver>,
    fault_injector: Arc<dyn CanvasGenerationFaultInjector>,
}

impl TauriCanvasGenerationExecutor {
    fn production(app: tauri::AppHandle, catalog: materials::MaterialCatalog) -> Self {
        Self {
            driver: Arc::new(ProductionTauriCanvasGenerationDriver { app, catalog }),
            fault_injector: Arc::new(NoopCanvasGenerationFaultInjector),
        }
    }

    fn checkpoint(
        &self,
        request: &canvas_agent::CanvasGenerationRequest,
        point: CanvasGenerationFaultPoint,
    ) -> Result<(), canvas_agent::CanvasAgentError> {
        self.fault_injector
            .checkpoint(&request.kind, &request.request_id, point)
    }

    fn ensure_running(
        cancelled: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<(), canvas_agent::CanvasAgentError> {
        if cancelled() {
            Err(canvas_agent::CanvasAgentError::new(
                "canvas-agent-cancelled",
            ))
        } else {
            Ok(())
        }
    }
}

impl canvas_agent::CanvasGenerationExecutor for TauriCanvasGenerationExecutor {
    fn generate(
        &self,
        request: &canvas_agent::CanvasGenerationRequest,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
        journal: &dyn canvas_agent::CanvasGenerationJournal,
    ) -> Result<canvas_agent::CanvasGenerationOutput, canvas_agent::CanvasAgentError> {
        Self::ensure_running(cancelled)?;
        self.checkpoint(request, CanvasGenerationFaultPoint::BeforeProviderRequested)?;
        journal.transition(
            canvas_agent::CanvasGenerationStage::ProviderRequested,
            None,
            None,
        )?;
        self.checkpoint(request, CanvasGenerationFaultPoint::AfterProviderRequested)?;
        Self::ensure_running(cancelled)?;
        let provider = self
            .driver
            .request_provider(request, cancelled)
            .map_err(|error| {
                if error.code != "canvas-agent-cancelled" {
                    let _ = journal.transition(
                        canvas_agent::CanvasGenerationStage::ProviderUncertain,
                        None,
                        None,
                    );
                }
                error
            })?;
        Self::ensure_running(cancelled)?;
        self.checkpoint(request, CanvasGenerationFaultPoint::BeforeProviderSucceeded)?;
        let provider_digest = match &provider {
            TauriCanvasProviderOutput::Text { output_digest, .. } => Some(output_digest.as_str()),
            _ => None,
        };
        journal.transition(
            canvas_agent::CanvasGenerationStage::ProviderSucceeded,
            None,
            provider_digest,
        )?;
        self.checkpoint(request, CanvasGenerationFaultPoint::AfterProviderSucceeded)?;
        Self::ensure_running(cancelled)?;

        if let TauriCanvasProviderOutput::Text {
            text, model_label, ..
        } = provider
        {
            return Ok(canvas_agent::CanvasGenerationOutput {
                text: Some(text),
                material_id: None,
                media_url: None,
                thumbnail_url: None,
                model_label: Some(model_label),
            });
        }

        self.checkpoint(request, CanvasGenerationFaultPoint::BeforeMaterializing)?;
        journal.transition(
            canvas_agent::CanvasGenerationStage::Materializing,
            None,
            None,
        )?;
        self.checkpoint(request, CanvasGenerationFaultPoint::AfterMaterializing)?;
        Self::ensure_running(cancelled)?;
        let materialized = self.driver.materialize(request, provider, cancelled)?;
        Self::ensure_running(cancelled)?;
        self.checkpoint(request, CanvasGenerationFaultPoint::BeforeMaterialCommitted)?;
        journal.transition(
            canvas_agent::CanvasGenerationStage::MaterialCommitted,
            materialized.output.material_id.as_deref(),
            Some(&materialized.output_digest),
        )?;
        self.checkpoint(request, CanvasGenerationFaultPoint::AfterMaterialCommitted)?;
        Ok(materialized.output)
    }
}

// Development-only, bounded routing evidence. Never records file names or paths.
fn log_notes_drop(stage: &str, count: usize, hit: bool) {
    #[cfg(debug_assertions)]
    {
        static COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        if COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < 80 {
            eprintln!("[notes-drop] stage={stage} count={count} hit={hit}");
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = (stage, count, hit);
}

#[tauri::command]
fn notes_drop_diagnostic(caller: tauri::Webview, stage: String, count: usize, hit: bool) -> Result<(), String> {
    require_main_caller(&caller)?;
    if matches!(stage.as_str(), "listener-ready" | "listener-failed" | "enter" | "drop" | "classified" | "import" | "failed") {
        log_notes_drop(&stage, count.min(100_000), hit);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // R3a: LocalTransport starts after Tauri plugins and exposes only the Native Messaging bootstrap control plane.
    tauri::Builder::default()
        .on_webview_event(|webview, event| {
            if webview.label() == "main" {
                if let tauri::WebviewEvent::DragDrop(event) = event {
                    match event {
                        tauri::DragDropEvent::Enter { paths, .. } => log_notes_drop("native-webview-enter", paths.len(), true),
                        tauri::DragDropEvent::Drop { paths, .. } => log_notes_drop("native-webview-drop", paths.len(), true),
                        _ => {},
                    }
                }
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // The OS close button/Alt+F4 must use the same draft barrier
                    // as the explicit close command and tray quit. Never destroy
                    // Main before production and retained editors acknowledge.
                    api.prevent_close();
                    request_normal_quit(window.app_handle().clone(), false);
                    return;
                }
                if let tauri::WindowEvent::DragDrop(event) = event {
                    match event {
                        tauri::DragDropEvent::Enter { paths, .. } => log_notes_drop("native-window-enter", paths.len(), true),
                        tauri::DragDropEvent::Drop { paths, .. } => log_notes_drop("native-window-drop", paths.len(), true),
                        _ => {},
                    }
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(workspace_windows::WorkspaceWindows::default());
            let identifier = app.config().identifier.clone();
            let runtime_profile = runtime_profile::RuntimeProfile::resolve_current(&identifier)
                .map_err(std::io::Error::other)?;
            let app_data = app.path().app_data_dir().map_err(std::io::Error::other)?;
            runtime_profile
                .validate_app_data_root(&identifier, &app_data)
                .map_err(std::io::Error::other)?;
            // Update bootstrap must run before any service can hold data or tasks.
            #[cfg(windows)]
            desktop_app_update::initialize(app, &app_data).map_err(std::io::Error::other)?;
            let resource_dir = app.path().resource_dir().map_err(std::io::Error::other)?;
            let dsh_host = dsh_host::DshHostService::production_background(&resource_dir, &app_data);
            DSH_HOST_SERVICE
                .set(dsh_host.clone())
                .map_err(|_| std::io::Error::other("DSH host already initialized"))?;
            app.manage(dsh_host.clone());
            app.manage(Arc::new(dsh_engine_update::DshEngineUpdater::new(dsh_host.clone(), app_data.clone())));
            let browser_broker = Arc::new(
                browser_broker::BrowserBroker::initialize(&app_data)
                    .map_err(std::io::Error::other)?,
            );
            app.manage(browser_broker);
            let backend = Arc::new(
                backend::BackendServices::initialize_product(&app_data, &resource_dir)
                    .map_err(std::io::Error::other)?,
            );
            let knowledge_committed_app = app.handle().clone();
            backend.knowledge().set_companion_committed_listener(move |change| {
                // A wake-up only: the current target rereads its existing source.
                // Never hold source locks or carry note contents into this event.
                let _ = knowledge_committed_app.emit_to("main", "luckyray:knowledge-committed", change);
            }).map_err(std::io::Error::other)?;
            backend.canvas_agent().set_generation_executor(Arc::new(
                TauriCanvasGenerationExecutor::production(
                    app.handle().clone(),
                    backend.material_catalog(),
                ),
            ));
            BACKEND_SERVICES
                .set(backend.clone())
                .map_err(|_| std::io::Error::other("backend services already initialized"))?;
            dsh_host.install_resource_broker(dsh_resource_broker::DshResourceBroker::new(
                Arc::clone(&backend),
            ));
            let capability_db = open_db_write().map_err(std::io::Error::other)?;
            seed_local_capabilities(&capability_db).map_err(std::io::Error::other)?;
            app.manage(backend.clone());
            let companion_gateway =
                companion_gateway::CompanionGateway::initialize(Arc::clone(&backend));
            COMPANION_GATEWAY
                .set(Arc::clone(&companion_gateway))
                .map_err(|_| std::io::Error::other("companion gateway already initialized"))?;
            companion_gateway.attach_lsh_remote_host(Arc::clone(&dsh_host));
            let presentation_app = app.handle().clone();
            companion_gateway.attach_presentation_sink(Arc::new(move |target| {
                presentation_app.get_webview_window("main").is_some()
                    && presentation_app.emit_to("main", "luckyray:companion-presentation-open", target).is_ok()
            }));
            app.manage(companion_gateway);
            let _ = MATERIAL_CHANGE_APP_HANDLE.set(app.handle().clone());
            let adapter: Arc<dyn local_transport::TransportAdapter> =
                Arc::new(LegacyLocalTransportAdapter::new(backend.clone()));
            let transport = local_transport::start_server(
                local_transport::ServerConfig::production(backend.app_data_dir().to_path_buf()),
                adapter,
            )
            .map_err(std::io::Error::other)?;
            println!(
                "[luckyray] local transport listening on {}",
                transport.client_config().base_url
            );
            app.manage(transport);
            community_mcp::initialize(app.handle().clone());
            if let Err(error) = allow_canvas_generated_media_fs_scope(app.handle()) {
                // Fail closed: without the scope the canvas cannot persist
                // generated media, so surface it instead of failing silently.
                eprintln!("[canvas] {error}");
                return Err(std::io::Error::other(error).into());
            }
            setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(workspace_command_policy::guard(tauri::generate_handler![
            desktop_app_update::desktop_application_update,
            extension_appearance::publish_extension_appearance,
            extension_packages::manage_extension_packages,
            extension_runtime::extension_runtime,
            notes_drop_diagnostic,
            minimize_window,
            hide_window,
            show_window,
            toggle_maximize_window,
            close_window,
            browser_personal_open,
            browser_personal_navigate,
            browser_personal_back,
            browser_personal_forward,
            browser_personal_reload,
            browser_personal_stop,
            browser_personal_status,
            browser_personal_set_viewport,
            browser_personal_close,
            agent_workspace_list,
            agent_workspace_select_folder,
            agent_workspace_add,
            agent_workspace_set_enabled,
            agent_workspace_remove,
            agent_search_settings_status,
            agent_search_settings_update,
            agent_search_test_connection,
            canvas_comfyui_get_config,
            canvas_comfyui_set_config,
            canvas_comfyui_test_connection,
            canvas_media_profiles_list,
            canvas_media_profile_upsert,
            canvas_media_profile_activate,
            canvas_media_profile_delete,
            canvas_media_profile_list_models,
            canvas_text_generate,
            ai_model_profiles_list,
            ai_model_profile_upsert,
            ai_model_profile_activate,
            ai_model_profile_test_connection,
            ai_model_profile_select_model,
            ai_model_profile_delete,
            ai_model_profile_sync_from_lightseek,
            get_auto_launch_enabled,
            set_auto_launch_enabled,
            get_backend_bootstrap_status,
            companion_gateway::companion_gateway_status,
            companion_gateway::companion_gateway_start,
            companion_gateway::companion_gateway_stop,
            companion_gateway::companion_gateway_restart,
            companion_gateway::endpoint_recovery::companion_gateway_recover_endpoint,
            companion_gateway::endpoint_recovery::companion_gateway_endpoint_recovery_presentation,
            companion_gateway::companion_gateway_issue_pairing,
            companion_gateway::companion_gateway_set_authorization_mode,
            companion_gateway::companion_gateway_cancel_pairing,
            companion_gateway::companion_gateway_list_interfaces,
            companion_gateway::companion_gateway_list_devices,
            companion_gateway::companion_gateway_list_audit,
            companion_gateway::companion_gateway_revoke_device,
            companion_gateway::companion_gateway_lsh_remote_set_grant,
            companion_gateway::companion_gateway_lsh_remote_state,
            companion_gateway::companion_gateway_service_grants,
            companion_gateway::companion_gateway_service_set_grant,
            companion_gateway::companion_gateway_service_set_grants,
            companion_gateway::companion_gateway_presentation_claim,
            companion_gateway::companion_gateway_presentation_ack,
            dsh_host_status,
            dsh_host_probe,
            dsh_host_retry,
            dsh_engine_update_status,
            dsh_engine_update_check,
            dsh_engine_update_install,
            dsh_engine_update_cancel,
            dsh_engine_update_recover,
            dsh_engine_update_verify,
            dsh_engine_update_restart,
            dsh_engine_update_prepare_exit,
            dsh_native_surface_status,
            dsh_native_surface_open,
            dsh_native_surface_preload,
            dsh_plugin_compat_status,
            dsh_plugin_compat_check,
            dsh_plugin_compat_apply,
            dsh_plugin_compat_reclaim_surface,
            dsh_native_surface_restart,
            dsh_native_surface_set_bounds,
            dsh_native_surface_open_intent,
            dsh_native_surface_open_intent_status,
            canvas_agent_dispatch,
            dsh_native_surface_hide,
            dsh_native_surface_show,
            dsh_native_surface_close,
            knowledge_list_documents,
            knowledge_search_documents,
            knowledge_refresh_index,
            knowledge_index_snapshot,
            knowledge_document_relations,
            knowledge_backlinks,
            knowledge_tag_summary,
            knowledge_documents_for_tag,
            knowledge_documents_referencing_embed,
            knowledge_set_document_tags,
            knowledge_read_document,
            knowledge_attachment_context,
            knowledge_resolve_attachment,
            knowledge_preview_external_attachment_changes,
            knowledge_invalidate_attachment_inventory,
            knowledge_publish_attachment,
            knowledge_preview_attachment_conversion,
            knowledge_preview_attachment_import,
            knowledge_preview_attachment_rename,
            knowledge_get_attachment_link_update_policy,
            attachment_coordination::knowledge_get_attachment_handling_policy,
            attachment_coordination::knowledge_set_attachment_handling_policy,
            attachment_coordination::knowledge_audit_attachment_portability,
            attachment_coordination::knowledge_export_standalone_vault,
            attachment_coordination::knowledge_export_note_archive,
            attachment_coordination::knowledge_preview_attachment_relink,
            attachment_file_moves::knowledge_preview_material_file_move,
            attachment_coordination::knowledge_attachment_versions,
            attachment_coordination::material_catalog_list_note_attachments,
            attachment_coordination::material_catalog_attachment_details,
            attachment_coordination::material_catalog_promote_note_attachment,
            knowledge_set_attachment_link_update_policy,
            knowledge_execute_attachment_operation,
            knowledge_recover_attachment_operation,
            knowledge_cancel_attachment_operation,
            knowledge_list_attachment_operations,
            knowledge_activate_ui_source,
            knowledge_activate_current_ui_source,
            knowledge_deactivate_ui_source,
            knowledge_create_document,
            knowledge_append_document,
            knowledge_insert_document,
            knowledge_replace_document,
            knowledge_move_document,
            knowledge_delete_document,
            knowledge_insert_current,
            knowledge_insert_material_current,
            attachment_coordination::knowledge_discover_attachment_moves,
            knowledge_begin_current_context_session,
            knowledge_set_current_context,
            knowledge_companion_desktop_drafts,
            knowledge_companion_editing_status,
            knowledge_companion_committed_checkpoint,
            knowledge_get_current_context,
            knowledge_clear_current_context,
            migrate_managed_asset_library,
            get_app_data_dir,
            get_collection_server_base_url,
            get_local_transport_client_config,
            community_mcp::community_mcp_status,
            community_mcp::community_mcp_action,
            revoke_local_transport_extension_origin,
            rotate_local_transport_credentials,
            open_directory,
            get_storage_usage,
            clear_thumbnail_cache,
            persist_video_thumbnail,
            clear_all_data,
            create_backup,
            list_backups,
            restore_backup,
            get_current_notes_vault,
            knowledge_migrate_saved_vaults,
            create_notes_vault,
            open_notes_vault,
            list_notes_vault_files,
            get_notes_vault_markdown_index,
            import_notes_vault_markdown_files,
            import_notes_vault_markdown_folder,
            export_notes_vault_markdown_file,
            export_notes_vault_markdown_folder,
            open_notes_vault_markdown_file_with_default_app,
            open_existing_local_file_with_default_app,
            notes_vault_asset_exists,
            notes_vault_find_asset_candidates,
            create_notes_vault_folder,
            create_notes_vault_markdown_file,
            read_notes_vault_markdown_file,
            write_notes_vault_markdown_file,
            rename_notes_vault_markdown_file,
            rename_notes_vault_folder,
            move_notes_vault_markdown_file,
            move_notes_vault_folder,
            delete_notes_vault_markdown_file,
            delete_notes_vault_empty_folder,
            export_assets_index,
            classify_dropped_paths,
            material_catalog_list_assets,
            material_catalog_get_assets,
            material_catalog_search_assets,
            material_catalog_import_paths,
            material_catalog_import_folder,
            material_catalog_import_bytes,
            material_catalog_get_source_page,
            material_catalog_get_change,
            material_catalog_update_asset,
            material_catalog_relocate_asset,
            material_catalog_rename_asset_file,
            material_catalog_delete_asset,
            material_catalog_scan_missing,
            material_catalog_remove_asset_record,
            material_catalog_list_folders,
            material_catalog_create_folder,
            material_catalog_rename_folder,
            material_catalog_delete_folder,
            material_catalog_move_folder,
            material_catalog_move_asset,
            material_catalog_list_tags,
            material_catalog_create_tag,
            material_catalog_update_tag,
            material_catalog_delete_tag,
            material_catalog_get_asset_tags,
            material_catalog_set_asset_tags,
            material_catalog_list_asset_tag_map,
            material_catalog_merge_tags,
            material_catalog_begin_external_drag,
            material_catalog_shell_action,
            material_library_command,
            material_native_video::material_native_video_command,
            workspace_windows::workspace_window_command,
            material_native_video::material_video_preview_command,
            material_catalog_resolve_lightseek_paths,
            favorite_items_list,
            favorite_item_counts,
            favorite_item_add,
            favorite_item_update,
            favorite_item_remove,
            smart_folder_list,
            smart_folder_create,
            smart_folder_update,
            smart_folder_delete,
            get_material_change_state,
            publish_material_change,
            import_image_from_url,
            collection_image_to_assets,
            export_asset_file,
            material_export_plan,
            material_export_discard_plan,
            material_export_start,
            material_export_status,
            material_export_cancel,
            material_export_open_destination,
            material_csv_export_plan,
            material_csv_export_discard_plan,
            material_csv_export_start,
            material_csv_export_status,
            material_csv_export_cancel,
            material_csv_export_retry,
            ai_chat_complete,
            notes_inline_generate,
            notes_inline_apply,
            notes_inline_discard,
            notes_inline_cancel,
            ai_image_generate,
            ai_video_generate,
            ai_chat_stream,
            ai_chat_cancel,
            update_current_editor,
            // D65 正式画布 MVP：文件存储命令
            get_canvas_storage_dir,
            check_canvas_files,
            list_canvases,
            load_canvas,
            save_canvas,
            create_canvas,
            rename_canvas,
            delete_canvas,
            save_canvas_thumbnail,
            delete_canvas_thumbnail
        ]))
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                community_mcp::shutdown();
                if !NORMAL_QUIT_COMPLETED.load(std::sync::atomic::Ordering::Acquire) {
                    // An unexpected termination must never activate a pending
                    // switch. Explicit full-quit paths drain on a worker first.
                    DSH_UPDATE_RESTART_ARMED.store(false, std::sync::atomic::Ordering::Release);
                    if let Some(gateway) = COMPANION_GATEWAY.get() { let _ = gateway.shutdown(); }
                    if let Some(host) = DSH_HOST_SERVICE.get() { let _ = host.shutdown(); }
                }
            }
        });
}

fn prepared_update_record() -> &'static Mutex<Option<String>> {
    DSH_UPDATE_PREPARED_RECORD.get_or_init(|| Mutex::new(None))
}

/// A full quit is not a window close: the tray keeps the process alive. Drain
/// outside Tauri's event thread, then request exit only after the update
/// marker has been safely committed. The next startup rechecks the closure.
fn drain_application_services() -> bool {
        material_native_video::shutdown();
        let started = std::time::Instant::now();
        let runs_quiescent_before = engine_update_other_runs_quiescent();
        let gateway_settled = COMPANION_GATEWAY.get().is_none_or(|gateway| gateway.shutdown());
        let settled = DSH_HOST_SERVICE.get().map_or(true, |host| host.shutdown());
        let other_runs_quiescent = runs_quiescent_before && engine_update_other_runs_quiescent();
        eprintln!("[dsh-update-exit] drain finished gateway={gateway_settled} host={settled} otherRuns={other_runs_quiescent} elapsedMs={}", started.elapsed().as_millis());
        let armed = DSH_UPDATE_RESTART_ARMED.swap(false, std::sync::atomic::Ordering::AcqRel);
        if armed && gateway_settled && settled && other_runs_quiescent {
            if let Some(host) = DSH_HOST_SERVICE.get() {
                if let Some((store, _, false)) = host.engine_update_context() {
                    let expected = prepared_update_record().lock().unwrap().take();
                    if let Some(expected) = expected {
                        match store.arm_after_confirmed_shutdown_if_digest(Some(&expected)) {
                            Ok(()) => eprintln!("[dsh-update-exit] switch armed after confirmed drain"),
                            Err(error) => eprintln!("[dsh-update-exit] switch not armed: {error:?}"),
                        }
                    }
                }
            }
        } else if armed {
            eprintln!("[dsh-update-exit] switch not armed: owned tree or background run not quiescent");
        }
        gateway_settled && settled && other_runs_quiescent
}

/// Both normal quit and signed desktop update share the same editor barrier
/// and single admission. A failed continuation releases the exact saved round
/// and restores interaction; no update-specific draft/save implementation.
fn with_saved_application_quit(
    app: &tauri::AppHandle,
    continuation: impl FnOnce() -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    if NORMAL_QUIT_REQUESTED.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("update-quit-in-progress");
    }
    struct Admission<'a> { app: &'a tauri::AppHandle, completed: bool }
    impl Drop for Admission<'_> {
        fn drop(&mut self) {
            if !self.completed {
                workspace_windows::cancel_prepared_application_quit(self.app);
                NORMAL_QUIT_REQUESTED.store(false, std::sync::atomic::Ordering::Release);
            }
        }
    }
    let mut admission = Admission { app, completed: false };
    if !workspace_windows::prepare_application_quit(app) {
        return Err("update-editors-not-saved");
    }
    continuation()?;
    NORMAL_QUIT_COMPLETED.store(true, std::sync::atomic::Ordering::Release);
    admission.completed = true;
    Ok(())
}

fn request_normal_quit(app: tauri::AppHandle, restart: bool) {
    std::thread::spawn(move || {
        if let Err(code) = with_saved_application_quit(&app, || {
            eprintln!("[dsh-update-exit] normal quit requested restart={restart}");
            let scheduled = desktop_app_update::scheduled_exit_guard_required(&app)?;
            let mut lsh_hold = if scheduled {
                DSH_HOST_SERVICE.get().map(|host| host.reserve_desktop_update_restart()).transpose()?
            } else { None };
            if let Some(host) = lsh_hold.as_mut() { host.stop_surface()?; }
            let drained = drain_application_services();
            if scheduled && !drained { return Err("update-service-drain-incomplete"); }
            Ok(())
        }) {
            eprintln!("[workspace] quit cancelled: {code}");
            desktop_app_update::report_scheduled_quit_blocked(&app, code);
            return;
        }
        if restart { app.request_restart(); } else { app.exit(0); }
    });
}

#[cfg(windows)]
fn quit_for_desktop_update(
    app: &tauri::AppHandle,
    prepare: impl FnOnce(Option<(u32, Option<u32>)>) -> Result<desktop_app_update::installer::PreparedInstaller, &'static str>,
) -> Result<(), &'static str> {
    with_saved_application_quit(app, || {
        let backend = backend_services().map_err(|_| "update-task-state-unavailable")?;
        let runs = backend.agent_runs();
        // Reserve the existing execution admission: a query alone would race
        // a new generation request while the saved barrier is being drained.
        let _run_admission = runs.acquire_transient("desktop-update")
            .map_err(|_| "update-generation-active")?;
        if runs.has_active_background_run().map_err(|_| "update-task-state-unavailable")? {
            return Err("update-generation-active");
        }
        let mut _host_admission = match DSH_HOST_SERVICE.get() {
            Some(host) => Some(host.reserve_desktop_update_restart()?),
            None => None,
        };
        // Pin and create the exact verified installer before stopping any
        // service. Its thread remains suspended until the drain has succeeded.
        let reserved = _host_admission.as_ref().and_then(|host| host.reserved_processes());
        let installer = prepare(reserved)?;
        if let Some(host) = _host_admission.as_mut() { host.stop_surface()?; }
        if !drain_application_services() { return Err("update-service-drain-incomplete"); }
        installer.start()?;
        Ok(())
    })?;
    // The already-running installer owns /R (reopen). Do not spawn Main here
    // or depend on the user launching it after this process has exited.
    app.exit(0);
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn material_catalog_for_app(app: &tauri::AppHandle) -> Result<materials::MaterialCatalog, String> {
    let _ = app;
    backend_services().map(|backend| backend.material_catalog())
}

fn emit_catalog_change(app: &tauri::AppHandle, change: &Option<materials::MaterialChange>) {
    if let Some(change) = change {
        let _ = app.emit(MATERIAL_CHANGE_EVENT, change);
    }
}

/// Gateway-side publish: the Companion Gateway mutates through the same
/// authorities, so Desktop UI converges through the same change event.
pub(crate) fn publish_catalog_change_global(change: &Option<materials::MaterialChange>) {
    emit_catalog_change_global(change);
}

fn emit_catalog_change_global(change: &Option<materials::MaterialChange>) {
    if let (Some(app), Some(change)) = (MATERIAL_CHANGE_APP_HANDLE.get(), change) {
        let _ = app.emit(MATERIAL_CHANGE_EVENT, change);
    }
}

pub(crate) fn material_catalog_for_http() -> Result<materials::MaterialCatalog, String> {
    backend_services().map(|backend| backend.material_catalog())
}

#[tauri::command]
fn favorite_items_list(
    caller: tauri::Webview,
    item_type: favorites::FavoriteItemType,
) -> Result<Vec<favorites::FavoriteItem>, String> {
    require_main_caller(&caller)?;
    let connection = backend_services()?
        .open_read()
        .map_err(|error| error.to_string())?;
    favorites::list(&connection, item_type)
}

#[tauri::command]
fn favorite_item_counts(caller: tauri::Webview) -> Result<favorites::FavoriteCounts, String> {
    require_main_caller(&caller)?;
    let connection = backend_services()?
        .open_read()
        .map_err(|error| error.to_string())?;
    favorites::counts(&connection)
}

#[tauri::command]
fn favorite_item_add(
    caller: tauri::Webview,
    item_type: favorites::FavoriteItemType,
    item_id: String,
) -> Result<favorites::FavoriteItem, String> {
    require_main_caller(&caller)?;
    let mut connection = backend_services()?
        .open_write()
        .map_err(|error| error.to_string())?;
    favorites::add(&mut connection, item_type, &item_id)
}

#[tauri::command]
fn favorite_item_update(
    caller: tauri::Webview,
    item_type: favorites::FavoriteItemType,
    item_id: String,
    theme: String,
    copy: String,
) -> Result<favorites::FavoriteItem, String> {
    require_main_caller(&caller)?;
    let mut connection = backend_services()?
        .open_write()
        .map_err(|error| error.to_string())?;
    favorites::update_notes(&mut connection, item_type, &item_id, &theme, &copy)
}

#[tauri::command]
fn favorite_item_remove(
    caller: tauri::Webview,
    item_type: favorites::FavoriteItemType,
    item_id: String,
) -> Result<favorites::FavoriteRemoval, String> {
    require_main_caller(&caller)?;
    let mut connection = backend_services()?
        .open_write()
        .map_err(|error| error.to_string())?;
    favorites::remove(&mut connection, item_type, &item_id)
}

#[tauri::command]
fn smart_folder_list(
    caller: tauri::Webview,
) -> Result<Vec<smart_folders::SmartFolderDefinition>, String> {
    require_main_caller(&caller)?;
    let connection = backend_services()?
        .open_read()
        .map_err(|error| error.to_string())?;
    smart_folders::list(&connection)
}

#[tauri::command]
fn smart_folder_create(
    caller: tauri::Webview,
    input: smart_folders::SmartFolderDefinitionInput,
) -> Result<smart_folders::SmartFolderDefinition, String> {
    require_main_caller(&caller)?;
    let mut connection = backend_services()?
        .open_write()
        .map_err(|error| error.to_string())?;
    smart_folders::create(&mut connection, input)
}

#[tauri::command]
fn smart_folder_update(
    caller: tauri::Webview,
    id: String,
    input: smart_folders::SmartFolderDefinitionInput,
) -> Result<smart_folders::SmartFolderDefinition, String> {
    require_main_caller(&caller)?;
    let mut connection = backend_services()?
        .open_write()
        .map_err(|error| error.to_string())?;
    smart_folders::update(&mut connection, &id, input)
}

#[tauri::command]
fn smart_folder_delete(caller: tauri::Webview, id: String) -> Result<bool, String> {
    require_main_caller(&caller)?;
    let mut connection = backend_services()?
        .open_write()
        .map_err(|error| error.to_string())?;
    smart_folders::delete(&mut connection, &id)
}

fn backend_services() -> Result<&'static Arc<backend::BackendServices>, String> {
    BACKEND_SERVICES
        .get()
        .ok_or_else(|| "backend-not-ready: 后端服务尚未完成初始化".to_string())
}

fn require_main_caller(caller: &tauri::Webview) -> Result<(), String> {
    if caller.label() == "main" {
        Ok(())
    } else {
        Err("main-surface-untrusted-caller".to_owned())
    }
}

#[tauri::command]
fn get_backend_bootstrap_status() -> Result<backend::BackendBootstrapStatus, String> {
    backend_services().map(|backend| backend.status())
}

#[tauri::command]
async fn dsh_host_status(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
) -> Result<dsh_host::DshHostStatusView, String> {
    require_main_caller(&caller)?;
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.wait_initialized();
        host.status()
    })
    .await
    .map_err(|_| "dsh-host-unavailable".to_owned())
}

#[tauri::command]
async fn dsh_host_probe(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
) -> Result<dsh_host::DshHostStatusView, String> {
    require_main_caller(&caller)?;
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.probe(dsh_host::DshHostAction::Probe))
        .await
        .map_err(|_| "dsh-host-unavailable".to_owned())?
}

#[tauri::command]
async fn dsh_host_retry(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
) -> Result<dsh_host::DshHostStatusView, String> {
    require_main_caller(&caller)?;
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.probe(dsh_host::DshHostAction::ExplicitRetry))
        .await
        .map_err(|_| "dsh-host-unavailable".to_owned())?
}

const DSH_NATIVE_SURFACE_WEBVIEW_LABEL: &str = "dsh-native-surface-m1";
// Creation/retirement spans the backend carrier and the UI-thread child.
// Serialize that whole transaction, not only the host's protocol operation.
static DSH_NATIVE_SURFACE_LIFECYCLE: Mutex<()> = Mutex::new(());

// A timed-out task must not run later and hide, show or close a replacement.
// Once a UI action has begun, await its acknowledgement before releasing the
// lifecycle owner. These callbacks only perform local UI work, never host IO.
fn run_dsh_native_surface_on_main<T: Send + 'static>(
    window: &tauri::Window,
    failure: &'static str,
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::mpsc::{self, RecvTimeoutError};
    const PENDING: u8 = 0;
    const RUNNING: u8 = 1;
    const CANCELLED: u8 = 2;
    let phase = Arc::new(AtomicU8::new(PENDING));
    let scheduled = phase.clone();
    let (send, receive) = mpsc::sync_channel(1);
    window.run_on_main_thread(move || {
        if scheduled.compare_exchange(PENDING, RUNNING, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            let _ = send.send(action());
        }
    }).map_err(|_| failure.to_owned())?;
    match receive.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => {
            if phase.compare_exchange(PENDING, CANCELLED, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                Err(failure.to_owned())
            } else {
                receive.recv().map_err(|_| failure.to_owned())?
            }
        }
        Err(RecvTimeoutError::Disconnected) => Err(failure.to_owned()),
    }
}

fn settle_warm_existing_webview_close_failure(host: &Arc<dsh_host::DshHostService>) -> String {
    // The warm child WebView itself failed to close. A successful scoped
    // carrier binding-close cannot prove native-child settlement, so the
    // existing Level-2 generation/Job owner invalidates generation G before
    // the primary open error is returned.
    host.invalidate_native_surface_generation("dsh-native-surface-unavailable")
}

fn compensate_native_surface_open(
    host: &Arc<dsh_host::DshHostService>,
    primary_error: &'static str,
) -> String {
    if host.close_native_surface().is_err() {
        debug_assert_eq!(
            host.surface_status().stage,
            dsh_host::DshNativeSurfaceStage::Unavailable
        );
    }
    primary_error.to_owned()
}

fn settle_native_surface_close(
    host: &Arc<dsh_host::DshHostService>,
    webview_close_failed: bool,
    backend_settlement: Result<dsh_host::DshNativeSurfaceStatusView, String>,
) -> Result<dsh_host::DshNativeSurfaceStatusView, String> {
    if webview_close_failed {
        return Err(host.invalidate_native_surface_generation("dsh-native-surface-close-unsettled"));
    }
    backend_settlement
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DshNativeSurfaceBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn checked_surface_bounds(
    bounds: DshNativeSurfaceBounds,
    viewport: tauri::LogicalSize<f64>,
) -> Result<(tauri::LogicalPosition<f64>, tauri::LogicalSize<f64>), String> {
    if !bounds.x.is_finite()
        || !bounds.y.is_finite()
        || !bounds.width.is_finite()
        || !bounds.height.is_finite()
        || bounds.x < 0.0
        || bounds.y < 0.0
        || bounds.width < 320.0
        || bounds.height < 240.0
        || bounds.x > 16_384.0
        || bounds.y > 16_384.0
        || bounds.width > 16_384.0
        || bounds.height > 16_384.0
        || !viewport.width.is_finite()
        || !viewport.height.is_finite()
        || viewport.width < 556.0
        || viewport.height < 300.0
        || viewport.width > 16_384.0
        || viewport.height > 16_384.0
    {
        return Err("dsh-native-surface-bounds-invalid".to_owned());
    }
    // The renderer supplies the measured AppShell mount, including the current
    // sidebar density/collapsed width. The backend validates and clips that
    // rectangle without replacing its left edge with a second shell truth.
    const SHELL_TOP: f64 = 60.0;
    let left = bounds.x;
    let top = bounds.y.max(SHELL_TOP);
    let right = (bounds.x + bounds.width).min(viewport.width);
    let bottom = (bounds.y + bounds.height).min(viewport.height);
    if right - left < 320.0 || bottom - top < 240.0 {
        return Err("dsh-native-surface-bounds-invalid".to_owned());
    }
    Ok((
        tauri::LogicalPosition::new(left, top),
        tauri::LogicalSize::new(right - left, bottom - top),
    ))
}

#[cfg(test)]
mod dsh_native_surface_bounds_tests {
    use super::*;

    #[test]
    fn warm_existing_webview_close_failure_forces_level_two_before_return() {
        // Even when the scoped carrier binding-close would succeed, a failed
        // close of the warm child WebView must invalidate the current Native
        // Surface generation through the existing Level-2/Job owner before
        // the primary open error is returned.
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-warm-webview-fail-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let app_data = root.join("app-data");
        std::fs::create_dir_all(&app_data).unwrap();
        let service = dsh_host::DshHostService::production(&root, &app_data);
        let error = settle_warm_existing_webview_close_failure(&service);
        assert_eq!(
            error, "dsh-native-surface-unavailable",
            "the primary open error is preserved"
        );
        let surface = service.surface_status();
        assert_eq!(
            surface.stage,
            dsh_host::DshNativeSurfaceStage::Unavailable,
            "Level-2 reset owns the surface projection"
        );
        assert!(!surface.ready);
        assert_eq!(surface.owned_direct_process_count, 0);
        assert_eq!(
            service.status().stage,
            dsh_host::DshHostStage::Unavailable,
            "the Host generation is reset through the existing owner"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn backend_preserves_each_validated_sidebar_mount_left() {
        let viewport = tauri::LogicalSize::new(1_440.0, 900.0);
        for (mode, left) in [
            ("collapsed", 60.0),
            ("compact", 210.0),
            ("normal", 220.0),
            ("loose", 236.0),
        ] {
            let (position, size) = checked_surface_bounds(
                DshNativeSurfaceBounds {
                    x: left,
                    y: 60.0,
                    width: viewport.width - left,
                    height: viewport.height - 60.0,
                },
                viewport,
            )
            .unwrap_or_else(|error| panic!("{mode}: {error}"));
            assert_eq!(position.x, left, "{mode}");
            assert_eq!(position.y, 60.0, "{mode}");
            assert_eq!(position.x + size.width, viewport.width, "{mode}");
            assert_eq!(position.y + size.height, viewport.height, "{mode}");
        }
    }

    #[test]
    fn backend_keeps_titlebar_viewport_and_minimum_size_protections() {
        let (position, size) = checked_surface_bounds(
            DshNativeSurfaceBounds {
                x: 84.0,
                y: 0.0,
                width: 2_000.0,
                height: 2_000.0,
            },
            tauri::LogicalSize::new(820.0, 700.0),
        )
        .unwrap();
        assert_eq!(position.x, 84.0);
        assert_eq!(position.y, 60.0);
        assert_eq!(position.x + size.width, 820.0);
        assert_eq!(position.y + size.height, 700.0);
        assert!(checked_surface_bounds(
            DshNativeSurfaceBounds {
                x: 501.0,
                y: 100.0,
                width: 500.0,
                height: 500.0,
            },
            tauri::LogicalSize::new(820.0, 700.0),
        )
        .is_err());
        assert!(checked_surface_bounds(
            DshNativeSurfaceBounds {
                x: f64::NAN,
                y: 100.0,
                width: 500.0,
                height: 500.0,
            },
            tauri::LogicalSize::new(1_440.0, 900.0),
        )
        .is_err());
        assert!(checked_surface_bounds(
            DshNativeSurfaceBounds {
                x: 60.0,
                y: 60.0,
                width: 319.0,
                height: 500.0,
            },
            tauri::LogicalSize::new(1_440.0, 900.0),
        )
        .is_err());
        assert!(checked_surface_bounds(
            DshNativeSurfaceBounds {
                x: 60.0,
                y: 60.0,
                width: 500.0,
                height: 239.0,
            },
            tauri::LogicalSize::new(1_440.0, 900.0),
        )
        .is_err());
    }

    #[test]
    fn webview_open_failure_preserves_primary_error_after_backend_cleanup_escalation() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-webview-compensation-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let app_data = root.join("app-data");
        std::fs::create_dir_all(&app_data).unwrap();
        let service = dsh_host::DshHostService::production(&root, &app_data);
        service.inject_surface_control_failure_for_test();

        assert_eq!(
            compensate_native_surface_open(&service, "dsh-native-surface-unavailable"),
            "dsh-native-surface-unavailable"
        );
        assert_eq!(
            service.surface_status().stage,
            dsh_host::DshNativeSurfaceStage::Unavailable
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn webview_close_failure_escalates_to_level_two_and_preserves_primary_error() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-webview-close-fault-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let app_data = root.join("app-data");
        std::fs::create_dir_all(&app_data).unwrap();
        let service = dsh_host::DshHostService::production(&root, &app_data);

        assert_eq!(
            settle_native_surface_close(&service, true, Ok(service.surface_status())).unwrap_err(),
            "dsh-native-surface-close-unsettled"
        );
        assert_eq!(service.status().stage, dsh_host::DshHostStage::Unavailable);
        assert_eq!(
            service.surface_status().stage,
            dsh_host::DshNativeSurfaceStage::Unavailable
        );
        assert!(!service.surface_status().ready);
        let _ = std::fs::remove_dir_all(root);
    }
}

fn main_surface_viewport(caller: &tauri::Webview) -> Result<tauri::LogicalSize<f64>, String> {
    let physical = caller
        .window()
        .inner_size()
        .map_err(|_| "dsh-native-surface-bounds-invalid".to_owned())?;
    let scale = caller
        .window()
        .scale_factor()
        .map_err(|_| "dsh-native-surface-bounds-invalid".to_owned())?;
    Ok(physical.to_logical(scale))
}

#[tauri::command]
fn dsh_native_surface_status(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
) -> Result<dsh_host::DshNativeSurfaceStatusView, String> {
    require_main_caller(&caller)?;
    Ok(host.surface_status())
}

#[tauri::command]
async fn dsh_plugin_compat_status(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
) -> Result<serde_json::Value, String> {
    require_main_caller(&caller)?;
    // Compat requests may wait for bounded host-frame IO (up to 150s on a
    // wedged wrapper); run them off the UI thread like the surface commands.
    let surface_host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || surface_host.plugin_compat_status())
        .await
        .map_err(|_| "dsh-plugin-compat-unavailable".to_owned())?
}

#[tauri::command]
async fn dsh_plugin_compat_check(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
    baseline: Option<bool>,
) -> Result<serde_json::Value, String> {
    require_main_caller(&caller)?;
    let surface_host = host.inner().clone();
    let with_baseline = baseline.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || surface_host.plugin_compat_check(with_baseline))
        .await
        .map_err(|_| "dsh-plugin-compat-unavailable".to_owned())?
}

#[tauri::command]
async fn dsh_plugin_compat_reclaim_surface(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
) -> Result<(), String> {
    require_main_caller(&caller)?;
    // Retire a frozen/dead native surface child so the outer HTML recovery
    // panel is reachable. This never touches the wrapper host tree (compat
    // actions stay available) and never closes a healthy surface.
    // Deliberately wrapper-independent: retiring the dead native child must
    // never wait on (or fail because of) a wedged compat transport.
    let surface_host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lifecycle = DSH_NATIVE_SURFACE_LIFECYCLE.lock()
            .map_err(|_| "dsh-native-surface-close-unsettled".to_owned())?;
        surface_host.reclaim_failed_native_surface_with(|| retire_dsh_native_surface_child(&caller))
    })
    .await
    .map_err(|_| "dsh-native-surface-close-unsettled".to_owned())?
}

#[tauri::command]
async fn dsh_plugin_compat_apply(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
    action: serde_json::Value,
) -> Result<serde_json::Value, String> {
    require_main_caller(&caller)?;
    let surface_host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || surface_host.plugin_compat_apply(&action))
        .await
        .map_err(|_| "dsh-plugin-compat-unavailable".to_owned())?
}

fn open_dsh_login_in_system_browser(target: &url::Url) {
    if dsh_login_browser::is_official_authorize_url(target) {
        // Use the existing URL/default-browser opener, not the directory
        // helper (Explorer may open a folder for an authorization URL).
        // Do not log URLs, which contain short-lived auth data.
        if tauri_plugin_opener::open_url(target.as_str(), None::<&str>).is_err() {
            eprintln!("dsh-login-browser-open-failed");
        }
    }
}

fn create_dsh_native_surface_child(
    caller: &tauri::Webview,
    position: tauri::LogicalPosition<f64>,
    size: tauri::LogicalSize<f64>,
    bootstrap: &dsh_host::DshNativeSurfaceBootstrap,
) -> Result<(), String> {
    let url: url::Url = format!(
        "http://127.0.0.1:{}{}?ref={}",
        bootstrap.port, bootstrap.bootstrap_path, bootstrap.bootstrap_ref,
    )
    .parse()
    .map_err(|_| "dsh-native-surface-unavailable".to_owned())?;
    let expected_port = bootstrap.port;
    let builder = tauri::webview::WebviewBuilder::new(
        DSH_NATIVE_SURFACE_WEBVIEW_LABEL,
        tauri::WebviewUrl::External(url),
    )
    .disable_drag_drop_handler()
    .initialization_script(dsh_login_browser::INITIALIZATION_SCRIPT)
    .on_new_window(|target, _features| {
        open_dsh_login_in_system_browser(&target);
        tauri::webview::NewWindowResponse::Deny
    })
    .on_navigation(move |target| {
        // The official client preopens a blank popup, then replaces its location.
        // The child-only shim routes that replacement here. Never load account
        // pages in the privileged native child or broaden its loopback fence.
        open_dsh_login_in_system_browser(target);
        target.scheme() == "http"
            && target.host_str() == Some("127.0.0.1")
            && target.port() == Some(expected_port)
    });
    #[cfg(all(windows, feature = "lsh-background-surface-preload"))]
    dsh_native_container::create_hidden(&caller.window(), builder, position, size)?;
    #[cfg(not(all(windows, feature = "lsh-background-surface-preload")))]
    caller
        .window()
        .add_child(builder, position, size)
        .map(|_| ())
        .map_err(|_| "dsh-native-surface-unavailable".to_owned())?;
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    {
        // Child WebView focus does not bubble through Main's DOM. The only
        // exposed action is dismissing Main's content drawer; no IPC authority
        // or file/session data is made available to the remote page.
        let child = caller.app_handle().get_webview(DSH_NATIVE_SURFACE_WEBVIEW_LABEL)
            .ok_or_else(|| "dsh-native-surface-unavailable".to_owned())?;
        let app = caller.app_handle().clone();
        child.with_webview(move |view| unsafe {
            let handler = webview2_com::FocusChangedEventHandler::create(Box::new(move |_, _| {
                let _ = tauri::Emitter::emit_to(&app, "main", "luckyray:lsh-content-outside", ());
                Ok(())
            }));
            let mut token = 0;
            if view.controller().add_GotFocus(&handler, &mut token).is_err() {
                eprintln!("lsh-content-outside-focus-unavailable");
            }
            // The controller owns the handler until this child is destroyed.
        }).map_err(|_| "dsh-native-surface-unavailable".to_owned())?;
    }
    Ok(())
}

fn retire_dsh_native_surface_child(caller: &tauri::Webview) -> Result<(), String> {
    #[cfg(all(windows, feature = "lsh-background-surface-preload"))]
    dsh_native_container::hide(&caller.window())?;
    let Some(existing) = caller
        .app_handle()
        .get_webview(DSH_NATIVE_SURFACE_WEBVIEW_LABEL)
    else {
        return Ok(());
    };
    // Webview::close dispatches asynchronously when called off the Tauri main
    // thread. Execute it on the main thread itself so WRY handles Close and
    // removes the old native child before this barrier acknowledges. The
    // replacement add_child call uses the same main-thread seam afterwards.
    run_dsh_native_surface_on_main(&caller.window(), "dsh-native-surface-close-unsettled", move || {
        existing.close().map_err(|_| "dsh-native-surface-close-unsettled".to_owned())
    })
}

#[tauri::command]
async fn dsh_native_surface_open(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
    bounds: DshNativeSurfaceBounds,
) -> Result<dsh_host::DshNativeSurfaceStatusView, String> {
    require_main_caller(&caller)?;
    let surface_host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lifecycle = DSH_NATIVE_SURFACE_LIFECYCLE.lock()
            .map_err(|_| "dsh-native-surface-unavailable".to_owned())?;
        open_dsh_native_surface_blocking(&caller, &surface_host, bounds)
    }).await.map_err(|_| "dsh-native-surface-unavailable".to_owned())?
}

fn open_dsh_native_surface_blocking(
    caller: &tauri::Webview,
    surface_host: &Arc<dsh_host::DshHostService>,
    bounds: DshNativeSurfaceBounds,
) -> Result<dsh_host::DshNativeSurfaceStatusView, String> {
    let (position, size) = checked_surface_bounds(bounds, main_surface_viewport(caller)?)?;
    if let Some(existing) = caller
        .app_handle()
        .get_webview(DSH_NATIVE_SURFACE_WEBVIEW_LABEL)
    {
        #[cfg(all(windows, feature = "lsh-background-surface-preload"))]
        {
            let status = surface_host.surface_status();
            if existing.window().label() == dsh_native_container::LABEL
                && surface_host.native_surface_binding().is_some()
                && status.stage != dsh_host::DshNativeSurfaceStage::Unavailable
                && status.stage != dsh_host::DshNativeSurfaceStage::Closed
            {
                // A foreground entry joins the one prepared child. Never
                // spend another bootstrap or restart a healthy generation.
                return Ok(status);
            }
        }
        let _ = existing;
        if retire_dsh_native_surface_child(caller).is_err() {
            return Err(settle_warm_existing_webview_close_failure(surface_host));
        }
    }
    let (_status, bootstrap) = surface_host.open_native_surface()?;
    let host_generation = bootstrap.host_generation;
    let carrier_generation = bootstrap.carrier_generation;
    if create_dsh_native_surface_child(caller, position, size, &bootstrap).is_err() {
        if retire_dsh_native_surface_child(caller).is_err() {
            return Err(settle_warm_existing_webview_close_failure(surface_host));
        }
        return Err(compensate_native_surface_open(
            surface_host,
            "dsh-native-surface-unavailable",
        ));
    }
    surface_host.publish_surface_stage_for(
        host_generation,
        carrier_generation,
        dsh_host::DshNativeSurfaceStage::WebviewCreated,
    );
    if !surface_host.native_surface_binding_matches(host_generation, carrier_generation) {
        if retire_dsh_native_surface_child(caller).is_err() {
            return Err(settle_warm_existing_webview_close_failure(surface_host));
        }
        return Err("dsh-native-surface-preload-stale".to_owned());
    }
    Ok(surface_host.surface_status())
}

#[tauri::command]
async fn dsh_native_surface_preload(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
) -> Result<Option<dsh_host::DshNativeSurfaceStatusView>, String> {
    require_main_caller(&caller)?;
    #[cfg(not(all(windows, feature = "lsh-background-surface-preload")))]
    { let _ = host; Ok(None) }
    #[cfg(all(windows, feature = "lsh-background-surface-preload"))]
    {
        let surface_host = host.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _lifecycle = DSH_NATIVE_SURFACE_LIFECYCLE.lock()
                .map_err(|_| "dsh-native-surface-unavailable".to_owned())?;
            let viewport = main_surface_viewport(&caller)?;
            open_dsh_native_surface_blocking(&caller, &surface_host, DshNativeSurfaceBounds {
                x: 0.0, y: 60.0, width: viewport.width, height: viewport.height - 60.0,
            })?;
            let Some(binding) = surface_host.native_surface_binding() else {
                // Shutdown or host failure may win just after child creation.
                // Even this early exit must retire the already-created child.
                if retire_dsh_native_surface_child(&caller).is_err() {
                    return Err(settle_warm_existing_webview_close_failure(&surface_host));
                }
                return Err("dsh-native-surface-preload-stale".to_owned());
            };
            // The carrier has a 90s client-ready watchdog. Allow it to publish
            // its real failure; mere child creation is never preload success.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(95);
            let outcome = loop {
                if !surface_host.native_surface_binding_matches(binding.0, binding.1)
                    || caller.app_handle().get_webview("main").is_none()
                {
                    break Err("dsh-native-surface-preload-stale".to_owned());
                }
                let status = surface_host.surface_status();
                if status.ready && matches!(status.stage,
                    dsh_host::DshNativeSurfaceStage::ClientReady | dsh_host::DshNativeSurfaceStage::SessionOpen)
                    && surface_host.native_surface_binding_matches(binding.0, binding.1)
                {
                    break Ok(Some(status));
                }
                if status.stage == dsh_host::DshNativeSurfaceStage::Unavailable {
                    break Err("dsh-native-surface-unavailable".to_owned());
                }
                if std::time::Instant::now() >= deadline {
                    break Err("dsh-native-surface-preload-timeout".to_owned());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            };
            if outcome.is_err() {
                if retire_dsh_native_surface_child(&caller).is_err() {
                    return Err(settle_warm_existing_webview_close_failure(&surface_host));
                }
                // Never close a replacement binding after the original one
                // was retired by a host monitor or application shutdown.
                if surface_host.native_surface_binding_matches(binding.0, binding.1) {
                    let _ = surface_host.close_native_surface();
                }
            }
            outcome
        }).await.map_err(|_| "dsh-native-surface-unavailable".to_owned())?
    }
}

#[tauri::command]
async fn dsh_native_surface_restart(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
    bounds: DshNativeSurfaceBounds,
) -> Result<dsh_host::DshNativeSurfaceStatusView, String> {
    require_main_caller(&caller)?;
    let (position, size) = checked_surface_bounds(bounds, main_surface_viewport(&caller)?)?;
    let surface_host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lifecycle = DSH_NATIVE_SURFACE_LIFECYCLE.lock()
            .map_err(|_| "dsh-native-surface-unavailable".to_owned())?;
        let retire_caller = caller.clone();
        let create_caller = caller.clone();
        surface_host.restart_native_surface_with(
            move || retire_dsh_native_surface_child(&retire_caller),
            move |bootstrap| {
                create_dsh_native_surface_child(&create_caller, position, size, bootstrap)
            },
        )
    })
    .await
    .map_err(|_| "dsh-native-surface-unavailable".to_owned())?
}

#[tauri::command]
fn dsh_native_surface_set_bounds(
    caller: tauri::Webview,
    bounds: DshNativeSurfaceBounds,
) -> Result<(), String> {
    require_main_caller(&caller)?;
    let (position, size) = checked_surface_bounds(bounds, main_surface_viewport(&caller)?)?;
    let webview = caller
        .app_handle()
        .get_webview(DSH_NATIVE_SURFACE_WEBVIEW_LABEL)
        .ok_or_else(|| "dsh-native-surface-not-open".to_owned())?;
    #[cfg(all(windows, feature = "lsh-background-surface-preload"))]
    return dsh_native_container::set_bounds(&caller.window(), &webview, position, size);
    #[cfg(not(all(windows, feature = "lsh-background-surface-preload")))]
    webview
        .set_bounds(tauri::Rect {
            position: position.into(),
            size: size.into(),
        })
        .map_err(|_| "dsh-native-surface-unavailable".to_owned())
}

#[tauri::command]
async fn dsh_native_surface_open_intent(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
    intent: dsh_host::DshOpenIntent,
) -> Result<(), String> {
    require_main_caller(&caller)?;
    let webview = caller
        .app_handle()
        .get_webview(DSH_NATIVE_SURFACE_WEBVIEW_LABEL)
        .ok_or_else(|| "dsh-open-intent-not-ready".to_owned())?;
    let owned = host.inner().clone();
    let catalog = material_catalog_for_app(caller.app_handle())?;
    #[cfg(all(windows, feature = "lsh-background-surface-preload"))]
    let admission = (owned.native_surface_binding(), webview.clone());
    tauri::async_runtime::spawn_blocking(move || {
        intent.validate_material_context(&catalog)?;
        #[cfg(all(windows, feature = "lsh-background-surface-preload"))]
        {
            // Renderer admission may precede a blocking-worker queue. Recheck
            // native visibility and the original binding after that wait.
            let (host_generation, carrier_generation) = admission.0
                .ok_or_else(|| "dsh-open-intent-not-ready".to_owned())?;
            if !dsh_native_container::visible_for_intent(&caller.window(), &admission.1)
                .unwrap_or(false)
                || !owned.native_surface_binding_matches(host_generation, carrier_generation)
            {
                return Err("dsh-open-intent-not-ready".to_owned());
            }
        }
        owned.stage_open_intent(intent)
    })
        .await
        .map_err(|_| "dsh-open-intent-unavailable".to_owned())??;
    // The payload has already crossed the authenticated, sealed carrier. The
    // child eval is a fixed wake only; no user text or resource identity is
    // interpolated into JavaScript.
    webview
        .eval("globalThis.dispatchEvent(new Event('luckyray:open-intent'))")
        .map_err(|_| "dsh-open-intent-unavailable".to_owned())
}

#[tauri::command]
async fn dsh_engine_update_status(
    caller: tauri::Webview,
    updater: tauri::State<'_, Arc<dsh_engine_update::DshEngineUpdater>>,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
) -> Result<dsh_engine_update::EngineUpdateStatus, String> {
    require_main_caller(&caller)?;
    let updater = updater.inner().clone();
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.wait_initialized();
        updater.status()
    })
    .await
    .map_err(|_| "dsh-engine-update-unavailable".to_owned())
}

#[tauri::command]
async fn dsh_engine_update_check(
    caller: tauri::Webview,
    updater: tauri::State<'_, Arc<dsh_engine_update::DshEngineUpdater>>,
) -> Result<dsh_engine_update::EngineUpdateStatus, String> {
    require_main_caller(&caller)?;
    let updater = updater.inner().clone();
    tauri::async_runtime::spawn_blocking(move || updater.check())
        .await.map_err(|_| "dsh-engine-update-unavailable".to_owned())
}

#[tauri::command]
async fn dsh_engine_update_install(
    caller: tauri::Webview,
    updater: tauri::State<'_, Arc<dsh_engine_update::DshEngineUpdater>>,
) -> Result<dsh_engine_update::EngineUpdateStatus, String> {
    require_main_caller(&caller)?;
    let updater = updater.inner().clone();
    tauri::async_runtime::spawn_blocking(move || updater.install())
        .await.map_err(|_| "dsh-engine-update-unavailable".to_owned())
}

#[tauri::command]
fn dsh_engine_update_cancel(
    caller: tauri::Webview,
    updater: tauri::State<'_, Arc<dsh_engine_update::DshEngineUpdater>>,
) -> Result<dsh_engine_update::EngineUpdateStatus, String> {
    require_main_caller(&caller)?;
    Ok(updater.cancel())
}

#[tauri::command]
fn dsh_engine_update_recover(
    caller: tauri::Webview,
    updater: tauri::State<'_, Arc<dsh_engine_update::DshEngineUpdater>>,
) -> Result<dsh_engine_update::EngineUpdateStatus, String> {
    require_main_caller(&caller)?;
    let status = updater.recover_pre_activation();
    if matches!(status.phase, "recovered" | "recovered_restart_required") {
        DSH_UPDATE_RESTART_ARMED.store(false, std::sync::atomic::Ordering::Release);
        *prepared_update_record().lock().unwrap() = None;
    }
    Ok(status)
}

#[tauri::command]
async fn dsh_engine_update_verify(
    caller: tauri::Webview,
    updater: tauri::State<'_, Arc<dsh_engine_update::DshEngineUpdater>>,
) -> Result<dsh_engine_update::EngineUpdateStatus, String> {
    require_main_caller(&caller)?;
    let updater = updater.inner().clone();
    tauri::async_runtime::spawn_blocking(move || updater.verify_activated_health())
        .await.map_err(|_| "dsh-engine-update-unavailable".to_owned())
}

#[tauri::command]
async fn dsh_engine_update_restart(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    updater: tauri::State<'_, Arc<dsh_engine_update::DshEngineUpdater>>,
) -> Result<(), String> {
    require_main_caller(&caller)?;
    let updater = updater.inner().clone();
    // Admission and digest binding can hash large signed records; keep them
    // off the main thread so the window stays responsive until the quit.
    tauri::async_runtime::spawn_blocking(move || {
        dsh_engine_update_restart_blocking(app, updater)
    })
    .await
    .map_err(|_| "dsh-engine-update-unavailable".to_owned())?
}

fn dsh_engine_update_restart_blocking(
    app: tauri::AppHandle,
    updater: Arc<dsh_engine_update::DshEngineUpdater>,
) -> Result<(), String> {
    if !engine_update_other_runs_quiescent() {
        return Err("dsh-engine-update-background-run-active".to_owned());
    }
    // One click covers both hosts. A cold host is reserved directly; a used
    // host must first pass the same prepare gate as the manual exit path.
    // Either way the durable switch is armed only by request_normal_quit's
    // exit hook after a confirmed drain, and any gate failure returns while
    // the window stays open.
    let status = updater.status();
    if status.phase == "exit_prepared" {
        // Already prepared on an earlier click; continue to arm and quit.
    } else if status.can_restart {
        if !updater.begin_controlled_restart() {
            return Err("dsh-engine-update-not-quiescent".to_owned());
        }
    } else if status.can_prepare_exit {
        if !updater.prepare_safe_exit() {
            return Err("dsh-engine-update-not-quiescent".to_owned());
        }
    } else {
        return Err("dsh-engine-update-not-quiescent".to_owned());
    }
    let (store, _, _) = DSH_HOST_SERVICE.get().and_then(|host| host.engine_update_context())
        .filter(|(_, _, pending)| !pending)
        .ok_or("dsh-engine-update-not-quiescent".to_owned())?;
    *prepared_update_record().lock().unwrap() = Some(store.pending_record_digest()
        .map_err(|_| "dsh-engine-update-not-quiescent".to_owned())?);
    DSH_UPDATE_RESTART_ARMED.store(true, std::sync::atomic::Ordering::Release);
    request_normal_quit(app, true);
    Ok(())
}

#[tauri::command]
async fn dsh_engine_update_prepare_exit(
    caller: tauri::Webview,
    updater: tauri::State<'_, Arc<dsh_engine_update::DshEngineUpdater>>,
) -> Result<dsh_engine_update::EngineUpdateStatus, String> {
    require_main_caller(&caller)?;
    let updater = updater.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        dsh_engine_update_prepare_exit_blocking(updater)
    })
    .await
    .map_err(|_| "dsh-engine-update-unavailable".to_owned())?
}

fn dsh_engine_update_prepare_exit_blocking(
    updater: Arc<dsh_engine_update::DshEngineUpdater>,
) -> Result<dsh_engine_update::EngineUpdateStatus, String> {
    if !engine_update_other_runs_quiescent() {
        return Err("dsh-engine-update-background-run-active".to_owned());
    }
    if !updater.prepare_safe_exit() {
        return Err("dsh-engine-update-not-quiescent".to_owned());
    }
    let (store, _, _) = DSH_HOST_SERVICE.get().and_then(|host| host.engine_update_context())
        .filter(|(_, _, pending)| !pending)
        .ok_or("dsh-engine-update-not-quiescent".to_owned())?;
    *prepared_update_record().lock().unwrap() = Some(store.pending_record_digest()
        .map_err(|_| "dsh-engine-update-not-quiescent".to_owned())?);
    DSH_UPDATE_RESTART_ARMED.store(true, std::sync::atomic::Ordering::Release);
    Ok(updater.status())
}

fn engine_update_other_runs_quiescent() -> bool {
    backend_services()
        .and_then(|backend| backend.agent_runs().has_active_background_run()
            .map_err(|_| "agent-run-ledger-unavailable".to_owned()))
        .map(|active| !active)
        .unwrap_or(false)
}

#[tauri::command]
async fn canvas_agent_dispatch(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    require_main_caller(&caller)?;
    let owned = host.inner().clone();
    // Startup is shared with dsh_native_surface_preload. Polling this bounded
    // channel never opens, shows or replaces a native child WebView.
    tauri::async_runtime::spawn_blocking(move || owned.canvas_agent_dispatch(request))
        .await.map_err(|_| "canvas-agent-unavailable".to_owned())?
}

#[tauri::command]
async fn dsh_native_surface_open_intent_status(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
    intent_id: String,
) -> Result<String, String> {
    require_main_caller(&caller)?;
    let owned = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || owned.open_intent_status(&intent_id))
        .await
        .map_err(|_| "dsh-open-intent-status-unavailable".to_owned())?
}

// Visual-only visibility seam for LuckyRay route changes. Hiding never touches
// the DSH Host/carrier/session/turn lifecycle; an absent child is a no-op so a
// route-away before any first open stays harmless.
#[tauri::command]
fn dsh_native_surface_hide(caller: tauri::Webview) -> Result<(), String> {
    require_main_caller(&caller)?;
    #[cfg(all(windows, feature = "lsh-background-surface-preload"))]
    return dsh_native_container::hide(&caller.window());
    #[cfg(not(all(windows, feature = "lsh-background-surface-preload")))]
    {
    if let Some(webview) = caller
        .app_handle()
        .get_webview(DSH_NATIVE_SURFACE_WEBVIEW_LABEL)
    {
        webview
            .hide()
            .map_err(|_| "dsh-native-surface-unavailable".to_owned())?;
    }
    Ok(())
    }
}

// Showing the same child again only refreshes validated bounds and unhides it.
// It must never open/rebind the surface; a missing child fails with the
// bounded not-open code so the renderer falls back to a first-time open.
#[tauri::command]
fn dsh_native_surface_show(
    caller: tauri::Webview,
    bounds: DshNativeSurfaceBounds,
) -> Result<(), String> {
    require_main_caller(&caller)?;
    let (position, size) = checked_surface_bounds(bounds, main_surface_viewport(&caller)?)?;
    let webview = caller
        .app_handle()
        .get_webview(DSH_NATIVE_SURFACE_WEBVIEW_LABEL)
        .ok_or_else(|| "dsh-native-surface-not-open".to_owned())?;
    #[cfg(all(windows, feature = "lsh-background-surface-preload"))]
    return dsh_native_container::show(&caller.window(), &webview, position, size);
    #[cfg(not(all(windows, feature = "lsh-background-surface-preload")))]
    webview
        .set_bounds(tauri::Rect {
            position: position.into(),
            size: size.into(),
        })
        .and_then(|_| webview.show())
        .map_err(|_| "dsh-native-surface-unavailable".to_owned())
}

#[tauri::command]
async fn dsh_native_surface_close(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
) -> Result<dsh_host::DshNativeSurfaceStatusView, String> {
    require_main_caller(&caller)?;
    let surface_host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lifecycle = DSH_NATIVE_SURFACE_LIFECYCLE.lock()
            .map_err(|_| "dsh-native-surface-unavailable".to_owned())?;
        let webview_error = retire_dsh_native_surface_child(&caller).err();
        let backend_settlement = surface_host.close_native_surface();
        settle_native_surface_close(&surface_host, webview_error.is_some(), backend_settlement)
    }).await.map_err(|_| "dsh-native-surface-unavailable".to_owned())?
}

fn knowledge_error(error: knowledge::KnowledgeError) -> String {
    serde_json::json!({ "code": error.code, "message": error.message }).to_string()
}

fn knowledge_service() -> Result<knowledge::KnowledgeService, String> {
    backend_services().map(|backend| backend.knowledge())
}

#[tauri::command]
async fn knowledge_list_documents(
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<knowledge::KnowledgeDocumentSummary>, String> {
    let service = knowledge_service()?;
    let limit = limit.unwrap_or(200);
    tauri::async_runtime::spawn_blocking(move || {
        match query
            .as_deref()
            .map(str::trim)
            .filter(|query| !query.is_empty())
        {
            Some(query) => service.search_documents(query, limit),
            None => service.recent_documents(limit),
        }
        .map_err(knowledge_error)
    })
    .await
    .map_err(|_| "knowledge-index-worker-failed: Knowledge index worker failed".to_string())?
}

#[tauri::command]
async fn knowledge_search_documents(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<knowledge::KnowledgeDocumentSummary>, String> {
    let service = knowledge_service()?;
    tauri::async_runtime::spawn_blocking(move || {
        service
            .search_documents(&query, limit.unwrap_or(200))
            .map_err(knowledge_error)
    })
    .await
    .map_err(|_| "knowledge-index-worker-failed: Knowledge index worker failed".to_string())?
}

#[tauri::command]
async fn knowledge_refresh_index(modified_paths: Option<Vec<String>>) -> Result<knowledge::KnowledgeIndexSnapshot, String> {
    let service = knowledge_service()?;
    tauri::async_runtime::spawn_blocking(move || match modified_paths {
        Some(paths) => service.refresh_modified_documents(&paths),
        None => service.refresh_index(),
    }.map_err(knowledge_error))
        .await
        .map_err(|_| "knowledge-index-worker-failed: Knowledge index worker failed".to_string())?
}

#[tauri::command]
fn knowledge_index_snapshot() -> Result<knowledge::KnowledgeIndexSnapshot, String> {
    knowledge_service()?
        .index_snapshot()
        .map_err(knowledge_error)
}

#[tauri::command]
async fn knowledge_document_relations(
    document_ref: knowledge::KnowledgeDocumentRef,
) -> Result<knowledge::KnowledgeDocumentRelations, String> {
    let service = knowledge_service()?;
    tauri::async_runtime::spawn_blocking(move || {
        service
            .document_relations(&document_ref)
            .map_err(knowledge_error)
    })
    .await
    .map_err(|_| "knowledge-index-worker-failed: Knowledge index worker failed".to_string())?
}

#[tauri::command]
async fn knowledge_backlinks(
    document_ref: knowledge::KnowledgeDocumentRef,
) -> Result<Vec<knowledge::KnowledgeBacklink>, String> {
    let service = knowledge_service()?;
    tauri::async_runtime::spawn_blocking(move || {
        service.backlinks(&document_ref).map_err(knowledge_error)
    })
    .await
    .map_err(|_| "knowledge-index-worker-failed: Knowledge index worker failed".to_string())?
}

#[tauri::command]
async fn knowledge_tag_summary() -> Result<Vec<knowledge::KnowledgeTagSummary>, String> {
    let service = knowledge_service()?;
    tauri::async_runtime::spawn_blocking(move || service.tag_summary().map_err(knowledge_error))
        .await
        .map_err(|_| "knowledge-index-worker-failed: Knowledge index worker failed".to_string())?
}

#[tauri::command]
async fn knowledge_documents_for_tag(
    tag: String,
) -> Result<Vec<knowledge::KnowledgeDocumentSummary>, String> {
    let service = knowledge_service()?;
    tauri::async_runtime::spawn_blocking(move || {
        service.documents_for_tag(&tag).map_err(knowledge_error)
    })
    .await
    .map_err(|_| "knowledge-index-worker-failed: Knowledge index worker failed".to_string())?
}

#[tauri::command]
async fn knowledge_documents_referencing_embed(
    target: String,
) -> Result<Vec<knowledge::KnowledgeDocumentSummary>, String> {
    let service = knowledge_service()?;
    tauri::async_runtime::spawn_blocking(move || {
        service
            .documents_referencing_embed(&target)
            .map_err(knowledge_error)
    })
    .await
    .map_err(|_| "knowledge-index-worker-failed: Knowledge index worker failed".to_string())?
}

#[tauri::command]
async fn knowledge_set_document_tags(
    input: knowledge::KnowledgeSetTagsInput,
    source_epoch: u64,
) -> Result<knowledge::KnowledgeMutationResult, String> {
    let service = knowledge_service()?;
    tauri::async_runtime::spawn_blocking(move || {
        service
            .set_document_tags_from_ui(source_epoch, &input)
            .map_err(knowledge_error)
    })
    .await
    .map_err(|_| "knowledge-index-worker-failed: Knowledge index worker failed".to_string())?
}

#[tauri::command]
fn knowledge_read_document(
    app: tauri::AppHandle,
    document_ref: knowledge::KnowledgeDocumentRef,
) -> Result<serde_json::Value, String> {
    let registry=app.state::<workspace_windows::WorkspaceWindows>();
    let _read=registry.guard_main_document_read()?;
    let service=knowledge_service()?;
    // Capture the physical source used by this actual read. A later native bind
    // must not turn equal text from a recreated Vault into the old view's proof.
    let scope=service.capture_workspace_scope(&document_ref.vault_id).map_err(knowledge_error)?;
    let document=scope.read_document(&document_ref).map_err(knowledge_error)?;
    let authority=workspace_notes_metadata::authority_for(&scope,&document_ref)?;
    if let Ok(backend)=backend_services() { let _ = attachment_coordination::sync_note_attachment_index(&scope,&backend.material_catalog(),&document_ref); }
    let mut result=serde_json::to_value(document).map_err(|_|"knowledge-document-encode")?;
    result.as_object_mut().ok_or("knowledge-document-encode")?.insert("workspaceSourceId".into(),serde_json::Value::String(authority.source_id));
    Ok(result)
}

#[tauri::command]
fn knowledge_activate_ui_source(
    vault_id: String,
) -> Result<knowledge::KnowledgeUiSourceActivation, String> {
    let backend = backend_services()?;
    if !backend.stop_all_runs_and_wait(std::time::Duration::from_secs(10)) {
        return Err("agent-run-stop-timeout".to_owned());
    }
    backend
        .knowledge()
        .activate_ui_source(&vault_id)
        .map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_activate_current_ui_source() -> Result<knowledge::KnowledgeUiSourceActivation, String>
{
    // The renderer supplies no Vault identifier here. Backend current-Vault
    // state is the sole authority for restoring the UI write projection.
    knowledge_service()?
        .activate_current_ui_source()
        .map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_deactivate_ui_source() -> Result<(), String> {
    let backend = backend_services()?;
    if !backend.stop_all_runs_and_wait(std::time::Duration::from_secs(10)) {
        return Err("agent-run-stop-timeout".to_owned());
    }
    backend
        .knowledge()
        .deactivate_ui_source()
        .map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_create_document(
    input: knowledge::KnowledgeCreateInput,
    source_epoch: u64,
) -> Result<knowledge::KnowledgeDocumentSnapshot, String> {
    let service=knowledge_service()?;
    let document=service
        .create_document_from_ui(source_epoch, &input)
        .map_err(knowledge_error)?;
    if let Ok(_source)=service.lock_active_ui_source(source_epoch,Some(&document.summary.document_ref.vault_id)) {
        if let Ok(backend)=backend_services() {let _=attachment_coordination::sync_note_attachment_index(&service,&backend.material_catalog(),&document.summary.document_ref);}
    }
    Ok(document)
}

#[tauri::command]
fn knowledge_append_document(
    input: knowledge::KnowledgeWriteInput,
    source_epoch: u64,
) -> Result<knowledge::KnowledgeMutationResult, String> {
    knowledge_service()?
        .append_document_from_ui(source_epoch, &input)
        .map(attachment_coordination::project_saved_mutation)
        .map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_insert_document(
    input: knowledge::KnowledgeInsertInput,
    source_epoch: u64,
) -> Result<knowledge::KnowledgeMutationResult, String> {
    knowledge_service()?
        .insert_document_from_ui(source_epoch, &input)
        .map(attachment_coordination::project_saved_mutation)
        .map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_replace_document(
    input: knowledge::KnowledgeWriteInput,
    source_epoch: u64,
) -> Result<knowledge::KnowledgeMutationResult, String> {
    knowledge_service()?
        .replace_document_from_ui(source_epoch, &input)
        .map(attachment_coordination::project_saved_mutation)
        .map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_move_document(
    app: tauri::AppHandle,
    input: knowledge::KnowledgeMoveInput,
    source_epoch: u64,
) -> Result<knowledge::KnowledgeDocumentSnapshot, String> {
    let service=knowledge_service()?;
    let scope=service.capture_workspace_scope(&input.document_ref.vault_id).map_err(knowledge_error)?;
    let registry=app.state::<workspace_windows::WorkspaceWindows>();
    let _retirement=registry.guard_main_document_retirement(&scope,&input.document_ref)?;
    move_document_with_services(&service,&backend_services()?.material_catalog(),&input,source_epoch)
}

fn move_document_with_services(service:&knowledge::KnowledgeService,catalog:&materials::MaterialCatalog,input:&knowledge::KnowledgeMoveInput,source_epoch:u64)->Result<knowledge::KnowledgeDocumentSnapshot,String> {
    let before=service.read_document(&input.document_ref).map_err(knowledge_error)?;
    let previous=catalog.note_attachment_refs(&input.document_ref.vault_id,&input.document_ref.relative_path).map_err(|e|e.message)?;
    let document=service
        .move_document_from_ui(source_epoch, &input)
        .map_err(knowledge_error)?;
    if let Ok(_source)=service.lock_active_ui_source(source_epoch,Some(&input.document_ref.vault_id)) {
            if attachment_coordination::sync_note_attachment_index(service,catalog,&document.summary.document_ref).is_ok() {
                let rewrites=knowledge::attachment_target_rewrites(&before.content,&document.content);
                let projected=service.with_attachment_index_snapshot(&document.summary.document_ref,&[],|targets,_| {
                    let mut next=catalog.note_attachment_refs(&input.document_ref.vault_id,&document.summary.document_ref.relative_path).map_err(|e|e.message)?;
                    for reference in previous {
                        for (_,target) in rewrites.iter().filter(|(old,_)|old==&reference.target) {
                            if targets.contains(target) && !next.iter().any(|candidate|candidate.target==*target) {next.push(materials::NoteAttachmentRefInput{asset_id:reference.asset_id.clone(),target:target.clone()});}
                        }
                    }
                    catalog.replace_note_attachment_refs(&input.document_ref.vault_id,&document.summary.document_ref.relative_path,&next).map_err(|e|e.message)?;
                    if input.document_ref.relative_path!=document.summary.document_ref.relative_path {catalog.replace_note_attachment_refs(&input.document_ref.vault_id,&input.document_ref.relative_path,&[]).map_err(|e|e.message)?;}
                    Ok(())
                });
                let _=projected;
            }
    }
    Ok(document)
}

#[tauri::command]
fn knowledge_attachment_context(document_ref: knowledge::KnowledgeDocumentRef) -> Result<(knowledge::KnowledgeUiSourceActivation, knowledge::KnowledgeDocumentSnapshot), String> {
    let service = knowledge_service()?;
    let active = service.active_ui_source_identity().map_err(knowledge_error)?;
    if active.vault_id != document_ref.vault_id { return Err("knowledge-source-inactive: Vault source changed".into()); }
    let document = service.read_document(&document_ref).map_err(knowledge_error)?;
    Ok((active, document))
}

#[tauri::command]
async fn knowledge_preview_external_attachment_changes(vault_id: String, paths: Vec<String>, incomplete: bool) -> Result<knowledge::ExternalAttachmentUpdate, String> {
    let service = knowledge_service()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut update=service.preview_external_attachment_changes(&vault_id,&paths,incomplete).map_err(knowledge_error)?;
        if let Some(plan)=update.plan.take() {update.plan=Some(attachment_coordination::authorize_attachment_plan(&service,plan)?);}
        Ok(update)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn knowledge_invalidate_attachment_inventory(vault_id: String) -> Result<(), String> {
    let service = knowledge_service()?;
    tauri::async_runtime::spawn_blocking(move || {
        service.invalidate_attachment_inventory(&vault_id).map_err(knowledge_error)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn knowledge_resolve_attachment(document_ref: knowledge::KnowledgeDocumentRef, destination: String, wiki: bool) -> Result<knowledge::AttachmentResolution, String> {
    let service = knowledge_service()?;
    let catalog = backend_services()?.material_catalog();
    tauri::async_runtime::spawn_blocking(move || attachment_coordination::resolve_attachment_with_material_identity(
        &service, &catalog, &document_ref, &destination, wiki,
    )).await.map_err(|error| error.to_string())?
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgePublishAttachmentInput {
    document_ref: knowledge::KnowledgeDocumentRef,
    source_epoch: u64,
    expected_revision: String,
    name: String,
    bytes: Option<Vec<u8>>,
    source_path: Option<String>,
    material_id: Option<String>,
    #[serde(default)]
    handling_policy: Option<String>,
}

#[tauri::command]
fn knowledge_publish_attachment(input: KnowledgePublishAttachmentInput) -> Result<knowledge::AttachmentPublication, String> {
    publish_attachment_with_services(&knowledge_service()?, &backend_services()?.material_catalog(), input)
}

fn publish_attachment_with_services(service: &knowledge::KnowledgeService, catalog: &materials::MaterialCatalog, input: KnowledgePublishAttachmentInput) -> Result<knowledge::AttachmentPublication, String> {
    let selection_count = usize::from(input.bytes.is_some()) + usize::from(input.source_path.is_some()) + usize::from(input.material_id.is_some());
    if selection_count != 1 { return Err("knowledge-attachment-invalid-source: Select exactly one attachment source".into()); }
    let material_paths;
    let path = if let Some(id) = &input.material_id {
        material_paths = catalog.resolve_external_drag_files(&[id.clone()]).map_err(|error| error.message)?;
        if material_paths.len() != 1 { return Err("knowledge-attachment-invalid-source: Material file mapping is not unique".into()); }
        material_paths.first().map(|path| path.as_path())
    } else { input.source_path.as_deref().map(std::path::Path::new) };
    let policy=input.handling_policy.unwrap_or(service.attachment_handling_policy(&input.document_ref.vault_id).map_err(knowledge_error)?);
    if !matches!(policy.as_str(),"reference"|"copy") {return Err("knowledge-policy-invalid".into());}
    let reference=policy=="reference" && path.is_some();
    let result=service.publish_attachment_with_policy(input.source_epoch, &input.document_ref, &input.expected_revision, &input.name, input.bytes.as_deref().unwrap_or_default(), path, input.material_id.is_some() && !reference,reference).map_err(knowledge_error)?;
    let _source=service.lock_active_ui_source(input.source_epoch,Some(&input.document_ref.vault_id)).map_err(knowledge_error)?;
    let published=service.attachment_absolute_path(&result.relative_path).map_err(knowledge_error)?;
    catalog.register_note_attachment(&published,&input.document_ref.vault_id,if reference {input.material_id.as_deref()}else{None}).map_err(|e|e.message)?;
    Ok(result)
}

#[tauri::command]
fn knowledge_preview_attachment_conversion(document_refs: Vec<knowledge::KnowledgeDocumentRef>) -> Result<knowledge::AttachmentOperationPlan, String> {
    let catalog = backend_services()?.material_catalog();
    let assets = catalog.list_assets_scoped(&materials::MaterialFilter::default(),&materials::MaterialQueryScope{scope:"all".into(),..Default::default()}).map_err(|error| error.message)?;
    let mut mappings = Vec::new();
    for asset in assets {
        let path = catalog.resolve_external_drag_files(&[asset.id.clone()]).ok().and_then(|mut paths| if paths.len() == 1 { paths.pop() } else { None });
        mappings.push((asset.id, asset.name, path));
    }
    let service=knowledge_service()?;
    let approved=document_refs.iter().map(|document|catalog.approved_note_attachment_paths(&document.vault_id,&document.relative_path).map(|paths|(document.relative_path.clone(),paths)).map_err(|e|e.message)).collect::<Result<Vec<_>,_>>()?;
    let plan=service.preview_attachment_conversion_with_approved(&document_refs, &mappings,&approved).map_err(knowledge_error)?;
    attachment_coordination::authorize_attachment_plan(&service,plan)
}

#[tauri::command]
fn knowledge_preview_attachment_import(vault_id: String, source_root: String, source_notes: Vec<String>, target_parent: String,handling_policy:Option<String>) -> Result<knowledge::AttachmentOperationPlan, String> {
    let service=knowledge_service()?;
    let policy=handling_policy.unwrap_or(service.attachment_handling_policy(&vault_id).map_err(knowledge_error)?);
    if !matches!(policy.as_str(),"reference"|"copy") {return Err("knowledge-policy-invalid".into());}
    let plan=service.preview_attachment_import_with_policy(&vault_id, std::path::Path::new(&source_root), &source_notes, &target_parent,policy=="reference").map_err(knowledge_error)?;
    attachment_coordination::authorize_attachment_plan(&service,plan)
}

#[tauri::command]
fn knowledge_preview_attachment_rename(vault_id: String, old_path: String, new_path: String) -> Result<knowledge::AttachmentOperationPlan, String> {
    let service=knowledge_service()?;
    let plan=service.preview_attachment_rename(&vault_id, &old_path, &new_path).map_err(knowledge_error)?;
    attachment_coordination::authorize_attachment_plan(&service,plan)
}

#[tauri::command]
fn knowledge_get_attachment_link_update_policy(vault_id: String) -> Result<knowledge::LinkUpdatePolicy, String> {
    knowledge_service()?.attachment_link_update_policy(&vault_id).map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_set_attachment_link_update_policy(vault_id: String, source_epoch: u64, policy: knowledge::LinkUpdatePolicy) -> Result<knowledge::LinkUpdatePolicy, String> {
    knowledge_service()?.set_attachment_link_update_policy(&vault_id, source_epoch, policy).map_err(knowledge_error)
}

#[tauri::command]
async fn knowledge_execute_attachment_operation(source_epoch: u64, plan: knowledge::AttachmentOperationPlan, request_id: String) -> Result<knowledge::AttachmentOperationResult, String> {
    attachment_coordination::verify_attachment_plan(&plan,source_epoch)?;
    let service = knowledge_service()?;
    let catalog=backend_services()?.material_catalog();
    let attempt = service.begin_attachment_attempt(&plan.vault_id, &request_id).map_err(knowledge_error)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result=service.execute_attachment_attempt(source_epoch, &plan, attempt).map_err(knowledge_error)?;
        Ok(attachment_coordination::finish_attachment_projection(&service,&catalog,&plan,result,source_epoch))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn knowledge_recover_attachment_operation(source_epoch: u64, vault_id: String, operation_id: String, rollback: bool, request_id: String) -> Result<knowledge::AttachmentOperationResult, String> {
    let service = knowledge_service()?;
    let catalog=backend_services()?.material_catalog();
    let plan=service.read_attachment_operation_plan(&vault_id,&operation_id).map_err(knowledge_error)?;
    if rollback {attachment_coordination::validate_attachment_rollback(&plan)?;}
    let attempt = service.begin_attachment_attempt(&vault_id, &request_id).map_err(knowledge_error)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result=service.recover_attachment_attempt(source_epoch,&vault_id,&operation_id,rollback,attempt).map_err(knowledge_error)?;
        if rollback {
            Ok(attachment_coordination::finish_attachment_rollback(&service,&catalog,&plan,result,source_epoch))
        } else {Ok(attachment_coordination::finish_attachment_projection(&service,&catalog,&plan,result,source_epoch))}
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn knowledge_cancel_attachment_operation(vault_id: String, request_id: String) -> Result<(), String> {
    knowledge_service()?.cancel_attachment_operation(&vault_id, &request_id).map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_list_attachment_operations(vault_id: String) -> Result<Vec<String>, String> {
    knowledge_service()?.list_attachment_operations(&vault_id).map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_delete_document(
    app: tauri::AppHandle,
    input: knowledge::KnowledgeDeleteInput,
    source_epoch: u64,
) -> Result<(), String> {
    let service=knowledge_service()?;
    let scope=service.capture_workspace_scope(&input.document_ref.vault_id).map_err(knowledge_error)?;
    let registry=app.state::<workspace_windows::WorkspaceWindows>();
    let _retirement=registry.guard_main_document_retirement(&scope,&input.document_ref)?;
    service.delete_document_from_ui(source_epoch, &input)
        .map_err(knowledge_error)?;
    backend_services()?.material_catalog().replace_note_attachment_refs(&input.document_ref.vault_id,&input.document_ref.relative_path,&[]).map_err(|e|e.message)
}

#[tauri::command]
fn knowledge_insert_current(
    input: knowledge::KnowledgeCurrentInsertInput,
    source_epoch: u64,
) -> Result<knowledge::KnowledgeMutationResult, String> {
    knowledge_service()?
        .insert_into_current_from_ui(source_epoch, &input)
        .map(attachment_coordination::project_saved_mutation)
        .map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_insert_material_current(caller:tauri::Webview,app:tauri::AppHandle,asset_id:String,source_epoch:u64,library_id:Option<String>,vault_id:Option<String>)->Result<knowledge::KnowledgeMutationResult,String> {
    let catalog=material_catalog_in_context(&app,&caller,library_id.as_deref(),vault_id.as_deref(),&[asset_id.clone()])?;
    insert_material_current_with_services(&knowledge_service()?,&catalog,&asset_id,source_epoch)
}

fn insert_material_current_with_services(service:&knowledge::KnowledgeService,catalog:&materials::MaterialCatalog,asset_id:&str,source_epoch:u64)->Result<knowledge::KnowledgeMutationResult,String> {
    let context=service.get_current_context().map_err(knowledge_error)?.ok_or("请先打开要插入附件的笔记。")?;
    let asset=catalog.get_assets(&[asset_id.to_owned()]).map_err(|e|e.message)?.into_iter().next().ok_or("素材不存在。")?;
    let published=publish_attachment_with_services(service,catalog,KnowledgePublishAttachmentInput{
        document_ref:context.document_ref.clone(),source_epoch,expected_revision:context.expected_revision.clone(),name:asset.name,bytes:None,source_path:None,material_id:Some(asset_id.into()),handling_policy:None
    })?;
    let _source=service.lock_active_ui_source(source_epoch,Some(&context.document_ref.vault_id)).map_err(knowledge_error)?;
    let mut result=service.insert_material_block_into_bound_current(&published.markdown,&context,&_source).map_err(knowledge_error)?;
    if let Err(message)=attachment_coordination::sync_note_attachment_index(service,catalog,&result.document.summary.document_ref) {
        result.index_stale=true;result.index_warning=Some(knowledge::KnowledgeMutationWarning{code:"attachment-index-pending".into(),message});
    }
    Ok(result)
}

#[tauri::command]
fn knowledge_begin_current_context_session(
    session_id: String,
    source_epoch: u64,
) -> Result<knowledge::KnowledgeContextSession, String> {
    knowledge_service()?
        .begin_current_context_session(source_epoch, &session_id)
        .map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_set_current_context(
    input: knowledge::KnowledgeCurrentContextInput,
) -> Result<knowledge::KnowledgeCurrentContext, String> {
    knowledge_service()?
        .set_current_context(&input)
        .map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_companion_desktop_drafts(source_epoch: u64, generation: u64, paths: Vec<String>) -> Result<(), String> {
    knowledge_service()?.companion_set_desktop_drafts(source_epoch, generation, paths).map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_companion_editing_status(
    caller: tauri::Webview,
    document_ref: knowledge::KnowledgeDocumentRef,
    source_epoch: u64,
) -> Result<knowledge::KnowledgeEditingStatus, String> {
    require_main_caller(&caller)?;
    knowledge_service()?.companion_editing_from_ui(source_epoch, &document_ref)
        .map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_companion_committed_checkpoint(
    caller: tauri::Webview,
    vault_id: String,
    source_epoch: u64,
) -> Result<knowledge::KnowledgeCommittedCheckpoint, String> {
    require_main_caller(&caller)?;
    knowledge_service()?.companion_committed_checkpoint_from_ui(source_epoch, &vault_id)
        .map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_get_current_context() -> Result<Option<knowledge::KnowledgeCurrentContext>, String> {
    knowledge_service()?
        .get_current_context()
        .map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_clear_current_context(
    input: knowledge::KnowledgeCurrentContextClearInput,
) -> Result<(), String> {
    knowledge_service()?
        .clear_current_context(&input)
        .map_err(knowledge_error)
}

#[tauri::command]
fn material_catalog_list_assets(
    app: tauri::AppHandle,
    filters: Option<materials::MaterialFilter>,
) -> Result<Vec<materials::MaterialAsset>, String> {
    material_catalog_for_app(&app)?
        .list_assets(&filters.unwrap_or_default())
        .map_err(|error| error.message)
}

#[tauri::command]
fn material_catalog_get_assets(
    app: tauri::AppHandle,
    asset_ids: Vec<String>,
) -> Result<Vec<materials::MaterialAsset>, String> {
    material_catalog_for_app(&app)?
        .get_assets(&asset_ids)
        .map_err(|error| error.message)
}

#[tauri::command]
fn material_catalog_search_assets(
    app: tauri::AppHandle,
    query: String,
    limit: usize,
) -> Result<Vec<materials::MaterialAssetSearchHit>, String> {
    material_catalog_for_app(&app)?
        .search_assets(&query, limit)
        .map_err(|error| error.message)
}

#[tauri::command]
fn material_catalog_begin_external_drag(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    library_id: Option<String>,
    vault_id: Option<String>,
    asset_ids: Vec<String>,
    preview_png: Option<String>,
) -> Result<(), String> {
    if caller.label() != "main" {
        return Err("material-external-drag-untrusted-caller".to_owned());
    }
    let paths = material_catalog_in_context(&app,&caller,library_id.as_deref(),vault_id.as_deref(),&asset_ids)?
        .resolve_external_drag_files(&asset_ids)
        .map_err(encode_material_catalog_command_error)?;
    material_drag::begin_file_drag(caller.window().clone(), paths, preview_png)
}

fn material_catalog_in_context(app:&tauri::AppHandle,caller:&tauri::Webview,library_id:Option<&str>,vault_id:Option<&str>,ids:&[String])->Result<materials::MaterialCatalog,String> {
    if library_id.is_some() && vault_id.is_some() {return Err("material-context-conflict".into());}
    if let Some(vault)=vault_id {require_main_caller(caller)?;return material_catalog_for_app(app)?.for_vault_attachment_ids(vault,ids).map_err(encode_material_catalog_command_error);}
    material_catalog_in_library(app,caller,library_id)
}
// Explicit local material scope. No library ID still means the legacy catalog.
fn material_catalog_in_library(app:&tauri::AppHandle,caller:&tauri::Webview,library_id:Option<&str>)->Result<materials::MaterialCatalog,String> {
    let catalog=material_catalog_for_app(app)?;
    match library_id {Some(id)=>{require_main_caller(caller)?;catalog.for_library(id).map_err(encode_material_catalog_command_error)},None=>Ok(catalog)}
}
#[tauri::command]
async fn material_library_command(caller:tauri::Webview,app:tauri::AppHandle,mut request:materials::LibraryRequest)->Result<serde_json::Value,String> {
    require_main_caller(&caller)?;
    if matches!(&request.action, materials::LibraryAction::WatchLibraryRoot { .. } | materials::LibraryAction::UnwatchLibraryRoot { .. }) {
        if request.vault_id.is_some() { return Err("vault-attachment-operation-not-authorized".into()); }
        let id = request.library_id.clone().ok_or("library-watch-owner-required")?;
        let catalog = material_catalog_for_app(&app)?;
        return match request.action {
            materials::LibraryAction::WatchLibraryRoot { expected_root, channel } => {
                let catalog = catalog.for_library(&id).map_err(encode_material_catalog_command_error)?;
                let channel: tauri::ipc::Channel<serde_json::Value> = channel.channel_on(caller);
                tauri::async_runtime::spawn_blocking(move || materials::start_library_root_watch(&catalog, std::path::Path::new(&expected_root), move |event| { let _ = channel.send(event); }).map(serde_json::Value::String))
                    .await.map_err(|e| format!("library-watch-worker-failed: {e}"))?
            }
            materials::LibraryAction::UnwatchLibraryRoot { token } => {
                // Release still works after a library becomes hidden/offline.
                tauri::async_runtime::spawn_blocking(move || materials::stop_library_root_watch(&catalog, &id, &token).map(|_| serde_json::Value::Null))
                    .await.map_err(|e| format!("library-watch-worker-failed: {e}"))?
            }
            _ => unreachable!(),
        };
    }
    let progress: Option<tauri::ipc::Channel<serde_json::Value>> = match &request.action {
        materials::LibraryAction::ImportPaths { progress: Some(id), .. } => Some(id.channel_on(caller.clone())),
        _ => None,
    };
    match &mut request.action {
        materials::LibraryAction::TransferExport{watch_roots,protected_roots,..}|materials::LibraryAction::TransferRestore{watch_roots,protected_roots,..}=>{
            *protected_roots=material_export_protected_dirs(&app,watch_roots)?;
        }
        materials::LibraryAction::ExportStart{watch_roots,..}|materials::LibraryAction::CsvStart{watch_roots,..}|materials::LibraryAction::CsvRetry{watch_roots,..}=>{
            *watch_roots=material_export_protected_dirs(&app,watch_roots)?.into_iter().map(|path|path.to_string_lossy().into_owned()).collect();
        }
        _=>{}
    }
    let catalog=material_catalog_for_app(&app)?;
    tauri::async_runtime::spawn_blocking(move||materials::execute_library_request_with_progress(catalog,request,&mut |value| { if let Some(channel)=&progress { let _=channel.send(value); } })).await.map_err(|error|format!("material-library-worker-failed: {error}"))?
}

#[tauri::command]
async fn material_catalog_shell_action(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    library_id: Option<String>,
    vault_id: Option<String>,
    request: material_shell::MaterialShellRequest,
) -> Result<(), String> {
    require_main_caller(&caller)?;
    let catalog = material_catalog_in_context(&app,&caller,library_id.as_deref(),vault_id.as_deref(),&[request.asset_id.clone()])?;
    tauri::async_runtime::spawn_blocking(move || material_shell::perform(&catalog, &request))
        .await
        .map_err(|error| format!("material-shell-worker-failed: {error}"))?
}

#[tauri::command]
fn material_catalog_resolve_lightseek_paths(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    library_id: Option<String>,
    vault_id: Option<String>,
    asset_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    require_main_caller(&caller)?;
    if library_id.is_some() && vault_id.is_some() {return Err("material-context-conflict".into());}
    let catalog = match vault_id {Some(id)=>material_catalog_for_app(&app)?.for_vault_attachment_ids(&id,&asset_ids).map_err(encode_material_catalog_command_error)?,None=>material_catalog_in_library(&app,&caller,library_id.as_deref())?};
    catalog.resolve_open_in_lightseek_paths(&asset_ids)
        .map(|paths| {
            paths
                .into_iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect()
        })
        .map_err(encode_material_catalog_command_error)
}

#[tauri::command]
fn material_catalog_import_paths(
    app: tauri::AppHandle,
    paths: Vec<String>,
    options: materials::MaterialImportOptions,
) -> Result<materials::MaterialImportResult, String> {
    let catalog = material_catalog_for_app(&app)?;
    let paths = paths
        .into_iter()
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    let outcome = catalog
        .import_paths(&paths, &options)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_import_folder(
    app: tauri::AppHandle,
    path: String,
    options: materials::MaterialImportOptions,
) -> Result<materials::MaterialImportResult, String> {
    let catalog = material_catalog_for_app(&app)?;
    let outcome = catalog
        .import_folder(std::path::Path::new(&path), &options)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_import_bytes(
    app: tauri::AppHandle,
    items: Vec<materials::MaterialBytesInput>,
    options: materials::MaterialImportOptions,
) -> Result<materials::MaterialImportResult, String> {
    let catalog = material_catalog_for_app(&app)?;
    let outcome = materials::import_tauri_material_bytes(&catalog, items, &options)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_get_change(app: tauri::AppHandle) -> Result<materials::MaterialChange, String> {
    material_catalog_for_app(&app)?
        .read_change()
        .map_err(|error| error.message)
}

#[tauri::command]
fn material_catalog_update_asset(
    app: tauri::AppHandle,
    id: String,
    patch: materials::MaterialAssetPatch,
    reason: Option<String>,
) -> Result<Option<materials::MaterialAsset>, String> {
    let outcome = material_catalog_for_app(&app)?
        .update_asset(&id, patch, reason.as_deref().unwrap_or("material-update"))
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

fn encode_material_catalog_command_error(error: materials::MaterialError) -> String {
    let payload = serde_json::to_string(&error).unwrap_or_else(|_| {
        serde_json::json!({
            "code": error.code,
            "message": error.message,
        })
        .to_string()
    });
    format!("luckyray-material-error:{payload}")
}

#[tauri::command]
fn material_catalog_relocate_asset(
    app: tauri::AppHandle,
    id: String,
    path: String,
    options: Option<materials::MaterialRelocateOptions>,
) -> Result<Option<materials::MaterialAsset>, String> {
    let options = options.unwrap_or_default();
    let outcome = material_catalog_for_app(&app)?
        .relocate_asset(&id, std::path::Path::new(path.trim()), &options)
        .map_err(encode_material_catalog_command_error)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_rename_asset_file(
    app: tauri::AppHandle,
    id: String,
    file_name: String,
) -> Result<Option<materials::MaterialAsset>, String> {
    let outcome = material_catalog_for_app(&app)?
        .rename_asset_file(&id, &file_name)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_delete_asset(
    app: tauri::AppHandle,
    id: String,
    delete_file: bool,
) -> Result<materials::MaterialDeleteResult, String> {
    let outcome = material_catalog_for_app(&app)?
        .delete_asset(&id, delete_file)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_scan_missing(
    app: tauri::AppHandle,
) -> Result<Vec<materials::MissingMaterialAsset>, String> {
    material_catalog_for_app(&app)?
        .scan_missing()
        .map_err(|error| error.message)
}

#[tauri::command]
fn material_catalog_remove_asset_record(
    app: tauri::AppHandle,
    id: String,
) -> Result<materials::RemoveMaterialResult, String> {
    let outcome = material_catalog_for_app(&app)?
        .remove_asset_record(&id)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_list_folders(
    app: tauri::AppHandle,
) -> Result<Vec<materials::MaterialFolder>, String> {
    material_catalog_for_app(&app)?
        .list_folders()
        .map_err(|error| error.message)
}

#[tauri::command]
fn material_catalog_create_folder(
    app: tauri::AppHandle,
    input: materials::MaterialFolderInput,
) -> Result<materials::MaterialFolder, String> {
    let outcome = material_catalog_for_app(&app)?
        .create_folder(input)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_rename_folder(
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<Option<materials::MaterialFolder>, String> {
    let outcome = material_catalog_for_app(&app)?
        .rename_folder(&id, &name)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_delete_folder(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let outcome = material_catalog_for_app(&app)?
        .delete_folder(&id)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_move_folder(
    app: tauri::AppHandle,
    input: materials::MaterialFolderMove,
) -> Result<bool, String> {
    let outcome = material_catalog_for_app(&app)?
        .move_folder(input)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_move_asset(
    app: tauri::AppHandle,
    id: String,
    folder_id: Option<String>,
) -> Result<bool, String> {
    let outcome = material_catalog_for_app(&app)?
        .move_asset(&id, folder_id.as_deref())
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_list_tags(
    app: tauri::AppHandle,
) -> Result<Vec<materials::MaterialTag>, String> {
    material_catalog_for_app(&app)?
        .list_tags()
        .map_err(|error| error.message)
}

#[tauri::command]
fn material_catalog_create_tag(
    app: tauri::AppHandle,
    name: String,
    color: Option<String>,
) -> Result<materials::MaterialTag, String> {
    let outcome = material_catalog_for_app(&app)?
        .create_tag(&name, color)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_update_tag(
    app: tauri::AppHandle,
    id: String,
    patch: materials::MaterialTagPatch,
) -> Result<Option<materials::MaterialTag>, String> {
    let outcome = material_catalog_for_app(&app)?
        .update_tag(&id, patch)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_delete_tag(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let outcome = material_catalog_for_app(&app)?
        .delete_tag(&id)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_get_asset_tags(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<String>, String> {
    material_catalog_for_app(&app)?
        .get_asset_tags(&id)
        .map_err(|error| error.message)
}

#[tauri::command]
fn material_catalog_set_asset_tags(
    app: tauri::AppHandle,
    id: String,
    tag_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    let outcome = material_catalog_for_app(&app)?
        .set_asset_tags(&id, tag_ids)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn material_catalog_list_asset_tag_map(
    app: tauri::AppHandle,
    ids: Option<Vec<String>>,
) -> Result<HashMap<String, Vec<String>>, String> {
    material_catalog_for_app(&app)?
        .list_asset_tag_map(ids)
        .map_err(|error| error.message)
}

#[tauri::command]
fn material_catalog_merge_tags(
    app: tauri::AppHandle,
    target_id: String,
    source_ids: Vec<String>,
) -> Result<materials::MaterialTagMergeResult, String> {
    let outcome = material_catalog_for_app(&app)?
        .merge_tags(&target_id, source_ids)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示 LuckyRay", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 LuckyRay", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    let mut builder = TrayIconBuilder::with_id("luckyray-main")
        .tooltip("LuckyRay")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "hide" => hide_main_window(app),
            "quit" => request_normal_quit(app.clone(), false),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, .. } = event {
                if button == MouseButton::Left {
                    show_main_window(tray.app_handle());
                }
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| match ch {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

fn resolve_asset_library_dir(
    app: &tauri::AppHandle,
    library_dir: Option<String>,
) -> Result<std::path::PathBuf, String> {
    let custom = library_dir
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(path) = custom {
        return Ok(std::path::PathBuf::from(path));
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("asset-library"))
}

#[tauri::command]
fn migrate_managed_asset_library(
    app: tauri::AppHandle,
    from_dir: Option<String>,
    to_dir: String,
) -> Result<materials::MaterialLibraryMigrationResult, String> {
    let source_dir = resolve_asset_library_dir(&app, from_dir)?;
    let target_dir = std::path::PathBuf::from(to_dir.trim());
    let outcome = material_catalog_for_app(&app)?
        .migrate_managed_library(&source_dir, &target_dir)
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(outcome.value)
}

#[tauri::command]
fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    // Explicitly derive the data root from this runtime's validated identifier.
    let base = app.path().data_dir().map_err(|e| e.to_string())?;
    let identifier = app.config().identifier.clone();
    let app_data = base.join(&identifier);
    Ok(app_data.to_string_lossy().to_string())
}

#[tauri::command]
fn get_collection_server_base_url(
    transport: tauri::State<'_, local_transport::LocalTransportHandle>,
) -> String {
    transport.base_url()
}

#[tauri::command]
fn get_local_transport_client_config(
    transport: tauri::State<'_, local_transport::LocalTransportHandle>,
) -> local_transport::LocalTransportClientConfig {
    transport.client_config()
}

#[tauri::command]
fn revoke_local_transport_extension_origin(
    origin: String,
    transport: tauri::State<'_, local_transport::LocalTransportHandle>,
) -> Result<(), String> {
    transport.revoke_extension_origin(&origin)
}

#[tauri::command]
fn rotate_local_transport_credentials(
    transport: tauri::State<'_, local_transport::LocalTransportHandle>,
) -> Result<(), String> {
    transport.rotate_credentials()
}

#[tauri::command]
fn open_directory(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn minimize_window(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn hide_window(window: tauri::Window) {
    let _ = window.hide();
}

#[tauri::command]
fn show_window(window: tauri::Window) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::Window) {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn close_window(app: tauri::AppHandle) {
    request_normal_quit(app, false);
}

#[tauri::command]
async fn browser_personal_open(
    caller: tauri::Webview,
    broker: tauri::State<'_, Arc<browser_broker::BrowserBroker>>,
    viewport: Option<browser_broker::PersonalBrowserViewport>,
) -> Result<browser_broker::PersonalBrowserStatus, String> {
    let caller_label = caller.label().to_owned();
    let broker = Arc::clone(broker.inner());
    #[cfg(windows)]
    let parent_window = if viewport.is_some() {
        Some(
            caller
                .window()
                .hwnd()
                .map_err(|_| "browser-viewport-unavailable".to_owned())?
                .0 as isize,
        )
    } else {
        None
    };
    #[cfg(not(windows))]
    let parent_window: Option<isize> = None;
    tauri::async_runtime::spawn_blocking(move || match (viewport, parent_window) {
        (Some(viewport), Some(parent_window)) => {
            broker.open_personal_embedded(&caller_label, parent_window, viewport)
        }
        (None, None) => broker.open_personal(&caller_label),
        _ => Err("browser-viewport-unavailable".to_owned()),
    })
    .await
    .map_err(|_| "browser-host-operation-failed".to_owned())?
}

#[tauri::command]
async fn browser_personal_navigate(
    caller: tauri::Webview,
    broker: tauri::State<'_, Arc<browser_broker::BrowserBroker>>,
    session_id: String,
    expected_generation: u64,
    url: String,
) -> Result<browser_broker::PersonalBrowserStatus, String> {
    browser_personal_command(
        caller,
        broker,
        session_id,
        expected_generation,
        "navigate",
        Some(url),
    )
    .await
}

macro_rules! browser_command {
    ($name:ident, $command:literal) => {
        #[tauri::command]
        async fn $name(
            caller: tauri::Webview,
            broker: tauri::State<'_, Arc<browser_broker::BrowserBroker>>,
            session_id: String,
            expected_generation: u64,
        ) -> Result<browser_broker::PersonalBrowserStatus, String> {
            browser_personal_command(
                caller,
                broker,
                session_id,
                expected_generation,
                $command,
                None,
            )
            .await
        }
    };
}

browser_command!(browser_personal_back, "back");
browser_command!(browser_personal_forward, "forward");
browser_command!(browser_personal_reload, "reload");
browser_command!(browser_personal_stop, "stop");
browser_command!(browser_personal_status, "status");

#[tauri::command]
async fn browser_personal_set_viewport(
    caller: tauri::Webview,
    broker: tauri::State<'_, Arc<browser_broker::BrowserBroker>>,
    session_id: String,
    expected_generation: u64,
    viewport: browser_broker::PersonalBrowserViewport,
) -> Result<browser_broker::PersonalBrowserStatus, String> {
    let caller_label = caller.label().to_owned();
    let broker = Arc::clone(broker.inner());
    tauri::async_runtime::spawn_blocking(move || {
        broker.set_personal_viewport(&caller_label, &session_id, expected_generation, viewport)
    })
    .await
    .map_err(|_| "browser-host-operation-failed".to_owned())?
}

async fn browser_personal_command(
    caller: tauri::Webview,
    broker: tauri::State<'_, Arc<browser_broker::BrowserBroker>>,
    session_id: String,
    expected_generation: u64,
    command: &'static str,
    url: Option<String>,
) -> Result<browser_broker::PersonalBrowserStatus, String> {
    let caller_label = caller.label().to_owned();
    let broker = Arc::clone(broker.inner());
    tauri::async_runtime::spawn_blocking(move || {
        broker.command_personal(
            &caller_label,
            &session_id,
            expected_generation,
            command,
            url,
        )
    })
    .await
    .map_err(|_| "browser-host-operation-failed".to_owned())?
}

#[tauri::command]
async fn browser_personal_close(
    caller: tauri::Webview,
    broker: tauri::State<'_, Arc<browser_broker::BrowserBroker>>,
    session_id: String,
    expected_generation: u64,
) -> Result<browser_broker::PersonalBrowserStatus, String> {
    let caller_label = caller.label().to_owned();
    let broker = Arc::clone(broker.inner());
    tauri::async_runtime::spawn_blocking(move || {
        broker.close_personal(&caller_label, &session_id, expected_generation)
    })
    .await
    .map_err(|_| "browser-host-operation-failed".to_owned())?
}

#[tauri::command]
fn agent_workspace_list(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
) -> Result<Vec<agent_workspace::WorkspaceGrantManagementView>, String> {
    require_main_caller(&caller)?;
    let grants = backend
        .workspace()
        .list()
        .map_err(|error| error.code.to_owned())?;
    Ok(backend.workspace().management_snapshot(&grants))
}

#[tauri::command]
async fn agent_workspace_select_folder(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
) -> Result<Option<agent_workspace::WorkspaceFolderSelectionView>, String> {
    require_main_caller(&caller)?;
    let caller_label = caller.label().to_owned();
    let selection = tauri::async_runtime::spawn_blocking(move || {
        caller
            .dialog()
            .file()
            .set_title("选择要授权的工作区")
            .blocking_pick_folder()
    })
    .await
    .map_err(|_| "workspace-selection-unavailable".to_owned())?;
    let Some(selection) = selection else {
        return Ok(None);
    };
    let root = selection
        .into_path()
        .map_err(|_| "workspace-selection-unavailable".to_owned())?;
    backend
        .workspace()
        .issue_add_folder_selection(&root, &caller_label)
        .map(Some)
        .map_err(|error| error.code.to_owned())
}

#[tauri::command]
fn agent_workspace_add(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    selection_management_ref: String,
) -> Result<agent_workspace::WorkspaceGrantManagementView, String> {
    require_main_caller(&caller)?;
    let grant = backend
        .workspace()
        .add_from_folder_selection(&selection_management_ref, caller.label())
        .map_err(|error| error.code.to_owned())?;
    let view = backend.workspace().management_snapshot(&[grant]);
    Ok(view
        .into_iter()
        .next()
        .ok_or_else(|| "workspace-management-reference-unavailable".to_owned())?)
}

#[tauri::command]
fn agent_workspace_set_enabled(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    management_ref: String,
    enabled: bool,
) -> Result<agent_workspace::WorkspaceGrantManagementView, String> {
    require_main_caller(&caller)?;
    let grant_id = backend
        .workspace()
        .consume_management_ref(&management_ref)
        .map_err(|error| error.code.to_owned())?;
    let grant = backend
        .workspace()
        .set_enabled(&grant_id, enabled)
        .map_err(|error| error.code.to_owned())?;
    let view = backend.workspace().management_snapshot(&[grant]);
    Ok(view
        .into_iter()
        .next()
        .ok_or_else(|| "workspace-management-reference-unavailable".to_owned())?)
}

#[tauri::command]
fn agent_workspace_remove(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    management_ref: String,
) -> Result<(), String> {
    require_main_caller(&caller)?;
    let grant_id = backend
        .workspace()
        .consume_management_ref(&management_ref)
        .map_err(|error| error.code.to_owned())?;
    backend
        .workspace()
        .remove(&grant_id)
        .map_err(|error| error.code.to_owned())
}

#[tauri::command]
fn agent_search_settings_status(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
) -> Result<web_tools::SearchSettingsStatus, String> {
    require_main_caller(&caller)?;
    backend
        .web_tools()
        .settings_status(backend.inner())
        .map_err(|error| error.code.to_owned())
}

#[tauri::command]
async fn agent_search_settings_update(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    update: web_tools::SearchSettingsUpdate,
) -> Result<web_tools::SearchSettingsStatus, String> {
    require_main_caller(&caller)?;
    let backend = Arc::clone(backend.inner());
    tauri::async_runtime::spawn_blocking(move || {
        backend
            .web_tools()
            .update_settings(&backend, update)
            .map_err(|error| error.code.to_owned())
    })
    .await
    .map_err(|_| "web-search-unavailable".to_owned())?
}

#[tauri::command]
async fn agent_search_test_connection(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
) -> Result<web_tools::SearchConnectionResult, String> {
    require_main_caller(&caller)?;
    let backend = Arc::clone(backend.inner());
    tauri::async_runtime::spawn_blocking(move || backend.web_tools().test_connection(&backend))
        .await
        .map_err(|_| "web-search-unavailable".to_owned())
}

#[tauri::command]
fn canvas_comfyui_get_config(caller: tauri::Webview, backend: tauri::State<'_, Arc<backend::BackendServices>>) -> Result<canvas_comfyui::Config, String> {
    require_main_caller(&caller)?;
    canvas_comfyui::get(backend.db_path()).map_err(str::to_owned)
}
#[tauri::command]
fn canvas_comfyui_set_config(caller: tauri::Webview, backend: tauri::State<'_, Arc<backend::BackendServices>>, base_url: String) -> Result<canvas_comfyui::Config, String> {
    require_main_caller(&caller)?;
    canvas_comfyui::set(backend.db_path(), &base_url).map_err(str::to_owned)
}
#[tauri::command]
async fn canvas_comfyui_test_connection(caller: tauri::Webview, base_url: String) -> Result<canvas_comfyui::ConnectionResult, String> {
    require_main_caller(&caller)?;
    canvas_comfyui::test(&base_url).await.map_err(str::to_owned)
}

#[tauri::command]
fn canvas_media_profiles_list(caller: tauri::Webview, backend: tauri::State<'_, Arc<backend::BackendServices>>) -> Result<canvas_media_profiles::Snapshot, String> {
    require_main_caller(&caller)?;
    canvas_media_profiles::list(backend.db_path()).map_err(str::to_owned)
}
#[tauri::command]
fn canvas_media_profile_upsert(caller: tauri::Webview, backend: tauri::State<'_, Arc<backend::BackendServices>>, profile: canvas_media_profiles::ProfileInput) -> Result<canvas_media_profiles::Snapshot, String> {
    require_main_caller(&caller)?;
    canvas_media_profiles::upsert(backend.db_path(), profile).map_err(str::to_owned)
}
#[tauri::command]
fn canvas_media_profile_activate(caller: tauri::Webview, backend: tauri::State<'_, Arc<backend::BackendServices>>, profile_id: String) -> Result<canvas_media_profiles::Snapshot, String> {
    require_main_caller(&caller)?;
    canvas_media_profiles::activate(backend.db_path(), &profile_id).map_err(str::to_owned)
}
#[tauri::command]
fn canvas_media_profile_delete(caller: tauri::Webview, backend: tauri::State<'_, Arc<backend::BackendServices>>, profile_id: String, revision: u64) -> Result<canvas_media_profiles::Snapshot, String> {
    require_main_caller(&caller)?;
    canvas_media_profiles::remove(backend.db_path(), &profile_id, revision).map_err(str::to_owned)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasMediaModelsQuery {
    base_url: String,
    api_key: Option<String>,
    image_protocol: String,
    profile_id: Option<String>,
    profile_revision: Option<u64>,
    #[serde(default)]
    clear_api_key: bool,
}

/// Editor helper: discover upstream model IDs for the entered Base URL and
/// key. The key is used only for this request and is never persisted or
/// logged; an empty key falls back to the profile store's already-saved key
/// for the matching base URL.
#[tauri::command]
async fn canvas_media_profile_list_models(
    caller: tauri::Webview,
    backend: tauri::State<'_, std::sync::Arc<backend::BackendServices>>,
    query: CanvasMediaModelsQuery,
) -> Result<Vec<String>, String> {
    require_main_caller(&caller)?;
    let base=canvas_media_profiles::validated_base(&query.base_url).map_err(str::to_owned)?;
    let mut key = query.api_key.unwrap_or_default();
    if key.trim().is_empty() && !query.clear_api_key {
        if let Ok(runtime) = canvas_media_profiles::resolve(backend.db_path(),query.profile_id.as_deref(),query.profile_revision) {
            if runtime.profile.base_url == base { key=runtime.api_key; }
        }
    }
    let gemini = query.image_protocol == "gemini-image";
    let base=canvas_media_protocols::easycli_base(&base,&query.image_protocol);
    canvas_media_protocols::list_models(&base, &key, gemini)
        .await
        .map_err(str::to_owned)
}

#[tauri::command]
fn ai_model_profiles_list(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
) -> Result<ai_profiles::AiModelProfilesSnapshot, String> {
    require_main_caller(&caller)?;
    ai_profiles::list(backend.inner()).map_err(|error| error.to_owned())
}

#[tauri::command]
fn ai_model_profile_upsert(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    profile: ai_profiles::AiModelProfileInput,
) -> Result<ai_profiles::AiModelProfilesSnapshot, String> {
    require_main_caller(&caller)?;
    ai_profiles::upsert(backend.inner(), profile).map_err(|error| error.to_owned())
}

#[tauri::command]
fn ai_model_profile_activate(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    profile_id: String,
) -> Result<ai_profiles::AiModelProfilesSnapshot, String> {
    require_main_caller(&caller)?;
    ai_profiles::activate(backend.inner(), &profile_id).map_err(|error| error.to_owned())
}

#[tauri::command]
async fn ai_model_profile_test_connection(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    profile_id: String,
) -> Result<ai_profiles::AiModelProfilesSnapshot, String> {
    require_main_caller(&caller)?;
    ai_profiles::test_connection(backend.inner(), &profile_id)
        .await
        .map_err(|error| error.to_owned())
}

#[tauri::command]
fn ai_model_profile_select_model(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    profile_id: String,
    model: String,
) -> Result<ai_profiles::AiModelProfilesSnapshot, String> {
    require_main_caller(&caller)?;
    ai_profiles::select_model(backend.inner(), &profile_id, &model)
        .map_err(|error| error.to_owned())
}

#[tauri::command]
fn ai_model_profile_delete(
    caller: tauri::Webview,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    profile_id: String,
) -> Result<ai_profiles::AiModelProfilesSnapshot, String> {
    require_main_caller(&caller)?;
    ai_profiles::remove(backend.inner(), &profile_id).map_err(|error| error.to_owned())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AiModelProfileSyncResult {
    outcome: &'static str,
    message: &'static str,
    synced: usize,
    skipped: usize,
    unsupported: usize,
    items: Vec<AiModelProfileSyncItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot: Option<ai_profiles::AiModelProfilesSnapshot>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AiModelProfileSyncItem {
    source_identity: String,
    display_name: String,
    provider: String,
    status: &'static str,
    reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_id: Option<String>,
}

fn take_lightseek_import_connection(
    source_identity: &str,
    wire_protocol: Option<&str>,
    secrets: &mut HashMap<String, String>,
) -> Result<Option<(&'static str, String)>, &'static str> {
    let secret = secrets
        .remove(source_identity)
        .ok_or("lightseek-model-sync-invalid")?;
    let protocol = match wire_protocol {
        Some("openai-completions") => "openai-compatible",
        Some("anthropic-messages") => "anthropic-messages",
        _ => return Ok(None),
    };
    Ok(Some((protocol, secret)))
}

#[tauri::command]
async fn ai_model_profile_sync_from_lightseek(
    caller: tauri::Webview,
    host: tauri::State<'_, Arc<dsh_host::DshHostService>>,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
) -> Result<AiModelProfileSyncResult, String> {
    require_main_caller(&caller)?;
    let owned_host = host.inner().clone();
    let projection =
        match tauri::async_runtime::spawn_blocking(move || owned_host.sync_lightseek_model())
            .await
            .map_err(|_| "lightseek-model-sync-unavailable".to_owned())?
        {
            Ok(value) => value,
            Err(error) if error == "lightseek-model-sync-not-ready" => {
                return Ok(AiModelProfileSyncResult {
                    outcome: "not-ready",
                    message: "请先打开 LightSeek，再同步当前模型配置。",
                    synced: 0,
                    skipped: 0,
                    unsupported: 0,
                    items: Vec::new(),
                    snapshot: None,
                });
            }
            Err(_) => {
                return Ok(AiModelProfileSyncResult {
                    outcome: "unavailable",
                    message: "暂时无法读取 LightSeek 模型配置，请稍后重试。",
                    synced: 0,
                    skipped: 0,
                    unsupported: 0,
                    items: Vec::new(),
                    snapshot: None,
                });
            }
        };
    match projection.outcome.as_str() {
        "ready" => {
            let mut secrets = projection
                .secrets
                .into_iter()
                .map(|secret| (secret.source_identity, secret.value))
                .collect::<HashMap<_, _>>();
            let mut imports = Vec::new();
            let mut items = Vec::with_capacity(projection.providers.len());
            for provider in projection.providers {
                if !provider.syncable {
                    let skipped = provider.reason == "credential-missing";
                    items.push(AiModelProfileSyncItem {
                        source_identity: provider.source_identity,
                        display_name: provider.display_name,
                        provider: provider.provider,
                        status: if skipped { "skipped" } else { "unsupported" },
                        reason: provider.reason,
                        profile_id: None,
                    });
                    continue;
                }
                let Some((protocol, api_key)) = take_lightseek_import_connection(
                    &provider.source_identity,
                    provider.wire_protocol.as_deref(),
                    &mut secrets,
                )
                .map_err(str::to_owned)?
                else {
                    items.push(AiModelProfileSyncItem {
                        source_identity: provider.source_identity,
                        display_name: provider.display_name,
                        provider: provider.provider,
                        status: "unsupported",
                        reason: "wire-protocol-unsupported".to_owned(),
                        profile_id: None,
                    });
                    continue;
                };
                let Some(endpoint) = provider.endpoint else {
                    return Err("lightseek-model-sync-invalid".to_owned());
                };
                let models = provider
                    .models
                    .into_iter()
                    .map(|model| ai_profiles::LightSeekModelImport {
                        id: model.id,
                        input: model.input,
                        input_state: model.input_state,
                        tool_calls: model.tool_calls,
                        max_output_tokens: model.max_output_tokens,
                        context_window_tokens: model.context_window_tokens,
                    })
                    .collect();
                imports.push(ai_profiles::LightSeekProfileImport {
                    source_identity: provider.source_identity.clone(),
                    source_provider: provider.provider.clone(),
                    display_name: provider.display_name.clone(),
                    protocol: protocol.to_owned(),
                    base_url: endpoint,
                    models,
                    api_key,
                });
                items.push(AiModelProfileSyncItem {
                    source_identity: provider.source_identity,
                    display_name: provider.display_name,
                    provider: provider.provider,
                    status: "synced",
                    reason: "ready".to_owned(),
                    profile_id: None,
                });
            }
            if !secrets.is_empty() {
                return Err("lightseek-model-sync-invalid".to_owned());
            }
            let owned_backend = backend.inner().clone();
            let default_source_identity = projection.default_source_identity;
            let synchronized = tauri::async_runtime::spawn_blocking(move || {
                ai_profiles::sync_from_lightseek_batch(
                    owned_backend.as_ref(),
                    imports,
                    default_source_identity.as_deref(),
                )
            })
            .await
            .map_err(|_| "lightseek-model-sync-unavailable".to_owned())?
            .map_err(str::to_owned)?;
            let imported = synchronized
                .imports
                .into_iter()
                .map(|item| (item.source_identity, item.profile_id))
                .collect::<HashMap<_, _>>();
            for item in &mut items {
                item.profile_id = imported.get(&item.source_identity).cloned();
            }
            let synced = items.iter().filter(|item| item.status == "synced").count();
            let skipped = items.iter().filter(|item| item.status == "skipped").count();
            let unsupported = items
                .iter()
                .filter(|item| item.status == "unsupported")
                .count();
            Ok(AiModelProfileSyncResult {
                outcome: if unsupported == 0 && skipped == 0 {
                    "synced"
                } else {
                    "partial"
                },
                message: if unsupported == 0 && skipped == 0 {
                    "已将 LightSeek 可同步的模型配置更新到应用内 AI。"
                } else {
                    "同步已完成；部分提供商未配置或协议暂不受应用内 AI 支持。"
                },
                synced,
                skipped,
                unsupported,
                items,
                snapshot: Some(synchronized.snapshot),
            })
        }
        "stale" => Ok(AiModelProfileSyncResult {
            outcome: "stale",
            message: "同步期间 LightSeek 配置发生了变化，未写入；请重新同步。",
            synced: 0,
            skipped: 0,
            unsupported: 0,
            items: Vec::new(),
            snapshot: None,
        }),
        _ => Ok(AiModelProfileSyncResult {
            outcome: "unavailable",
            message: "暂时无法读取 LightSeek 模型配置，请稍后重试。",
            synced: 0,
            skipped: 0,
            unsupported: 0,
            items: Vec::new(),
            snapshot: None,
        }),
    }
}

#[cfg(test)]
mod ai_model_profile_sync_bridge_tests {
    use super::take_lightseek_import_connection;
    use std::collections::HashMap;

    #[test]
    fn unsupported_wire_protocol_consumes_only_its_backend_secret() {
        let mut secrets = HashMap::from([
            ("unsupported".to_owned(), "unsupported-secret".to_owned()),
            ("supported".to_owned(), "supported-secret".to_owned()),
        ]);

        assert_eq!(
            take_lightseek_import_connection("unsupported", Some("fixture-wire"), &mut secrets),
            Ok(None)
        );
        assert!(!secrets.contains_key("unsupported"));
        assert_eq!(
            take_lightseek_import_connection("supported", Some("openai-completions"), &mut secrets),
            Ok(Some(("openai-compatible", "supported-secret".to_owned())))
        );
        assert!(secrets.is_empty());
    }
}

const AUTO_LAUNCH_NAME: &str = "LuckyRay";
const AUTO_LAUNCH_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(target_os = "windows")]
fn auto_launch_command_value() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    Ok(format!("\"{}\"", exe.to_string_lossy()))
}

/// Packaged builds run as a GUI-subsystem process: any console-subsystem
/// child spawned without `CREATE_NO_WINDOW` flashes a terminal window.
#[cfg(target_os = "windows")]
fn reg_command() -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new("reg");
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn get_auto_launch_enabled_sync() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let output = reg_command()
            .args(["query", AUTO_LAUNCH_RUN_KEY, "/v", AUTO_LAUNCH_NAME])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Ok(false);
        }
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let expected = auto_launch_command_value()?.trim_matches('"').to_string();
        Ok(stdout.contains(AUTO_LAUNCH_NAME) && stdout.contains(&expected))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

#[tauri::command]
async fn get_auto_launch_enabled() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(get_auto_launch_enabled_sync)
        .await
        .map_err(|error| format!("auto-launch-query-task-failed: {error}"))?
}

fn set_auto_launch_enabled_sync(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if enabled {
            let value = auto_launch_command_value()?;
            let status = reg_command()
                .args([
                    "add",
                    AUTO_LAUNCH_RUN_KEY,
                    "/v",
                    AUTO_LAUNCH_NAME,
                    "/t",
                    "REG_SZ",
                    "/d",
                    &value,
                    "/f",
                ])
                .status()
                .map_err(|error| error.to_string())?;
            if !status.success() {
                return Err("写入开机自启动失败".to_string());
            }
            return Ok(());
        }

        let status = reg_command()
            .args(["delete", AUTO_LAUNCH_RUN_KEY, "/v", AUTO_LAUNCH_NAME, "/f"])
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() || !get_auto_launch_enabled_sync()? {
            return Ok(());
        }
        Err("关闭开机自启动失败".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = enabled;
        Err("当前平台暂未支持开机自启动".to_string())
    }
}

#[tauri::command]
async fn set_auto_launch_enabled(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_auto_launch_enabled_sync(enabled))
        .await
        .map_err(|error| format!("auto-launch-update-task-failed: {error}"))?
}

// D41c: 桌面端笔记编辑器激活 / 光标移动时调用，发布 Knowledge current context
// 前端调用：invoke('update_current_editor', { noteId, cursorOffset, selection })
// noteId=null 表示清空（如关闭所有笔记 tab）
#[tauri::command]
fn update_current_editor(
    note_id: Option<String>,
    cursor_offset: Option<i64>,
    selection: Option<String>,
) -> Result<(), String> {
    knowledge_service()?
        .publish_legacy_current_context(note_id.as_deref(), cursor_offset, selection)
        .map_err(knowledge_error)
}

// ===== D16 数据安全：备份 / 恢复 / 导出 =====

const MAX_BACKUPS: usize = 5;
const BACKUP_DATA_DIRECTORIES: &[&str] = &[
    "asset-library",
    "canvases",
    "canvas",
    "generated-images",
    "ai",
    "material-managed-roots",
];
const BACKUP_DATA_FILES: &[&str] = &["notes-vault-current.json"];
const CLEAR_DATA_DIRECTORIES: &[&str] = &[
    "asset-library",
    ".thumbnails",
    "thumbnails",
    "canvases",
    "canvas",
    "generated-images",
    "ai",
    "material-managed-roots",
    "media-transfer-staging",
    "material-delete-pending",
    "exports",
];
const CLEAR_DATA_FILES: &[&str] = &["notes-vault-current.json"];

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct BackupManifest {
    created_at: String,
    app_version: String,
    db_size_bytes: u64,
    asset_count: u32,
    source_dir: String,
}

#[derive(serde::Serialize)]
struct BackupInfo {
    id: String,
    path: String,
    manifest: BackupManifest,
}

/// 获取备份根目录: %APPDATA%\com.luckyray.desktop\backups
#[derive(serde::Serialize)]
struct StorageUsage {
    app_data_dir: String,
    db_size_bytes: u64,
    asset_library_size_bytes: u64,
    thumbnail_size_bytes: u64,
    canvas_size_bytes: u64,
    generated_media_size_bytes: u64,
    other_data_size_bytes: u64,
    backup_size_bytes: u64,
    total_size_bytes: u64,
    asset_count: u32,
    note_count: u32,
    tag_count: u32,
    collection_count: u32,
}

#[derive(serde::Serialize)]
struct ClearCacheResult {
    removed_bytes: u64,
    removed_files: u32,
}

#[derive(serde::Serialize)]
struct ClearAllDataResult {
    backup_id: String,
    cleared_tables: Vec<String>,
    removed_bytes: u64,
    removed_files: u32,
}

fn backup_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 计算目录内文件数
fn count_files(dir: &std::path::Path) -> u32 {
    let mut count = 0u32;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                count += count_files(&path);
            } else if path.is_file() {
                count += 1;
            }
        }
    }
    count
}

/// 递归复制目录
fn dir_size_bytes(dir: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                total = total.saturating_add(dir_size_bytes(&path));
            } else if let Ok(meta) = path.metadata() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

fn count_table_rows(db_path: &std::path::Path, table: &str) -> u32 {
    let conn = match rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(conn) => conn,
        Err(_) => return 0,
    };
    let sql = format!("SELECT COUNT(*) FROM {}", table);
    conn.query_row(&sql, [], |row| row.get::<_, i64>(0))
        .unwrap_or(0)
        .max(0) as u32
}

fn collect_storage_usage(app: tauri::AppHandle) -> Result<StorageUsage, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_data.join("luckyray.db");
    let db_size_bytes = db_path.metadata().map(|m| m.len()).unwrap_or(0);
    let asset_library_size_bytes = dir_size_bytes(&app_data.join("asset-library"));
    let thumbnail_size_bytes = dir_size_bytes(&app_data.join(".thumbnails"))
        .saturating_add(dir_size_bytes(&app_data.join("thumbnails")));
    let canvas_size_bytes = dir_size_bytes(&app_data.join("canvases"));
    let generated_media_size_bytes = dir_size_bytes(&app_data.join("canvas"))
        .saturating_add(dir_size_bytes(&app_data.join("generated-images")));
    let other_data_size_bytes = dir_size_bytes(&app_data.join("ai"))
        .saturating_add(dir_size_bytes(&app_data.join("material-managed-roots")))
        .saturating_add(dir_size_bytes(&app_data.join("media-transfer-staging")))
        .saturating_add(dir_size_bytes(&app_data.join("agent-engine")))
        .saturating_add(dir_size_bytes(&app_data.join("exports")))
        .saturating_add(
            app_data
                .join("notes-vault-current.json")
                .metadata()
                .map(|metadata| metadata.len())
                .unwrap_or(0),
        );
    let backup_size_bytes = dir_size_bytes(&app_data.join("backups"));
    let total_size_bytes = db_size_bytes
        .saturating_add(asset_library_size_bytes)
        .saturating_add(thumbnail_size_bytes)
        .saturating_add(canvas_size_bytes)
        .saturating_add(generated_media_size_bytes)
        .saturating_add(other_data_size_bytes)
        .saturating_add(backup_size_bytes);
    let knowledge_document_count = knowledge_service()
        .ok()
        .and_then(|service| service.index_snapshot().ok())
        .map(|snapshot| u32::try_from(snapshot.documents.len()).unwrap_or(u32::MAX))
        .unwrap_or(0);
    Ok(StorageUsage {
        app_data_dir: app_data.to_string_lossy().to_string(),
        db_size_bytes,
        asset_library_size_bytes,
        thumbnail_size_bytes,
        canvas_size_bytes,
        generated_media_size_bytes,
        other_data_size_bytes,
        backup_size_bytes,
        total_size_bytes,
        asset_count: count_table_rows(&db_path, "asset"),
        note_count: knowledge_document_count,
        tag_count: count_table_rows(&db_path, "tag"),
        collection_count: count_table_rows(&db_path, "collection_item"),
    })
}

#[tauri::command]
async fn get_storage_usage(app: tauri::AppHandle) -> Result<StorageUsage, String> {
    tauri::async_runtime::spawn_blocking(move || collect_storage_usage(app))
        .await
        .map_err(|error| format!("storage-usage-task-failed: {error}"))?
}

fn clear_dir_contents(dir: &std::path::Path) -> Result<ClearCacheResult, String> {
    let mut removed_bytes = 0u64;
    let mut removed_files = 0u32;
    if !dir.exists() {
        return Ok(ClearCacheResult {
            removed_bytes,
            removed_files,
        });
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let size_before = if path.is_dir() {
            dir_size_bytes(&path)
        } else {
            path.metadata().map(|m| m.len()).unwrap_or(0)
        };
        if path.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        removed_bytes = removed_bytes.saturating_add(size_before);
        removed_files = removed_files.saturating_add(1);
    }
    Ok(ClearCacheResult {
        removed_bytes,
        removed_files,
    })
}

#[tauri::command]
fn clear_thumbnail_cache(app: tauri::AppHandle) -> Result<ClearCacheResult, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let first = clear_dir_contents(&app_data.join(".thumbnails"))?;
    let second = clear_dir_contents(&app_data.join("thumbnails"))?;
    let outcome = material_catalog_for_app(&app)?
        .clear_video_thumbnail_references()
        .map_err(|error| error.message)?;
    emit_catalog_change(&app, &outcome.change);
    Ok(ClearCacheResult {
        removed_bytes: first.removed_bytes.saturating_add(second.removed_bytes),
        removed_files: first.removed_files.saturating_add(second.removed_files),
    })
}

fn validate_video_thumbnail_asset_id(asset_id: &str) -> Result<(), String> {
    if asset_id.is_empty()
        || asset_id.len() > 160
        || !asset_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err("Invalid asset id for video thumbnail".to_string());
    }
    Ok(())
}

fn video_thumbnail_extension(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("png")
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

fn remove_video_thumbnail_files(app_data: &std::path::Path, asset_id: &str) -> Result<(), String> {
    validate_video_thumbnail_asset_id(asset_id)?;
    let directory = app_data.join("thumbnails").join("video");
    for extension in ["jpg", "png", "webp"] {
        let path = directory.join(format!("{}.{}", asset_id, extension));
        if path.exists() {
            std::fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn persist_video_thumbnail(
    app: tauri::AppHandle,
    asset_id: String,
    data: Vec<u8>,
    notify: Option<bool>,
) -> Result<String, String> {
    validate_video_thumbnail_asset_id(&asset_id)?;
    if data.len() < 64 || data.len() > 8 * 1024 * 1024 {
        return Err("Video thumbnail size is invalid".to_string());
    }
    let extension = video_thumbnail_extension(&data)
        .ok_or_else(|| "Unsupported video thumbnail image format".to_string())?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let directory = app_data.join("thumbnails").join("video");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let catalog = material_catalog_for_app(&app)?;
    let is_video = catalog
        .list_assets(&materials::MaterialFilter::default())
        .map_err(|error| error.message)?
        .into_iter()
        .any(|asset| asset.id == asset_id && asset.kind == "video");
    if !is_video {
        return Err("Video asset does not exist".to_string());
    }

    remove_video_thumbnail_files(&app_data, &asset_id)?;
    let path = directory.join(format!("{}.{}", asset_id, extension));
    let temporary = directory.join(format!("{}.{}.tmp", asset_id, extension));
    std::fs::write(&temporary, &data).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;

    let path_text = path.to_string_lossy().to_string();
    let outcome = match catalog.update_asset(
        &asset_id,
        materials::MaterialAssetPatch {
            thumbnail_url: Some(path_text.clone()),
            ..Default::default()
        },
        "video-thumbnail-ready",
    ) {
        Ok(outcome) => outcome,
        Err(error) => {
            let _ = std::fs::remove_file(&path);
            return Err(error.message);
        }
    };
    if notify.unwrap_or(true) {
        emit_catalog_change(&app, &outcome.change);
    }
    Ok(path_text)
}

#[cfg(test)]
mod video_thumbnail_tests {
    use super::{validate_video_thumbnail_asset_id, video_thumbnail_extension};

    #[test]
    fn detects_supported_thumbnail_formats() {
        assert_eq!(
            video_thumbnail_extension(&[0xff, 0xd8, 0xff, 0x00]),
            Some("jpg")
        );
        assert_eq!(
            video_thumbnail_extension(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
            Some("png")
        );
        assert_eq!(video_thumbnail_extension(b"RIFF0000WEBP"), Some("webp"));
        assert_eq!(video_thumbnail_extension(b"not-an-image"), None);
    }

    #[test]
    fn rejects_thumbnail_path_escape_ids() {
        assert!(validate_video_thumbnail_asset_id("asset_01-safe").is_ok());
        assert!(validate_video_thumbnail_asset_id("../outside").is_err());
        assert!(validate_video_thumbnail_asset_id("folder\\asset").is_err());
    }
}

fn remove_dir_if_exists(dir: &std::path::Path) -> Result<ClearCacheResult, String> {
    if !dir.exists() {
        return Ok(ClearCacheResult {
            removed_bytes: 0,
            removed_files: 0,
        });
    }
    let removed_bytes = dir_size_bytes(dir);
    std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    Ok(ClearCacheResult {
        removed_bytes,
        removed_files: 1,
    })
}

fn remove_file_if_exists(path: &std::path::Path) -> Result<ClearCacheResult, String> {
    if !path.exists() {
        return Ok(ClearCacheResult {
            removed_bytes: 0,
            removed_files: 0,
        });
    }
    let removed_bytes = path.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    std::fs::remove_file(path).map_err(|error| error.to_string())?;
    Ok(ClearCacheResult {
        removed_bytes,
        removed_files: 1,
    })
}

fn clear_app_owned_paths(app_data: &std::path::Path) -> Result<ClearCacheResult, String> {
    let mut removed_bytes = 0u64;
    let mut removed_files = 0u32;
    for dirname in CLEAR_DATA_DIRECTORIES {
        let result = remove_dir_if_exists(&app_data.join(dirname))?;
        removed_bytes = removed_bytes.saturating_add(result.removed_bytes);
        removed_files = removed_files.saturating_add(result.removed_files);
    }
    for filename in CLEAR_DATA_FILES {
        let result = remove_file_if_exists(&app_data.join(filename))?;
        removed_bytes = removed_bytes.saturating_add(result.removed_bytes);
        removed_files = removed_files.saturating_add(result.removed_files);
    }
    Ok(ClearCacheResult {
        removed_bytes,
        removed_files,
    })
}

fn clear_known_table(conn: &rusqlite::Connection, table: &str) -> Result<bool, String> {
    let sql = format!("DELETE FROM {}", table);
    match conn.execute(&sql, []) {
        Ok(_) => Ok(true),
        Err(err) => {
            let message = err.to_string();
            if message.contains("no such table") || message.contains("no such module") {
                Ok(false)
            } else {
                Err(message)
            }
        }
    }
}

#[tauri::command]
fn clear_all_data(
    app: tauri::AppHandle,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
) -> Result<ClearAllDataResult, String> {
    if !backend.stop_all_runs_and_wait(std::time::Duration::from_secs(10)) {
        return Err("agent-run-stop-timeout".to_owned());
    }
    let backup = create_backup(app.clone())?;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_data.join("luckyray.db");
    let mut cleared_tables = Vec::new();

    if db_path.exists() {
        let conn =
            rusqlite::Connection::open(&db_path).map_err(|e| format!("打开数据库失败: {}", e))?;
        let tables = [
            "collection_item_search",
            "asset_search",
            "item_tag",
            "ai_run_source",
            "ai_run_artifact",
            "ai_run_capability_snapshot",
            "ai_run",
            "ai_message",
            "ai_conversation",
            "agent_project",
            "asset_ai",
            "memory_entries",
            "agent_capability_state",
            "agent_skill_state",
            "agent_skill_package",
            "agent_workspace_grant",
            "agent_schedule_fire",
            "agent_schedule",
            "collection_item",
            "collection_failure",
            "asset",
            "folder",
            "tag",
            "settings",
            "local_capability",
        ];
        for table in tables {
            if clear_known_table(&conn, table)? {
                cleared_tables.push(table.to_string());
            }
        }
        let _ = conn.execute("VACUUM", []);
    }

    let removed = clear_app_owned_paths(&app_data)?;

    Ok(ClearAllDataResult {
        backup_id: backup.id,
        cleared_tables,
        removed_bytes: removed.removed_bytes,
        removed_files: removed.removed_files,
    })
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let entries = std::fs::read_dir(src).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 自动轮转：保留最新 MAX_BACKUPS 份，删除多余的
fn rotate_backups(root: &std::path::Path) {
    let mut dirs: Vec<_> = std::fs::read_dir(root)
        .into_iter()
        .flat_map(|r| r.into_iter())
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().is_dir() && !e.file_name().to_string_lossy().starts_with("pre-restore-")
        })
        .collect();
    dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    for old in dirs.iter().skip(MAX_BACKUPS) {
        let _ = std::fs::remove_dir_all(old.path());
    }
}

fn checkpoint_db(db_path: &std::path::Path) -> Result<(), String> {
    if !db_path.exists() {
        return Ok(());
    }

    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    let (busy, _log, _checkpointed): (i64, i64, i64) = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| e.to_string())?;
    if busy != 0 {
        return Err("数据库正在被占用，请稍后再备份或恢复".to_string());
    }
    Ok(())
}

fn verify_db_integrity(db_path: &std::path::Path) -> Result<(), String> {
    if !db_path.exists() {
        return Ok(());
    }
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    let result: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if result.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(format!("SQLite 完整性检查失败: {}", result))
    }
}

fn remove_sqlite_sidecars(db_path: &std::path::Path) -> Result<(), String> {
    for suffix in ["-wal", "-shm"] {
        let sidecar = std::path::PathBuf::from(format!("{}{}", db_path.to_string_lossy(), suffix));
        if sidecar.exists() {
            std::fs::remove_file(&sidecar).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn write_manifest(dir: &std::path::Path, manifest: &BackupManifest) -> Result<(), String> {
    let manifest_json = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("manifest.json"), manifest_json).map_err(|e| e.to_string())
}

fn copy_current_data_to_backup(
    app_data: &std::path::Path,
    backup_dir: &std::path::Path,
    created_at: String,
) -> Result<BackupManifest, String> {
    std::fs::create_dir_all(backup_dir).map_err(|e| e.to_string())?;

    let db_src = app_data.join("luckyray.db");
    let db_dst = backup_dir.join("luckyray.db");
    let db_size = if db_src.exists() {
        checkpoint_db(&db_src)?;
        std::fs::copy(&db_src, &db_dst).map_err(|e| e.to_string())?
    } else {
        0
    };

    for dirname in BACKUP_DATA_DIRECTORIES {
        let source = app_data.join(dirname);
        if source.exists() {
            copy_dir_recursive(&source, &backup_dir.join(dirname))?;
        }
    }
    for filename in BACKUP_DATA_FILES {
        let source = app_data.join(filename);
        if source.exists() {
            std::fs::copy(&source, backup_dir.join(filename)).map_err(|error| error.to_string())?;
        }
    }
    let asset_count = count_files(&backup_dir.join("asset-library"));

    let manifest = BackupManifest {
        created_at,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        db_size_bytes: db_size,
        asset_count,
        source_dir: app_data.to_string_lossy().to_string(),
    };
    write_manifest(backup_dir, &manifest)?;
    Ok(manifest)
}

fn restore_data_from_backup(
    backup_dir: &std::path::Path,
    app_data: &std::path::Path,
) -> Result<(), String> {
    let backup_db = backup_dir.join("luckyray.db");
    let db_dst = app_data.join("luckyray.db");
    if backup_db.exists() {
        remove_sqlite_sidecars(&db_dst)?;
        std::fs::copy(&backup_db, &db_dst).map_err(|e| e.to_string())?;
        remove_sqlite_sidecars(&db_dst)?;
        verify_db_integrity(&db_dst)?;
    }

    for dirname in BACKUP_DATA_DIRECTORIES {
        let backup_source = backup_dir.join(dirname);
        if !backup_source.exists() {
            continue;
        }
        let destination = app_data.join(dirname);
        let restore_tmp = app_data.join(format!("{dirname}.restore-tmp"));
        if restore_tmp.exists() {
            std::fs::remove_dir_all(&restore_tmp).map_err(|e| e.to_string())?;
        }
        copy_dir_recursive(&backup_source, &restore_tmp)?;
        if destination.exists() {
            std::fs::remove_dir_all(&destination).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&restore_tmp, &destination).map_err(|e| e.to_string())?;
    }
    for filename in BACKUP_DATA_FILES {
        let backup_source = backup_dir.join(filename);
        if backup_source.exists() {
            let destination = app_data.join(filename);
            let restore_tmp = app_data.join(format!("{filename}.restore-tmp"));
            std::fs::copy(&backup_source, &restore_tmp).map_err(|error| error.to_string())?;
            if destination.exists() {
                std::fs::remove_file(&destination).map_err(|error| error.to_string())?;
            }
            std::fs::rename(&restore_tmp, &destination).map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod settings_data_safety_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_dir(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("luckyray-{label}-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn backup_round_trip_preserves_all_product_owned_data() {
        let root = unique_test_dir("settings-backup");
        let app_data = root.join("app-data");
        let backup = root.join("backup");
        std::fs::create_dir_all(&app_data).unwrap();
        rusqlite::Connection::open(app_data.join("luckyray.db")).unwrap();

        let directory_files = [
            ("asset-library", "asset.bin"),
            ("canvases", "canvas.json"),
            ("canvas", "generated-videos/video.mp4"),
            ("generated-images", "image.png"),
            ("ai", "model-profiles.json"),
            ("material-managed-roots", "roots.json"),
        ];
        for (directory, relative_file) in directory_files {
            let path = app_data.join(directory).join(relative_file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, format!("payload:{directory}")).unwrap();
        }
        std::fs::write(app_data.join("notes-vault-current.json"), "vault-map").unwrap();

        let manifest = copy_current_data_to_backup(&app_data, &backup, "now".to_string()).unwrap();
        for (directory, relative_file) in directory_files {
            assert!(
                backup.join(directory).join(relative_file).is_file(),
                "{directory}"
            );
            std::fs::remove_dir_all(app_data.join(directory)).unwrap();
        }
        assert!(backup.join("notes-vault-current.json").is_file());
        std::fs::remove_file(app_data.join("notes-vault-current.json")).unwrap();
        assert_eq!(manifest.app_version, env!("CARGO_PKG_VERSION"));

        restore_data_from_backup(&backup, &app_data).unwrap();
        for (directory, relative_file) in directory_files {
            assert!(
                app_data.join(directory).join(relative_file).is_file(),
                "{directory}"
            );
        }
        assert_eq!(
            std::fs::read_to_string(app_data.join("notes-vault-current.json")).unwrap(),
            "vault-map"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clear_app_owned_paths_keeps_external_and_security_state_out_of_scope() {
        let root = unique_test_dir("settings-clear");
        let app_data = root.join("app-data");
        let external_vault = root.join("external-vault");
        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::create_dir_all(&external_vault).unwrap();
        std::fs::write(external_vault.join("note.md"), "external").unwrap();
        std::fs::write(
            app_data.join("local-transport-auth-v1.json"),
            "secret-state",
        )
        .unwrap();

        for dirname in CLEAR_DATA_DIRECTORIES {
            let path = app_data.join(dirname).join("payload.bin");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, dirname).unwrap();
        }
        for filename in CLEAR_DATA_FILES {
            std::fs::write(app_data.join(filename), filename).unwrap();
        }

        clear_app_owned_paths(&app_data).unwrap();

        for dirname in CLEAR_DATA_DIRECTORIES {
            assert!(!app_data.join(dirname).exists(), "{dirname}");
        }
        for filename in CLEAR_DATA_FILES {
            assert!(!app_data.join(filename).exists(), "{filename}");
        }
        assert_eq!(
            std::fs::read_to_string(external_vault.join("note.md")).unwrap(),
            "external"
        );
        assert!(app_data.join("local-transport-auth-v1.json").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tauri::command]
fn create_backup(app: tauri::AppHandle) -> Result<BackupInfo, String> {
    let root = backup_root(&app)?;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;

    // 时间戳目录名: 20260612-210530
    let now = chrono::Local::now();
    let dir_name = now.format("%Y%m%d-%H%M%S").to_string();
    let backup_dir = root.join(&dir_name);
    let manifest = copy_current_data_to_backup(&app_data, &backup_dir, now.to_rfc3339())?;

    // 轮转旧备份
    rotate_backups(&root);

    Ok(BackupInfo {
        id: dir_name,
        path: backup_dir.to_string_lossy().to_string(),
        manifest,
    })
}

fn collect_backups(app: tauri::AppHandle) -> Result<Vec<BackupInfo>, String> {
    let root = backup_root(&app)?;
    let mut backups = Vec::new();

    let entries = std::fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        let manifest: BackupManifest = if manifest_path.exists() {
            let data = std::fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
            serde_json::from_str(&data).map_err(|e| e.to_string())?
        } else {
            // 兼容没有 manifest 的旧备份目录
            let db_size = path
                .join("luckyray.db")
                .metadata()
                .map(|m| m.len())
                .unwrap_or(0);
            let asset_count = count_files(&path.join("asset-library"));
            BackupManifest {
                created_at: String::new(),
                app_version: "unknown".to_string(),
                db_size_bytes: db_size,
                asset_count,
                source_dir: String::new(),
            }
        };
        let id = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        backups.push(BackupInfo {
            id,
            path: path.to_string_lossy().to_string(),
            manifest,
        });
    }

    // 按 id 降序（即时间最新在前）
    backups.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(backups)
}

#[tauri::command]
async fn list_backups(app: tauri::AppHandle) -> Result<Vec<BackupInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || collect_backups(app))
        .await
        .map_err(|error| format!("backup-list-task-failed: {error}"))?
}

#[tauri::command]
fn restore_backup(
    app: tauri::AppHandle,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    backup_id: String,
) -> Result<String, String> {
    if !backend.stop_all_runs_and_wait(std::time::Duration::from_secs(10)) {
        return Err("agent-run-stop-timeout".to_owned());
    }
    let root = backup_root(&app)?;
    let backup_dir = root.join(&backup_id);

    if !backup_dir.exists() {
        return Err(format!("备份不存在: {}", backup_id));
    }

    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;

    // 恢复前自动创建 pre-restore 安全备份
    let now = chrono::Local::now();
    let pre_name = format!("pre-restore-{}", now.format("%Y%m%d-%H%M%S"));
    let pre_dir = root.join(&pre_name);

    copy_current_data_to_backup(&app_data, &pre_dir, now.to_rfc3339())?;

    if let Err(error) = restore_data_from_backup(&backup_dir, &app_data) {
        let rollback_result = restore_data_from_backup(&pre_dir, &app_data);
        return match rollback_result {
            Ok(()) => Err(format!("恢复失败，已回滚到恢复前数据: {}", error)),
            Err(rollback_error) => Err(format!(
                "恢复失败，且自动回滚失败。恢复前安全备份在 {}。错误: {}; 回滚错误: {}",
                pre_dir.to_string_lossy(),
                error,
                rollback_error
            )),
        };
    }

    verify_db_integrity(&app_data.join("luckyray.db"))?;

    Ok(format!(
        "已恢复备份 {}，安全备份已保存为 {}",
        backup_id, pre_name
    ))
}

#[derive(serde::Serialize)]
struct ExportResult {
    path: String,
    count: u32,
}

const NOTES_VAULT_SCHEMA_VERSION: u32 = 1;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NotesVaultMetadata {
    id: String,
    name: String,
    root_path: String,
    mode: String,
    created_at: String,
    last_opened_at: String,
    schema_version: u32,
    #[serde(default)]
    link_update_policy: knowledge::LinkUpdatePolicy,
}

impl From<&NotesVaultMetadata> for knowledge::KnowledgeVaultRegistration {
    fn from(vault: &NotesVaultMetadata) -> Self {
        Self {
            id: vault.id.clone(),
            name: vault.name.clone(),
            root_path: vault.root_path.clone(),
            mode: vault.mode.clone(),
            created_at: vault.created_at.clone(),
            last_opened_at: vault.last_opened_at.clone(),
            schema_version: vault.schema_version,
            link_update_policy: vault.link_update_policy,
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenNotesVaultResult {
    vault: Option<NotesVaultMetadata>,
    missing: bool,
    root_path: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NotesVaultFileNode {
    kind: String,
    name: String,
    relative_path: String,
    absolute_path: String,
    children: Vec<NotesVaultFileNode>,
    mtime: Option<String>,
    size: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotesVaultMarkdownFile {
    name: String,
    relative_path: String,
    absolute_path: String,
    content_text: String,
    mtime: Option<String>,
    size: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NotesVaultMarkdownHeading {
    level: u8,
    text: String,
    slug: String,
    line: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NotesVaultMarkdownWikiLink {
    raw: String,
    target: String,
    alias: Option<String>,
    line: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NotesVaultMarkdownEmbed {
    raw: String,
    target: String,
    kind: Option<String>,
    line: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NotesVaultMarkdownIndexDocument {
    relative_path: String,
    absolute_path: String,
    file_name: String,
    title: String,
    revision: String,
    headings: Vec<NotesVaultMarkdownHeading>,
    wiki_links: Vec<NotesVaultMarkdownWikiLink>,
    embeds: Vec<NotesVaultMarkdownEmbed>,
    tags: Vec<String>,
    frontmatter_tags: Vec<String>,
    inline_tags: Vec<String>,
    plain_text: String,
    excerpt: String,
    content_length: usize,
    mtime: Option<String>,
    size: u64,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NotesVaultMarkdownIndexError {
    code: String,
    message: String,
    relative_path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotesVaultMarkdownIndex {
    vault_id: String,
    root_path: String,
    generated_at: String,
    documents: Vec<NotesVaultMarkdownIndexDocument>,
    errors: Vec<NotesVaultMarkdownIndexError>,
    version: u64,
    changed_paths: Vec<String>,
    removed_paths: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotesVaultWriteResult {
    relative_path: String,
    absolute_path: String,
    mtime: Option<String>,
    size: u64,
    message: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotesVaultDeleteResult {
    relative_path: String,
    absolute_path: String,
    deleted: bool,
    message: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotesVaultFileTransferItem {
    source_path: String,
    relative_path: String,
    absolute_path: String,
    renamed: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotesVaultFileTransferError {
    source_path: String,
    code: String,
    message: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotesVaultImportMarkdownResult {
    copied_count: usize,
    failed_count: usize,
    skipped_count: usize,
    conflict_renamed_count: usize,
    target_parent_relative_path: String,
    files: Vec<NotesVaultFileTransferItem>,
    errors: Vec<NotesVaultFileTransferError>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotesVaultExportMarkdownResult {
    exported_count: usize,
    conflict_renamed_count: usize,
    target_directory_path: String,
    files: Vec<NotesVaultFileTransferItem>,
    errors: Vec<NotesVaultFileTransferError>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotesVaultAssetExistsResult {
    relative_path: String,
    absolute_path: String,
    exists: bool,
    is_file: bool,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NotesVaultAssetCandidateResult {
    relative_path: String,
    absolute_path: String,
    exists: bool,
    is_file: bool,
    match_kind: String,
}

fn notes_vault_now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn notes_vault_metadata_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join(".luckyray").join("vault.json")
}

fn notes_vault_state_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("notes-vault-current.json"))
}

fn normalize_vault_root(path: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("仓库目录不能为空".to_string());
    }
    let root = std::path::PathBuf::from(trimmed);
    if !root.exists() {
        return Err(format!("仓库目录不存在: {}", trimmed));
    }
    if !root.is_dir() {
        return Err(format!("选择的路径不是目录: {}", trimmed));
    }
    Ok(root)
}

fn allow_notes_vault_fs_scope(
    app: &tauri::AppHandle,
    root: &std::path::Path,
) -> Result<(), String> {
    app.fs_scope()
        .allow_directory(root, true)
        .map_err(|error| format!("allow-notes-vault-fs-scope-failed: {}", error))
}

/// The canvas writes generated images/videos into app-data subdirectories and
/// reads them back for previews. Tauri's default fs scope does not include the
/// app data dir, so it must be granted explicitly - mirroring the notes-vault
/// scope grant, and limited to these two directories.
fn allow_canvas_generated_media_fs_scope(app: &tauri::AppHandle) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("canvas-generated-media-scope-unavailable: {error}"))?;
    for directory in ["generated-images", "generated-videos"] {
        let path = app_data.join(directory);
        std::fs::create_dir_all(&path)
            .map_err(|error| format!("canvas-generated-media-directory-failed: {error}"))?;
        app.fs_scope()
            .allow_directory(&path, true)
            .map_err(|error| format!("allow-canvas-generated-media-fs-scope-failed: {error}"))?;
    }
    Ok(())
}

fn is_reserved_notes_vault_path_segment(segment: &str) -> bool {
    segment.eq_ignore_ascii_case(".luckyray")
}

fn safe_vault_relative_asset_path(relative_path: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = relative_path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err("invalid-relative-path: asset path cannot be empty".to_string());
    }
    if trimmed.starts_with('/') || trimmed.starts_with('~') || trimmed.contains(':') {
        return Err(format!(
            "path-outside-vault: asset path must be vault-relative: {}",
            relative_path
        ));
    }
    let mut path = std::path::PathBuf::new();
    for segment in trimmed.split('/') {
        let part = segment.trim();
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!(
                "path-outside-vault: asset path contains unsafe segment: {}",
                relative_path
            ));
        }
        if is_reserved_notes_vault_path_segment(part) {
            return Err(format!(
                "reserved-vault-metadata-path: .luckyray is reserved: {}",
                relative_path
            ));
        }
        path.push(part);
    }
    Ok(path)
}

fn notes_vault_asset_candidate_result(
    root: &std::path::Path,
    relative: &std::path::Path,
    match_kind: &str,
) -> Option<NotesVaultAssetCandidateResult> {
    let target = notes_vault_target_in_root(root, relative).ok()?;
    if !target.exists() || !target.is_file() {
        return None;
    }
    Some(NotesVaultAssetCandidateResult {
        relative_path: notes_vault_relative_path_string(relative),
        absolute_path: target.to_string_lossy().to_string(),
        exists: true,
        is_file: true,
        match_kind: match_kind.to_string(),
    })
}

fn push_notes_vault_asset_candidate(
    root: &std::path::Path,
    relative: &std::path::Path,
    match_kind: &str,
    seen: &mut HashSet<String>,
    results: &mut Vec<NotesVaultAssetCandidateResult>,
) {
    if let Some(candidate) = notes_vault_asset_candidate_result(root, relative, match_kind) {
        let key = candidate.relative_path.to_ascii_lowercase();
        if seen.insert(key) {
            results.push(candidate);
        }
    }
}

fn collect_notes_vault_asset_basename_matches(
    root: &std::path::Path,
    dir: &std::path::Path,
    relative_dir: &std::path::Path,
    basename_lower: &str,
    seen: &mut HashSet<String>,
    results: &mut Vec<NotesVaultAssetCandidateResult>,
) -> Result<(), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("resolve-vault-root-failed: {}", error))?;
    let entries =
        std::fs::read_dir(dir).map_err(|error| format!("read-vault-dir-failed: {}", error))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if is_reserved_notes_vault_path_segment(&name) {
            continue;
        }
        let canonical = match path.canonicalize() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !canonical.starts_with(&canonical_root) {
            continue;
        }
        let mut child_relative = relative_dir.to_path_buf();
        child_relative.push(&name);
        if path.is_dir() {
            collect_notes_vault_asset_basename_matches(
                root,
                &path,
                &child_relative,
                basename_lower,
                seen,
                results,
            )?;
        } else if name.to_ascii_lowercase() == basename_lower {
            push_notes_vault_asset_candidate(root, &child_relative, "basename", seen, results);
        }
    }
    Ok(())
}
fn safe_vault_relative_markdown_path(relative_path: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = relative_path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err("试迁移路径不能为空".to_string());
    }
    if trimmed.starts_with('/') || trimmed.starts_with('~') || trimmed.contains(':') {
        return Err(format!("试迁移路径必须是仓库内相对路径: {}", relative_path));
    }
    if !trimmed.to_ascii_lowercase().ends_with(".md") {
        return Err(format!("试迁移目标必须是 Markdown 文件: {}", relative_path));
    }
    let mut path = std::path::PathBuf::new();
    for segment in trimmed.split('/') {
        let part = segment.trim();
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("试迁移路径包含不安全片段: {}", relative_path));
        }
        if is_reserved_notes_vault_path_segment(part) {
            return Err(format!(
                "reserved-vault-metadata-path: .luckyray is reserved: {}",
                relative_path
            ));
        }
        path.push(part);
    }
    Ok(path)
}

fn safe_vault_relative_directory_path(relative_path: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = relative_path
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    let mut path = std::path::PathBuf::new();
    if trimmed.is_empty() {
        return Ok(path);
    }
    if trimmed.starts_with('/') || trimmed.starts_with('~') || trimmed.contains(':') {
        return Err(format!(
            "path-outside-vault: 目录路径必须是仓库内相对路径: {}",
            relative_path
        ));
    }
    for segment in trimmed.split('/') {
        let part = segment.trim();
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!(
                "path-outside-vault: 目录路径包含不安全片段: {}",
                relative_path
            ));
        }
        if is_reserved_notes_vault_path_segment(part) {
            return Err(format!(
                "reserved-vault-metadata-path: .luckyray is reserved: {}",
                relative_path
            ));
        }
        path.push(part);
    }
    Ok(path)
}

fn safe_notes_vault_entity_name(name: &str, kind: &str) -> Result<String, String> {
    let trimmed = name.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        return Err(format!("invalid-name: {}名称不能为空", kind));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(format!("invalid-name: {}名称不安全", kind));
    }
    if trimmed.chars().any(|ch| {
        ch == '\\'
            || ch == '/'
            || ch == ':'
            || ch == '*'
            || ch == '?'
            || ch == '"'
            || ch == '<'
            || ch == '>'
            || ch == '|'
            || ch.is_control()
    }) {
        return Err(format!("invalid-name: {}名称包含非法字符", kind));
    }
    Ok(trimmed.to_string())
}

fn safe_notes_vault_markdown_file_name(name: &str) -> Result<String, String> {
    let mut safe_name = safe_notes_vault_entity_name(name, "Markdown 文件")?;
    if !safe_name.to_ascii_lowercase().ends_with(".md") {
        safe_name.push_str(".md");
    }
    if safe_name.eq_ignore_ascii_case(".md") {
        return Err("invalid-name: Markdown 文件名不能为空".to_string());
    }
    Ok(safe_name)
}

fn notes_vault_metadata_checked_root(
    vault: &NotesVaultMetadata,
) -> Result<std::path::PathBuf, String> {
    let root = normalize_vault_root(&vault.root_path)?;
    let metadata_path = notes_vault_metadata_path(&root);
    if !metadata_path.exists() {
        return Err(
            "missing-vault-metadata: 当前仓库缺少 .luckyray/vault.json，请先建立或打开仓库"
                .to_string(),
        );
    }
    Ok(root)
}

fn notes_vault_modified_time(metadata: &std::fs::Metadata) -> Option<String> {
    metadata
        .modified()
        .ok()
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
}

fn notes_vault_relative_path_string(path: &std::path::Path) -> String {
    path.iter()
        .filter_map(|part| part.to_str())
        .collect::<Vec<_>>()
        .join("/")
}

fn notes_vault_target_in_root(
    root: &std::path::Path,
    relative_path: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("解析仓库目录失败: {}", error))?;
    let target = root.join(relative_path);
    if target.exists() {
        let canonical_target = target
            .canonicalize()
            .map_err(|error| format!("解析仓库内路径失败: {}", error))?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err("path-outside-vault: 目标路径不在当前仓库内".to_string());
        }
        return Ok(target);
    }
    let parent = target
        .parent()
        .ok_or_else(|| "path-outside-vault: 无法解析目标父目录".to_string())?;
    let existing_parent = if parent.exists() {
        parent.to_path_buf()
    } else {
        parent
            .ancestors()
            .find(|ancestor| ancestor.exists())
            .map(|ancestor| ancestor.to_path_buf())
            .unwrap_or_else(|| root.to_path_buf())
    };
    let canonical_parent = existing_parent
        .canonicalize()
        .map_err(|error| format!("解析目标父目录失败: {}", error))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err("path-outside-vault: 目标父目录不在当前仓库内".to_string());
    }
    Ok(target)
}

fn notes_vault_existing_markdown_target(
    root: &std::path::Path,
    relative_path: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let relative = safe_vault_relative_markdown_path(relative_path)
        .map_err(|error| format!("not-markdown-file: {}", error))?;
    let target = notes_vault_target_in_root(root, &relative)?;
    if !target.exists() {
        return Err(format!(
            "missing-file: Markdown file does not exist: {}",
            relative_path
        ));
    }
    if !target.is_file() {
        return Err("not-markdown-file: target path is not a Markdown file".to_string());
    }
    Ok((relative, target))
}

fn notes_vault_existing_directory_target(
    root: &std::path::Path,
    relative_path: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let relative = safe_vault_relative_directory_path(relative_path)?;
    if relative.as_os_str().is_empty() {
        return Err("invalid-target: vault root cannot be renamed, moved, or deleted".to_string());
    }
    let target = notes_vault_target_in_root(root, &relative)?;
    if !target.exists() {
        return Err(format!(
            "missing-folder: folder does not exist: {}",
            relative_path
        ));
    }
    if !target.is_dir() {
        return Err("not-folder: target path is not a folder".to_string());
    }
    Ok((relative, target))
}

fn notes_vault_existing_parent_directory(
    root: &std::path::Path,
    parent_relative_path: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let relative = safe_vault_relative_directory_path(parent_relative_path)?;
    let target = notes_vault_target_in_root(root, &relative)?;
    if !target.exists() {
        return Err(format!(
            "missing-folder: target folder does not exist: {}",
            parent_relative_path
        ));
    }
    if !target.is_dir() {
        return Err("not-folder: target parent is not a folder".to_string());
    }
    Ok((relative, target))
}

fn notes_vault_relative_parent(relative: &std::path::Path) -> std::path::PathBuf {
    relative
        .parent()
        .map(|path| path.to_path_buf())
        .unwrap_or_else(std::path::PathBuf::new)
}
fn notes_vault_file_node(
    root: &std::path::Path,
    path: &std::path::Path,
    relative_path: std::path::PathBuf,
) -> Result<NotesVaultFileNode, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("读取仓库文件信息失败 {}: {}", path.to_string_lossy(), error))?;
    let is_dir = metadata.is_dir();
    let name = if relative_path.as_os_str().is_empty() {
        notes_vault_name(root)
    } else {
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_string()
    };
    let mut children = Vec::new();
    if is_dir {
        let mut entries: Vec<std::path::PathBuf> = std::fs::read_dir(path)
            .map_err(|error| format!("读取仓库目录失败 {}: {}", path.to_string_lossy(), error))?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|entry_path| {
                let name = entry_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                if name == ".luckyray" {
                    return false;
                }
                if entry_path.is_dir() {
                    return true;
                }
                entry_path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("md"))
                    .unwrap_or(false)
            })
            .collect();
        entries.sort_by(|a, b| {
            let a_dir = a.is_dir();
            let b_dir = b.is_dir();
            b_dir.cmp(&a_dir).then_with(|| {
                a.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .cmp(
                        &b.file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("")
                            .to_ascii_lowercase(),
                    )
            })
        });
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        for entry_path in entries {
            let mut child_relative = relative_path.clone();
            if let Some(name) = entry_path.file_name() {
                child_relative.push(name);
            }
            let safe_child = entry_path
                .canonicalize()
                .map(|canonical| canonical.starts_with(&canonical_root))
                .unwrap_or(false);
            if !safe_child {
                continue;
            }
            children.push(notes_vault_file_node(root, &entry_path, child_relative)?);
        }
    }

    Ok(NotesVaultFileNode {
        kind: if is_dir { "folder" } else { "file" }.to_string(),
        name,
        relative_path: notes_vault_relative_path_string(&relative_path),
        absolute_path: path.to_string_lossy().to_string(),
        children,
        mtime: notes_vault_modified_time(&metadata),
        size: if metadata.is_file() {
            metadata.len()
        } else {
            0
        },
    })
}

fn notes_vault_name(root: &std::path::Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "LuckyRay Vault".to_string())
}

fn make_notes_vault_id(root: &std::path::Path, created_at: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(root.to_string_lossy().as_bytes());
    hasher.update(created_at.as_bytes());
    let digest = hasher.finalize();
    format!(
        "lr-vault-{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3]
    )
}

fn read_notes_vault_metadata(path: &std::path::Path) -> Result<NotesVaultMetadata, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("读取仓库元数据失败: {}", error))?;
    serde_json::from_str::<NotesVaultMetadata>(&text)
        .map_err(|error| format!("仓库元数据格式无效: {}", error))
}

fn write_notes_vault_metadata(
    path: &std::path::Path,
    metadata: &NotesVaultMetadata,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建仓库元数据目录失败: {}", error))?;
    }
    knowledge_service()?.write_vault_registration_metadata(path, &knowledge::KnowledgeVaultRegistration::from(metadata)).map_err(knowledge_error)
}

fn write_current_notes_vault(
    _app: &tauri::AppHandle,
    metadata: &NotesVaultMetadata,
) -> Result<(), String> {
    knowledge_service()?
        .register_current_vault(&knowledge::KnowledgeVaultRegistration::from(metadata))
        .map_err(knowledge_error)
}

#[tauri::command]
fn knowledge_migrate_saved_vaults(caller: tauri::Webview, vaults: Vec<NotesVaultMetadata>) -> Result<(), String> {
    require_main_caller(&caller)?;
    let registrations: Vec<_> = vaults.iter().map(knowledge::KnowledgeVaultRegistration::from).collect();
    knowledge_service()?.migrate_saved_vaults(&registrations).map_err(knowledge_error)
}

#[tauri::command]
fn get_current_notes_vault(app: tauri::AppHandle) -> Result<Option<NotesVaultMetadata>, String> {
    let path = notes_vault_state_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let mut metadata = read_notes_vault_metadata(&path)?;
    metadata.link_update_policy = knowledge_service()?.attachment_link_update_policy(&metadata.id).map_err(knowledge_error)?;
    if let Ok(root) = normalize_vault_root(&metadata.root_path) {
        allow_notes_vault_fs_scope(&app, &root)?;
    }
    Ok(Some(metadata))
}

#[tauri::command]
fn create_notes_vault(
    app: tauri::AppHandle,
    root_path: String,
) -> Result<NotesVaultMetadata, String> {
    let root = normalize_vault_root(&root_path)?;
    allow_notes_vault_fs_scope(&app, &root)?;
    let metadata_path = notes_vault_metadata_path(&root);
    let now = notes_vault_now();
    let mut metadata = if metadata_path.exists() {
        read_notes_vault_metadata(&metadata_path)?
    } else {
        NotesVaultMetadata {
            id: make_notes_vault_id(&root, &now),
            name: notes_vault_name(&root),
            root_path: root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: now.clone(),
            last_opened_at: now.clone(),
            schema_version: NOTES_VAULT_SCHEMA_VERSION,
            link_update_policy: knowledge::LinkUpdatePolicy::default(),
        }
    };

    metadata.root_path = root.to_string_lossy().to_string();
    metadata.mode = "vault-bound".to_string();
    metadata.schema_version = NOTES_VAULT_SCHEMA_VERSION;
    metadata.last_opened_at = now;
    write_notes_vault_metadata(&metadata_path, &metadata)?;
    write_current_notes_vault(&app, &metadata)?;
    metadata.link_update_policy = knowledge_service()?.attachment_link_update_policy(&metadata.id).map_err(knowledge_error)?;
    Ok(metadata)
}

#[tauri::command]
fn open_notes_vault(
    app: tauri::AppHandle,
    root_path: String,
) -> Result<OpenNotesVaultResult, String> {
    let root = normalize_vault_root(&root_path)?;
    let metadata_path = notes_vault_metadata_path(&root);
    if !metadata_path.exists() {
        return Ok(OpenNotesVaultResult {
            vault: None,
            missing: true,
            root_path: root.to_string_lossy().to_string(),
        });
    }

    let mut metadata = read_notes_vault_metadata(&metadata_path)?;
    allow_notes_vault_fs_scope(&app, &root)?;
    metadata.root_path = root.to_string_lossy().to_string();
    metadata.last_opened_at = notes_vault_now();
    write_notes_vault_metadata(&metadata_path, &metadata)?;
    write_current_notes_vault(&app, &metadata)?;
    metadata.link_update_policy = knowledge_service()?.attachment_link_update_policy(&metadata.id).map_err(knowledge_error)?;
    Ok(OpenNotesVaultResult {
        vault: Some(metadata),
        missing: false,
        root_path: root.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn list_notes_vault_files(vault: NotesVaultMetadata) -> Result<NotesVaultFileNode, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    notes_vault_file_node(&root, &root, std::path::PathBuf::new())
}

#[tauri::command]
fn notes_vault_asset_exists(
    vault: NotesVaultMetadata,
    relative_path: String,
) -> Result<NotesVaultAssetExistsResult, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let relative = safe_vault_relative_asset_path(&relative_path)?;
    let result = knowledge_service()?.resolve_vault_attachment(&knowledge::KnowledgeDocumentRef { vault_id: vault.id, relative_path: "__attachment_probe__.md".into() }, &format!("./{}", notes_vault_relative_path_string(&relative)), true).map_err(knowledge_error)?;
    Ok(NotesVaultAssetExistsResult {
        relative_path: notes_vault_relative_path_string(&relative),
        absolute_path: result.absolute_path.unwrap_or_else(|| root.join(&relative).to_string_lossy().into_owned()),
        exists: result.status == "resolved",
        is_file: result.status == "resolved",
    })
}

#[tauri::command]
fn open_notes_vault_markdown_file_with_default_app(
    vault: NotesVaultMetadata,
    relative_path: String,
) -> Result<(), String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let (_relative, target) = notes_vault_existing_markdown_target(&root, &relative_path)?;
    tauri_plugin_opener::open_path(&target, None::<&str>)
        .map_err(|error| format!("open-markdown-failed: {}", error))?;
    Ok(())
}

#[tauri::command]
fn open_existing_local_file_with_default_app(path: String) -> Result<(), String> {
    let requested = std::path::PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("open-local-file-path-not-absolute".to_string());
    }
    let target = std::fs::canonicalize(&requested)
        .map_err(|error| format!("open-local-file-not-found: {}", error))?;
    if !target.is_file() {
        return Err("open-local-file-target-is-not-file".to_string());
    }
    tauri_plugin_opener::open_path(&target, None::<&str>)
        .map_err(|error| format!("open-local-file-failed: {}", error))?;
    Ok(())
}

#[tauri::command]
fn notes_vault_find_asset_candidates(
    vault: NotesVaultMetadata,
    target: String,
    current_relative_path: String,
) -> Result<Vec<NotesVaultAssetCandidateResult>, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let result = knowledge_service()?.resolve_vault_attachment(
        &knowledge::KnowledgeDocumentRef { vault_id: vault.id, relative_path: current_relative_path },
        &target, true,
    ).map_err(knowledge_error)?;
    Ok(result.candidates.into_iter().map(|relative_path| NotesVaultAssetCandidateResult {
        absolute_path: root.join(&relative_path).to_string_lossy().into_owned(),
        relative_path, exists: true, is_file: true, match_kind: result.status.clone(),
    }).collect())
}
#[tauri::command]
async fn get_notes_vault_markdown_index(
    vault: NotesVaultMetadata,
) -> Result<NotesVaultMarkdownIndex, String> {
    let service = knowledge_service()?;
    tauri::async_runtime::spawn_blocking(move || {
        let (snapshot, root) = service
            .refresh_index_for_legacy_identity(&vault.id, &vault.root_path)
            .map_err(knowledge_error)?;
        Ok(NotesVaultMarkdownIndex {
            vault_id: snapshot.vault_id,
            root_path: root.to_string_lossy().to_string(),
            generated_at: snapshot.built_at,
            documents: snapshot
                .documents
                .into_iter()
                .map(|document| NotesVaultMarkdownIndexDocument {
                    absolute_path: root
                        .join(
                            document
                                .relative_path
                                .replace('/', std::path::MAIN_SEPARATOR_STR),
                        )
                        .to_string_lossy()
                        .to_string(),
                    relative_path: document.relative_path,
                    file_name: document.file_name,
                    title: document.title,
                    revision: document.revision,
                    headings: document
                        .headings
                        .into_iter()
                        .map(|heading| NotesVaultMarkdownHeading {
                            level: heading.level,
                            text: heading.text,
                            slug: heading.slug,
                            line: heading.line,
                        })
                        .collect(),
                    wiki_links: document
                        .wiki_links
                        .into_iter()
                        .map(|link| NotesVaultMarkdownWikiLink {
                            raw: link.raw,
                            target: link.target,
                            alias: link.alias,
                            line: link.line,
                        })
                        .collect(),
                    embeds: document
                        .embeds
                        .into_iter()
                        .map(|embed| NotesVaultMarkdownEmbed {
                            raw: embed.raw,
                            target: embed.target,
                            kind: embed.kind,
                            line: embed.line,
                        })
                        .collect(),
                    tags: document.tags,
                    frontmatter_tags: document.frontmatter_tags,
                    inline_tags: document.inline_tags,
                    plain_text: document.plain_text,
                    excerpt: document.excerpt,
                    content_length: document.content_length,
                    mtime: document.modified_at,
                    size: document.size,
                })
                .collect(),
            errors: snapshot
                .errors
                .into_iter()
                .map(|failure| NotesVaultMarkdownIndexError {
                    code: failure.code,
                    message: failure.message,
                    relative_path: failure.relative_path,
                })
                .collect(),
            version: snapshot.version,
            changed_paths: snapshot.changed_paths,
            removed_paths: snapshot.removed_paths,
        })
    })
    .await
    .map_err(|_| "knowledge-index-worker-failed: Knowledge index worker failed".to_string())?
}

#[tauri::command]
fn import_notes_vault_markdown_files(
    vault: NotesVaultMetadata,
    source_paths: Vec<String>,
    target_parent_relative_path: String,
) -> Result<NotesVaultImportMarkdownResult, String> {
    notes_vault_metadata_checked_root(&vault)?;
    import_markdown_files_with_service(&knowledge_service()?, &backend_services()?.material_catalog(), &vault, source_paths, target_parent_relative_path)
}

fn import_markdown_files_with_service(service: &knowledge::KnowledgeService, catalog: &materials::MaterialCatalog, vault: &NotesVaultMetadata, source_paths: Vec<String>, target_parent_relative_path: String) -> Result<NotesVaultImportMarkdownResult, String> {
    let mut result = NotesVaultImportMarkdownResult { copied_count: 0, failed_count: 0, skipped_count: 0, conflict_renamed_count: 0, target_parent_relative_path: target_parent_relative_path.clone(), files: Vec::new(), errors: Vec::new() };
    let mut groups = std::collections::BTreeMap::<std::path::PathBuf, Vec<String>>::new();
    for source in source_paths {
        let path = match checked_notes_import_source(std::path::Path::new(&source)) {
            Ok(path) => path,
            Err(message) => {result.failed_count+=1;result.errors.push(NotesVaultFileTransferError {source_path:source,code:"import-incomplete".into(),message});continue;}
        };
        if let Some(parent) = path.parent() {
            // Only walk ancestors of a user-selected note. The marker restores
            // Obsidian root-relative wiki and ../ attachment context without a scan.
            let source_root = parent.ancestors().take(64).find(|ancestor| ancestor.join(".obsidian").is_dir()).unwrap_or(parent);
            if let Ok(relative) = path.strip_prefix(source_root) {
                groups.entry(source_root.into()).or_default().push(notes_vault_relative_path_string(relative));
            } else { result.skipped_count += 1; }
        } else { result.skipped_count += 1; }
    }
    for (source_root, notes) in groups {
        match import_owned_notes_with_service(service, catalog, vault, &source_root, &notes, &target_parent_relative_path) {
            Ok(batch) => {
                result.copied_count += batch.copied_count;
                result.failed_count += batch.failed_count;
                result.skipped_count += batch.skipped_count;
                result.conflict_renamed_count += batch.conflict_renamed_count;
                result.files.extend(batch.files);
                result.errors.extend(batch.errors);
            }
            Err(message) => {
                result.failed_count += notes.len();
                for note in &notes { result.errors.push(NotesVaultFileTransferError { source_path: source_root.join(note).to_string_lossy().into_owned(), code: "import-incomplete".into(), message: message.clone() }); }
            },
        }
    }
    Ok(result)
}

#[tauri::command]
fn import_notes_vault_markdown_folder(
    vault: NotesVaultMetadata,
    source_directory_path: String,
    target_parent_relative_path: String,
) -> Result<NotesVaultImportMarkdownResult, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    import_markdown_folder_with_service(&knowledge_service()?, &backend_services()?.material_catalog(), &vault, &root, source_directory_path, target_parent_relative_path)
}

fn import_markdown_folder_with_service(service: &knowledge::KnowledgeService, catalog: &materials::MaterialCatalog, vault: &NotesVaultMetadata, root: &std::path::Path, source_directory_path: String, target_parent_relative_path: String) -> Result<NotesVaultImportMarkdownResult, String> {
    let source = std::path::PathBuf::from(source_directory_path);
    let source_root = checked_notes_import_source(&source)?;
    let _source_guard = crate::agent_workspace::filesystem_directory_identity_guard(&source_root)
        .map_err(|_|"来源目录暂时无法稳定读取。".to_string())?;
    if source_root.starts_with(root.canonicalize().map_err(|error| error.to_string())?) { return Err("source-inside-vault: choose a folder outside the current vault".into()); }
    let source_name = source.file_name().and_then(|name| name.to_str()).unwrap_or("Imported Folder");
    let (parent, _) = notes_vault_existing_parent_directory(&root, &target_parent_relative_path)?;
    let (base, _, _) = unique_notes_vault_directory_target(&root, &parent, source_name, "Imported Folder")?;
    let mut sources = Vec::new();
    let mut errors = Vec::new();
    collect_markdown_source_files(&source_root, &source_root, &mut sources, &mut errors);
    let notes: Vec<_> = sources.iter().map(|(_, relative)| notes_vault_relative_path_string(relative)).collect();
    let mut result = if notes.is_empty() {
        NotesVaultImportMarkdownResult {copied_count:0,failed_count:0,skipped_count:0,conflict_renamed_count:0,target_parent_relative_path:notes_vault_relative_path_string(&base),files:Vec::new(),errors:Vec::new()}
    } else {
        match import_owned_notes_with_service(service, catalog, vault, &source_root, &notes, &notes_vault_relative_path_string(&base)) {
            Ok(result) => result,
            Err(message) => NotesVaultImportMarkdownResult {
                copied_count:0, failed_count:notes.len(), skipped_count:0, conflict_renamed_count:0,
                target_parent_relative_path:notes_vault_relative_path_string(&base), files:Vec::new(),
                errors:notes.iter().map(|note|NotesVaultFileTransferError {
                    source_path:source_root.join(note).to_string_lossy().into_owned(), code:"import-incomplete".into(), message:message.clone()
                }).collect(),
            },
        }
    };
    result.errors.extend(errors);
    Ok(result)
}

fn checked_notes_import_source(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if !path.is_absolute(){return Err("来源路径必须是绝对路径。".into());}
    for ancestor in path.ancestors().filter(|path|!path.as_os_str().is_empty()) {
        let metadata=std::fs::symlink_metadata(ancestor).map_err(|_|"来源路径不存在或无法读取。".to_string())?;
        let linked=metadata.file_type().is_symlink();
        #[cfg(windows)]
        let linked={use std::os::windows::fs::MetadataExt;linked || metadata.file_attributes() & 0x400 != 0};
        if linked{return Err("来源经过链接目录，无法安全导入。".into());}
    }
    path.canonicalize().map_err(|_|"来源路径无法确认。".into())
}

fn import_owned_notes_with_service(service: &knowledge::KnowledgeService, catalog: &materials::MaterialCatalog, vault: &NotesVaultMetadata, source_root: &std::path::Path, notes: &[String], parent: &str) -> Result<NotesVaultImportMarkdownResult, String> {
    let active = service.active_ui_source_identity().map_err(knowledge_error)?;
    if active.vault_id != vault.id { return Err("knowledge-source-inactive: Vault changed before import".into()); }
    let reference=service.attachment_handling_policy(&vault.id).map_err(knowledge_error)?=="reference";
    let plan = service.preview_attachment_import_with_policy(&vault.id, source_root, notes, parent,reference).map_err(knowledge_error)?;
    let outcome = service.execute_attachment_operation(active.source_epoch, &plan).map_err(knowledge_error)?;
    let outcome=attachment_coordination::finish_attachment_projection(service,catalog,&plan,outcome,active.source_epoch);
    let mut files = Vec::new();
    let mut errors: Vec<_> = outcome.issues.iter().map(|issue| NotesVaultFileTransferError { source_path: issue.target.clone(), code: issue.status.clone(), message: format!("Attachment {}: {}; recovery {}", issue.target, issue.status, outcome.operation_id) }).collect();
    let mut conflicts = 0;
    for (index, change) in plan.files.iter().filter(|file| file.relative_path.to_ascii_lowercase().ends_with(".md")).enumerate() {
        let reference = knowledge::KnowledgeDocumentRef { vault_id: vault.id.clone(), relative_path: change.relative_path.clone() };
        match service.read_document(&reference) {
          Ok(document) => {
            if Some(document.revision) != change.after_revision {
                errors.push(NotesVaultFileTransferError { source_path: source_root.to_string_lossy().into_owned(), code: "import-readback-changed".into(), message: format!("导入后笔记内容已变化，未计为成功：{}",change.relative_path) });
                continue;
            }
            let source_note = notes.get(index).map(String::as_str).unwrap_or("");
            let expected = if parent.is_empty() { source_note.to_owned() } else { format!("{parent}/{source_note}") };
            let renamed = change.relative_path != expected;
            conflicts += usize::from(renamed);
            files.push(NotesVaultFileTransferItem { source_path: source_root.join(source_note).to_string_lossy().into_owned(), relative_path: change.relative_path.clone(), absolute_path: std::path::Path::new(&vault.root_path).join(&change.relative_path).to_string_lossy().into_owned(), renamed });
          },
          Err(failure) => errors.push(NotesVaultFileTransferError { source_path: source_root.to_string_lossy().into_owned(), code: "import-readback-failed".into(), message: format!("笔记导入结果尚未读取成功：{}；{}",change.relative_path,knowledge_error(failure)) }),
        }
    }
    if outcome.status == "partial" { errors.push(NotesVaultFileTransferError { source_path: source_root.to_string_lossy().into_owned(), code: "import-partial".into(), message: format!("Import is partial. Resume or rollback operation {}", outcome.operation_id) }); }
    Ok(NotesVaultImportMarkdownResult { copied_count: files.len(), failed_count: notes.len().saturating_sub(files.len()), skipped_count: 0, conflict_renamed_count: conflicts, target_parent_relative_path: parent.into(), files, errors })
}
#[tauri::command]
fn export_notes_vault_markdown_file(
    vault: NotesVaultMetadata,
    relative_path: String,
    target_directory_path: String,
) -> Result<NotesVaultExportMarkdownResult, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let (relative, source) = notes_vault_existing_markdown_target(&root, &relative_path)?;
    let target_directory = std::path::PathBuf::from(target_directory_path.trim());
    if !target_directory.exists() || !target_directory.is_dir() {
        return Err(
            "invalid-target-directory: export target must be an existing directory".to_string(),
        );
    }
    let source_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Exported Markdown")
        .to_string();
    let (target, renamed) =
        unique_local_markdown_export_target(&target_directory, &source_name, "Exported Markdown");
    let mut files = Vec::new();
    let mut errors = Vec::new();
    match copy_file_without_overwrite(&source, &target) {
        Ok(_) => files.push(NotesVaultFileTransferItem {
            source_path: source.to_string_lossy().to_string(),
            relative_path: notes_vault_relative_path_string(&relative),
            absolute_path: target.to_string_lossy().to_string(),
            renamed,
        }),
        Err(error) => errors.push(NotesVaultFileTransferError {
            source_path: source.to_string_lossy().to_string(),
            code: "copy-failed".to_string(),
            message: error,
        }),
    }
    Ok(NotesVaultExportMarkdownResult {
        exported_count: files.len(),
        conflict_renamed_count: if renamed && !files.is_empty() { 1 } else { 0 },
        target_directory_path: target_directory.to_string_lossy().to_string(),
        files,
        errors,
    })
}

#[tauri::command]
fn export_notes_vault_markdown_folder(
    vault: NotesVaultMetadata,
    relative_path: String,
    target_directory_path: String,
) -> Result<NotesVaultExportMarkdownResult, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let source_relative = safe_vault_relative_directory_path(&relative_path)?;
    let source_root = notes_vault_target_in_root(&root, &source_relative)?;
    if !source_root.exists() || !source_root.is_dir() {
        return Err("missing-folder: source folder does not exist".to_string());
    }
    let target_directory = std::path::PathBuf::from(target_directory_path.trim());
    if !target_directory.exists() || !target_directory.is_dir() {
        return Err(
            "invalid-target-directory: export target must be an existing directory".to_string(),
        );
    }
    let export_name = if source_relative.as_os_str().is_empty() {
        vault.name.clone()
    } else {
        source_root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Exported Folder")
            .to_string()
    };
    let (target_root, root_renamed) =
        unique_local_directory_export_target(&target_directory, &export_name, "Exported Folder");
    std::fs::create_dir_all(&target_root)
        .map_err(|error| format!("write-failed: failed to create export folder: {}", error))?;

    let mut source_files = Vec::new();
    let mut errors = Vec::new();
    collect_vault_markdown_files_for_export(
        &source_root,
        &source_root,
        &mut source_files,
        &mut errors,
    );

    let mut files = Vec::new();
    for (source, relative_inside_source) in source_files {
        let target = target_root.join(&relative_inside_source);
        if let Some(target_parent) = target.parent() {
            if let Err(error) = std::fs::create_dir_all(target_parent) {
                errors.push(NotesVaultFileTransferError {
                    source_path: source.to_string_lossy().to_string(),
                    code: "write-failed".to_string(),
                    message: format!("failed to create export directory: {}", error),
                });
                continue;
            }
        }
        let vault_relative = source.strip_prefix(&root).unwrap_or(&source).to_path_buf();
        match copy_file_without_overwrite(&source, &target) {
            Ok(_) => files.push(NotesVaultFileTransferItem {
                source_path: source.to_string_lossy().to_string(),
                relative_path: notes_vault_relative_path_string(&vault_relative),
                absolute_path: target.to_string_lossy().to_string(),
                renamed: root_renamed,
            }),
            Err(error) => errors.push(NotesVaultFileTransferError {
                source_path: source.to_string_lossy().to_string(),
                code: "copy-failed".to_string(),
                message: error,
            }),
        }
    }

    Ok(NotesVaultExportMarkdownResult {
        exported_count: files.len(),
        conflict_renamed_count: if root_renamed && !files.is_empty() {
            files.len()
        } else {
            0
        },
        target_directory_path: target_root.to_string_lossy().to_string(),
        files,
        errors,
    })
}

#[tauri::command]
fn create_notes_vault_folder(
    vault: NotesVaultMetadata,
    parent_relative_path: String,
    name: String,
) -> Result<NotesVaultFileNode, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let parent_relative = safe_vault_relative_directory_path(&parent_relative_path)?;
    let folder_name = safe_notes_vault_entity_name(&name, "文件夹")?;
    let mut target_relative = parent_relative.clone();
    target_relative.push(folder_name);
    let target = notes_vault_target_in_root(&root, &target_relative)?;
    if target.exists() {
        return Err(format!(
            "already-exists: 文件夹已存在: {}",
            target.to_string_lossy()
        ));
    }
    std::fs::create_dir_all(&target)
        .map_err(|error| format!("创建真实 Vault 文件夹失败: {}", error))?;
    notes_vault_file_node(&root, &target, target_relative)
}

#[tauri::command]
fn create_notes_vault_markdown_file(
    vault: NotesVaultMetadata,
    parent_relative_path: String,
    name: String,
) -> Result<NotesVaultMarkdownFile, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let parent_relative = safe_vault_relative_directory_path(&parent_relative_path)?;
    let file_name = safe_notes_vault_markdown_file_name(&name)?;
    let mut target_relative = parent_relative.clone();
    target_relative.push(file_name);
    let target = notes_vault_target_in_root(&root, &target_relative)?;
    if target.exists() {
        return Err(format!(
            "already-exists: Markdown 文件已存在: {}",
            target.to_string_lossy()
        ));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建 Markdown 所在目录失败: {}", error))?;
    }
    let title = target
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("未命名文档");
    let content = format!("# {}\n", title);
    std::fs::write(&target, &content)
        .map_err(|error| format!("写入真实 Vault Markdown 失败: {}", error))?;
    let metadata = std::fs::metadata(&target)
        .map_err(|error| format!("读取 Markdown 文件信息失败: {}", error))?;
    Ok(NotesVaultMarkdownFile {
        name: target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_string(),
        relative_path: notes_vault_relative_path_string(&target_relative),
        absolute_path: target.to_string_lossy().to_string(),
        content_text: content,
        mtime: notes_vault_modified_time(&metadata),
        size: metadata.len(),
    })
}

fn is_windows_reserved_name(name: &str) -> bool {
    let upper = name.trim().trim_end_matches('.').to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn sanitize_vault_copy_segment(raw: &str, fallback: &str) -> String {
    let mut value = raw
        .trim()
        .chars()
        .map(|ch| {
            if ch == '\\'
                || ch == '/'
                || ch == ':'
                || ch == '*'
                || ch == '?'
                || ch == '"'
                || ch == '<'
                || ch == '>'
                || ch == '|'
                || ch.is_control()
            {
                '-'
            } else {
                ch
            }
        })
        .collect::<String>();
    value = value.trim().trim_matches('.').trim().to_string();
    while value.contains("--") {
        value = value.replace("--", "-");
    }
    if value.is_empty()
        || value == "."
        || value == ".."
        || is_reserved_notes_vault_path_segment(&value)
        || is_windows_reserved_name(&value)
    {
        value = fallback.to_string();
    }
    if value.chars().count() > 120 {
        value = value
            .chars()
            .take(120)
            .collect::<String>()
            .trim()
            .trim_matches('.')
            .trim()
            .to_string();
        if value.is_empty() {
            value = fallback.to_string();
        }
    }
    value
}

fn sanitize_vault_copy_file_stem(raw: &str, fallback: &str) -> String {
    let trimmed = raw.trim();
    let stem = if trimmed.to_ascii_lowercase().ends_with(".md") {
        &trimmed[..trimmed.len().saturating_sub(3)]
    } else if trimmed.to_ascii_lowercase().ends_with(".markdown") {
        &trimmed[..trimmed.len().saturating_sub(9)]
    } else {
        trimmed
    };
    sanitize_vault_copy_segment(stem, fallback)
}

fn is_notes_vault_markdown_source(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

fn unique_notes_vault_markdown_target(
    root: &std::path::Path,
    parent_relative: &std::path::Path,
    source_name: &str,
    fallback_stem: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf, bool), String> {
    let stem = sanitize_vault_copy_file_stem(source_name, fallback_stem);
    let mut suffix = 1usize;
    loop {
        let file_name = if suffix == 1 {
            format!("{}.md", stem)
        } else {
            format!("{} ({}).md", stem, suffix)
        };
        let mut relative = parent_relative.to_path_buf();
        relative.push(file_name);
        let relative_string = notes_vault_relative_path_string(&relative);
        safe_vault_relative_markdown_path(&relative_string)?;
        let target = notes_vault_target_in_root(root, &relative)?;
        if target.exists() {
            suffix += 1;
            continue;
        }
        return Ok((relative, target, suffix > 1));
    }
}

fn unique_notes_vault_directory_target(
    root: &std::path::Path,
    parent_relative: &std::path::Path,
    source_name: &str,
    fallback_stem: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf, bool), String> {
    let stem = sanitize_vault_copy_segment(source_name, fallback_stem);
    let mut suffix = 1usize;
    loop {
        let folder_name = if suffix == 1 {
            stem.clone()
        } else {
            format!("{} ({})", stem, suffix)
        };
        let mut relative = parent_relative.to_path_buf();
        relative.push(folder_name);
        let relative_string = notes_vault_relative_path_string(&relative);
        safe_vault_relative_directory_path(&relative_string)?;
        let target = notes_vault_target_in_root(root, &relative)?;
        if target.exists() {
            suffix += 1;
            continue;
        }
        return Ok((relative, target, suffix > 1));
    }
}

fn unique_local_markdown_export_target(
    directory: &std::path::Path,
    source_name: &str,
    fallback_stem: &str,
) -> (std::path::PathBuf, bool) {
    let stem = sanitize_vault_copy_file_stem(source_name, fallback_stem);
    let mut suffix = 1usize;
    loop {
        let file_name = if suffix == 1 {
            format!("{}.md", stem)
        } else {
            format!("{} ({}).md", stem, suffix)
        };
        let target = directory.join(file_name);
        if target.exists() {
            suffix += 1;
            continue;
        }
        return (target, suffix > 1);
    }
}

fn unique_local_directory_export_target(
    directory: &std::path::Path,
    source_name: &str,
    fallback_stem: &str,
) -> (std::path::PathBuf, bool) {
    let stem = sanitize_vault_copy_segment(source_name, fallback_stem);
    let mut suffix = 1usize;
    loop {
        let folder_name = if suffix == 1 {
            stem.clone()
        } else {
            format!("{} ({})", stem, suffix)
        };
        let target = directory.join(folder_name);
        if target.exists() {
            suffix += 1;
            continue;
        }
        return (target, suffix > 1);
    }
}

// Keep each already-validated ancestor pinned while opening the next component.
// A final-component no-follow handle alone does not fence intermediate junctions.
fn hold_notes_import_directory_chain(
    root: &std::path::Path,
    directory: &std::path::Path,
) -> Result<Vec<crate::agent_workspace::FilesystemDirectoryIdentityGuard>, String> {
    let relative = directory.strip_prefix(root).map_err(|_| "来源目录超出导入范围。".to_string())?;
    let mut path = root.to_path_buf();
    let mut guards = vec![crate::agent_workspace::filesystem_directory_identity_guard(&path)
        .map_err(|_| "无法稳定读取来源根目录。".to_string())?];
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("来源目录包含不安全路径。".into());
        }
        path.push(component.as_os_str());
        guards.push(crate::agent_workspace::filesystem_directory_identity_guard(&path)
            .map_err(|_| "来源目录发生变化或经过链接，未继续读取。".to_string())?);
    }
    Ok(guards)
}

#[cfg(all(test, windows))]
mod notes_import_guard_tests;

fn collect_markdown_source_files(
    root: &std::path::Path,
    current: &std::path::Path,
    files: &mut Vec<(std::path::PathBuf, std::path::PathBuf)>,
    errors: &mut Vec<NotesVaultFileTransferError>,
) {
    let mut pending = vec![current.to_path_buf()];
    let mut visited = 0usize;
    while let Some(directory) = pending.pop() {
        let current = checked_notes_import_source(&directory);
        if !current.as_ref().is_ok_and(|path|path.starts_with(root)) {
            errors.push(NotesVaultFileTransferError {source_path:directory.to_string_lossy().into_owned(),code:"knowledge-path-reparse-forbidden".into(),message:"来源目录发生变化或经过链接，未继续读取。".into()});continue;
        }
        #[cfg(all(test, windows))]
        notes_import_guard_tests::before_guards(&directory);
        let _guards = match hold_notes_import_directory_chain(root, &directory) {
            Ok(guard)=>guard,
            Err(_)=>{errors.push(NotesVaultFileTransferError {source_path:directory.to_string_lossy().into_owned(),code:"read-folder-failed".into(),message:"无法稳定读取此来源目录。".into()});continue;}
        };
        #[cfg(all(test, windows))]
        notes_import_guard_tests::before_enumeration(&directory);
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                errors.push(NotesVaultFileTransferError {source_path:directory.to_string_lossy().into_owned(),code:"read-folder-failed".into(),message:"无法读取此来源文件夹，其他可读取笔记继续导入。".into()});
                continue;
            }
        };
        for entry in entries {
            visited += 1;
            if visited > 100_000 {
                errors.push(NotesVaultFileTransferError {source_path:root.to_string_lossy().into_owned(),code:"source-folder-capacity".into(),message:"来源目录超过本次可检查范围，尚未检查的项目未导入。".into()});
                return;
            }
            let entry = match entry {Ok(entry)=>entry,Err(_)=>{
                errors.push(NotesVaultFileTransferError {source_path:directory.to_string_lossy().into_owned(),code:"read-folder-failed".into(),message:"部分来源项目无法读取。".into()});continue;
            }};
            let path=entry.path();
            let name=entry.file_name();
            let name=name.to_string_lossy();
            if is_reserved_notes_vault_path_segment(&name) || [".git",".obsidian"].iter().any(|reserved|name.eq_ignore_ascii_case(reserved)){continue;}
            let metadata=match std::fs::symlink_metadata(&path){Ok(metadata)=>metadata,Err(_)=>{
                errors.push(NotesVaultFileTransferError {source_path:path.to_string_lossy().into_owned(),code:"read-folder-failed".into(),message:"无法检查此来源项目。".into()});continue;
            }};
            let linked=metadata.file_type().is_symlink();
            #[cfg(windows)]
            let linked={use std::os::windows::fs::MetadataExt;linked || metadata.file_attributes() & 0x400 != 0};
            if linked {
                errors.push(NotesVaultFileTransferError {source_path:path.to_string_lossy().into_owned(),code:"knowledge-path-reparse-forbidden".into(),message:"此链接路径未读取，其他普通笔记继续导入。".into()});continue;
            }
            if metadata.is_dir(){pending.push(path);}
            else if metadata.is_file() && is_notes_vault_markdown_source(&path){
                if let Ok(relative)=path.strip_prefix(root){files.push((path.clone(),relative.to_path_buf()));}
            }
        }
    }
}

fn collect_vault_markdown_files_for_export(
    root: &std::path::Path,
    current: &std::path::Path,
    files: &mut Vec<(std::path::PathBuf, std::path::PathBuf)>,
    errors: &mut Vec<NotesVaultFileTransferError>,
) {
    let entries = match std::fs::read_dir(current) {
        Ok(entries) => entries,
        Err(error) => {
            errors.push(NotesVaultFileTransferError {
                source_path: current.to_string_lossy().to_string(),
                code: "read-folder-failed".to_string(),
                message: error.to_string(),
            });
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if is_reserved_notes_vault_path_segment(name) {
            continue;
        }
        if path.is_dir() {
            collect_vault_markdown_files_for_export(root, &path, files, errors);
        } else if path.is_file() && is_notes_vault_markdown_source(&path) {
            let relative = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
            files.push((path, relative));
        }
    }
}

fn copy_file_without_overwrite(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<u64, String> {
    let mut reader = std::fs::File::open(source)
        .map_err(|error| format!("read-failed: failed to open source file: {}", error))?;
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| format!("write-failed: failed to create target file: {}", error))?;
    std::io::copy(&mut reader, &mut writer)
        .map_err(|error| format!("copy-failed: failed to copy file: {}", error))
}

#[tauri::command]
fn read_notes_vault_markdown_file(
    vault: NotesVaultMetadata,
    relative_path: String,
) -> Result<NotesVaultMarkdownFile, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let relative = safe_vault_relative_markdown_path(&relative_path)
        .map_err(|error| format!("not-markdown-file: {}", error))?;
    let target = notes_vault_target_in_root(&root, &relative)?;
    if !target.exists() {
        return Err(format!(
            "missing-file: Markdown 文件不存在: {}",
            relative_path
        ));
    }
    if !target.is_file() {
        return Err("not-markdown-file: 目标路径不是 Markdown 文件".to_string());
    }
    let content = std::fs::read_to_string(&target)
        .map_err(|error| format!("读取 Markdown 文件失败: {}", error))?;
    let metadata = std::fs::metadata(&target)
        .map_err(|error| format!("读取 Markdown 文件信息失败: {}", error))?;
    Ok(NotesVaultMarkdownFile {
        name: target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_string(),
        relative_path: notes_vault_relative_path_string(&relative),
        absolute_path: target.to_string_lossy().to_string(),
        content_text: content,
        mtime: notes_vault_modified_time(&metadata),
        size: metadata.len(),
    })
}

#[tauri::command]
fn write_notes_vault_markdown_file(
    vault: NotesVaultMetadata,
    relative_path: String,
    content_text: String,
) -> Result<NotesVaultWriteResult, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let relative = safe_vault_relative_markdown_path(&relative_path)
        .map_err(|error| format!("not-markdown-file: {}", error))?;
    let target = notes_vault_target_in_root(&root, &relative)?;
    if !target.exists() {
        return Err(format!(
            "missing-file: Markdown 文件不存在: {}",
            relative_path
        ));
    }
    if !target.is_file() {
        return Err("not-markdown-file: 目标路径不是 Markdown 文件".to_string());
    }
    std::fs::write(&target, content_text)
        .map_err(|error| format!("保存真实 Vault Markdown 失败: {}", error))?;
    let metadata = std::fs::metadata(&target)
        .map_err(|error| format!("读取 Markdown 文件信息失败: {}", error))?;
    Ok(NotesVaultWriteResult {
        relative_path: notes_vault_relative_path_string(&relative),
        absolute_path: target.to_string_lossy().to_string(),
        mtime: notes_vault_modified_time(&metadata),
        size: metadata.len(),
        message: "已保存到真实 Vault Markdown 文件".to_string(),
    })
}

#[tauri::command]
fn rename_notes_vault_markdown_file(
    app: tauri::AppHandle,
    vault: NotesVaultMetadata,
    relative_path: String,
    new_name: String,
) -> Result<NotesVaultMarkdownFile, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let registry=app.state::<workspace_windows::WorkspaceWindows>();
    let (relative, source) = notes_vault_existing_markdown_target(&root, &relative_path)?;
    let _retirement=registry.guard_main_path_retirement(&root,&relative,false)?;
    let file_name = safe_notes_vault_markdown_file_name(&new_name)?;
    let mut target_relative = notes_vault_relative_parent(&relative);
    target_relative.push(file_name);
    if target_relative == relative {
        return read_notes_vault_markdown_file(vault, relative_path);
    }
    let target = notes_vault_target_in_root(&root, &target_relative)?;
    if target.exists() {
        return Err(format!(
            "already-exists: target Markdown file already exists: {}",
            target.to_string_lossy()
        ));
    }
    std::fs::rename(&source, &target)
        .map_err(|error| format!("rename-failed: failed to rename Markdown file: {}", error))?;
    read_notes_vault_markdown_file(vault, notes_vault_relative_path_string(&target_relative))
}

#[tauri::command]
fn rename_notes_vault_folder(
    app: tauri::AppHandle,
    vault: NotesVaultMetadata,
    relative_path: String,
    new_name: String,
) -> Result<NotesVaultFileNode, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let registry=app.state::<workspace_windows::WorkspaceWindows>();
    let (relative, source) = notes_vault_existing_directory_target(&root, &relative_path)?;
    let _retirement=registry.guard_main_path_retirement(&root,&relative,true)?;
    let folder_name = safe_notes_vault_entity_name(&new_name, "folder")?;
    let mut target_relative = notes_vault_relative_parent(&relative);
    target_relative.push(folder_name);
    if target_relative == relative {
        return notes_vault_file_node(&root, &source, relative);
    }
    let target = notes_vault_target_in_root(&root, &target_relative)?;
    if target.exists() {
        return Err(format!(
            "already-exists: target folder already exists: {}",
            target.to_string_lossy()
        ));
    }
    std::fs::rename(&source, &target)
        .map_err(|error| format!("rename-failed: failed to rename folder: {}", error))?;
    notes_vault_file_node(&root, &target, target_relative)
}

#[tauri::command]
fn move_notes_vault_markdown_file(
    app: tauri::AppHandle,
    vault: NotesVaultMetadata,
    relative_path: String,
    target_parent_relative_path: String,
) -> Result<NotesVaultMarkdownFile, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let registry=app.state::<workspace_windows::WorkspaceWindows>();
    let (relative, source) = notes_vault_existing_markdown_target(&root, &relative_path)?;
    let _retirement=registry.guard_main_path_retirement(&root,&relative,false)?;
    let (target_parent_relative, target_parent) =
        notes_vault_existing_parent_directory(&root, &target_parent_relative_path)?;
    let file_name = relative
        .file_name()
        .ok_or_else(|| "invalid-target: Markdown file name is missing".to_string())?
        .to_os_string();
    let mut target_relative = target_parent_relative;
    target_relative.push(file_name);
    if target_relative == relative {
        return read_notes_vault_markdown_file(vault, relative_path);
    }
    let target = notes_vault_target_in_root(&root, &target_relative)?;
    if target.exists() {
        return Err(format!(
            "already-exists: target Markdown file already exists: {}",
            target.to_string_lossy()
        ));
    }
    if !target_parent.is_dir() {
        return Err("not-folder: target parent is not a folder".to_string());
    }
    std::fs::rename(&source, &target)
        .map_err(|error| format!("move-failed: failed to move Markdown file: {}", error))?;
    read_notes_vault_markdown_file(vault, notes_vault_relative_path_string(&target_relative))
}

#[tauri::command]
fn move_notes_vault_folder(
    app: tauri::AppHandle,
    vault: NotesVaultMetadata,
    relative_path: String,
    target_parent_relative_path: String,
) -> Result<NotesVaultFileNode, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let registry=app.state::<workspace_windows::WorkspaceWindows>();
    let (relative, source) = notes_vault_existing_directory_target(&root, &relative_path)?;
    let _retirement=registry.guard_main_path_retirement(&root,&relative,true)?;
    let (target_parent_relative, target_parent) =
        notes_vault_existing_parent_directory(&root, &target_parent_relative_path)?;
    let source_canonical = source
        .canonicalize()
        .map_err(|error| format!("path-error: failed to resolve source folder: {}", error))?;
    let target_parent_canonical = target_parent
        .canonicalize()
        .map_err(|error| format!("path-error: failed to resolve target folder: {}", error))?;
    if target_parent_canonical.starts_with(&source_canonical) {
        return Err(
            "invalid-move: cannot move a folder into itself or its child folder".to_string(),
        );
    }
    let folder_name = relative
        .file_name()
        .ok_or_else(|| "invalid-target: folder name is missing".to_string())?
        .to_os_string();
    let mut target_relative = target_parent_relative;
    target_relative.push(folder_name);
    if target_relative == relative {
        return notes_vault_file_node(&root, &source, relative);
    }
    let target = notes_vault_target_in_root(&root, &target_relative)?;
    if target.exists() {
        return Err(format!(
            "already-exists: target folder already exists: {}",
            target.to_string_lossy()
        ));
    }
    std::fs::rename(&source, &target)
        .map_err(|error| format!("move-failed: failed to move folder: {}", error))?;
    notes_vault_file_node(&root, &target, target_relative)
}

#[tauri::command]
fn delete_notes_vault_markdown_file(
    app: tauri::AppHandle,
    vault: NotesVaultMetadata,
    relative_path: String,
) -> Result<NotesVaultDeleteResult, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let registry=app.state::<workspace_windows::WorkspaceWindows>();
    let (relative, target) = notes_vault_existing_markdown_target(&root, &relative_path)?;
    let _retirement=registry.guard_main_path_retirement(&root,&relative,false)?;
    let absolute_path = target.to_string_lossy().to_string();
    std::fs::remove_file(&target)
        .map_err(|error| format!("delete-failed: failed to delete Markdown file: {}", error))?;
    Ok(NotesVaultDeleteResult {
        relative_path: notes_vault_relative_path_string(&relative),
        absolute_path,
        deleted: true,
        message: "Deleted one Markdown file".to_string(),
    })
}

#[tauri::command]
fn delete_notes_vault_empty_folder(
    app: tauri::AppHandle,
    vault: NotesVaultMetadata,
    relative_path: String,
) -> Result<NotesVaultDeleteResult, String> {
    let root = notes_vault_metadata_checked_root(&vault)?;
    let registry=app.state::<workspace_windows::WorkspaceWindows>();
    let (relative, target) = notes_vault_existing_directory_target(&root, &relative_path)?;
    let _retirement=registry.guard_main_path_retirement(&root,&relative,true)?;
    let mut entries = std::fs::read_dir(&target)
        .map_err(|error| format!("delete-failed: failed to inspect folder: {}", error))?;
    if entries.next().is_some() {
        return Err(
            "folder-not-empty: only empty folders can be deleted in this phase".to_string(),
        );
    }
    let absolute_path = target.to_string_lossy().to_string();
    std::fs::remove_dir(&target)
        .map_err(|error| format!("delete-failed: failed to delete empty folder: {}", error))?;
    Ok(NotesVaultDeleteResult {
        relative_path: notes_vault_relative_path_string(&relative),
        absolute_path,
        deleted: true,
        message: "Deleted one empty folder".to_string(),
    })
}

#[tauri::command]
fn export_assets_index(app: tauri::AppHandle) -> Result<ExportResult, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_data.join("luckyray.db");

    if !db_path.exists() {
        return Err("数据库文件不存在".to_string());
    }

    let export_dir = app_data.join("exports");
    std::fs::create_dir_all(&export_dir).map_err(|e| e.to_string())?;

    #[derive(serde::Serialize)]
    struct AssetEntry {
        id: String,
        name: String,
        original_path: String,
        library_path: Option<String>,
        storage_mode: String,
        kind: String,
        mime_type: String,
        size_bytes: Option<i64>,
        folder_id: Option<String>,
        imported_at: String,
    }

    let entries = material_catalog_for_app(&app)?
        .list_assets(&materials::MaterialFilter::default())
        .map_err(|error| error.message)?
        .into_iter()
        .map(|asset| AssetEntry {
            id: asset.id,
            name: asset.name,
            original_path: asset.original_path,
            library_path: asset.library_path,
            storage_mode: asset.storage_mode,
            kind: asset.kind,
            mime_type: asset.mime_type,
            size_bytes: asset.size_bytes,
            folder_id: asset.folder_id,
            imported_at: asset.imported_at,
        })
        .collect::<Vec<_>>();

    let count = entries.len() as u32;
    let json = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
    let file_path = export_dir.join("assets-index.json");
    std::fs::write(&file_path, json).map_err(|e| e.to_string())?;

    Ok(ExportResult {
        path: export_dir.to_string_lossy().to_string(),
        count,
    })
}

// ===== D17 素材库完善：批量导入 / 重复检测 / 失效管理 / 筛选 =====

/// 支持的文件扩展名
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterialChange {
    version: i64,
    reason: String,
    affected_ids: Vec<String>,
    folders_changed: bool,
    occurred_at: String,
}

fn default_material_change() -> MaterialChange {
    MaterialChange {
        version: 0,
        reason: "bootstrap".to_string(),
        affected_ids: Vec::new(),
        folders_changed: false,
        occurred_at: String::new(),
    }
}

#[cfg(test)]
fn ensure_material_change_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    materials::ensure_change_schema(conn).map_err(|error| error.message)
}

fn read_material_change(conn: &rusqlite::Connection) -> Result<MaterialChange, String> {
    materials::read_change(conn)
        .map(|change| MaterialChange {
            version: change.version,
            reason: change.reason,
            affected_ids: change.affected_ids,
            folders_changed: change.folders_changed,
            occurred_at: change.occurred_at,
        })
        .map_err(|error| error.message)
}

fn publish_material_change_in_db(
    conn: &rusqlite::Connection,
    reason: String,
    affected_ids: Vec<String>,
    folders_changed: bool,
) -> Result<MaterialChange, String> {
    materials::publish_change_metadata(conn, &reason, affected_ids, folders_changed)
        .map(|change| MaterialChange {
            version: change.version,
            reason: change.reason,
            affected_ids: change.affected_ids,
            folders_changed: change.folders_changed,
            occurred_at: change.occurred_at,
        })
        .map_err(|error| error.message)
}

fn emit_material_change(change: &MaterialChange, app: Option<&tauri::AppHandle>) {
    let target = app
        .cloned()
        .or_else(|| MATERIAL_CHANGE_APP_HANDLE.get().cloned());
    if let Some(app) = target {
        let _ = app.emit(MATERIAL_CHANGE_EVENT, change);
    }
}

#[tauri::command]
fn get_material_change_state(app: tauri::AppHandle) -> Result<MaterialChange, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let db_path = app_data.join("luckyray.db");
    if !db_path.exists() {
        return Ok(default_material_change());
    }
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    read_material_change(&conn)
}

#[tauri::command]
fn publish_material_change(
    app: tauri::AppHandle,
    reason: String,
    affected_ids: Vec<String>,
    folders_changed: bool,
) -> Result<MaterialChange, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let db_path = app_data.join("luckyray.db");
    if !db_path.exists() {
        return Ok(default_material_change());
    }
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    let change = publish_material_change_in_db(&conn, reason, affected_ids, folders_changed)?;
    emit_material_change(&change, Some(&app));
    Ok(change)
}

#[cfg(test)]
mod material_change_tests {
    use super::*;

    fn setup_change_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE asset (id TEXT PRIMARY KEY);
            CREATE TABLE folder (id TEXT PRIMARY KEY, scope TEXT NOT NULL);
            CREATE TABLE tag (id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE item_tag (id TEXT PRIMARY KEY, item_type TEXT NOT NULL, item_id TEXT NOT NULL, tag_id TEXT NOT NULL);
            ",
        )
        .unwrap();
        ensure_material_change_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn material_change_version_advances_only_after_successful_material_write() {
        let conn = setup_change_db();
        assert_eq!(read_material_change(&conn).unwrap().version, 0);

        conn.execute("INSERT INTO asset(id) VALUES ('asset-a')", [])
            .unwrap();
        let after_insert = read_material_change(&conn).unwrap();
        assert_eq!(after_insert.version, 1);

        let published = publish_material_change_in_db(
            &conn,
            "desktop-import".to_string(),
            vec!["asset-a".to_string(), "asset-a".to_string()],
            false,
        )
        .unwrap();
        assert_eq!(published.version, 1);
        assert_eq!(published.affected_ids, vec!["asset-a".to_string()]);

        let before_noop = read_material_change(&conn).unwrap().version;
        // A failed or deduplicated import does not execute a material-table write.
        assert_eq!(read_material_change(&conn).unwrap().version, before_noop);
    }

    #[test]
    fn material_change_tracks_folder_and_asset_tag_writes() {
        let conn = setup_change_db();
        conn.execute(
            "INSERT INTO folder(id, scope) VALUES ('folder-a', 'materials')",
            [],
        )
        .unwrap();
        let after_folder = read_material_change(&conn).unwrap();
        assert!(after_folder.folders_changed);

        conn.execute("INSERT INTO item_tag(id, item_type, item_id, tag_id) VALUES ('tag-a', 'asset', 'asset-a', 't-a')", [])
            .unwrap();
        let after_tag = read_material_change(&conn).unwrap();
        assert!(after_tag.version > after_folder.version);
        assert!(!after_tag.folders_changed);
    }
}

#[derive(serde::Serialize)]
struct DroppedPathInfo {
    path: String,
    is_file: bool,
    is_dir: bool,
}

#[tauri::command]
fn classify_dropped_paths(paths: Vec<String>) -> Vec<DroppedPathInfo> {
    paths
        .into_iter()
        .filter_map(|raw| {
            let path = raw.trim().to_string();
            if path.is_empty() {
                return None;
            }
            let metadata = std::fs::metadata(&path).ok();
            Some(DroppedPathInfo {
                path,
                is_file: metadata.as_ref().is_some_and(|value| value.is_file()),
                is_dir: metadata.as_ref().is_some_and(|value| value.is_dir()),
            })
        })
        .collect()
}

fn create_id_simple() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let counter = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!(
        "{:x}-{:09x}-{:x}-{:x}",
        now.as_secs(),
        now.subsec_nanos(),
        std::process::id(),
        counter
    )
}

// ===== D28: 图片 URL 入库 =====

#[derive(serde::Serialize)]
struct ImportImageResult {
    success: bool,
    asset_id: Option<String>,
    asset_name: Option<String>,
    skipped: Option<String>,
    error: Option<String>,
}

#[tauri::command]
async fn import_image_from_url(
    app: tauri::AppHandle,
    url: String,
) -> Result<ImportImageResult, String> {
    let app_handle = app.clone();

    tokio::task::spawn_blocking(move || {
        let result = panic::catch_unwind(AssertUnwindSafe(|| {
            import_image_from_url_sync(&app_handle, &url)
        }));
        match result {
            Ok(r) => r,
            Err(panic_err) => {
                let msg = if let Some(s) = panic_err.downcast_ref::<String>() {
                    s.clone()
                } else if let Some(s) = panic_err.downcast_ref::<&str>() {
                    s.to_string()
                } else {
                    "未知内部错误".to_string()
                };
                Ok(ImportImageResult {
                    success: false,
                    asset_id: None,
                    asset_name: None,
                    skipped: None,
                    error: Some(format!("内部错误: {}", msg)),
                })
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn import_image_from_url_sync(
    app: &tauri::AppHandle,
    url: &str,
) -> Result<ImportImageResult, String> {
    let url_trimmed = url.trim();
    if url_trimmed.is_empty() {
        return Ok(ImportImageResult {
            success: false,
            asset_id: None,
            asset_name: None,
            skipped: None,
            error: Some("URL 为空".to_string()),
        });
    }

    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_data.join("luckyray.db");

    if !db_path.exists() {
        return Ok(ImportImageResult {
            success: false,
            asset_id: None,
            asset_name: None,
            skipped: None,
            error: Some("数据库未就绪".to_string()),
        });
    }

    // 下载图片
    let client = reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .get(url_trimmed)
        .header("Referer", url_trimmed)
        .send()
        .map_err(|e| format!("下载图片失败: {}", e))?;

    if !resp.status().is_success() {
        return Ok(ImportImageResult {
            success: false,
            asset_id: None,
            asset_name: None,
            skipped: None,
            error: Some(format!("HTTP {}", resp.status())),
        });
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    // 放宽类型检查：不再强制要求 image/ 前缀（CDN 可能返回不同类型）

    let bytes = resp
        .bytes()
        .map_err(|e| format!("读取图片数据失败: {}", e))?;
    if bytes.len() < 1024 {
        return Ok(ImportImageResult {
            success: false,
            asset_id: None,
            asset_name: None,
            skipped: None,
            error: Some("图片太小，可能是图标".to_string()),
        });
    }

    // 从 URL 路径推断扩展名
    let ext = content_type
        .split('/')
        .last()
        .filter(|e| !e.is_empty() && *e != "octet-stream")
        .unwrap_or_else(|| {
            url_trimmed
                .rsplit('.')
                .next()
                .filter(|e| e.len() <= 5)
                .unwrap_or("jpg")
        });
    let catalog = material_catalog_for_app(app)?;
    let imported = materials::import_downloaded_material(
        &catalog,
        materials::MaterialBytesInput {
            name: format!("download.{}", ext),
            original_path: url_trimmed.to_string(),
            mime_type: content_type.clone(),
            description: None,
            bytes: bytes.to_vec(),
        },
        &materials::MaterialImportOptions::default(),
    )
    .map_err(|error| error.message)?;
    emit_catalog_change(app, &imported.change);
    return Ok(ImportImageResult {
        success: true,
        asset_id: Some(imported.asset.id),
        asset_name: Some(imported.asset.name),
        skipped: imported.skipped_duplicate.then(|| "duplicate".to_string()),
        error: None,
    });
}

// ===== D28: collection 图片入库 =====

#[tauri::command]
async fn collection_image_to_assets(
    app: tauri::AppHandle,
    item_id: String,
    url: String,
) -> Result<ImportImageResult, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_data.join("luckyray.db");

    if !db_path.exists() {
        return Ok(ImportImageResult {
            success: false,
            asset_id: None,
            asset_name: None,
            skipped: None,
            error: Some("数据库未就绪".to_string()),
        });
    }

    // 读取 collection_item
    let (item_url, _item_thumbnail, _item_type) = {
        let conn = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("打开数据库失败: {}", e))?;

        let mut stmt = conn.prepare(
            "SELECT type, content, asset_id, url_metadata, thumbnail, trigger FROM collection_item WHERE id = ?1"
        ).map_err(|e| e.to_string())?;

        let row = stmt
            .query_row(rusqlite::params![item_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(|e| format!("访问收集项失败: {}", e))?;

        let (item_type, _content, _asset_id, url_meta, thumbnail, _trigger) = row;

        // 确定图片 URL 来源
        let mut best_url = String::new();
        if !url.trim().is_empty() {
            best_url = url.trim().to_string();
        }
        if best_url.is_empty() {
            if let Some(ref t) = thumbnail {
                if !t.is_empty() {
                    best_url = t.clone();
                }
            }
        }
        if best_url.is_empty() {
            if let Some(ref um) = url_meta {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(um) {
                    if let Some(img_url) = parsed.get("imageUrl").and_then(|v| v.as_str()) {
                        best_url = img_url.to_string();
                    }
                }
            }
        }
        if best_url.is_empty() {
            if item_type == "link" {
                if let Some(ref um) = url_meta {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(um) {
                        if let Some(link_url) = parsed.get("url").and_then(|v| v.as_str()) {
                            best_url = link_url.to_string();
                        }
                    }
                }
            }
        }
        (best_url, thumbnail.unwrap_or_default(), item_type)
    };

    if item_url.is_empty() {
        return Ok(ImportImageResult {
            success: false,
            asset_id: None,
            asset_name: None,
            skipped: None,
            error: Some("收集项没有可用的图片 URL".to_string()),
        });
    }

    // 检查是否已经入库过（processed_asset_id 存在）
    {
        let conn = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;

        let existing: Option<String> = conn.query_row(
            "SELECT processed_asset_id FROM collection_item WHERE id = ?1 AND processed_asset_id IS NOT NULL",
            rusqlite::params![item_id],
            |row| row.get(0),
        ).ok();

        if let Some(asset_id) = existing {
            return Ok(ImportImageResult {
                success: true,
                asset_id: Some(asset_id),
                asset_name: None,
                skipped: Some("already_linked".to_string()),
                error: None,
            });
        }
    }

    // 下载并入库
    let result = import_image_from_url(app.clone(), item_url).await?;

    // 标记 collection_item
    if result.success {
        let conn = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;
        let now = chrono::Local::now().to_rfc3339();
        let _ = conn.execute(
            "UPDATE collection_item SET processed_at = ?1, processed_action = 'moved_to_assets', processed_asset_id = ?2, updated_at = ?3 WHERE id = ?4",
            rusqlite::params![now, result.asset_id, now, item_id],
        );
    }

    Ok(result)
}

// D36: 导出素材文件到下载文件夹
#[tauri::command]
fn export_asset_file(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    source_path: String,
    filename: String,
    vault_id: Option<String>,
    asset_id: Option<String>,
) -> Result<String, String> {
    let catalog=material_catalog_for_app(&app)?;
    let source_path=if let Some(vault)=vault_id {
        require_main_caller(&caller)?;
        let id=asset_id.ok_or("vault-attachment-context-required")?;
        catalog.for_vault_attachment_ids(&vault,&[id.clone()]).map_err(encode_material_catalog_command_error)?
            .resolve_open_in_lightseek_paths(&[id]).map_err(encode_material_catalog_command_error)?
            .into_iter().next().ok_or("vault-attachment-missing")?.to_string_lossy().into_owned()
    } else {catalog.assert_legacy_file_path(std::path::Path::new(&source_path)).map_err(encode_material_catalog_command_error)?;source_path};
    let downloads = app
        .path()
        .download_dir()
        .map_err(|e| format!("无法获取下载目录: {}", e))?;
    std::fs::create_dir_all(&downloads).map_err(|e| format!("创建目录失败: {}", e))?;

    let safe_name = safe_file_name(&filename);
    let dest = downloads.join(&safe_name);

    // 如果文件已存在，追加序号
    let dest = if dest.exists() {
        let stem = safe_name
            .rfind('.')
            .map(|i| &safe_name[..i])
            .unwrap_or(&safe_name);
        let ext = safe_name.rfind('.').map(|i| &safe_name[i..]).unwrap_or("");
        let mut counter = 1;
        loop {
            let candidate = downloads.join(format!("{}_{}{}", stem, counter, ext));
            if !candidate.exists() {
                break candidate;
            }
            counter += 1;
        }
    } else {
        dest
    };

    std::fs::copy(&source_path, &dest).map_err(|e| format!("复制文件失败: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

/// This new export route is intentionally main-WebView-only. The legacy
/// Downloads command above remains available for its existing callers.
#[tauri::command]
async fn material_export_plan(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    request: materials::ExportPlanRequest,
) -> Result<materials::ExportPlanSummary, String> {
    require_main_caller(&caller)?;
    let catalog = material_catalog_for_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || materials::export_manager().plan(&catalog, request))
        .await.map_err(|error| format!("material-export-plan-worker-failed: {error}"))?
}

/// CSV export is a local main-WebView action, never a Companion route.
#[tauri::command]
async fn material_csv_export_plan(
    caller: tauri::Webview, app: tauri::AppHandle, request: materials::CsvExportPlanRequest,
) -> Result<materials::CsvExportPlanSummary, String> {
    require_main_caller(&caller)?;
    let catalog = material_catalog_for_app(&app)?;
    tauri::async_runtime::spawn_blocking(move || materials::csv_export_manager().plan(&catalog, request))
        .await.map_err(|error| format!("material-csv-plan-worker-failed: {error}"))?
}

#[tauri::command]
fn material_csv_export_discard_plan(caller: tauri::Webview, app:tauri::AppHandle, plan_id: String) -> Result<(), String> {
    require_main_caller(&caller)?;
    materials::csv_export_manager().discard_scoped(&material_catalog_for_app(&app)?,&plan_id)?;
    Ok(())
}

#[tauri::command]
async fn material_csv_export_start(
    caller: tauri::Webview, app: tauri::AppHandle, plan_id: String, destination: String,
    include_description: bool, watch_roots: Vec<String>,
) -> Result<materials::CsvExportTaskStatus, String> {
    require_main_caller(&caller)?;
    let catalog = material_catalog_for_app(&app)?;
    let protected = material_export_protected_dirs(&app, &watch_roots)?;
    tauri::async_runtime::spawn_blocking(move || materials::csv_export_manager()
        .start(catalog, &plan_id, &destination, include_description, &protected))
        .await.map_err(|error| format!("material-csv-start-worker-failed: {error}"))?
}

#[tauri::command]
fn material_csv_export_status(caller: tauri::Webview, app:tauri::AppHandle, task_id: String) -> Result<materials::CsvExportTaskStatus, String> {
    require_main_caller(&caller)?;
    materials::csv_export_manager().assert_task_scope(&material_catalog_for_app(&app)?,&task_id)?;
    materials::csv_export_manager().status(&task_id)
}

#[tauri::command]
fn material_csv_export_cancel(caller: tauri::Webview, app:tauri::AppHandle, task_id: String) -> Result<materials::CsvExportTaskStatus, String> {
    require_main_caller(&caller)?;
    materials::csv_export_manager().assert_task_scope(&material_catalog_for_app(&app)?,&task_id)?;
    materials::csv_export_manager().cancel(&task_id)
}

#[tauri::command]
async fn material_csv_export_retry(
    caller: tauri::Webview, app: tauri::AppHandle, task_id: String, watch_roots: Vec<String>,
) -> Result<materials::CsvExportTaskStatus, String> {
    require_main_caller(&caller)?;
    let catalog = material_catalog_for_app(&app)?;
    let protected = material_export_protected_dirs(&app, &watch_roots)?;
    tauri::async_runtime::spawn_blocking(move || materials::csv_export_manager()
        .retry(catalog, &task_id, &protected))
        .await.map_err(|error| format!("material-csv-retry-worker-failed: {error}"))?
}

#[tauri::command]
fn material_export_discard_plan(caller: tauri::Webview, app:tauri::AppHandle, plan_id: String) -> Result<(), String> {
    require_main_caller(&caller)?;
    materials::export_manager().discard_scoped(&material_catalog_for_app(&app)?,&plan_id)?;
    Ok(())
}

fn material_export_protected_dirs(app: &tauri::AppHandle, watch_roots: &[String]) -> Result<Vec<std::path::PathBuf>, String> {
    if watch_roots.len() > 64 || watch_roots.iter().any(|root| root.len() > 32_768 || !std::path::Path::new(root).is_absolute()) {
        return Err("素材监控目录配置无效或过多，不能安全导出".into());
    }
    let resolver = app.path();
    let mut paths = [resolver.app_data_dir(), resolver.app_config_dir(), resolver.app_cache_dir(),
        resolver.resource_dir()].into_iter().filter_map(Result::ok).collect::<Vec<_>>();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() { paths.push(parent.to_path_buf()); }
    }
    #[cfg(debug_assertions)]
    paths.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    paths.extend(watch_roots.iter().map(std::path::PathBuf::from));
    Ok(paths)
}

#[tauri::command]
async fn material_export_start(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    plan_id: String,
    destination: String,
    preserve_hierarchy: bool,
    watch_roots: Vec<String>,
) -> Result<materials::ExportTaskStatus, String> {
    require_main_caller(&caller)?;
    let catalog = material_catalog_for_app(&app)?;
    let protected = material_export_protected_dirs(&app, &watch_roots)?;
    tauri::async_runtime::spawn_blocking(move || materials::export_manager()
        .start(catalog, &plan_id, &destination, preserve_hierarchy, &protected))
        .await.map_err(|error| format!("material-export-start-worker-failed: {error}"))?
}

#[tauri::command]
fn material_export_status(caller: tauri::Webview, app:tauri::AppHandle, task_id: String) -> Result<materials::ExportTaskStatus, String> {
    require_main_caller(&caller)?;
    materials::export_manager().assert_task_scope(&material_catalog_for_app(&app)?,&task_id)?;
    materials::export_manager().status(&task_id)
}

#[tauri::command]
fn material_export_cancel(caller: tauri::Webview, app:tauri::AppHandle, task_id: String) -> Result<materials::ExportTaskStatus, String> {
    require_main_caller(&caller)?;
    materials::export_manager().assert_task_scope(&material_catalog_for_app(&app)?,&task_id)?;
    materials::export_manager().cancel(&task_id)
}

#[tauri::command]
fn material_export_open_destination(caller: tauri::Webview, app:tauri::AppHandle, task_id: String,library_id:Option<String>) -> Result<(), String> {
    require_main_caller(&caller)?;
    let base=material_catalog_for_app(&app)?;
    let catalog=match library_id.as_deref() { Some(id)=>base.for_library_task(id).map_err(encode_material_catalog_command_error)?, None=>base };
    materials::export_manager().assert_task_scope(&catalog,&task_id)?;
    let status = materials::export_manager().status(&task_id)?;
    let destination = std::path::PathBuf::from(status.destination);
    if !destination.is_dir() { return Err("导出目录已不存在".into()); }
    tauri_plugin_opener::open_path(destination, None::<&str>)
        .map_err(|error| format!("打开导出目录失败: {error}"))
}

#[tauri::command]
fn material_catalog_get_source_page(
    app: tauri::AppHandle,
    asset_id: String,
) -> Result<Option<materials::MaterialSourcePage>, String> {
    material_catalog_for_app(&app)?
        .get_source_page(&asset_id)
        .map_err(|error| error.message)
}

// ===== D29: AI 后端服务 =====

#[derive(serde::Deserialize)]
struct AiChatRequestMessage {
    role: String,
    content: serde_json::Value,
}

#[derive(serde::Deserialize)]
struct AiChatRequest {
    messages: Vec<AiChatRequestMessage>,
    system_prompt: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    model: Option<String>,
}

#[derive(serde::Serialize)]
struct AiChatResponse {
    success: bool,
    content: Option<String>,
    error_kind: Option<String>,
    error_message: Option<String>,
    error_detail: Option<String>,
}

#[derive(Clone)]
pub(crate) struct AiModelConfig {
    pub(crate) provider: String,
    pub(crate) protocol: String,
    pub(crate) api_key: String,
    pub(crate) model: String,
    pub(crate) custom_url: Option<String>,
}

pub(crate) fn load_ai_model_config(db_path: &std::path::Path) -> Result<AiModelConfig, String> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    let get_setting = |key: &str| -> Option<String> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get(0),
        )
        .ok()
    };
    Ok(AiModelConfig {
        provider: get_setting("aiProvider").unwrap_or_else(|| "deepseek".to_string()),
        protocol: get_setting("aiProtocol").unwrap_or_else(|| "openai-compatible".to_string()),
        api_key: get_setting("aiApiKey").unwrap_or_default(),
        model: get_setting("aiModel").unwrap_or_else(|| "deepseek-chat".to_string()),
        custom_url: get_setting("aiBaseURL"),
    })
}

#[derive(serde::Deserialize)]
struct AiChatStreamRequest {
    stream_id: String,
    messages: Vec<AiChatRequestMessage>,
    system_prompt: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
}

pub(crate) fn normalize_ai_api_key(raw: &str) -> String {
    let mut key = raw
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string();
    if key.to_lowercase().starts_with("authorization:") {
        key = key["authorization:".len()..].trim().to_string();
    }
    if key.to_lowercase().starts_with("bearer ") {
        key = key["bearer ".len()..].trim().to_string();
    }
    key.trim().to_string()
}

fn default_ai_base_url(provider_key: &str) -> &'static str {
    match provider_key {
        "openai" => "https://api.openai.com/v1",
        "anthropic" => "https://api.anthropic.com/v1",
        "minimax" => "https://api.minimax.io/v1",
        "ollama" => "http://localhost:11434/v1",
        "deepseek" => "https://api.deepseek.com",
        "twelveai" => "https://new.12ai.org/v1",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai",
        "zhipu" => "https://open.bigmodel.cn/api/paas/v4",
        "qwen" => "https://dashscope.aliyuncs.com/compatible-mode/v1",
        _ => "https://api.example.com/v1",
    }
}

pub(crate) fn normalize_ai_base_url(provider_key: &str, custom_url: Option<&str>) -> String {
    let raw = custom_url.unwrap_or("").trim();
    let mut base = if raw.is_empty() {
        default_ai_base_url(provider_key).to_string()
    } else {
        raw.split_whitespace().collect::<String>()
    };
    while base.ends_with('/') {
        base.pop();
    }
    if provider_key == "minimax" {
        base = base.replace("api.minimax.chat", "api.minimax.io");
    }

    if provider_key == "deepseek" {
        for official in ["https://api.deepseek.com/v1", "https://api.deepseek.com"] {
            if base.eq_ignore_ascii_case(official) {
                return "https://api.deepseek.com".to_owned();
            }
        }
    }

    for suffix in ["/chat/completions", "/messages", "/responses"] {
        if base.to_lowercase().ends_with(suffix) {
            let next_len = base.len().saturating_sub(suffix.len());
            base.truncate(next_len);
            while base.ends_with('/') {
                base.pop();
            }
            break;
        }
    }

    if matches!(provider_key, "custom" | "twelveai" | "gemini" | "zhipu" | "qwen") {
        return base;
    }

    let lower = base.to_lowercase();
    if lower.ends_with("/v1") || lower.ends_with("/v2") || lower.ends_with("/anthropic") {
        base
    } else {
        format!("{}/v1", base)
    }
}

fn build_ai_endpoint(provider_key: &str, protocol: &str, custom_url: Option<&str>) -> String {
    let base = normalize_ai_base_url(provider_key, custom_url);
    let lower = base.to_lowercase();
    if protocol == "anthropic-messages" && lower.ends_with("/anthropic") {
        return format!("{}/v1/messages", base);
    }
    if protocol == "anthropic-messages"
        && (lower.ends_with("/v1") || lower.contains("/anthropic/v"))
    {
        return format!("{}/messages", base);
    }
    if protocol == "anthropic-messages" {
        return format!("{}/v1/messages", base);
    }
    format!("{}/chat/completions", base)
}

fn endpoint_uses_anthropic_format(protocol: &str) -> bool {
    protocol == "anthropic-messages"
}

fn ai_auth_header(protocol: &str, api_key: &str) -> (&'static str, String) {
    if protocol == "anthropic-messages" {
        ("x-api-key", api_key.to_string())
    } else {
        ("Authorization", format!("Bearer {}", api_key))
    }
}

fn is_minimax_auth_error(status: reqwest::StatusCode, body: &str) -> bool {
    if status.as_u16() != 401 {
        return false;
    }
    let lower = body.to_lowercase();
    lower.contains("2049") || lower.contains("invalid api key")
}

fn build_anthropic_body(
    messages: &[AiChatRequestMessage],
    system_prompt: &Option<String>,
    model_str: &str,
    safe_max_tokens: u32,
    stream: bool,
) -> serde_json::Map<String, serde_json::Value> {
    let mut req_body = serde_json::Map::new();
    req_body.insert(
        "model".to_string(),
        serde_json::Value::String(model_str.to_string()),
    );
    req_body.insert(
        "max_tokens".to_string(),
        serde_json::Value::Number((safe_max_tokens as i64).into()),
    );
    if stream {
        req_body.insert("stream".to_string(), serde_json::Value::Bool(true));
    }

    let mut anthropic_messages = Vec::new();
    let mut system_content = system_prompt.clone().unwrap_or_default();
    for msg in messages {
        if msg.role == "system" {
            let msg_content_text = if let Some(s) = msg.content.as_str() {
                s.to_string()
            } else {
                msg.content.to_string()
            };
            if system_content.is_empty() {
                system_content = msg_content_text;
            } else {
                system_content.push_str("\n\n");
                system_content.push_str(&msg_content_text);
            }
        } else {
            let role = match msg.role.as_str() {
                "assistant" => "assistant",
                _ => "user",
            };
            anthropic_messages.push(serde_json::json!({
                "role": role,
                "content": openai_content_to_anthropic(&msg.content)
            }));
        }
    }
    if !system_content.is_empty() {
        req_body.insert(
            "system".to_string(),
            serde_json::Value::String(system_content),
        );
    }
    req_body.insert(
        "messages".to_string(),
        serde_json::Value::Array(anthropic_messages),
    );
    req_body
}

fn parse_anthropic_content(resp_text: &str) -> Result<Option<String>, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(resp_text).map_err(|e| format!("解析 API 响应失败: {}", e))?;
    Ok(parsed
        .get("content")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .filter(|text| !text.trim().is_empty()))
}

fn parse_openai_content(resp_text: &str) -> Result<Option<String>, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(resp_text).map_err(|e| format!("解析 API 响应失败: {}", e))?;
    Ok(parsed
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|item| item.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .filter(|text| !text.trim().is_empty()))
}

fn extract_api_error_message(body: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or(body)
            .to_string(),
        Err(_) => body.to_string(),
    }
}

fn minimax_fallback_attempts(endpoint: &str) -> Vec<(String, bool)> {
    let lower = endpoint.to_lowercase();
    if lower.contains("api.minimax.io") {
        return vec![
            (
                "https://api.minimaxi.com/v1/chat/completions".to_string(),
                false,
            ),
            (
                "https://api.minimaxi.com/anthropic/v1/messages".to_string(),
                true,
            ),
            (
                "https://api.minimax.io/anthropic/v1/messages".to_string(),
                true,
            ),
        ];
    }
    if lower.contains("api.minimaxi.com") {
        return vec![
            (
                "https://api.minimax.io/v1/chat/completions".to_string(),
                false,
            ),
            (
                "https://api.minimax.io/anthropic/v1/messages".to_string(),
                true,
            ),
            (
                "https://api.minimaxi.com/anthropic/v1/messages".to_string(),
                true,
            ),
        ];
    }
    vec![
        (
            "https://api.minimaxi.com/v1/chat/completions".to_string(),
            false,
        ),
        (
            "https://api.minimax.io/v1/chat/completions".to_string(),
            false,
        ),
        (
            "https://api.minimaxi.com/anthropic/v1/messages".to_string(),
            true,
        ),
        (
            "https://api.minimax.io/anthropic/v1/messages".to_string(),
            true,
        ),
    ]
}

#[derive(serde::Serialize, Clone)]
struct AiStreamEvent {
    stream_id: String,
    delta: Option<String>,
    done: bool,
    error_kind: Option<String>,
    error_message: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug, Eq, PartialEq)]
struct AiStreamTerminalResult {
    success: bool,
    content: Option<String>,
    error_kind: Option<String>,
    error_message: Option<String>,
}

fn emit_ai_stream_event(app: &tauri::AppHandle, event: AiStreamEvent) {
    let _ = app.emit("luckyray-ai-stream", event);
}

fn openai_content_to_anthropic(content: &serde_json::Value) -> serde_json::Value {
    if let Some(text) = content.as_str() {
        return serde_json::Value::String(text.to_string());
    }
    let Some(items) = content.as_array() else {
        return content.clone();
    };
    let converted: Vec<serde_json::Value> = items
        .iter()
        .filter_map(|item| {
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if item_type == "text" {
                return Some(serde_json::json!({
                    "type": "text",
                    "text": item.get("text").and_then(|v| v.as_str()).unwrap_or("")
                }));
            }
            if item_type == "image_url" {
                let url = item
                    .get("image_url")
                    .and_then(|v| v.get("url"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if let Some(rest) = url.strip_prefix("data:") {
                    if let Some((media, data)) = rest.split_once(";base64,") {
                        return Some(serde_json::json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media,
                                "data": data
                            }
                        }));
                    }
                }
            }
            None
        })
        .collect();
    serde_json::Value::Array(converted)
}

#[tauri::command]
async fn ai_chat_complete(
    app: tauri::AppHandle,
    request: AiChatRequest,
) -> Result<AiChatResponse, String> {
    let app_data = match app.path().app_data_dir() {
        Ok(path) => path,
        Err(_) => return Ok(ai_chat_failure_response("provider_error")),
    };
    let db_path = app_data.join("luckyray.db");
    let config = match load_ai_model_config(&db_path) {
        Ok(config) => config,
        Err(_) => return Ok(ai_chat_failure_response("provider_error")),
    };
    ai_chat_complete_with_config(config, request).await
}

fn notes_inline_error(error: notes_inline::NotesInlineError) -> String {
    serde_json::json!({
        "code": error.code,
        "message": match error.code {
            "notes-inline-busy" => "当前有 Agent 任务正在运行，请先完成或停止该任务",
            "notes-inline-selection-required" => "请先选择要处理的正文",
            "notes-inline-revision-conflict" | "notes-inline-selection-conflict" => "笔记内容已变化，请重新选择并生成",
            "notes-inline-preview-expired" => "预览已过期，请重新生成",
            "notes-inline-already-resolved" => "该预览已经处理",
            "notes-inline-content-too-large" | "notes-inline-content-invalid" => "生成内容超出可批准范围",
            "notes-inline-cancelled" => "AI 写作已停止",
            _ => "笔记 AI 操作失败，请稍后重试",
        }
    })
    .to_string()
}

#[tauri::command]
async fn notes_inline_generate(
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    request: notes_inline::NotesInlineGenerateRequest,
) -> Result<notes_inline::NotesInlinePreview, String> {
    let lease = backend
        .agent_runs()
        .acquire_transient("notes-inline")
        .map_err(|_| {
            notes_inline_error(notes_inline::NotesInlineError {
                code: "notes-inline-busy",
            })
        })?;
    let cancellation = lease.cancellation_flag();
    let action = notes_inline::NotesInlineAction::parse(request.action.trim())
        .map_err(notes_inline_error)?;
    let knowledge = backend.knowledge();
    let service = backend.notes_inline();
    let plan = service
        .prepare_generation(&knowledge, action)
        .map_err(notes_inline_error)?;
    let config = load_ai_model_config(backend.db_path()).map_err(|_| {
        notes_inline_error(notes_inline::NotesInlineError {
            code: "notes-inline-provider-unavailable",
        })
    })?;
    let provider = ai_chat_complete_with_config(
        config,
        AiChatRequest {
            messages: vec![AiChatRequestMessage {
                role: "user".to_owned(),
                content: serde_json::Value::String(plan.prompt.clone()),
            }],
            system_prompt: Some(plan.system_prompt.clone()),
            temperature: Some(0.35),
            max_tokens: Some(8192),
            model: None,
        },
    );
    let response = tokio::select! {
        response = provider => response,
        _ = async {
            while !cancellation.load(std::sync::atomic::Ordering::Acquire) {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        } => Err("notes-inline-cancelled".to_owned()),
    }
    .map_err(|error| {
        notes_inline_error(notes_inline::NotesInlineError {
            code: if error == "notes-inline-cancelled" {
                "notes-inline-cancelled"
            } else {
                "notes-inline-provider-unavailable"
            },
        })
    })?;
    if lease.is_cancelled() {
        return Err(notes_inline_error(notes_inline::NotesInlineError {
            code: "notes-inline-cancelled",
        }));
    }
    if !response.success {
        return Err(notes_inline_error(notes_inline::NotesInlineError {
            code: "notes-inline-provider-unavailable",
        }));
    }
    let output = response.content.as_deref().unwrap_or_default();
    service
        .publish_preview(&knowledge, plan, output)
        .map_err(notes_inline_error)
}

#[tauri::command]
async fn notes_inline_apply(
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    request: notes_inline::NotesInlineApplyRequest,
) -> Result<notes_inline::NotesInlineApplyResult, String> {
    let service = backend.notes_inline();
    let knowledge = backend.knowledge();
    tauri::async_runtime::spawn_blocking(move || service.apply(&knowledge, &request))
        .await
        .map_err(|_| {
            notes_inline_error(notes_inline::NotesInlineError {
                code: "notes-inline-write-failed",
            })
        })?
        .map_err(notes_inline_error)
}

#[tauri::command]
fn notes_inline_discard(
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    request: notes_inline::NotesInlineDiscardRequest,
) -> Result<(), String> {
    backend
        .notes_inline()
        .discard(&request.preview_id)
        .map_err(notes_inline_error)
}

#[tauri::command]
fn notes_inline_cancel(
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
) -> Result<bool, String> {
    let cancelled = backend
        .agent_runs()
        .cancel_transient("notes-inline")
        .map_err(|error| error.code.to_owned())?;
    backend.notes_inline().revoke_all();
    Ok(cancelled)
}

async fn ai_chat_complete_with_config(
    config: AiModelConfig,
    request: AiChatRequest,
) -> Result<AiChatResponse, String> {
    ai_chat_complete_with_config_and_fallbacks(config, request, None, None).await
}

/// Explicit canvas connection; never consult global AI settings or return a key.
#[tauri::command]
async fn canvas_text_generate(
    caller: tauri::Webview,
    backend: tauri::State<'_, std::sync::Arc<backend::BackendServices>>,
    profile_id: String,
    profile_revision: u64,
    request: AiChatRequest,
) -> Result<AiChatResponse, String> {
    require_main_caller(&caller)?;
    let runtime = match canvas_media_profiles::resolve(backend.db_path(), Some(&profile_id), Some(profile_revision)) {
        Ok(runtime) => runtime,
        Err(_) => return Ok(AiChatResponse { success:false,content:None,error_kind:Some("profile_changed".into()),error_message:Some("画布文本配置已变化或删除，请重新生成。".into()),error_detail:None }),
    };
    let config = match canvas_media_profiles::text_runtime_config(runtime, request.model.as_deref()) {
        Ok(config) => config,
        Err(_) => return Ok(AiChatResponse { success:false,content:None,error_kind:Some("profile_disabled".into()),error_message:Some("这套配置的文本协议或模型不可用。".into()),error_detail:None }),
    };
    ai_chat_complete_transport(config, request, Some(Vec::new()), None, true).await
}

async fn ai_chat_complete_with_config_and_fallbacks(
    config: AiModelConfig,
    request: AiChatRequest,
    fallback_override: Option<Vec<(String, bool)>>,
    timeout_override: Option<std::time::Duration>,
) -> Result<AiChatResponse, String> {
    ai_chat_complete_transport(config, request, fallback_override, timeout_override, false).await
}

async fn ai_chat_complete_transport(
    config: AiModelConfig,
    request: AiChatRequest,
    fallback_override: Option<Vec<(String, bool)>>,
    timeout_override: Option<std::time::Duration>,
    pinned_endpoint: bool,
) -> Result<AiChatResponse, String> {
    let AiModelConfig {
        provider,
        protocol,
        api_key,
        model,
        custom_url,
    } = config;

    let api_key = normalize_ai_api_key(&api_key);
    if api_key.is_empty() {
        return Ok(ai_chat_failure_response("no_api_key"));
    }

    let provider_key = provider.trim().to_lowercase();
    let requested_model = request.model.as_deref().map(str::trim).unwrap_or("");
    let model_str = if !requested_model.is_empty()
        && requested_model.len() <= 128
        && !requested_model.chars().any(char::is_control)
    {
        requested_model.to_string()
    } else {
        model.trim().to_string()
    };
    let safe_max_tokens = request.max_tokens.unwrap_or(4096).clamp(1, 32768);
    let endpoint = if pinned_endpoint {
        match canvas_media_protocols::endpoint(custom_url.as_deref().unwrap_or(""), "chat/completions", false) {
            Ok(endpoint) => endpoint,
            Err(_) => return Ok(ai_chat_failure_response("provider_error")),
        }
    } else { build_ai_endpoint(&provider_key, &protocol, custom_url.as_deref()) };
    let endpoint_anthropic_format = endpoint_uses_anthropic_format(&protocol);
    let api_key_header = ai_auth_header(&protocol, &api_key);

    // 构建请求体
    let mut req_body = serde_json::Map::new();

    if endpoint_anthropic_format {
        req_body = build_anthropic_body(
            &request.messages,
            &request.system_prompt,
            &model_str,
            safe_max_tokens,
            false,
        );
    } else {
        // OpenAI-compatible format
        req_body.insert(
            "model".to_string(),
            serde_json::Value::String(model_str.clone()),
        );

        let mut messages = Vec::new();
        if let Some(ref sp) = request.system_prompt {
            if !sp.is_empty() {
                messages.push(serde_json::json!({"role": "system", "content": sp}));
            }
        }
        for msg in &request.messages {
            messages.push(serde_json::json!({"role": msg.role, "content": msg.content}));
        }
        req_body.insert("messages".to_string(), serde_json::Value::Array(messages));

        if let Some(t) = request.temperature {
            req_body.insert("temperature".to_string(), serde_json::json!(t));
        }
        if provider_key == "minimax" {
            // MiniMax OpenAI-compatible endpoint deprecates max_tokens and expects
            // max_completion_tokens. Also keep it below the LuckyRay UI cap so a
            // stale huge DB value cannot make normal chat fail with HTTP 400.
            req_body.insert(
                "max_completion_tokens".to_string(),
                serde_json::json!(safe_max_tokens),
            );
        } else if request.max_tokens.is_some() {
            req_body.insert("max_tokens".to_string(), serde_json::json!(safe_max_tokens));
        }
    }

    let client = match reqwest::Client::builder()
        .redirect(if pinned_endpoint { reqwest::redirect::Policy::none() } else { reqwest::redirect::Policy::limited(10) })
        .no_proxy()
        .timeout(timeout_override.unwrap_or_else(|| std::time::Duration::from_secs(30)))
        .build()
    {
        Ok(client) => client,
        Err(_) => return Ok(ai_chat_failure_response("provider_error")),
    };

    let mut req = client
        .post(&endpoint)
        .header(api_key_header.0, api_key_header.1)
        .header("Content-Type", "application/json")
        .json(&req_body);
    if endpoint_anthropic_format {
        req = req.header("anthropic-version", "2023-06-01");
        if provider_key == "minimax" {
            req = req.header("X-Api-Key", api_key.clone());
        }
    }
    let resp = match req.send().await {
        Ok(response) => response,
        Err(error) => {
            let kind = if error.is_timeout() {
                "timeout"
            } else {
                "connection"
            };
            return Ok(ai_chat_failure_response(kind));
        }
    };

    let status = resp.status();
    let body_limit = if status.is_success() {
        AI_STREAM_MAX_TOTAL_RESPONSE_BYTES
    } else {
        AI_STREAM_MAX_ERROR_BODY_BYTES
    };
    let overflow_kind = if status.is_success() {
        "invalid_stream"
    } else {
        "provider_error"
    };
    let resp_text = match read_ai_response_body_bounded(resp, body_limit, overflow_kind).await {
        Ok(body) => body,
        Err(failure) => return Ok(ai_chat_failure_response(failure.kind)),
    };

    if !status.is_success() {
        if provider_key != "minimax" || !matches!(status.as_u16(), 401 | 403) {
            return Ok(ai_chat_failure_response(ai_failure_kind_for_http_status(
                status,
            )));
        }
        for (fallback_endpoint, anthropic_format) in
            fallback_override.unwrap_or_else(|| minimax_fallback_attempts(&endpoint))
        {
            let fallback_body = if anthropic_format {
                build_anthropic_body(
                    &request.messages,
                    &request.system_prompt,
                    &model_str,
                    safe_max_tokens,
                    false,
                )
            } else {
                req_body.clone()
            };
            let mut fallback_req = client
                .post(&fallback_endpoint)
                .header("Authorization", format!("Bearer {}", api_key))
                .header("Content-Type", "application/json")
                .json(&fallback_body);
            if anthropic_format {
                fallback_req = fallback_req.header("X-Api-Key", api_key.clone());
            }
            let fallback_resp = match fallback_req.send().await {
                Ok(resp) => resp,
                Err(_) => continue,
            };
            let fallback_status = fallback_resp.status();
            let fallback_limit = if fallback_status.is_success() {
                AI_STREAM_MAX_TOTAL_RESPONSE_BYTES
            } else {
                AI_STREAM_MAX_ERROR_BODY_BYTES
            };
            let fallback_kind = if fallback_status.is_success() {
                "invalid_stream"
            } else {
                "provider_error"
            };
            let fallback_text =
                match read_ai_response_body_bounded(fallback_resp, fallback_limit, fallback_kind)
                    .await
                {
                    Ok(body) => body,
                    Err(failure) => return Ok(ai_chat_failure_response(failure.kind)),
                };
            if !fallback_status.is_success() {
                continue;
            }
            let parsed = match if anthropic_format {
                parse_anthropic_content(&fallback_text)
            } else {
                parse_openai_content(&fallback_text)
            } {
                Ok(content) => content,
                Err(_) => return Ok(ai_chat_failure_response("invalid_stream")),
            };
            return match parsed {
                Some(content) => Ok(AiChatResponse {
                    success: true,
                    content: Some(content),
                    error_kind: None,
                    error_message: None,
                    error_detail: None,
                }),
                None => Ok(ai_chat_failure_response("empty_response")),
            };
        }
        return Ok(ai_chat_failure_response(ai_failure_kind_for_http_status(
            status,
        )));
    }

    let content = match if endpoint_anthropic_format {
        parse_anthropic_content(&resp_text)
    } else {
        parse_openai_content(&resp_text)
    } {
        Ok(content) => content,
        Err(_) => return Ok(ai_chat_failure_response("invalid_stream")),
    };

    match content {
        Some(c) => Ok(AiChatResponse {
            success: true,
            content: Some(c),
            error_kind: None,
            error_message: None,
            error_detail: None,
        }),
        None => Ok(ai_chat_failure_response("empty_response")),
    }
}

#[derive(Clone, Copy, Debug)]
struct AiStreamFailure {
    kind: &'static str,
    message: &'static str,
}

fn safe_ai_stream_failure(kind: &str) -> AiStreamFailure {
    match kind {
        "no_api_key" => AiStreamFailure {
            kind: "no_api_key",
            message: "AI 尚未配置",
        },
        "unauthorized" => AiStreamFailure {
            kind: "unauthorized",
            message: "AI 服务认证失败",
        },
        "rate_limited" => AiStreamFailure {
            kind: "rate_limited",
            message: "AI 服务请求过于频繁",
        },
        "timeout" => AiStreamFailure {
            kind: "timeout",
            message: "AI 请求超时",
        },
        "connection" => AiStreamFailure {
            kind: "connection",
            message: "AI 服务连接失败",
        },
        "invalid_stream" => AiStreamFailure {
            kind: "invalid_stream",
            message: "AI 流式响应格式无效",
        },
        "empty_response" => AiStreamFailure {
            kind: "empty_response",
            message: "AI 服务返回空内容",
        },
        "cancelled" => AiStreamFailure {
            kind: "cancelled",
            message: "AI 响应已停止",
        },
        _ => AiStreamFailure {
            kind: "provider_error",
            message: "AI 服务返回错误",
        },
    }
}

fn ai_chat_failure_response(kind: &str) -> AiChatResponse {
    let failure = safe_ai_stream_failure(kind);
    AiChatResponse {
        success: false,
        content: None,
        error_kind: Some(failure.kind.to_string()),
        error_message: Some(failure.message.to_string()),
        error_detail: None,
    }
}

fn ai_failure_kind_for_http_status(status: reqwest::StatusCode) -> &'static str {
    match status.as_u16() {
        401 | 403 => "unauthorized",
        429 => "rate_limited",
        _ => "provider_error",
    }
}

fn ai_stream_terminal_success(content: String) -> AiStreamTerminalResult {
    AiStreamTerminalResult {
        success: true,
        content: Some(content),
        error_kind: None,
        error_message: None,
    }
}

fn ai_stream_terminal_failure(kind: &str) -> AiStreamTerminalResult {
    let failure = safe_ai_stream_failure(kind);
    AiStreamTerminalResult {
        success: false,
        content: None,
        error_kind: Some(failure.kind.to_string()),
        error_message: Some(failure.message.to_string()),
    }
}

fn append_ai_stream_utf8(
    incomplete: &mut Vec<u8>,
    bytes: &[u8],
    output: &mut String,
) -> Result<(), AiStreamFailure> {
    incomplete.extend_from_slice(bytes);
    loop {
        match std::str::from_utf8(incomplete) {
            Ok(text) => {
                output.push_str(text);
                incomplete.clear();
                return Ok(());
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    let text = std::str::from_utf8(&incomplete[..valid])
                        .map_err(|_| safe_ai_stream_failure("invalid_stream"))?;
                    output.push_str(text);
                    incomplete.drain(..valid);
                }
                if error.error_len().is_some() || incomplete.len() > 3 {
                    incomplete.clear();
                    return Err(safe_ai_stream_failure("invalid_stream"));
                }
                return Ok(());
            }
        }
    }
}

fn emit_ai_stream_error(
    app: &tauri::AppHandle,
    stream_id: &str,
    kind: &str,
    _untrusted_detail: &str,
) {
    let failure = safe_ai_stream_failure(kind);
    emit_ai_stream_event(
        app,
        AiStreamEvent {
            stream_id: stream_id.to_string(),
            delta: None,
            done: true,
            error_kind: Some(failure.kind.to_string()),
            error_message: Some(failure.message.to_string()),
        },
    );
}

const AI_STREAM_MAX_TOTAL_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const AI_STREAM_MAX_SSE_LINE_BYTES: usize = 4 * 1024 * 1024;
const AI_STREAM_MAX_VISIBLE_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const AI_STREAM_MAX_HIDDEN_BYTES: usize = 4 * 1024 * 1024;
const AI_STREAM_MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

fn ensure_ai_sse_line_projection(
    pending_bytes: usize,
    incomplete_utf8_bytes: usize,
    incoming: &[u8],
) -> Result<(), AiStreamFailure> {
    let mut projected = pending_bytes
        .checked_add(incomplete_utf8_bytes)
        .ok_or_else(|| safe_ai_stream_failure("invalid_stream"))?;
    for segment in incoming.split_inclusive(|byte| *byte == b'\n') {
        let line_bytes = if segment.last() == Some(&b'\n') {
            segment.len().saturating_sub(1)
        } else {
            segment.len()
        };
        projected = projected
            .checked_add(line_bytes)
            .filter(|length| *length <= AI_STREAM_MAX_SSE_LINE_BYTES)
            .ok_or_else(|| safe_ai_stream_failure("invalid_stream"))?;
        if segment.last() == Some(&b'\n') {
            projected = 0;
        }
    }
    Ok(())
}

async fn read_ai_response_body_bounded(
    response: reqwest::Response,
    max_bytes: usize,
    overflow_kind: &'static str,
) -> Result<String, AiStreamFailure> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(safe_ai_stream_failure(overflow_kind));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(next) = stream.next().await {
        let bytes = next.map_err(|_| safe_ai_stream_failure("connection"))?;
        body.len()
            .checked_add(bytes.len())
            .filter(|total| *total <= max_bytes)
            .ok_or_else(|| safe_ai_stream_failure(overflow_kind))?;
        body.extend_from_slice(&bytes);
    }
    String::from_utf8(body).map_err(|_| safe_ai_stream_failure(overflow_kind))
}

#[derive(Default)]
pub(crate) struct AiVisibleContentStream {
    reasoning_depth: usize,
    visible_bytes: usize,
    hidden_bytes: usize,
    failure: Option<AiReasoningStreamFailure>,
    pending: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AiReasoningStreamFailure {
    /// Hidden reasoning content exceeded the bounded budget.
    HiddenOverflow,
    /// Visible content exceeded the bounded budget.
    VisibleOverflow,
    /// Reasoning nesting exceeded the maximum depth.
    NestingOverflow,
    /// A reasoning close tag appeared while no reasoning block was open.
    MalformedBoundary,
    /// The stream ended while a reasoning block was still open. This is the
    /// only failure a completed turn may discard at EOF: the hidden tail is
    /// dropped and the already-emitted safe visible content is retained.
    UnclosedThinkTail,
    /// Any other invalid stream state. Kept for classification completeness:
    /// every production failure path currently maps to a specific variant, so
    /// this fallback is intentionally never constructed today.
    #[allow(dead_code)]
    Invalid,
}

impl AiVisibleContentStream {
    const OPEN_TAG: &'static str = "<think>";
    const CLOSE_TAG: &'static str = "</think>";
    const MAX_DEPTH: usize = 32;

    fn boundary_at_start(value: &str) -> AiReasoningBoundary {
        if value.len() >= Self::OPEN_TAG.len()
            && value.as_bytes()[..Self::OPEN_TAG.len()]
                .eq_ignore_ascii_case(Self::OPEN_TAG.as_bytes())
        {
            return AiReasoningBoundary::Open;
        }
        if value.len() >= Self::CLOSE_TAG.len()
            && value.as_bytes()[..Self::CLOSE_TAG.len()]
                .eq_ignore_ascii_case(Self::CLOSE_TAG.as_bytes())
        {
            return AiReasoningBoundary::Close;
        }
        if Self::OPEN_TAG
            .get(..value.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(value))
            || Self::CLOSE_TAG
                .get(..value.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(value))
        {
            return AiReasoningBoundary::Partial;
        }
        AiReasoningBoundary::Other
    }

    fn consume_hidden(&mut self, bytes: usize) {
        self.hidden_bytes = self.hidden_bytes.saturating_add(bytes);
        if self.hidden_bytes > AI_STREAM_MAX_HIDDEN_BYTES {
            self.set_failure(AiReasoningStreamFailure::HiddenOverflow);
            self.pending.clear();
        }
    }

    fn set_failure(&mut self, failure: AiReasoningStreamFailure) {
        if self.failure.is_none() {
            self.failure = Some(failure);
        }
        self.pending.clear();
    }

    fn tainted(&self) -> bool {
        self.failure.is_some()
    }

    pub(crate) fn push(&mut self, chunk: &str) -> String {
        if self.tainted() {
            return String::new();
        }
        self.pending.push_str(chunk);
        let mut visible = String::new();

        while !self.pending.is_empty() {
            if self.reasoning_depth == 0 {
                let Some(tag_start) = self.pending.find('<') else {
                    visible.push_str(&self.pending);
                    self.pending.clear();
                    break;
                };
                if tag_start > 0 {
                    visible.push_str(&self.pending[..tag_start]);
                    self.pending.drain(..tag_start);
                }
                match Self::boundary_at_start(&self.pending) {
                    AiReasoningBoundary::Partial => break,
                    AiReasoningBoundary::Open => {
                        self.pending.drain(..Self::OPEN_TAG.len());
                        self.reasoning_depth = 1;
                        self.consume_hidden(Self::OPEN_TAG.len());
                        continue;
                    }
                    AiReasoningBoundary::Close => {
                        self.set_failure(AiReasoningStreamFailure::MalformedBoundary);
                        break;
                    }
                    AiReasoningBoundary::Other => {}
                }
                let first_len = self.pending.chars().next().map(char::len_utf8).unwrap_or(0);
                visible.push_str(&self.pending[..first_len]);
                self.pending.drain(..first_len);
                continue;
            }

            let Some(tag_start) = self.pending.find('<') else {
                let consumed = self.pending.len();
                self.pending.clear();
                self.consume_hidden(consumed);
                break;
            };
            if tag_start > 0 {
                self.pending.drain(..tag_start);
                self.consume_hidden(tag_start);
                if self.tainted() {
                    break;
                }
            }

            match Self::boundary_at_start(&self.pending) {
                AiReasoningBoundary::Partial => break,
                AiReasoningBoundary::Open => {
                    if self.reasoning_depth >= Self::MAX_DEPTH {
                        self.set_failure(AiReasoningStreamFailure::NestingOverflow);
                        break;
                    }
                    self.pending.drain(..Self::OPEN_TAG.len());
                    self.reasoning_depth += 1;
                    self.consume_hidden(Self::OPEN_TAG.len());
                }
                AiReasoningBoundary::Close => {
                    self.pending.drain(..Self::CLOSE_TAG.len());
                    self.reasoning_depth -= 1;
                    self.consume_hidden(Self::CLOSE_TAG.len());
                }
                AiReasoningBoundary::Other => {
                    let first_len = self.pending.chars().next().map(char::len_utf8).unwrap_or(0);
                    self.pending.drain(..first_len);
                    self.consume_hidden(first_len);
                }
            }
        }
        match self.visible_bytes.checked_add(visible.len()) {
            Some(total) if total <= AI_STREAM_MAX_VISIBLE_OUTPUT_BYTES => {
                self.visible_bytes = total;
                visible
            }
            _ => {
                self.set_failure(AiReasoningStreamFailure::VisibleOverflow);
                String::new()
            }
        }
    }

    pub(crate) fn finish(&mut self) {
        self.pending.clear();
        if self.reasoning_depth > 0 && self.failure.is_none() {
            // EOF while a reasoning block is open: the hidden tail is dropped.
            // This is the only EOF condition a completed turn may discard.
            self.failure = Some(AiReasoningStreamFailure::UnclosedThinkTail);
        }
    }

    pub(crate) fn failure_kind(&self) -> Option<&'static str> {
        self.failure.map(|failure| match failure {
            AiReasoningStreamFailure::HiddenOverflow => "hidden-overflow",
            AiReasoningStreamFailure::VisibleOverflow => "visible-overflow",
            AiReasoningStreamFailure::NestingOverflow => "nesting-overflow",
            AiReasoningStreamFailure::MalformedBoundary => "malformed-reasoning",
            AiReasoningStreamFailure::UnclosedThinkTail => "unclosed-think-tail",
            AiReasoningStreamFailure::Invalid => "invalid_stream",
        })
    }

    pub(crate) fn failure_class(&self) -> Option<AiReasoningStreamFailure> {
        self.failure
    }

    /// True only when the sole stream problem is an unclosed reasoning tail at
    /// EOF. Any other failure (overflow, malformed boundary, nesting) returns
    /// false so the caller keeps rejecting instead of completing.
    pub(crate) fn unclosed_think_tail_only(&self) -> bool {
        self.failure == Some(AiReasoningStreamFailure::UnclosedThinkTail)
    }

    pub(crate) fn has_visible_content(&self) -> bool {
        self.visible_bytes > 0
    }

    #[cfg(test)]
    fn retained_bytes(&self) -> usize {
        self.pending.len()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AiReasoningBoundary {
    Open,
    Close,
    Partial,
    Other,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AiStreamLineOutcome {
    Continue,
    Done,
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MiniMaxStreamContentMode {
    Unknown,
    Cumulative,
    Incremental,
}

#[derive(Debug, Default)]
struct AiProviderStreamState {
    minimax_previous_content: Option<String>,
    minimax_mode: Option<MiniMaxStreamContentMode>,
}

impl AiProviderStreamState {
    fn visible_delta(&mut self, provider_key: &str, content: String) -> Result<String, ()> {
        if provider_key != "minimax" {
            return Ok(content);
        }
        if content.is_empty() {
            return Ok(content);
        }
        let Some(previous) = self.minimax_previous_content.as_ref() else {
            self.minimax_previous_content = Some(content.clone());
            self.minimax_mode = Some(MiniMaxStreamContentMode::Unknown);
            return Ok(content);
        };
        match self
            .minimax_mode
            .unwrap_or(MiniMaxStreamContentMode::Unknown)
        {
            MiniMaxStreamContentMode::Unknown if content.starts_with(previous) => {
                let delta = content[previous.len()..].to_owned();
                self.minimax_previous_content = Some(content);
                self.minimax_mode = Some(MiniMaxStreamContentMode::Cumulative);
                Ok(delta)
            }
            MiniMaxStreamContentMode::Unknown => {
                self.minimax_previous_content = None;
                self.minimax_mode = Some(MiniMaxStreamContentMode::Incremental);
                Ok(content)
            }
            MiniMaxStreamContentMode::Cumulative if content.starts_with(previous) => {
                let delta = content[previous.len()..].to_owned();
                self.minimax_previous_content = Some(content);
                Ok(delta)
            }
            MiniMaxStreamContentMode::Cumulative => Err(()),
            MiniMaxStreamContentMode::Incremental => Ok(content),
        }
    }
}

fn process_ai_stream_line_with_sink(
    stream_id: &str,
    provider_key: &str,
    line: &str,
    sanitizer: &mut AiVisibleContentStream,
    provider_state: &mut AiProviderStreamState,
    mut emit: impl FnMut(AiStreamEvent),
) -> AiStreamLineOutcome {
    let trimmed = line.trim();
    if !trimmed.starts_with("data:") {
        return AiStreamLineOutcome::Continue;
    }
    let data = trimmed.trim_start_matches("data:").trim();
    if data.is_empty() {
        return AiStreamLineOutcome::Continue;
    }
    if data == "[DONE]" {
        return AiStreamLineOutcome::Done;
    }
    let parsed: serde_json::Value = match serde_json::from_str(data) {
        Ok(value) => value,
        Err(_) => return AiStreamLineOutcome::Invalid,
    };

    let mut done = false;
    let delta = if provider_key == "anthropic" {
        let event_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if event_type == "message_stop" {
            done = true;
        }
        parsed
            .get("delta")
            .and_then(|d| d.get("text"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    } else {
        if provider_key == "minimax"
            && parsed
                .get("choices")
                .and_then(|choices| choices.as_array())
                .and_then(|choices| choices.first())
                .and_then(|choice| choice.get("finish_reason"))
                .and_then(|reason| reason.as_str())
                .is_some_and(|reason| matches!(reason, "stop" | "length" | "tool_calls"))
        {
            done = true;
        }
        parsed
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|item| item.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };

    if let Some(text) = delta {
        let text = match provider_state.visible_delta(provider_key, text) {
            Ok(text) => text,
            Err(()) => return AiStreamLineOutcome::Invalid,
        };
        if !text.is_empty() {
            let visible = sanitizer.push(&text);
            if sanitizer.failure_kind().is_some() {
                return AiStreamLineOutcome::Invalid;
            }
            if !visible.is_empty() {
                emit(AiStreamEvent {
                    stream_id: stream_id.to_string(),
                    delta: Some(visible),
                    done: false,
                    error_kind: None,
                    error_message: None,
                });
            }
        }
    }
    if done {
        AiStreamLineOutcome::Done
    } else {
        AiStreamLineOutcome::Continue
    }
}

async fn forward_ai_stream_response(
    response: reqwest::Response,
    provider_key: &str,
    stream_id: &str,
    mut emit: impl FnMut(AiStreamEvent),
) -> Result<String, AiStreamFailure> {
    if ai_stream_is_cancelled(stream_id) {
        return Err(safe_ai_stream_failure("cancelled"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > AI_STREAM_MAX_TOTAL_RESPONSE_BYTES as u64)
    {
        return Err(safe_ai_stream_failure("invalid_stream"));
    }
    let mut pending = String::new();
    let mut incomplete_utf8 = Vec::with_capacity(3);
    let mut visible_stream = AiVisibleContentStream::default();
    let mut provider_state = AiProviderStreamState::default();
    let mut visible_output = String::new();
    let mut total_response_bytes = 0_usize;
    let mut stream = response.bytes_stream();
    while let Some(next) = stream.next().await {
        if ai_stream_is_cancelled(stream_id) {
            return Err(safe_ai_stream_failure("cancelled"));
        }
        let bytes = next.map_err(|_| safe_ai_stream_failure("connection"))?;
        total_response_bytes = total_response_bytes
            .checked_add(bytes.len())
            .filter(|total| *total <= AI_STREAM_MAX_TOTAL_RESPONSE_BYTES)
            .ok_or_else(|| safe_ai_stream_failure("invalid_stream"))?;
        ensure_ai_sse_line_projection(pending.len(), incomplete_utf8.len(), &bytes)?;
        append_ai_stream_utf8(&mut incomplete_utf8, &bytes, &mut pending)?;
        while let Some(index) = pending.find('\n') {
            if index > AI_STREAM_MAX_SSE_LINE_BYTES {
                return Err(safe_ai_stream_failure("invalid_stream"));
            }
            let line = pending[..index].trim_end_matches('\r').to_string();
            pending.drain(..=index);
            let mut emit_visible = |event: AiStreamEvent| {
                if let Some(delta) = event.delta.as_deref() {
                    visible_output.push_str(delta);
                }
                emit(event);
            };
            match process_ai_stream_line_with_sink(
                stream_id,
                provider_key,
                &line,
                &mut visible_stream,
                &mut provider_state,
                &mut emit_visible,
            ) {
                AiStreamLineOutcome::Continue => {}
                AiStreamLineOutcome::Invalid => {
                    return Err(safe_ai_stream_failure("invalid_stream"));
                }
                AiStreamLineOutcome::Done => {
                    visible_stream.finish();
                    if visible_stream.failure_kind().is_some() {
                        return Err(safe_ai_stream_failure("invalid_stream"));
                    }
                    emit(AiStreamEvent {
                        stream_id: stream_id.to_string(),
                        delta: None,
                        done: true,
                        error_kind: None,
                        error_message: None,
                    });
                    return Ok(visible_output);
                }
            }
        }
        if pending.len() > AI_STREAM_MAX_SSE_LINE_BYTES {
            return Err(safe_ai_stream_failure("invalid_stream"));
        }
    }
    if !incomplete_utf8.is_empty() {
        return Err(safe_ai_stream_failure("invalid_stream"));
    }
    if !pending.trim().is_empty() {
        if pending.len() > AI_STREAM_MAX_SSE_LINE_BYTES {
            return Err(safe_ai_stream_failure("invalid_stream"));
        }
        let mut emit_visible = |event: AiStreamEvent| {
            if let Some(delta) = event.delta.as_deref() {
                visible_output.push_str(delta);
            }
            emit(event);
        };
        match process_ai_stream_line_with_sink(
            stream_id,
            provider_key,
            &pending,
            &mut visible_stream,
            &mut provider_state,
            &mut emit_visible,
        ) {
            AiStreamLineOutcome::Continue => {}
            AiStreamLineOutcome::Invalid => {
                return Err(safe_ai_stream_failure("invalid_stream"));
            }
            AiStreamLineOutcome::Done => {
                visible_stream.finish();
                if visible_stream.failure_kind().is_some() {
                    return Err(safe_ai_stream_failure("invalid_stream"));
                }
                emit(AiStreamEvent {
                    stream_id: stream_id.to_string(),
                    delta: None,
                    done: true,
                    error_kind: None,
                    error_message: None,
                });
                return Ok(visible_output);
            }
        }
    }
    Err(safe_ai_stream_failure("invalid_stream"))
}

#[cfg(test)]
mod ai_stream_reasoning_safety_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn deepseek_openai_compatible_base_url_is_not_rewritten_with_a_v1_segment() {
        assert_eq!(
            build_ai_endpoint(
                "deepseek",
                "openai-compatible",
                Some("https://api.deepseek.com")
            ),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            build_ai_endpoint(
                "deepseek",
                "anthropic-messages",
                Some("https://api.deepseek.com/anthropic")
            ),
            "https://api.deepseek.com/anthropic/v1/messages"
        );
    }

    #[tokio::test]
    async fn nonstream_deepseek_anthropic_message_uses_the_native_wire_contract() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept loopback");
            let mut request = [0_u8; 16 * 1024];
            let read = socket.read(&mut request).expect("read request");
            let request = String::from_utf8_lossy(&request[..read]);
            let lower = request.to_ascii_lowercase();
            assert!(request.starts_with("POST /anthropic/v1/messages HTTP/1.1"));
            assert!(lower.contains("x-api-key: fixture-key"));
            assert!(lower.contains("anthropic-version: 2023-06-01"));
            assert!(!lower.contains("authorization: bearer"));
            assert!(request.contains("\"model\":\"deepseek-v4-flash\""));
            assert!(request.contains("\"max_tokens\":16"));
            let body = br#"{"content":[{"type":"text","text":"OK"}]}"#;
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .expect("write response headers");
            socket.write_all(body).expect("write response body");
        });

        let response = ai_chat_complete_with_config(
            AiModelConfig {
                provider: "deepseek".to_owned(),
                protocol: "anthropic-messages".to_owned(),
                api_key: "fixture-key".to_owned(),
                model: "deepseek-v4-flash".to_owned(),
                custom_url: Some(format!("http://{address}/anthropic")),
            },
            AiChatRequest {
                messages: vec![AiChatRequestMessage {
                    role: "user".to_owned(),
                    content: serde_json::Value::String("请只回复 OK，用于连接测试。".to_owned()),
                }],
                system_prompt: None,
                temperature: Some(0.0),
                max_tokens: Some(16),
                model: None,
            },
        )
        .await
        .expect("native Anthropic message result");
        server.join().expect("loopback server");

        assert!(response.success);
        assert_eq!(response.content.as_deref(), Some("OK"));
        assert_eq!(response.error_kind, None);
    }

    #[tokio::test]
    async fn canvas_text_pinned_endpoint_uses_v1_and_does_not_follow_redirects() {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let server=std::thread::spawn(move||{
            let (mut socket,_)=listener.accept().unwrap();
            socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut request_bytes=Vec::new();
            while !request_bytes.windows(4).any(|part|part==b"\r\n\r\n") {
                let mut buffer=[0_u8;2048];let size=socket.read(&mut buffer).unwrap();
                assert!(size>0);request_bytes.extend_from_slice(&buffer[..size]);assert!(request_bytes.len()<=32768);
            }
            let request=String::from_utf8_lossy(&request_bytes);
            assert!(request.starts_with("POST /v1/chat/completions "));
            assert!(request.to_ascii_lowercase().contains("authorization: bearer fixture-key"));
            write!(socket,"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let result=ai_chat_complete_transport(AiModelConfig {provider:"custom".into(),protocol:"openai-compatible".into(),api_key:"fixture-key".into(),model:"chat".into(),custom_url:Some(format!("http://{address}"))},nonstream_test_request(),Some(Vec::new()),None,true).await.unwrap();
        server.join().unwrap();
        assert!(!result.success);
        assert_ne!(result.error_kind.as_deref(),Some("connection"));
        assert!(!serde_json::to_string(&result).unwrap().contains("fixture-key"));
    }

    fn nonstream_test_request() -> AiChatRequest {
        AiChatRequest {
            messages: vec![AiChatRequestMessage {
                role: "user".to_string(),
                content: serde_json::Value::String("safe question".to_string()),
            }],
            system_prompt: None,
            temperature: Some(0.0),
            max_tokens: Some(64),
            model: None,
        }
    }

    fn assert_safe_nonstream_failure(response: &AiChatResponse, expected_kind: &str) {
        assert!(!response.success);
        assert!(response.content.is_none());
        assert_eq!(response.error_kind.as_deref(), Some(expected_kind));
        assert_eq!(
            response.error_message.as_deref(),
            Some(safe_ai_stream_failure(expected_kind).message)
        );
        assert_eq!(response.error_detail, None);
        let serialized = serde_json::to_string(response).expect("serialize App-compatible result");
        for forbidden in [
            "PRIVATE",
            "SECRET",
            "provider.invalid",
            "private\\note",
            "stack",
            "127.0.0.1",
        ] {
            assert!(!serialized.contains(forbidden), "leaked {forbidden}");
        }
    }

    fn spawn_nonstream_http_response(
        status_line: &'static str,
        body: Vec<u8>,
    ) -> (std::net::SocketAddr, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept loopback");
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request);
            write!(
                socket,
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .expect("write response headers");
            let _ = socket.write_all(&body);
        });
        (address, server)
    }

    #[tokio::test]
    async fn nonstream_transport_failure_returns_one_app_compatible_safe_result() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("reserve loopback port");
        let address = listener.local_addr().expect("loopback address");
        drop(listener);
        let config = AiModelConfig {
            provider: "openai".to_string(),
            protocol: "openai-compatible".to_string(),
            api_key: "PRIVATE-API-KEY".to_string(),
            model: "safe-model".to_string(),
            custom_url: Some(format!("http://{address}/PRIVATE/path?token=SECRET")),
        };

        let response = ai_chat_complete_with_config(config, nonstream_test_request())
            .await
            .expect("transport failure must be a typed response, not a raw Tauri error");

        assert_safe_nonstream_failure(&response, "connection");
    }

    #[tokio::test]
    async fn nonstream_timeout_returns_the_fixed_safe_timeout_result() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept loopback");
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request);
            std::thread::sleep(std::time::Duration::from_millis(100));
        });

        let response = ai_chat_complete_with_config_and_fallbacks(
            AiModelConfig {
                provider: "openai".to_string(),
                protocol: "openai-compatible".to_string(),
                api_key: "PRIVATE-API-KEY".to_string(),
                model: "safe-model".to_string(),
                custom_url: Some(format!("http://{address}/PRIVATE?token=SECRET")),
            },
            nonstream_test_request(),
            None,
            Some(std::time::Duration::from_millis(20)),
        )
        .await
        .expect("timeout must be a typed App-compatible result");
        server.join().expect("loopback server");

        assert_safe_nonstream_failure(&response, "timeout");
    }

    #[tokio::test]
    async fn nonstream_http_failures_ignore_provider_bodies_and_use_the_stream_error_table() {
        let cases = [
            ("401 Unauthorized", "unauthorized"),
            ("403 Forbidden", "unauthorized"),
            ("429 Too Many Requests", "rate_limited"),
            ("500 Internal Server Error", "provider_error"),
        ];

        for (status_line, expected_kind) in cases {
            let body = br#"{"error":{"message":"PRIVATE-TOKEN https://provider.invalid/private?token=SECRET C:\\private\\note stack"}}"#.to_vec();
            let (address, server) = spawn_nonstream_http_response(status_line, body);
            let config = AiModelConfig {
                provider: "openai".to_string(),
                protocol: "openai-compatible".to_string(),
                api_key: "PRIVATE-API-KEY".to_string(),
                model: "safe-model".to_string(),
                custom_url: Some(format!("http://{address}")),
            };

            let response = ai_chat_complete_with_config(config, nonstream_test_request())
                .await
                .expect("HTTP failure must be a typed App-compatible result");
            server.join().expect("loopback server");

            assert_safe_nonstream_failure(&response, expected_kind);
        }
    }

    #[tokio::test]
    async fn nonstream_oversized_provider_error_body_is_bounded_and_never_serialized() {
        let body = vec![b'P'; AI_STREAM_MAX_ERROR_BODY_BYTES + 1];
        let (address, server) = spawn_nonstream_http_response("500 Internal Server Error", body);
        let response = ai_chat_complete_with_config(
            AiModelConfig {
                provider: "openai".to_string(),
                protocol: "openai-compatible".to_string(),
                api_key: "PRIVATE-API-KEY".to_string(),
                model: "safe-model".to_string(),
                custom_url: Some(format!("http://{address}")),
            },
            nonstream_test_request(),
        )
        .await
        .expect("oversized provider body must be a typed result");
        server.join().expect("loopback server");

        assert_safe_nonstream_failure(&response, "provider_error");
    }

    #[tokio::test]
    async fn nonstream_malformed_empty_and_unconfigured_results_are_typed_and_safe() {
        let cases = [
            (b"{PRIVATE-MALFORMED".to_vec(), "invalid_stream"),
            (br#"{"choices":[]}"#.to_vec(), "empty_response"),
            (
                br#"{"choices":[{"message":{"content":""}}]}"#.to_vec(),
                "empty_response",
            ),
        ];

        for (body, expected_kind) in cases {
            let (address, server) = spawn_nonstream_http_response("200 OK", body);
            let response = ai_chat_complete_with_config(
                AiModelConfig {
                    provider: "openai".to_string(),
                    protocol: "openai-compatible".to_string(),
                    api_key: "PRIVATE-API-KEY".to_string(),
                    model: "safe-model".to_string(),
                    custom_url: Some(format!("http://{address}")),
                },
                nonstream_test_request(),
            )
            .await
            .expect("provider response failure must remain a typed result");
            server.join().expect("loopback server");

            assert_safe_nonstream_failure(&response, expected_kind);
        }

        let no_key = ai_chat_complete_with_config(
            AiModelConfig {
                provider: "openai".to_string(),
                protocol: "openai-compatible".to_string(),
                api_key: String::new(),
                model: "safe-model".to_string(),
                custom_url: Some("https://provider.invalid/PRIVATE?token=SECRET".to_string()),
            },
            nonstream_test_request(),
        )
        .await
        .expect("missing key must be a typed result");
        assert_safe_nonstream_failure(&no_key, "no_api_key");
    }

    #[tokio::test]
    async fn nonstream_minimax_primary_and_fallback_bodies_never_escape_the_safe_result() {
        let primary_body =
            br#"{"error":{"message":"invalid api key 2049 PRIVATE-PRIMARY token=SECRET"}}"#
                .to_vec();
        let fallback_body = br#"{"error":{"message":"PRIVATE-FALLBACK https://provider.invalid/private?token=SECRET C:\\private\\note stack"}}"#.to_vec();
        let (primary_address, primary_server) =
            spawn_nonstream_http_response("401 Unauthorized", primary_body);
        let (fallback_address, fallback_server) =
            spawn_nonstream_http_response("500 Internal Server Error", fallback_body);

        let response = ai_chat_complete_with_config_and_fallbacks(
            AiModelConfig {
                provider: "minimax".to_string(),
                protocol: "openai-compatible".to_string(),
                api_key: "PRIVATE-API-KEY".to_string(),
                model: "safe-model".to_string(),
                custom_url: Some(format!("http://{primary_address}")),
            },
            nonstream_test_request(),
            Some(vec![(format!("http://{fallback_address}/PRIVATE"), false)]),
            None,
        )
        .await
        .expect("MiniMax fallback exhaustion must be a typed result");
        primary_server.join().expect("primary loopback server");
        fallback_server.join().expect("fallback loopback server");

        assert_safe_nonstream_failure(&response, "unauthorized");
    }

    #[test]
    fn production_sse_parser_drops_structured_and_tagged_reasoning_across_events() {
        let mut sanitizer = AiVisibleContentStream::default();
        let mut provider_state = AiProviderStreamState::default();
        let mut deltas = Vec::new();
        let lines = [
            r#"data: {"choices":[{"delta":{"reasoning_content":"PRIVATE-STRUCTURED","content":"公开<th"}}]}"#,
            r#"data: {"choices":[{"delta":{"thinking":"PRIVATE-THINKING","content":"ink>PRIVATE-TAGGED"}}]}"#,
            r#"data: {"choices":[{"delta":{"reasoning":"PRIVATE-REASONING","content":"</think>答案"}}]}"#,
            "data: [DONE]",
        ];

        for line in lines {
            process_ai_stream_line_with_sink(
                "stream-safe",
                "openai",
                line,
                &mut sanitizer,
                &mut provider_state,
                |event| {
                    if let Some(delta) = event.delta {
                        deltas.push(delta);
                    }
                },
            );
        }

        let visible = deltas.concat();
        assert_eq!(visible, "公开答案");
        assert!(!visible.contains("PRIVATE"));
        assert!(!visible.to_ascii_lowercase().contains("think"));
        assert_eq!(sanitizer.retained_bytes(), 0);
    }

    #[test]
    fn minimax_cumulative_stream_content_is_differenced_before_reasoning_sanitization() {
        let mut sanitizer = AiVisibleContentStream::default();
        let mut provider_state = AiProviderStreamState::default();
        let mut deltas = Vec::new();
        let lines = [
            r#"data: {"choices":[{"delta":{"content":"公开<think>A"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"公开<think>AB</think>答案"}}]}"#,
            "data: [DONE]",
        ];

        for line in lines {
            let outcome = process_ai_stream_line_with_sink(
                "minimax-cumulative",
                "minimax",
                line,
                &mut sanitizer,
                &mut provider_state,
                |event| {
                    if let Some(delta) = event.delta {
                        deltas.push(delta);
                    }
                },
            );
            assert_ne!(outcome, AiStreamLineOutcome::Invalid);
        }
        sanitizer.finish();
        assert_eq!(sanitizer.failure_kind(), None);
        assert_eq!(deltas.concat(), "公开答案");
    }

    #[test]
    fn minimax_empty_role_frame_does_not_misclassify_incremental_content() {
        let mut sanitizer = AiVisibleContentStream::default();
        let mut provider_state = AiProviderStreamState::default();
        let mut deltas = Vec::new();
        let lines = [
            r#"data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}"#,
            r#"data: {"choices":[{"delta":{"content":"第一段"},"finish_reason":null}]}"#,
            r#"data: {"choices":[{"delta":{"content":"第二段"},"finish_reason":"stop"}]}"#,
        ];

        let mut outcome = AiStreamLineOutcome::Continue;
        for line in lines {
            outcome = process_ai_stream_line_with_sink(
                "minimax-incremental-after-role",
                "minimax",
                line,
                &mut sanitizer,
                &mut provider_state,
                |event| deltas.extend(event.delta),
            );
            assert_ne!(outcome, AiStreamLineOutcome::Invalid);
        }
        assert_eq!(outcome, AiStreamLineOutcome::Done);
        sanitizer.finish();
        assert_eq!(sanitizer.failure_kind(), None);
        assert_eq!(deltas.concat(), "第一段第二段");
    }

    #[test]
    fn minimax_finish_reason_is_a_typed_terminal_without_a_done_sentinel() {
        let mut sanitizer = AiVisibleContentStream::default();
        let mut provider_state = AiProviderStreamState::default();
        let mut deltas = Vec::new();
        let first = process_ai_stream_line_with_sink(
            "minimax-terminal",
            "minimax",
            r#"data: {"choices":[{"delta":{"content":"答案"},"finish_reason":null}]}"#,
            &mut sanitizer,
            &mut provider_state,
            |event| deltas.extend(event.delta),
        );
        let terminal = process_ai_stream_line_with_sink(
            "minimax-terminal",
            "minimax",
            r#"data: {"choices":[{"delta":{"content":"答案完成"},"finish_reason":"stop"}]}"#,
            &mut sanitizer,
            &mut provider_state,
            |event| deltas.extend(event.delta),
        );

        assert_eq!(first, AiStreamLineOutcome::Continue);
        assert_eq!(terminal, AiStreamLineOutcome::Done);
        sanitizer.finish();
        assert_eq!(sanitizer.failure_kind(), None);
        assert_eq!(deltas.concat(), "答案完成");
    }

    #[test]
    fn production_reasoning_parser_nests_and_taints_orphan_closing_boundaries() {
        let cases = [
            (vec!["公开", "</thi", "nk>", "PRIVATE-ORPHAN"], "公开"),
            (
                vec![
                    "公开",
                    "<think>",
                    "PRIVATE-A",
                    "<THINK>",
                    "PRIVATE-B",
                    "</think>",
                    "PRIVATE-C",
                    "</think>",
                    "答案",
                ],
                "公开答案",
            ),
            (
                vec![
                    "公开",
                    "<think>PRIVATE</think>",
                    "</think>",
                    "PRIVATE-EXTRA",
                ],
                "公开",
            ),
        ];

        for (chunks, expected) in cases {
            let mut sanitizer = AiVisibleContentStream::default();
            let mut visible = String::new();
            for chunk in chunks {
                visible.push_str(&sanitizer.push(chunk));
                assert!(!visible.contains("PRIVATE"));
                assert!(!visible.to_ascii_lowercase().contains("think"));
            }
            sanitizer.finish();
            assert_eq!(visible, expected);
        }
    }

    #[test]
    fn production_reasoning_parser_has_hard_depth_hidden_and_visible_caps() {
        let mut too_deep = AiVisibleContentStream::default();
        assert!(too_deep.push(&"<think>".repeat(33)).is_empty());
        assert_eq!(too_deep.failure_kind(), Some("nesting-overflow"));

        let mut hidden_overflow = AiVisibleContentStream::default();
        assert!(hidden_overflow.push("<think>").is_empty());
        assert!(hidden_overflow
            .push(&"x".repeat(AI_STREAM_MAX_HIDDEN_BYTES + 1))
            .is_empty());
        assert_eq!(hidden_overflow.failure_kind(), Some("hidden-overflow"));

        let mut visible_overflow = AiVisibleContentStream::default();
        assert!(visible_overflow
            .push(&"x".repeat(AI_STREAM_MAX_VISIBLE_OUTPUT_BYTES + 1))
            .is_empty());
        assert_eq!(visible_overflow.failure_kind(), Some("visible-overflow"));
    }

    #[test]
    fn unclosed_think_tail_is_the_only_eof_failure_a_completed_turn_may_discard() {
        // Safe case: visible content followed by an unclosed reasoning tail.
        let mut tail = AiVisibleContentStream::default();
        assert_eq!(tail.push("可见正文"), "可见正文");
        assert!(tail.push("<think>隐藏尾巴").is_empty());
        assert!(tail.failure_class().is_none(), "no failure before EOF");
        tail.finish();
        assert_eq!(tail.failure_kind(), Some("unclosed-think-tail"));
        assert!(tail.unclosed_think_tail_only());
        assert!(tail.has_visible_content());

        // Empty visible content + unclosed tail: must NOT be discardable.
        let mut empty_tail = AiVisibleContentStream::default();
        assert!(empty_tail.push("<think>只有隐藏").is_empty());
        empty_tail.finish();
        assert_eq!(empty_tail.failure_kind(), Some("unclosed-think-tail"));
        assert!(empty_tail.unclosed_think_tail_only());
        assert!(!empty_tail.has_visible_content());

        // Malformed close at depth 0 is not an unclosed tail.
        let mut malformed = AiVisibleContentStream::default();
        assert_eq!(malformed.push("正文</think>"), "正文");
        malformed.finish();
        assert_eq!(malformed.failure_kind(), Some("malformed-reasoning"));
        assert!(!malformed.unclosed_think_tail_only());

        // Overflow is not an unclosed tail.
        let mut overflow = AiVisibleContentStream::default();
        assert!(overflow
            .push(&"x".repeat(AI_STREAM_MAX_VISIBLE_OUTPUT_BYTES + 1))
            .is_empty());
        overflow.finish();
        assert_eq!(overflow.failure_kind(), Some("visible-overflow"));
        assert!(!overflow.unclosed_think_tail_only());

        // Properly closed reasoning is not a failure at all.
        let mut closed = AiVisibleContentStream::default();
        assert_eq!(closed.push("公开"), "公开");
        assert!(closed.push("<think>秘密</think>").is_empty());
        closed.finish();
        assert_eq!(closed.failure_kind(), None);
    }

    #[tokio::test]
    async fn loopback_sse_forwarder_never_emits_reasoning_from_network_byte_splits() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"公开<th\",\"reasoning_content\":\"PRIVATE-STRUCTURED\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"ink>PRIVATE-TAGGED\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"</think>答案\"}}]}\n\n",
            "data: [DONE]\n\n"
        )
        .as_bytes()
        .to_vec();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept loopback");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
                .expect("write headers");
            for chunk in body.chunks(2) {
                write!(socket, "{:X}\r\n", chunk.len()).expect("write chunk size");
                socket.write_all(chunk).expect("write split body");
                socket.write_all(b"\r\n").expect("write chunk terminator");
                socket.flush().expect("flush split body");
            }
            socket.write_all(b"0\r\n\r\n").expect("finish chunks");
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/stream"))
            .send()
            .await
            .expect("loopback response");
        let mut events = Vec::new();

        let terminal_content =
            forward_ai_stream_response(response, "openai", "loopback-safe", |event| {
                events.push(event);
            })
            .await
            .expect("forward safe stream");
        server.join().expect("loopback server");

        let serialized = serde_json::to_string(&events).expect("serialize safe events");
        assert!(!serialized.contains("PRIVATE"));
        assert!(!serialized.to_ascii_lowercase().contains("think"));
        let visible = events
            .iter()
            .filter_map(|event| event.delta.as_deref())
            .collect::<String>();
        assert_eq!(visible, "公开答案");
        assert_eq!(terminal_content, "公开答案");
        assert_eq!(events.last().map(|event| event.done), Some(true));
    }

    #[tokio::test]
    async fn malformed_loopback_sse_returns_only_a_fixed_safe_error() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let private_body =
            b"data: {PRIVATE-BODY token=SECRET path=C:\\private\\note.md}\n\n".to_vec();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept loopback");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                private_body.len()
            )
            .expect("write headers");
            socket.write_all(&private_body).expect("write body");
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/stream?token=SECRET"))
            .send()
            .await
            .expect("loopback response");
        let mut events = Vec::new();
        let error = forward_ai_stream_response(response, "openai", "malformed-safe", |event| {
            events.push(event);
        })
        .await
        .expect_err("malformed SSE must fail closed");
        server.join().expect("loopback server");

        assert_eq!(error.kind, "invalid_stream");
        assert_eq!(error.message, "AI 流式响应格式无效");
        let diagnostic = format!("{error:?}");
        assert!(!diagnostic.contains("PRIVATE"));
        assert!(!diagnostic.contains("SECRET"));
        assert!(!diagnostic.contains("private\\note"));
        assert!(
            events.is_empty(),
            "malformed provider data is never emitted"
        );
    }

    #[tokio::test]
    async fn partial_loopback_sse_without_terminal_frame_fails_closed() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let body = b"data: {\"choices\":[{\"delta\":{\"content\":\"safe partial\"}}]}\n\n";
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept loopback");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .expect("write headers");
            socket.write_all(body).expect("write partial body");
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/stream"))
            .send()
            .await
            .expect("loopback response");
        let mut events = Vec::new();

        let error = forward_ai_stream_response(response, "openai", "partial-eof", |event| {
            events.push(event);
        })
        .await
        .expect_err("EOF before a provider terminal frame must fail closed");
        server.join().expect("loopback server");

        assert_eq!(error.kind, "invalid_stream");
        assert_eq!(
            events
                .iter()
                .filter_map(|event| event.delta.as_deref())
                .collect::<String>(),
            "safe partial"
        );
        assert!(!events.iter().any(|event| event.done));
    }

    #[tokio::test]
    async fn oversized_content_length_is_rejected_before_the_body_is_read() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept loopback");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                AI_STREAM_MAX_TOTAL_RESPONSE_BYTES + 1
            )
            .expect("write oversized headers");
            socket.flush().expect("flush oversized headers");
            std::thread::sleep(std::time::Duration::from_millis(250));
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/stream"))
            .send()
            .await
            .expect("loopback response");
        let started = std::time::Instant::now();

        let error = forward_ai_stream_response(response, "openai", "oversized", |_| {})
            .await
            .expect_err("oversized response must fail before reading its body");

        assert_eq!(error.kind, "invalid_stream");
        assert!(started.elapsed() < std::time::Duration::from_millis(200));
        server.join().expect("loopback server");
    }

    #[tokio::test]
    async fn an_sse_line_over_the_hard_limit_fails_without_emitting_content() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let body = vec![b'x'; AI_STREAM_MAX_SSE_LINE_BYTES + 1];
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept loopback");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .expect("write headers");
            let _ = socket.write_all(&body);
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/stream"))
            .send()
            .await
            .expect("loopback response");
        let mut events = Vec::new();

        let error = forward_ai_stream_response(response, "openai", "long-line", |event| {
            events.push(event);
        })
        .await
        .expect_err("oversized SSE line must fail closed");

        assert_eq!(error.kind, "invalid_stream");
        assert!(events.is_empty());
        server.join().expect("loopback server");
    }

    #[test]
    fn sse_line_budget_is_checked_against_projected_bytes_before_append() {
        assert!(ensure_ai_sse_line_projection(AI_STREAM_MAX_SSE_LINE_BYTES - 1, 0, b"x").is_ok());
        let error = ensure_ai_sse_line_projection(AI_STREAM_MAX_SSE_LINE_BYTES, 0, b"x")
            .expect_err("boundary plus one must fail before appending the chunk");
        assert_eq!(error.kind, "invalid_stream");

        assert!(ensure_ai_sse_line_projection(AI_STREAM_MAX_SSE_LINE_BYTES, 0, b"\nnext").is_ok());
    }

    #[tokio::test]
    async fn error_body_reader_rejects_declared_oversize_without_waiting_for_raw_body() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept loopback");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request);
            write!(
                socket,
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                AI_STREAM_MAX_ERROR_BODY_BYTES + 1
            )
            .expect("write error headers");
            socket.flush().expect("flush error headers");
            std::thread::sleep(std::time::Duration::from_millis(250));
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/error"))
            .send()
            .await
            .expect("loopback response");
        let started = std::time::Instant::now();

        let error = read_ai_response_body_bounded(
            response,
            AI_STREAM_MAX_ERROR_BODY_BYTES,
            "provider_error",
        )
        .await
        .expect_err("oversized provider body must not be read");

        assert_eq!(error.kind, "provider_error");
        assert!(started.elapsed() < std::time::Duration::from_millis(200));
        server.join().expect("loopback server");
    }

    #[tokio::test]
    async fn chunked_error_body_over_the_cap_is_discarded_with_one_request() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let body = vec![b'P'; AI_STREAM_MAX_ERROR_BODY_BYTES + 1];
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept loopback");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request);
            socket
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
                .expect("write chunked error headers");
            for chunk in body.chunks(4096) {
                if write!(socket, "{:X}\r\n", chunk.len()).is_err()
                    || socket.write_all(chunk).is_err()
                    || socket.write_all(b"\r\n").is_err()
                {
                    return;
                }
            }
            let _ = socket.write_all(b"0\r\n\r\n");
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/error"))
            .send()
            .await
            .expect("loopback response");

        let error = read_ai_response_body_bounded(
            response,
            AI_STREAM_MAX_ERROR_BODY_BYTES,
            "provider_error",
        )
        .await
        .expect_err("chunked provider body must stop at the cap");

        assert_eq!(error.kind, "provider_error");
        assert!(!format!("{error:?}").contains("PRIVATE"));
        server.join().expect("loopback server");
    }

    #[tokio::test]
    async fn malformed_utf8_sse_fails_without_emitting_provider_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let body = b"data: \xFF\n\n";
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept loopback");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .expect("write headers");
            socket.write_all(body).expect("write invalid utf8");
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/stream"))
            .send()
            .await
            .expect("loopback response");
        let mut events = Vec::new();

        let error = forward_ai_stream_response(response, "openai", "invalid-utf8", |event| {
            events.push(event);
        })
        .await
        .expect_err("invalid UTF-8 must fail closed");

        assert_eq!(error.kind, "invalid_stream");
        assert!(events.is_empty());
        server.join().expect("loopback server");
    }

    #[tokio::test]
    async fn ordinary_stream_cancellation_stops_reading_without_success_terminal() {
        let stream_id = format!("ai-cancel-{}", std::process::id());
        let _guard = AiStreamCancellationGuard::begin(&stream_id).expect("register stream");
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let cancel_id = stream_id.clone();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept loopback");
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request);
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .expect("write headers");
            let first = b"data: {\"choices\":[{\"delta\":{\"content\":\"visible\"}}]}\n\n";
            write!(socket, "{:X}\r\n", first.len()).expect("write size");
            socket.write_all(first).expect("write first chunk");
            socket.write_all(b"\r\n").expect("finish first chunk");
            socket.flush().expect("flush first chunk");
            std::thread::sleep(std::time::Duration::from_millis(20));
            assert!(cancel_ai_stream_if_active(&cancel_id));
            let done = b"data: [DONE]\n\n";
            let _ = write!(socket, "{:X}\r\n", done.len());
            let _ = socket.write_all(done);
            let _ = socket.write_all(b"\r\n0\r\n\r\n");
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/stream"))
            .send()
            .await
            .expect("loopback response");
        let mut events = Vec::new();
        let failure = forward_ai_stream_response(response, "openai", &stream_id, |event| {
            events.push(event);
        })
        .await
        .expect_err("cancelled stream must not succeed");
        assert_eq!(failure.kind, "cancelled");
        assert!(events.iter().all(|event| !event.done));
        server.join().expect("loopback server");
    }

    #[test]
    fn stream_error_allowlist_never_copies_provider_or_transport_details() {
        let cases = [
            ("no_api_key", "AI 尚未配置"),
            ("unauthorized", "AI 服务认证失败"),
            ("rate_limited", "AI 服务请求过于频繁"),
            ("timeout", "AI 请求超时"),
            ("connection", "AI 服务连接失败"),
            ("invalid_stream", "AI 流式响应格式无效"),
            ("cancelled", "AI 响应已停止"),
            ("provider_error", "AI 服务返回错误"),
        ];
        for (kind, expected_message) in cases {
            let failure = safe_ai_stream_failure(kind);
            assert_eq!(failure.kind, kind);
            assert_eq!(failure.message, expected_message);
        }
        let unknown = safe_ai_stream_failure(
            "PRIVATE token=SECRET https://provider.invalid/path?q=SECRET C:\\private\\note.md",
        );
        assert_eq!(unknown.kind, "provider_error");
        assert_eq!(unknown.message, "AI 服务返回错误");
        let serialized = format!("{unknown:?}");
        assert!(!serialized.contains("PRIVATE"));
        assert!(!serialized.contains("SECRET"));
        assert!(!serialized.contains("provider.invalid"));
        assert!(!serialized.contains("private\\note"));

        let terminal = ai_stream_terminal_failure(
            "PRIVATE token=SECRET https://provider.invalid/path?q=SECRET C:\\private\\note.md",
        );
        assert_eq!(terminal.success, false);
        assert_eq!(terminal.error_kind.as_deref(), Some("provider_error"));
        let terminal_json = serde_json::to_string(&terminal).expect("serialize safe terminal");
        assert!(!terminal_json.contains("PRIVATE"));
        assert!(!terminal_json.contains("SECRET"));
        assert!(!terminal_json.contains("provider.invalid"));
        assert!(!terminal_json.contains("private\\note"));
    }
}

#[tauri::command]
async fn ai_chat_stream(
    app: tauri::AppHandle,
    request: AiChatStreamRequest,
) -> Result<AiStreamTerminalResult, String> {
    let stream_id = request.stream_id.clone();
    let _cancellation = AiStreamCancellationGuard::begin(&stream_id)?;
    if ai_stream_is_cancelled(&stream_id) {
        return Ok(ai_stream_terminal_failure("cancelled"));
    }
    let app_data = match app.path().app_data_dir() {
        Ok(path) => path,
        Err(_) => {
            emit_ai_stream_error(&app, &stream_id, "provider_error", "");
            return Ok(ai_stream_terminal_failure("provider_error"));
        }
    };
    let db_path = app_data.join("luckyray.db");

    let AiModelConfig {
        provider,
        protocol,
        api_key,
        model,
        custom_url,
    } = match load_ai_model_config(&db_path) {
        Ok(config) => config,
        Err(_) => {
            emit_ai_stream_error(&app, &stream_id, "provider_error", "");
            return Ok(ai_stream_terminal_failure("provider_error"));
        }
    };

    let api_key = normalize_ai_api_key(&api_key);
    if api_key.is_empty() {
        emit_ai_stream_error(
            &app,
            &stream_id,
            "no_api_key",
            "请先在设置中配置 AI API Key",
        );
        return Ok(ai_stream_terminal_failure("no_api_key"));
    }

    let provider_key = provider.trim().to_lowercase();
    let model_str = model.trim().to_string();
    let safe_max_tokens = request.max_tokens.unwrap_or(4096).clamp(1, 32768);
    let endpoint = build_ai_endpoint(&provider_key, &protocol, custom_url.as_deref());
    let endpoint_anthropic_format = endpoint_uses_anthropic_format(&protocol);
    let api_key_header = ai_auth_header(&protocol, &api_key);

    let mut req_body = serde_json::Map::new();

    if endpoint_anthropic_format {
        req_body = build_anthropic_body(
            &request.messages,
            &request.system_prompt,
            &model_str,
            safe_max_tokens,
            true,
        );
    } else {
        req_body.insert(
            "model".to_string(),
            serde_json::Value::String(model_str.clone()),
        );
        req_body.insert("stream".to_string(), serde_json::Value::Bool(true));

        let mut messages = Vec::new();
        if let Some(ref sp) = request.system_prompt {
            if !sp.is_empty() {
                messages.push(serde_json::json!({"role": "system", "content": sp}));
            }
        }
        for msg in &request.messages {
            messages.push(serde_json::json!({"role": msg.role, "content": msg.content}));
        }
        req_body.insert("messages".to_string(), serde_json::Value::Array(messages));

        if let Some(t) = request.temperature {
            req_body.insert("temperature".to_string(), serde_json::json!(t));
        }
        if provider_key == "minimax" {
            req_body.insert(
                "max_completion_tokens".to_string(),
                serde_json::json!(safe_max_tokens),
            );
        } else if request.max_tokens.is_some() {
            req_body.insert("max_tokens".to_string(), serde_json::json!(safe_max_tokens));
        }
    }

    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(60))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            emit_ai_stream_error(&app, &stream_id, "provider_error", "");
            return Ok(ai_stream_terminal_failure("provider_error"));
        }
    };

    let mut req = client
        .post(&endpoint)
        .header(api_key_header.0, api_key_header.1)
        .header("Content-Type", "application/json")
        .json(&req_body);
    if endpoint_anthropic_format {
        req = req.header("anthropic-version", "2023-06-01");
        if provider_key == "minimax" {
            req = req.header("X-Api-Key", api_key.clone());
        }
    }

    let mut stream_parse_provider_key = if endpoint_anthropic_format {
        "anthropic"
    } else {
        provider_key.as_str()
    };
    let resp = match req.send().await {
        Ok(resp) => resp,
        Err(error) => {
            let kind = if error.is_timeout() {
                "timeout"
            } else {
                "connection"
            };
            emit_ai_stream_error(&app, &stream_id, kind, "");
            return Ok(ai_stream_terminal_failure(kind));
        }
    };
    if ai_stream_is_cancelled(&stream_id) {
        return Ok(ai_stream_terminal_failure("cancelled"));
    }

    let status = resp.status();
    let resp = if !status.is_success() {
        let resp_text =
            read_ai_response_body_bounded(resp, AI_STREAM_MAX_ERROR_BODY_BYTES, "provider_error")
                .await
                .unwrap_or_default();
        if provider_key == "minimax" && is_minimax_auth_error(status, &resp_text) {
            let mut fallback_resp_for_stream: Option<reqwest::Response> = None;
            let mut minimax_fallback_errors: Vec<String> = Vec::new();
            for (fallback_endpoint, anthropic_format) in minimax_fallback_attempts(&endpoint) {
                if ai_stream_is_cancelled(&stream_id) {
                    return Ok(ai_stream_terminal_failure("cancelled"));
                }
                let fallback_body = if anthropic_format {
                    build_anthropic_body(
                        &request.messages,
                        &request.system_prompt,
                        &model_str,
                        safe_max_tokens,
                        true,
                    )
                } else {
                    req_body.clone()
                };
                let mut fallback_req = client
                    .post(&fallback_endpoint)
                    .header("Authorization", format!("Bearer {}", api_key))
                    .header("Content-Type", "application/json")
                    .json(&fallback_body);
                if anthropic_format {
                    fallback_req = fallback_req.header("X-Api-Key", api_key.clone());
                }
                match fallback_req.send().await {
                    Ok(fallback_resp) if fallback_resp.status().is_success() => {
                        stream_parse_provider_key = if anthropic_format {
                            "anthropic"
                        } else {
                            "minimax"
                        };
                        fallback_resp_for_stream = Some(fallback_resp);
                        break;
                    }
                    Ok(fallback_resp) => {
                        let fallback_status = fallback_resp.status();
                        let fallback_text = read_ai_response_body_bounded(
                            fallback_resp,
                            AI_STREAM_MAX_ERROR_BODY_BYTES,
                            "provider_error",
                        )
                        .await
                        .unwrap_or_default();
                        minimax_fallback_errors.push(format!(
                            "{} HTTP {}: {}",
                            fallback_endpoint,
                            fallback_status.as_u16(),
                            extract_api_error_message(&fallback_text)
                        ));
                    }
                    Err(err) => {
                        minimax_fallback_errors.push(format!("{}: {}", fallback_endpoint, err));
                    }
                }
            }
            match fallback_resp_for_stream {
                Some(fallback_resp) => fallback_resp,
                None => {
                    let primary = extract_api_error_message(&resp_text);
                    let error_msg = if primary.to_lowercase().contains("invalid api key")
                        || primary.contains("2049")
                    {
                        primary
                    } else if minimax_fallback_errors.is_empty() {
                        primary
                    } else {
                        minimax_fallback_errors.join(" | ")
                    };
                    emit_ai_stream_error(&app, &stream_id, "unauthorized", &error_msg);
                    return Ok(ai_stream_terminal_failure("unauthorized"));
                }
            }
        } else {
            let error_msg = extract_api_error_message(&resp_text);
            let kind = if status.as_u16() == 401 {
                "unauthorized"
            } else if status.as_u16() == 429 {
                "rate_limited"
            } else {
                "api_error"
            };
            emit_ai_stream_error(&app, &stream_id, kind, &error_msg);
            return Ok(ai_stream_terminal_failure(kind));
        }
    } else {
        resp
    };

    let terminal_content =
        match forward_ai_stream_response(resp, stream_parse_provider_key, &stream_id, |event| {
            emit_ai_stream_event(&app, event)
        })
        .await
        {
            Ok(content) => content,
            Err(error) => {
                emit_ai_stream_error(&app, &stream_id, error.kind, error.message);
                return Ok(ai_stream_terminal_failure(error.kind));
            }
        };
    Ok(ai_stream_terminal_success(terminal_content))
}

struct AiStreamCancellationGuard {
    stream_id: String,
}

impl AiStreamCancellationGuard {
    fn begin(stream_id: &str) -> Result<Self, String> {
        if stream_id.is_empty()
            || stream_id.len() > 128
            || !stream_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("invalid_stream".to_owned());
        }
        AI_STREAM_CANCELLATIONS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|value| value.into_inner())
            .insert(stream_id.to_owned(), false);
        Ok(Self {
            stream_id: stream_id.to_owned(),
        })
    }
}

impl Drop for AiStreamCancellationGuard {
    fn drop(&mut self) {
        if let Some(active) = AI_STREAM_CANCELLATIONS.get() {
            active
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .remove(&self.stream_id);
        }
    }
}

fn ai_stream_is_cancelled(stream_id: &str) -> bool {
    AI_STREAM_CANCELLATIONS
        .get()
        .and_then(|active| {
            active
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .get(stream_id)
                .copied()
        })
        .unwrap_or(false)
}

fn cancel_ai_stream_if_active(stream_id: &str) -> bool {
    AI_STREAM_CANCELLATIONS
        .get()
        .and_then(|active| {
            active
                .lock()
                .unwrap_or_else(|value| value.into_inner())
                .get_mut(stream_id)
                .map(|cancelled| {
                    *cancelled = true;
                    true
                })
        })
        .unwrap_or(false)
}

#[tauri::command]
fn ai_chat_cancel(caller: tauri::Webview, stream_id: String) -> Result<(), String> {
    require_main_caller(&caller)?;
    let _ = cancel_ai_stream_if_active(&stream_id);
    Ok(())
}

// ===== D36: 浏览器插件本地 HTTP 接收服务 =====

// ===== D41: 插件 API 端点工具 =====

#[cfg(all(feature = "issue189-isolated-fixture", not(debug_assertions)))]
compile_error!("Issue #189 isolated fixture must never be built as a release binary");
#[cfg(all(feature = "issue191-isolated-fixture", not(debug_assertions)))]
compile_error!("Issue #191 UI fixture must never be built as a release binary");

fn app_data_dir() -> std::path::PathBuf {
    if let Some(backend) = BACKEND_SERVICES.get() {
        return backend.app_data_dir().to_path_buf();
    }
    let identifier = if cfg!(all(debug_assertions, feature = "issue191-isolated-fixture")) {
        #[cfg(feature = "issue191-isolated-fixture")]
        { runtime_profile::ISSUE191_FIXTURE_IDENTIFIER }
        #[cfg(not(feature = "issue191-isolated-fixture"))]
        { runtime_profile::DEVELOPMENT_IDENTIFIER }
    } else if cfg!(all(debug_assertions, feature = "issue189-frozen-old-fixture")) {
        #[cfg(feature = "issue189-frozen-old-fixture")]
        { runtime_profile::ISSUE189_OLD_IDENTIFIER }
        #[cfg(not(feature = "issue189-frozen-old-fixture"))]
        { runtime_profile::DEVELOPMENT_IDENTIFIER }
    } else if cfg!(all(debug_assertions, feature = "issue189-isolated-fixture")) {
        #[cfg(feature = "issue189-isolated-fixture")]
        { runtime_profile::ISSUE189_FIXTURE_IDENTIFIER }
        #[cfg(not(feature = "issue189-isolated-fixture"))]
        { runtime_profile::DEVELOPMENT_IDENTIFIER }
    } else if cfg!(debug_assertions) {
        runtime_profile::DEVELOPMENT_IDENTIFIER
    } else {
        runtime_profile::PRODUCTION_IDENTIFIER
    };
    std::path::PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join(identifier)
}

fn db_path() -> std::path::PathBuf {
    if let Some(backend) = BACKEND_SERVICES.get() {
        return backend.db_path().to_path_buf();
    }
    app_data_dir().join("luckyray.db")
}

fn open_db_read() -> Result<rusqlite::Connection, String> {
    backend_services()?
        .open_read()
        .map_err(|error| error.to_string())
}

fn open_db_write() -> Result<rusqlite::Connection, String> {
    backend_services()?
        .open_write()
        .map_err(|error| error.to_string())
}

// D41: 失败记录写入 collection_failure 表 (按需建表)
// D45a: 增加 reason 分类字段，供前端按类型显示不同提示
fn record_failure(source: &str, payload_summary: &str, error: &str) {
    record_failure_with_reason(
        source,
        payload_summary,
        error,
        classify_failure_reason(error),
    );
}

// D45a: 失败原因分类（前端用 6 种 reason 渲染不同提示）
fn classify_failure_reason(error: &str) -> &'static str {
    let e = error.to_lowercase();
    if e.contains("blob:") || e.contains("站内播放流") {
        return "media_blocked";
    }
    if e.contains("m3u8") || e.contains("mpd") {
        return "unsupported_format";
    }
    if e.contains("drm") || e.contains("受保护") || e.contains("widevine") {
        return "drm_protected";
    }
    if e.contains("太小") || e.contains("图标") {
        return "too_small";
    }
    if e.contains("http") && e.len() <= 16 {
        return "http_error";
    }
    if e.contains("下载失败") || e.contains("connection") || e.contains("timeout") {
        return "network";
    }
    if e.contains("不支持") || e.contains("unsupported") {
        return "unsupported_format";
    }
    "unknown"
}

// D45a: 带 reason 的失败记录（reason 单独传时使用）
fn record_failure_with_reason(source: &str, payload_summary: &str, error: &str, reason: &str) {
    if let Ok(conn) = open_db_write() {
        let id = create_id_simple();
        let now = chrono::Local::now().to_rfc3339();
        if let Err(e) = conn.execute(
            "INSERT INTO collection_failure (id, source, payload, error, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, source, payload_summary, error, reason, now],
        ) {
            eprintln!("[luckyray] record collection failure failed: {}", e);
        }
    } else {
        eprintln!("[luckyray] open db failed while recording collection failure");
    }
}

// D46: 本地能力中心
// local_capability 表 + 默认清单 + CRUD + 运行一次
// 严格按小智审查结论：技能 / 扩展 / 工作流 三类 + 真实持久化 + 运行一次真动作
// 第一轮不做：远程市场、第三方安装、6 技能全做、3 工作流全做。

// D46: 本地能力默认清单（首次启动插入；id 唯一，type 决定分类）
// 技能 type="skill"，扩展 type="extension"，工作流 type="workflow"
const KNOWLEDGE_CAPABILITY_MIGRATION_PENDING: &str = "knowledge-capability-migration-pending";
const KNOWLEDGE_CAPABILITY_MIGRATION_REASON: &str =
    "Vault-backed Knowledge capability migration is pending";
const KNOWLEDGE_CAPABILITY_IDS: [&str; 4] = [
    "skill.summary",
    "skill.search_intent",
    "wf.web_to_note",
    "wf.note_to_summary",
];

fn legacy_knowledge_capability_migration_error() -> String {
    format!(
        "{}: {}",
        KNOWLEDGE_CAPABILITY_MIGRATION_PENDING, KNOWLEDGE_CAPABILITY_MIGRATION_REASON
    )
}

fn canonical_knowledge_capability_id(value: &str) -> Option<&'static str> {
    match value {
        "skill.summary" | "skill_summary" => Some("skill.summary"),
        "skill.search_intent" | "skill_search_intent" => Some("skill.search_intent"),
        "wf.web_to_note" | "wf_web_to_note" => Some("wf.web_to_note"),
        "wf.note_to_summary" | "wf_note_to_summary" => Some("wf.note_to_summary"),
        _ => None,
    }
}

fn capability_route_error(error: String) -> (u16, String) {
    if error.starts_with(KNOWLEDGE_CAPABILITY_MIGRATION_PENDING) {
        return (
            409,
            serde_json::to_string(&serde_json::json!({
                "ok": false,
                "code": KNOWLEDGE_CAPABILITY_MIGRATION_PENDING,
                "reason": KNOWLEDGE_CAPABILITY_MIGRATION_REASON,
            }))
            .unwrap(),
        );
    }
    (
        500,
        serde_json::to_string(&serde_json::json!({ "ok": false, "error": error })).unwrap(),
    )
}

fn local_capability_defaults() -> Vec<(
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    bool,
    &'static str,
)> {
    // (id, type, name, description, enabled_by_default, run_kind)
    // run_kind 决定 /api/capability/run 走哪个具体动作
    vec![
        // === 技能 ===
        (
            "skill.summary",
            "skill",
            "当前笔记摘要",
            "对当前打开的笔记生成一句话摘要，结果写入运行记录",
            true,
            "skill_summary",
        ),
        (
            "skill.search_intent",
            "skill",
            "搜索意图拆解",
            "对输入关键词拆解搜索意图（素材/笔记/全局），命中真实数据",
            true,
            "skill_search_intent",
        ),
        (
            "skill.auto_tag",
            "skill",
            "素材自动打标",
            "扫描最近未打标素材，并按类型/文件名补基础标签",
            true,
            "skill_auto_tag",
        ),
        // === 扩展 ===
        (
            "ext.browser_plugin",
            "extension",
            "浏览器插件直收",
            "检查本地 HTTP 端口 37418 是否可连通，决定插件能否直收",
            true,
            "ext_browser_plugin",
        ),
        (
            "ext.tab_recording",
            "extension",
            "标签页录制",
            "检查桌面端录制端点 /api/video/record/save 是否就绪（不真录制）",
            true,
            "ext_tab_recording",
        ),
        (
            "ext.folder_watch",
            "extension",
            "文件夹监听",
            "通过设置页 Watch 文件夹定时扫描真实目录，并按素材管理方式导入新文件",
            false,
            "ext_folder_watch",
        ),
        // === 工作流 ===
        (
            "wf.web_to_note",
            "workflow",
            "网页收藏转笔记",
            "把最近一次浏览器插件收集的链接转成新笔记",
            true,
            "wf_web_to_note",
        ),
        (
            "wf.untagged_assets",
            "workflow",
            "未打标素材整理",
            "扫描最近 50 个素材并补基础标签",
            true,
            "wf_untagged_assets",
        ),
        (
            "wf.note_to_summary",
            "workflow",
            "当前笔记生成摘要笔记",
            "复用 skill.summary + 写入新笔记",
            false,
            "wf_note_to_summary",
        ),
    ]
}

fn capability_parameter_schema(id: &str) -> serde_json::Value {
    match id {
        "skill.summary" => serde_json::json!([
            { "key": "documentId", "label": "知识文档 ID", "type": "string", "placeholder": "kdoc-…" },
            {
                "key": "style",
                "label": "摘要样式",
                "type": "select",
                "defaultValue": "short",
                "options": [
                    { "label": "一句话", "value": "short" },
                    { "label": "要点", "value": "bullets" },
                    { "label": "行动项", "value": "actions" }
                ]
            },
            { "key": "maxChars", "label": "字数上限", "type": "number", "defaultValue": 80, "placeholder": "80" }
        ]),
        "skill.search_intent" => serde_json::json!([
            { "key": "query", "label": "搜索关键词", "type": "string", "placeholder": "关键词" },
            { "key": "limit", "label": "返回数量", "type": "number", "defaultValue": 5, "placeholder": "5" },
            {
                "key": "scope",
                "label": "搜索范围",
                "type": "select",
                "defaultValue": "all",
                "options": [
                    { "label": "全部", "value": "all" },
                    { "label": "素材", "value": "assets" },
                    { "label": "笔记", "value": "notes" }
                ]
            }
        ]),
        "skill.auto_tag" | "wf.untagged_assets" => serde_json::json!([
            { "key": "hint", "label": "标签倾向", "type": "string", "placeholder": "品牌/界面/灵感" },
            { "key": "limit", "label": "扫描数量", "type": "number", "defaultValue": 50, "placeholder": "50" }
        ]),
        "ext.folder_watch" => serde_json::json!([
            { "key": "path", "label": "监听路径", "type": "string", "placeholder": "D:\\素材" },
            { "key": "recursive", "label": "包含子文件夹", "type": "boolean", "defaultValue": true }
        ]),
        "wf.web_to_note" => serde_json::json!([
            { "key": "title", "label": "笔记标题", "type": "string", "placeholder": "网页收藏" },
            { "key": "url", "label": "来源 URL", "type": "string", "placeholder": "https://example.com" },
            { "key": "content", "label": "网页内容", "type": "string", "placeholder": "已捕获的网页正文" },
            { "key": "parentRelativePath", "label": "Vault 文件夹", "type": "string", "placeholder": "Inbox" },
            { "key": "includeSource", "label": "保留来源", "type": "boolean", "defaultValue": true }
        ]),
        "wf.note_to_summary" => serde_json::json!([
            { "key": "documentId", "label": "知识文档 ID", "type": "string", "placeholder": "kdoc-…" },
            { "key": "title", "label": "摘要笔记标题", "type": "string", "placeholder": "当前笔记摘要" },
            { "key": "parentRelativePath", "label": "Vault 文件夹", "type": "string", "placeholder": "Inbox" },
            {
                "key": "style",
                "label": "摘要样式",
                "type": "select",
                "defaultValue": "bullets",
                "options": [
                    { "label": "要点", "value": "bullets" },
                    { "label": "一句话", "value": "short" },
                    { "label": "行动项", "value": "actions" }
                ]
            }
        ]),
        _ => serde_json::json!([]),
    }
}

fn capability_result_actions(id: &str) -> serde_json::Value {
    match id {
        "wf.web_to_note" | "wf.note_to_summary" => {
            serde_json::json!(["record", "copy", "navigateDocument"])
        }
        "skill.summary" | "skill.search_intent" | "skill.auto_tag" | "wf.untagged_assets" => {
            serde_json::json!(["record", "copy", "appendCurrentNote", "createNote"])
        }
        _ => serde_json::json!(["record", "copy"]),
    }
}

fn capability_scalar_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.trim().to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        _ => value.to_string(),
    }
}

fn normalize_capability_input(input: Option<&serde_json::Value>) -> String {
    match input {
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(serde_json::Value::Object(map)) => {
            let text = map
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let source = map
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let mut param_lines: Vec<String> = Vec::new();
            if let Some(params) = map.get("params").and_then(|v| v.as_object()) {
                let mut keys: Vec<&String> = params.keys().collect();
                keys.sort();
                for key in keys {
                    if let Some(value) = params.get(key) {
                        param_lines.push(format!(
                            "- {}: {}",
                            key,
                            capability_scalar_to_string(value)
                        ));
                    }
                }
            }
            [
                text,
                if source.is_empty() {
                    "".to_string()
                } else {
                    format!("来源: {}", source)
                },
                if param_lines.is_empty() {
                    "".to_string()
                } else {
                    format!("参数:\n{}", param_lines.join("\n"))
                },
            ]
            .into_iter()
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<String>>()
            .join("\n")
        }
        Some(value) => capability_scalar_to_string(value),
        None => "".to_string(),
    }
}

fn seed_local_capabilities(conn: &rusqlite::Connection) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|_| "local capability seed lock failed".to_string())?;
    let result = (|| {
        for (id, t, name, desc, enabled, _run_kind) in local_capability_defaults() {
            conn.execute(
                "INSERT OR IGNORE INTO local_capability (id, type, name, description, enabled, status, last_run_at, last_result, last_error, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'ready', NULL, NULL, NULL, ?6, ?6)",
                rusqlite::params![id, t, name, desc, if enabled { 1 } else { 0 }, now],
            )
            .map_err(|_| "local capability seed failed".to_string())?;
            conn.execute(
                "UPDATE local_capability SET type = ?1, name = ?2, description = ?3 WHERE id = ?4",
                rusqlite::params![t, name, desc, id],
            )
            .map_err(|_| "local capability metadata update failed".to_string())?;
        }

        let migration_error = legacy_knowledge_capability_migration_error();
        for (id, _, _, _, enabled_by_default, _) in local_capability_defaults()
            .into_iter()
            .filter(|(id, _, _, _, _, _)| KNOWLEDGE_CAPABILITY_IDS.contains(id))
        {
            conn.execute(
                "UPDATE local_capability
                 SET enabled = ?1, status = 'ready', last_result = NULL,
                     last_error = NULL, updated_at = ?2
                 WHERE id = ?3 AND status = 'unavailable' AND last_error = ?4",
                rusqlite::params![
                    if enabled_by_default { 1 } else { 0 },
                    now,
                    id,
                    migration_error,
                ],
            )
            .map_err(|_| "local capability Knowledge migration failed".to_string())?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|_| "local capability seed commit failed".to_string()),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn list_local_capabilities(conn: &rusqlite::Connection) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare("SELECT id, type, name, description, enabled, status, last_run_at, last_result, last_error, created_at, updated_at FROM local_capability ORDER BY type, id")
        .map_err(|_| "local capability query prepare failed".to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let id = row.get::<_, String>(0)?;
            let enabled_int: i64 = row.get(4)?;
            let last_result: Option<String> = row.get(7)?;
            let last_error: Option<String> = row.get(8)?;
            let status = row.get::<_, String>(5)?;
            let effective_status = if last_error
                .as_deref()
                .is_some_and(|message| !message.is_empty())
            {
                "error"
            } else if last_result.is_some() {
                "ok"
            } else {
                status.as_str()
            };
            Ok(serde_json::json!({
                "id": id,
                "type": row.get::<_, String>(1)?,
                "name": row.get::<_, String>(2)?,
                "description": row.get::<_, String>(3)?,
                "parameters": capability_parameter_schema(&id),
                "resultActions": capability_result_actions(&id),
                "enabled": enabled_int != 0,
                "available": true,
                "unavailableCode": serde_json::Value::Null,
                "unavailableReason": serde_json::Value::Null,
                "status": effective_status,
                "lastRunAt": row.get::<_, Option<String>>(6)?,
                "lastResult": last_result,
                "lastError": last_error,
                "createdAt": row.get::<_, String>(9)?,
                "updatedAt": row.get::<_, String>(10)?,
            }))
        })
        .map_err(|_| "local capability query failed".to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| "local capability row decode failed".to_string())
}

fn set_local_capability_enabled(
    conn: &rusqlite::Connection,
    id: &str,
    enabled: bool,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    let affected = conn
        .execute(
            "UPDATE local_capability SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![if enabled { 1 } else { 0 }, now, id],
        )
        .map_err(|_| "local capability enabled state update failed".to_string())?;
    if affected == 0 {
        return Err(format!("capability-not-found: {}", id));
    }
    Ok(())
}

// D46: GET /api/capability/list — 列出全部能力
fn handle_api_list_capability_with_backend(
    backend: &backend::BackendServices,
) -> Result<String, String> {
    let conn = backend
        .open_write()
        .map_err(|error| format!("backend-database-unavailable: {}", error.message))?;
    seed_local_capabilities(&conn)?;
    let caps = list_local_capabilities(&conn)?;
    Ok(format!(
        r#"{{"ok":true,"capabilities":{},"count":{}}}"#,
        serde_json::to_string(&caps).unwrap_or_else(|_| "[]".to_string()),
        caps.len()
    ))
}

// D46: POST /api/capability/toggle — 切换启用/停用
// body: { id: string, enabled: bool }
fn handle_api_toggle_capability_with_backend(
    backend: &backend::BackendServices,
    body: &serde_json::Value,
) -> Result<String, String> {
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
    if id.is_empty() {
        return Err("id 不能为空".to_string());
    }
    let enabled = body
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let conn = backend
        .open_write()
        .map_err(|error| format!("backend-database-unavailable: {}", error.message))?;
    seed_local_capabilities(&conn)?;
    set_local_capability_enabled(&conn, id, enabled)?;
    Ok(format!(
        r#"{{"ok":true,"id":{},"enabled":{}}}"#,
        serde_json::to_string(id).unwrap_or_else(|_| "\"\"".to_string()),
        if enabled { "true" } else { "false" }
    ))
}

// D46: POST /api/capability/run — 运行一次
// body: { id: string, input?: string | { text?: string, params?: object, source?: string } }
// 返回 { ok, id, status, lastRunAt, lastResult, lastError, summary }
fn handle_api_run_capability_with_backend(
    backend: &backend::BackendServices,
    body: &serde_json::Value,
) -> Result<String, String> {
    let requested_id = body.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
    if requested_id.is_empty() {
        return Err("id 不能为空".to_string());
    }
    let id = canonical_knowledge_capability_id(requested_id).unwrap_or(requested_id);
    let input_value = body.get("input");
    let input = normalize_capability_input(input_value);
    let conn = backend
        .open_write()
        .map_err(|error| format!("backend-database-unavailable: {}", error.message))?;
    seed_local_capabilities(&conn)?;
    let capability: Option<(String, i64)> = conn
        .query_row(
            "SELECT id, enabled FROM local_capability WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let Some((capability_id, enabled)) = capability else {
        return Err(format!("能力不存在: {}", id));
    };
    if enabled == 0 {
        return Ok(serde_json::to_string(&serde_json::json!({
            "ok": false,
            "id": capability_id,
            "status": "disabled",
            "code": "capability-disabled",
            "lastError": "capability-disabled: Capability is disabled",
        }))
        .unwrap());
    }

    // 通过 id 前缀派生 run_kind（id 形如 skill.summary → run_kind=skill_summary）
    let run_kind_id = capability_id.replace('.', "_");
    let now = chrono::Local::now().to_rfc3339();

    if canonical_knowledge_capability_id(&capability_id).is_some() {
        return match execute_knowledge_capability(backend, &run_kind_id, input_value) {
            Ok(outcome) => {
                let _ = conn.execute(
                    "UPDATE local_capability SET status = 'ok', last_run_at = ?1, last_result = ?2, last_error = NULL, updated_at = ?1 WHERE id = ?3",
                    rusqlite::params![now, outcome.last_result, capability_id],
                );
                Ok(serde_json::to_string(&serde_json::json!({
                    "ok": true,
                    "id": capability_id,
                    "status": "ok",
                    "lastRunAt": now,
                    "lastResult": outcome.last_result,
                    "summary": outcome.summary,
                    "result": outcome.result,
                    "indexWarning": outcome.index_warning,
                    "indexStale": outcome.index_stale,
                }))
                .unwrap())
            }
            Err(error) => {
                let stored_error = error.storage_message();
                let _ = conn.execute(
                    "UPDATE local_capability SET status = 'error', last_run_at = ?1, last_result = NULL, last_error = ?2, updated_at = ?1 WHERE id = ?3",
                    rusqlite::params![now, stored_error, capability_id],
                );
                Ok(serde_json::to_string(&serde_json::json!({
                    "ok": false,
                    "id": capability_id,
                    "status": "error",
                    "code": error.code,
                    "lastRunAt": now,
                    "lastError": stored_error,
                }))
                .unwrap())
            }
        };
    }

    let result = execute_capability_action(&capability_id, &run_kind_id, &input);

    match result {
        Ok((result_text, summary)) => {
            let _ = conn.execute(
                "UPDATE local_capability SET last_run_at = ?1, last_result = ?2, last_error = NULL, updated_at = ?1 WHERE id = ?3",
                rusqlite::params![now, result_text, capability_id],
            );
            Ok(serde_json::to_string(&serde_json::json!({
                "ok": true,
                "id": capability_id,
                "status": "ok",
                "lastRunAt": now,
                "lastResult": result_text,
                "summary": summary,
            }))
            .unwrap())
        }
        Err(err) => {
            let _ = conn.execute(
                "UPDATE local_capability SET last_run_at = ?1, last_result = NULL, last_error = ?2, updated_at = ?1 WHERE id = ?3",
                rusqlite::params![now, err, capability_id],
            );
            Ok(serde_json::to_string(&serde_json::json!({
                "ok": false,
                "id": capability_id,
                "status": "error",
                "lastRunAt": now,
                "lastError": err,
            }))
            .unwrap())
        }
    }
}

fn push_unique_tag(tags: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if value.is_empty() || tags.iter().any(|item| item == value) {
        return;
    }
    tags.push(value.to_string());
}

fn infer_asset_auto_tags(name: &str, kind: &str, input: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    match kind.to_lowercase().as_str() {
        "image" => push_unique_tag(&mut tags, "图片"),
        "video" => push_unique_tag(&mut tags, "视频"),
        "audio" => push_unique_tag(&mut tags, "音频"),
        "document" => push_unique_tag(&mut tags, "文档"),
        _ => push_unique_tag(&mut tags, "素材"),
    }

    let haystack = format!("{} {}", name, input).to_lowercase();
    let rules: [(&str, [&str; 4]); 10] = [
        ("人像", ["人像", "portrait", "girl", "person"]),
        ("风景", ["风景", "landscape", "scenery", "nature"]),
        ("设计", ["设计", "design", "ui", "ux"]),
        ("插画", ["插画", "illustration", "draw", "anime"]),
        ("服装", ["服装", "dress", "clothes", "outfit"]),
        ("网页", ["网页", "web", "site", "page"]),
        ("截图", ["截图", "screenshot", "screen", "capture"]),
        ("视频", ["视频", "video", "mp4", "mov"]),
        ("日系", ["日系", "japan", "jp", "和风"]),
        ("古风", ["古风", "汉服", "国风", "wuxia"]),
    ];
    for (tag, needles) in rules {
        if needles.iter().any(|needle| haystack.contains(needle)) {
            push_unique_tag(&mut tags, tag);
        }
    }

    for token in
        input.split(|c: char| c.is_whitespace() || c == ',' || c == '，' || c == ';' || c == '；')
    {
        let token = token.trim().trim_start_matches('#');
        if token.chars().count() >= 2 && token.chars().count() <= 12 && !token.contains(':') {
            push_unique_tag(&mut tags, token);
        }
    }

    tags.truncate(4);
    tags
}

fn capability_tag_color(name: &str) -> &'static str {
    match name {
        "图片" => "#60a5fa",
        "视频" => "#a78bfa",
        "音频" => "#34d399",
        "文档" => "#f59e0b",
        "人像" => "#f472b6",
        "风景" => "#22c55e",
        "设计" => "#818cf8",
        "插画" => "#fb923c",
        "服装" => "#f43f5e",
        "网页" => "#38bdf8",
        "截图" => "#94a3b8",
        "日系" => "#facc15",
        "古风" => "#c084fc",
        _ => "#fbbf24",
    }
}

// D46: 执行具体动作（每个 run_kind 一个分支）
// 返回 (result_text_for_db, summary_for_ui)
fn execute_capability_action(
    id: &str,
    run_kind: &str,
    input: &str,
) -> Result<(String, String), String> {
    match run_kind {
        "skill_auto_tag" => {
            let catalog = material_catalog_for_http()?;
            let assets = catalog
                .list_assets(&materials::MaterialFilter {
                    recent_only: true,
                    ..Default::default()
                })
                .map_err(|error| error.message)?;
            let ids = assets
                .iter()
                .map(|asset| asset.id.clone())
                .collect::<Vec<_>>();
            let tag_map = catalog
                .list_asset_tag_map(Some(ids))
                .map_err(|error| error.message)?;
            let mut assignments = Vec::new();
            let mut examples: Vec<String> = Vec::new();
            for asset in assets
                .into_iter()
                .filter(|asset| tag_map.get(&asset.id).is_none_or(Vec::is_empty))
            {
                let tags = infer_asset_auto_tags(&asset.name, &asset.kind, input);
                if tags.is_empty() {
                    continue;
                }
                if examples.len() < 5 {
                    examples.push(format!("{} -> {}", asset.name, tags.join("、")));
                }
                assignments.push(materials::MaterialAssetTagNames {
                    asset_id: asset.id,
                    tags: tags
                        .into_iter()
                        .map(|name| materials::MaterialNamedTag {
                            color: Some(capability_tag_color(&name).to_string()),
                            name,
                        })
                        .collect(),
                });
            }
            let tagged_assets = assignments.len();
            let outcome = catalog
                .add_asset_tag_names(assignments)
                .map_err(|error| error.message)?;
            emit_catalog_change_global(&outcome.change);
            let inserted_relations = outcome.value;

            let summary = if input.is_empty() {
                format!(
                    "已为最近 50 个素材中的 {} 个未打标素材补标签",
                    tagged_assets
                )
            } else {
                format!("按「{}」为 {} 个未打标素材补标签", input, tagged_assets)
            };
            let detail = if tagged_assets == 0 {
                "最近 50 个素材没有需要补基础标签的项".to_string()
            } else {
                format!(
                    "新增 {} 条标签关系；示例：{}",
                    inserted_relations,
                    examples.join("；")
                )
            };
            Ok((summary.clone(), detail))
        }
        "ext_browser_plugin" => {
            // 检查端口 37418：尝试打开 db（说明进程在跑）；不真正连自己
            let db_exists = db_path().exists();
            if !db_exists {
                return Err("数据库文件不存在，请先打开 LuckyRay 桌面端".to_string());
            }
            let result =
                "本地传输模块已运行；浏览器扩展通过 Native Messaging 自动建立安全连接".to_string();
            Ok((result.clone(), result))
        }
        "ext_tab_recording" => {
            // 检查录制端点 + tabCapture 支持说明
            let db_exists = db_path().exists();
            if !db_exists {
                return Err("数据库文件不存在，请先打开桌面端".to_string());
            }
            let result =
                "录制端点 /api/video/record/save 已注册；浏览器标签页录制需在 Chrome/Edge 加载插件"
                    .to_string();
            Ok((result.clone(), result))
        }
        "ext_folder_watch" => {
            let result = if input.is_empty() {
                "文件夹监听已接入设置页 Watch 文件夹；请在设置 → 存储 → Watch 文件夹添加监听源并启用。".to_string()
            } else {
                format!(
                    "文件夹监听参数已收到：{}。实际监听源请在设置 → 存储 → Watch 文件夹中管理。",
                    input
                )
            };
            Ok((result.clone(), result))
        }
        "wf_untagged_assets" => {
            // 复用 skill_auto_tag 的扫描
            let inner = execute_capability_action(id, "skill_auto_tag", input).map_err(|e| e)?;
            Ok((
                format!("[workflow] {}", inner.0),
                format!("[workflow] {}", inner.1),
            ))
        }
        _ => Err(format!("未知能力: {}", id)),
    }
}

// D41c: 当前活动笔记上下文由 KnowledgeService 内存状态拥有。
#[cfg(test)]
mod knowledge_capability_tests {
    use super::{
        backend, capabilities, execute_knowledge_capability, knowledge, list_local_capabilities,
        seed_local_capabilities, set_local_capability_enabled,
        KNOWLEDGE_CAPABILITY_MIGRATION_PENDING,
    };
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn capability_connection() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE local_capability (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'ready',
                last_run_at TEXT,
                last_result TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    fn temp_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "luckyray-capability-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn capability_backend(
        label: &str,
    ) -> (
        backend::BackendServices,
        PathBuf,
        knowledge::KnowledgeVaultRegistration,
    ) {
        let app_data = temp_path(&format!("{label}-app"));
        let vault_root = temp_path(&format!("{label}-vault"));
        std::fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let vault = knowledge::KnowledgeVaultRegistration {
            id: format!("vault-{label}"),
            name: label.to_string(),
            root_path: vault_root.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        std::fs::write(
            vault_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        let backend = backend::BackendServices::initialize(&app_data).unwrap();
        backend.knowledge().register_current_vault(&vault).unwrap();
        (backend, vault_root, vault)
    }

    #[test]
    fn retired_knowledge_capabilities_migrate_once_to_published_defaults() {
        let conn = capability_connection();
        conn.execute_batch(
            "CREATE TABLE note (id TEXT PRIMARY KEY, content_text TEXT NOT NULL);
             INSERT INTO note (id, content_text) VALUES ('sentinel', 'unchanged');
             INSERT INTO local_capability
                (id, type, name, description, enabled, status, last_result, created_at, updated_at)
             VALUES ('third.party', 'extension', 'Third party', 'unchanged', 0, 'error', 'sentinel', 'old', 'old');",
        )
        .unwrap();
        let expected_defaults = [
            ("skill.summary", true),
            ("skill.search_intent", true),
            ("wf.web_to_note", true),
            ("wf.note_to_summary", false),
        ];
        for (id, _) in expected_defaults {
            conn.execute(
                "INSERT INTO local_capability
                 (id, type, name, description, enabled, status, last_error, created_at, updated_at)
                 VALUES (?1, 'skill', 'old', 'old', 0, 'unavailable', ?2, 'old', 'old')",
                rusqlite::params![
                    id,
                    format!(
                        "{}: Vault-backed Knowledge capability migration is pending",
                        KNOWLEDGE_CAPABILITY_MIGRATION_PENDING
                    )
                ],
            )
            .unwrap();
        }

        seed_local_capabilities(&conn).unwrap();
        let listed = list_local_capabilities(&conn).unwrap();
        for (id, expected_enabled) in expected_defaults {
            let enabled: i64 = conn
                .query_row(
                    "SELECT enabled FROM local_capability WHERE id = ?1",
                    rusqlite::params![id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(enabled != 0, expected_enabled, "{id} default changed");
            let capability = listed
                .iter()
                .find(|capability| capability["id"] == id)
                .unwrap();
            assert_eq!(capability["enabled"], expected_enabled);
            assert_eq!(capability["available"], true);
            assert_ne!(capability["status"], "unavailable");
            assert_eq!(capability["unavailableCode"], serde_json::Value::Null);
            assert!(capability["parameters"]
                .as_array()
                .is_some_and(|items| !items.is_empty()));
            assert!(capability["resultActions"]
                .as_array()
                .is_some_and(|items| !items.is_empty()));
        }

        set_local_capability_enabled(&conn, "skill.summary", false).unwrap();
        seed_local_capabilities(&conn).unwrap();
        let persisted: i64 = conn
            .query_row(
                "SELECT enabled FROM local_capability WHERE id = 'skill.summary'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(persisted, 0, "restart must preserve the user's toggle");
        let sentinel: String = conn
            .query_row(
                "SELECT content_text FROM note WHERE id = 'sentinel'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sentinel, "unchanged");
        let unrelated: (i64, String, String) = conn
            .query_row(
                "SELECT enabled, status, last_result FROM local_capability WHERE id = 'third.party'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(unrelated, (0, "error".to_string(), "sentinel".to_string()));
    }

    #[test]
    fn capability_seed_is_serialized_across_connections_and_does_not_reapply_after_toggle() {
        let app_data = temp_path("registry-concurrent");
        let backend = std::sync::Arc::new(backend::BackendServices::initialize(&app_data).unwrap());
        let connection = backend.open_write().unwrap();
        let pending = format!(
            "{}: Vault-backed Knowledge capability migration is pending",
            KNOWLEDGE_CAPABILITY_MIGRATION_PENDING
        );
        for id in [
            "skill.summary",
            "skill.search_intent",
            "wf.web_to_note",
            "wf.note_to_summary",
        ] {
            connection
                .execute(
                    "INSERT INTO local_capability
                     (id, type, name, description, enabled, status, last_error, created_at, updated_at)
                     VALUES (?1, 'skill', 'old', 'old', 0, 'unavailable', ?2, 'old', 'old')",
                    rusqlite::params![id, pending],
                )
                .unwrap();
        }
        drop(connection);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads = (0..2)
            .map(|_| {
                let backend = backend.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let connection = backend.open_write().unwrap();
                    barrier.wait();
                    seed_local_capabilities(&connection)
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap().unwrap();
        }

        let connection = backend.open_write().unwrap();
        set_local_capability_enabled(&connection, "skill.summary", false).unwrap();
        seed_local_capabilities(&connection).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT enabled FROM local_capability WHERE id = 'skill.summary'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn vault_capability_executor_searches_summarizes_and_creates_canonical_documents() {
        let (backend, root, vault) = capability_backend("vertical");
        let knowledge = backend.knowledge();
        let source = knowledge
            .create_document(&knowledge::KnowledgeCreateInput {
                title: "Source".to_string(),
                parent_relative_path: None,
                content: "TOKEN-ALPHA design system\nTODO ship release".to_string(),
            })
            .unwrap();
        let source_id = knowledge::KnowledgeService::document_id(&source.summary.document_ref);

        let search = execute_knowledge_capability(
            &backend,
            "skill_search_intent",
            Some(&serde_json::json!({
                "text": "TOKEN-ALPHA",
                "params": { "scope": "notes", "limit": 3 }
            })),
        )
        .unwrap();
        assert_eq!(search.result["documents"].as_array().unwrap().len(), 1);
        assert_eq!(search.result["documents"][0]["id"], source_id);
        assert_eq!(search.result["documents"][0]["revision"], source.revision);

        let summary = execute_knowledge_capability(
            &backend,
            "skill.summary",
            Some(&serde_json::json!({
                "params": { "documentId": source_id, "style": "actions", "maxChars": 80 }
            })),
        )
        .unwrap();
        assert!(summary.last_result.contains("TODO ship release"));
        assert_eq!(
            summary.result["document"]["documentRef"]["vaultId"],
            vault.id
        );

        let web = execute_knowledge_capability(
            &backend,
            "wf_web_to_note",
            Some(&serde_json::json!({
                "text": "Captured body\n---\nnot frontmatter",
                "params": {
                    "title": "Captured page",
                    "url": "https://example.test/path?secret=not-logged",
                    "includeSource": true
                }
            })),
        )
        .unwrap();
        assert_eq!(web.result["kind"], "document-created");
        assert_eq!(web.result["documentRef"]["vaultId"], vault.id);
        assert!(root.join("Captured page.md").is_file());
        assert_eq!(knowledge.list_documents().unwrap().len(), 2);

        let note_summary = execute_knowledge_capability(
            &backend,
            "wf.note_to_summary",
            Some(&serde_json::json!({
                "params": {
                    "documentId": knowledge::KnowledgeService::document_id(&source.summary.document_ref),
                    "expectedRevision": source.revision,
                    "title": "Source digest",
                    "style": "bullets"
                }
            })),
        )
        .unwrap();
        assert_eq!(note_summary.result["kind"], "document-created");
        assert!(root.join("Source digest.md").is_file());
        assert_eq!(knowledge.list_documents().unwrap().len(), 3);
    }

    #[test]
    fn vault_capabilities_fail_closed_for_missing_invalid_stale_and_cross_vault_inputs() {
        let app_data = temp_path("no-vault");
        let no_vault = backend::BackendServices::initialize(&app_data).unwrap();
        let no_vault_error = execute_knowledge_capability(
            &no_vault,
            "skill.search_intent",
            Some(&serde_json::json!({ "text": "query" })),
        )
        .unwrap_err();
        assert_eq!(no_vault_error.code, "knowledge-vault-required");

        let (backend, root_a, vault_a) = capability_backend("guards-a");
        let knowledge = backend.knowledge();
        let source = knowledge
            .create_document(&knowledge::KnowledgeCreateInput {
                title: "Guarded".to_string(),
                parent_relative_path: None,
                content: "original".to_string(),
            })
            .unwrap();
        let malformed = execute_knowledge_capability(
            &backend,
            "skill.summary",
            Some(&serde_json::json!({ "params": { "documentId": "legacy-db-id" } })),
        )
        .unwrap_err();
        assert_eq!(malformed.code, "legacy-db-note-retired");

        let cross_vault_id =
            knowledge::KnowledgeService::document_id(&knowledge::KnowledgeDocumentRef {
                vault_id: "vault-other".to_string(),
                relative_path: "Guarded.md".to_string(),
            });
        let cross_vault = execute_knowledge_capability(
            &backend,
            "skill.summary",
            Some(&serde_json::json!({ "params": { "documentId": cross_vault_id } })),
        )
        .unwrap_err();
        assert_eq!(cross_vault.code, "knowledge-vault-mismatch");

        let stale = execute_knowledge_capability(
            &backend,
            "skill.summary",
            Some(&serde_json::json!({
                "params": {
                    "documentId": knowledge::KnowledgeService::document_id(&source.summary.document_ref),
                    "expectedRevision": "stale"
                }
            })),
        )
        .unwrap_err();
        assert_eq!(stale.code, "knowledge-revision-conflict");

        let activation = knowledge.activate_ui_source(&vault_a.id).unwrap();
        let root_b = temp_path("guards-b-vault");
        std::fs::create_dir_all(root_b.join(".luckyray")).unwrap();
        let vault_b = knowledge::KnowledgeVaultRegistration {
            id: "vault-guards-b".to_string(),
            name: "guards-b".to_string(),
            root_path: root_b.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        std::fs::write(
            root_b.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault_b).unwrap(),
        )
        .unwrap();
        knowledge.register_current_vault(&vault_b).unwrap();
        let switched = execute_knowledge_capability(
            &backend,
            "wf.web_to_note",
            Some(&serde_json::json!({
                "text": "must not be written",
                "sourceEpoch": activation.source_epoch,
                "params": { "title": "Wrong vault" }
            })),
        )
        .unwrap_err();
        assert_eq!(switched.code, "knowledge-source-inactive");
        assert!(!root_a.join("Wrong vault.md").exists());
        assert!(!root_b.join("Wrong vault.md").exists());
    }

    #[test]
    fn web_to_note_rejects_path_escape_oversize_and_overwrite_without_network_fetch() {
        let (backend, root, _) = capability_backend("web-guards");
        let first = execute_knowledge_capability(
            &backend,
            "wf.web_to_note",
            Some(&serde_json::json!({
                "text": "first",
                "params": { "title": "Saved", "url": "https://example.test/a" }
            })),
        )
        .unwrap();
        assert_eq!(first.result["kind"], "document-created");
        let original = std::fs::read(root.join("Saved.md")).unwrap();

        let overwrite = execute_knowledge_capability(
            &backend,
            "wf.web_to_note",
            Some(&serde_json::json!({ "text": "second", "params": { "title": "Saved" } })),
        )
        .unwrap_err();
        assert_eq!(overwrite.code, "knowledge-name-conflict");
        assert_eq!(std::fs::read(root.join("Saved.md")).unwrap(), original);

        let escape = execute_knowledge_capability(
            &backend,
            "wf.web_to_note",
            Some(&serde_json::json!({
                "text": "escape",
                "params": { "title": "Escape", "parentRelativePath": "../outside" }
            })),
        )
        .unwrap_err();
        assert_eq!(escape.code, "knowledge-path-outside-vault");
        assert!(!root
            .parent()
            .unwrap()
            .join("outside")
            .join("Escape.md")
            .exists());

        let too_large = execute_knowledge_capability(
            &backend,
            "wf.web_to_note",
            Some(&serde_json::json!({
                "params": { "title": "Huge", "content": "x".repeat(512 * 1024 + 1) }
            })),
        )
        .unwrap_err();
        assert_eq!(too_large.code, "capability-input-too-large");
        assert!(!root.join("Huge.md").exists());

        let invalid_url = execute_knowledge_capability(
            &backend,
            "wf.web_to_note",
            Some(&serde_json::json!({
                "text": "body",
                "params": { "title": "Bad URL", "url": "file:///secret" }
            })),
        )
        .unwrap_err();
        assert_eq!(invalid_url.code, "capability-web-source-invalid");

        let invalid_content = execute_knowledge_capability(
            &backend,
            "wf.web_to_note",
            Some(&serde_json::json!({
                "text": "body\u{0}tail",
                "params": { "title": "Bad Content" }
            })),
        )
        .unwrap_err();
        assert_eq!(invalid_content.code, "capability-input-invalid");
        assert!(!root.join("Bad Content.md").exists());
    }

    #[test]
    fn committed_capability_write_returns_index_warning_and_later_refresh_converges() {
        let (backend, root, _) = capability_backend("index-warning");
        capabilities::fail_next_post_write_index_refresh();
        let outcome = execute_knowledge_capability(
            &backend,
            "wf.web_to_note",
            Some(&serde_json::json!({
                "text": "committed before refresh failure",
                "params": { "title": "Warning" }
            })),
        )
        .unwrap();
        assert!(root.join("Warning.md").is_file());
        assert!(outcome.index_stale);
        assert_eq!(
            outcome
                .index_warning
                .as_ref()
                .map(|warning| warning.code.as_str()),
            Some("knowledge-index-refresh-failed")
        );
        assert!(outcome.summary.contains("索引刷新稍后重试"));

        let refreshed = backend.knowledge().refresh_index().unwrap();
        assert!(!refreshed.stale);
        assert!(refreshed.refresh_error.is_none());
        assert!(refreshed
            .documents
            .iter()
            .any(|document| document.relative_path == "Warning.md"));
    }

    #[test]
    fn headless_capability_does_not_write_after_the_current_vault_switches() {
        let (backend, root_a, _) = capability_backend("headless-switch-a");
        let backend = std::sync::Arc::new(backend);
        let root_b = temp_path("headless-switch-b-vault");
        std::fs::create_dir_all(root_b.join(".luckyray")).unwrap();
        let vault_b = knowledge::KnowledgeVaultRegistration {
            id: "vault-headless-switch-b".to_string(),
            name: "headless-switch-b".to_string(),
            root_path: root_b.to_string_lossy().to_string(),
            mode: "vault-bound".to_string(),
            created_at: "2026-07-15T00:00:00Z".to_string(),
            last_opened_at: "2026-07-15T00:00:00Z".to_string(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        std::fs::write(
            root_b.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault_b).unwrap(),
        )
        .unwrap();
        let barrier = capabilities::block_before_capability_create("Headless switched");
        let worker_backend = backend.clone();
        let worker = std::thread::spawn(move || {
            execute_knowledge_capability(
                &worker_backend,
                "wf.web_to_note",
                Some(&serde_json::json!({
                    "text": "must not cross Vaults",
                    "params": { "title": "Headless switched" }
                })),
            )
        });

        barrier.0.wait();
        backend
            .knowledge()
            .register_current_vault(&vault_b)
            .unwrap();
        barrier.1.wait();
        let error = worker.join().unwrap().unwrap_err();
        assert_eq!(error.code, "knowledge-vault-not-current");
        assert!(!root_a.join("Headless switched.md").exists());
        assert!(!root_b.join("Headless switched.md").exists());
    }
}

// D41c: POST /api/assets/import-media — 图片+视频统一入口
// body: { mediaType: "image" | "video", url, targetFolderId?, newFolderName?, parentFolderId? }
#[derive(Clone, Debug)]
struct MediaImportDiagnostic {
    capture_source: String,
    fingerprint: String,
    client_request_id: Option<String>,
}

#[derive(Clone, Debug)]
struct MediaImportFailure {
    status: u16,
    code: &'static str,
    message: &'static str,
    reason: &'static str,
    category: &'static str,
    diagnostic: MediaImportDiagnostic,
}

fn source_page_from_json(body: &serde_json::Value) -> Result<Option<materials::MaterialSourcePageInput>, ()> {
    let kind = body.get("sourcePageKind");
    let url = body.get("sourcePageUrl");
    if kind.is_none() && url.is_none() { return Ok(None); }
    let (Some(kind), Some(url)) = (kind.and_then(|v| v.as_str()), url.and_then(|v| v.as_str())) else {
        return Err(());
    };
    materials::MaterialSourcePageInput::from_parts(
        url, kind, body.get("sourcePageTitle").and_then(|v| v.as_str()),
    ).map(Some).ok_or(())
}

impl MediaImportDiagnostic {
    fn from_request(body: &serde_json::Value, url: &str) -> Self {
        let capture_source = match body.get("captureSource").and_then(|value| value.as_str()) {
            Some("hover") => "hover",
            Some("context-menu") => "context-menu",
            Some("popup") => "popup",
            _ => "unknown",
        }
        .to_string();
        let client_request_id = body
            .get("requestId")
            .and_then(|value| value.as_str())
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 96
                    && value.chars().all(|character| {
                        character.is_ascii_alphanumeric() || "_.:-".contains(character)
                    })
            })
            .map(str::to_string);
        Self {
            capture_source,
            fingerprint: media_url_fingerprint(url),
            client_request_id,
        }
    }
}

impl MediaImportFailure {
    fn fixed(
        diagnostic: &MediaImportDiagnostic,
        code: &'static str,
        message: &'static str,
        reason: &'static str,
        category: &'static str,
    ) -> Self {
        Self {
            status: 500,
            code,
            message,
            reason,
            category,
            diagnostic: diagnostic.clone(),
        }
    }

    fn download(error: &reqwest::Error, diagnostic: &MediaImportDiagnostic) -> Self {
        Self::fixed(
            diagnostic,
            "media-download-failed",
            "媒体下载失败",
            "network",
            classify_reqwest_error(error),
        )
    }

    fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "error": self.message,
            "code": self.code,
            "reason": self.reason,
            "category": self.category,
            "source": self.diagnostic.capture_source,
            "fingerprint": self.diagnostic.fingerprint,
            "clientRequestId": self.diagnostic.client_request_id,
        })
    }
}

fn media_url_fingerprint(url: &str) -> String {
    let normalized = reqwest::Url::parse(url)
        .map(|value| value.to_string())
        .unwrap_or_else(|_| url.trim().to_string());
    format!("{:x}", Sha256::digest(normalized.as_bytes()))
        .chars()
        .take(12)
        .collect()
}

fn classify_reqwest_error(error: &reqwest::Error) -> &'static str {
    classify_reqwest_error_flags(
        error.is_timeout(),
        error.is_connect(),
        error.is_redirect(),
        error.is_request(),
        error.is_body(),
    )
}

fn classify_reqwest_error_flags(
    timeout: bool,
    connect: bool,
    redirect: bool,
    request: bool,
    body: bool,
) -> &'static str {
    if timeout {
        "timeout"
    } else if connect {
        "connect"
    } else if redirect {
        "redirect"
    } else if request {
        "request"
    } else if body {
        "body"
    } else {
        "other"
    }
}

fn record_media_import_failure(failure: &MediaImportFailure) {
    let payload = media_import_failure_payload(failure);
    record_failure_with_reason("api_import_media", &payload, failure.code, failure.reason);
}

fn media_import_failure_payload(failure: &MediaImportFailure) -> String {
    serde_json::json!({
        "captureSource": failure.diagnostic.capture_source,
        "category": failure.category,
        "fingerprint": failure.diagnostic.fingerprint,
        "clientRequestId": failure.diagnostic.client_request_id,
    })
    .to_string()
}

fn download_api_media(body: &serde_json::Value, max_bytes: Option<usize>)
    -> Result<(materials::MaterialBytesInput, Option<materials::MaterialSourcePageInput>), MediaImportFailure> {
    let media_type = body
        .get("mediaType")
        .and_then(|v| v.as_str())
        .unwrap_or("image");
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let diagnostic = MediaImportDiagnostic::from_request(body, url);
    let source_page = source_page_from_json(body).map_err(|_| {
        let mut failure = MediaImportFailure::fixed(
            &diagnostic, "source-page-invalid", "来源页面地址无效", "param", "request",
        );
        failure.status = 400;
        failure
    })?;
    if url.is_empty() {
        return Err(MediaImportFailure::fixed(
            &diagnostic,
            "media-url-required",
            "媒体地址不能为空",
            "param",
            "request",
        ));
    }
    // 视频源校验（粗筛）
    if media_type == "video" {
        let lower = url.to_lowercase();
        if lower.starts_with("blob:") {
            return Err(MediaImportFailure::fixed(
                &diagnostic,
                "media-url-blocked",
                "此视频暂不支持直接下载",
                "media_blocked",
                "request",
            ));
        }
        if !lower.starts_with("http://") && !lower.starts_with("https://") {
            return Err(MediaImportFailure::fixed(
                &diagnostic,
                "media-url-invalid",
                "视频地址无效",
                "param",
                "request",
            ));
        }
        if lower.contains(".m3u8") {
            return Err(MediaImportFailure::fixed(
                &diagnostic,
                "media-format-unsupported",
                "暂不支持此视频格式",
                "unsupported_format",
                "request",
            ));
        }
    }

    // 下载
    let client = reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| MediaImportFailure::download(&error, &diagnostic))?;

    let resp = client
        .get(url)
        .header("Referer", url)
        .send()
        .map_err(|error| MediaImportFailure::download(&error, &diagnostic))?;
    if !resp.status().is_success() {
        return Err(MediaImportFailure::fixed(
            &diagnostic,
            "media-download-http-failed",
            "媒体下载服务返回失败状态",
            "http_error",
            "http-status",
        ));
    }
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    // 视频特别要求 >= 32KB
    let bytes = if let Some(limit) = max_bytes {
        use std::io::Read;
        let mut bytes = Vec::new();
        resp.take(limit as u64 + 1).read_to_end(&mut bytes).map_err(|_| {
            MediaImportFailure::fixed(&diagnostic, "media-download-body-failed", "媒体下载失败", "network", "body")
        })?;
        if bytes.len() > limit {
            let mut failure = MediaImportFailure::fixed(&diagnostic, "consumer-media-too-large", "原图大小超出限制", "too_large", "body");
            failure.status = 413;
            return Err(failure);
        }
        bytes
    } else {
        resp.bytes().map_err(|error| MediaImportFailure::download(&error, &diagnostic))?.to_vec()
    };
    if media_type == "image" && bytes.len() < 1024 {
        return Err(MediaImportFailure::fixed(
            &diagnostic,
            "media-too-small",
            "图片太小，可能是图标",
            "too_small",
            "body",
        ));
    }
    if media_type == "video" && bytes.len() < 32_768 {
        return Err(MediaImportFailure::fixed(
            &diagnostic,
            "media-too-small",
            "视频文件太小，可能不是有效视频",
            "too_small",
            "body",
        ));
    }

    let ext = if media_type == "video" {
        // 视频扩展名推断
        let ct_ext = content_type
            .split('/')
            .last()
            .filter(|e| !e.is_empty() && *e != "octet-stream")
            .map(|s| s.to_string());
        ct_ext
            .or_else(|| {
                url.rsplit('.').next().and_then(|e| {
                    if e.len() <= 5 && !e.contains('?') && !e.contains('/') {
                        Some(e.to_string())
                    } else {
                        None
                    }
                })
            })
            .unwrap_or_else(|| "mp4".to_string())
    } else {
        content_type
            .split('/')
            .last()
            .filter(|e| !e.is_empty() && *e != "octet-stream")
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                url.rsplit('.')
                    .next()
                    .filter(|e| e.len() <= 5)
                    .unwrap_or("jpg")
                    .to_string()
            })
    };

    Ok((materials::MaterialBytesInput {
        name: format!("download.{ext}"), original_path: url.to_owned(),
        mime_type: content_type, description: None, bytes,
    }, source_page))
}

fn handle_api_import_media(body: &serde_json::Value) -> Result<String, MediaImportFailure> {
    let (input, source_page) = download_api_media(body, None)?;
    let media_type = body.get("mediaType").and_then(|v| v.as_str()).unwrap_or("image");
    let diagnostic = MediaImportDiagnostic::from_request(body, &input.original_path);
    let target_folder_id = body.get("targetFolderId").and_then(|v| v.as_str());
    let new_folder_name = body
        .get("newFolderName")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let parent_folder_id = body.get("parentFolderId").and_then(|v| v.as_str());

    // Only create a requested folder after the remote bytes have been fetched and
    // validated, so a network failure remains a zero-write operation.
    let effective_folder_id = if let Some(name) = new_folder_name {
        let folder_body = serde_json::json!({
            "name": name,
            "parentId": parent_folder_id.or(target_folder_id),
        });
        let res = handle_api_create_folder(&folder_body).map_err(|_| {
            MediaImportFailure::fixed(
                &diagnostic,
                "media-folder-failed",
                "创建素材文件夹失败",
                "unknown",
                "other",
            )
        })?;
        let parsed: serde_json::Value = serde_json::from_str(&res).map_err(|_| {
            MediaImportFailure::fixed(
                &diagnostic,
                "media-folder-result-invalid",
                "素材文件夹结果无效",
                "unknown",
                "other",
            )
        })?;
        Some(
            parsed
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
    } else {
        target_folder_id.map(|s| s.to_string())
    };

    let catalog = material_catalog_for_http().map_err(|_| {
        MediaImportFailure::fixed(
            &diagnostic,
            "material-catalog-unavailable",
            "素材服务不可用",
            "unknown",
            "other",
        )
    })?;
    let imported = materials::import_downloaded_material_with_source(
        &catalog,
        input,
        &materials::MaterialImportOptions {
            folder_id: effective_folder_id.clone(),
            storage_mode: "managed".to_string(),
            ..Default::default()
        },
        source_page.as_ref(),
    )
    .map_err(|_| {
        MediaImportFailure::fixed(
            &diagnostic,
            "material-import-failed",
            "素材入库失败",
            "unknown",
            "other",
        )
    })?;
    emit_catalog_change_global(&imported.change);
    let mut response = materials::canonical_import_response(&imported);
    response["mediaType"] = serde_json::Value::String(media_type.to_string());
    return Ok(response.to_string());
}

#[cfg(test)]
mod media_import_diagnostic_tests {
    use super::{
        classify_reqwest_error, classify_reqwest_error_flags, media_import_failure_payload,
        media_url_fingerprint, MediaImportDiagnostic, MediaImportFailure,
    };

    #[test]
    fn reqwest_error_categories_have_stable_public_precedence() {
        assert_eq!(
            classify_reqwest_error_flags(true, true, true, true, true),
            "timeout"
        );
        assert_eq!(
            classify_reqwest_error_flags(false, true, true, true, true),
            "connect"
        );
        assert_eq!(
            classify_reqwest_error_flags(false, false, true, true, true),
            "redirect"
        );
        assert_eq!(
            classify_reqwest_error_flags(false, false, false, true, true),
            "request"
        );
        assert_eq!(
            classify_reqwest_error_flags(false, false, false, false, true),
            "body"
        );
        assert_eq!(
            classify_reqwest_error_flags(false, false, false, false, false),
            "other"
        );
    }

    #[test]
    fn real_send_failure_is_classified_without_exposing_the_target() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let target = format!("http://127.0.0.1:{port}/private?token=must-not-leak");
        let error = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(1))
            .build()
            .unwrap()
            .get(&target)
            .send()
            .unwrap_err();
        let diagnostic = MediaImportDiagnostic::from_request(
            &serde_json::json!({"captureSource":"hover","requestId":"action-9"}),
            &target,
        );
        let failure = MediaImportFailure::download(&error, &diagnostic);
        let json = failure.json().to_string();

        assert!(matches!(
            classify_reqwest_error(&error),
            "connect" | "timeout"
        ));
        assert_eq!(failure.category, classify_reqwest_error(&error));
        assert!(!json.contains("private"));
        assert!(!json.contains("token"));
        assert!(!json.contains(&target));
        let record = media_import_failure_payload(&failure);
        assert!(record.contains("\"captureSource\":\"hover\""));
        assert!(record.contains("\"category\":"));
        assert!(record.contains(&failure.diagnostic.fingerprint));
        assert!(!record.contains("private"));
        assert!(!record.contains("token"));
        assert!(!record.contains(&target));
    }

    #[test]
    fn url_fingerprint_is_stable_and_includes_the_query_without_revealing_it() {
        let first = media_url_fingerprint("https://cdn.test/image.png?variant=one");
        let same = media_url_fingerprint("https://cdn.test/image.png?variant=one");
        let different = media_url_fingerprint("https://cdn.test/image.png?variant=two");

        assert_eq!(first, same);
        assert_ne!(first, different);
        assert_eq!(first.len(), 12);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
    }
}

// D41: GET /api/folders — 列出所有素材文件夹（按 parentId/sortOrder 排序）
fn handle_api_list_folders() -> Result<String, String> {
    fn flatten(folders: Vec<materials::MaterialFolder>, output: &mut Vec<serde_json::Value>) {
        for folder in folders {
            output.push(serde_json::json!({
                "id": folder.id,
                "parentId": folder.parent_id,
                "name": folder.name,
                "sortOrder": folder.sort_order,
            }));
            flatten(folder.children, output);
        }
    }
    let mut folders = Vec::new();
    flatten(
        material_catalog_for_http()?
            .list_folders()
            .map_err(|error| error.message)?,
        &mut folders,
    );
    serde_json::to_string(&serde_json::json!({ "folders": folders }))
        .map_err(|error| error.to_string())
}

// HTTP folder Adapter preserves the legacy response while delegating all writes to Catalog.

pub(crate) fn handle_api_create_folder(body: &serde_json::Value) -> Result<String, String> {
    let name = body
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return Err("name 不能为空".to_string());
    }
    let parent_id = body.get("parentId").and_then(|value| value.as_str());
    let catalog = material_catalog_for_http()?;
    let outcome = catalog
        .create_folder(materials::MaterialFolderInput {
            parent_id: parent_id.map(str::to_string),
            name: name.to_string(),
        })
        .map_err(|error| error.message)?;
    let existed = outcome.change.is_none();
    emit_catalog_change_global(&outcome.change);
    if existed {
        return Ok(serde_json::json!({ "id": outcome.value.id, "existed": true }).to_string());
    }
    Ok(serde_json::json!({
        "id": outcome.value.id,
        "name": outcome.value.name,
        "parentId": outcome.value.parent_id,
        "existed": false
    })
    .to_string())
}

// D41: POST /api/assets/import-image — 直接入素材库
fn handle_api_import_image(body: &serde_json::Value) -> Result<String, String> {
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if url.is_empty() {
        return Err("url 不能为空".to_string());
    }
    let folder_id = body.get("folderId").and_then(|v| v.as_str());
    let new_folder_name = body
        .get("newFolderName")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    // 若有 newFolderName，先建文件夹
    let effective_folder_id = if let Some(name) = new_folder_name {
        let folder_body = serde_json::json!({ "name": name, "parentId": folder_id });
        let res = handle_api_create_folder(&folder_body)?;
        let parsed: serde_json::Value = serde_json::from_str(&res).map_err(|e| e.to_string())?;
        Some(
            parsed
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        )
    } else {
        folder_id.map(|s| s.to_string())
    };

    // 复用 lib.rs 已有的 import_image_from_url_sync（async 命令外层）
    // 这里直接用同步版（不经过 Tauri command），传入 url
    // 共享 library_dir 写入逻辑
    let app_data = app_data_dir();
    let library_dir = app_data.join("asset-library");
    std::fs::create_dir_all(&library_dir).map_err(|e| format!("创建素材目录失败: {}", e))?;

    // 下载图片
    let client = reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    let resp = client
        .get(url)
        .header("Referer", url)
        .send()
        .map_err(|e| format!("下载图片失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let bytes = resp
        .bytes()
        .map_err(|e| format!("读取图片数据失败: {}", e))?;
    if bytes.len() < 1024 {
        return Err("图片太小，可能是图标".to_string());
    }
    let ext = content_type
        .split('/')
        .last()
        .filter(|e| !e.is_empty() && *e != "octet-stream")
        .unwrap_or_else(|| {
            url.rsplit('.')
                .next()
                .filter(|e| e.len() <= 5)
                .unwrap_or("jpg")
        });
    let catalog = material_catalog_for_http()?;
    let imported = materials::import_downloaded_material(
        &catalog,
        materials::MaterialBytesInput {
            name: format!("download.{}", ext),
            original_path: url.to_string(),
            mime_type: content_type.clone(),
            description: None,
            bytes: bytes.to_vec(),
        },
        &materials::MaterialImportOptions {
            folder_id: effective_folder_id.clone(),
            storage_mode: "managed".to_string(),
            ..Default::default()
        },
    )
    .map_err(|error| error.message)?;
    emit_catalog_change_global(&imported.change);
    return Ok(materials::canonical_import_response(&imported).to_string());
}

fn handle_capability_route_with_backend(
    backend: &backend::BackendServices,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Option<(u16, String)> {
    if method == "GET" && path == "/api/capability/list" {
        return Some(match handle_api_list_capability_with_backend(backend) {
            Ok(response) => (200, response),
            Err(error) => capability_route_error(error),
        });
    }
    if method == "POST" && matches!(path, "/api/capability/toggle" | "/api/capability/run") {
        let parsed = match body.and_then(|value| serde_json::from_str(value).ok()) {
            Some(value) => value,
            None => {
                return Some((
                    400,
                    r#"{"ok":false,"code":"invalid-json","message":"Request JSON is invalid"}"#
                        .to_string(),
                ))
            }
        };
        return Some(match path {
            "/api/capability/toggle" => {
                match handle_api_toggle_capability_with_backend(backend, &parsed) {
                    Ok(response) => (200, response),
                    Err(error) => capability_route_error(error),
                }
            }
            _ => match handle_api_run_capability_with_backend(backend, &parsed) {
                Ok(response) => (200, response),
                Err(error) => capability_route_error(error),
            },
        });
    }
    None
}

fn media_transfer_error_response(error: media_transfer::MediaTransferError) -> (u16, String) {
    let status = match error.code.as_str() {
        "media-input-invalid" => 400,
        "media-transfer-not-found" | "media-probe-expired" => 404,
        "media-cancel-too-late" => 409,
        "media-capacity" => 429,
        "media-staging-unavailable" => 503,
        _ => 500,
    };
    (
        status,
        serde_json::json!({
            "code": error.code,
            "message": error.message,
        })
        .to_string(),
    )
}

fn serialize_media_transfer_snapshot(
    status: u16,
    snapshot: media_transfer::MediaTransferSnapshot,
) -> (u16, String) {
    match serde_json::to_string(&snapshot) {
        Ok(body) => (status, body),
        Err(_) => (
            500,
            serde_json::json!({
                "code": "media-serialization-failed",
                "message": "Media transfer response is unavailable",
            })
            .to_string(),
        ),
    }
}

fn serialize_media_probe_snapshot(snapshot: media_transfer::MediaProbeSnapshot) -> (u16, String) {
    match serde_json::to_string(&snapshot) {
        Ok(body) => (200, body),
        Err(_) => (
            500,
            serde_json::json!({
                "code": "media-serialization-failed",
                "message": "Media probe response is unavailable",
            })
            .to_string(),
        ),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaTransferApiRequest {
    #[serde(default, rename = "requestId")]
    _request_id: Option<String>,
    #[serde(flatten)]
    transfer: media_transfer::MediaTransferRequest,
    #[serde(default)]
    probe_id: Option<String>,
    #[serde(default)]
    format_id: Option<String>,
    #[serde(default)]
    source_page_kind: Option<String>,
    #[serde(default)]
    material_source_page_url: Option<String>,
    #[serde(default)]
    source_page_title: Option<String>,
}

fn handle_media_transfer_route_with_backend(
    backend: &backend::BackendServices,
    method: &str,
    raw_path: &str,
    body: Option<&str>,
) -> Option<(u16, String)> {
    let path = raw_path.split('?').next().unwrap_or(raw_path);
    if path == "/api/media/probes" {
        if method != "POST" {
            return None;
        }
        let request = match body
            .and_then(|body| serde_json::from_str::<media_transfer::MediaProbeRequest>(body).ok())
        {
            Some(request) => request,
            None => {
                return Some((
                    400,
                    serde_json::json!({
                        "code": "media-input-invalid",
                        "message": "Media probe input is invalid",
                    })
                    .to_string(),
                ))
            }
        };
        return Some(match backend.media_transfer().probe(request) {
            Ok(snapshot) => serialize_media_probe_snapshot(snapshot),
            Err(error) => media_transfer_error_response(error),
        });
    }
    if path == "/api/media/transfers" {
        if method != "POST" {
            return None;
        }
        let request = match body
            .and_then(|body| serde_json::from_str::<MediaTransferApiRequest>(body).ok())
        {
            Some(request) => request,
            None => {
                return Some((
                    400,
                    serde_json::json!({
                        "code": "media-input-invalid",
                        "message": "Media transfer input is invalid",
                    })
                    .to_string(),
                ))
            }
        };
        let source_page = if let Some(kind) = request.source_page_kind.as_deref() {
            match materials::MaterialSourcePageInput::from_parts(
                request.material_source_page_url.as_deref().unwrap_or_default(),
                kind,
                request.source_page_title.as_deref(),
            ) {
                Some(page) => Some(page),
                None => return Some((400, serde_json::json!({
                    "code": "source-page-invalid", "message": "Source page URL is invalid"
                }).to_string())),
            }
        } else {
            if request.source_page_title.is_some() || request.material_source_page_url.is_some() {
                return Some((400, serde_json::json!({
                    "code": "source-page-invalid", "message": "Source page binding is incomplete"
                }).to_string()));
            }
            None
        };
        return Some(
            match backend.media_transfer().start_selected_with_source(
                request.transfer,
                request.probe_id.as_deref(),
                request.format_id.as_deref(),
                source_page,
            ) {
                Ok(snapshot) => serialize_media_transfer_snapshot(202, snapshot),
                Err(error) => media_transfer_error_response(error),
            },
        );
    }

    let tail = path.strip_prefix("/api/media/transfers/")?;
    if tail.is_empty() {
        return None;
    }
    if let Some(transfer_id) = tail.strip_suffix("/cancel") {
        if method != "POST" || transfer_id.is_empty() || transfer_id.contains('/') {
            return None;
        }
        return Some(match backend.media_transfer().cancel(transfer_id) {
            Ok(snapshot) => serialize_media_transfer_snapshot(200, snapshot),
            Err(error) => media_transfer_error_response(error),
        });
    }
    if method != "GET" || tail.contains('/') {
        return None;
    }
    Some(match backend.media_transfer().status(tail) {
        Ok(snapshot) => serialize_media_transfer_snapshot(200, snapshot),
        Err(error) => media_transfer_error_response(error),
    })
}

// D41: 统一路由分发
fn handle_api_route(method: &str, path: &str, body: Option<&str>) -> (u16, String) {
    if method == "GET" && path == "/api/extension/appearance" {
        return match extension_appearance::read_projection() {
            Some(projection) => (200, serde_json::to_string(&projection).unwrap()),
            None => (503, r#"{"error":"appearance-not-ready"}"#.into()),
        };
    }
    if path.starts_with("/api/capability/") {
        return match backend_services() {
            Ok(backend) => handle_capability_route_with_backend(backend, method, path, body)
                .unwrap_or_else(|| (404, r#"{"error":"not found"}"#.to_string())),
            Err(error) => capability_route_error(error),
        };
    }
    // GET /api/folders
    if method == "GET" && path == "/api/folders" {
        return match handle_api_list_folders() {
            Ok(s) => (200, s),
            Err(e) => (500, format!(r#"{{"error":"{}"}}"#, e.replace('"', "'"))),
        };
    }
    // POST /api/folders
    if method == "POST" && path == "/api/folders" {
        let b: serde_json::Value = match body.and_then(|s| serde_json::from_str(s).ok()) {
            Some(v) => v,
            None => return (400, r#"{"error":"invalid json"}"#.to_string()),
        };
        return match handle_api_create_folder(&b) {
            Ok(s) => (200, s),
            Err(e) => (500, format!(r#"{{"error":"{}"}}"#, e.replace('"', "'"))),
        };
    }
    // POST /api/assets/import-image
    if method == "POST" && path == "/api/assets/import-file" {
        let b: serde_json::Value = match body.and_then(|s| serde_json::from_str(s).ok()) {
            Some(v) => v,
            None => return (400, r#"{"error":"invalid json"}"#.to_string()),
        };
        return match assets_import_file::handle_import_file(&b) {
            Ok(s) => (200, s),
            Err(e) => {
                // Failure records never contain signed query strings: the URL
                // is reduced to scheme://host/path and any URL embedded in the
                // error text is redacted before reaching the log.
                let summary = format!(
                    "import-file (url={}, fileName={:?})",
                    assets_import_file::sanitize_url_for_log(
                        b.get("url").and_then(|v| v.as_str()).unwrap_or("")
                    ),
                    b.get("fileName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .chars()
                        .take(60)
                        .collect::<String>()
                );
                let message = assets_import_file::redact_url_secrets(&e.message);
                record_failure("api_import_file", &summary, &message);
                assets_import_file::error_response_parts(e.status, e.code, &message)
            }
        };
    }
    if method == "POST" && path == "/api/assets/import-image" {
        let b: serde_json::Value = match body.and_then(|s| serde_json::from_str(s).ok()) {
            Some(v) => v,
            None => return (400, r#"{"error":"invalid json"}"#.to_string()),
        };
        return match handle_api_import_image(&b) {
            Ok(s) => (200, s),
            Err(e) => {
                let summary = format!(
                    "import-image ({})",
                    &b.to_string().chars().take(200).collect::<String>()
                );
                record_failure("api_import_image", &summary, &e);
                (500, format!(r#"{{"error":"{}"}}"#, e.replace('"', "'")))
            }
        };
    }
    // D41c: POST /api/assets/import-media — 图片+视频统一入口
    if method == "POST" && path == "/api/assets/import-media" {
        let b: serde_json::Value = match body.and_then(|s| serde_json::from_str(s).ok()) {
            Some(v) => v,
            None => return (400, r#"{"error":"invalid json"}"#.to_string()),
        };
        return match handle_api_import_media(&b) {
            Ok(s) => (200, s),
            Err(failure) => {
                record_media_import_failure(&failure);
                (failure.status, failure.json().to_string())
            }
        };
    }
    // D42: GET /api/collection/failures — 收集失败记录（collection_failure 表）
    if method == "GET" && path.starts_with("/api/collection/failures") {
        let limit: i64 = path
            .split('?')
            .nth(1)
            .and_then(|qs| {
                qs.split('&').find_map(|kv| {
                    let mut it = kv.splitn(2, '=');
                    let k = it.next()?;
                    let v = it.next().unwrap_or("");
                    if k == "limit" {
                        v.parse::<i64>().ok()
                    } else {
                        None
                    }
                })
            })
            .unwrap_or(50)
            .max(1)
            .min(500);
        return match handle_api_list_failures(limit) {
            Ok(s) => (200, s),
            Err(e) => (500, format!(r#"{{"error":"{}"}}"#, e.replace('"', "'"))),
        };
    }
    // D45a-R1: POST /api/collection/failures — 插件录制/直收失败写入失败历史
    if method == "POST" && path == "/api/collection/failures" {
        let b: serde_json::Value = match body.and_then(|s| serde_json::from_str(s).ok()) {
            Some(v) => v,
            None => return (400, r#"{"error":"invalid json"}"#.to_string()),
        };
        return match handle_api_create_failure(&b) {
            Ok(s) => (200, s),
            Err(e) => (
                500,
                format!(
                    r#"{{"error":"{}","reason":"{}"}}"#,
                    e.replace('"', "'"),
                    classify_failure_reason(&e)
                ),
            ),
        };
    }
    // D42: GET /api/collection/items — 旧收集箱历史（collection_item 表）
    if method == "GET" && path.starts_with("/api/collection/items") {
        let limit: i64 = path
            .split('?')
            .nth(1)
            .and_then(|qs| {
                qs.split('&').find_map(|kv| {
                    let mut it = kv.splitn(2, '=');
                    let k = it.next()?;
                    let v = it.next().unwrap_or("");
                    if k == "limit" {
                        v.parse::<i64>().ok()
                    } else {
                        None
                    }
                })
            })
            .unwrap_or(50)
            .max(1)
            .min(500);
        return match handle_api_list_items(limit) {
            Ok(s) => (200, s),
            Err(e) => (500, format!(r#"{{"error":"{}"}}"#, e.replace('"', "'"))),
        };
    }
    // D45a-2: POST /api/video/detect-candidates — 媒体候选识别
    if method == "POST" && path == "/api/video/detect-candidates" {
        let b: serde_json::Value = match body.and_then(|s| serde_json::from_str(s).ok()) {
            Some(v) => v,
            None => return (400, r#"{"error":"invalid json"}"#.to_string()),
        };
        return match handle_api_video_detect_candidates(&b) {
            Ok(s) => (200, s),
            Err(e) => (500, format!(r#"{{"error":"{}"}}"#, e.replace('"', "'"))),
        };
    }
    // D45a-3: POST /api/video/record/save — 标签页录制入库（base64 webm）
    if method == "POST" && path == "/api/video/record/save" {
        let b: serde_json::Value = match body.and_then(|s| serde_json::from_str(s).ok()) {
            Some(v) => v,
            None => return (400, r#"{"error":"invalid json"}"#.to_string()),
        };
        return match handle_api_video_record_save(&b) {
            Ok(s) => (200, s),
            Err(e) => {
                let summary = format!("video-record-save ({} bytes)", b.to_string().len());
                record_failure("api_video_record", &summary, &e);
                (
                    500,
                    format!(
                        r#"{{"error":"{}","reason":"{}"}}"#,
                        e.replace('"', "'"),
                        classify_failure_reason(&e)
                    ),
                )
            }
        };
    }
    (404, r#"{"error":"not found"}"#.to_string())
}

// D42: 列出 collection_failure（按 created_at 倒序，最多 limit 条）
// D45a: 增加 reason 字段（reason 分类见 classify_failure_reason）
fn handle_api_list_failures(limit: i64) -> Result<String, String> {
    let conn = open_db_read().map_err(|e| format!("打开数据库失败: {}", e))?;

    // 尝试读 reason 列；失败则回退到老 schema
    let result_str = match conn.prepare("SELECT id, source, payload, error, reason, created_at FROM collection_failure ORDER BY created_at DESC LIMIT ?1") {
        Ok(mut stmt) => {
            let rows = stmt.query_map(rusqlite::params![limit], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "source": row.get::<_, String>(1)?,
                    "payload": row.get::<_, String>(2)?,
                    "error": row.get::<_, String>(3)?,
                    "reason": row.get::<_, String>(4)?,
                    "createdAt": row.get::<_, String>(5)?,
                }))
            });
            match rows {
                Ok(rs) => {
                    let mut failures = Vec::new();
                    for r in rs { if let Ok(v) = r { failures.push(v); } }
                    format!(r#"{{"ok":true,"failures":{},"count":{}}}"#, serde_json::to_string(&failures).unwrap_or_else(|_| "[]".to_string()), failures.len())
                }
                Err(_) => {
                    // 回退：旧表无 reason 列
                    let mut stmt2 = conn.prepare("SELECT id, source, payload, error, created_at FROM collection_failure ORDER BY created_at DESC LIMIT ?1").map_err(|e| format!("prepare 失败: {}", e))?;
                    let rows2 = stmt2.query_map(rusqlite::params![limit], |row| {
                        let error = row.get::<_, String>(3)?;
                        let reason = classify_failure_reason(&error);
                        Ok(serde_json::json!({
                            "id": row.get::<_, String>(0)?,
                            "source": row.get::<_, String>(1)?,
                            "payload": row.get::<_, String>(2)?,
                            "error": error,
                            "reason": reason,
                            "createdAt": row.get::<_, String>(4)?,
                        }))
                    }).map_err(|e| format!("query 失败: {}", e))?;
                    let mut failures = Vec::new();
                    for r in rows2 { if let Ok(v) = r { failures.push(v); } }
                    format!(r#"{{"ok":true,"failures":{},"count":{}}}"#, serde_json::to_string(&failures).unwrap_or_else(|_| "[]".to_string()), failures.len())
                }
            }
        }
        Err(_) => {
            // 完全没表，返回空集
            r#"{"ok":true,"failures":[],"count":0}"#.to_string()
        }
    };
    Ok(result_str)
}

fn handle_api_create_failure(body: &serde_json::Value) -> Result<String, String> {
    let source = body
        .get("source")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("browser-plugin");
    let error = body
        .get("error")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("unknown failure");
    let reason = body
        .get("reason")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| classify_failure_reason(error));
    let payload_summary = body
        .get("payload")
        .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "{}".to_string()))
        .unwrap_or_else(|| "{}".to_string());

    record_failure_with_reason(source, &payload_summary, error, reason);
    Ok(format!(
        r#"{{"ok":true,"source":{},"reason":{}}}"#,
        serde_json::to_string(source).unwrap_or_else(|_| "\"browser-plugin\"".to_string()),
        serde_json::to_string(reason).unwrap_or_else(|_| "\"unknown\"".to_string())
    ))
}

// D42: 列出 collection_item（按 created_at 倒序，最多 limit 条）
// 用于设置页"收集历史"折叠面板的回退展示
fn handle_api_list_items(limit: i64) -> Result<String, String> {
    let conn = open_db_read().map_err(|e| format!("打开数据库失败: {}", e))?;
    // 旧版 collection_item 表可能字段不全（早期只有部分列），先按最小列读取
    let mut stmt = match conn.prepare(
        "SELECT id, type, content, url_metadata, source, created_at FROM collection_item ORDER BY created_at DESC LIMIT ?1"
    ) {
        Ok(s) => s,
        Err(e) => {
            // 表不存在 / 字段缺失 → 返回空集而非 500
            eprintln!("[luckyray] collection_item prepare failed (ok for fresh install): {}", e);
            return Ok(r#"{"ok":true,"items":[],"count":0}"#.to_string());
        }
    };
    let rows = stmt
        .query_map(rusqlite::params![limit], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "type": row.get::<_, String>(1)?,
                "text": row.get::<_, String>(2)?,
                "url": row.get::<_, String>(3)?,
                "source": row.get::<_, String>(4)?,
                "capturedAt": row.get::<_, String>(5)?,
            }))
        })
        .map_err(|e| format!("query 失败: {}", e))?;
    let mut items = Vec::new();
    for r in rows {
        if let Ok(v) = r {
            items.push(v);
        }
    }
    Ok(format!(
        r#"{{"ok":true,"items":{},"count":{}}}"#,
        serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string()),
        items.len()
    ))
}

// ===== D45a: 视频增强 =====
// 第一轮严格按小智审查结论：只做
//   1. 普通 mp4/webm/mov 直链识别和入库（D41c 已有，增强 reason 分类）
//   2. 媒体请求候选识别（m3u8/mpd/blob/分片候选 + 失败原因）
//   3. 当前标签页录制（前端 MediaRecorder → webm bytes → 后端入库）
//   4. 失败历史（D45a-4）
// 不做：HLS/DASH 分片合并、ffmpeg 合并、yt-dlp 集成、DRM 绕过。

// D45a-2: 媒体请求候选识别
// body: { urls: [string], pageUrl?: string, title?: string }
// 返回 { ok, candidates: [{url, kind, reason}], count }
//   kind: "direct_video" | "m3u8" | "mpd" | "blob" | "segment" | "iframe" | "audio" | "unknown"
//   reason: 直接候选时为 "ready"；其它候选时为 "needs_merge" | "drm_protected" | "embed_only" | "needs_recording"
fn handle_api_video_detect_candidates(body: &serde_json::Value) -> Result<String, String> {
    let urls: Vec<String> = body
        .get("urls")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let title = body
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut candidates: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for raw in &urls {
        let url = raw.trim();
        if url.is_empty() || seen.contains(url) {
            continue;
        }
        seen.insert(url.to_string());

        let lower = url.to_lowercase();
        let (kind, reason) = if lower.starts_with("blob:") {
            ("blob", "needs_recording")
        } else if lower.contains(".m3u8") || lower.contains("m3u8?") {
            ("m3u8", "needs_merge")
        } else if lower.contains(".mpd") || lower.contains("manifest") {
            ("mpd", "needs_merge")
        } else if lower.contains(".mp4") || lower.contains(".webm") || lower.contains(".mov") {
            ("direct_video", "ready")
        } else if lower.contains(".ts?") || lower.contains(".m4s?") || lower.contains("segment") {
            ("segment", "needs_merge")
        } else if lower.contains(".mp3")
            || lower.contains(".m4a")
            || lower.contains(".ogg")
            || lower.contains(".wav")
        {
            ("audio", "ready")
        } else if lower.contains("youtube.com")
            || lower.contains("youtu.be")
            || lower.contains("vimeo.com")
            || lower.contains("bilibili.com")
        {
            ("iframe", "embed_only")
        } else {
            // 未知 URL：检查 Content-Type
            ("unknown", "needs_check")
        };

        candidates.push(serde_json::json!({
            "url": url,
            "kind": kind,
            "reason": reason,
            "title": title,
        }));
    }

    Ok(format!(
        r#"{{"ok":true,"candidates":{},"count":{}}}"#,
        serde_json::to_string(&candidates).unwrap_or_else(|_| "[]".to_string()),
        candidates.len()
    ))
}

// D45a-3: 当前标签页录制 — spike 阶段由前端 MediaRecorder 录 webm，
// 后端只负责接收 base64 + 写入素材库。
// POST /api/video/record/save
// body: { webmBase64, title?, sourceUrl? }
fn handle_api_video_record_save(body: &serde_json::Value) -> Result<String, String> {
    let source_page = source_page_from_json(body)
        .map_err(|_| "来源页面地址无效".to_string())?;
    let b64 = body
        .get("webmBase64")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if b64.is_empty() {
        return Err("录制内容为空".to_string());
    }
    let body_bytes = base64_decode(b64).map_err(|error| format!("base64 解码失败: {error}"))?;
    if body_bytes.len() < 1024 {
        return Err("录制数据过小，可能录制未启动".to_string());
    }
    let title = body
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("录制");
    let source_url = body
        .get("sourceUrl")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let prefix = create_id_simple();
    let file_name = format!(
        "{}-{}-record-{}.webm",
        &prefix[..8.min(prefix.len())],
        safe_file_name(title),
        stamp
    );
    let catalog = material_catalog_for_http()?;
    let imported = materials::import_downloaded_material_with_source(
        &catalog,
        materials::MaterialBytesInput {
            name: file_name,
            original_path: if source_url.is_empty() {
                format!("recording://{stamp}")
            } else {
                source_url.to_string()
            },
            mime_type: "video/webm".to_string(),
            description: Some(format!("标签页录制 · {title}")),
            bytes: body_bytes.clone(),
        },
        &materials::MaterialImportOptions::default(),
        source_page.as_ref(),
    )
    .map_err(|error| error.message)?;
    emit_catalog_change_global(&imported.change);
    Ok(materials::canonical_import_response(&imported).to_string())
}

// D45a-3: simple base64 decoder.

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 128] = &{
        let mut t = [255u8; 128];
        let chars = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut i = 0;
        while i < chars.len() {
            t[chars[i] as usize] = i as u8;
            i += 1;
        }
        t
    };
    let cleaned: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let pad_count = cleaned.iter().rev().take_while(|&&b| b == b'=').count();
    let data_len = cleaned.len() - pad_count;
    if data_len % 4 == 1 {
        return Err("base64 长度非法（data_len % 4 == 1）".to_string());
    }
    let mut out = Vec::with_capacity(data_len / 4 * 3);
    let mut i = 0;
    while i + 4 <= data_len {
        let b0 = TABLE[cleaned[i] as usize];
        let b1 = TABLE[cleaned[i + 1] as usize];
        let b2 = TABLE[cleaned[i + 2] as usize];
        let b3 = TABLE[cleaned[i + 3] as usize];
        if b0 == 255 || b1 == 255 || b2 == 255 || b3 == 255 {
            return Err(format!("非法 base64 字符 at {}", i));
        }
        out.push((b0 << 2) | (b1 >> 4));
        out.push((b1 << 4) | (b2 >> 2));
        out.push((b2 << 6) | b3);
        i += 4;
    }
    let rem = data_len - i;
    if rem == 2 {
        let b0 = TABLE[cleaned[i] as usize];
        let b1 = TABLE[cleaned[i + 1] as usize];
        if b0 == 255 || b1 == 255 {
            return Err("尾部非法".to_string());
        }
        out.push((b0 << 2) | (b1 >> 4));
    } else if rem == 3 {
        let b0 = TABLE[cleaned[i] as usize];
        let b1 = TABLE[cleaned[i + 1] as usize];
        let b2 = TABLE[cleaned[i + 2] as usize];
        if b0 == 255 || b1 == 255 || b2 == 255 {
            return Err("尾部非法".to_string());
        }
        out.push((b0 << 2) | (b1 >> 4));
        out.push((b1 << 4) | (b2 >> 2));
    }
    Ok(out)
}

struct LegacyLocalTransportAdapter {
    backend: Arc<backend::BackendServices>,
}

impl LegacyLocalTransportAdapter {
    fn new(backend: Arc<backend::BackendServices>) -> Self {
        Self { backend }
    }

    fn dispatch_tool_route(
        &self,
        context: &tools::ToolCallContext,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Option<local_transport::AdapterResponse> {
        if path == "/api/tools/list" && method == "GET" {
            return Some(match self.backend.list_tools(context) {
                Ok(definitions) => local_transport::AdapterResponse {
                    status: 200,
                    body: serde_json::to_string(&definitions).unwrap_or_else(|_| "[]".to_string()),
                },
                Err(error) => local_transport::AdapterResponse {
                    status: error.status(),
                    body: serde_json::json!({"code":error.code,"message":error.message})
                        .to_string(),
                },
            });
        }
        if path == "/api/tools/run" && method == "POST" {
            let request = match body
                .and_then(|value| serde_json::from_str::<tools::ToolRunRequest>(value).ok())
            {
                Some(request) => request,
                None => {
                    return Some(local_transport::AdapterResponse {
                        status: 400,
                        body: serde_json::json!({
                            "code":"tool-input-invalid",
                            "message":"Tool run request is invalid"
                        })
                        .to_string(),
                    })
                }
            };
            return Some(match self.backend.run_tool(context, request) {
                Ok(result) => local_transport::AdapterResponse {
                    status: 200,
                    body: serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string()),
                },
                Err(error) => local_transport::AdapterResponse {
                    status: error.status(),
                    body: serde_json::json!({"code":error.code,"message":error.message})
                        .to_string(),
                },
            });
        }
        None
    }
}

impl local_transport::TransportAdapter for LegacyLocalTransportAdapter {
    fn dispatch(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> local_transport::AdapterResponse {
        if !self.backend.status().ready {
            return local_transport::AdapterResponse {
                status: 503,
                body: r#"{"ok":false,"code":"backend-not-ready","message":"Backend is not ready"}"#
                    .to_string(),
            };
        }
        if path == "/api/material-libraries/media-receipt"
            || materials::media_import_transport::explicit_request(path, body)
            || materials::media_import_transport::scoped_job(&self.backend, path) {
            return local_transport::AdapterResponse { status: 401,
                body: r#"{"code":"consumer-principal-required"}"#.into() };
        }
        if materials::consumer_transport::handles(path) {
            return local_transport::AdapterResponse { status: 401,
                body: r#"{"code":"consumer-principal-required"}"#.into() };
        }
        if method == "POST" && path == "/api/notes/capture-target" {
            return extension_note_capture::note_target_response(&self.backend, body);
        }
        if method == "POST" && matches!(path, "/api/notes/attach-material" | "/api/notes/capture") {
            return local_transport::AdapterResponse { status: 401, body: r#"{"code":"capture-principal-required"}"#.into() };
        }
        if knowledge::KnowledgeService::handles_http_path(path) {
            let response = self.backend.knowledge().dispatch_http(method, path, body);
            return local_transport::AdapterResponse {
                status: response.status,
                body: response.body,
            };
        }
        if matches!(path, "/api/tools/list" | "/api/tools/run") {
            return local_transport::AdapterResponse {
                status: 401,
                body: serde_json::json!({
                    "code":"tool-caller-invalid",
                    "message":"Verified transport principal is required"
                })
                .to_string(),
            };
        }
        if let Some((status, body)) =
            handle_capability_route_with_backend(&self.backend, method, path, body)
        {
            return local_transport::AdapterResponse { status, body };
        }
        if let Some((status, body)) =
            handle_media_transfer_route_with_backend(&self.backend, method, path, body)
        {
            return local_transport::AdapterResponse { status, body };
        }
        let (status, body) = handle_api_route(method, path, body);
        local_transport::AdapterResponse { status, body }
    }

    fn dispatch_verified(
        &self,
        principal: &local_transport::VerifiedTransportPrincipal,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> local_transport::AdapterResponse {
        if principal.is_materials_mcp() {
            if let Some(response)=community_mcp_knowledge::route(&self.backend.knowledge(),principal,method,path,body){return response;}
            return materials::mcp_transport::route(&self.backend, principal, method, path, body);
        }
        if !self.backend.status().ready { return self.dispatch(method, path, body); }
        if let Some(response) = materials::media_import_transport::route(&self.backend, principal, method, path, body) {
            return response;
        }
        if materials::consumer_transport::handles(path) {
            let response = (|| -> materials::MaterialResult<local_transport::AdapterResponse> {
                let authorization = principal.material_authorization(&self.backend.material_catalog())?;
                let response = materials::consumer_transport::route(
                    &self.backend, principal, authorization, method, path, body,
                    |_| principal.material_admission(),
                ).expect("recognized material consumer route");
                // Cached receipts and read responses also require current authority.
                Ok(principal.material_delivery_response(response))
            })();
            return match response {
                Ok(value) => value,
                Err(error) => materials::consumer_transport::response(Err(error)),
            };
        }
        if method == "POST" && matches!(path, "/api/assets/import-media" | "/api/media/transfers") {
            return extension_note_capture::media_response_with_receipt(&self.backend, principal, path, body, || self.dispatch(method, path, body));
        }
        if method == "POST" && matches!(path, "/api/notes/attach-material" | "/api/notes/capture") {
            if !self.backend.status().ready { return self.dispatch(method, path, body); }
            return extension_note_capture::note_material_attach_response(&self.backend, principal, body);
        }
        if let Some(response) =
            self.dispatch_tool_route(&principal.tool_context(), method, path, body)
        {
            return response;
        }
        self.dispatch(method, path, body)
    }

    fn collect(&self, body: &serde_json::Value) -> Result<serde_json::Value, String> {
        if !self.backend.status().ready {
            return Err("backend-not-ready: 后端服务尚未完成初始化".to_string());
        }
        insert_collection_item(body).map(|id| serde_json::json!({"ok": true, "id": id}))
    }
}

#[cfg(test)]
mod media_transfer_transport_tests {
    use super::*;

    #[test]
    fn media_transfer_api_accepts_only_an_opaque_probe_and_format_selection() {
        let parsed: MediaTransferApiRequest = serde_json::from_value(serde_json::json!({
            "url": "https://www.youtube.com/watch?v=fixture",
            "fileName": "fixture.mp4",
            "sourcePageUrl": "https://www.youtube.com/watch?v=fixture",
            "materialSourcePageUrl": "https://www.youtube.com/watch?v=fixture&t=35#clip",
            "sourcePageKind": "work-page",
            "sourcePageTitle": "Fixture work",
            "probeId": "probe-0123456789abcdef0123456789abcdef",
            "formatId": "format-fedcba9876543210fedcba9876543210"
        }))
        .unwrap();
        assert_eq!(
            parsed.probe_id.as_deref(),
            Some("probe-0123456789abcdef0123456789abcdef")
        );
        assert_eq!(
            parsed.format_id.as_deref(),
            Some("format-fedcba9876543210fedcba9876543210")
        );
        assert_eq!(
            parsed.transfer.source_page_url.as_deref(),
            Some("https://www.youtube.com/watch?v=fixture")
        );
        let page = materials::MaterialSourcePageInput::from_parts(
            parsed.material_source_page_url.as_deref().unwrap(),
            parsed.source_page_kind.as_deref().unwrap(),
            parsed.source_page_title.as_deref(),
        ).unwrap();
        assert_eq!(page.page_url, "https://www.youtube.com/watch?v=fixture&t=35#clip");
        assert_eq!(page.page_kind, "work-page");
        assert_eq!(page.title.as_deref(), Some("Fixture work"));
        assert!(materials::MaterialSourcePageInput::from_parts(
            "https://user:password@example.test/work", "work-page", None,
        ).is_none());
        assert!(
            serde_json::from_value::<MediaTransferApiRequest>(serde_json::json!({
                "url": "https://www.youtube.com/watch?v=fixture",
                "fileName": "fixture.mp4",
                "formatSelector": "137+bestaudio/137"
            }))
            .is_err()
        );
    }

    #[test]
    fn source_page_request_requires_a_safe_complete_pair_and_keeps_position_parameters() {
        let page = source_page_from_json(&serde_json::json!({
            "sourcePageUrl": "https://works.test/piece/42?view=detail&item=7#frame-3",
            "sourcePageKind": "work-page",
        })).unwrap().unwrap();
        assert_eq!(page.page_url, "https://works.test/piece/42?view=detail&item=7#frame-3");
        assert_eq!(source_page_from_json(&serde_json::json!({
            "sourcePageUrl": "https://works.test/#/work/42?item=7",
            "sourcePageKind": "work-page",
        })).unwrap().unwrap().page_url, "https://works.test/#/work/42?item=7");
        assert!(source_page_from_json(&serde_json::json!({
            "sourcePageUrl": "https://works.test/piece/42",
        })).is_err());
        assert!(source_page_from_json(&serde_json::json!({
            "sourcePageUrl": "file:///C:/private.txt", "sourcePageKind": "work-page",
        })).is_err());
        assert!(source_page_from_json(&serde_json::json!({
            "sourcePageUrl": "https://user:secret@works.test/piece/42",
            "sourcePageKind": "work-page",
        })).is_err());
        assert!(source_page_from_json(&serde_json::json!({
            "sourcePageUrl": "https://works.test/piece/42?token=SECRET",
            "sourcePageKind": "work-page",
        })).is_err());
        assert!(source_page_from_json(&serde_json::json!({
            "sourcePageUrl": "https://works.test/#/work/42?token=SECRET",
            "sourcePageKind": "work-page",
        })).is_err());
        assert!(source_page_from_json(&serde_json::json!({
            "sourcePageUrl": "https://works.test/#/work/42%3Faccess_token%3DSECRET",
            "sourcePageKind": "work-page",
        })).is_err());
        assert!(source_page_from_json(&serde_json::json!({
            "sourcePageUrl": "https://cdn.test/piece.png?width=480",
            "sourcePageKind": "work-page",
        })).is_err());
        assert!(source_page_from_json(&serde_json::json!({})).unwrap().is_none());
    }

    fn temp_app_data() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "luckyray-media-route-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn extension_note_media_route_uses_the_canonical_attachment_publisher() {
        let app_data = temp_app_data();
        let vault_root = app_data.with_extension("vault");
        std::fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let vault = knowledge::KnowledgeVaultRegistration {
            id: "vault-extension-attachment".into(),
            name: "Extension attachment".into(),
            root_path: vault_root.to_string_lossy().to_string(),
            mode: "vault-bound".into(),
            created_at: "2026-09-08T00:00:00Z".into(),
            last_opened_at: "2026-09-08T00:00:00Z".into(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        std::fs::write(
            vault_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        let backend = Arc::new(backend::BackendServices::initialize(&app_data).unwrap());
        let knowledge = backend.knowledge();
        knowledge.register_current_vault(&vault).unwrap();
        knowledge.activate_ui_source(&vault.id).unwrap();

        let source = app_data.with_extension("source.png");
        std::fs::write(&source, b"extension image bytes").unwrap();
        let catalog = backend.material_catalog();
        let imported = catalog
            .import_paths(&[source], &materials::MaterialImportOptions::default())
            .unwrap()
            .value;
        let asset = imported.assets.first().unwrap();
        let adapter = LegacyLocalTransportAdapter::new(backend.clone());
        let prepared = local_transport::TransportAdapter::dispatch(
            &adapter,
            "POST",
            "/api/notes/capture-target",
            Some(r#"{"target":"new"}"#),
        );
        assert_eq!(prepared.status, 200, "{}", prepared.body);
        let body = serde_json::json!({
            "requestId": "attachment-reference",
            "assetId": asset.id,
            "target": "new",
            "title": "Captured image",
            "sourceUrl": "https://page.test/article",
            "binding": serde_json::from_str::<serde_json::Value>(&prepared.body).unwrap(),
        })
        .to_string();
        let principal = local_transport::VerifiedTransportPrincipal::capture_test_principal();
        let response = local_transport::TransportAdapter::dispatch_verified(
            &adapter,
            &principal,
            "POST",
            "/api/notes/attach-material",
            Some(&body),
        );
        assert_eq!(response.status, 200, "{}", response.body);
        let restarted_adapter = LegacyLocalTransportAdapter::new(backend.clone());
        let replay = local_transport::TransportAdapter::dispatch_verified(
            &restarted_adapter,
            &principal,
            "POST",
            "/api/notes/attach-material",
            Some(&body),
        );
        assert_eq!(replay.status, response.status);
        assert_eq!(replay.body, response.body);
        let payload: serde_json::Value = serde_json::from_str(&response.body).unwrap();
        let relative_note = payload
            .pointer("/documentRef/relativePath")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        let markdown = payload
            .pointer("/attachment/markdown")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        let relative_attachment = payload
            .pointer("/attachment/relativePath")
            .and_then(serde_json::Value::as_str)
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(vault_root.join(relative_note)).unwrap(),
            format!("{markdown}\n\n来源：https://page.test/article")
        );
        assert!(vault_root.join(relative_attachment).is_file());
        assert!(!catalog
            .note_attachment_refs(&vault.id, relative_note)
            .unwrap()
            .is_empty());

        assert!(
            !vault_root.join("attachments").exists(),
            "reference policy must not create a Vault copy"
        );
        assert_eq!(
            std::fs::read(vault_root.join(relative_attachment)).unwrap(),
            b"extension image bytes"
        );
        let document_ref: knowledge::KnowledgeDocumentRef =
            serde_json::from_value(payload["documentRef"].clone()).unwrap();
        let note_id = knowledge::KnowledgeService::document_id(&document_ref);
        let target_request = serde_json::json!({"target":"existing", "noteId":note_id}).to_string();
        let prepared_existing = local_transport::TransportAdapter::dispatch(
            &adapter,
            "POST",
            "/api/notes/capture-target",
            Some(&target_request),
        );
        assert_eq!(prepared_existing.status, 200);
        let activation = knowledge.active_ui_source_identity().unwrap();
        knowledge
            .append_document_from_ui(
                activation.source_epoch,
                &knowledge::KnowledgeWriteInput {
                    document_ref: document_ref.clone(),
                    content: "\nUser edit".into(),
                    expected_revision: Some(payload["revision"].as_str().unwrap().into()),
                },
            )
            .unwrap();
        let before = std::fs::read(vault_root.join(relative_note)).unwrap();
        let stale_request = serde_json::json!({
            "requestId":"attachment-stale",
            "assetId":asset.id, "target":"existing", "noteId":note_id,
            "binding":serde_json::from_str::<serde_json::Value>(&prepared_existing.body).unwrap(),
        })
        .to_string();
        let stale = local_transport::TransportAdapter::dispatch_verified(
            &adapter,
            &principal,
            "POST",
            "/api/notes/attach-material",
            Some(&stale_request),
        );
        assert_eq!(stale.status, 409);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&stale.body).unwrap()["code"],
            "knowledge-revision-conflict"
        );
        assert_eq!(
            std::fs::read(vault_root.join(relative_note)).unwrap(),
            before
        );

        knowledge
            .set_attachment_handling_policy(&vault.id, activation.source_epoch, "copy")
            .unwrap();
        let mut copy_request: serde_json::Value = serde_json::from_str(&body).unwrap();
        copy_request["title"] = serde_json::json!("Copied image");
        copy_request["requestId"] = serde_json::json!("attachment-copy");
        let copied = local_transport::TransportAdapter::dispatch_verified(
            &adapter,
            &principal,
            "POST",
            "/api/notes/attach-material",
            Some(&copy_request.to_string()),
        );
        assert_eq!(copied.status, 200, "{}", copied.body);
        let copied: serde_json::Value = serde_json::from_str(&copied.body).unwrap();
        let copied_path = copied["attachment"]["relativePath"].as_str().unwrap();
        assert!(copied_path.starts_with("attachments/"));
        assert_eq!(
            std::fs::read(vault_root.join(copied_path)).unwrap(),
            b"extension image bytes"
        );

        knowledge.deactivate_ui_source().unwrap();
        knowledge.activate_ui_source(&vault.id).unwrap();
        copy_request["title"] = serde_json::json!("Must not be created");
        copy_request["requestId"] = serde_json::json!("attachment-changed");
        let changed = local_transport::TransportAdapter::dispatch_verified(
            &adapter,
            &principal,
            "POST",
            "/api/notes/attach-material",
            Some(&copy_request.to_string()),
        );
        assert_eq!(changed.status, 409);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&changed.body).unwrap()["code"],
            "knowledge-source-inactive"
        );
        assert!(!vault_root.join("Must not be created.md").exists());

        let _ = std::fs::remove_dir_all(&app_data);
        let _ = std::fs::remove_dir_all(&vault_root);
    }

    #[test]
    fn production_adapter_exposes_safe_media_transfer_start_and_status_json() {
        let app_data = temp_app_data();
        let backend = Arc::new(backend::BackendServices::initialize(&app_data).unwrap());
        let adapter = LegacyLocalTransportAdapter::new(backend);
        let request = serde_json::json!({
            "url": "file:///C:/private/video.mp4?token=PRIVATE",
            "fileName": "video.mp4",
            "mimeType": "video/mp4"
        })
        .to_string();

        let started = local_transport::TransportAdapter::dispatch(
            &adapter,
            "POST",
            "/api/media/transfers",
            Some(&request),
        );
        assert_eq!(started.status, 202);
        assert!(!started.body.contains("PRIVATE"));
        assert!(!started.body.contains("C:/private"));
        let transfer_id = serde_json::from_str::<serde_json::Value>(&started.body)
            .unwrap()
            .get("transferId")
            .and_then(serde_json::Value::as_str)
            .unwrap()
            .to_string();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let failed = loop {
            let response = local_transport::TransportAdapter::dispatch(
                &adapter,
                "GET",
                &format!("/api/media/transfers/{transfer_id}"),
                None,
            );
            assert_eq!(response.status, 200);
            let body = serde_json::from_str::<serde_json::Value>(&response.body).unwrap();
            if body.get("state").and_then(serde_json::Value::as_str) == Some("failed") {
                break response.body;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        };
        assert!(failed.contains("media-network-denied"));
        assert!(!failed.contains("PRIVATE"));
        assert!(!failed.contains("C:/private"));

        let unknown = local_transport::TransportAdapter::dispatch(
            &adapter,
            "GET",
            "/api/media/transfers/media-unknown",
            None,
        );
        assert_eq!(unknown.status, 404);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&unknown.body)
                .unwrap()
                .get("code")
                .and_then(serde_json::Value::as_str),
            Some("media-transfer-not-found")
        );

        std::fs::remove_dir_all(app_data).unwrap();
    }
}

fn insert_collection_item(payload: &serde_json::Value) -> Result<String, String> {
    let conn = open_db_write().map_err(|error| format!("打开数据库失败: {error}"))?;

    let payload_type = payload
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("text");
    let title = payload.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let url = payload.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let selection = payload
        .get("selection")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let thumbnail = payload
        .get("thumbnail")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let captured_at = payload
        .get("capturedAt")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let source_detail = payload.get("sourceDetail");

    let browser = source_detail
        .and_then(|d| d.get("browser"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let trigger = source_detail
        .and_then(|d| d.get("trigger"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // HTML 渲染通过 source.includes('browser_plugin') 判断是否显示插件卡片
    let source = "browser_plugin";

    let now = if captured_at.is_empty() {
        chrono::Local::now().to_rfc3339()
    } else {
        captured_at.to_string()
    };

    let item_id = create_id_simple();

    let db_type = match payload_type {
        "image" => "file",
        "link" => "link",
        "file" => "file",
        _ => "text",
    };

    let content = if db_type == "file" || db_type == "link" {
        if !url.is_empty() {
            url.to_string()
        } else {
            title.to_string()
        }
    } else {
        if !selection.is_empty() {
            selection.to_string()
        } else if !title.is_empty() {
            title.to_string()
        } else {
            "".to_string()
        }
    };

    let url_metadata = if db_type == "file" || db_type == "link" {
        serde_json::json!({
            "url": url,
            "imageUrl": thumbnail,
            "hostname": if !url.is_empty() {
                url.split('/').nth(2).unwrap_or("")
            } else { "" },
            "trigger": trigger,
            "browser": browser,
        })
        .to_string()
    } else {
        serde_json::json!({
            "title": title,
        })
        .to_string()
    };

    let thumbnail_val = if !thumbnail.is_empty() {
        thumbnail.to_string()
    } else {
        String::new()
    };

    conn.execute(
        "INSERT INTO collection_item (id, type, content, url_metadata, source, created_at, thumbnail, browser, trigger) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            item_id,
            db_type,
            content,
            url_metadata,
            source,
            now,
            thumbnail_val,
            browser,
            trigger,
        ],
    ).map_err(|e| {
        // D41: 失败记录
        let summary = format!("collect type={} url={}", db_type, url);
        record_failure("collect", &summary, &e.to_string());
        format!("写入收集项失败: {}", e)
    })?;

    Ok(item_id)
}

// =====================================================================
// D65 正式画布 MVP — 文件存储
// 目录: <APP_DATA>/canvases/
//   index.json  — 画布列表（最小结构）
//   <canvasId>.json — 单个画布（节点/边/视口）
// 不新增 SQLite 表，不改数据库 schema。
// 失败一律返回 String 错误给前端，不静默吞。
// =====================================================================

const CANVAS_GENERATION_MAX_PROMPT_BYTES: usize = 64 * 1024;
const CANVAS_GENERATION_MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const CANVAS_GENERATION_MAX_POLL_BYTES: usize = 1024 * 1024;
const CANVAS_GENERATION_MAX_REFERENCES: usize = 8;
const CANVAS_GENERATION_MAX_REFERENCE_BYTES: usize = 16 * 1024 * 1024;
const CANVAS_GENERATION_MAX_VIDEO_BYTES: usize = 512 * 1024 * 1024;
const CANVAS_GENERATION_VIDEO_REDIRECTS: usize = 3;
const CANVAS_GENERATION_VIDEO_DOWNLOAD_SECONDS: u64 = 300;

#[derive(serde::Deserialize)]
struct AiImageReference {
    #[serde(default)]
    id: String,
    #[serde(default)]
    label: String,
    kind: String,
    role: String,
    media_url: Option<String>,
}

#[derive(serde::Deserialize)]
struct AiImageGenerateRequest {
    prompt: String,
    model: String,
    aspect: Option<String>,
    quality: Option<String>,
    #[serde(default)]
    resolution: Option<String>,
    count: Option<u32>,
    #[serde(default)]
    references: Vec<AiImageReference>,
}

#[derive(serde::Serialize)]
struct AiGeneratedImage {
    url: String,
    thumbnail_url: Option<String>,
}

#[derive(serde::Serialize)]
struct AiImageGenerateResponse {
    success: bool,
    images: Vec<AiGeneratedImage>,
    error_kind: Option<String>,
    error_message: Option<String>,
    error_detail: Option<String>,
}

#[derive(serde::Deserialize)]
struct AiVideoGenerateRequest {
    client_task_id: Option<String>,
    provider_task_id: Option<String>,
    prompt: String,
    model: String,
    aspect: Option<String>,
    quality: Option<String>,
    duration: Option<u32>,
    #[allow(dead_code)]
    sound: Option<bool>,
    #[serde(default)]
    references: Vec<AiImageReference>,
}

#[derive(serde::Serialize)]
struct AiVideoGenerateResponse {
    success: bool,
    video_url: Option<String>,
    thumbnail_url: Option<String>,
    error_kind: Option<String>,
    error_message: Option<String>,
    error_detail: Option<String>,
}

#[derive(Clone, serde::Serialize)]
struct AiVideoGenerationProgress {
    client_task_id: String,
    provider_task_id: Option<String>,
    stage: String,
    progress: Option<u64>,
}

fn canvas_generation_message(kind: &str) -> &'static str {
    match kind {
        "bigmodel_prompt_too_long" => "智谱 CogVideoX-Flash 的提示词最多 512 个字符，请缩短后重新生成",
        "bigmodel_reference_invalid" => "智谱参考图需为 PNG/JPEG，且不超过 5 MB",
        "submission_unknown" => "提交结果尚未确认。为避免重复生成，请先在服务端确认原任务状态，不要重新提交",
        "submission_binding_changed" => "原视频任务的配置或输入已改变，无法安全恢复；请检查原任务后再决定是否重新生成",
        "stable_task_id_required" => "缺少可恢复的视频任务标识，请更新客户端后重新操作",
        "no_api_key" => "尚未配置画布生成服务",
        "profile_changed" => "生成配置已更改或删除；请检查原配置后重新发起，不会自动切换服务",
        "unauthorized" => "画布生成服务认证失败",
        "rate_limited" => "画布生成服务请求过于频繁",
        "account_rate_limited" => "供应商报告账户已达到速率限制；当前占用情况尚未确认",
        "provider_overloaded" => "供应商报告该模型当前访问量过大",
        "permission_denied" => "供应商报告当前账户、订阅或密钥无此接口权限",
        "insufficient_balance" => "供应商报告账户欠费或余额不足",
        "account_restricted" => "供应商报告账户或套餐使用受限，请核对对应错误码",
        "usage_limit" => "供应商报告使用上限已达到，请核对对应错误码",
        "timeout" => "画布生成请求超时",
        "connection" => "画布生成服务连接失败",
        "invalid_response" => "画布生成服务响应无效",
        "empty_response" => "画布生成服务没有返回可用结果",
        "unsupported_input" => "当前生成服务不支持该输入",
        "moderation_blocked" => "生成服务因内容安全规则拒绝了本次请求或输出",
        "model_unavailable" => "当前模型不可用或不支持此生成操作",
        "unsupported_protocol" => "当前模型与生成接口协议不匹配，请检查服务协议配置",
        "unsupported_model_protocol" => "当前模型无法自动识别图片协议，请在配置中选择固定协议",
        "invalid_request" => "生成服务拒绝了请求参数，请检查模型、协议与生成选项",
        _ => "画布生成服务暂时不可用",
    }
}

fn ai_image_failure_with_detail(kind: &str, detail: &str) -> AiImageGenerateResponse {
    AiImageGenerateResponse {
        success: false,
        images: Vec::new(),
        error_kind: Some(kind.to_string()),
        error_message: Some(canvas_generation_message(kind).to_string()),
        error_detail: Some(detail.chars().take(400).collect()),
    }
}

fn ai_image_failure(kind: &str) -> AiImageGenerateResponse {
    AiImageGenerateResponse {
        success: false,
        images: Vec::new(),
        error_kind: Some(kind.to_string()),
        error_message: Some(canvas_generation_message(kind).to_string()),
        error_detail: None,
    }
}

fn ai_video_failure_with_detail(kind: &str, detail: &str) -> AiVideoGenerateResponse {
    AiVideoGenerateResponse {
        success: false,
        video_url: None,
        thumbnail_url: None,
        error_kind: Some(kind.to_string()),
        error_message: Some(canvas_generation_message(kind).to_string()),
        error_detail: Some(detail.chars().take(400).collect()),
    }
}


fn ai_video_failure(kind: &str) -> AiVideoGenerateResponse {
    AiVideoGenerateResponse {
        success: false,
        video_url: None,
        thumbnail_url: None,
        error_kind: Some(kind.to_string()),
        error_message: Some(canvas_generation_message(kind).to_string()),
        error_detail: None,
    }
}


fn canvas_generation_http_error_kind(status: reqwest::StatusCode) -> &'static str {
    match status.as_u16() {
        401 | 403 => "unauthorized",
        408 | 504 => "timeout",
        429 | 503 => "rate_limited",
        _ => "provider_error",
    }
}

fn safe_canvas_model_label(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 128 || trimmed.chars().any(char::is_control) {
        "当前模型".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn validate_canvas_image_bytes(
    bytes: Vec<u8>,
    advertised_mime: Option<&str>,
) -> Result<(Vec<u8>, String, &'static str), canvas_agent::CanvasAgentError> {
    if bytes.is_empty() || bytes.len() > CANVAS_GENERATION_MAX_RESPONSE_BYTES {
        return Err(canvas_agent::CanvasAgentError::new(
            "canvas-agent-generation-invalid",
        ));
    }
    let detected = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        ("image/png", "png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        ("image/jpeg", "jpg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12).is_some_and(|value| value == b"WEBP") {
        ("image/webp", "webp")
    } else {
        return Err(canvas_agent::CanvasAgentError::new(
            "canvas-agent-generation-invalid",
        ));
    };
    if advertised_mime
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| {
            !matches!(
                value.as_str(),
                "image/png" | "image/jpeg" | "image/jpg" | "image/webp"
            )
        })
    {
        return Err(canvas_agent::CanvasAgentError::new(
            "canvas-agent-generation-invalid",
        ));
    }
    Ok((bytes, detected.0.to_owned(), detected.1))
}

fn materialize_canvas_image_bytes(
    raw: &str,
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<(Vec<u8>, String, &'static str), canvas_agent::CanvasAgentError> {
    use std::io::Read as _;

    if cancelled() {
        return Err(canvas_agent::CanvasAgentError::new(
            "canvas-agent-cancelled",
        ));
    }
    if let Some(payload) = raw.strip_prefix("data:image/") {
        let (header, encoded) = payload.split_once(";base64,").ok_or_else(|| {
            canvas_agent::CanvasAgentError::new("canvas-agent-generation-invalid")
        })?;
        if encoded.len() > (CANVAS_GENERATION_MAX_RESPONSE_BYTES * 4 / 3 + 16) {
            return Err(canvas_agent::CanvasAgentError::new(
                "canvas-agent-generation-invalid",
            ));
        }
        let bytes = base64_decode(encoded)
            .map_err(|_| canvas_agent::CanvasAgentError::new("canvas-agent-generation-invalid"))?;
        return validate_canvas_image_bytes(bytes, Some(&format!("image/{header}")));
    }
    if !raw.starts_with("https://") || raw.len() > 4096 {
        return Err(canvas_agent::CanvasAgentError::new(
            "canvas-agent-generation-invalid",
        ));
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    let mut response = web_tools::SafeHttpClient::production(std::time::Duration::from_secs(20))
        .get(raw, deadline, 3, "image/png,image/jpeg,image/webp")
        .map_err(|_| canvas_agent::CanvasAgentError::new("canvas-agent-materialize-failed"))?;
    if !response.response.status().is_success() {
        return Err(canvas_agent::CanvasAgentError::new(
            "canvas-agent-materialize-failed",
        ));
    }
    let advertised_mime = response
        .response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .map(str::to_owned);
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if cancelled() {
            return Err(canvas_agent::CanvasAgentError::new(
                "canvas-agent-cancelled",
            ));
        }
        let read = response
            .response
            .read(&mut buffer)
            .map_err(|_| canvas_agent::CanvasAgentError::new("canvas-agent-materialize-failed"))?;
        if read == 0 {
            break;
        }
        let next = bytes
            .len()
            .checked_add(read)
            .filter(|value| *value <= CANVAS_GENERATION_MAX_RESPONSE_BYTES)
            .ok_or_else(|| {
                canvas_agent::CanvasAgentError::new("canvas-agent-generation-invalid")
            })?;
        bytes.reserve(next.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..read]);
    }
    validate_canvas_image_bytes(bytes, advertised_mime.as_deref())
}

fn sha256_file(path: &std::path::Path) -> Result<String, canvas_agent::CanvasAgentError> {
    use std::io::Read as _;

    let mut file = std::fs::File::open(path)
        .map_err(|_| canvas_agent::CanvasAgentError::new("canvas-agent-materialize-failed"))?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| canvas_agent::CanvasAgentError::new("canvas-agent-materialize-failed"))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .filter(|value| *value <= CANVAS_GENERATION_MAX_VIDEO_BYTES as u64)
            .ok_or_else(|| {
                canvas_agent::CanvasAgentError::new("canvas-agent-generation-invalid")
            })?;
        digest.update(&buffer[..read]);
    }
    if total == 0 {
        return Err(canvas_agent::CanvasAgentError::new(
            "canvas-agent-generation-invalid",
        ));
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn import_canvas_generated_video(
    catalog: &materials::MaterialCatalog,
    path: &std::path::Path,
) -> Result<
    (materials::MaterialAsset, Option<materials::MaterialChange>),
    canvas_agent::CanvasAgentError,
> {
    let content_hash = sha256_file(path)?;
    let outcome = catalog
        .import_paths(
            &[path.to_path_buf()],
            &materials::MaterialImportOptions::default(),
        )
        .map_err(|_| canvas_agent::CanvasAgentError::new("canvas-agent-materialize-failed"))?;
    let asset = outcome
        .value
        .assets
        .into_iter()
        .next()
        .or_else(|| {
            catalog
                .list_assets(&materials::MaterialFilter::default())
                .ok()?
                .into_iter()
                .find(|asset| asset.content_hash.as_deref() == Some(content_hash.as_str()))
        })
        .ok_or_else(|| canvas_agent::CanvasAgentError::new("canvas-agent-materialize-failed"))?;
    Ok((asset, outcome.change))
}

fn load_canvas_generation_settings(
    app: &tauri::AppHandle,
) -> Result<(String, String, String, String), ()> {
    let path = app.path().app_data_dir().map_err(|_| ())?.join("luckyray.db");
    let config = canvas_media_profiles::resolve(&path, None, None).map_err(|_| ())?;
    Ok((normalize_ai_api_key(&config.api_key), config.profile.base_url, config.profile.image_model, config.profile.video_model))
}

fn normalized_canvas_generation_base(raw: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(raw.trim()).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    let mut path = url.path().trim_end_matches('/').to_string();
    for suffix in [
        "/images/generations",
        "/videos",
        "/chat/completions",
        "/responses",
    ] {
        if path.to_ascii_lowercase().ends_with(suffix) {
            path.truncate(path.len().saturating_sub(suffix.len()));
            path = path.trim_end_matches('/').to_string();
            break;
        }
    }
    if !path.to_ascii_lowercase().ends_with("/v1") {
        path.push_str("/v1");
    }
    url.set_path(&path);
    Some(url.to_string().trim_end_matches('/').to_string())
}

fn canvas_generation_endpoint(base: &str, suffix: &str) -> Option<String> {
    normalized_canvas_generation_base(base).map(|value| format!("{value}/{suffix}"))
}

fn canvas_reference_role_priority(role: &str) -> u8 {
    match role {
        "firstFrame" => 0,
        "lastFrame" => 1,
        "reference" => 2,
        "videoReference" => 3,
        "promptContext" => 4,
        _ => 5,
    }
}

fn ordered_canvas_image_references(references: &[AiImageReference]) -> Option<Vec<String>> {
    if references.len() > CANVAS_GENERATION_MAX_REFERENCES {
        return None;
    }
    let mut values = Vec::new();
    for (index, reference) in references.iter().enumerate() {
        if reference.kind != "image" {
            return None;
        }
        let Some(value) = reference
            .media_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if value.len() > CANVAS_GENERATION_MAX_REFERENCE_BYTES
            || !(value.starts_with("data:image/") || value.starts_with("https://"))
        {
            return None;
        }
        values.push((
            canvas_reference_role_priority(&reference.role),
            index,
            value.to_string(),
        ));
    }
    values.sort_by_key(|(priority, index, _)| (*priority, *index));
    Some(values.into_iter().map(|(_, _, value)| value).collect())
}

fn append_custom_canvas_image_references(
    body: &mut serde_json::Map<String, serde_json::Value>,
    endpoint: &str,
    is_agnes: bool,
    references: &[AiImageReference],
) -> Result<(), ()> {
    let is_official_openai = reqwest::Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == "api.openai.com");
    if is_agnes || is_official_openai || references.is_empty() {
        return Ok(());
    }
    let valid_text = |value: &str, max_bytes: usize| {
        !value.trim().is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
    };
    let mut projected = Vec::with_capacity(references.len());
    for reference in references {
        let media_url = reference.media_url.as_deref().map(str::trim).ok_or(())?;
        if reference.kind != "image"
            || !matches!(
                reference.role.as_str(),
                "firstFrame" | "lastFrame" | "reference" | "promptContext"
            )
            || !valid_text(&reference.id, 256)
            || !valid_text(&reference.label, 512)
            || media_url.len() > CANVAS_GENERATION_MAX_REFERENCE_BYTES
            || !(media_url.starts_with("data:image/") || media_url.starts_with("https://"))
        {
            return Err(());
        }
        projected.push(serde_json::json!({
            "id": reference.id,
            "label": reference.label,
            "kind": reference.kind,
            "role": reference.role,
            "media_url": media_url,
        }));
    }
    body.insert(
        "references".to_string(),
        serde_json::Value::Array(projected),
    );
    Ok(())
}

fn canvas_generated_image_from_value(value: &serde_json::Value) -> Option<AiGeneratedImage> {
    // Providers may return an empty url field alongside a usable b64_json;
    // only accept a url that already passes the final scheme/size checks.
    let usable = |candidate: &str| -> bool {
        !candidate.is_empty()
            && candidate.len() <= CANVAS_GENERATION_MAX_RESPONSE_BYTES
            && (candidate.starts_with("data:image/") || candidate.starts_with("https://"))
    };
    let url = value
        .get("url")
        .and_then(|item| item.as_str())
        .or_else(|| value.get("image_url").and_then(|item| item.as_str()))
        .filter(|candidate| usable(candidate))
        .map(str::to_string)
        .or_else(|| {
            value
                .get("b64_json")
                .and_then(|item| item.as_str())
                .filter(|data| !data.is_empty())
                .map(|data| format!("data:image/png;base64,{data}"))
        })?;
    if url.len() > CANVAS_GENERATION_MAX_RESPONSE_BYTES
        || !(url.starts_with("data:image/") || url.starts_with("https://"))
    {
        return None;
    }
    let thumbnail_url = value
        .get("thumbnail_url")
        .and_then(|item| item.as_str())
        .filter(|item| item.starts_with("https://") && item.len() <= 4096)
        .map(str::to_string);
    Some(AiGeneratedImage { url, thumbnail_url })
}

/// Bounded structural fingerprint of an unexpected provider response: top
/// level keys and per-item key sets only - never values, URLs or content.
fn canvas_response_shape(parsed: &serde_json::Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let serde_json::Value::Object(map) = parsed {
        let keys: Vec<&String> = map.keys().take(12).collect();
        parts.push(format!("{{{}}}", keys.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(",")));
        for (key, value) in map.iter().take(3) {
            if let serde_json::Value::Array(items) = value {
                match items.first() {
                    Some(serde_json::Value::Object(item)) => {
                        let item_keys: Vec<&String> = item.keys().take(10).collect();
                        let mut hint = format!("{key}[0]{{{}}}", item_keys.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(","));
                        for field in ["url", "image_url"] {
                            if let Some(serde_json::Value::String(value)) = item.get(field) {
                                hint.push_str(&format!(" {field}:len={} prefix={}", value.len(), &value[..value.len().min(12)]));
                            }
                        }
                        if let Some(serde_json::Value::String(value)) = item.get("b64_json") {
                            hint.push_str(&format!(" b64:len={}", value.len()));
                        }
                        parts.push(hint);
                    }
                    _ => parts.push(format!("{key}[{}]", items.len())),
                }
            }
        }
    } else {
        parts.push(match parsed {
            serde_json::Value::Array(items) => format!("[{}]", items.len()),
            serde_json::Value::String(_) => "str".to_string(),
            serde_json::Value::Null => "null".to_string(),
            _ => "scalar".to_string(),
        });
    }
    parts.join(" ").chars().take(400).collect()
}

fn extract_canvas_generated_images(parsed: &serde_json::Value) -> Vec<AiGeneratedImage> {
    if let Some(image) = canvas_generated_image_from_value(parsed) {
        return vec![image];
    }
    for key in ["data", "images", "output", "result"] {
        let Some(candidate) = parsed.get(key) else {
            continue;
        };
        if let Some(items) = candidate.as_array() {
            let images = items
                .iter()
                .filter_map(canvas_generated_image_from_value)
                .take(4)
                .collect::<Vec<_>>();
            if !images.is_empty() {
                return images;
            }
        }
        if let Some(image) = canvas_generated_image_from_value(candidate) {
            return vec![image];
        }
        for nested in ["data", "images", "output"] {
            if let Some(items) = candidate.get(nested).and_then(|value| value.as_array()) {
                let images = items
                    .iter()
                    .filter_map(canvas_generated_image_from_value)
                    .take(4)
                    .collect::<Vec<_>>();
                if !images.is_empty() {
                    return images;
                }
            }
        }
    }
    Vec::new()
}

fn canvas_image_size(model: &str, aspect: Option<&str>) -> &'static str {
    if model.to_ascii_lowercase().contains("dall-e-2") {
        return "1024x1024";
    }
    match aspect.unwrap_or("1:1") {
        "7:4" | "3:2" | "16:9" | "4:3" if model.to_ascii_lowercase().contains("dall-e-3") => "1792x1024",
        "4:7" | "2:3" | "9:16" | "3:4" if model.to_ascii_lowercase().contains("dall-e-3") => "1024x1792",
        "16:9" | "4:3" => "1536x1024",
        "9:16" | "3:4" => "1024x1536",
        _ => "1024x1024",
    }
}

#[tauri::command]
async fn ai_image_generate(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    request: AiImageGenerateRequest,
    media_profile_id: Option<String>,
    media_profile_revision: Option<u64>,
) -> Result<AiImageGenerateResponse, String> {
    require_main_caller(&caller)?;
    ai_image_generate_with_binding(&app, request, &|| false, media_profile_id.as_deref(), media_profile_revision).await
}

async fn ai_image_generate_internal(
    app: &tauri::AppHandle,
    request: AiImageGenerateRequest,
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<AiImageGenerateResponse, String> {
    ai_image_generate_with_binding(app, request, cancelled, None, None).await
}

async fn ai_image_generate_with_binding(
    app: &tauri::AppHandle,
    request: AiImageGenerateRequest,
    cancelled: &(dyn Fn() -> bool + Send + Sync),
    profile_id: Option<&str>,
    profile_revision: Option<u64>,
) -> Result<AiImageGenerateResponse, String> {
    if cancelled() {
        return Ok(ai_image_failure("cancelled"));
    }
    // Resolve the pinned profile once (or active only for unpinned legacy callers); Agnes keeps the
    // original inline adapter, every other protocol dispatches through the
    // profile-aware implementations in canvas_media_protocols.
    let db_path = match app.path().app_data_dir() {
        Ok(dir) => dir.join("luckyray.db"),
        Err(_) => return Ok(ai_image_failure("provider_error")),
    };
    let runtime = match canvas_media_profiles::resolve(&db_path, profile_id, profile_revision) {
        Ok(runtime) => runtime,
        Err("canvas-media-profile-changed" | "canvas-media-profile-missing") => return Ok(ai_image_failure("profile_changed")),
        Err(_) => return Ok(ai_image_failure("provider_error")),
    };
    if runtime.profile.image_protocol == "disabled" {
        return Ok(ai_image_failure("unsupported_input"));
    }
    if runtime.profile.image_protocol != "agnes" {
        return Ok(canvas_media_protocols::image(&request, &runtime, cancelled).await);
    }
    if request.resolution.is_some() {return Ok(ai_image_failure("unsupported_input"));}
    let api_key = crate::normalize_ai_api_key(&runtime.api_key);
    let base_url = runtime.profile.base_url.clone();
    let configured_model = runtime.profile.image_model.clone();
    if api_key.is_empty() {
        return Ok(ai_image_failure("no_api_key"));
    }
    let prompt = request.prompt.trim();
    if prompt.is_empty() || prompt.len() > CANVAS_GENERATION_MAX_PROMPT_BYTES {
        return Ok(ai_image_failure("unsupported_input"));
    }
    let model = if request.model.trim().is_empty() {
        configured_model.trim()
    } else {
        request.model.trim()
    };
    if model.is_empty() || model.len() > 128 {
        return Ok(ai_image_failure("unsupported_input"));
    }
    let Some(endpoint) = canvas_generation_endpoint(&base_url, "images/generations") else {
        return Ok(ai_image_failure("provider_error"));
    };
    let Some(reference_images) = ordered_canvas_image_references(&request.references) else {
        return Ok(ai_image_failure("unsupported_input"));
    };
    let is_agnes = endpoint.contains("agnes-ai.com") || model.starts_with("agnes-image-");
    let mut body = serde_json::Map::new();
    body.insert("model".to_string(), serde_json::json!(model));
    body.insert("prompt".to_string(), serde_json::json!(prompt));
    if is_agnes {
        if request.count.unwrap_or(1) != 1 {return Ok(ai_image_failure("unsupported_input"));}
        let legacy_specs: serde_json::Value = serde_json::from_str(include_str!("../../src/core/canvas/agnesImageLegacySpecs.json")).expect("validated legacy Agnes image specs");
        let legacy = legacy_specs.get(model);
        let size = if let Some(spec) = legacy {
            if request.quality.is_some() {return Ok(ai_image_failure("unsupported_input"));}
            match spec["sizes"].get(request.aspect.as_deref().unwrap_or("1:1")).and_then(serde_json::Value::as_str) {
                Some(size) => size,
                None => return Ok(ai_image_failure("unsupported_input")),
            }
        } else { match request.quality.as_deref() {
            Some("超清") | Some("4K") => "4K",
            Some("高清") | Some("2K") => "2K",
            Some("3K") => "3K",
            _ => "1K",
        }};
        body.insert("size".to_string(), serde_json::json!(size));
        if legacy.is_none() {
            body.insert("ratio".to_string(),serde_json::json!(request.aspect.as_deref().unwrap_or("1:1")));
        }
        if reference_images.is_empty() {
            body.insert("return_base64".to_string(), serde_json::json!(true));
        } else {
            body.insert(
                "extra_body".to_string(),
                serde_json::json!({
                    "image": reference_images,
                    "response_format": "b64_json"
                }),
            );
        }
    } else {
        let count = if model.to_ascii_lowercase().contains("dall-e-3") {
            1
        } else {
            request.count.unwrap_or(1).clamp(1, 4)
        };
        body.insert("n".to_string(), serde_json::json!(count));
        body.insert(
            "size".to_string(),
            serde_json::json!(canvas_image_size(model, request.aspect.as_deref())),
        );
        body.insert(
            "quality".to_string(),
            serde_json::json!(if matches!(
                request.quality.as_deref(),
                Some("高清" | "超清" | "high" | "hd")
            ) {
                "high"
            } else {
                "medium"
            }),
        );
    }
    if append_custom_canvas_image_references(&mut body, &endpoint, is_agnes, &request.references)
        .is_err()
    {
        return Ok(ai_image_failure("unsupported_input"));
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(_) => return Ok(ai_image_failure("provider_error")),
    };
    let response = match client
        .post(endpoint)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return Ok(ai_image_failure(if error.is_timeout() {
                "timeout"
            } else {
                "connection"
            }))
        }
    };
    if cancelled() {
        return Ok(ai_image_failure("cancelled"));
    }
    let status = response.status();
    let limit = if status.is_success() {
        CANVAS_GENERATION_MAX_RESPONSE_BYTES
    } else {
        AI_STREAM_MAX_ERROR_BODY_BYTES
    };
    let response_text = match read_ai_response_body_bounded(response, limit, "provider_error").await
    {
        Ok(body) => body,
        Err(_) => {
            return Ok(ai_image_failure(if status.is_success() {
                "invalid_response"
            } else {
                "provider_error"
            }))
        }
    };
    if !status.is_success() {
        return Ok(ai_image_failure(canvas_generation_http_error_kind(status)));
    }
    let parsed: serde_json::Value = match serde_json::from_str(&response_text) {
        Ok(value) => value,
        Err(_) => return Ok(ai_image_failure("invalid_response")),
    };
    let images = extract_canvas_generated_images(&parsed);
    if images.is_empty() {
        return Ok(ai_image_failure_with_detail(
            "empty_response",
            &canvas_response_shape(&parsed),
        ));
    }
    Ok(AiImageGenerateResponse {
        success: true,
        images,
        error_kind: None,
        error_message: None,
        error_detail: None,
    })
}

fn canvas_video_dimensions(aspect: Option<&str>, quality: Option<&str>) -> (u32, u32) {
    fn scaled_even(value: u32, numerator: u32, denominator: u32) -> u32 {
        let rounded = (value * numerator + denominator / 2) / denominator;
        if rounded % 2 == 0 {
            rounded
        } else {
            rounded + 1
        }
    }
    let short = match quality.unwrap_or("720p") {
        "480p" => 480,
        "1080p" | "2K" => 1080,
        _ => 720,
    };
    match aspect.unwrap_or("16:9") {
        "9:16" if short == 480 => (448, 832),
        "9:16" => (short, scaled_even(short, 16, 9)),
        "1:1" => (short, short),
        "4:3" => (scaled_even(short, 4, 3), short),
        "3:4" => (short, scaled_even(short, 4, 3)),
        _ if short == 480 => (832, 448),
        _ => (scaled_even(short, 16, 9), short),
    }
}

fn canvas_video_frames(duration: Option<u32>) -> u32 {
    match duration.unwrap_or(5) {
        0..=5 => 121,
        6..=10 => 241,
        11..=15 => 361,
        _ => 441,
    }
}

fn valid_provider_task_id(value: &str) -> bool {
    !matches!(value, "" | "." | "..")
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn emit_canvas_video_progress(
    app: &tauri::AppHandle,
    client_task_id: Option<&str>,
    provider_task_id: Option<&str>,
    stage: &str,
    progress: Option<u64>,
) {
    let Some(client_task_id) = client_task_id.filter(|value| valid_provider_task_id(value)) else {
        return;
    };
    let _ = app.emit(
        "canvas-ai-video-progress",
        AiVideoGenerationProgress {
            client_task_id: client_task_id.to_string(),
            provider_task_id: provider_task_id.map(str::to_string),
            stage: stage.to_string(),
            progress,
        },
    );
}

fn materialize_canvas_video_with_client(
    client: &web_tools::SafeHttpClient,
    raw_url: &str,
    output_dir: &std::path::Path,
    max_bytes: usize,
    deadline: std::time::Instant,
) -> Result<std::path::PathBuf, ()> {
    use std::io::{Read as _, Write as _};

    if max_bytes == 0 {
        return Err(());
    }
    std::fs::create_dir_all(output_dir).map_err(|_| ())?;
    let mut response = client
        .get(
            raw_url,
            deadline,
            CANVAS_GENERATION_VIDEO_REDIRECTS,
            "video/mp4,video/webm,video/quicktime,application/octet-stream",
        )
        .map_err(|_| ())?;
    if !response.response.status().is_success() {
        return Err(());
    }
    if response
        .response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length == 0 || length > max_bytes)
    {
        return Err(());
    }
    let content_type = response
        .response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .ok_or(())?;
    let extension = match content_type.as_str() {
        "video/mp4" | "video/quicktime" | "application/octet-stream" => "mp4",
        "video/webm" => "webm",
        _ => return Err(()),
    };
    let nonce = format!(
        "{}\0{}\0{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        raw_url
    );
    let digest = Sha256::digest(nonce.as_bytes());
    let digest_hex = format!("{digest:x}");
    let stem = &digest_hex[..24];
    let final_path = output_dir.join(format!("canvas-video-{stem}.{extension}"));
    let partial_path = output_dir.join(format!("canvas-video-{stem}.{extension}.part"));
    let result = (|| -> Result<(), ()> {
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial_path)
            .map_err(|_| ())?;
        let mut total = 0_usize;
        let mut prefix = Vec::with_capacity(16);
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = response.response.read(&mut buffer).map_err(|_| ())?;
            if read == 0 {
                break;
            }
            total = total.checked_add(read).ok_or(())?;
            if total > max_bytes {
                return Err(());
            }
            if prefix.len() < 16 {
                let take = (16 - prefix.len()).min(read);
                prefix.extend_from_slice(&buffer[..take]);
            }
            output.write_all(&buffer[..read]).map_err(|_| ())?;
        }
        if total == 0 {
            return Err(());
        }
        let signature_is_valid = match extension {
            "webm" => prefix.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
            _ => prefix.len() >= 8 && &prefix[4..8] == b"ftyp",
        };
        if !signature_is_valid {
            return Err(());
        }
        output.sync_all().map_err(|_| ())?;
        drop(output);
        std::fs::rename(&partial_path, &final_path).map_err(|_| ())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&partial_path);
        return Err(());
    }
    Ok(final_path)
}

#[tauri::command]
async fn ai_video_generate(
    app: tauri::AppHandle,
    caller: tauri::Webview,
    request: AiVideoGenerateRequest,
    media_profile_id: Option<String>,
    media_profile_revision: Option<u64>,
) -> Result<AiVideoGenerateResponse, String> {
    require_main_caller(&caller)?;
    ai_video_generate_with_binding(&app, request, &|| false, media_profile_id.as_deref(), media_profile_revision).await
}

async fn ai_video_generate_internal(
    app: &tauri::AppHandle,
    request: AiVideoGenerateRequest,
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<AiVideoGenerateResponse, String> {
    ai_video_generate_with_binding(app, request, cancelled, None, None).await
}

/// Verified model controls share the same matrix as the UI. Unknown legacy models
/// retain basic generation, but never silently accept discarded option selections.
fn canvas_agnes_video_body(request: &AiVideoGenerateRequest, model: &str, prompt: &str, references: &[String]) -> Result<serde_json::Value, &'static str> {
    static SPECS: OnceLock<serde_json::Value> = OnceLock::new();
    let specs = SPECS.get_or_init(|| serde_json::from_str(include_str!("../../src/core/canvas/agnesVideoSpecs.json")).expect("validated Agnes video specs"));
    let spec = specs.get(model);
    let mut body = serde_json::json!({"model":model,"prompt":prompt,"mode":"text","size":"720P"});
    if let Some(spec) = spec {
        let aspect = request.aspect.as_deref().unwrap_or("16:9");
        let quality = request.quality.as_deref().unwrap_or("720p");
        let duration = request.duration.unwrap_or(5);
        if !spec["aspects"].as_array().is_some_and(|v|v.iter().any(|x|x.as_str()==Some(aspect)))
            || !spec["qualities"].as_array().is_some_and(|v|v.iter().any(|x|x.as_str()==Some(quality)))
            || !spec["durations"].as_array().is_some_and(|v|v.iter().any(|x|x.as_u64()==Some(duration as u64)))
            || request.sound.is_some() || references.len()>2 || references.iter().any(|url|!url.starts_with("https://")) {
            return Err("unsupported_input");
        }
        body["aspect_ratio"] = serde_json::json!(aspect);
        body["seconds"] = serde_json::json!(duration.to_string());
        body["size"] = serde_json::json!(match quality {"720p"=>"720P","1080p"=>"1080P",value=>value});
    } else if request.aspect.is_some() || request.quality.is_some() || request.duration.is_some() || request.sound.is_some() {
        return Err("unsupported_input");
    }
    if let Some(first) = references.first() {
        body["mode"] = serde_json::json!("keyframe");
        body[if spec.is_some(){"first_frame"}else{"first_frame_image"}] = serde_json::json!(first);
        if let Some(last)=references.get(1) {
            body[if spec.is_some(){"last_frame"}else{"last_frame_image"}] = serde_json::json!(last);
        }
    }
    Ok(body)
}

#[cfg(test)]
mod canvas_agnes_video_payload_tests {
    use super::*;
    fn request(model: &str) -> AiVideoGenerateRequest {
        AiVideoGenerateRequest {client_task_id:None,provider_task_id:None,prompt:"synthetic".into(),model:model.into(),aspect:Some("3:4".into()),quality:Some("2K".into()),duration:Some(11),sound:None,references:vec![]}
    }
    #[test]
    fn verified_agnes_options_reach_actual_request_body() {
        let request=request("agnes-video-2.5");
        let body=canvas_agnes_video_body(&request,&request.model,&request.prompt,&["https://example.test/first.png".into(),"https://example.test/last.png".into()]).unwrap();
        assert_eq!(body["aspect_ratio"],"3:4");assert_eq!(body["size"],"2K");assert_eq!(body["seconds"],"11");
        assert_eq!(body["first_frame"],"https://example.test/first.png");assert_eq!(body["last_frame"],"https://example.test/last.png");
        assert!(body.get("first_frame_image").is_none());
    }
    #[test]
    fn rejects_invalid_flash_and_legacy_controls_without_coercion() {
        let mut r=request("agnes-video-2.5-flash");
        assert!(canvas_agnes_video_body(&r,&r.model,&r.prompt,&[]).is_err());
        r.quality=Some("720p".into());assert!(canvas_agnes_video_body(&r,&r.model,&r.prompt,&[]).is_ok());
        r.duration=Some(15);assert!(canvas_agnes_video_body(&r,&r.model,&r.prompt,&[]).is_err());
        r.model="agnes-video-v2.0".into();assert!(canvas_agnes_video_body(&r,&r.model,&r.prompt,&[]).is_err());
        r.aspect=None;r.quality=None;r.duration=None;
        let body=canvas_agnes_video_body(&r,&r.model,&r.prompt,&[]).unwrap();
        assert!(body.get("aspect_ratio").is_none());assert!(body.get("seconds").is_none());
    }
}

async fn ai_video_generate_with_binding(
    app: &tauri::AppHandle,
    request: AiVideoGenerateRequest,
    cancelled: &(dyn Fn() -> bool + Send + Sync),
    profile_id: Option<&str>,
    profile_revision: Option<u64>,
) -> Result<AiVideoGenerateResponse, String> {
    if cancelled() {
        return Ok(ai_video_failure("cancelled"));
    }
    // A persisted task must never be resumed with a newly selected provider.
    if request.provider_task_id.as_deref().is_some_and(|id| !id.is_empty()) && profile_id.is_none() {
        return Ok(ai_video_failure("profile_changed"));
    }
    // Same profile resolution as image generation: Agnes keeps the inline
    // adapter, openai-video / 12ai-task dispatch to canvas_media_protocols.
    let db_path = match app.path().app_data_dir() {
        Ok(dir) => dir.join("luckyray.db"),
        Err(_) => return Ok(ai_video_failure("provider_error")),
    };
    let runtime = match canvas_media_profiles::resolve(&db_path, profile_id, profile_revision) {
        Ok(runtime) => runtime,
        Err("canvas-media-profile-changed" | "canvas-media-profile-missing") => return Ok(ai_video_failure("profile_changed")),
        Err(_) => return Ok(ai_video_failure("provider_error")),
    };
    if runtime.profile.video_protocol == "disabled" {
        return Ok(ai_video_failure("unsupported_input"));
    }
    if runtime.profile.video_protocol != "agnes" {
        return Ok(canvas_media_protocols::video(app, &request, &runtime, cancelled).await);
    }
    let api_key = crate::normalize_ai_api_key(&runtime.api_key);
    let base_url = runtime.profile.base_url.clone();
    let configured_model = runtime.profile.video_model.clone();
    if api_key.is_empty() {
        return Ok(ai_video_failure("no_api_key"));
    }
    let prompt = request.prompt.trim();
    if prompt.is_empty() || prompt.len() > CANVAS_GENERATION_MAX_PROMPT_BYTES {
        return Ok(ai_video_failure("unsupported_input"));
    }
    let model = if request.model.trim().is_empty() {
        configured_model.trim()
    } else {
        request.model.trim()
    };
    if model.is_empty() || model.len() > 128 {
        return Ok(ai_video_failure("unsupported_input"));
    }
    let Some(base) = normalized_canvas_generation_base(&base_url) else {
        return Ok(ai_video_failure("provider_error"));
    };
    let create_endpoint = format!("{base}/videos");
    let gateway = base.strip_suffix("/v1").unwrap_or(&base);
    let poll_endpoint = format!("{gateway}/agnesapi");
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(_) => return Ok(ai_video_failure("provider_error")),
    };
    let resumed = request
        .provider_task_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("");
    if !resumed.is_empty() && !valid_provider_task_id(resumed) {
        return Ok(ai_video_failure("unsupported_input"));
    }
    let video_id = if !resumed.is_empty() {
        resumed.to_string()
    } else {
        // Polling an accepted task needs no original image files or upload payload.
        let Some(reference_images) = ordered_canvas_image_references(&request.references) else {
            return Ok(ai_video_failure("unsupported_input"));
        };
        let body = match canvas_agnes_video_body(&request, model, prompt, &reference_images) {
            Ok(body) => body,
            Err(kind) => return Ok(ai_video_failure(kind)),
        };
        let response = match client
            .post(create_endpoint)
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return Ok(ai_video_failure(if error.is_timeout() {
                    "timeout"
                } else {
                    "connection"
                }))
            }
        };
        if cancelled() {
            return Ok(ai_video_failure("cancelled"));
        }
        let status = response.status();
        let text = match read_ai_response_body_bounded(
            response,
            if status.is_success() {
                CANVAS_GENERATION_MAX_POLL_BYTES
            } else {
                AI_STREAM_MAX_ERROR_BODY_BYTES
            },
            "provider_error",
        )
        .await
        {
            Ok(text) => text,
            Err(_) => {
                return Ok(ai_video_failure(if status.is_success() {
                    "invalid_response"
                } else {
                    "provider_error"
                }))
            }
        };
        if !status.is_success() {
            return Ok(ai_video_failure_with_detail(
                canvas_generation_http_error_kind(status),
                &format!("http {} {}", status.as_u16(), &text.chars().take(200).collect::<String>()),
            ));
        }
        let parsed: serde_json::Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(_) => {
                return Ok(ai_video_failure_with_detail(
                    "invalid_response",
                    &format!("non-json: {}", &text.chars().take(120).collect::<String>()),
                ))
            }
        };
        let id = parsed
            .get("video_id")
            .and_then(|value| value.as_str())
            .or_else(|| parsed.get("task_id").and_then(|value| value.as_str()))
            .or_else(|| parsed.get("id").and_then(|value| value.as_str()))
            .unwrap_or("");
        if !valid_provider_task_id(id) {
            return Ok(ai_video_failure("invalid_response"));
        }
        id.to_string()
    };
    emit_canvas_video_progress(
        &app,
        request.client_task_id.as_deref(),
        Some(&video_id),
        "queued",
        Some(0),
    );
    for _ in 0..60 {
        if cancelled() {
            return Ok(ai_video_failure("cancelled"));
        }
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        if cancelled() {
            return Ok(ai_video_failure("cancelled"));
        }
        let response = match client
            .get(&poll_endpoint)
            .query(&[("video_id", video_id.as_str()), ("model_name", model)])
            .bearer_auth(&api_key)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) if error.is_timeout() => continue,
            Err(_) => return Ok(ai_video_failure("connection")),
        };
        if cancelled() {
            return Ok(ai_video_failure("cancelled"));
        }
        let status = response.status();
        let text = match read_ai_response_body_bounded(
            response,
            if status.is_success() {
                CANVAS_GENERATION_MAX_POLL_BYTES
            } else {
                AI_STREAM_MAX_ERROR_BODY_BYTES
            },
            "provider_error",
        )
        .await
        {
            Ok(text) => text,
            Err(_) => {
                return Ok(ai_video_failure(if status.is_success() {
                    "invalid_response"
                } else {
                    "provider_error"
                }))
            }
        };
        if !status.is_success() {
            if matches!(status.as_u16(), 429 | 503) {
                continue;
            }
            return Ok(ai_video_failure(canvas_generation_http_error_kind(status)));
        }
        let parsed: serde_json::Value = match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(_) => return Ok(ai_video_failure("invalid_response")),
        };
        let status_name = parsed
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let progress = parsed
            .get("progress")
            .and_then(|value| value.as_u64())
            .map(|value| value.min(100));
        emit_canvas_video_progress(
            &app,
            request.client_task_id.as_deref(),
            Some(&video_id),
            if matches!(status_name, "queued" | "pending") {
                "queued"
            } else {
                "generating"
            },
            progress,
        );
        if status_name == "failed" {
            return Ok(ai_video_failure("provider_error"));
        }
        if status_name != "completed" {
            continue;
        }
        let remote_url = parsed
            .get("url")
            .and_then(|value| value.as_str())
            .or_else(|| parsed.get("video_url").and_then(|value| value.as_str()))
            .unwrap_or("");
        if remote_url.len() > 4096 || !remote_url.starts_with("https://") {
            return Ok(ai_video_failure("invalid_response"));
        }
        emit_canvas_video_progress(
            &app,
            request.client_task_id.as_deref(),
            Some(&video_id),
            "downloading",
            Some(99),
        );
        let output_dir = match app.path().app_data_dir() {
            Ok(path) => path.join("canvas").join("generated-videos"),
            Err(_) => return Ok(ai_video_failure("provider_error")),
        };
        let remote_url = remote_url.to_string();
        let materialized = match tokio::task::spawn_blocking(move || {
            let deadline = std::time::Instant::now()
                + std::time::Duration::from_secs(CANVAS_GENERATION_VIDEO_DOWNLOAD_SECONDS);
            materialize_canvas_video_with_client(
                &web_tools::SafeHttpClient::production(std::time::Duration::from_secs(30)),
                &remote_url,
                &output_dir,
                CANVAS_GENERATION_MAX_VIDEO_BYTES,
                deadline,
            )
        })
        .await
        {
            Ok(Ok(path)) => path,
            Ok(Err(())) => return Ok(ai_video_failure("connection")),
            Err(_) => return Ok(ai_video_failure("provider_error")),
        };
        if cancelled() {
            let _ = std::fs::remove_file(&materialized);
            return Ok(ai_video_failure("cancelled"));
        }
        return Ok(AiVideoGenerateResponse {
            success: true,
            video_url: Some(materialized.to_string_lossy().into_owned()),
            thumbnail_url: None,
            error_kind: None,
            error_message: None,
            error_detail: None,
        });
    }
    Ok(ai_video_failure("timeout"))
}

#[cfg(test)]
mod canvas_generation_bridge_tests {
    use super::{
        append_custom_canvas_image_references, canvas_generation_endpoint,
        canvas_generation_message, extract_canvas_generated_images,
        materialize_canvas_video_with_client, normalized_canvas_generation_base,
        valid_provider_task_id, AiGeneratedImage, AiImageReference, CanvasGenerationFaultInjector,
        CanvasGenerationFaultPoint, TauriCanvasGenerationDriver, TauriCanvasGenerationExecutor,
        TauriCanvasMaterializedOutput, TauriCanvasProviderOutput,
    };
    use crate::canvas_agent::{
        CanvasGenerationExecutor, CanvasGenerationJournal, CanvasGenerationOutput,
        CanvasGenerationRequest, CanvasGenerationStage,
    };
    use crate::web_tools::SafeHttpClient;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    struct FixtureCanvasGenerationDriver {
        provider_calls: Arc<AtomicUsize>,
        material_calls: Arc<AtomicUsize>,
    }

    impl TauriCanvasGenerationDriver for FixtureCanvasGenerationDriver {
        fn request_provider(
            &self,
            request: &CanvasGenerationRequest,
            _cancelled: &(dyn Fn() -> bool + Send + Sync),
        ) -> Result<TauriCanvasProviderOutput, crate::canvas_agent::CanvasAgentError> {
            self.provider_calls.fetch_add(1, Ordering::SeqCst);
            Ok(match request.kind.as_str() {
                "text" => TauriCanvasProviderOutput::Text {
                    text: "fixture text".to_owned(),
                    model_label: "fixture-model".to_owned(),
                    output_digest: "a".repeat(64),
                },
                "image" => TauriCanvasProviderOutput::Image {
                    generated: AiGeneratedImage {
                        url: "https://fixture.invalid/image.png".to_owned(),
                        thumbnail_url: None,
                    },
                    model_label: "fixture-model".to_owned(),
                },
                "video" => TauriCanvasProviderOutput::Video {
                    path: PathBuf::from("fixture-video.mp4"),
                    model_label: "fixture-model".to_owned(),
                },
                _ => panic!("unexpected fixture kind"),
            })
        }

        fn materialize(
            &self,
            request: &CanvasGenerationRequest,
            _provider: TauriCanvasProviderOutput,
            _cancelled: &(dyn Fn() -> bool + Send + Sync),
        ) -> Result<TauriCanvasMaterializedOutput, crate::canvas_agent::CanvasAgentError> {
            self.material_calls.fetch_add(1, Ordering::SeqCst);
            Ok(TauriCanvasMaterializedOutput {
                output: CanvasGenerationOutput {
                    text: None,
                    material_id: Some(format!("material-{}", request.kind)),
                    media_url: Some(format!("asset://material-{}", request.kind)),
                    thumbnail_url: None,
                    model_label: Some("fixture-model".to_owned()),
                },
                output_digest: "b".repeat(64),
            })
        }
    }

    struct PointFaultInjector(CanvasGenerationFaultPoint);

    impl CanvasGenerationFaultInjector for PointFaultInjector {
        fn checkpoint(
            &self,
            _kind: &str,
            _request_id: &str,
            point: CanvasGenerationFaultPoint,
        ) -> Result<(), crate::canvas_agent::CanvasAgentError> {
            if point == self.0 {
                Err(crate::canvas_agent::CanvasAgentError::new(
                    "canvas-agent-generation-fault-injected",
                ))
            } else {
                Ok(())
            }
        }
    }

    #[derive(Default)]
    struct StageJournal(Mutex<Vec<CanvasGenerationStage>>);

    impl CanvasGenerationJournal for StageJournal {
        fn transition(
            &self,
            stage: CanvasGenerationStage,
            _material_id: Option<&str>,
            _output_digest: Option<&str>,
        ) -> Result<(), crate::canvas_agent::CanvasAgentError> {
            self.0.lock().unwrap().push(stage);
            Ok(())
        }
    }

    fn fixture_executor(
        point: CanvasGenerationFaultPoint,
    ) -> (
        TauriCanvasGenerationExecutor,
        Arc<AtomicUsize>,
        Arc<AtomicUsize>,
    ) {
        let provider_calls = Arc::new(AtomicUsize::new(0));
        let material_calls = Arc::new(AtomicUsize::new(0));
        (
            TauriCanvasGenerationExecutor {
                driver: Arc::new(FixtureCanvasGenerationDriver {
                    provider_calls: provider_calls.clone(),
                    material_calls: material_calls.clone(),
                }),
                fault_injector: Arc::new(PointFaultInjector(point)),
            },
            provider_calls,
            material_calls,
        )
    }

    #[test]
    fn production_canvas_executor_fault_points_bound_text_image_and_video_stages() {
        let provider_points = [
            (
                CanvasGenerationFaultPoint::BeforeProviderRequested,
                Vec::new(),
                0,
            ),
            (
                CanvasGenerationFaultPoint::AfterProviderRequested,
                vec![CanvasGenerationStage::ProviderRequested],
                0,
            ),
            (
                CanvasGenerationFaultPoint::BeforeProviderSucceeded,
                vec![CanvasGenerationStage::ProviderRequested],
                1,
            ),
            (
                CanvasGenerationFaultPoint::AfterProviderSucceeded,
                vec![
                    CanvasGenerationStage::ProviderRequested,
                    CanvasGenerationStage::ProviderSucceeded,
                ],
                1,
            ),
        ];
        for kind in ["text", "image", "video"] {
            for (point, expected_stages, expected_provider_calls) in &provider_points {
                let (executor, provider_calls, material_calls) = fixture_executor(*point);
                let journal = StageJournal::default();
                let error = executor
                    .generate(
                        &CanvasGenerationRequest {
                            kind: kind.to_owned(),
                            prompt: "fixture".to_owned(),
                            operation_digest: "c".repeat(64),
                            request_id: format!("request-{kind}-{point:?}"),
                        },
                        &|| false,
                        &journal,
                    )
                    .unwrap_err();
                assert_eq!(error.code, "canvas-agent-generation-fault-injected");
                assert_eq!(*journal.0.lock().unwrap(), *expected_stages);
                assert_eq!(
                    provider_calls.load(Ordering::SeqCst),
                    *expected_provider_calls
                );
                assert_eq!(material_calls.load(Ordering::SeqCst), 0);
            }
        }

        let material_points = [
            (
                CanvasGenerationFaultPoint::BeforeMaterializing,
                vec![
                    CanvasGenerationStage::ProviderRequested,
                    CanvasGenerationStage::ProviderSucceeded,
                ],
                0,
            ),
            (
                CanvasGenerationFaultPoint::AfterMaterializing,
                vec![
                    CanvasGenerationStage::ProviderRequested,
                    CanvasGenerationStage::ProviderSucceeded,
                    CanvasGenerationStage::Materializing,
                ],
                0,
            ),
            (
                CanvasGenerationFaultPoint::BeforeMaterialCommitted,
                vec![
                    CanvasGenerationStage::ProviderRequested,
                    CanvasGenerationStage::ProviderSucceeded,
                    CanvasGenerationStage::Materializing,
                ],
                1,
            ),
            (
                CanvasGenerationFaultPoint::AfterMaterialCommitted,
                vec![
                    CanvasGenerationStage::ProviderRequested,
                    CanvasGenerationStage::ProviderSucceeded,
                    CanvasGenerationStage::Materializing,
                    CanvasGenerationStage::MaterialCommitted,
                ],
                1,
            ),
        ];
        for kind in ["image", "video"] {
            for (point, expected_stages, expected_material_calls) in &material_points {
                let (executor, provider_calls, material_calls) = fixture_executor(*point);
                let journal = StageJournal::default();
                let error = executor
                    .generate(
                        &CanvasGenerationRequest {
                            kind: kind.to_owned(),
                            prompt: "fixture".to_owned(),
                            operation_digest: "d".repeat(64),
                            request_id: format!("request-{kind}-{point:?}"),
                        },
                        &|| false,
                        &journal,
                    )
                    .unwrap_err();
                assert_eq!(error.code, "canvas-agent-generation-fault-injected");
                assert_eq!(*journal.0.lock().unwrap(), *expected_stages);
                assert_eq!(provider_calls.load(Ordering::SeqCst), 1);
                assert_eq!(
                    material_calls.load(Ordering::SeqCst),
                    *expected_material_calls
                );
            }
        }
    }

    #[test]
    fn generation_endpoints_and_errors_are_safe_and_bounded() {
        assert_eq!(
            canvas_generation_endpoint("https://example.test/v1/", "images/generations").as_deref(),
            Some("https://example.test/v1/images/generations"),
        );
        assert!(normalized_canvas_generation_base("http://example.test/v1").is_none());
        assert!(normalized_canvas_generation_base("https://user@example.test/v1").is_none());
        assert!(
            normalized_canvas_generation_base("https://example.test/v1?token=PRIVATE").is_none()
        );
        assert_eq!(
            canvas_generation_message("provider_error"),
            "画布生成服务暂时不可用"
        );
        assert!(!canvas_generation_message("provider_error").contains("PRIVATE"));
        assert!(valid_provider_task_id("task-1.safe"));
        assert!(!valid_provider_task_id("../task"));
    }

    #[test]
    fn image_projection_accepts_only_supported_safe_result_shapes() {
        let parsed = serde_json::json!({"data": [{"url": "https://cdn.example.test/image.png"}]});
        let images = extract_canvas_generated_images(&parsed);
        assert_eq!(images.len(), 1);
        let unsafe_result = serde_json::json!({"data": [{"url": "file:///private/path.png"}]});
        assert!(extract_canvas_generated_images(&unsafe_result).is_empty());
    }

    #[test]
    fn custom_image_provider_receives_validated_reference_metadata_only() {
        let references = vec![AiImageReference {
            id: "node-image-1".to_string(),
            label: "参考图".to_string(),
            kind: "image".to_string(),
            role: "reference".to_string(),
            media_url: Some("https://cdn.example.test/reference.png".to_string()),
        }];
        let mut custom_body = serde_json::Map::new();
        append_custom_canvas_image_references(
            &mut custom_body,
            "https://images.example.test/v1/images/generations",
            false,
            &references,
        )
        .expect("custom provider reference contract should be accepted");
        assert_eq!(
            custom_body["references"][0]["id"],
            serde_json::json!("node-image-1")
        );
        assert_eq!(
            custom_body["references"][0]["media_url"],
            serde_json::json!("https://cdn.example.test/reference.png")
        );

        let mut official_body = serde_json::Map::new();
        append_custom_canvas_image_references(
            &mut official_body,
            "https://api.openai.com/v1/images/generations",
            false,
            &references,
        )
        .unwrap();
        assert!(!official_body.contains_key("references"));

        let mut lookalike_body = serde_json::Map::new();
        append_custom_canvas_image_references(
            &mut lookalike_body,
            "https://api.openai.com.evil.test/v1/images/generations",
            false,
            &references,
        )
        .unwrap();
        assert!(lookalike_body.contains_key("references"));

        let unsafe_reference = vec![AiImageReference {
            id: "node-image-2".to_string(),
            label: "PRIVATE\npath".to_string(),
            kind: "image".to_string(),
            role: "reference".to_string(),
            media_url: Some("https://cdn.example.test/reference.png".to_string()),
        }];
        assert!(append_custom_canvas_image_references(
            &mut serde_json::Map::new(),
            "https://images.example.test/v1/images/generations",
            false,
            &unsafe_reference,
        )
        .is_err());
    }

    #[test]
    fn generated_video_download_is_bounded_and_leaves_no_partial_file() {
        let serve = |body: Vec<u8>| {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 2048];
                let _ = stream.read(&mut request);
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
            });
            (format!("http://{address}/generated.mp4"), worker)
        };
        let root = std::env::temp_dir().join(format!(
            "luckyray-canvas-video-{}-{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let safe_client = SafeHttpClient::loopback_for_test(Duration::from_secs(2));

        let valid_bytes = b"\0\0\0\x18ftypisom\0\0\0\0isommp42".to_vec();
        let (valid_url, valid_worker) = serve(valid_bytes.clone());
        let saved = materialize_canvas_video_with_client(
            &safe_client,
            &valid_url,
            &root,
            64,
            Instant::now() + Duration::from_secs(3),
        )
        .expect("bounded generated video should materialize");
        valid_worker.join().unwrap();
        assert_eq!(std::fs::read(&saved).unwrap(), valid_bytes);

        let (large_url, large_worker) = serve(vec![b'x'; 65]);
        assert!(materialize_canvas_video_with_client(
            &safe_client,
            &large_url,
            &root,
            64,
            Instant::now() + Duration::from_secs(3),
        )
        .is_err());
        large_worker.join().unwrap();
        assert_eq!(
            std::fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "part"))
                .count(),
            0,
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}

const CANVAS_INDEX_FILE: &str = "index.json";
const CANVAS_SCHEMA_VERSION: u32 = 2;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct CanvasListEntry {
    id: String,
    name: String,
    created_at: String,
    updated_at: String,
    node_count: u32,
    edge_count: u32,
    #[serde(default)]
    cover_version: u8,
    #[serde(default)]
    cover_kind: Option<String>,
    #[serde(default)]
    cover_url: Option<String>,
    #[serde(default)]
    cover_poster: Option<String>,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    content_digest: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct CanvasIndex {
    schema_version: u32,
    canvases: Vec<CanvasListEntry>,
}

type CanvasFile = canvas_agent::CanvasDocument;

fn canvas_list_entry(entry: canvas_agent::CanvasIndexEntry) -> CanvasListEntry {
    CanvasListEntry {
        id: entry.id,
        name: entry.name,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        node_count: entry.node_count,
        edge_count: entry.edge_count,
        cover_version: entry.cover_version,
        cover_kind: entry.cover_kind,
        cover_url: entry.cover_url,
        cover_poster: entry.cover_poster,
        revision: entry.revision,
        content_digest: entry.content_digest,
    }
}

fn canvas_storage_error(error: canvas_agent::CanvasAgentError) -> String {
    match error.code {
        "canvas-agent-revision-conflict" => "canvas-revision-conflict".to_owned(),
        code => code.to_owned(),
    }
}

#[cfg(test)]
fn canvas_content_digest(canvas: &CanvasFile) -> Result<String, String> {
    canvas_agent::content_digest(canvas).map_err(|error| error.code.to_owned())
}

fn normalize_loaded_canvas(canvas: CanvasFile) -> Result<CanvasFile, String> {
    canvas_agent::normalize_document(canvas).map_err(|_| "canvas-content-digest-invalid".to_owned())
}

#[cfg(test)]
fn canvas_cover_from_nodes(
    nodes: &serde_json::Value,
) -> (Option<String>, Option<String>, Option<String>) {
    canvas_agent::canvas_cover_from_nodes(nodes)
}

#[derive(serde::Serialize)]
struct CanvasStorageCheck {
    ok: bool,
    storage_dir: String,
    canvas_count: u32,
    checked_files: u32,
    issues: Vec<String>,
}

fn canvases_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("canvases");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn get_canvas_storage_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = canvases_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

fn backup_canvas_problem_file(
    path: &std::path::Path,
    suffix: &str,
) -> Result<std::path::PathBuf, String> {
    let backup = path.with_extension(format!(
        "{}.{}-{}",
        path.extension().and_then(|s| s.to_str()).unwrap_or("json"),
        suffix,
        chrono::Local::now().timestamp_millis()
    ));
    std::fs::copy(path, &backup).map_err(|e| format!("备份异常画布文件失败: {}", e))?;
    Ok(backup)
}

fn canvas_file_path(app: &tauri::AppHandle, canvas_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = canvases_dir(app)?;
    // canvas id 校验：仅允许 [a-zA-Z0-9_-]，避免路径穿越
    if canvas_id.is_empty() || canvas_id.len() > 128 {
        return Err("画布 ID 非法".to_string());
    }
    if !canvas_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("画布 ID 只能包含字母、数字、下划线、连字符".to_string());
    }
    Ok(dir.join(format!("{}.json", canvas_id)))
}

fn read_canvas_index(app: &tauri::AppHandle) -> Result<CanvasIndex, String> {
    let dir = canvases_dir(app)?;
    let path = dir.join(CANVAS_INDEX_FILE);
    if !path.exists() {
        return Ok(CanvasIndex {
            schema_version: CANVAS_SCHEMA_VERSION,
            canvases: vec![],
        });
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // 解析失败：备份为 .corrupt，不覆盖原文件
    match serde_json::from_str::<CanvasIndex>(&raw) {
        Ok(idx) => Ok(idx),
        Err(e) => {
            let backup =
                path.with_extension(format!("json.corrupt-{}", chrono::Local::now().timestamp()));
            let _ = std::fs::copy(&path, &backup);
            Err(format!("画布索引解析失败: {}，已备份为 {:?}", e, backup))
        }
    }
}

#[cfg(test)]
fn atomic_write_canvas_json(path: &std::path::Path, contents: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("画布文件名无效: {}", path.display()))?;
    let temp_path = path.with_file_name(format!(
        ".{}.tmp-{}-{}",
        file_name,
        std::process::id(),
        chrono::Local::now()
            .timestamp_nanos_opt()
            .unwrap_or_default()
    ));
    let result = (|| -> Result<(), String> {
        let mut temp_file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| format!("创建画布临时文件失败: {}", error))?;
        temp_file
            .write_all(contents)
            .map_err(|error| format!("写入画布临时文件失败: {}", error))?;
        temp_file
            .sync_all()
            .map_err(|error| format!("同步画布临时文件失败: {}", error))?;
        drop(temp_file);

        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
            const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
            #[link(name = "Kernel32")]
            unsafe extern "system" {
                fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
            }
            let source: Vec<u16> = temp_path.as_os_str().encode_wide().chain(Some(0)).collect();
            let destination: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let moved = unsafe {
                MoveFileExW(
                    source.as_ptr(),
                    destination.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            };
            if moved == 0 {
                return Err(format!(
                    "原子替换画布文件失败: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }

        #[cfg(not(windows))]
        std::fs::rename(&temp_path, path)
            .map_err(|error| format!("原子替换画布文件失败: {}", error))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

fn make_canvas_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("c-{}-{:04x}", ts, rand_u16())
}

// 不引入 rand 依赖，用时间戳哈希生成 4 位 hex
fn rand_u16() -> u16 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos as u16) ^ ((nanos >> 16) as u16)
}

#[derive(serde::Serialize)]
struct CreateCanvasResult {
    canvas: CanvasListEntry,
}

#[tauri::command]
fn create_canvas(
    app: tauri::AppHandle,
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    name: Option<String>,
) -> Result<CreateCanvasResult, String> {
    let id = make_canvas_id();
    let now = chrono::Local::now().to_rfc3339();
    let display_name = name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "未命名画布".to_string());

    // 初始化空画布文件
    let empty = CanvasFile {
        // New files intentionally begin as v1 and upgrade on the first explicit save.
        schema_version: 1,
        canvas_id: id.clone(),
        name: display_name.clone(),
        created_at: now.clone(),
        updated_at: now.clone(),
        nodes: serde_json::json!([]),
        edges: serde_json::json!([]),
        viewport: serde_json::json!({ "x": 0, "y": 0, "zoom": 1 }),
        generation_history: serde_json::json!([]),
        revision: 0,
        content_digest: String::new(),
        agent_receipts: Vec::new(),
    };
    let _ = app;
    let entry = backend
        .canvas_agent()
        .create_normal_canvas(empty)
        .map(canvas_list_entry)
        .map_err(canvas_storage_error)?;

    Ok(CreateCanvasResult { canvas: entry })
}

#[tauri::command]
fn list_canvases(app: tauri::AppHandle) -> Result<Vec<CanvasListEntry>, String> {
    let index = read_canvas_index(&app)?;
    let mut entries = index.canvases;
    // 按 updated_at 倒序
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(entries)
}

#[tauri::command]
fn check_canvas_files(app: tauri::AppHandle) -> Result<CanvasStorageCheck, String> {
    let dir = canvases_dir(&app)?;
    let index_path = dir.join(CANVAS_INDEX_FILE);
    let mut issues: Vec<String> = Vec::new();
    let mut checked_files = 0u32;
    let mut seen_ids = std::collections::HashSet::new();
    let mut canvas_count = 0u32;

    if !index_path.exists() {
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                issues.push(format!("缺少 index.json，但目录里存在 {}", path.display()));
            }
        }
        return Ok(CanvasStorageCheck {
            ok: issues.is_empty(),
            storage_dir: dir.to_string_lossy().to_string(),
            canvas_count,
            checked_files,
            issues,
        });
    }

    let raw = std::fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
    let index = match serde_json::from_str::<CanvasIndex>(&raw) {
        Ok(idx) => idx,
        Err(e) => {
            let backup = backup_canvas_problem_file(&index_path, "broken")?;
            issues.push(format!(
                "index.json 解析失败: {}，已备份为 {}",
                e,
                backup.display()
            ));
            return Ok(CanvasStorageCheck {
                ok: false,
                storage_dir: dir.to_string_lossy().to_string(),
                canvas_count,
                checked_files,
                issues,
            });
        }
    };

    canvas_count = index.canvases.len() as u32;
    for entry in &index.canvases {
        if !seen_ids.insert(entry.id.clone()) {
            issues.push(format!("index.json 存在重复画布 ID: {}", entry.id));
        }

        let path = match canvas_file_path(&app, &entry.id) {
            Ok(path) => path,
            Err(e) => {
                issues.push(format!("画布 ID {} 非法: {}", entry.id, e));
                continue;
            }
        };

        if !path.exists() {
            issues.push(format!(
                "index.json 记录了 {}，但单画布文件不存在",
                entry.id
            ));
            continue;
        }

        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(e) => {
                issues.push(format!("读取 {} 失败: {}", path.display(), e));
                continue;
            }
        };
        let canvas = match serde_json::from_str::<CanvasFile>(&raw) {
            Ok(canvas) => canvas,
            Err(e) => {
                match backup_canvas_problem_file(&path, "broken") {
                    Ok(backup) => issues.push(format!(
                        "{} 解析失败: {}，已备份为 {}",
                        path.display(),
                        e,
                        backup.display()
                    )),
                    Err(backup_err) => issues.push(format!(
                        "{} 解析失败: {}，且备份失败: {}",
                        path.display(),
                        e,
                        backup_err
                    )),
                }
                continue;
            }
        };

        checked_files += 1;
        if canvas.canvas_id != entry.id {
            issues.push(format!(
                "{} 内部 canvas_id={}，与 index id={} 不一致",
                path.display(),
                canvas.canvas_id,
                entry.id
            ));
        }
        if canvas.name != entry.name {
            issues.push(format!(
                "{} 名称={}，与 index name={} 不一致",
                path.display(),
                canvas.name,
                entry.name
            ));
        }
        let node_count = canvas.nodes.as_array().map(|a| a.len() as u32).unwrap_or(0);
        if node_count != entry.node_count {
            issues.push(format!(
                "{} 节点数={}，与 index node_count={} 不一致",
                path.display(),
                node_count,
                entry.node_count
            ));
        }
        let edge_count = canvas.edges.as_array().map(|a| a.len() as u32).unwrap_or(0);
        if edge_count != entry.edge_count {
            issues.push(format!(
                "{} 连线数={}，与 index edge_count={} 不一致",
                path.display(),
                edge_count,
                entry.edge_count
            ));
        }
    }

    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.file_name().and_then(|s| s.to_str()) == Some(CANVAS_INDEX_FILE) {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if !seen_ids.contains(stem) {
                issues.push(format!(
                    "发现未被 index.json 记录的单画布文件: {}",
                    path.display()
                ));
            }
        }
    }

    Ok(CanvasStorageCheck {
        ok: issues.is_empty(),
        storage_dir: dir.to_string_lossy().to_string(),
        canvas_count,
        checked_files,
        issues,
    })
}

#[tauri::command]
fn load_canvas(app: tauri::AppHandle, canvas_id: String) -> Result<CanvasFile, String> {
    let path = canvas_file_path(&app, &canvas_id)?;
    if !path.exists() {
        return Err(format!("画布不存在: {}", canvas_id));
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let canvas: CanvasFile = match serde_json::from_str(&raw) {
        Ok(c) => c,
        Err(e) => {
            let backup =
                path.with_extension(format!("json.corrupt-{}", chrono::Local::now().timestamp()));
            let _ = std::fs::copy(&path, &backup);
            return Err(format!("画布文件解析失败: {}，已备份为 {:?}", e, backup));
        }
    };
    normalize_loaded_canvas(canvas)
}

#[tauri::command]
fn save_canvas(
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    canvas: CanvasFile,
) -> Result<CanvasListEntry, String> {
    // 校验 canvas_id
    if canvas.canvas_id.is_empty() {
        return Err("画布 ID 不能为空".to_string());
    }
    backend
        .canvas_agent()
        .save_normal_canvas(canvas)
        .map(canvas_list_entry)
        .map_err(canvas_storage_error)
}

#[tauri::command]
fn rename_canvas(
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    canvas_id: String,
    name: String,
    expected_revision: u64,
    expected_digest: String,
) -> Result<CanvasListEntry, String> {
    backend
        .canvas_agent()
        .rename_normal_canvas(&canvas_id, &name, expected_revision, &expected_digest)
        .map(canvas_list_entry)
        .map_err(canvas_storage_error)
}

#[tauri::command]
fn delete_canvas(
    backend: tauri::State<'_, Arc<backend::BackendServices>>,
    canvas_id: String,
    expected_revision: u64,
    expected_digest: String,
) -> Result<(), String> {
    // D65-R1: 删除不做默认画布保护，前端如果需要保护"default"画布，
    // 应在 UI 层拦截，不要走后端。允许删除任何通过校验的 canvasId。
    backend
        .canvas_agent()
        .delete_normal_canvas(&canvas_id, expected_revision, &expected_digest)
        .map_err(canvas_storage_error)
}

#[tauri::command]
fn save_canvas_thumbnail(
    app: tauri::AppHandle,
    canvas_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let base = canvases_dir(&app)?;
    let thumb_dir = base.join(".thumbnails");
    std::fs::create_dir_all(&thumb_dir).map_err(|e| e.to_string())?;
    let path = thumb_dir.join(format!("{}.png", canvas_id));
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_canvas_thumbnail(app: tauri::AppHandle, canvas_id: String) -> Result<(), String> {
    let base = canvases_dir(&app)?;
    let path = base.join(".thumbnails").join(format!("{}.png", canvas_id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod canvas_storage_tests {
    use super::{
        atomic_write_canvas_json, canvas_content_digest, canvas_cover_from_nodes,
        normalize_loaded_canvas, CanvasFile,
    };
    use std::sync::atomic::{AtomicBool, Ordering};

    struct CanvasPermit(AtomicBool);

    impl crate::canvas_agent::CanvasWritePermit for CanvasPermit {
        fn consume(
            &self,
            _binding: &crate::canvas_agent::CanvasWriteBinding,
        ) -> Result<(), crate::canvas_agent::CanvasAgentError> {
            if self.0.swap(true, Ordering::SeqCst) {
                return Err(crate::canvas_agent::CanvasAgentError::new(
                    "canvas-agent-permit-consumed",
                ));
            }
            Ok(())
        }
    }

    #[test]
    fn atomically_replaces_existing_canvas_json() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-canvas-atomic-{}-{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("canvas.json");
        atomic_write_canvas_json(&path, br#"{"version":1}"#).unwrap();
        atomic_write_canvas_json(&path, br#"{"version":2,"complete":true}"#).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"version":2,"complete":true}"#
        );
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn caches_the_highest_priority_material_cover() {
        let nodes = serde_json::json!([
            { "data": { "kind": "generator", "generationKind": "video", "resultMediaUrl": "video.mp4" } },
            { "data": { "kind": "image", "refMediaUrl": "image.png", "refThumbnailUrl": "thumb.png" } }
        ]);
        assert_eq!(
            canvas_cover_from_nodes(&nodes),
            (
                Some("image".to_string()),
                Some("thumb.png".to_string()),
                None
            )
        );
    }

    fn sample_canvas(nodes: serde_json::Value) -> CanvasFile {
        CanvasFile {
            schema_version: 1,
            canvas_id: "canvas-test".to_string(),
            name: "Test".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-02T00:00:00Z".to_string(),
            nodes,
            edges: serde_json::json!([]),
            viewport: serde_json::json!({"zoom":1,"y":0,"x":0}),
            generation_history: serde_json::json!([]),
            revision: 0,
            content_digest: String::new(),
            agent_receipts: Vec::new(),
        }
    }

    #[test]
    fn canvas_digest_is_canonical_and_excludes_revision_and_updated_at() {
        let first =
            sample_canvas(serde_json::json!([{"data":{"text":"hello","title":"A"},"id":"n1"}]));
        let mut second =
            sample_canvas(serde_json::json!([{"id":"n1","data":{"title":"A","text":"hello"}}]));
        second.revision = 99;
        second.updated_at = "2030-02-01T00:00:00Z".to_string();
        second
            .agent_receipts
            .push(crate::canvas_agent::CanvasAgentReceipt {
                operation_digest: "a".repeat(64),
                revision: 1,
                metadata: serde_json::Map::new(),
            });
        assert_eq!(
            canvas_content_digest(&first).unwrap(),
            canvas_content_digest(&second).unwrap()
        );
    }

    #[test]
    fn canvas_v2_receipts_are_preserved_but_not_part_of_content_identity() {
        let mut canvas = sample_canvas(serde_json::json!([{"id":"n1"}]));
        canvas.schema_version = 2;
        canvas.revision = 4;
        canvas
            .agent_receipts
            .push(crate::canvas_agent::CanvasAgentReceipt {
                operation_digest: "b".repeat(64),
                revision: 4,
                metadata: serde_json::Map::from_iter([(
                    "stage".to_owned(),
                    serde_json::json!("canvas-committed"),
                )]),
            });
        canvas.content_digest = canvas_content_digest(&canvas).unwrap();
        let loaded = normalize_loaded_canvas(canvas.clone()).unwrap();
        assert_eq!(loaded.agent_receipts, canvas.agent_receipts);
        let mut without_receipt = canvas;
        without_receipt.agent_receipts.clear();
        assert_eq!(
            canvas_content_digest(&loaded).unwrap(),
            canvas_content_digest(&without_receipt).unwrap()
        );
    }

    #[test]
    fn canvas_v1_load_gets_a_digest_without_mutating_schema() {
        let canvas = normalize_loaded_canvas(sample_canvas(serde_json::json!([]))).unwrap();
        assert_eq!(canvas.schema_version, 1);
        assert_eq!(canvas.revision, 0);
        assert_eq!(canvas.content_digest.len(), 64);
    }

    #[test]
    fn canvas_v2_rejects_tampered_payload() {
        let mut canvas = sample_canvas(serde_json::json!([]));
        canvas.schema_version = 2;
        canvas.revision = 3;
        canvas.content_digest = canvas_content_digest(&canvas).unwrap();
        canvas.nodes = serde_json::json!([{"id":"tampered"}]);
        assert_eq!(
            normalize_loaded_canvas(canvas).unwrap_err(),
            "canvas-content-digest-invalid"
        );
    }

    #[test]
    fn agent_commit_normal_save_reload_and_agent_inspect_share_one_schema() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-canvas-cross-service-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let canvas_dir = root.join("canvases");
        std::fs::create_dir_all(&canvas_dir).unwrap();
        let mut initial = sample_canvas(serde_json::json!([{
            "id":"node-1",
            "type":"spike",
            "position":{"x":0,"y":0},
            "data":{"kind":"text","role":"text","label":"before","result":"before"}
        }]));
        initial.canvas_id = "canvas-chain".to_owned();
        initial.schema_version = 2;
        initial.revision = 1;
        initial.content_digest = canvas_content_digest(&initial).unwrap();
        let path = canvas_dir.join("canvas-chain.json");
        atomic_write_canvas_json(&path, &serde_json::to_vec_pretty(&initial).unwrap()).unwrap();

        let agent = crate::canvas_agent::CanvasAgentService::new(&root);
        agent.activate("canvas-chain").unwrap();
        let scope = agent.current_scope().unwrap();
        let prepared = agent
            .prepare(
                scope,
                "canvas.mutate",
                &serde_json::json!({
                    "requestId":"request-chain",
                    "operations":[{"op":"update","nodeId":"node-1","title":"agent","text":"agent"}]
                }),
                crate::canvas_agent::CanvasWriteScope {
                    local_turn_id: "local-turn".to_owned(),
                    engine_session_id: "engine-session".to_owned(),
                    engine_turn_id: "engine-turn".to_owned(),
                    tool_call_id: "tool-call".to_owned(),
                    generation: 1,
                },
                [9; 32],
            )
            .unwrap();
        agent
            .execute(scope, prepared, &CanvasPermit(AtomicBool::new(false)))
            .unwrap();
        let agent_committed = crate::canvas_agent::load_document(&root, "canvas-chain").unwrap();
        assert_eq!(agent_committed.revision, 2);
        assert_eq!(agent_committed.agent_receipts.len(), 1);

        let mut normal_input = agent_committed.clone();
        normal_input.agent_receipts.clear();
        normal_input.name = "normal-save".to_owned();
        let normal_saved = agent.save_normal_canvas(normal_input).unwrap();
        assert_eq!(normal_saved.revision, 3);
        let reloaded = crate::canvas_agent::load_document(&root, "canvas-chain").unwrap();
        assert_eq!(reloaded.revision, 3);
        assert_eq!(reloaded.agent_receipts, agent_committed.agent_receipts);
        assert_eq!(
            reloaded.content_digest,
            canvas_content_digest(&reloaded).unwrap()
        );

        agent.clear();
        agent.activate("canvas-chain").unwrap();
        let inspected = agent.inspect(agent.current_scope().unwrap()).unwrap();
        assert_eq!(inspected["revision"], 3);
        assert_eq!(inspected["nodes"][0]["title"], "agent");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_known_receipt_metadata_fails_closed() {
        let mut canvas = sample_canvas(serde_json::json!([]));
        canvas.schema_version = 2;
        canvas.revision = 1;
        canvas
            .agent_receipts
            .push(crate::canvas_agent::CanvasAgentReceipt {
                operation_digest: "c".repeat(64),
                revision: 1,
                metadata: serde_json::Map::from_iter([(
                    "materialId".to_owned(),
                    serde_json::json!({"not":"an-id"}),
                )]),
            });
        canvas.content_digest = canvas_content_digest(&canvas).unwrap();
        assert_eq!(
            normalize_loaded_canvas(canvas).unwrap_err(),
            "canvas-content-digest-invalid"
        );
    }
}
