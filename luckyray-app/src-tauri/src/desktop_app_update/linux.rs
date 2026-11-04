//! Linux AppImage native update service. Mirrors the Windows v1.9.9 pipeline
//! (`windows.rs`) step for step: check -> download -> verify -> schedule or
//! immediate restart, with the same state machine, snapshot shape and event.
//! Differences are only the platform pieces: the Linux release identity
//! (`LINUX_PROFILE`, `linux-x86_64-appimage`), the application-data staging
//! directory, and the T35 atomic AppImage replacement instead of NSIS.
//! Only a validated AppImage target enables it; a deb (or any invalid target)
//! keeps the `disabled` notice-only status.
use super::feed::{self, Candidate, MANIFEST};
use super::{
    appimage,
    policy::{Machine, Phase, Ticket},
    store::{Intent, Store},
    verification::*,
};
use serde::Deserialize;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
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
}
type Shared = Arc<Service>;
/// Process-lifetime owner lock; never released while this process runs.
static OWNER_LOCK: std::sync::OnceLock<std::fs::File> = std::sync::OnceLock::new();

/// Same admission rule as Windows: only an enabled, official, release build.
/// Linux replaces `production_nsis` with "validated AppImage target".
fn admitted(trust: &Trust, identifier: &str, release_build: bool, appimage: bool) -> bool {
    trust.enabled
        && release_build
        && appimage
        && identifier == trust.identifier
        && trust.identifier == "com.luckyray.desktop"
        && trust.manifest_url == MANIFEST
        && !trust.public_key.is_empty()
}

pub(crate) fn scheduled_exit_guard_required(app: &tauri::AppHandle) -> Result<bool, &'static str> {
    let Some(service) = app.try_state::<Shared>() else { return Ok(false); };
    let d = service.data.lock().map_err(|_| "update-state-unavailable")?;
    Ok(d.machine.requires_saved_lsh_exit())
}
pub(crate) fn report_scheduled_quit_blocked(app: &tauri::AppHandle, code: &'static str) {
    let Some(service) = app.try_state::<Shared>() else { return; };
    let recorded = service.data.lock().unwrap_or_else(|error| error.into_inner())
        .machine.scheduled_quit_blocked(code);
    if recorded {
        // The schedule stays cancellable; the settings card shows the code.
        service.emit(app);
    }
}
impl Service {
    fn snapshot(&self) -> serde_json::Value {
        let d = self.data.lock().unwrap_or_else(|e| e.into_inner());
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
            !self.data.lock().unwrap_or_else(|e| e.into_inner()).machine.current(ticket)
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
                || !self.data.lock().unwrap_or_else(|e| e.into_inner()).machine.current(ticket),
                |size, total| {
                    let active = {
                        let mut d = self.data.lock().map_err(|_| "update-state-unavailable")?;
                        d.machine.progress(ticket, size, total, MAX_PACKAGE_BYTES as u64)?
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
            appimage::verify(&bytes, &update.signature, &self.trust.public_key, &update.version)?;
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
                &Intent { version: update.version.clone(), url: update.url.clone(), signature: update.signature.clone() },
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
    /// Immediate install. Like Windows `restart()`: the stored intent is NOT
    /// consumed before verification; a refusal before the replace keeps the
    /// verified package (Ready/Scheduled) for a later attempt. Once the
    /// replacement starts it is a single recorded attempt, never re-looped.
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
            appimage::verify(&bytes, &update.signature, &self.trust.public_key, &update.version)?;
            feed::confirm_release(&update, tauri::async_runtime::block_on(fetch_update(app, || false)))?;
            let target: std::cell::RefCell<Option<PathBuf>> = std::cell::RefCell::new(None);
            crate::quit_for_appimage_update(
                app,
                || {
                    *target.borrow_mut() = Some(appimage::resolve_target()?);
                    self.store.ensure()
                },
                || {
                    let target = target.borrow().clone().ok_or("update-appimage-target-unavailable")?;
                    attempted = true;
                    self.store.begin_immediate_attempt(&Intent {
                        version: update.version.clone(), url: update.url.clone(), signature: update.signature.clone(),
                    })?;
                    appimage::replace_target(&bytes, &target)?;
                    appimage::restart(&target)
                },
            )
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
        Ok(())
    }
}

async fn fetch_update(
    app: &tauri::AppHandle,
    cancelled: impl Fn() -> bool,
) -> Result<Option<Candidate>, &'static str> {
    let bytes = feed::fetch(MANIFEST, feed::MAX_MANIFEST_BYTES, Duration::from_secs(20), cancelled, |_, _| Ok(())).await?;
    feed::parse(&bytes, &app.package_info().version.to_string(), &LINUX_PROFILE)
}

/// Called in setup BEFORE backend, transport, DSH or gateway construction,
/// at the same point as the Windows initializer.
pub(crate) fn initialize(app: &mut tauri::App) -> Result<(), String> {
    let trust: Trust =
        serde_json::from_str(include_str!("trust.json")).map_err(|_| "update-trust-invalid")?;
    let release_build = !cfg!(debug_assertions) && cfg!(target_arch = "x86_64");
    let enabled = admitted(&trust, &app.config().identifier, release_build, appimage::install_format() == "appimage");
    let store = Store::new(
        app.path().app_data_dir().map_err(|_| "update-app-data-unavailable")?.join("desktop-update"),
    );
    let service = Arc::new(Service {
        data: Mutex::new(Data { machine: Machine::new(enabled), update: None, bytes: None }),
        store,
        trust,
    });
    if enabled {
        // Same lifetime ownership as Windows production NSIS: a second
        // instance refuses to start services while another owns the install.
        let lock = appimage::acquire_owner_lock(service.store.root(), Duration::from_secs(30)).map_err(|code| {
            eprintln!("LuckyRay 或其更新仍在运行，或无法确认安装环境安全。请正常关闭另一个实例，再启动此版本。\nAnother LuckyRay instance may be running. Close it normally and try again. ({code})");
            code.to_string()
        })?;
        OWNER_LOCK.set(lock).map_err(|_| "update-ownership-unknown")?;
        let main = app.get_webview_window("main");
        let pending = service.store.pending();
        if pending {
            if let Some(window) = &main { let _ = window.hide(); }
        }
        let boot_result = bootstrap(app.handle(), &service);
        if pending {
            if let Some(window) = &main { let _ = window.show(); }
        }
        if let Err(code) = boot_result {
            let mut d = service.data.lock().map_err(|_| "update-state-unavailable")?;
            d.machine.phase = Phase::Error;
            d.machine.error = Some(code);
            d.machine.revision += 1;
        }
    }
    app.manage(service);
    Ok(())
}
/// Scheduled install at startup. Same order as Windows `bootstrap`, including
/// consuming the intent BEFORE validate/verify: this is intentional in v1.9.9
/// (store.rs `take_intent`: "Consume before any attempt. Crashes/canceled
/// installers cannot form a restart loop."). A failure surfaces as an error and
/// the user re-checks and reschedules; it is never retried automatically.
fn bootstrap(app: &tauri::AppHandle, service: &Service) -> Result<(), &'static str> {
    let installed = app.package_info().version.to_string();
    if !service.store.pending() {
        if service.store.unfinished_attempt() {
            let attempt = service.store.attempt()?;
            // No installer marker exists on Linux: the running version is the
            // completion evidence (the replaced AppImage reports the new one).
            if stable_version(&installed)? >= stable_version(&attempt.version)? {
                service.store.clear_attempt()?;
            } else {
                return Err("update-previous-install-incomplete");
            }
        }
        return Ok(());
    }
    let intent = service.store.take_intent()?.ok_or("update-cache-invalid")?;
    intent.validate(&installed, &LINUX_PROFILE)?;
    let target = appimage::resolve_target()?;
    let bytes = service.store.package()?;
    // A cached file is untrusted even though it was verified in a prior process.
    appimage::verify(&bytes, &intent.signature, &service.trust.public_key, &intent.version)?;
    feed::confirm_release(
        &Candidate { version: intent.version, url: intent.url, signature: intent.signature },
        tauri::async_runtime::block_on(fetch_update(app, || false)),
    )?;
    appimage::replace_target(&bytes, &target)?;
    appimage::restart(&target)?;
    // No backend/LSH/editor has started in this process.
    std::process::exit(0)
}

#[tauri::command]
pub(crate) async fn desktop_application_update(
    window: tauri::WebviewWindow,
    action: String,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("update-action-unavailable".into());
    }
    // Linux slice S4: the renderer asks which asset this install takes.
    if action == "format" {
        return Ok(serde_json::json!({"format": appimage::install_format()}));
    }
    let app = window.app_handle().clone();
    let service = app.try_state::<Shared>().ok_or("update-state-unavailable")?.inner().clone();
    let enabled = service.data.lock().map_err(|_| "update-state-unavailable")?.machine.phase != Phase::Disabled;
    if !enabled {
        // deb / invalid AppImage target: notice-only, nothing is read or replaced.
        return match action.as_str() {
            "status" => Ok(service.snapshot()),
            "install" | "restart" => Err("update-deb-notice-only".into()),
            _ => Err("update-action-unavailable".into()),
        };
    }
    match action.as_str() {
        "status" => {}
        "check" => service.check(&app).await.map_err(str::to_owned)?,
        "download" => service.download(&app).await.map_err(str::to_owned)?,
        "install" => {
            let s = service.clone();
            let a = app.clone();
            tauri::async_runtime::spawn_blocking(move || s.schedule(&a))
                .await.map_err(|_| "update-worker-failed")?.map_err(str::to_owned)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    fn trust() -> Trust {
        serde_json::from_str(include_str!("trust.json")).unwrap()
    }
    #[test]
    fn only_a_release_appimage_with_official_trust_is_admitted() {
        let t = trust();
        assert!(admitted(&t, "com.luckyray.desktop", true, true));
        assert!(!admitted(&t, "com.luckyray.desktop", true, false));
        assert!(!admitted(&t, "com.luckyray.desktop", false, true));
        assert!(!admitted(&t, "com.example.other", true, true));
        let mut off = trust();
        off.enabled = false;
        assert!(!admitted(&off, "com.luckyray.desktop", true, true));
        let mut feed = trust();
        feed.manifest_url = "https://example.com/latest.json".into();
        assert!(!admitted(&feed, "com.luckyray.desktop", true, true));
        let mut key = trust();
        key.public_key.clear();
        assert!(!admitted(&key, "com.luckyray.desktop", true, true));
    }
}
