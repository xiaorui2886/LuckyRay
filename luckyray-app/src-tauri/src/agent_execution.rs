//! Controlled, Backend-owned project verification.
//!
//! This module intentionally exposes one fixed LuckyRay check only.  It is
//! not a terminal, shell, package-script runner, or a general recipe registry:
//! the model never supplies an executable, arguments, working directory, or
//! environment.  Every invocation starts from a run-bound opaque recipe ref
//! and crosses the existing Agent approval/one-shot-permit boundary.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::agent_workspace::WorkspaceGrantService;

const RECIPE_REFERENCE_TTL: Duration = Duration::from_secs(10 * 60);
const MANIFEST_CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_WORKER_OUTPUT_BYTES: usize = 4 * 1024;
const RECIPE_ID_MANIFEST: &str = "project-manifest-v1";

/// A private durable locator.  It is written only to `ai_run_artifact` so a
/// crash can be honestly discarded as interrupted/not-replayed; it must never
/// enter a model observation, SafeAgentEvent, renderer DTO, or final answer.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ExecutionRecipeLocator {
    pub(crate) grant_id: String,
    pub(crate) root_digest: String,
    pub(crate) manifest_name: ManifestName,
    pub(crate) manifest_digest: String,
    pub(crate) manifest_identity: String,
    pub(crate) recipe_id: String,
}

/// Backend-owned state behind one model-visible, run-scoped recipe reference.
/// It deliberately does not implement `Serialize`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExecutionRecipeBinding {
    pub(crate) locator: ExecutionRecipeLocator,
    pub(crate) workspace_label: String,
    pub(crate) principal: [u8; 32],
    pub(crate) conversation_id: String,
    expires_at: Instant,
}

impl ExecutionRecipeBinding {
    pub(crate) fn operation_digest(&self) -> String {
        let bytes = [
            b"luckyray-execution-recipe-v1\0".as_slice(),
            self.locator.recipe_id.as_bytes(),
            b"\0",
            self.locator.grant_id.as_bytes(),
            b"\0",
            self.locator.root_digest.as_bytes(),
            b"\0",
            self.locator.manifest_name.as_str().as_bytes(),
            b"\0",
            self.locator.manifest_digest.as_bytes(),
            b"\0",
            self.locator.manifest_identity.as_bytes(),
        ]
        .concat();
        format!("{:x}", Sha256::digest(bytes))
    }
}

/// Per-run bindings are intentionally separate from file refs and permits.
/// A recipe ref is a lookup token, never an execution authority by itself.
#[derive(Debug, Default)]
pub(crate) struct ExecutionRunBindings {
    entries: Mutex<HashMap<String, ExecutionRecipeBinding>>,
}

impl PartialEq for ExecutionRunBindings {
    fn eq(&self, other: &Self) -> bool {
        if std::ptr::eq(self, other) {
            return true;
        }
        let ours = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let theirs = other
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        ours == theirs
    }
}

impl Eq for ExecutionRunBindings {}

impl ExecutionRunBindings {
    pub(crate) fn bind(&self, binding: ExecutionRecipeBinding) -> String {
        let reference = format!("recipe-ref-{}", random_id());
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(reference.clone(), binding);
        reference
    }

    pub(crate) fn resolve(
        &self,
        reference: &str,
    ) -> Result<ExecutionRecipeBinding, ExecutionError> {
        let binding = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(reference)
            .cloned()
            .ok_or_else(execution_recipe_invalid)?;
        if Instant::now() >= binding.expires_at {
            return Err(execution_recipe_expired());
        }
        Ok(binding)
    }

    /// A check can run only once after its matching approval permit has been
    /// consumed.  A stopped, failed, or stale request cannot be replayed with
    /// the same ref.
    pub(crate) fn consume(
        &self,
        reference: &str,
    ) -> Result<ExecutionRecipeBinding, ExecutionError> {
        let binding = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(reference)
            .ok_or_else(execution_recipe_invalid)?;
        if Instant::now() >= binding.expires_at {
            return Err(execution_recipe_expired());
        }
        Ok(binding)
    }

    pub(crate) fn redaction_tokens(&self) -> Vec<String> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecutionRecipeObservation {
    pub(crate) recipe_ref: String,
    pub(crate) label: String,
    pub(crate) description: String,
    pub(crate) requires_confirmation: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ExecutionStatus {
    Passed,
    Failed,
    NotRun,
    Stopped,
    TimedOut,
    StartFailed,
    Uncertain,
}

impl ExecutionStatus {
    #[cfg(test)]
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::NotRun => "not-run",
            Self::Stopped => "stopped",
            Self::TimedOut => "timed-out",
            Self::StartFailed => "start-failed",
            Self::Uncertain => "uncertain",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum ManifestName {
    #[serde(rename = "package.json")]
    PackageJson,
    #[serde(rename = "Cargo.toml")]
    CargoToml,
    #[serde(rename = "pyproject.toml")]
    PyprojectToml,
}

impl ManifestName {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::PackageJson => "package.json",
            Self::CargoToml => "Cargo.toml",
            Self::PyprojectToml => "pyproject.toml",
        }
    }

    pub(crate) fn from_safe_name(value: &str) -> Option<Self> {
        match value {
            "package.json" => Some(Self::PackageJson),
            "Cargo.toml" => Some(Self::CargoToml),
            "pyproject.toml" => Some(Self::PyprojectToml),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ExecutionReason {
    Valid,
    Missing,
    Unavailable,
    Empty,
    EncodingInvalid,
    FormatInvalid,
    TooLarge,
    UnsafeFile,
    Unreadable,
    ResultInvalid,
    NotStarted,
    ManifestChanged,
    UserStopped,
    TimeLimit,
    CouldNotStart,
    ResultNeedsReconciliation,
}

impl ExecutionReason {
    #[cfg(test)]
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Valid => "valid",
            Self::Missing => "missing",
            Self::Unavailable => "unavailable",
            Self::Empty => "empty",
            Self::EncodingInvalid => "encoding-invalid",
            Self::FormatInvalid => "format-invalid",
            Self::TooLarge => "too-large",
            Self::UnsafeFile => "unsafe-file",
            Self::Unreadable => "unreadable",
            Self::ResultInvalid => "result-invalid",
            Self::NotStarted => "not-started",
            Self::ManifestChanged => "manifest-changed",
            Self::UserStopped => "user-stopped",
            Self::TimeLimit => "time-limit",
            Self::CouldNotStart => "could-not-start",
            Self::ResultNeedsReconciliation => "result-needs-reconciliation",
        }
    }
}

/// Backend-internal verifier truth. It cannot be built from a product summary
/// or an exit code: every constructor validates the complete typed tuple.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExecutionRunObservation {
    pub(crate) status: ExecutionStatus,
    pub(crate) manifest_name: Option<ManifestName>,
    pub(crate) reason: ExecutionReason,
}

/// The only safe public projection of an execution result. `summary` is
/// generated from the typed tuple and is verified, never parsed back into
/// provenance. Authority and private process data stay outside this DTO.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionResultView {
    pub(crate) status: ExecutionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) manifest_name: Option<ManifestName>,
    pub(crate) reason: ExecutionReason,
    pub(crate) summary: String,
}

impl ExecutionRunObservation {
    pub(crate) fn try_new(
        status: ExecutionStatus,
        manifest_name: Option<ManifestName>,
        reason: ExecutionReason,
    ) -> Result<Self, ExecutionError> {
        let legal = match (status, reason, manifest_name.is_some()) {
            (ExecutionStatus::Passed, ExecutionReason::Valid, true) => true,
            (
                ExecutionStatus::Failed,
                ExecutionReason::Missing | ExecutionReason::Unavailable,
                false,
            ) => true,
            (
                ExecutionStatus::Failed,
                ExecutionReason::Empty
                | ExecutionReason::EncodingInvalid
                | ExecutionReason::FormatInvalid
                | ExecutionReason::TooLarge
                | ExecutionReason::UnsafeFile
                | ExecutionReason::Unreadable
                | ExecutionReason::ResultInvalid,
                true,
            ) => true,
            (
                ExecutionStatus::NotRun,
                ExecutionReason::NotStarted | ExecutionReason::ManifestChanged,
                true,
            ) => true,
            (ExecutionStatus::Stopped, ExecutionReason::UserStopped, true) => true,
            (ExecutionStatus::TimedOut, ExecutionReason::TimeLimit, true) => true,
            (ExecutionStatus::StartFailed, ExecutionReason::CouldNotStart, true) => true,
            (ExecutionStatus::Uncertain, ExecutionReason::ResultNeedsReconciliation, true) => true,
            _ => false,
        };
        if !legal {
            return Err(ExecutionError::new(
                "execution-result-invalid",
                "Controlled project check result is invalid",
            ));
        }
        Ok(Self {
            status,
            manifest_name,
            reason,
        })
    }

    pub(crate) fn public_view(&self) -> ExecutionResultView {
        ExecutionResultView {
            status: self.status,
            manifest_name: self.manifest_name,
            reason: self.reason,
            summary: execution_result_summary(self.status, self.manifest_name, self.reason),
        }
    }

    #[cfg(test)]
    pub(crate) const fn receipt_state(&self) -> &'static str {
        match self.status {
            ExecutionStatus::Passed => "committed",
            ExecutionStatus::Uncertain => "uncertain",
            ExecutionStatus::Failed
            | ExecutionStatus::NotRun
            | ExecutionStatus::Stopped
            | ExecutionStatus::TimedOut
            | ExecutionStatus::StartFailed => "committed-warning",
        }
    }

    pub(crate) fn uncertain(manifest_name: ManifestName) -> Self {
        Self::try_new(
            ExecutionStatus::Uncertain,
            Some(manifest_name),
            ExecutionReason::ResultNeedsReconciliation,
        )
        .expect("the Backend uncertain tuple is fixed")
    }
}

impl ExecutionResultView {
    pub(crate) fn from_public_value(value: &serde_json::Value) -> Result<Self, ExecutionError> {
        let object = value.as_object().ok_or_else(|| {
            ExecutionError::new(
                "execution-result-invalid",
                "Controlled project check result is invalid",
            )
        })?;
        // Optional means absent, not an explicit null. Keep the Rust and TS
        // public contracts byte-for-byte aligned and fail closed on shape
        // drift before serde can collapse null into Option::None.
        if object
            .get("manifestName")
            .is_some_and(|manifest| !manifest.is_string())
        {
            return Err(ExecutionError::new(
                "execution-result-invalid",
                "Controlled project check result is invalid",
            ));
        }
        let view: Self = serde_json::from_value(value.clone()).map_err(|_| {
            ExecutionError::new(
                "execution-result-invalid",
                "Controlled project check result is invalid",
            )
        })?;
        view.clone().into_observation()?;
        Ok(view)
    }

    pub(crate) fn into_observation(self) -> Result<ExecutionRunObservation, ExecutionError> {
        let observation =
            ExecutionRunObservation::try_new(self.status, self.manifest_name, self.reason)?;
        if self.summary != observation.public_view().summary {
            return Err(ExecutionError::new(
                "execution-result-invalid",
                "Controlled project check result is invalid",
            ));
        }
        Ok(observation)
    }
}

fn execution_result_summary(
    status: ExecutionStatus,
    manifest_name: Option<ManifestName>,
    reason: ExecutionReason,
) -> String {
    let manifest = manifest_name
        .map(ManifestName::as_str)
        .unwrap_or("项目清单");
    match (status, reason) {
        (ExecutionStatus::Passed, ExecutionReason::Valid) => {
            format!("项目清单检查已通过（{manifest}）。")
        }
        (ExecutionStatus::Failed, ExecutionReason::Missing) => {
            "未找到支持的项目清单，项目清单检查未通过。".to_owned()
        }
        (ExecutionStatus::Failed, ExecutionReason::Unavailable) => {
            "项目清单暂不可读取，项目清单检查未通过。".to_owned()
        }
        (ExecutionStatus::Failed, ExecutionReason::Empty) => {
            format!("{manifest} 为空，项目清单检查未通过。")
        }
        (ExecutionStatus::Failed, ExecutionReason::EncodingInvalid) => {
            format!("{manifest} 不是有效的 UTF-8 文本，项目清单检查未通过。")
        }
        (ExecutionStatus::Failed, ExecutionReason::FormatInvalid) => {
            format!("{manifest} 格式无效，项目清单检查未通过。")
        }
        (ExecutionStatus::Failed, ExecutionReason::TooLarge) => {
            format!("{manifest} 超过检查大小上限，项目清单检查未通过。")
        }
        (ExecutionStatus::Failed, ExecutionReason::UnsafeFile) => {
            format!("{manifest} 不是可安全检查的普通文件，项目清单检查未通过。")
        }
        (ExecutionStatus::Failed, ExecutionReason::Unreadable) => {
            format!("{manifest} 无法读取，项目清单检查未通过。")
        }
        (ExecutionStatus::Failed, ExecutionReason::ResultInvalid) => {
            "项目清单检查结果无法验证。".to_owned()
        }
        (ExecutionStatus::NotRun, ExecutionReason::NotStarted) => "项目清单检查未运行。".to_owned(),
        (ExecutionStatus::NotRun, ExecutionReason::ManifestChanged) => {
            "授权项目或项目清单已变化，检查未运行。".to_owned()
        }
        (ExecutionStatus::Stopped, ExecutionReason::UserStopped) => {
            "项目清单检查已停止。".to_owned()
        }
        (ExecutionStatus::TimedOut, ExecutionReason::TimeLimit) => "项目清单检查超时。".to_owned(),
        (ExecutionStatus::StartFailed, ExecutionReason::CouldNotStart) => {
            "项目清单检查未能启动。".to_owned()
        }
        (ExecutionStatus::Uncertain, ExecutionReason::ResultNeedsReconciliation) => {
            "项目清单检查结果待核对；不会自动重试。".to_owned()
        }
        _ => "项目清单检查结果无法验证。".to_owned(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExecutionError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

/// Backend-only phase evidence for failures around the one-shot Permit
/// boundary. The service uses this value instead of interpreting an error
/// string when deciding whether a prepared receipt may be discarded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExecutionDispatchDisposition {
    NotAdmitted,
    UnknownAfterAdmission,
}

impl ExecutionError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct ExecutionRecipeCatalog {
    executable: Option<PathBuf>,
    #[cfg(test)]
    fixture: Arc<Mutex<Option<ExecutionFixture>>>,
    /// Test-only instrumentation for the real registered sidecar path.  It
    /// never exists in product builds and therefore cannot become a second
    /// execution authority or a renderer-visible counter.
    #[cfg(test)]
    owned_dispatch: Option<Arc<ExecutionDispatchCounters>>,
}

#[cfg(test)]
#[derive(Clone)]
struct ExecutionFixture {
    outcome: ExecutionRunObservation,
    dispatch: Arc<ExecutionDispatchCounters>,
    before_spawn: Option<Arc<(std::sync::Barrier, std::sync::Barrier)>>,
    after_spawn: Option<Arc<(std::sync::Barrier, std::sync::Barrier)>>,
}

#[cfg(test)]
#[derive(Debug, Default)]
pub(crate) struct ExecutionDispatchCounters {
    spawn_attempts: Arc<std::sync::atomic::AtomicUsize>,
    process_spawned: Arc<std::sync::atomic::AtomicUsize>,
}

#[cfg(test)]
impl ExecutionDispatchCounters {
    pub(crate) fn spawn_attempts(&self) -> usize {
        self.spawn_attempts
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    pub(crate) fn process_spawned(&self) -> usize {
        self.process_spawned
            .load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl ExecutionRecipeCatalog {
    pub(crate) fn unavailable() -> Self {
        Self {
            executable: None,
            #[cfg(test)]
            fixture: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            owned_dispatch: None,
        }
    }

    /// Resolves only the app-owned Tauri external binary.  No project path,
    /// manifest, model input, or renderer value participates in this lookup.
    pub(crate) fn app_owned(resource_dir: &Path) -> Self {
        Self {
            executable: resolve_app_owned_cli(resource_dir),
            #[cfg(test)]
            fixture: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            owned_dispatch: None,
        }
    }

    pub(crate) fn available(&self) -> bool {
        if self.executable.is_some() {
            return true;
        }
        #[cfg(test)]
        {
            return self.fixture_for_test().is_some();
        }
        #[cfg(not(test))]
        {
            false
        }
    }

    /// Produce exactly one static, read-only recipe for the selected frozen
    /// workspace grant.  The model sees only the display label and a short
    /// opaque ref; grant/root/manifest identities remain in the binding.
    pub(crate) fn list_manifest_check(
        &self,
        workspace: &WorkspaceGrantService,
        grant_id: &str,
        workspace_label: &str,
        principal: [u8; 32],
        conversation_id: &str,
        bindings: &ExecutionRunBindings,
    ) -> Result<ExecutionRecipeObservation, ExecutionError> {
        if !self.available() {
            return Err(ExecutionError::new(
                "execution-unavailable",
                "Controlled project checking is unavailable",
            ));
        }
        let manifest = workspace
            .project_manifest_binding(grant_id)
            .map_err(map_workspace_error)?;
        let manifest_name =
            ManifestName::from_safe_name(&manifest.manifest_name).ok_or_else(|| {
                ExecutionError::new(
                    "execution-recipe-unavailable",
                    "Controlled project checking is unavailable",
                )
            })?;
        let binding = ExecutionRecipeBinding {
            locator: ExecutionRecipeLocator {
                grant_id: grant_id.to_owned(),
                root_digest: manifest.root_digest,
                manifest_name,
                manifest_digest: manifest.manifest_digest,
                manifest_identity: manifest.manifest_identity,
                recipe_id: RECIPE_ID_MANIFEST.to_owned(),
            },
            workspace_label: workspace_label.to_owned(),
            principal,
            conversation_id: conversation_id.to_owned(),
            expires_at: Instant::now() + RECIPE_REFERENCE_TTL,
        };
        let recipe_ref = bindings.bind(binding);
        Ok(ExecutionRecipeObservation {
            recipe_ref,
            label: "项目清单检查".to_owned(),
            description:
                "检查授权项目的清单文件是否可安全读取；不会执行项目脚本、安装依赖或访问网络。"
                    .to_owned(),
            requires_confirmation: true,
        })
    }

    /// Revalidates the exact root/manifest identity immediately before the
    /// owned process launches.  A changed grant or manifest becomes an honest
    /// `not-run` result; it never falls through to a shell or replay.
    pub(crate) fn run_manifest_check(
        &self,
        workspace: &WorkspaceGrantService,
        binding: &ExecutionRecipeBinding,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
    ) -> ExecutionRunObservation {
        let manifest_name = binding.locator.manifest_name;
        if cancelled() {
            return not_run(manifest_name, ExecutionReason::NotStarted);
        }
        if binding.locator.recipe_id != RECIPE_ID_MANIFEST {
            return not_run(manifest_name, ExecutionReason::NotStarted);
        }
        let current = match workspace.project_manifest_binding(&binding.locator.grant_id) {
            Ok(value) => value,
            Err(_) => return not_run(manifest_name, ExecutionReason::ManifestChanged),
        };
        if current.root_digest != binding.locator.root_digest
            || current.manifest_name != binding.locator.manifest_name.as_str()
            || current.manifest_digest != binding.locator.manifest_digest
            || current.manifest_identity != binding.locator.manifest_identity
        {
            return not_run(manifest_name, ExecutionReason::ManifestChanged);
        }
        // Stop may race with the identity check above. Observe it again at the
        // last Backend-only point before either a fixture or the owned process
        // can launch, so a pre-launch Stop has a strict zero-process outcome.
        if cancelled() {
            return not_run(manifest_name, ExecutionReason::NotStarted);
        }
        #[cfg(test)]
        if let Some(fixture) = self.fixture_for_test() {
            if let Some(gate) = &fixture.before_spawn {
                gate.0.wait();
                gate.1.wait();
                if cancelled() {
                    return not_run(manifest_name, ExecutionReason::NotStarted);
                }
            }
            fixture
                .dispatch
                .spawn_attempts
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if fixture.outcome.status == ExecutionStatus::StartFailed {
                return fixture.outcome;
            }
            fixture
                .dispatch
                .process_spawned
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Some(gate) = &fixture.after_spawn {
                gate.0.wait();
                gate.1.wait();
                if cancelled() {
                    return observed(
                        ExecutionStatus::Stopped,
                        Some(manifest_name),
                        ExecutionReason::UserStopped,
                    );
                }
            }
            return retain_result_only_if_manifest_still_bound(workspace, binding, fixture.outcome);
        }
        #[cfg(all(windows, feature = "browser-host-runtime"))]
        {
            let Some(executable) = self.executable.as_deref() else {
                return start_failed(manifest_name);
            };
            #[cfg(test)]
            if let Some(dispatch) = &self.owned_dispatch {
                dispatch
                    .spawn_attempts
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            let outcome =
                run_owned_manifest_check(executable, &current.root, manifest_name, cancelled);
            #[cfg(test)]
            if outcome.status != ExecutionStatus::StartFailed {
                if let Some(dispatch) = &self.owned_dispatch {
                    dispatch
                        .process_spawned
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }
            return retain_result_only_if_manifest_still_bound(workspace, binding, outcome);
        }
        #[cfg(not(all(windows, feature = "browser-host-runtime")))]
        {
            let _ = current;
            start_failed(manifest_name)
        }
    }

    #[cfg(test)]
    pub(crate) fn with_fixture(
        outcome: ExecutionRunObservation,
    ) -> (Self, Arc<std::sync::atomic::AtomicUsize>) {
        let dispatch = Arc::new(ExecutionDispatchCounters::default());
        let launches = dispatch.process_spawned.clone();
        let catalog = Self {
            executable: None,
            fixture: Arc::new(Mutex::new(Some(ExecutionFixture {
                outcome,
                dispatch: dispatch.clone(),
                before_spawn: None,
                after_spawn: None,
            }))),
            owned_dispatch: None,
        };
        (catalog, launches)
    }

    #[cfg(test)]
    pub(crate) fn with_blocking_fixture(
        outcome: ExecutionRunObservation,
    ) -> (
        Self,
        Arc<ExecutionDispatchCounters>,
        Arc<(std::sync::Barrier, std::sync::Barrier)>,
    ) {
        let dispatch = Arc::new(ExecutionDispatchCounters::default());
        let gate = Arc::new((std::sync::Barrier::new(2), std::sync::Barrier::new(2)));
        let catalog = Self {
            executable: None,
            fixture: Arc::new(Mutex::new(Some(ExecutionFixture {
                outcome,
                dispatch: dispatch.clone(),
                before_spawn: Some(gate.clone()),
                after_spawn: None,
            }))),
            owned_dispatch: None,
        };
        (catalog, dispatch, gate)
    }

    #[cfg(test)]
    pub(crate) fn with_running_fixture(
        outcome: ExecutionRunObservation,
    ) -> (
        Self,
        Arc<ExecutionDispatchCounters>,
        Arc<(std::sync::Barrier, std::sync::Barrier)>,
    ) {
        let dispatch = Arc::new(ExecutionDispatchCounters::default());
        let gate = Arc::new((std::sync::Barrier::new(2), std::sync::Barrier::new(2)));
        let catalog = Self {
            executable: None,
            fixture: Arc::new(Mutex::new(Some(ExecutionFixture {
                outcome,
                dispatch: dispatch.clone(),
                before_spawn: None,
                after_spawn: Some(gate.clone()),
            }))),
            owned_dispatch: None,
        };
        (catalog, dispatch, gate)
    }

    #[cfg(test)]
    pub(crate) fn with_dispatch_fixture(
        outcome: ExecutionRunObservation,
    ) -> (Self, Arc<ExecutionDispatchCounters>) {
        let dispatch = Arc::new(ExecutionDispatchCounters::default());
        let catalog = Self {
            executable: None,
            fixture: Arc::new(Mutex::new(Some(ExecutionFixture {
                outcome,
                dispatch: dispatch.clone(),
                before_spawn: None,
                after_spawn: None,
            }))),
            owned_dispatch: None,
        };
        (catalog, dispatch)
    }

    /// Drives the same owned Windows process branch used by product startup,
    /// while exposing only an in-test launch count to prove approval precedes
    /// exactly one process spawn.
    #[cfg(all(test, windows, feature = "browser-host-runtime"))]
    pub(crate) fn app_owned_with_launch_counter_for_test(
        resource_dir: &Path,
    ) -> (Self, Arc<std::sync::atomic::AtomicUsize>) {
        let dispatch = Arc::new(ExecutionDispatchCounters::default());
        let launches = dispatch.process_spawned.clone();
        let catalog = Self {
            executable: resolve_app_owned_cli(resource_dir),
            fixture: Arc::new(Mutex::new(None)),
            owned_dispatch: Some(dispatch),
        };
        (catalog, launches)
    }

    #[cfg(test)]
    pub(crate) fn executable_for_test(&self) -> Option<&Path> {
        self.executable.as_deref()
    }

    #[cfg(test)]
    fn fixture_for_test(&self) -> Option<ExecutionFixture> {
        self.fixture
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// A fixed verifier is deliberately not a filesystem sandbox. Its working
/// directory is the canonical granted root, and its result is accepted only
/// if the Backend can still prove the exact root/manifest binding immediately
/// after the owned process returns. A replacement during execution therefore
/// becomes `not-run` instead of a false result for a different project.
fn retain_result_only_if_manifest_still_bound(
    workspace: &WorkspaceGrantService,
    binding: &ExecutionRecipeBinding,
    outcome: ExecutionRunObservation,
) -> ExecutionRunObservation {
    if !matches!(
        outcome.status,
        ExecutionStatus::Passed | ExecutionStatus::Failed
    ) {
        return outcome;
    }
    let still_bound = workspace
        .project_manifest_binding(&binding.locator.grant_id)
        .ok()
        .is_some_and(|current| {
            current.root_digest == binding.locator.root_digest
                && current.manifest_name == binding.locator.manifest_name.as_str()
                && current.manifest_digest == binding.locator.manifest_digest
                && current.manifest_identity == binding.locator.manifest_identity
        });
    if still_bound {
        outcome
    } else {
        not_run(
            binding.locator.manifest_name,
            ExecutionReason::ManifestChanged,
        )
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn run_owned_manifest_check(
    executable: &Path,
    root: &Path,
    manifest_name: ManifestName,
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> ExecutionRunObservation {
    use std::ffi::OsString;
    use std::thread;

    // A cancellation may arrive in the tiny interval after the catalog's last
    // identity check. Do not spawn just to immediately terminate in that case.
    if cancelled() {
        return not_run(manifest_name, ExecutionReason::NotStarted);
    }
    let environment = minimal_execution_environment();
    let spawned = match crate::owned_process::spawn_in_owned_job(
        executable,
        &[
            OsString::from("verify"),
            OsString::from("workspace-manifest"),
        ],
        root,
        environment,
        false,
    ) {
        Ok(value) => value,
        Err(_) => return start_failed(manifest_name),
    };
    let crate::owned_process::AtomicSpawn {
        process,
        stdin,
        stdout,
        stderr,
        job,
    } = spawned;
    drop(stdin);
    let stdout_reader = thread::spawn(move || drain_bounded(stdout));
    let stderr_reader = thread::spawn(move || drain_bounded(stderr));
    let started = Instant::now();
    let mut stopped = false;
    let mut timed_out = false;
    while !process.wait_for(Duration::from_millis(40)) {
        if cancelled() {
            stopped = true;
            job.terminate();
            break;
        }
        if started.elapsed() >= MANIFEST_CHECK_TIMEOUT {
            timed_out = true;
            job.terminate();
            break;
        }
    }
    // Closing the Job after an explicit termination is a second ownership
    // fence. The workers are app-owned and all output is drained/bounded.
    let _ = process.wait_for(Duration::from_secs(2));
    let stdout = stdout_reader.join().unwrap_or_default();
    let _stderr = stderr_reader.join().unwrap_or_default();
    if stopped {
        return observed(
            ExecutionStatus::Stopped,
            Some(manifest_name),
            ExecutionReason::UserStopped,
        );
    }
    if timed_out {
        return observed(
            ExecutionStatus::TimedOut,
            Some(manifest_name),
            ExecutionReason::TimeLimit,
        );
    }
    parse_owned_manifest_result(&stdout, manifest_name)
}

fn parse_owned_manifest_result(
    stdout: &[u8],
    expected_manifest: ManifestName,
) -> ExecutionRunObservation {
    let value: WorkerEnvelope = match serde_json::from_slice(stdout) {
        Ok(value) => value,
        Err(_) => return result_invalid(expected_manifest),
    };
    if value.protocol != crate::tool_cli::CLI_PROTOCOL
        || value.protocol_identity != crate::tool_cli::cli_protocol_identity()
    {
        // A stale or substituted registered externalBin must not have its
        // result accepted merely because it emitted a familiar status shape.
        // The check is intentionally fail-closed and never retries a process.
        return result_invalid(expected_manifest);
    }
    match value.status.as_str() {
        "passed"
            if value.ok
                && value.exit_code == 0
                && value.reason == "valid"
                && value
                    .manifest_name
                    .as_deref()
                    .and_then(ManifestName::from_safe_name)
                    == Some(expected_manifest) =>
        {
            observed(
                ExecutionStatus::Passed,
                Some(expected_manifest),
                ExecutionReason::Valid,
            )
        }
        "failed"
            if !value.ok
                && value.exit_code == 4
                && valid_worker_failure(
                    &value.reason,
                    value.manifest_name.as_deref(),
                    expected_manifest,
                ) =>
        {
            let reason = worker_failure_reason(&value.reason)
                .expect("valid_worker_failure accepts only typed sidecar reasons");
            let manifest_name = value
                .manifest_name
                .as_deref()
                .and_then(ManifestName::from_safe_name);
            observed(ExecutionStatus::Failed, manifest_name, reason)
        }
        _ => result_invalid(expected_manifest),
    }
}

fn valid_worker_failure(
    reason: &str,
    manifest_name: Option<&str>,
    expected_manifest: ManifestName,
) -> bool {
    match reason {
        "missing" | "unavailable" => manifest_name.is_none(),
        "empty" | "encoding-invalid" | "format-invalid" | "too-large" | "unsafe-file"
        | "unreadable" => {
            manifest_name.and_then(ManifestName::from_safe_name) == Some(expected_manifest)
        }
        _ => false,
    }
}

fn worker_failure_reason(reason: &str) -> Option<ExecutionReason> {
    match reason {
        "missing" => Some(ExecutionReason::Missing),
        "unavailable" => Some(ExecutionReason::Unavailable),
        "empty" => Some(ExecutionReason::Empty),
        "encoding-invalid" => Some(ExecutionReason::EncodingInvalid),
        "format-invalid" => Some(ExecutionReason::FormatInvalid),
        "too-large" => Some(ExecutionReason::TooLarge),
        "unsafe-file" => Some(ExecutionReason::UnsafeFile),
        "unreadable" => Some(ExecutionReason::Unreadable),
        _ => None,
    }
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn drain_bounded(mut reader: impl std::io::Read) -> Vec<u8> {
    let mut retained = Vec::with_capacity(MAX_WORKER_OUTPUT_BYTES);
    let mut buffer = [0u8; 512];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let remaining = MAX_WORKER_OUTPUT_BYTES.saturating_sub(retained.len());
                retained.extend_from_slice(&buffer[..count.min(remaining)]);
                // Keep draining after the cap so a malformed sidecar cannot
                // block the owned process on a full pipe. The parsed result
                // will fail closed if the bounded envelope is incomplete.
            }
        }
    }
    retained
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn minimal_execution_environment() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    use std::ffi::OsString;
    let system_root =
        std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
    let system32 = PathBuf::from(&system_root).join("System32");
    vec![
        (OsString::from("SystemRoot"), system_root.clone()),
        (OsString::from("WINDIR"), system_root),
        (OsString::from("PATH"), system32.into_os_string()),
        (OsString::from("TEMP"), OsString::from(r"C:\Windows\Temp")),
        (OsString::from("TMP"), OsString::from(r"C:\Windows\Temp")),
    ]
}

#[derive(Deserialize)]
struct WorkerEnvelope {
    ok: bool,
    status: String,
    #[serde(rename = "exitCode")]
    exit_code: u16,
    #[serde(rename = "manifestName")]
    manifest_name: Option<String>,
    reason: String,
    protocol: String,
    #[serde(rename = "protocolIdentity")]
    protocol_identity: String,
}

fn resolve_app_owned_cli(resource_dir: &Path) -> Option<PathBuf> {
    let registered_name =
        option_env!("LUCKYRAY_BUILD_TARGET").map(|target| format!("luckyray-cli-{target}.exe"));
    let mut candidates = Vec::new();
    for root in [resource_dir.to_path_buf(), resource_dir.join("binaries")] {
        // Tauri bundle resources use the normalized sidecar name. Tauri dev
        // may point at the registered source externalBin, which keeps its
        // target-triple suffix. Both are fixed app resource locations; never
        // search PATH or any workspace/project directory.
        candidates.push(root.join("luckyray-cli.exe"));
        if let Some(name) = &registered_name {
            candidates.push(root.join(name));
        }
    }
    if let Ok(current) = std::env::current_exe() {
        if let Some(parent) = current.parent() {
            candidates.push(parent.join("luckyray-cli.exe"));
            if let Some(name) = &registered_name {
                candidates.push(parent.join(name));
            }
        }
    }
    candidates.into_iter().find(|candidate| {
        std::fs::metadata(candidate)
            .map(|metadata| metadata.is_file())
            .unwrap_or(false)
    })
}

fn map_workspace_error(error: crate::agent_workspace::WorkspaceError) -> ExecutionError {
    let code = match error.code {
        "workspace-grant-not-found"
        | "workspace-grant-unavailable"
        | "workspace-grant-changed"
        | "workspace-grant-reparse-denied"
        | "workspace-file-type-denied"
        | "workspace-file-not-found" => "execution-recipe-unavailable",
        _ => "execution-recipe-invalid",
    };
    ExecutionError::new(code, "Authorized project check is unavailable")
}

fn execution_recipe_invalid() -> ExecutionError {
    ExecutionError::new(
        "execution-recipe-invalid",
        "Project check reference is invalid for this Agent run",
    )
}

fn execution_recipe_expired() -> ExecutionError {
    ExecutionError::new(
        "execution-recipe-expired",
        "Project check reference expired before confirmation",
    )
}

fn observed(
    status: ExecutionStatus,
    manifest_name: Option<ManifestName>,
    reason: ExecutionReason,
) -> ExecutionRunObservation {
    ExecutionRunObservation::try_new(status, manifest_name, reason)
        .expect("Backend execution result constructors use a fixed legal tuple")
}

#[cfg(test)]
fn passed() -> ExecutionRunObservation {
    observed(
        ExecutionStatus::Passed,
        Some(ManifestName::PackageJson),
        ExecutionReason::Valid,
    )
}

fn not_run(manifest_name: ManifestName, reason: ExecutionReason) -> ExecutionRunObservation {
    observed(ExecutionStatus::NotRun, Some(manifest_name), reason)
}

fn result_invalid(manifest_name: ManifestName) -> ExecutionRunObservation {
    observed(
        ExecutionStatus::Failed,
        Some(manifest_name),
        ExecutionReason::ResultInvalid,
    )
}

fn start_failed(manifest_name: ManifestName) -> ExecutionRunObservation {
    observed(
        ExecutionStatus::StartFailed,
        Some(manifest_name),
        ExecutionReason::CouldNotStart,
    )
}

fn random_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::Ordering;

    fn temp_dir(label: &str) -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix(&format!("luckyray-execution-{label}-"))
            .tempdir()
            .unwrap()
    }

    #[test]
    fn recipe_ref_is_run_bound_manifest_pinned_and_one_shot() {
        let app_data = temp_dir("app");
        let root = temp_dir("workspace");
        fs::write(root.path().join("package.json"), br#"{"name":"safe"}"#).unwrap();
        let backend = crate::backend::BackendServices::initialize(app_data.path()).unwrap();
        let workspace = backend.workspace();
        let grant = workspace.add(root.path(), "Project").unwrap();
        let (catalog, launches) = ExecutionRecipeCatalog::with_fixture(passed());
        let bindings = ExecutionRunBindings::default();
        let observation = catalog
            .list_manifest_check(
                &workspace,
                &grant.id,
                "Project",
                [7u8; 32],
                "conversation-a",
                &bindings,
            )
            .unwrap();
        assert!(!serde_json::to_string(&observation)
            .unwrap()
            .contains("wsg-"));
        let binding = bindings.resolve(&observation.recipe_ref).unwrap();
        assert_eq!(binding.workspace_label, "Project");
        assert_eq!(binding.locator.recipe_id, RECIPE_ID_MANIFEST);
        let outcome = catalog.run_manifest_check(&workspace, &binding, &|| false);
        assert_eq!(outcome.status, ExecutionStatus::Passed);
        let public = serde_json::to_value(outcome.public_view()).unwrap();
        assert_eq!(public["manifestName"], "package.json");
        assert_eq!(public["reason"], "valid");
        assert!(public.get("exitCode").is_none());
        assert_eq!(launches.load(Ordering::SeqCst), 1);
        assert!(bindings.consume(&observation.recipe_ref).is_ok());
        assert!(bindings.consume(&observation.recipe_ref).is_err());
    }

    #[test]
    fn spawn_api_failure_counts_one_attempt_and_zero_started_processes() {
        let app_data = temp_dir("spawn-failed-app");
        let root = temp_dir("spawn-failed-workspace");
        fs::write(root.path().join("package.json"), br#"{"name":"safe"}"#).unwrap();
        let backend = crate::backend::BackendServices::initialize(app_data.path()).unwrap();
        let workspace = backend.workspace();
        let grant = workspace.add(root.path(), "Project").unwrap();
        let (catalog, dispatch) = ExecutionRecipeCatalog::with_dispatch_fixture(observed(
            ExecutionStatus::StartFailed,
            Some(ManifestName::PackageJson),
            ExecutionReason::CouldNotStart,
        ));
        let bindings = ExecutionRunBindings::default();
        let observation = catalog
            .list_manifest_check(
                &workspace,
                &grant.id,
                "Project",
                [70u8; 32],
                "conversation-spawn-failed",
                &bindings,
            )
            .unwrap();
        let binding = bindings.resolve(&observation.recipe_ref).unwrap();
        let outcome = catalog.run_manifest_check(&workspace, &binding, &|| false);
        assert_eq!(outcome.status, ExecutionStatus::StartFailed);
        assert_eq!(outcome.reason, ExecutionReason::CouldNotStart);
        assert_eq!(dispatch.spawn_attempts(), 1);
        assert_eq!(dispatch.process_spawned(), 0);
    }

    #[test]
    fn changed_manifest_is_not_run_before_fixture_launch() {
        let app_data = temp_dir("stale-app");
        let root = temp_dir("stale-workspace");
        fs::write(root.path().join("Cargo.toml"), "[package]\nname='safe'\n").unwrap();
        let backend = crate::backend::BackendServices::initialize(app_data.path()).unwrap();
        let workspace = backend.workspace();
        let grant = workspace.add(root.path(), "Project").unwrap();
        let (catalog, launches) = ExecutionRecipeCatalog::with_fixture(passed());
        let bindings = ExecutionRunBindings::default();
        let observation = catalog
            .list_manifest_check(
                &workspace,
                &grant.id,
                "Project",
                [8u8; 32],
                "conversation-a",
                &bindings,
            )
            .unwrap();
        let binding = bindings.resolve(&observation.recipe_ref).unwrap();
        fs::write(
            root.path().join("Cargo.toml"),
            "[package]\nname='changed'\n",
        )
        .unwrap();
        let outcome = catalog.run_manifest_check(&workspace, &binding, &|| false);
        assert_eq!(outcome.status, ExecutionStatus::NotRun);
        assert_eq!(outcome.reason, ExecutionReason::ManifestChanged);
        assert_eq!(launches.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn stop_after_recipe_validation_still_prevents_fixture_launch() {
        let app_data = temp_dir("cancelled-app");
        let root = temp_dir("cancelled-workspace");
        fs::write(root.path().join("package.json"), br#"{"name":"safe"}"#).unwrap();
        let backend = crate::backend::BackendServices::initialize(app_data.path()).unwrap();
        let workspace = backend.workspace();
        let grant = workspace.add(root.path(), "Project").unwrap();
        let (catalog, launches) = ExecutionRecipeCatalog::with_fixture(passed());
        let bindings = ExecutionRunBindings::default();
        let observation = catalog
            .list_manifest_check(
                &workspace,
                &grant.id,
                "Project",
                [9u8; 32],
                "conversation-a",
                &bindings,
            )
            .unwrap();
        let binding = bindings.resolve(&observation.recipe_ref).unwrap();
        let outcome = catalog.run_manifest_check(&workspace, &binding, &|| true);
        assert_eq!(outcome.status, ExecutionStatus::NotRun);
        assert_eq!(outcome.reason, ExecutionReason::NotStarted);
        assert_eq!(launches.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn completed_verifier_result_is_discarded_if_manifest_changed_during_execution() {
        let app_data = temp_dir("post-check-app");
        let root = temp_dir("post-check-workspace");
        let manifest = root.path().join("package.json");
        fs::write(&manifest, br#"{"name":"safe"}"#).unwrap();
        let backend = crate::backend::BackendServices::initialize(app_data.path()).unwrap();
        let workspace = backend.workspace();
        let grant = workspace.add(root.path(), "Project").unwrap();
        let (catalog, _launches) = ExecutionRecipeCatalog::with_fixture(passed());
        let bindings = ExecutionRunBindings::default();
        let observation = catalog
            .list_manifest_check(
                &workspace,
                &grant.id,
                "Project",
                [10u8; 32],
                "conversation-a",
                &bindings,
            )
            .unwrap();
        let binding = bindings.resolve(&observation.recipe_ref).unwrap();
        fs::write(&manifest, br#"{"name":"replaced"}"#).unwrap();
        let outcome = retain_result_only_if_manifest_still_bound(&workspace, &binding, passed());
        assert_eq!(outcome.status, ExecutionStatus::NotRun);
        assert_eq!(outcome.reason, ExecutionReason::ManifestChanged);
    }

    #[test]
    fn registered_external_bin_resolution_is_target_bound_and_never_uses_path() {
        let resources = temp_dir("registered-external-bin");
        let target = option_env!("LUCKYRAY_BUILD_TARGET")
            .expect("build script always provides the target triple");
        let registered = resources.path().join(format!("luckyray-cli-{target}.exe"));
        fs::write(&registered, b"MZ-test").unwrap();

        let catalog = ExecutionRecipeCatalog::app_owned(resources.path());
        assert_eq!(catalog.executable_for_test(), Some(registered.as_path()));

        let bundled_resources = resources.path().join("Tauri resource dir with spaces");
        fs::create_dir_all(&bundled_resources).unwrap();
        let bundled = bundled_resources.join("luckyray-cli.exe");
        fs::write(&bundled, b"MZ-bundle-test").unwrap();
        let bundled_catalog = ExecutionRecipeCatalog::app_owned(&bundled_resources);
        assert_eq!(
            bundled_catalog.executable_for_test(),
            Some(bundled.as_path())
        );
    }

    #[test]
    fn sidecar_result_with_a_wrong_protocol_identity_is_rejected() {
        let stdout = serde_json::to_vec(&serde_json::json!({
            "ok": true,
            "status": "passed",
            "exitCode": 0,
            "protocol": crate::tool_cli::CLI_PROTOCOL,
            "protocolIdentity": "0".repeat(64),
        }))
        .unwrap();
        let outcome = parse_owned_manifest_result(&stdout, ManifestName::PackageJson);
        assert_eq!(outcome.status, ExecutionStatus::Failed);
        assert_eq!(outcome.reason, ExecutionReason::ResultInvalid);
        assert_eq!(outcome.manifest_name, Some(ManifestName::PackageJson));
    }

    #[test]
    fn sidecar_illegal_private_tuple_fails_closed_to_typed_result_invalid() {
        for payload in [
            serde_json::json!({
                "ok": false,
                "status": "passed",
                "exitCode": 0,
                "manifestName": "package.json",
                "reason": "valid",
                "protocol": crate::tool_cli::CLI_PROTOCOL,
                "protocolIdentity": crate::tool_cli::cli_protocol_identity(),
            }),
            serde_json::json!({
                "ok": false,
                "status": "failed",
                "exitCode": 5,
                "manifestName": "package.json",
                "reason": "format-invalid",
                "protocol": crate::tool_cli::CLI_PROTOCOL,
                "protocolIdentity": crate::tool_cli::cli_protocol_identity(),
            }),
        ] {
            let stdout = serde_json::to_vec(&payload).unwrap();
            let outcome = parse_owned_manifest_result(&stdout, ManifestName::PackageJson);
            assert_eq!(outcome.status, ExecutionStatus::Failed);
            assert_eq!(outcome.reason, ExecutionReason::ResultInvalid);
            assert_eq!(outcome.manifest_name, Some(ManifestName::PackageJson));
            let public = serde_json::to_value(outcome.public_view()).unwrap();
            assert_eq!(public["summary"], "项目清单检查结果无法验证。");
            assert!(public.get("exitCode").is_none());
        }
    }

    #[test]
    fn sidecar_manifest_reason_projects_a_safe_product_failure() {
        for (manifest_name, reason, expected_summary) in [
            (
                "package.json",
                "empty",
                "package.json 为空，项目清单检查未通过。",
            ),
            (
                "Cargo.toml",
                "format-invalid",
                "Cargo.toml 格式无效，项目清单检查未通过。",
            ),
        ] {
            let stdout = serde_json::to_vec(&serde_json::json!({
                "ok": false,
                "status": "failed",
                "exitCode": 4,
                "manifestName": manifest_name,
                "reason": reason,
                "protocol": crate::tool_cli::CLI_PROTOCOL,
                "protocolIdentity": crate::tool_cli::cli_protocol_identity(),
            }))
            .unwrap();
            let expected_manifest = ManifestName::from_safe_name(manifest_name).unwrap();
            let outcome = parse_owned_manifest_result(&stdout, expected_manifest);
            assert_eq!(outcome.status, ExecutionStatus::Failed);
            assert_eq!(outcome.manifest_name, Some(expected_manifest));
            assert_eq!(outcome.public_view().summary, expected_summary);
        }
    }

    #[test]
    fn shared_execution_result_matrix_is_typed_and_projects_one_safe_summary() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/executionResultMatrix.json"
        ))
        .unwrap();
        assert_eq!(fixture["schemaVersion"], 1);
        let cases = fixture["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 44);
        let mut legal = std::collections::HashSet::new();

        for case in cases {
            let mut public_value = serde_json::json!({
                "status": case["status"],
                "reason": case["reason"],
                "summary": case["summary"],
            });
            if let Some(manifest_name) = case["manifestName"].as_str() {
                public_value["manifestName"] = serde_json::Value::String(manifest_name.to_owned());
            }
            let public = ExecutionResultView::from_public_value(&public_value).unwrap();
            let typed = public.clone().into_observation().unwrap();
            assert_eq!(typed.public_view(), public);
            assert_eq!(public.summary, case["summary"]);
            assert_eq!(typed.receipt_state(), case["receiptState"]);
            assert!(serde_json::to_string(&public)
                .unwrap()
                .find("exitCode")
                .is_none());
            legal.insert(format!(
                "{}|{}|{}",
                case["status"].as_str().unwrap(),
                case["reason"].as_str().unwrap(),
                case["manifestName"].as_str().unwrap_or("<none>")
            ));
        }

        let statuses = [
            ExecutionStatus::Passed,
            ExecutionStatus::Failed,
            ExecutionStatus::NotRun,
            ExecutionStatus::Stopped,
            ExecutionStatus::TimedOut,
            ExecutionStatus::StartFailed,
            ExecutionStatus::Uncertain,
        ];
        let reasons = [
            ExecutionReason::Valid,
            ExecutionReason::Missing,
            ExecutionReason::Unavailable,
            ExecutionReason::Empty,
            ExecutionReason::EncodingInvalid,
            ExecutionReason::FormatInvalid,
            ExecutionReason::TooLarge,
            ExecutionReason::UnsafeFile,
            ExecutionReason::Unreadable,
            ExecutionReason::ResultInvalid,
            ExecutionReason::NotStarted,
            ExecutionReason::ManifestChanged,
            ExecutionReason::UserStopped,
            ExecutionReason::TimeLimit,
            ExecutionReason::CouldNotStart,
            ExecutionReason::ResultNeedsReconciliation,
        ];
        let manifests = [
            None,
            Some(ManifestName::PackageJson),
            Some(ManifestName::CargoToml),
            Some(ManifestName::PyprojectToml),
        ];
        for status in statuses {
            for reason in reasons {
                for manifest_name in manifests {
                    let key = format!(
                        "{}|{}|{}",
                        status.as_str(),
                        reason.as_str(),
                        manifest_name.map(ManifestName::as_str).unwrap_or("<none>")
                    );
                    assert_eq!(
                        ExecutionRunObservation::try_new(status, manifest_name, reason).is_ok(),
                        legal.contains(&key),
                        "Rust accepted a tuple that differs from the shared matrix: {key}"
                    );
                }
            }
        }
        assert!(ExecutionResultView::from_public_value(&serde_json::json!({
            "status":"failed",
            "manifestName": null,
            "reason":"missing",
            "summary":"未找到支持的项目清单，项目清单检查未通过。"
        }))
        .is_err());
    }
}
