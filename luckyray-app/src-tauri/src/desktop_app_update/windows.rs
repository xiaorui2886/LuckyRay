use super::feed::{self, Candidate, MANIFEST};
use super::{
    ownership::Ownership,
    policy::{Machine, Phase, Ticket},
    store::{Intent, Store},
    verification::*,
};
use serde::Deserialize;
use std::{
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

const EVENT: &str = "luckyray:desktop-update-status";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Trust {
    enabled: bool,
    public_key: String,
    manifest_url: String,
    identifier: String,
}
struct Data {
    machine: Machine,
    update: Option<Candidate>,
    bytes: Option<Vec<u8>>,
}
struct Service {
    data: Mutex<Data>,
    store: Store,
    trust: Trust,
    ownership: Option<Arc<Ownership>>,
}
type Shared = Arc<Service>;
static OWNERSHIP: OnceLock<Arc<Ownership>> = OnceLock::new();
pub(crate) fn scheduled_exit_guard_required(app: &tauri::AppHandle) -> Result<bool, &'static str> {
    let Some(service) = app.try_state::<Shared>() else { return Ok(false); };
    let d = service.data.lock().map_err(|_| "update-state-unavailable")?;
    Ok(d.machine.requires_saved_lsh_exit())
}
pub(crate) fn report_scheduled_quit_blocked(app: &tauri::AppHandle, code: &'static str) {
    let Some(service) = app.try_state::<Shared>() else { return; };
    let recorded = service.data.lock().unwrap_or_else(|error| error.into_inner())
        .machine.scheduled_quit_blocked(code);
    if !recorded { return; }
    service.emit(app);
    // A tray quit may hide the settings card. Show an application-owned notice,
    // keeping the scheduled intent cancellable instead of silently exiting.
    let reason = match code {
        "update-lsh-task-active" => "LSH 仍有执行任务、审批或排队输入。 / LSH work or approval is still active.",
        "update-lsh-composition-pending" => "LSH 输入法组合尚未结束。 / LSH input composition is unfinished.",
        "update-lsh-draft-pending" => "LSH 仍有未提交的文字或附件。 / LSH has an unsubmitted draft.",
        "update-lsh-save-failed" | "update-lsh-save-timeout" => "LSH 尚未确认会话安全保存。 / LSH saving has not been confirmed.",
        "update-lsh-content-changed" => "LSH 会话在保存确认后又发生变化。 / The LSH session changed after its save confirmation.",
        "update-editors-not-saved" => "笔记、输入或画布保存尚未完成。 / Editor saving is unfinished.",
        _ => "后台保存或正常退出尚未确认。 / Safe saving or shutdown is not confirmed.",
    };
    super::installer::startup_notice(&format!("已停止本次更新退出，软件保持打开。完成当前工作后可重试，或在更新设置中取消安排。\n{reason}\n\nUpdate exit was stopped. Finish your work and retry, or cancel the scheduled update in Settings."));
}
impl Service {
    fn snapshot(&self) -> serde_json::Value {
        let d = self.data.lock().unwrap_or_else(|e| e.into_inner());
        Self::snapshot_locked(&d)
    }
    fn snapshot_locked(d: &Data) -> serde_json::Value {
        let m = &d.machine;
        serde_json::json!({
        "revision":m.revision,"phase":m.phase.name(),"version":d.update.as_ref().map(|u|&u.version),
        "downloadedBytes":m.downloaded,"totalBytes":m.total,"errorCode":m.error,
        "canCheck":m.can_check(),"canDownload":m.phase==Phase::Available,"canCancel":m.can_cancel(),"canInstall":m.phase==Phase::Ready})
    }
    fn emit(&self, app: &tauri::AppHandle) {
        let _ = app.emit_to("main", EVENT, self.snapshot());
    }
    fn failed(&self, ticket: Ticket, code: &'static str, app: &tauri::AppHandle) {
        {
            let mut d = self.data.lock().unwrap_or_else(|e| e.into_inner());
            if d.machine.fail(ticket, code) {
                d.bytes = None;
            }
        }
        self.emit(app);
    }
    async fn check(&self, app: &tauri::AppHandle) -> Result<(), &'static str> {
        let ticket = {
            let mut d = self.data.lock().map_err(|_| "update-state-unavailable")?;
            let t = d.machine.check()?;
            d.update = None;
            d.bytes = None;
            t
        };
        self.emit(app);
        let result = fetch_update(app, || {
            !self
                .data
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .machine
                .current(ticket)
        })
        .await;
        match result {
            Ok(update) => {
                let mut d = self.data.lock().map_err(|_| "update-state-unavailable")?;
                if d.machine.checked(ticket, update.is_some()) {
                    d.update = update;
                }
            }
            Err(e) => self.failed(ticket, e, app),
        }
        self.emit(app);
        Ok(())
    }
    async fn download(&self, app: &tauri::AppHandle) -> Result<(), &'static str> {
        let (ticket, update) = {
            let mut d = self.data.lock().map_err(|_| "update-state-unavailable")?;
            let update = d.update.clone().ok_or("update-action-unavailable")?;
            (d.machine.download()?, update)
        };
        self.emit(app);
        let result = (async {
            let mut last = Instant::now();
            let bytes = feed::fetch(
                &update.url,
                MAX_PACKAGE_BYTES,
                Duration::from_secs(1800),
                || {
                    !self
                        .data
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .machine
                        .current(ticket)
                },
                |size, total| {
                    let active = {
                        let mut d = self.data.lock().map_err(|_| "update-state-unavailable")?;
                        d.machine
                            .progress(ticket, size, total, MAX_PACKAGE_BYTES as u64)?
                    };
                    if !active {
                        return Err("update-cancelled");
                    }
                    if last.elapsed() >= Duration::from_millis(200) {
                        self.emit(app);
                        last = Instant::now();
                    }
                    Ok(())
                },
            )
            .await?;
            {
                let mut d = self.data.lock().map_err(|_| "update-state-unavailable")?;
                if !d.machine.verifying(ticket)? {
                    return Err("update-cancelled");
                }
            }
            self.emit(app);
            verify_package(
                &bytes,
                &update.signature,
                &self.trust.public_key,
                &update.version,
            )?;
            let mut d = self.data.lock().map_err(|_| "update-state-unavailable")?;
            if d.machine.verified(ticket) {
                d.bytes = Some(bytes);
            }
            Ok(())
        })
        .await;
        if let Err(code) = result {
            self.failed(ticket, code, app);
        }
        self.emit(app);
        Ok(())
    }
    fn schedule(&self, app: &tauri::AppHandle) -> Result<(), &'static str> {
        {
            let mut d = self.data.lock().map_err(|_| "update-state-unavailable")?;
            if d.machine.phase != Phase::Ready {
                return Err("update-not-verified");
            }
            let update = d.update.as_ref().ok_or("update-not-verified")?;
            let bytes = d.bytes.as_ref().ok_or("update-not-verified")?;
            // The same Rust-owned bytes already passed signature+version verification.
            self.store.schedule(
                &Intent {
                    version: update.version.clone(),
                    url: update.url.clone(),
                    signature: update.signature.clone(),
                },
                bytes,
            )?;
            d.machine.schedule()?;
            d.bytes = None;
        }
        self.emit(app);
        Ok(())
    }
    fn cancel(&self, app: &tauri::AppHandle) -> Result<(), &'static str> {
        {
            let mut d = self.data.lock().map_err(|_| "update-state-unavailable")?;
            if !d.machine.can_cancel() {
                return Err("update-cancel-unavailable");
            }
            self.store.cancel()?;
            d.machine.cancel()?;
            d.update = None;
            d.bytes = None;
        }
        self.emit(app);
        Ok(())
    }
    fn restart(&self, app: &tauri::AppHandle) -> Result<(), &'static str> {
        let (ticket, update, memory_bytes) = {
            let mut d = self.data.lock().map_err(|_| "update-state-unavailable")?;
            let update = d.update.clone().ok_or("update-not-verified")?;
            let ticket = d.machine.prepare_restart()?;
            (ticket, update, d.bytes.clone())
        };
        self.emit(app);
        let mut attempted = false;
        let result = (|| {
            let bytes = match memory_bytes { Some(bytes) => bytes, None => self.store.package()? };
            verify_package(&bytes, &update.signature, &self.trust.public_key, &update.version)?;
            feed::confirm_release(&update, tauri::async_runtime::block_on(fetch_update(app, || false)))?;
            crate::quit_for_desktop_update(app, |reserved_probe| {
                self.ownership.as_ref().ok_or("update-ownership-unknown")?.admit_for_restart(reserved_probe)?;
                self.store.ensure()?;
                let installer = super::installer::prepare(self.store.root(), &bytes)?;
                // From here failure is an attempt, not a restored scheduled
                // instruction. A later process must never loop the installer.
                attempted = true;
                self.store.begin_immediate_attempt(&Intent {
                    version: update.version.clone(), url: update.url.clone(), signature: update.signature.clone(),
                })?;
                Ok(installer)
            })
        })();
        {
            let mut d = self.data.lock().map_err(|_| "update-state-unavailable")?;
            match result {
                Err(code) if !attempted => { d.machine.restart_blocked(ticket, code); }
                Err(code) => { d.machine.restart_handoff(ticket, Some(code)); }
                Ok(()) => { d.machine.restart_handoff(ticket, None); }
            }
        }
        self.emit(app);
        // Publish a typed status even for a safe refusal so the renderer can
        // show its reason and keep the verified package available for later.
        Ok(())
    }
}

async fn fetch_update(
    app: &tauri::AppHandle,
    cancelled: impl Fn() -> bool,
) -> Result<Option<Candidate>, &'static str> {
    let bytes = feed::fetch(
        MANIFEST,
        feed::MAX_MANIFEST_BYTES,
        Duration::from_secs(20),
        cancelled,
        |_, _| Ok(()),
    )
    .await?;
    feed::parse(&bytes, &app.package_info().version.to_string())
}

/// Called in setup BEFORE backend, transport, DSH or gateway construction.
/// Pending intent is consumed once; failures continue ordinary startup with an error.
/// A used/active app is never stopped to install an update.
pub(crate) fn initialize(app: &mut tauri::App, profile: &Path) -> Result<(), String> {
    let trust: Trust =
        serde_json::from_str(include_str!("trust.json")).map_err(|_| "update-trust-invalid")?;
    let production_nsis = !cfg!(debug_assertions)
        && cfg!(target_arch = "x86_64")
        && matches!(
            tauri::utils::platform::bundle_type(),
            Some(tauri::utils::config::BundleType::Nsis)
        )
        && app.config().identifier == "com.luckyray.desktop";
    let enabled = trust.enabled
        && production_nsis
        && app.config().identifier == trust.identifier
        && trust.identifier == "com.luckyray.desktop"
        && trust.manifest_url == MANIFEST
        && !trust.public_key.is_empty();
    let store = Store::new(
        app.path()
            .app_cache_dir()
            .map_err(|_| "update-cache-unavailable")?
            .join("signed-desktop-update-v1"),
    );
    let main = app.get_webview_window("main");
    if production_nsis {
        if let Some(window) = &main {
            let _ = window.hide();
        }
    }
    // Every production NSIS instance holds this for its entire lifetime.
    // A second instance cannot start services while another owns installation.
    let ownership = if production_nsis {
        {
            let guard = Arc::new(Ownership::acquire(store.root(), profile).map_err(|code| {
                super::installer::startup_notice("LuckyRay 或安装程序仍在运行，或无法确认安装环境安全。请正常关闭另一个实例，再启动此版本。\nAnother LuckyRay instance or installer may be running. Close it normally and try again.");
                code
            })?);
            OWNERSHIP
                .set(guard.clone())
                .map_err(|_| "update-ownership-unknown")?;
            Some(guard)
        }
    } else {
        None
    };
    if production_nsis {
        super::installer::refuse_incomplete_installation();
    }
    let service = Arc::new(Service {
        data: Mutex::new(Data {
            machine: Machine::new(enabled),
            update: None,
            bytes: None,
        }),
        store,
        trust,
        ownership,
    });
    if enabled {
        // Before normal UI is interactive, avoid exposing an uninitialized app behind the installer.
        let main = app.get_webview_window("main");
        let pending = service.store.pending();
        if pending {
            if let Some(window) = &main {
                let _ = window.hide();
            }
        }
        let boot_result = bootstrap(app.handle(), &service);
        if pending {
            if let Some(window) = &main {
                let _ = window.show();
            }
        }
        if let Err(code) = boot_result {
            let mut d = service
                .data
                .lock()
                .map_err(|_| "update-state-unavailable")?;
            d.machine.phase = Phase::Error;
            d.machine.error = Some(code);
            d.machine.revision += 1;
        }
    }
    if production_nsis {
        if let Some(window) = &main {
            let _ = window.show();
        }
    }
    app.manage(service);
    Ok(())
}
fn bootstrap(app: &tauri::AppHandle, service: &Service) -> Result<(), &'static str> {
    if !service.store.pending() {
        if service.store.unfinished_attempt() {
            let attempt = service.store.attempt()?;
            let current = stable_version(&app.package_info().version.to_string())?;
            if current >= stable_version(&attempt.version)?
                && super::installer::completion_matches(&current.to_string())
            {
                service.store.clear_attempt()?;
            } else {
                return Err("update-previous-install-incomplete");
            }
        }
        return Ok(());
    }
    let intent = service.store.take_intent()?.ok_or("update-cache-invalid")?;
    intent.validate(&app.package_info().version.to_string())?;
    let ownership = service
        .ownership
        .as_ref()
        .ok_or("update-ownership-unknown")?;
    ownership.admit()?;
    let bytes = service.store.package()?;
    // A cached file is untrusted even though it was verified in a prior process.
    verify_package(
        &bytes,
        &intent.signature,
        &service.trust.public_key,
        &intent.version,
    )?;
    feed::confirm_release(&Candidate {
        version: intent.version, url: intent.url, signature: intent.signature,
    }, tauri::async_runtime::block_on(fetch_update(app, || false)))?;
    ownership.admit()?;
    // Official installer receives only this immutable, freshly verified buffer.
    // No normal services have been initialized, so failure can resume normal startup.
    super::installer::launch(service.store.root(), &bytes)
}

#[tauri::command]
pub(crate) async fn desktop_application_update(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    action: String,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("update-main-only".into());
    }
    let service = app
        .try_state::<Shared>()
        .ok_or("update-state-unavailable")?
        .inner()
        .clone();
    match action.as_str() {
        "status" => {}
        "check" => service.check(&app).await.map_err(str::to_owned)?,
        "download" => service.download(&app).await.map_err(str::to_owned)?,
        "install" => {
            let s = service.clone();
            let a = app.clone();
            tauri::async_runtime::spawn_blocking(move || s.schedule(&a))
                .await
                .map_err(|_| "update-worker-failed")?
                .map_err(str::to_owned)?;
        }
        "restart" => {
            let s = service.clone();
            let a = app.clone();
            tauri::async_runtime::spawn_blocking(move || s.restart(&a))
                .await.map_err(|_| "update-worker-failed")?.map_err(str::to_owned)?;
        }
        "cancel" => service.cancel(&app).map_err(str::to_owned)?,
        _ => return Err("update-action-unavailable".into()),
    }
    Ok(service.snapshot())
}
