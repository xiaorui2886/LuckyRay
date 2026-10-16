//! One update state shared by the Settings and LightSeek entry points. The
//! updater never invokes an installer or hot-switches a live DSH generation.

use super::{
    admit_for_this_build, check_catalog, download_artifact_with_progress, trusted_source_for_this_build,
    AdmittedCandidate, CatalogError,
};
use crate::dsh_host::{DshHostService, DshNativeSurfaceStage, DshHostStage};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineUpdateStatus {
    pub(crate) phase: &'static str,
    pub(crate) current_version: Option<String>,
    pub(crate) candidate_version: Option<String>,
    pub(crate) upstream_version: Option<String>,
    pub(crate) upstream_unvalidated: bool,
    pub(crate) catalog_status: &'static str,
    pub(crate) source_class: &'static str,
    pub(crate) channel: &'static str,
    pub(crate) can_check: bool,
    pub(crate) can_install: bool,
    pub(crate) can_cancel: bool,
    pub(crate) can_recover: bool,
    pub(crate) can_verify: bool,
    pub(crate) can_restart: bool,
    pub(crate) can_prepare_exit: bool,
    pub(crate) message: &'static str,
    pub(crate) switch_error: Option<String>,
    pub(crate) work_stage: Option<&'static str>,
    pub(crate) progress_done: Option<u64>,
    pub(crate) progress_total: Option<u64>,
    pub(crate) cancel_requested: bool,
}

#[derive(Default)]
struct State {
    candidate: Option<AdmittedCandidate>,
    upstream_version: Option<String>,
    catalog_status: &'static str,
    busy: bool,
    downloading: bool,
    outcome: Option<&'static str>,
    work_stage: Option<&'static str>,
    progress_done: Option<u64>,
    progress_total: Option<u64>,
    cancel_requested: bool,
    // An installation Job whose drain was not proved cannot be relabelled
    // "cancelled" or retried in the same process. Preserve its workspace.
    assembly_unsettled: bool,
}

pub(crate) struct DshEngineUpdater {
    host: Arc<DshHostService>,
    app_data: PathBuf,
    state: Mutex<State>,
    cancel_download: AtomicBool,
    #[cfg(test)]
    fixture_authority: Option<(super::TrustedSource, reqwest::blocking::Client, reqwest::Client)>,
}

impl DshEngineUpdater {
    pub(crate) fn new(host: Arc<DshHostService>, app_data: PathBuf) -> Self {
        Self {
            host,
            app_data,
            state: Mutex::new(State::default()),
            cancel_download: AtomicBool::new(false),
            #[cfg(test)]
            fixture_authority: None,
        }
    }

    pub(crate) fn status(&self) -> EngineUpdateStatus {
        let state = self.state.lock().unwrap();
        self.project(&state)
    }

    #[cfg(test)]
    pub(crate) fn with_fixture_authority(mut self, source: super::TrustedSource,
        client: reqwest::blocking::Client, artifact_client: reqwest::Client) -> Self {
        let url = reqwest::Url::parse(&source.feed_url).unwrap();
        assert_eq!(source.trust_class, "development");
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert!(self.app_data.starts_with(std::env::temp_dir()));
        self.fixture_authority = Some((source, client, artifact_client));
        self
    }

    fn source(&self) -> Option<super::TrustedSource> {
        #[cfg(test)]
        if let Some((source, _, _)) = &self.fixture_authority { return Some(source.clone()); }
        trusted_source_for_this_build().ok()
    }

    fn check_catalog(&self, current: &str, now: i64) -> Result<AdmittedCandidate, CatalogError> {
        #[cfg(test)]
        if let Some((source, client, _)) = &self.fixture_authority {
            return super::check_catalog_with_source(source, client, current, now);
        }
        check_catalog(current, now)
    }

    fn readmit(&self, bytes: &[u8], current: &str, now: i64) -> Result<AdmittedCandidate, super::AdmissionError> {
        #[cfg(test)]
        if let Some((source, _, _)) = &self.fixture_authority {
            return super::admit_with_source(source, bytes, current, now);
        }
        admit_for_this_build(bytes, current, now)
    }

    fn download(&self, candidate: &AdmittedCandidate, archive: &std::path::Path) -> Result<(), super::ArtifactError> {
        let mut progress = |done, total| self.set_work_progress("download", done, total);
        #[cfg(test)]
        if let Some((_, _, client)) = &self.fixture_authority {
            return tauri::async_runtime::block_on(super::download_artifact_with_client(client, candidate, archive, &self.cancel_download, &mut progress));
        }
        download_artifact_with_progress(candidate, archive, &self.cancel_download, &mut progress)
    }

    fn project(&self, state: &State) -> EngineUpdateStatus {
        let source = self.source();
        let context = self.host.engine_update_context();
        let current_version = context.as_ref().map(|(_, version, _)| version.clone());
        let pending_health = context.as_ref().is_some_and(|(_, _, pending)| *pending);
        let restart_required = context
            .as_ref()
            .is_some_and(|(store, _, _)| store.pending_switch());
        let phase = if state.assembly_unsettled {
            "recovery_required"
        } else if self.host.status().stage == DshHostStage::Initializing {
            "initializing"
        } else if context.is_none() && state.outcome == Some("recovered_restart_required") {
            "recovered_restart_required"
        } else if context.is_none()
            && super::read_switch_error(&self.app_data).is_some()
        {
            "switch_incomplete"
        } else if context.is_none() {
            "recovery_required"
        } else if pending_health && state.outcome == Some("verification_failed") {
            "verification_failed"
        } else if pending_health {
            "verification_required"
        } else if restart_required && state.outcome == Some("exit_prepared") {
            "exit_prepared"
        } else if restart_required {
            "restart_required"
        } else if state.busy {
            "working"
        } else if matches!(state.outcome, Some("recovered" | "healthy")) {
            state.outcome.unwrap()
        } else if source.is_none() && state.outcome.is_none() {
            "unconfigured"
        } else {
            state.outcome.unwrap_or(if state.candidate.is_some() {
                "available"
            } else {
                "idle"
            })
        };
        let message = match phase {
            "initializing" => "正在核验运行资源；尚不能检查或安装更新。",
            "recovery_required" => "引擎或更新记录无法验证；已停止升级，请保留现有数据。",
            "switch_incomplete" => "引擎切换在重启后未完成，现有引擎与资料未被替换。可在设置中撤销本次切换并恢复，或稍后重试更新；失败类别已记录在应用数据目录的 last-switch-error.json。",
            "recovered_restart_required" => "未激活的待切换记录已保留归档；请正常关闭并重新打开 LuckyRay。",
            "recovered" => "未激活的待切换记录已归档，现有引擎和资料未改动。",
            "verification_required" => "新版引擎已切换，仍需完成启动和资源链验收；不会自动回滚数据。",
            "verification_failed" => "本机健康检查未通过；当前引擎仍保留，未自动回滚资料。请确认 LightSeek 会话可打开并处理插件问题后重试。",
            "healthy" => "已验证新版引擎、会话界面及插件组合；本机健康状态已保存。",
            "restart_required" => "新版已验证暂存。可从冷宿主直接受控重启；若已使用 LightSeek，请先完成任务、核对草稿，再准备正常退出切换。",
            "exit_prepared" => "已准备在本次正常退出后切换。请先保存其他页面更改、完成 LightSeek 与远程任务，再从 LuckyRay 完全退出并重新打开；隐藏窗口或异常终止不会激活更新。",
            "working" => "正在检查或准备引擎更新。",
            "unconfigured" => "当前构建未配置受信签名更新源，不能在线升级引擎。",
            "current" => "当前没有适用于此宿主的更高版本。",
            "requires_host" => "候选要求的宿主版本、接口或能力与当前 LuckyRay 不兼容。",
            "legacy_contract" => "旧版更新清单绑定的宿主构建已变化；维护端需重新验证并提供兼容清单。",
            "no_candidate" => "受信更新源暂无候选清单；尚未获得新版安装许可。",
            "upgrade_path" => "候选未验证从当前引擎版本升级；需维护端补充升级验证。",
            "check_failed" => "检查更新失败或离线；不能判定已是最新版。",
            "untrusted" => "更新清单的签名、格式或有效期校验失败，已拒绝。",
            "prepare_failed" => "下载或验证失败；当前引擎未切换。",
            "cancelled" => "已取消下载；当前引擎未切换。",
            "available" => "发现适用于当前宿主的受信引擎版本，可主动升级。",
            "upstream_unvalidated" => "上游有新版，但 LuckyRay 尚未验证；不能直接安装。",
            "upstream_unavailable" => "官方上游源不可访问或发行身份无法确认；不能判定已是最新。",
            "upstream_identity" => "目录制品与官方发行身份不匹配，已拒绝下载。",
            _ => "可检查适用于当前宿主的引擎更新。",
        };
        let ready = context.is_some()
            && phase != "initializing"
            && !state.assembly_unsettled
            && !pending_health
            && !restart_required
            && !state.busy;
        let can_recover = matches!(phase, "recovery_required" | "switch_incomplete" | "restart_required" | "exit_prepared")
            && !state.busy
            && !state.assembly_unsettled
            && context.as_ref().map_or_else(
                || super::UpdateStore::open(&self.app_data)
                    .is_ok_and(|store| store.can_abandon_pre_activation()),
                |(store, _, _)| store.can_abandon_pre_activation(),
            );
        let can_verify = matches!(phase, "verification_required" | "verification_failed") && !state.busy;
        let can_restart = phase == "restart_required" && !state.busy
            && source.is_some()
            && self.host.status().stage == DshHostStage::BundledVerified
            && self.host.surface_status().stage == DshNativeSurfaceStage::Closed;
        let can_prepare_exit = phase == "restart_required" && !state.busy && source.is_some()
            && self.host.status().stage == DshHostStage::ProbeCompleted
            && matches!(self.host.surface_status().stage,
                DshNativeSurfaceStage::ClientReady | DshNativeSurfaceStage::SessionOpen);
        let upstream_unvalidated = unvalidated_release(state.upstream_version.as_deref(), current_version.as_deref(),
            state.candidate.as_ref().map(|candidate| candidate.version()));
        EngineUpdateStatus {
            phase,
            current_version,
            candidate_version: state
                .candidate
                .as_ref()
                .map(|candidate| candidate.version().to_owned()),
            upstream_version: state.upstream_version.clone(),
            upstream_unvalidated,
            catalog_status: if state.catalog_status.is_empty() { if source.is_some() { "unchecked" } else { "unconfigured" } } else { state.catalog_status },
            source_class: source.as_ref().map_or("none", |source| source.trust_class),
            channel: super::CHANNEL,
            can_check: ready,
            can_install: ready && source.is_some() && state.candidate.is_some(),
            can_cancel: state.busy && state.downloading && !state.cancel_requested,
            can_recover,
            can_verify,
            can_restart,
            can_prepare_exit,
            message,
            switch_error: if phase == "switch_incomplete" {
                super::read_switch_error(&self.app_data).map(|record| record.error_category)
            } else {
                None
            },
            work_stage: state.work_stage,
            progress_done: state.progress_done,
            progress_total: state.progress_total,
            cancel_requested: state.cancel_requested,
        }
    }

    pub(crate) fn check(&self) -> EngineUpdateStatus {
        let current = {
            let mut state = self.state.lock().unwrap();
            if !self.project(&state).can_check {
                return self.project(&state);
            }
            state.busy = true;
            state.downloading = false;
            state.work_stage = Some("catalog");
            state.progress_done = None;
            state.progress_total = None;
            state.cancel_requested = false;
            state.candidate = None;
            state.outcome = None;
            self.host
                .engine_update_context()
                .map(|(_, version, _)| version)
        };
        let development = self.source().is_some_and(|source| source.trust_class == "development");
        let (discovery, result) = std::thread::scope(|scope| {
            let discovery = scope.spawn(|| if development { None } else { Some(super::upstream::discover()) });
            let result = current.as_ref().and_then(|version| {
            let now = now_unix()?;
            Some(self.check_catalog(&version, now))
            });
            (discovery.join().ok().flatten(), result)
        });
        let mut state = self.state.lock().unwrap();
        state.busy = false;
        state.work_stage = None;
        state.upstream_version = discovery.as_ref().and_then(|result| result.as_ref().ok()).map(|found| found.version.clone());
        match result {
            Some(Ok(candidate)) => {
                state.candidate = Some(candidate);
                state.catalog_status = "verified";
                state.outcome = Some("available");
            }
            Some(Err(CatalogError::NotAnUpgrade)) => { state.catalog_status = "current"; state.outcome = Some("current"); },
            Some(Err(CatalogError::RequiresHost)) => { state.catalog_status = "requires_host"; state.outcome = Some("requires_host"); },
            Some(Err(CatalogError::LegacyContract)) => { state.catalog_status = "legacy_contract"; state.outcome = Some("legacy_contract"); },
            Some(Err(CatalogError::NoCandidate)) => { state.catalog_status = "no_candidate"; state.outcome = Some("no_candidate"); },
            Some(Err(CatalogError::UpgradePath)) => { state.catalog_status = "upgrade_path"; state.outcome = Some("upgrade_path"); },
            Some(Err(CatalogError::Untrusted)) => { state.catalog_status = "untrusted"; state.outcome = Some("untrusted"); },
            Some(Err(CatalogError::UpstreamIdentity)) => { state.catalog_status = "upstream_identity"; state.outcome = Some("upstream_identity"); },
            Some(Err(CatalogError::Unconfigured)) => { state.catalog_status = "unconfigured"; state.outcome = Some("unconfigured"); },
            _ => { state.catalog_status = "unavailable"; state.outcome = Some("check_failed"); },
        }
        // Do not erase catalog errors, host mismatch or a separately admitted
        // older update. A newer upstream release remains visible alongside it.
        state.outcome = Some(discovery_outcome(state.outcome.unwrap(), development,
            discovery.as_ref(), current.as_deref()));
        self.project(&state)
    }

    pub(crate) fn install(&self) -> EngineUpdateStatus {
        let (candidate, context) = {
            let mut state = self.state.lock().unwrap();
            if !self.project(&state).can_install {
                return self.project(&state);
            }
            state.busy = true;
            state.downloading = true;
            state.work_stage = Some("download");
            state.progress_done = None;
            state.progress_total = None;
            state.cancel_requested = false;
            self.cancel_download.store(false, Ordering::Release);
            (state.candidate.take(), self.host.engine_update_context())
        };
        let mut assembly_unsettled = false;
        let result = (|| {
            let admitted = candidate.ok_or(())?;
            let (store, current, pending_health) = context.ok_or(())?;
            if pending_health || store.pending_switch() {
                return Err(());
            }
            let now = now_unix().ok_or(())?;
            self.readmit(&admitted.signed_envelope, &current, now).map_err(|_| ())?;
            let archive = store.new_download_path().map_err(|_| ())?;
            // Only this newly generated archive is cleaned up. Never touch a
            // prior version, backup, or any user-controlled profile file.
            let prepared = (|| {
                self.download(&admitted, &archive).map_err(|_| ())?;
                if self.cancel_download.load(Ordering::Acquire) {
                    return Err(());
                }
                store
                    .prepare_from_archive_with_progress(admitted, &archive, &self.cancel_download,
                        &mut |stage, done, total| self.set_work_progress(stage, done, total))
                    .map_err(|error| {
                        assembly_unsettled = error == super::transaction::StoreError::RecoveryRequired;
                        ()
                    })
            })();
            let _ = std::fs::remove_file(&archive);
            let prepared = prepared?;
            {
                // Cancellation ends at the verified-staging boundary. This
                // lock is the linearization point against an in-flight click.
                let mut state = self.state.lock().unwrap();
                if self.cancel_download.load(Ordering::Acquire) {
                    return Err(());
                }
                state.downloading = false;
                state.work_stage = Some("schedule");
                state.progress_done = None;
                state.progress_total = None;
            }
            store
                .schedule_restart_switch_with_progress(&prepared, &current,
                    &mut |done, total| self.set_work_progress("schedule", done, total))
                .map_err(|_| ())
        })();
        let mut state = self.state.lock().unwrap();
        state.busy = false;
        state.downloading = false;
        state.work_stage = None;
        state.progress_done = None;
        state.progress_total = None;
        state.assembly_unsettled |= assembly_unsettled;
        state.outcome = if result.is_ok() {
            None
        } else {
            Some(preparation_failure_outcome(self.cancel_download.load(Ordering::Acquire), state.assembly_unsettled))
        };
        self.project(&state)
    }

    pub(crate) fn cancel(&self) -> EngineUpdateStatus {
        let mut state = self.state.lock().unwrap();
        if state.busy && state.downloading {
            self.cancel_download.store(true, Ordering::Release);
            state.cancel_requested = true;
        }
        self.project(&state)
    }

    fn set_work_progress(&self, stage: &'static str, done: u64, total: u64) {
        let mut state = self.state.lock().unwrap();
        state.work_stage = Some(stage);
        state.progress_done = Some(done);
        state.progress_total = Some(total);
    }

    pub(crate) fn recover_pre_activation(&self) -> EngineUpdateStatus {
        let mut state = self.state.lock().unwrap();
        if self.project(&state).can_recover {
            let context = self.host.engine_update_context();
            let recovered = context.as_ref().map_or_else(
                || super::UpdateStore::open(&self.app_data)
                    .is_ok_and(|store| store.abandon_pre_activation().is_ok()),
                |(store, _, _)| store.abandon_pre_activation().is_ok(),
            );
            if recovered {
                state.outcome = Some(if context.is_some() {
                    "recovered"
                } else {
                    "recovered_restart_required"
                });
            }
        }
        self.project(&state)
    }

    /// A local, non-model health check. The maintenance resource-chain E2E
    /// remains separate; this only commits a switched runtime after the
    /// signed closure, real session surface and current plugin composition
    /// have all been observed in this process.
    pub(crate) fn verify_activated_health(&self) -> EngineUpdateStatus {
        {
            let mut state = self.state.lock().unwrap();
            if !self.project(&state).can_verify {
                return self.project(&state);
            }
            state.busy = true;
        }
        let accepted = (|| {
            if self.host.surface_status().stage != DshNativeSurfaceStage::SessionOpen {
                return false;
            }
            let Some((store, current, pending)) = self.host.engine_update_context() else {
                return false;
            };
            if !pending || store.pending_switch() {
                return false;
            }
            let Ok(check) = self.host.plugin_compat_check(false) else {
                return false;
            };
            if check.get("checked") != Some(&serde_json::json!(true)) {
                return false;
            }
            let Ok(compat) = self.host.plugin_compat_status() else {
                return false;
            };
            if !plugin_composition_clear(&compat, &current)
                || self.host.surface_status().stage != DshNativeSurfaceStage::SessionOpen {
                return false;
            }
            let Ok(Some(installed)) = store.load_active() else {
                return false;
            };
            if installed.candidate.version != current || !installed.pending_health {
                return false;
            }
            store.mark_healthy(&installed).is_ok()
        })();
        let mut state = self.state.lock().unwrap();
        state.busy = false;
        state.outcome = if accepted { Some("healthy") } else { Some("verification_failed") };
        self.project(&state)
    }

    /// Reserve a cold host before Tauri initiates its own restart. The exit
    /// hook arms the durable switch only after shutdown reports a confirmed
    /// drain; this method alone cannot authorize startup activation.
    pub(crate) fn begin_controlled_restart(&self) -> bool {
        let state = self.state.lock().unwrap();
        if !self.project(&state).can_restart { return false; }
        let Some((store, current, false)) = self.host.engine_update_context() else { return false; };
        store.preflight_pending_for_this_build(&current).is_ok()
            && self.host.begin_cold_update_restart()
    }

    /// A previously used host cannot be hot-switched. The UI explicitly asks
    /// the user to finish work and save drafts, then use the application's
    /// normal full quit path. Only the Exit hook, after an owned-tree drain,
    /// may arm the durable switch; hiding a window or crashing does nothing.
    pub(crate) fn prepare_safe_exit(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        if !self.project(&state).can_prepare_exit { return false; }
        let Some((store, current, false)) = self.host.engine_update_context() else { return false; };
        if store.preflight_pending_for_this_build(&current).is_err()
            || self.host.status().stage != DshHostStage::ProbeCompleted {
            return false;
        }
        state.outcome = Some("exit_prepared");
        true
    }
}

fn discovery_outcome(
    catalog: &'static str,
    development: bool,
    discovery: Option<&Result<super::upstream::Discovery, super::upstream::DiscoveryError>>,
    current: Option<&str>,
) -> &'static str {
    if development || !matches!(catalog, "current" | "unconfigured") { return catalog; }
    match (discovery, current) {
        (Some(Ok(found)), Some(current)) if super::upstream::is_newer(&found.version, current) => "upstream_unvalidated",
        (Some(Err(_)), _) | (None, _) => "upstream_unavailable",
        _ => catalog,
    }
}

fn preparation_failure_outcome(cancelled: bool, worker_unsettled: bool) -> &'static str {
    if worker_unsettled { "recovery_required" }
    else if cancelled { "cancelled" }
    else { "prepare_failed" }
}

fn unvalidated_release(upstream: Option<&str>, current: Option<&str>, admitted: Option<&str>) -> bool {
    match (upstream, current) {
        (Some(upstream), Some(current)) => super::upstream::is_newer(upstream, current) && admitted != Some(upstream),
        _ => false,
    }
}

fn plugin_composition_clear(value: &serde_json::Value, current: &str) -> bool {
    let Some(object) = value.as_object() else { return false; };
    if object.get("manifestValid") != Some(&serde_json::json!(true))
        || object.get("runtimeVersion").and_then(|value| value.as_str()) != Some(current) {
        return false;
    }
    let Some(plugins) = object.get("plugins").and_then(|value| value.as_array()) else {
        return false;
    };
    let Some(quarantine) = object.get("quarantineSet").and_then(|value| value.as_array()) else {
        return false;
    };
    plugins.iter().all(|plugin| {
        let outcome = plugin.get("outcome").and_then(|value| value.as_str());
        outcome == Some("pass") || outcome == Some("fail")
            && plugin.get("quarantined") == Some(&serde_json::json!(true))
            && plugin.get("resolved") == Some(&serde_json::json!(true))
            && plugin.get("entryId").is_some_and(|id| quarantine.contains(id))
    })
}

#[cfg(test)]
mod health_tests {
    use super::plugin_composition_clear;

    #[test]
    fn an_unsettled_installation_worker_is_never_reported_as_cancelled() {
        assert_eq!(super::preparation_failure_outcome(false, false), "prepare_failed");
        assert_eq!(super::preparation_failure_outcome(true, false), "cancelled");
        assert_eq!(super::preparation_failure_outcome(false, true), "recovery_required");
        assert_eq!(super::preparation_failure_outcome(true, true), "recovery_required");
    }

    #[test]
    fn discovery_never_grants_installation_or_erases_catalog_errors() {
        let newer = Ok(super::super::upstream::Discovery {
            version: "0.2.0-rc.1".into(), tag: "dsh-v0.2.0-rc.1".into(), release_id: 10,
        });
        let failed = Err(super::super::upstream::DiscoveryError::Network);
        for catalog in ["current", "unconfigured"] {
            assert_eq!(super::discovery_outcome(catalog, false, Some(&newer), Some("0.1.7-rc.2")), "upstream_unvalidated");
            assert_eq!(super::discovery_outcome(catalog, false, Some(&failed), Some("0.1.7-rc.2")), "upstream_unavailable");
            assert_eq!(super::discovery_outcome(catalog, false, Some(&newer), Some("0.2.0-rc.1")), catalog);
            assert_eq!(super::discovery_outcome(catalog, true, None, Some("0.1.7-rc.2")), catalog);
        }
        for catalog in ["available", "requires_host", "legacy_contract", "no_candidate", "upgrade_path", "untrusted", "upstream_identity", "check_failed"] {
            assert_eq!(super::discovery_outcome(catalog, false, Some(&newer), Some("0.1.7-rc.2")), catalog);
            assert_eq!(super::discovery_outcome(catalog, false, Some(&failed), Some("0.1.7-rc.2")), catalog);
        }
        assert!(super::unvalidated_release(Some("0.2.0-rc.1"), Some("0.1.7-rc.2"), Some("0.1.8-rc.1")));
        assert!(super::unvalidated_release(Some("0.2.0-rc.1"), Some("0.1.7-rc.2"), None));
        assert!(!super::unvalidated_release(Some("0.2.0-rc.1"), Some("0.1.7-rc.2"), Some("0.2.0-rc.1")));
        assert!(!super::unvalidated_release(Some("0.1.7-rc.2"), Some("0.1.7-rc.2"), None));
    }

    #[test]
    fn plugin_health_rejects_unknown_or_unquarantined_failures() {
        assert!(plugin_composition_clear(&serde_json::json!({"manifestValid":true,"runtimeVersion":"0.1.7-rc.2","plugins":[],"quarantineSet":[]}), "0.1.7-rc.2"));
        assert!(plugin_composition_clear(&serde_json::json!({"manifestValid":true,"runtimeVersion":"0.1.7-rc.2","quarantineSet":["broken"],"plugins":[
            {"outcome":"pass"},{"entryId":"broken","outcome":"fail","quarantined":true,"resolved":true}
        ]}), "0.1.7-rc.2"));
        for result in [
            serde_json::json!({"manifestValid":false,"runtimeVersion":"0.1.7-rc.2","plugins":[],"quarantineSet":[]}),
            serde_json::json!({"manifestValid":true,"runtimeVersion":"0.1.5-rc.2","plugins":[],"quarantineSet":[]}),
            serde_json::json!({"manifestValid":true,"runtimeVersion":"0.1.7-rc.2","plugins":[{"outcome":"unknown"}],"quarantineSet":[]}),
            serde_json::json!({"manifestValid":true,"runtimeVersion":"0.1.7-rc.2","plugins":[{"entryId":"broken","outcome":"fail","quarantined":false}],"quarantineSet":[]}),
            serde_json::json!({"manifestValid":true,"runtimeVersion":"0.1.7-rc.2","plugins":[{"entryId":"broken","outcome":"fail","quarantined":true,"resolved":false}],"quarantineSet":["broken"]}),
            serde_json::json!({"manifestValid":true,"runtimeVersion":"0.1.7-rc.2","plugins":[{"entryId":"broken","outcome":"fail","quarantined":true,"resolved":true}],"quarantineSet":[]}),
        ] {
            assert!(!plugin_composition_clear(&result, "0.1.7-rc.2"));
        }
    }
}

fn now_unix() -> Option<i64> {
    Some(SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as i64)
}
