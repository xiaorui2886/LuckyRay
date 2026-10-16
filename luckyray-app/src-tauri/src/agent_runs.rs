use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::knowledge::{KnowledgeDocumentRef, KnowledgeService};

const RUN_ID_MAX_BYTES: usize = 128;
const CONTENT_MAX_BYTES: usize = 64 * 1024;
const SAFE_TEXT_MAX_BYTES: usize = 128 * 1024;
const MAX_SOURCES_PER_RUN: u32 = 25;
const MAX_ARTIFACTS_PER_RUN: u32 = 32;
const TERMINAL_STATUSES: &[&str] = &[
    "completed",
    "partial",
    "failed",
    "cancelled",
    "aborted",
    "interrupted",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunKind {
    Agent,
    Research,
}

impl RunKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Research => "research",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunExecutionMode {
    Foreground,
    Background,
}

impl RunExecutionMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Foreground => "foreground",
            Self::Background => "background",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgentConversationMode {
    Standard,
    ProjectTask,
}

impl AgentConversationMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::ProjectTask => "project-task",
        }
    }

    fn parse(value: &str) -> Result<Self, RunLedgerError> {
        match value {
            "standard" => Ok(Self::Standard),
            "project-task" => Ok(Self::ProjectTask),
            _ => Err(RunLedgerError::new("agent-run-conversation-mode-invalid")),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentConversationSummary {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) agent_mode: String,
    pub(crate) project_id: Option<String>,
    pub(crate) pinned_at: Option<String>,
    pub(crate) archived_at: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WorkspaceActionTruth {
    NotRequested,
    NotApplied,
    Verified,
    Partial,
    Uncertain,
}

impl WorkspaceActionTruth {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::NotRequested => "not-requested",
            Self::NotApplied => "not-applied",
            Self::Verified => "verified",
            Self::Partial => "partial",
            Self::Uncertain => "uncertain",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "not-requested" => Some(Self::NotRequested),
            "not-applied" => Some(Self::NotApplied),
            "verified" => Some(Self::Verified),
            "partial" => Some(Self::Partial),
            "uncertain" => Some(Self::Uncertain),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ExecutionActionTruth {
    NotRequested,
    NoResult,
    Verified,
    Uncertain,
}

impl ExecutionActionTruth {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::NotRequested => "not-requested",
            Self::NoResult => "no-result",
            Self::Verified => "verified",
            Self::Uncertain => "uncertain",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "not-requested" => Some(Self::NotRequested),
            "no-result" => Some(Self::NoResult),
            "verified" => Some(Self::Verified),
            "uncertain" => Some(Self::Uncertain),
            _ => None,
        }
    }
}

/// Durable, non-authoritative projection of Backend action settlement for one
/// assistant result message. It contains no run, approval, artifact, path,
/// digest, provider, or execution identity and can never authorize an action.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentActionTruth {
    pub(crate) workspace: WorkspaceActionTruth,
    pub(crate) execution: ExecutionActionTruth,
}

impl AgentActionTruth {
    pub(crate) const fn new(
        workspace: WorkspaceActionTruth,
        execution: ExecutionActionTruth,
    ) -> Self {
        Self {
            workspace,
            execution,
        }
    }

    fn parse(workspace: &str, execution: &str) -> Option<Self> {
        Some(Self::new(
            WorkspaceActionTruth::parse(workspace)?,
            ExecutionActionTruth::parse(execution)?,
        ))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentMessageView {
    pub(crate) id: String,
    pub(crate) conversation_id: String,
    pub(crate) role: String,
    pub(crate) content: String,
    pub(crate) created_at: String,
    pub(crate) action_truth: Option<AgentActionTruth>,
}

#[derive(Clone, Debug)]
pub(crate) struct RunAdmission {
    pub(crate) conversation_id: String,
    pub(crate) user_content: String,
    pub(crate) kind: RunKind,
    pub(crate) execution_mode: RunExecutionMode,
    pub(crate) policy_id: String,
    pub(crate) vault_binding_digest: String,
    pub(crate) restart_of: Option<String>,
    pub(crate) existing_trigger_message_id: Option<String>,
    /// Backend-only schedule fire locator. When present, admission links the
    /// fire to this newly-created run inside the same SQLite transaction.
    pub(crate) schedule_fire_id: Option<String>,
}

pub(crate) struct AdmittedRun {
    pub(crate) run_id: String,
    pub(crate) lease: RunExecutionLease,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunStopCause {
    ExplicitCancel,
    SafetyAbort,
}

impl RunStopCause {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::ExplicitCancel => "explicit-cancel",
            Self::SafetyAbort => "safety-abort",
        }
    }

    fn parse(value: &str) -> Result<Self, RunLedgerError> {
        match value {
            "explicit-cancel" => Ok(Self::ExplicitCancel),
            "safety-abort" => Ok(Self::SafetyAbort),
            _ => Err(RunLedgerError::new("agent-run-state-conflict")),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) enum AgentObservedTerminal {
    Completed,
    Failed { code: String },
    Cancelled,
    Aborted,
    NotExecuted,
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StopTransportObservation {
    Unknown,
    NotRequested,
    Acknowledged,
    Failed,
}

impl StopTransportObservation {
    fn parse(value: Option<&str>) -> Result<Self, RunLedgerError> {
        match value {
            None => Ok(Self::NotRequested),
            Some("unknown") => Ok(Self::Unknown),
            Some("acknowledged") => Ok(Self::Acknowledged),
            Some("failed") => Ok(Self::Failed),
            Some(_) => Err(RunLedgerError::new("agent-run-state-conflict")),
        }
    }

    const fn as_durable_str(self) -> Option<&'static str> {
        match self {
            Self::NotRequested => None,
            Self::Unknown => Some("unknown"),
            Self::Acknowledged => Some("acknowledged"),
            Self::Failed => Some("failed"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DurableArtifactActionTruth {
    WorkspaceVerified,
    WorkspacePartial,
    WorkspaceUncertain,
    ExecutionVerified,
    ExecutionUncertain,
}

impl DurableArtifactActionTruth {
    const fn as_str(self) -> &'static str {
        match self {
            Self::WorkspaceVerified => "workspace-verified",
            Self::WorkspacePartial => "workspace-partial",
            Self::WorkspaceUncertain => "workspace-uncertain",
            Self::ExecutionVerified => "execution-verified",
            Self::ExecutionUncertain => "execution-uncertain",
        }
    }

    fn parse(value: &str) -> Result<Self, RunLedgerError> {
        match value {
            "workspace-verified" => Ok(Self::WorkspaceVerified),
            "workspace-partial" => Ok(Self::WorkspacePartial),
            "workspace-uncertain" => Ok(Self::WorkspaceUncertain),
            "execution-verified" => Ok(Self::ExecutionVerified),
            "execution-uncertain" => Ok(Self::ExecutionUncertain),
            _ => Err(RunLedgerError::new("agent-run-state-conflict")),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct AgentTerminalProposal {
    pub(crate) observed: AgentObservedTerminal,
    pub(crate) assistant_content: Option<String>,
    pub(crate) partial: bool,
    pub(crate) cited_references: Vec<String>,
    pub(crate) receipt_summary: Option<String>,
    pub(crate) action_truth: Option<AgentActionTruth>,
}

#[derive(Clone, Debug)]
pub(crate) enum RunTerminal {
    /// The only admitted/running Agent terminal proposal. RunCoordinator
    /// reduces this observation with the durable stop cause and receipt facts
    /// inside the same Immediate transaction that commits the terminal row.
    Agent(AgentTerminalProposal),
    Completed {
        assistant_content: String,
        partial: bool,
        cited_references: Vec<String>,
        action_truth: Option<AgentActionTruth>,
    },
    Failed {
        code: String,
        committed_warning: bool,
    },
    FailedWithResult {
        code: String,
        assistant_content: String,
        committed_warning: bool,
        action_truth: Option<AgentActionTruth>,
    },
    /// The run itself failed, but a prior receipt-backed Workspace operation
    /// already committed or became durably uncertain. The safe Backend summary
    /// is persisted as the result row while status/safe_code remain failed;
    /// model prose is never accepted through this variant.
    FailedWithCommittedResult {
        code: String,
        assistant_content: String,
        action_truth: Option<AgentActionTruth>,
    },
    CancelledWithCommittedResult {
        assistant_content: String,
        action_truth: Option<AgentActionTruth>,
    },
    AbortedWithCommittedResult {
        assistant_content: String,
        action_truth: Option<AgentActionTruth>,
    },
    InterruptedWithCommittedResult {
        assistant_content: String,
        action_truth: Option<AgentActionTruth>,
    },
    /// A cancelled run without a receipt-backed action result still owns one
    /// Backend-authored durable assistant row. This keeps explicit Stop truth
    /// identical across the live surface, history reload, and remount.
    Cancelled {
        action_truth: Option<AgentActionTruth>,
    },
    /// Route/app safety termination is distinct from an explicit user Stop,
    /// but follows the same durable one-result-row settlement contract.
    Aborted {
        action_truth: Option<AgentActionTruth>,
    },
    Interrupted {
        action_truth: Option<AgentActionTruth>,
    },
}

#[derive(Default)]
struct DurableEffectProjection {
    workspace_truth: Option<WorkspaceActionTruth>,
    execution_truth: Option<ExecutionActionTruth>,
    any_committed: bool,
    workspace_names: Vec<String>,
    execution_names: Vec<String>,
    safe_result_summaries: Vec<String>,
}

impl DurableEffectProjection {
    fn action_truth(&self, fallback: Option<AgentActionTruth>) -> Option<AgentActionTruth> {
        if self.workspace_truth.is_none() && self.execution_truth.is_none() {
            return fallback;
        }
        let fallback = fallback.unwrap_or(AgentActionTruth::new(
            WorkspaceActionTruth::NotRequested,
            ExecutionActionTruth::NotRequested,
        ));
        Some(AgentActionTruth::new(
            self.workspace_truth.unwrap_or(fallback.workspace),
            self.execution_truth.unwrap_or(fallback.execution),
        ))
    }

    fn receipt_summary(&self) -> Option<String> {
        if !self.safe_result_summaries.is_empty() {
            return Some(self.safe_result_summaries.join("\n"));
        }
        let mut lines = Vec::new();
        match self.workspace_truth {
            Some(WorkspaceActionTruth::Uncertain) => {
                lines.push("文件状态待核对；不会自动重试。".to_owned())
            }
            Some(WorkspaceActionTruth::Partial) => lines.push(format!(
                "授权文件部分变更已提交：{}。",
                self.workspace_names.join("、")
            )),
            Some(WorkspaceActionTruth::Verified) => lines.push(format!(
                "授权文件变更已确认：{}。",
                self.workspace_names.join("、")
            )),
            _ => {}
        }
        match self.execution_truth {
            Some(ExecutionActionTruth::Uncertain) => {
                lines.push("项目检查结果待核对；不会自动重试。".to_owned())
            }
            Some(ExecutionActionTruth::Verified) => {
                lines.push(format!("项目检查：{}。", self.execution_names.join("、")))
            }
            _ => {}
        }
        (!lines.is_empty()).then(|| lines.join("\n"))
    }
}

fn merge_workspace_truth(
    current: Option<WorkspaceActionTruth>,
    candidate: WorkspaceActionTruth,
) -> Option<WorkspaceActionTruth> {
    let rank = |value| match value {
        WorkspaceActionTruth::NotRequested => 0,
        WorkspaceActionTruth::NotApplied => 1,
        WorkspaceActionTruth::Verified => 2,
        WorkspaceActionTruth::Partial => 3,
        WorkspaceActionTruth::Uncertain => 4,
    };
    Some(
        current
            .filter(|value| rank(*value) >= rank(candidate))
            .unwrap_or(candidate),
    )
}

fn merge_execution_truth(
    current: Option<ExecutionActionTruth>,
    candidate: ExecutionActionTruth,
) -> Option<ExecutionActionTruth> {
    let rank = |value| match value {
        ExecutionActionTruth::NotRequested => 0,
        ExecutionActionTruth::NoResult => 1,
        ExecutionActionTruth::Verified => 2,
        ExecutionActionTruth::Uncertain => 3,
    };
    Some(
        current
            .filter(|value| rank(*value) >= rank(candidate))
            .unwrap_or(candidate),
    )
}

fn durable_effect_projection(
    transaction: &Transaction<'_>,
    run_id: &str,
) -> Result<DurableEffectProjection, RunLedgerError> {
    let mut statement = transaction
        .prepare(
            "SELECT entity_kind,receipt_state,status,display_name,action_truth,safe_result_summary
             FROM ai_run_artifact WHERE run_id=?1 ORDER BY created_at,id",
        )
        .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
    let rows = statement
        .query_map([run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
    let mut projection = DurableEffectProjection::default();
    for row in rows {
        let (entity_kind, receipt_state, status, display_name, stored_truth, safe_summary) =
            row.map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        let uncertain = matches!(receipt_state.as_str(), "uncertain" | "provider-uncertain")
            || status == "uncertain";
        let committed = matches!(receipt_state.as_str(), "committed" | "ledger-committed")
            || matches!(status.as_str(), "committed" | "committed-warning");
        projection.any_committed |= committed;
        if let Some(summary) = safe_summary {
            if (committed || uncertain)
                && !summary.trim().is_empty()
                && summary.as_bytes().len() <= SAFE_TEXT_MAX_BYTES
                && !projection.safe_result_summaries.contains(&summary)
            {
                projection.safe_result_summaries.push(summary);
            }
        }
        let typed = stored_truth
            .as_deref()
            .map(DurableArtifactActionTruth::parse)
            .transpose()?;
        match typed {
            Some(DurableArtifactActionTruth::WorkspaceUncertain) => {
                projection.workspace_truth = merge_workspace_truth(
                    projection.workspace_truth,
                    WorkspaceActionTruth::Uncertain,
                );
            }
            Some(DurableArtifactActionTruth::WorkspacePartial) => {
                projection.workspace_truth = merge_workspace_truth(
                    projection.workspace_truth,
                    WorkspaceActionTruth::Partial,
                );
            }
            Some(DurableArtifactActionTruth::WorkspaceVerified) => {
                projection.workspace_truth = merge_workspace_truth(
                    projection.workspace_truth,
                    WorkspaceActionTruth::Verified,
                );
            }
            Some(DurableArtifactActionTruth::ExecutionUncertain) => {
                projection.execution_truth = merge_execution_truth(
                    projection.execution_truth,
                    ExecutionActionTruth::Uncertain,
                );
            }
            Some(DurableArtifactActionTruth::ExecutionVerified) => {
                projection.execution_truth = merge_execution_truth(
                    projection.execution_truth,
                    ExecutionActionTruth::Verified,
                );
            }
            None if entity_kind == "execution" && uncertain => {
                projection.execution_truth = merge_execution_truth(
                    projection.execution_truth,
                    ExecutionActionTruth::Uncertain,
                );
            }
            None if entity_kind == "execution" && committed => {
                projection.execution_truth = merge_execution_truth(
                    projection.execution_truth,
                    ExecutionActionTruth::Verified,
                );
            }
            None if matches!(
                entity_kind.as_str(),
                "workspace-file" | "workspace-change-set"
            ) && uncertain =>
            {
                projection.workspace_truth = merge_workspace_truth(
                    projection.workspace_truth,
                    WorkspaceActionTruth::Uncertain,
                );
            }
            None if matches!(
                entity_kind.as_str(),
                "workspace-file" | "workspace-change-set"
            ) && committed =>
            {
                let inferred = if entity_kind == "workspace-change-set"
                    && display_name == "部分应用多文件变更"
                {
                    WorkspaceActionTruth::Partial
                } else {
                    WorkspaceActionTruth::Verified
                };
                projection.workspace_truth =
                    merge_workspace_truth(projection.workspace_truth, inferred);
            }
            _ => {}
        }
        if matches!(
            entity_kind.as_str(),
            "workspace-file" | "workspace-change-set"
        ) && (committed || uncertain)
            && !projection.workspace_names.contains(&display_name)
        {
            projection.workspace_names.push(display_name.clone());
        }
        if entity_kind == "execution"
            && (committed || uncertain)
            && !projection.execution_names.contains(&display_name)
        {
            projection.execution_names.push(display_name);
        }
    }
    Ok(projection)
}

/// Reduces worker/transport observations with the monotonic durable cause and
/// receipt facts while the same Immediate transaction owns terminal commit.
/// Child terminal values are evidence only; they never override uncertain or
/// committed effect truth.
fn reduce_agent_terminal(
    transaction: &Transaction<'_>,
    run_id: &str,
    proposal: AgentTerminalProposal,
) -> Result<RunTerminal, RunLedgerError> {
    let (stop_cause, stop_transport, policy_id) = transaction
        .query_row(
            "SELECT stop_cause,stop_transport,policy_id FROM ai_run WHERE id=?1",
            [run_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
    let stop_cause = stop_cause
        .map(|value| RunStopCause::parse(&value))
        .transpose()?;
    let stop_transport = StopTransportObservation::parse(stop_transport.as_deref())?;
    let effects = durable_effect_projection(transaction, run_id)?;
    let fallback_action_truth = proposal.action_truth.or_else(|| {
        matches!(
            policy_id.as_str(),
            "standard-v1" | "project-task-v1" | "schedule-v1"
        )
        .then(|| {
            AgentActionTruth::new(
                WorkspaceActionTruth::NotRequested,
                ExecutionActionTruth::NotRequested,
            )
        })
    });
    let action_truth = effects.action_truth(fallback_action_truth);
    if effects.workspace_truth == Some(WorkspaceActionTruth::Uncertain)
        || effects.execution_truth == Some(ExecutionActionTruth::Uncertain)
    {
        let (code, assistant_content) =
            if effects.workspace_truth == Some(WorkspaceActionTruth::Uncertain) {
                (
                    "agent-engine-workspace-write-uncertain".to_owned(),
                    "文件状态待核对；不会自动重试。".to_owned(),
                )
            } else {
                (
                    "agent-engine-execution-result-uncertain".to_owned(),
                    "项目检查结果待核对；不会自动重试。".to_owned(),
                )
            };
        return Ok(RunTerminal::FailedWithCommittedResult {
            code,
            assistant_content,
            action_truth,
        });
    }

    let receipt_summary = effects.receipt_summary().or(proposal.receipt_summary);
    let with_receipt = |cancelled: bool, content: Option<String>| {
        content.map(|assistant_content| {
            if cancelled {
                RunTerminal::CancelledWithCommittedResult {
                    assistant_content,
                    action_truth,
                }
            } else {
                RunTerminal::AbortedWithCommittedResult {
                    assistant_content,
                    action_truth,
                }
            }
        })
    };
    let stop_terminal = |cause: RunStopCause| match cause {
        RunStopCause::ExplicitCancel => with_receipt(true, receipt_summary.clone())
            .unwrap_or(RunTerminal::Cancelled { action_truth }),
        RunStopCause::SafetyAbort => with_receipt(false, receipt_summary.clone())
            .unwrap_or(RunTerminal::Aborted { action_truth }),
    };

    match proposal.observed {
        AgentObservedTerminal::Failed { code } => {
            if let Some(assistant_content) = receipt_summary {
                Ok(RunTerminal::FailedWithCommittedResult {
                    code,
                    assistant_content,
                    action_truth,
                })
            } else {
                Ok(RunTerminal::FailedWithResult {
                    code,
                    committed_warning: effects.any_committed,
                    assistant_content: "Agent 未完成：运行未能完成。".to_owned(),
                    action_truth,
                })
            }
        }
        AgentObservedTerminal::NotExecuted => Ok(RunTerminal::FailedWithResult {
            code: "agent-engine-material-not-executed".to_owned(),
            committed_warning: false,
            assistant_content: "素材变更未执行：未写入任何数据。".to_owned(),
            action_truth,
        }),
        AgentObservedTerminal::Interrupted => {
            if let Some(assistant_content) = receipt_summary {
                return Ok(RunTerminal::InterruptedWithCommittedResult {
                    assistant_content,
                    action_truth,
                });
            }
            if matches!(
                stop_transport,
                StopTransportObservation::Unknown | StopTransportObservation::Failed
            ) && stop_cause.is_some()
            {
                return Ok(RunTerminal::Aborted { action_truth });
            }
            if let Some(cause) = stop_cause {
                Ok(stop_terminal(cause))
            } else {
                Ok(RunTerminal::Interrupted { action_truth })
            }
        }
        AgentObservedTerminal::Completed => {
            if stop_transport == StopTransportObservation::Unknown && stop_cause.is_some() {
                // A runtime child observation can race the Stop transport
                // acknowledgement. There is not enough durable input to
                // reduce a terminal yet; the worker retries this exact
                // proposal after the Stop path publishes its monotonic fact.
                return Err(RunLedgerError::new("agent-run-settlement-pending"));
            }
            if stop_transport == StopTransportObservation::Failed && stop_cause.is_some() {
                return Ok(with_receipt(false, receipt_summary)
                    .unwrap_or(RunTerminal::Aborted { action_truth }));
            }
            if let Some(cause) = stop_cause {
                return Ok(stop_terminal(cause));
            }
            let assistant_content = proposal
                .assistant_content
                .ok_or_else(|| RunLedgerError::new("agent-run-protocol-invalid"))?;
            Ok(RunTerminal::Completed {
                assistant_content,
                partial: proposal.partial,
                cited_references: proposal.cited_references,
                action_truth,
            })
        }
        AgentObservedTerminal::Cancelled | AgentObservedTerminal::Aborted => {
            if stop_transport == StopTransportObservation::Unknown && stop_cause.is_some() {
                return Err(RunLedgerError::new("agent-run-settlement-pending"));
            }
            if stop_transport == StopTransportObservation::Failed && stop_cause.is_some() {
                return Ok(with_receipt(false, receipt_summary)
                    .unwrap_or(RunTerminal::Aborted { action_truth }));
            }
            if let Some(cause) = stop_cause {
                Ok(stop_terminal(cause))
            } else if matches!(proposal.observed, AgentObservedTerminal::Cancelled) {
                Ok(with_receipt(true, receipt_summary)
                    .unwrap_or(RunTerminal::Cancelled { action_truth }))
            } else {
                Ok(with_receipt(false, receipt_summary)
                    .unwrap_or(RunTerminal::Aborted { action_truth }))
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DurableRunSnapshot {
    pub(crate) id: String,
    pub(crate) conversation_id: String,
    pub(crate) trigger_message_id: String,
    pub(crate) result_message_id: Option<String>,
    pub(crate) kind: String,
    pub(crate) execution_mode: String,
    pub(crate) policy_id: String,
    pub(crate) status: String,
    pub(crate) phase: String,
    pub(crate) partial: bool,
    pub(crate) model_used: u32,
    pub(crate) tool_used: u32,
    pub(crate) source_count: u32,
    pub(crate) candidate_count: u32,
    pub(crate) elapsed_ms: u64,
    pub(crate) safe_code: Option<String>,
    pub(crate) committed_warning: bool,
    pub(crate) restart_of: Option<String>,
    pub(crate) created_at: String,
    pub(crate) started_at: Option<String>,
    pub(crate) updated_at: String,
    pub(crate) terminal_at: Option<String>,
    pub(crate) version: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RestartSpec {
    pub(crate) conversation_id: String,
    pub(crate) input: String,
    pub(crate) kind: RunKind,
    pub(crate) policy_id: String,
    pub(crate) execution_mode: RunExecutionMode,
    pub(crate) restart_of: String,
    pub(crate) trigger_message_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DurableRunProgress {
    pub(crate) phase: String,
    pub(crate) model_used: u32,
    pub(crate) tool_used: u32,
    pub(crate) source_count: u32,
    pub(crate) candidate_count: u32,
    pub(crate) elapsed_ms: u64,
    pub(crate) partial: bool,
    pub(crate) awaiting_approval: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DurableRunSource {
    pub(crate) reference_label: String,
    pub(crate) source_token: String,
    pub(crate) kind: String,
    pub(crate) host: Option<String>,
    pub(crate) retained: bool,
    pub(crate) cited: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DurableRunArtifact {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) status: String,
    pub(crate) receipt_state: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DurableRunDetails {
    pub(crate) run: DurableRunSnapshot,
    pub(crate) sources: Vec<DurableRunSource>,
    pub(crate) artifacts: Vec<DurableRunArtifact>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DurableArtifactOrigin {
    pub(crate) id: String,
    pub(crate) run_id: String,
    pub(crate) entity_kind: String,
    pub(crate) entity_ref: String,
    pub(crate) operation_digest: String,
    pub(crate) expected_revision: Option<String>,
    pub(crate) new_revision: Option<String>,
    pub(crate) receipt_state: String,
}

impl DurableArtifactOrigin {
    pub(crate) fn canvas_id(&self) -> Result<String, RunLedgerError> {
        if self.entity_kind != "canvas" {
            return Err(RunLedgerError::new("agent-run-artifact-invalid"));
        }
        let canvas_id = if self.entity_ref.starts_with('{') {
            serde_json::from_str::<CanvasArtifactBinding>(&self.entity_ref)
                .map_err(|_| RunLedgerError::new("agent-run-artifact-invalid"))?
                .canvas_id
        } else {
            self.entity_ref.clone()
        };
        validate_id(&canvas_id)?;
        Ok(canvas_id)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CanvasArtifactBinding {
    canvas_id: String,
    stage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    material_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output_digest: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArtifactReconciliation {
    Committed,
    NotCommitted,
    Uncertain,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RunLedgerError {
    pub(crate) code: &'static str,
}

impl RunLedgerError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

#[derive(Clone)]
pub(crate) struct RunCoordinator {
    db_path: Option<Arc<PathBuf>>,
    test_connection: Option<Arc<Mutex<Connection>>>,
    runtime: Arc<RuntimeGate>,
    #[cfg(test)]
    fail_next_mark_running: Arc<AtomicBool>,
    #[cfg(test)]
    fail_next_settles: Arc<AtomicUsize>,
}

#[derive(Default)]
struct RuntimeState {
    owner: Option<RuntimeOwner>,
}

struct RuntimeOwner {
    id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
struct RuntimeGate {
    state: Mutex<RuntimeState>,
    changed: Condvar,
}

pub(crate) struct RunExecutionLease {
    gate: Arc<RuntimeGate>,
    owner_id: String,
    cancelled: Arc<AtomicBool>,
    released: bool,
}

impl RunExecutionLease {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub(crate) fn cancellation_flag(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    #[cfg(test)]
    pub(crate) fn run_id(&self) -> &str {
        &self.owner_id
    }

    fn release_inner(&mut self) {
        if self.released {
            return;
        }
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|item| item.into_inner());
        if state.owner.as_ref().map(|owner| owner.id.as_str()) == Some(self.owner_id.as_str()) {
            state.owner = None;
            self.gate.changed.notify_all();
        }
        self.released = true;
    }
}

impl Drop for RunExecutionLease {
    fn drop(&mut self) {
        self.release_inner();
    }
}

impl RunCoordinator {
    fn release_runtime_owner(&self, owner_id: &str) {
        let mut state = self
            .runtime
            .state
            .lock()
            .unwrap_or_else(|item| item.into_inner());
        if state.owner.as_ref().map(|owner| owner.id.as_str()) == Some(owner_id) {
            state.owner = None;
            self.runtime.changed.notify_all();
        }
    }

    pub(crate) fn has_active_background_run(&self) -> Result<bool, RunLedgerError> {
        self.with_connection(|connection| {
            let active: u32 = connection
                .query_row(
                    "SELECT COUNT(*) FROM ai_run
                     WHERE execution_mode='background'
                       AND status IN ('queued','running','planning','gathering','synthesizing','awaiting-approval')",
                    [],
                    |row| row.get(0),
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(active > 0)
        })
    }

    /// Opens the migrated run ledger without publishing restart terminals.
    /// Backend bootstrap must reconcile every durable artifact authority first,
    /// then call `reconcile_startup_terminals` exactly once.
    pub(crate) fn open(db_path: &Path) -> Result<Self, RunLedgerError> {
        Ok(Self {
            db_path: Some(Arc::new(db_path.to_path_buf())),
            test_connection: None,
            runtime: Arc::new(RuntimeGate::default()),
            #[cfg(test)]
            fail_next_mark_running: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            fail_next_settles: Arc::new(AtomicUsize::new(0)),
        })
    }

    #[cfg(test)]
    fn from_connection(connection: Connection) -> Self {
        Self {
            db_path: None,
            test_connection: Some(Arc::new(Mutex::new(connection))),
            runtime: Arc::new(RuntimeGate::default()),
            fail_next_mark_running: Arc::new(AtomicBool::new(false)),
            fail_next_settles: Arc::new(AtomicUsize::new(0)),
        }
    }

    #[cfg(test)]
    pub(crate) fn fail_next_mark_running(&self) {
        self.fail_next_mark_running.store(true, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn fail_next_settle(&self) {
        self.fail_next_settles(1);
    }

    #[cfg(test)]
    pub(crate) fn fail_next_settles(&self, count: usize) {
        self.fail_next_settles.store(count, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn remaining_injected_settle_failures(&self) -> usize {
        self.fail_next_settles.load(Ordering::Acquire)
    }

    fn acquire_runtime(&self, owner_id: String) -> Result<RunExecutionLease, RunLedgerError> {
        validate_id(&owner_id)?;
        let mut state = self
            .runtime
            .state
            .lock()
            .unwrap_or_else(|item| item.into_inner());
        if state.owner.is_some() {
            return Err(RunLedgerError::new("agent-engine-busy"));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        state.owner = Some(RuntimeOwner {
            id: owner_id.clone(),
            cancelled: cancelled.clone(),
        });
        Ok(RunExecutionLease {
            gate: self.runtime.clone(),
            owner_id,
            cancelled,
            released: false,
        })
    }

    pub(crate) fn acquire_transient(
        &self,
        domain: &str,
    ) -> Result<RunExecutionLease, RunLedgerError> {
        validate_safe_label(domain)?;
        self.acquire_runtime(format!("transient-{domain}-{}", random_hex(12)))
    }

    pub(crate) fn cancel_active(&self) {
        let state = self
            .runtime
            .state
            .lock()
            .unwrap_or_else(|item| item.into_inner());
        if let Some(owner) = state.owner.as_ref() {
            owner.cancelled.store(true, Ordering::Release);
        }
    }

    pub(crate) fn cancel_transient(&self, domain: &str) -> Result<bool, RunLedgerError> {
        validate_safe_label(domain)?;
        let prefix = format!("transient-{domain}-");
        let state = self
            .runtime
            .state
            .lock()
            .unwrap_or_else(|item| item.into_inner());
        let Some(owner) = state
            .owner
            .as_ref()
            .filter(|owner| owner.id.starts_with(&prefix))
        else {
            return Ok(false);
        };
        owner.cancelled.store(true, Ordering::Release);
        Ok(true)
    }

    pub(crate) fn wait_for_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .runtime
            .state
            .lock()
            .unwrap_or_else(|item| item.into_inner());
        while state.owner.is_some() {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let waited = self
                .runtime
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(now))
                .unwrap_or_else(|item| item.into_inner());
            state = waited.0;
            if waited.1.timed_out() && state.owner.is_some() {
                return false;
            }
        }
        true
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, RunLedgerError>,
    ) -> Result<T, RunLedgerError> {
        if let Some(connection) = self.test_connection.as_ref() {
            let mut connection = connection.lock().unwrap_or_else(|item| item.into_inner());
            return operation(&mut connection);
        }
        let path = self
            .db_path
            .as_deref()
            .ok_or_else(|| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        let mut connection = Connection::open(path.as_path())
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        operation(&mut connection)
    }

    pub(crate) fn conversation_mode(
        &self,
        conversation_id: &str,
    ) -> Result<AgentConversationMode, RunLedgerError> {
        validate_id(conversation_id)?;
        self.with_connection(|connection| {
            let mode = connection
                .query_row(
                    "SELECT agent_mode FROM ai_conversation WHERE id=?1",
                    [conversation_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
                .ok_or_else(|| RunLedgerError::new("agent-run-conversation-unavailable"))?;
            AgentConversationMode::parse(&mode)
        })
    }

    pub(crate) fn list_conversations(
        &self,
        limit: u32,
    ) -> Result<Vec<AgentConversationSummary>, RunLedgerError> {
        let limit = limit.clamp(1, 500);
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id,title,created_at,updated_at,agent_mode,
                            project_id,pinned_at,archived_at
                     FROM ai_conversation
                     ORDER BY (pinned_at IS NOT NULL) DESC,
                              pinned_at DESC,updated_at DESC,id DESC LIMIT ?1",
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let conversations = statement
                .query_map([limit], map_conversation_summary)
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(conversations)
        })
    }

    pub(crate) fn list_messages(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<AgentMessageView>, RunLedgerError> {
        validate_id(conversation_id)?;
        self.with_connection(|connection| {
            let conversation_exists = connection
                .query_row(
                    "SELECT 1 FROM ai_conversation WHERE id=?1",
                    [conversation_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
                .is_some();
            if !conversation_exists {
                return Err(RunLedgerError::new("agent-run-conversation-unavailable"));
            }
            let mut statement = connection
                .prepare(
                    "SELECT message.id,message.conversation_id,message.role,message.content,
                            message.created_at,truth.workspace_status,truth.execution_status
                     FROM ai_message AS message
                     LEFT JOIN ai_message_action_truth AS truth
                       ON truth.message_id=message.id
                     WHERE message.conversation_id=?1
                     ORDER BY message.created_at,message.id",
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let messages = statement
                .query_map([conversation_id], |row| {
                    let workspace = row.get::<_, Option<String>>(5)?;
                    let execution = row.get::<_, Option<String>>(6)?;
                    let action_truth = match (workspace.as_deref(), execution.as_deref()) {
                        (Some(workspace), Some(execution)) => {
                            AgentActionTruth::parse(workspace, execution)
                        }
                        _ => None,
                    };
                    Ok(AgentMessageView {
                        id: row.get(0)?,
                        conversation_id: row.get(1)?,
                        role: row.get(2)?,
                        content: row.get(3)?,
                        created_at: row.get(4)?,
                        action_truth,
                    })
                })
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(messages)
        })
    }

    pub(crate) fn set_conversation_pinned(
        &self,
        conversation_id: &str,
        pinned: bool,
    ) -> Result<AgentConversationSummary, RunLedgerError> {
        self.set_conversation_marker(conversation_id, "pinned_at", pinned)
    }

    pub(crate) fn set_conversation_archived(
        &self,
        conversation_id: &str,
        archived: bool,
    ) -> Result<AgentConversationSummary, RunLedgerError> {
        self.set_conversation_marker(conversation_id, "archived_at", archived)
    }

    fn set_conversation_marker(
        &self,
        conversation_id: &str,
        column: &str,
        enabled: bool,
    ) -> Result<AgentConversationSummary, RunLedgerError> {
        validate_id(conversation_id)?;
        let now = chrono::Utc::now().to_rfc3339();
        self.with_connection(|connection| {
            let sql = match column {
                "pinned_at" => "UPDATE ai_conversation SET pinned_at=?2,updated_at=?3 WHERE id=?1",
                "archived_at" => {
                    "UPDATE ai_conversation
                     SET archived_at=?2,pinned_at=NULL,updated_at=?3
                     WHERE id=?1"
                }
                _ => return Err(RunLedgerError::new("agent-run-protocol-invalid")),
            };
            let marker = enabled.then_some(now.as_str());
            let changed = connection
                .execute(sql, params![conversation_id, marker, now])
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if changed != 1 {
                return Err(RunLedgerError::new("agent-run-conversation-unavailable"));
            }
            connection
                .query_row(
                    "SELECT id,title,created_at,updated_at,agent_mode,
                            project_id,pinned_at,archived_at
                     FROM ai_conversation WHERE id=?1",
                    [conversation_id],
                    map_conversation_summary,
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))
        })
    }

    pub(crate) fn delete_conversation(&self, conversation_id: &str) -> Result<(), RunLedgerError> {
        validate_id(conversation_id)?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM ai_conversation WHERE id=?1)",
                    [conversation_id],
                    |row| row.get(0),
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if !exists {
                return Err(RunLedgerError::new("agent-run-conversation-unavailable"));
            }
            let active_runs: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM ai_run
                     WHERE conversation_id=?1
                       AND status IN (
                           'queued','running','planning','gathering',
                           'synthesizing','awaiting-approval'
                       )",
                    [conversation_id],
                    |row| row.get(0),
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if active_runs > 0 {
                return Err(RunLedgerError::new("agent-conversation-delete-blocked"));
            }
            let retained_receipts: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1
                         FROM ai_run_artifact AS artifact
                         JOIN ai_run AS run ON run.id=artifact.run_id
                         WHERE run.conversation_id=?1
                           AND artifact.receipt_state IN ('prepared','uncertain')
                     )",
                    [conversation_id],
                    |row| row.get(0),
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if retained_receipts {
                return Err(RunLedgerError::new(
                    "agent-conversation-delete-receipt-retained",
                ));
            }
            for sql in [
                "DELETE FROM ai_message_action_truth WHERE message_id IN (
                     SELECT id FROM ai_message WHERE conversation_id=?1
                 )",
                "DELETE FROM ai_run_source WHERE run_id IN (
                     SELECT id FROM ai_run WHERE conversation_id=?1
                 )",
                "DELETE FROM ai_run_artifact WHERE run_id IN (
                     SELECT id FROM ai_run WHERE conversation_id=?1
                 )",
                "DELETE FROM ai_run_capability_snapshot WHERE run_id IN (
                     SELECT id FROM ai_run WHERE conversation_id=?1
                 )",
                "DELETE FROM ai_run WHERE conversation_id=?1",
                "DELETE FROM ai_message WHERE conversation_id=?1",
                "DELETE FROM ai_conversation WHERE id=?1",
            ] {
                transaction
                    .execute(sql, [conversation_id])
                    .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            }
            transaction
                .commit()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))
        })
    }

    /// Compensates only the private draft-start window before R5 admission.
    /// The delete is linearized under an Immediate transaction and succeeds
    /// only while the newly-created conversation has no message and no run.
    /// It is deliberately narrower than user-initiated permanent deletion:
    /// once admission wrote either durable row, the conversation is history.
    pub(crate) fn discard_empty_draft_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<bool, RunLedgerError> {
        validate_id(conversation_id)?;
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let changed = transaction
                .execute(
                    "DELETE FROM ai_conversation
                     WHERE id=?1
                       AND NOT EXISTS(
                         SELECT 1 FROM ai_message WHERE conversation_id=?1
                       )
                       AND NOT EXISTS(
                         SELECT 1 FROM ai_run WHERE conversation_id=?1
                       )",
                    [conversation_id],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .commit()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(changed == 1)
        })
    }

    pub(crate) fn create_project_conversation(
        &self,
        title: &str,
    ) -> Result<AgentConversationSummary, RunLedgerError> {
        self.create_project_conversation_with_project(title, None)
    }

    pub(crate) fn create_standard_conversation(
        &self,
        title: &str,
    ) -> Result<AgentConversationSummary, RunLedgerError> {
        let title = title.trim();
        if title.is_empty() || title.as_bytes().len() > 120 || title.chars().any(char::is_control) {
            return Err(RunLedgerError::new("agent-run-protocol-invalid"));
        }
        let id = format!("conv-{}", random_hex(16));
        let now = chrono::Utc::now().to_rfc3339();
        self.with_connection(|connection| {
            connection
                .execute(
                    "INSERT INTO ai_conversation(
                         id,title,created_at,updated_at,agent_mode,project_id
                     ) VALUES (?1,?2,?3,?3,'standard',NULL)",
                    params![id, title, now],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(AgentConversationSummary {
                id,
                title: title.to_owned(),
                created_at: now.clone(),
                updated_at: now,
                agent_mode: AgentConversationMode::Standard.as_str().to_owned(),
                project_id: None,
                pinned_at: None,
                archived_at: None,
            })
        })
    }

    pub(crate) fn create_project_conversation_in_project(
        &self,
        title: &str,
        project_id: &str,
    ) -> Result<AgentConversationSummary, RunLedgerError> {
        validate_id(project_id)?;
        self.create_project_conversation_with_project(title, Some(project_id))
    }

    fn create_project_conversation_with_project(
        &self,
        title: &str,
        project_id: Option<&str>,
    ) -> Result<AgentConversationSummary, RunLedgerError> {
        let title = title.trim();
        if title.is_empty() || title.as_bytes().len() > 120 || title.chars().any(char::is_control) {
            return Err(RunLedgerError::new("agent-run-protocol-invalid"));
        }
        let id = format!("conv-{}", random_hex(16));
        let now = chrono::Utc::now().to_rfc3339();
        self.with_connection(|connection| {
            if let Some(project_id) = project_id {
                let project_exists: bool = connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM agent_project WHERE id=?1)",
                        [project_id],
                        |row| row.get(0),
                    )
                    .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
                if !project_exists {
                    return Err(RunLedgerError::new("agent-project-not-found"));
                }
            }
            connection
                .execute(
                    "INSERT INTO ai_conversation(
                         id,title,created_at,updated_at,agent_mode,project_id
                     ) VALUES (?1,?2,?3,?3,'project-task',?4)",
                    params![id, title, now, project_id],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(AgentConversationSummary {
                id,
                title: title.to_owned(),
                created_at: now.clone(),
                updated_at: now,
                agent_mode: AgentConversationMode::ProjectTask.as_str().to_owned(),
                project_id: project_id.map(ToOwned::to_owned),
                pinned_at: None,
                archived_at: None,
            })
        })
    }

    pub(crate) fn apply_schema(connection: &Connection) -> rusqlite::Result<()> {
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS ai_run (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                trigger_message_id TEXT NOT NULL,
                result_message_id TEXT,
                kind TEXT NOT NULL,
                execution_mode TEXT NOT NULL,
                policy_id TEXT NOT NULL,
                policy_version INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL,
                phase TEXT NOT NULL,
                partial INTEGER NOT NULL DEFAULT 0,
                model_used INTEGER NOT NULL DEFAULT 0,
                tool_used INTEGER NOT NULL DEFAULT 0,
                source_count INTEGER NOT NULL DEFAULT 0,
                candidate_count INTEGER NOT NULL DEFAULT 0,
                elapsed_ms INTEGER NOT NULL DEFAULT 0,
                safe_code TEXT,
                committed_warning INTEGER NOT NULL DEFAULT 0,
                stop_cause TEXT CHECK(stop_cause IS NULL OR stop_cause IN ('explicit-cancel','safety-abort')),
                stop_transport TEXT CHECK(stop_transport IS NULL OR stop_transport IN ('unknown','acknowledged','failed')),
                restart_of_run_id TEXT,
                vault_binding_digest TEXT,
                created_at TEXT NOT NULL,
                started_at TEXT,
                updated_at TEXT NOT NULL,
                terminal_at TEXT,
                version INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS ai_run_source (
                run_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                reference_label TEXT NOT NULL,
                source_token TEXT NOT NULL,
                kind TEXT NOT NULL,
                host TEXT,
                retained INTEGER NOT NULL DEFAULT 1,
                cited INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(run_id, ordinal)
             );
             CREATE TABLE IF NOT EXISTS ai_run_artifact (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                public_token TEXT NOT NULL UNIQUE,
                entity_kind TEXT NOT NULL,
                entity_ref TEXT NOT NULL,
                operation_digest TEXT NOT NULL,
                expected_revision TEXT,
                new_revision TEXT,
                receipt_state TEXT NOT NULL,
                display_name TEXT NOT NULL,
                status TEXT NOT NULL,
                action_truth TEXT CHECK(action_truth IS NULL OR action_truth IN ('workspace-verified','workspace-partial','workspace-uncertain','execution-verified','execution-uncertain')),
                safe_result_summary TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_ai_run_status_updated
                ON ai_run(status, updated_at);
             CREATE INDEX IF NOT EXISTS idx_ai_run_conversation_created
                ON ai_run(conversation_id, created_at);
             CREATE INDEX IF NOT EXISTS idx_ai_run_terminal
                ON ai_run(terminal_at);
             CREATE INDEX IF NOT EXISTS idx_ai_run_source_run
                ON ai_run_source(run_id, ordinal);
             CREATE INDEX IF NOT EXISTS idx_ai_run_artifact_run
                ON ai_run_artifact(run_id, created_at);",
        )
    }

    pub(crate) fn admit(&self, input: RunAdmission) -> Result<AdmittedRun, RunLedgerError> {
        validate_id(&input.conversation_id)?;
        validate_id(&input.policy_id)?;
        validate_digest(&input.vault_binding_digest)?;
        if input.user_content.trim().is_empty()
            || input.user_content.as_bytes().len() > CONTENT_MAX_BYTES
        {
            return Err(RunLedgerError::new("agent-run-protocol-invalid"));
        }
        if let Some(restart_of) = input.restart_of.as_deref() {
            validate_id(restart_of)?;
        }
        let now = chrono::Utc::now().to_rfc3339();
        let run_id = format!("run-{}", random_hex(16));
        let lease = self.acquire_runtime(run_id.clone())?;
        if let Some(message_id) = input.existing_trigger_message_id.as_deref() {
            validate_id(message_id)?;
        }
        if let Some(fire_id) = input.schedule_fire_id.as_deref() {
            validate_id(fire_id)?;
        }
        let message_id = input
            .existing_trigger_message_id
            .clone()
            .unwrap_or_else(|| format!("msg-{}", random_hex(16)));
        self.with_connection(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        let conversation_exists = transaction
            .query_row(
                "SELECT 1 FROM ai_conversation WHERE id=?1",
                [&input.conversation_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
            .is_some();
        if !conversation_exists {
            return Err(RunLedgerError::new("agent-run-conversation-unavailable"));
        }
        let active: u32 = transaction
            .query_row(
                "SELECT COUNT(*) FROM ai_run
                 WHERE status IN ('queued','running','planning','gathering','synthesizing','awaiting-approval')",
                [],
                |row| row.get(0),
            )
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        if active > 0 {
            return Err(RunLedgerError::new("agent-engine-busy"));
        }
        if let Some(restart_of) = input.restart_of.as_deref() {
            let old_status = transaction
                .query_row(
                    "SELECT status FROM ai_run WHERE id=?1",
                    [restart_of],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
                .ok_or_else(|| RunLedgerError::new("agent-run-not-found"))?;
            if !TERMINAL_STATUSES.contains(&old_status.as_str()) {
                return Err(RunLedgerError::new("agent-run-not-terminal"));
            }
            let chain_depth: u32 = transaction
                .query_row(
                    "WITH RECURSIVE chain(id, depth) AS (
                        SELECT ?1, 1
                        UNION ALL
                        SELECT r.restart_of_run_id, chain.depth + 1
                        FROM ai_run r JOIN chain ON r.id = chain.id
                        WHERE r.restart_of_run_id IS NOT NULL AND chain.depth < 9
                     ) SELECT MAX(depth) FROM chain",
                    [restart_of],
                    |row| row.get(0),
                )
                .unwrap_or(1);
            if chain_depth >= 8 {
                return Err(RunLedgerError::new("agent-run-restart-limit"));
            }
        }
        if input.existing_trigger_message_id.is_some() {
            let stored: Option<String> = transaction
                .query_row(
                    "SELECT content FROM ai_message
                     WHERE id=?1 AND conversation_id=?2 AND role='user'",
                    params![message_id, input.conversation_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if stored.as_deref() != Some(input.user_content.as_str()) {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
        } else {
            transaction
                .execute(
                    "INSERT INTO ai_message(id,conversation_id,role,content,created_at)
                     VALUES (?1,?2,'user',?3,?4)",
                    params![message_id, input.conversation_id, input.user_content, now],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        }
        if let Some(fire_id) = input.schedule_fire_id.as_deref() {
            let linked = transaction
                .execute(
                    "UPDATE agent_schedule_fire
                     SET state='running',run_id=?2,updated_at=?3
                     WHERE id=?1 AND state='starting' AND run_id IS NULL",
                    params![fire_id, run_id, now],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if linked != 1 {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            transaction
                .execute(
                    "UPDATE agent_schedule
                     SET last_run_id=?2,last_safe_code=NULL,updated_at=?3
                     WHERE id=(SELECT schedule_id FROM agent_schedule_fire WHERE id=?1)",
                    params![fire_id, run_id, now],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        }
        transaction
            .execute(
                "INSERT INTO ai_run(
                    id,conversation_id,trigger_message_id,kind,execution_mode,policy_id,
                    status,phase,restart_of_run_id,vault_binding_digest,created_at,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,'queued','queued',?7,?8,?9,?9)",
                params![
                    run_id,
                    input.conversation_id,
                    message_id,
                    input.kind.as_str(),
                    input.execution_mode.as_str(),
                    input.policy_id,
                    input.restart_of,
                    input.vault_binding_digest,
                    now
                ],
            )
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        transaction
            .execute(
                "UPDATE ai_conversation SET updated_at=?2 WHERE id=?1",
                params![input.conversation_id, now],
            )
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        transaction
            .commit()
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        Ok(())
        })?;
        Ok(AdmittedRun { run_id, lease })
    }

    pub(crate) fn mark_running(
        &self,
        run_id: &str,
        phase: &str,
    ) -> Result<DurableRunSnapshot, RunLedgerError> {
        validate_id(run_id)?;
        validate_safe_label(phase)?;
        #[cfg(test)]
        if self.fail_next_mark_running.swap(false, Ordering::AcqRel) {
            return Err(RunLedgerError::new("agent-run-ledger-unavailable"));
        }
        let now = chrono::Utc::now().to_rfc3339();
        self.with_connection(|connection| {
            let updated = connection
            .execute(
                "UPDATE ai_run SET status='running',phase=?2,started_at=COALESCE(started_at,?3),
                    updated_at=?3,version=version+1
                 WHERE id=?1 AND status='queued'",
                params![run_id, phase, now],
            )
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if updated != 1 {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            query_run(connection, run_id)?.ok_or_else(|| RunLedgerError::new("agent-run-not-found"))
        })
    }

    pub(crate) fn publish_progress(
        &self,
        run_id: &str,
        progress: DurableRunProgress,
    ) -> Result<DurableRunSnapshot, RunLedgerError> {
        validate_id(run_id)?;
        validate_safe_label(&progress.phase)?;
        let now = chrono::Utc::now().to_rfc3339();
        let status = if progress.awaiting_approval {
            "awaiting-approval"
        } else {
            "running"
        };
        self.with_connection(|connection| {
        let updated = connection
            .execute(
                "UPDATE ai_run SET status=?2,phase=?3,partial=?4,model_used=?5,tool_used=?6,
                    source_count=?7,candidate_count=?8,elapsed_ms=?9,updated_at=?10,version=version+1
                 WHERE id=?1
                   AND status NOT IN ('completed','partial','failed','cancelled','aborted','interrupted')
                   AND (
                     status<>?2 OR phase<>?3 OR partial<>?4 OR model_used<>?5 OR tool_used<>?6
                     OR source_count<>?7 OR candidate_count<>?8 OR elapsed_ms<>?9
                   )",
                params![
                    run_id,
                    status,
                    progress.phase,
                    progress.partial as i64,
                    progress.model_used,
                    progress.tool_used,
                    progress.source_count,
                    progress.candidate_count,
                    progress.elapsed_ms,
                    now,
                ],
            )
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        if updated == 0 {
            let current = query_run(&connection, run_id)?
                .ok_or_else(|| RunLedgerError::new("agent-run-not-found"))?;
            if TERMINAL_STATUSES.contains(&current.status.as_str()) {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
        }
        query_run(connection, run_id)?
            .ok_or_else(|| RunLedgerError::new("agent-run-not-found"))
        })
    }

    pub(crate) fn record_source(
        &self,
        run_id: &str,
        source: DurableRunSource,
    ) -> Result<(), RunLedgerError> {
        validate_id(run_id)?;
        validate_id(&source.reference_label)?;
        validate_id(&source.source_token)?;
        validate_safe_label(&source.kind)?;
        if let Some(host) = source.host.as_deref() {
            validate_safe_host(host)?;
        }
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let status = transaction
                .query_row("SELECT status FROM ai_run WHERE id=?1", [run_id], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
                .ok_or_else(|| RunLedgerError::new("agent-run-not-found"))?;
            if TERMINAL_STATUSES.contains(&status.as_str()) {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            let existing = transaction
                .query_row(
                    "SELECT reference_label,kind,host FROM ai_run_source
                 WHERE run_id=?1 AND source_token=?2",
                    params![run_id, source.source_token],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if let Some(existing) = existing {
                if existing
                    != (
                        source.reference_label.clone(),
                        source.kind.clone(),
                        source.host.clone(),
                    )
                {
                    return Err(RunLedgerError::new("agent-run-source-collision"));
                }
                transaction
                    .commit()
                    .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
                return Ok(());
            }
            let count: u32 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM ai_run_source WHERE run_id=?1",
                    [run_id],
                    |row| row.get(0),
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if count >= MAX_SOURCES_PER_RUN {
                return Err(RunLedgerError::new("agent-run-source-capacity"));
            }
            transaction
                .execute(
                    "INSERT INTO ai_run_source(
                    run_id,ordinal,reference_label,source_token,kind,host,retained,cited
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        run_id,
                        count + 1,
                        source.reference_label,
                        source.source_token,
                        source.kind,
                        source.host,
                        source.retained as i64,
                        source.cited as i64,
                    ],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .execute(
                    "UPDATE ai_run SET source_count=?2,version=version+1 WHERE id=?1",
                    params![run_id, count + 1],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .commit()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(())
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn prepare_artifact(
        &self,
        run_id: &str,
        public_token: &str,
        entity_kind: &str,
        entity_ref: &str,
        operation_digest: &str,
        expected_revision: Option<&str>,
        planned_revision: &str,
        display_name: &str,
    ) -> Result<String, RunLedgerError> {
        validate_id(run_id)?;
        validate_id(public_token)?;
        validate_safe_label(entity_kind)?;
        validate_digest(operation_digest)?;
        validate_internal_ref(entity_ref)?;
        validate_optional_revision(expected_revision)?;
        validate_optional_revision(Some(planned_revision))?;
        validate_display_name(display_name)?;
        let now = chrono::Utc::now().to_rfc3339();
        let artifact_id = format!("artifact-{}", random_hex(16));
        self.with_connection(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        let count: u32 = transaction
            .query_row(
                "SELECT COUNT(*) FROM ai_run_artifact WHERE run_id=?1",
                [run_id],
                |row| row.get(0),
            )
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        if count >= MAX_ARTIFACTS_PER_RUN {
            return Err(RunLedgerError::new("agent-run-artifact-capacity"));
        }
        transaction
            .execute(
                "INSERT INTO ai_run_artifact(
                    id,run_id,public_token,entity_kind,entity_ref,operation_digest,
                    expected_revision,new_revision,receipt_state,display_name,status,created_at,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'prepared',?9,'prepared',?10,?10)",
                params![
                    artifact_id,
                    run_id,
                    public_token,
                    entity_kind,
                    entity_ref,
                    operation_digest,
                    expected_revision,
                    planned_revision,
                    display_name,
                    now,
                ],
            )
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        transaction
            .commit()
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        Ok(artifact_id)
        })
    }

    pub(crate) fn transition_canvas_artifact_stage(
        &self,
        artifact_id: &str,
        canvas_id: &str,
        next_stage: &str,
        material_id: Option<&str>,
        output_digest: Option<&str>,
    ) -> Result<(), RunLedgerError> {
        validate_id(artifact_id)?;
        validate_id(canvas_id)?;
        if let Some(material_id) = material_id {
            validate_id(material_id)?;
        }
        if let Some(output_digest) = output_digest {
            validate_digest(output_digest)?;
        }
        if !canvas_artifact_stage(next_stage) {
            return Err(RunLedgerError::new("agent-run-protocol-invalid"));
        }
        let now = chrono::Utc::now().to_rfc3339();
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let (entity_kind, entity_ref, current_stage): (String, String, String) = transaction
                .query_row(
                    "SELECT entity_kind,entity_ref,receipt_state FROM ai_run_artifact WHERE id=?1",
                    [artifact_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(|_| RunLedgerError::new("agent-run-artifact-not-found"))?;
            if entity_kind != "canvas" {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            let mut binding = parse_canvas_artifact_binding(&entity_ref, &current_stage)?;
            if binding.canvas_id != canvas_id {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            if current_stage == next_stage {
                if material_id.is_some_and(|value| binding.material_id.as_deref() != Some(value))
                    || output_digest
                        .is_some_and(|value| binding.output_digest.as_deref() != Some(value))
                {
                    return Err(RunLedgerError::new("agent-run-state-conflict"));
                }
                transaction
                    .commit()
                    .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
                return Ok(());
            }
            if !canvas_artifact_transition(&current_stage, next_stage) {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            binding.stage = next_stage.to_owned();
            if let Some(material_id) = material_id {
                match binding.material_id.as_deref() {
                    Some(current) if current != material_id => {
                        return Err(RunLedgerError::new("agent-run-state-conflict"));
                    }
                    _ => binding.material_id = Some(material_id.to_owned()),
                }
            }
            if let Some(output_digest) = output_digest {
                match binding.output_digest.as_deref() {
                    Some(current) if current != output_digest => {
                        return Err(RunLedgerError::new("agent-run-state-conflict"));
                    }
                    _ => binding.output_digest = Some(output_digest.to_owned()),
                }
            }
            let encoded = serde_json::to_string(&binding)
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            validate_internal_ref(&encoded)?;
            let updated = transaction
                .execute(
                    "UPDATE ai_run_artifact SET entity_ref=?2,receipt_state=?3,updated_at=?4
                     WHERE id=?1 AND receipt_state=?5",
                    params![artifact_id, encoded, next_stage, now, current_stage],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if updated != 1 {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            transaction
                .commit()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(())
        })
    }

    pub(crate) fn commit_artifact(
        &self,
        artifact_id: &str,
        new_revision: &str,
        status: &str,
        display_name: &str,
    ) -> Result<DurableRunArtifact, RunLedgerError> {
        self.commit_artifact_with_action_truth(
            artifact_id,
            new_revision,
            status,
            display_name,
            None,
            None,
        )
    }

    pub(crate) fn commit_artifact_with_action_truth(
        &self,
        artifact_id: &str,
        new_revision: &str,
        status: &str,
        display_name: &str,
        action_truth: Option<DurableArtifactActionTruth>,
        safe_result_summary: Option<&str>,
    ) -> Result<DurableRunArtifact, RunLedgerError> {
        validate_id(artifact_id)?;
        validate_optional_revision(Some(new_revision))?;
        if !matches!(status, "committed" | "committed-warning") {
            return Err(RunLedgerError::new("agent-run-protocol-invalid"));
        }
        validate_display_name(display_name)?;
        if safe_result_summary.is_some_and(|value| {
            value.trim().is_empty() || value.as_bytes().len() > SAFE_TEXT_MAX_BYTES
        }) {
            return Err(RunLedgerError::new("agent-run-protocol-invalid"));
        }
        let now = chrono::Utc::now().to_rfc3339();
        self.with_connection(|connection| {
            let updated = connection
                .execute(
                    "UPDATE ai_run_artifact SET
                    receipt_state=CASE WHEN entity_kind='canvas' THEN 'ledger-committed' ELSE 'committed' END,
                    display_name=?3,status=?4,action_truth=?5,safe_result_summary=?6,updated_at=?7
                 WHERE id=?1
                   AND receipt_state IN ('prepared','canvas-committed')
                   AND new_revision=?2",
                    params![
                        artifact_id,
                        new_revision,
                        display_name,
                        status,
                        action_truth.map(DurableArtifactActionTruth::as_str),
                        safe_result_summary,
                        now
                    ],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if updated != 1 {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            query_artifact(connection, artifact_id)?
                .ok_or_else(|| RunLedgerError::new("agent-run-artifact-not-found"))
        })
    }

    pub(crate) fn mark_artifact_uncertain(&self, artifact_id: &str) -> Result<(), RunLedgerError> {
        validate_id(artifact_id)?;
        let now = chrono::Utc::now().to_rfc3339();
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let (entity_kind, entity_ref, current_stage): (String, String, String) = transaction
                .query_row(
                    "SELECT entity_kind,entity_ref,receipt_state
                     FROM ai_run_artifact WHERE id=?1",
                    [artifact_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(|_| RunLedgerError::new("agent-run-artifact-not-found"))?;
            if entity_kind == "canvas" && current_stage == "prepared" {
                transaction
                    .commit()
                    .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
                return Ok(());
            }
            if matches!(
                current_stage.as_str(),
                "committed" | "ledger-committed" | "provider-uncertain" | "uncertain"
            ) {
                transaction
                    .commit()
                    .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
                return Ok(());
            }
            let next_stage = if current_stage == "provider-requested" {
                "provider-uncertain"
            } else {
                "uncertain"
            };
            let next_status = "interrupted";
            let action_truth = match entity_kind.as_str() {
                "workspace-file" | "workspace-change-set" => {
                    Some(DurableArtifactActionTruth::WorkspaceUncertain.as_str())
                }
                "execution" => Some(DurableArtifactActionTruth::ExecutionUncertain.as_str()),
                _ => None,
            };
            let next_entity_ref = if entity_kind == "canvas" {
                let mut binding = parse_canvas_artifact_binding(&entity_ref, &current_stage)?;
                binding.stage = next_stage.to_owned();
                serde_json::to_string(&binding)
                    .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
            } else {
                entity_ref
            };
            validate_internal_ref(&next_entity_ref)?;
            transaction
                .execute(
                    "UPDATE ai_run_artifact SET
                       entity_ref=?2,receipt_state=?3,status=?4,action_truth=COALESCE(?5,action_truth),updated_at=?6
                     WHERE id=?1 AND receipt_state=?7",
                    params![
                        artifact_id,
                        next_entity_ref,
                        next_stage,
                        next_status,
                        action_truth,
                        now,
                        current_stage
                    ],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .execute(
                    "UPDATE ai_run SET
                     committed_warning=CASE
                       WHEN EXISTS(
                         SELECT 1 FROM ai_run_artifact
                          WHERE id=?1 AND status='committed-warning'
                       ) THEN 1 ELSE committed_warning END,
                     version=version+1,updated_at=?2
                     WHERE id=(SELECT run_id FROM ai_run_artifact WHERE id=?1)",
                    params![artifact_id, now],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .commit()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(())
        })
    }

    /// A workspace handler can prove that its commit linearization point was
    /// never crossed (for example a stale file ref, conflict, revoked grant,
    /// or rejected no-clobber create). Remove the prepared private receipt so
    /// recovery never leaves a user-visible phantom artifact. Unknown
    /// post-dispatch outcomes deliberately use `mark_artifact_uncertain`.
    pub(crate) fn discard_prepared_workspace_artifact(
        &self,
        artifact_id: &str,
    ) -> Result<(), RunLedgerError> {
        validate_id(artifact_id)?;
        self.with_connection(|connection| {
            let changed = connection
                .execute(
                    "DELETE FROM ai_run_artifact
                     WHERE id=?1 AND entity_kind IN ('workspace-file','workspace-change-set')
                       AND receipt_state='prepared'",
                    [artifact_id],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if changed != 1 {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            Ok(())
        })
    }

    /// An execution handler may prove that it did not start the owned process
    /// (for example a stale recipe binding, an expired permit, or a cancelled
    /// request before the spawn boundary).  In that case the prepared private
    /// receipt must not survive as a phantom verification result.  Once spawn
    /// has been attempted, the outcome is deliberately unknown and callers
    /// must use `mark_artifact_uncertain` instead.
    pub(crate) fn discard_prepared_execution_artifact(
        &self,
        artifact_id: &str,
    ) -> Result<(), RunLedgerError> {
        validate_id(artifact_id)?;
        self.with_connection(|connection| {
            let changed = connection
                .execute(
                    "DELETE FROM ai_run_artifact
                     WHERE id=?1 AND entity_kind='execution' AND receipt_state='prepared'",
                    [artifact_id],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if changed != 1 {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            Ok(())
        })
    }

    /// A journal-backed workspace artifact was initially uncertain, then
    /// startup reconciliation proved the original file is restored. Prepared
    /// and uncertain are both private no-write bookkeeping only at this
    /// point; unresolved uncertain outcomes never take this path.
    pub(crate) fn discard_not_committed_workspace_artifact(
        &self,
        artifact_id: &str,
    ) -> Result<(), RunLedgerError> {
        validate_id(artifact_id)?;
        self.with_connection(|connection| {
            let changed = connection
                .execute(
                    "DELETE FROM ai_run_artifact
                     WHERE id=?1 AND entity_kind IN ('workspace-file','workspace-change-set')
                       AND receipt_state IN ('prepared','uncertain')",
                    [artifact_id],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if changed != 1 {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            Ok(())
        })
    }

    pub(crate) fn reconcile_knowledge_artifacts(
        &self,
        knowledge: &KnowledgeService,
    ) -> Result<(), RunLedgerError> {
        let Ok(active_vault_id) = knowledge.current_vault_id() else {
            return Ok(());
        };
        let pending = self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id,run_id,entity_kind,entity_ref,operation_digest,expected_revision,new_revision,receipt_state
                     FROM ai_run_artifact
                     WHERE entity_kind='knowledge' AND receipt_state IN ('prepared','uncertain')",
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let origins = statement
                .query_map([], |row| {
                    Ok(DurableArtifactOrigin {
                        id: row.get(0)?,
                        run_id: row.get(1)?,
                        entity_kind: row.get(2)?,
                        entity_ref: row.get(3)?,
                        operation_digest: row.get(4)?,
                        expected_revision: row.get(5)?,
                        new_revision: row.get(6)?,
                        receipt_state: row.get(7)?,
                    })
                })
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(origins)
        })?;

        for origin in pending {
            let document_ref: KnowledgeDocumentRef = serde_json::from_str(&origin.entity_ref)
                .map_err(|_| RunLedgerError::new("agent-run-artifact-invalid"))?;
            if document_ref.vault_id != active_vault_id {
                continue;
            }
            let current_revision = knowledge
                .read_document(&document_ref)
                .ok()
                .map(|document| document.revision);
            match reconcile_artifact_revision(
                origin.expected_revision.as_deref(),
                origin.new_revision.as_deref(),
                current_revision.as_deref(),
            ) {
                ArtifactReconciliation::Committed => {
                    let revision = origin
                        .new_revision
                        .as_deref()
                        .ok_or_else(|| RunLedgerError::new("agent-run-artifact-invalid"))?;
                    self.reconcile_artifact_committed(&origin.id, revision)?;
                }
                ArtifactReconciliation::NotCommitted => {}
                ArtifactReconciliation::Uncertain => {
                    self.mark_artifact_uncertain(&origin.id)?;
                }
            }
        }
        Ok(())
    }

    pub(crate) fn reconcile_canvas_artifacts(
        &self,
        canvas: &crate::canvas_agent::CanvasAgentService,
    ) -> Result<(), RunLedgerError> {
        let pending = self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id,run_id,entity_kind,entity_ref,operation_digest,expected_revision,new_revision,receipt_state
                     FROM ai_run_artifact
                     WHERE entity_kind='canvas'
                       AND receipt_state NOT IN ('committed','ledger-committed')",
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let origins = statement
                .query_map([], |row| {
                    Ok(DurableArtifactOrigin {
                        id: row.get(0)?,
                        run_id: row.get(1)?,
                        entity_kind: row.get(2)?,
                        entity_ref: row.get(3)?,
                        operation_digest: row.get(4)?,
                        expected_revision: row.get(5)?,
                        new_revision: row.get(6)?,
                        receipt_state: row.get(7)?,
                    })
                })
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(origins)
        })?;

        for origin in pending {
            let binding = parse_canvas_artifact_binding(&origin.entity_ref, &origin.receipt_state)?;
            let expected_revision = origin
                .expected_revision
                .as_deref()
                .ok_or_else(|| RunLedgerError::new("agent-run-artifact-invalid"))?
                .parse::<u64>()
                .map_err(|_| RunLedgerError::new("agent-run-artifact-invalid"))?;
            let planned_revision = origin
                .new_revision
                .as_deref()
                .ok_or_else(|| RunLedgerError::new("agent-run-artifact-invalid"))?
                .parse::<u64>()
                .map_err(|_| RunLedgerError::new("agent-run-artifact-invalid"))?;
            match canvas.reconcile_artifact_with_recorded_identity(
                &binding.canvas_id,
                &origin.operation_digest,
                expected_revision,
                planned_revision,
                binding.material_id.as_deref(),
            ) {
                Ok(crate::canvas_agent::CanvasArtifactReconciliation::Committed) => {
                    self.reconcile_canvas_artifact_committed_warning(
                        &origin.id,
                        &planned_revision.to_string(),
                    )?;
                }
                Ok(crate::canvas_agent::CanvasArtifactReconciliation::NotCommitted) => {
                    match origin.receipt_state.as_str() {
                        "prepared" | "provider-uncertain" | "uncertain" => {}
                        "provider-requested" | "provider-succeeded" | "materializing"
                        | "material-committed" | "canvas-attaching" | "canvas-committed" => {
                            self.mark_artifact_uncertain(&origin.id)?;
                        }
                        _ => return Err(RunLedgerError::new("agent-run-artifact-invalid")),
                    }
                }
                Ok(crate::canvas_agent::CanvasArtifactReconciliation::Uncertain) | Err(_) => {
                    self.mark_artifact_uncertain(&origin.id)?;
                }
            }
        }
        Ok(())
    }

    /// Reconcile workspace artifacts after a crash. Each prepared or
    /// uncertain artifact carries a Backend-only private locator (grant id,
    /// relative path, root digest). The current file digest is re-verified
    /// through the workspace service with full identity/reparse checks:
    /// - file digest equals the planned revision: the file was written, the
    ///   ledger receipt was lost -> project committed-warning, never rewrite.
    /// - file absent or unchanged: nothing was written -> the prepared receipt
    ///   is discarded, never left as a phantom public artifact.
    /// - anything else: uncertain; never project a fake success.
    pub(crate) fn reconcile_workspace_artifacts(
        &self,
        workspace: &crate::agent_workspace::WorkspaceGrantService,
    ) -> Result<(), RunLedgerError> {
        let pending = self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id,run_id,entity_kind,entity_ref,operation_digest,expected_revision,new_revision,receipt_state
                     FROM ai_run_artifact
                     WHERE entity_kind IN ('workspace-file','workspace-change-set')
                       AND receipt_state IN ('prepared','uncertain')",
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let origins = statement
                .query_map([], |row| {
                    Ok(DurableArtifactOrigin {
                        id: row.get(0)?,
                        run_id: row.get(1)?,
                        entity_kind: row.get(2)?,
                        entity_ref: row.get(3)?,
                        operation_digest: row.get(4)?,
                        expected_revision: row.get(5)?,
                        new_revision: row.get(6)?,
                        receipt_state: row.get(7)?,
                    })
                })
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(origins)
        })?;

        for origin in pending {
            if origin.entity_kind == "workspace-change-set" {
                let locator: crate::agent_workspace::WorkspaceChangeSetLocator =
                    serde_json::from_str(&origin.entity_ref)
                        .map_err(|_| RunLedgerError::new("agent-run-artifact-invalid"))?;
                let reconciliation = match workspace.reconcile_change_set(&locator) {
                    Ok(value) => value,
                    Err(_) => crate::agent_workspace::WorkspaceChangeSetReconciliation::Uncertain,
                };
                match reconciliation {
                    result @ (crate::agent_workspace::WorkspaceChangeSetReconciliation::Committed
                    | crate::agent_workspace::WorkspaceChangeSetReconciliation::Partial) => {
                        let revision = origin
                            .new_revision
                            .as_deref()
                            .ok_or_else(|| RunLedgerError::new("agent-run-artifact-invalid"))?;
                        let action_truth = match result {
                            crate::agent_workspace::WorkspaceChangeSetReconciliation::Committed => {
                                DurableArtifactActionTruth::WorkspaceVerified
                            }
                            crate::agent_workspace::WorkspaceChangeSetReconciliation::Partial => {
                                DurableArtifactActionTruth::WorkspacePartial
                            }
                            _ => unreachable!(),
                        };
                        self.reconcile_workspace_artifact_committed_warning(
                            &origin.id,
                            revision,
                            action_truth,
                        )?;
                    }
                    crate::agent_workspace::WorkspaceChangeSetReconciliation::NotCommitted => {
                        self.discard_not_committed_workspace_artifact(&origin.id)?;
                    }
                    crate::agent_workspace::WorkspaceChangeSetReconciliation::Uncertain => {
                        self.mark_artifact_uncertain(&origin.id)?;
                    }
                }
                continue;
            }
            let locator: crate::agent_workspace::WorkspaceWriteLocator =
                serde_json::from_str(&origin.entity_ref)
                    .map_err(|_| RunLedgerError::new("agent-run-artifact-invalid"))?;
            let reconciliation = match workspace.reconcile_digest(&locator) {
                Ok(current_digest) => reconcile_artifact_revision(
                    origin.expected_revision.as_deref(),
                    origin.new_revision.as_deref(),
                    current_digest.as_deref(),
                ),
                // A changed/revoked root, unsafe reparse path, malformed
                // locator, or unreadable recovery journal makes the post-crash
                // outcome unknown. Never treat it as a no-write result.
                Err(_) => ArtifactReconciliation::Uncertain,
            };
            match reconciliation {
                ArtifactReconciliation::Committed => {
                    let revision = origin
                        .new_revision
                        .as_deref()
                        .ok_or_else(|| RunLedgerError::new("agent-run-artifact-invalid"))?;
                    self.reconcile_workspace_artifact_committed_warning(
                        &origin.id,
                        revision,
                        DurableArtifactActionTruth::WorkspaceVerified,
                    )?;
                }
                ArtifactReconciliation::NotCommitted => {
                    self.discard_not_committed_workspace_artifact(&origin.id)?;
                }
                ArtifactReconciliation::Uncertain => {
                    self.mark_artifact_uncertain(&origin.id)?;
                }
            }
        }
        Ok(())
    }

    /// A process owned by the previous application instance is terminated by
    /// the Windows Job when that instance exits.  A prepared execution receipt
    /// therefore has no trustworthy terminal outcome after startup: never
    /// replay its command, and retain the private locator as an uncertain
    /// receipt for an honest user-visible warning/retry path.
    pub(crate) fn reconcile_execution_artifacts(&self) -> Result<(), RunLedgerError> {
        let prepared_ids = self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id FROM ai_run_artifact
                     WHERE entity_kind='execution' AND receipt_state='prepared'",
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))
        })?;
        for artifact_id in prepared_ids {
            self.mark_artifact_uncertain(&artifact_id)?;
        }
        Ok(())
    }

    fn reconcile_workspace_artifact_committed_warning(
        &self,
        artifact_id: &str,
        revision: &str,
        action_truth: DurableArtifactActionTruth,
    ) -> Result<(), RunLedgerError> {
        validate_id(artifact_id)?;
        validate_optional_revision(Some(revision))?;
        let now = chrono::Utc::now().to_rfc3339();
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let updated = transaction
                .execute(
                    "UPDATE ai_run_artifact SET receipt_state='committed',
                       status='committed-warning',action_truth=?3,updated_at=?4
                     WHERE id=?1 AND entity_kind IN ('workspace-file','workspace-change-set') AND new_revision=?2
                       AND receipt_state IN ('prepared','uncertain')",
                    params![artifact_id, revision, action_truth.as_str(), now],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if updated != 1 {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            transaction
                .execute(
                    "UPDATE ai_run SET committed_warning=1,version=version+1,updated_at=?2
                     WHERE id=(SELECT run_id FROM ai_run_artifact WHERE id=?1)",
                    params![artifact_id, now],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .commit()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(())
        })
    }

    fn reconcile_canvas_artifact_committed_warning(
        &self,
        artifact_id: &str,
        revision: &str,
    ) -> Result<(), RunLedgerError> {
        validate_id(artifact_id)?;
        validate_optional_revision(Some(revision))?;
        let now = chrono::Utc::now().to_rfc3339();
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let updated = transaction
                .execute(
                    "UPDATE ai_run_artifact SET receipt_state='ledger-committed',
                       status='committed-warning',updated_at=?3
                     WHERE id=?1 AND entity_kind='canvas' AND new_revision=?2
                       AND receipt_state NOT IN ('committed','ledger-committed')",
                    params![artifact_id, revision, now],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            if updated != 1 {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            transaction
                .execute(
                    "UPDATE ai_run SET committed_warning=1,version=version+1,updated_at=?2
                     WHERE id=(SELECT run_id FROM ai_run_artifact WHERE id=?1)",
                    params![artifact_id, now],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .commit()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(())
        })
    }

    fn reconcile_artifact_committed(
        &self,
        artifact_id: &str,
        revision: &str,
    ) -> Result<(), RunLedgerError> {
        validate_id(artifact_id)?;
        validate_optional_revision(Some(revision))?;
        let now = chrono::Utc::now().to_rfc3339();
        self.with_connection(|connection| {
            connection
                .execute(
                    "UPDATE ai_run_artifact SET receipt_state=CASE
                       WHEN entity_kind='canvas' THEN 'ledger-committed' ELSE 'committed' END,
                       status='committed',
                     updated_at=?3 WHERE id=?1 AND new_revision=?2
                     AND receipt_state NOT IN ('committed','ledger-committed')",
                    params![artifact_id, revision, now],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(())
        })
    }

    pub(crate) fn artifact_origin(
        &self,
        public_token: &str,
    ) -> Result<DurableArtifactOrigin, RunLedgerError> {
        validate_id(public_token)?;
        self.with_connection(|connection| {
        connection
            .query_row(
                "SELECT id,run_id,entity_kind,entity_ref,operation_digest,expected_revision,new_revision,receipt_state
                 FROM ai_run_artifact WHERE public_token=?1",
                [public_token],
                |row| {
                    Ok(DurableArtifactOrigin {
                        id: row.get(0)?,
                        run_id: row.get(1)?,
                        entity_kind: row.get(2)?,
                        entity_ref: row.get(3)?,
                        operation_digest: row.get(4)?,
                        expected_revision: row.get(5)?,
                        new_revision: row.get(6)?,
                        receipt_state: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
            .ok_or_else(|| RunLedgerError::new("agent-run-artifact-not-found"))
        })
    }

    pub(crate) fn list_sources(
        &self,
        run_id: &str,
    ) -> Result<Vec<DurableRunSource>, RunLedgerError> {
        validate_id(run_id)?;
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT reference_label,source_token,kind,host,retained,cited
                 FROM ai_run_source WHERE run_id=?1 ORDER BY ordinal",
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let items = statement
                .query_map([run_id], |row| {
                    Ok(DurableRunSource {
                        reference_label: row.get(0)?,
                        source_token: row.get(1)?,
                        kind: row.get(2)?,
                        host: row.get(3)?,
                        retained: row.get::<_, i64>(4)? != 0,
                        cited: row.get::<_, i64>(5)? != 0,
                    })
                })
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(items)
        })
    }

    pub(crate) fn list_artifacts(
        &self,
        run_id: &str,
    ) -> Result<Vec<DurableRunArtifact>, RunLedgerError> {
        validate_id(run_id)?;
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT public_token,display_name,status,receipt_state
                 FROM ai_run_artifact WHERE run_id=?1 ORDER BY created_at",
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let items = statement
                .query_map([run_id], |row| {
                    Ok(DurableRunArtifact {
                        id: row.get(0)?,
                        display_name: row.get(1)?,
                        status: row.get(2)?,
                        receipt_state: row.get(3)?,
                    })
                })
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(items)
        })
    }

    /// Persists the first Backend-accepted stop cause for an active run. This
    /// is intent, not a terminal settlement; the worker observation and all
    /// durable effect facts are reduced later by `settle` in one transaction.
    pub(crate) fn record_stop_cause(
        &self,
        run_id: &str,
        requested: RunStopCause,
    ) -> Result<RunStopCause, RunLedgerError> {
        validate_id(run_id)?;
        let now = chrono::Utc::now().to_rfc3339();
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let current: Option<(String, Option<String>)> = transaction
                .query_row(
                    "SELECT status,stop_cause FROM ai_run WHERE id=?1",
                    [run_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let (status, existing) =
                current.ok_or_else(|| RunLedgerError::new("agent-run-not-found"))?;
            if TERMINAL_STATUSES.contains(&status.as_str()) {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            let accepted = match existing {
                Some(value) => RunStopCause::parse(&value)?,
                None => {
                    let updated = transaction
                        .execute(
                            "UPDATE ai_run SET stop_cause=?2,
                                stop_transport=COALESCE(stop_transport,'unknown'),
                                updated_at=?3,version=version+1
                             WHERE id=?1 AND stop_cause IS NULL
                               AND status NOT IN ('completed','partial','failed','cancelled','aborted','interrupted')",
                            params![run_id, requested.as_str(), now],
                        )
                        .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
                    if updated != 1 {
                        return Err(RunLedgerError::new("agent-run-state-conflict"));
                    }
                    requested
                }
            };
            transaction
                .commit()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(accepted)
        })
    }

    /// Persists the first concrete transport observation for an already
    /// accepted stop intent. This fact is Backend-only and monotonic; it is
    /// consumed by the same terminal reducer after a crash or retry.
    pub(crate) fn record_stop_transport(
        &self,
        run_id: &str,
        observed: StopTransportObservation,
    ) -> Result<StopTransportObservation, RunLedgerError> {
        validate_id(run_id)?;
        let value = observed
            .as_durable_str()
            .ok_or_else(|| RunLedgerError::new("agent-run-state-conflict"))?;
        if value == "unknown" {
            return Err(RunLedgerError::new("agent-run-state-conflict"));
        }
        let now = chrono::Utc::now().to_rfc3339();
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let current: Option<(String, Option<String>, Option<String>)> = transaction
                .query_row(
                    "SELECT status,stop_cause,stop_transport FROM ai_run WHERE id=?1",
                    [run_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let (status, cause, existing) =
                current.ok_or_else(|| RunLedgerError::new("agent-run-not-found"))?;
            if TERMINAL_STATUSES.contains(&status.as_str()) || cause.is_none() {
                return Err(RunLedgerError::new("agent-run-state-conflict"));
            }
            let accepted = match existing.as_deref() {
                Some("acknowledged") => StopTransportObservation::Acknowledged,
                Some("failed") => StopTransportObservation::Failed,
                Some("unknown") | None => {
                    let updated = transaction
                        .execute(
                            "UPDATE ai_run SET stop_transport=?2,updated_at=?3,version=version+1
                             WHERE id=?1 AND stop_cause IS NOT NULL
                               AND (stop_transport IS NULL OR stop_transport='unknown')
                               AND status NOT IN ('completed','partial','failed','cancelled','aborted','interrupted')",
                            params![run_id, value, now],
                        )
                        .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
                    if updated != 1 {
                        return Err(RunLedgerError::new("agent-run-state-conflict"));
                    }
                    observed
                }
                Some(_) => return Err(RunLedgerError::new("agent-run-state-conflict")),
            };
            transaction
                .commit()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(accepted)
        })
    }

    pub(crate) fn settle(
        &self,
        run_id: &str,
        terminal: RunTerminal,
    ) -> Result<DurableRunSnapshot, RunLedgerError> {
        validate_id(run_id)?;
        #[cfg(test)]
        if self
            .fail_next_settles
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                (remaining > 0).then(|| remaining - 1)
            })
            .is_ok()
        {
            return Err(RunLedgerError::new("agent-run-ledger-unavailable"));
        }
        let now = chrono::Utc::now().to_rfc3339();
        let result = self.with_connection(|connection| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        let current = query_run(&transaction, run_id)?
            .ok_or_else(|| RunLedgerError::new("agent-run-not-found"))?;
        if TERMINAL_STATUSES.contains(&current.status.as_str()) {
            transaction
                .commit()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            return Ok(current);
        }
        let terminal = match terminal {
            RunTerminal::Agent(proposal) => {
                reduce_agent_terminal(&transaction, run_id, proposal)?
            }
            terminal => terminal,
        };
        let (
            status,
            partial,
            safe_code,
            terminal_committed_warning,
            assistant_content,
            action_truth,
        ) = match terminal {
            RunTerminal::Completed {
                assistant_content,
                partial,
                cited_references,
                action_truth,
            } => {
                if assistant_content.trim().is_empty() || assistant_content.as_bytes().len() > SAFE_TEXT_MAX_BYTES {
                    return Err(RunLedgerError::new("agent-run-protocol-invalid"));
                }
                (
                    if partial { "partial" } else { "completed" },
                    partial,
                    None,
                    false,
                    Some((assistant_content, cited_references)),
                    action_truth,
                )
            }
            RunTerminal::Failed {
                code,
                committed_warning,
            } => ("failed", false, Some(code), committed_warning, None, None),
            RunTerminal::FailedWithResult {
                code,
                assistant_content,
                committed_warning,
                action_truth,
            } => {
                if assistant_content.trim().is_empty()
                    || assistant_content.as_bytes().len() > SAFE_TEXT_MAX_BYTES
                {
                    return Err(RunLedgerError::new("agent-run-protocol-invalid"));
                }
                (
                    "failed",
                    false,
                    Some(code),
                    committed_warning,
                    Some((assistant_content, Vec::new())),
                    action_truth,
                )
            }
            RunTerminal::FailedWithCommittedResult {
                code,
                assistant_content,
                action_truth,
            } => {
                if assistant_content.trim().is_empty()
                    || assistant_content.as_bytes().len() > SAFE_TEXT_MAX_BYTES
                {
                    return Err(RunLedgerError::new("agent-run-protocol-invalid"));
                }
                (
                    "failed",
                    false,
                    Some(code),
                    true,
                    Some((assistant_content, Vec::new())),
                    action_truth,
                )
            }
            RunTerminal::CancelledWithCommittedResult {
                assistant_content,
                action_truth,
            } => {
                if assistant_content.trim().is_empty()
                    || assistant_content.as_bytes().len() > SAFE_TEXT_MAX_BYTES
                {
                    return Err(RunLedgerError::new("agent-run-protocol-invalid"));
                }
                (
                    "cancelled",
                    false,
                    Some("agent-engine-cancelled".to_owned()),
                    true,
                    Some((assistant_content, Vec::new())),
                    action_truth,
                )
            }
            RunTerminal::AbortedWithCommittedResult {
                assistant_content,
                action_truth,
            } => {
                if assistant_content.trim().is_empty()
                    || assistant_content.as_bytes().len() > SAFE_TEXT_MAX_BYTES
                {
                    return Err(RunLedgerError::new("agent-run-protocol-invalid"));
                }
                (
                    "aborted",
                    false,
                    Some("agent-engine-aborted".to_owned()),
                    true,
                    Some((assistant_content, Vec::new())),
                    action_truth,
                )
            }
            RunTerminal::InterruptedWithCommittedResult {
                assistant_content,
                action_truth,
            } => {
                if assistant_content.trim().is_empty()
                    || assistant_content.as_bytes().len() > SAFE_TEXT_MAX_BYTES
                {
                    return Err(RunLedgerError::new("agent-run-protocol-invalid"));
                }
                (
                    "interrupted",
                    false,
                    Some("agent-run-app-restarted".to_owned()),
                    true,
                    Some((assistant_content, Vec::new())),
                    action_truth,
                )
            }
            RunTerminal::Cancelled { action_truth } => (
                "cancelled",
                false,
                Some("agent-engine-cancelled".to_owned()),
                false,
                Some(("Agent 已停止".to_owned(), Vec::new())),
                action_truth,
            ),
            RunTerminal::Aborted { action_truth } => (
                "aborted",
                false,
                Some("agent-engine-aborted".to_owned()),
                false,
                Some(("Agent 已安全终止".to_owned(), Vec::new())),
                action_truth,
            ),
            RunTerminal::Interrupted { action_truth } => (
                "interrupted",
                false,
                Some("agent-run-app-restarted".to_owned()),
                false,
                Some(("Agent 运行已中断；不会自动重试。".to_owned(), Vec::new())),
                action_truth,
            ),
            RunTerminal::Agent(_) => unreachable!("Agent proposals are reduced above"),
        };
        let committed_warning = current.committed_warning || terminal_committed_warning;
        let result_message_id = assistant_content
            .as_ref()
            .map(|_| format!("msg-{}", random_hex(16)));
        if let (Some(message_id), Some((content, cited_references))) =
            (&result_message_id, &assistant_content)
        {
            if cited_references.len() > MAX_SOURCES_PER_RUN as usize {
                return Err(RunLedgerError::new("agent-run-protocol-invalid"));
            }
            for reference in cited_references {
                validate_id(reference)?;
                transaction
                    .execute(
                        "UPDATE ai_run_source SET cited=1
                         WHERE run_id=?1 AND reference_label=?2 AND retained=1",
                        params![run_id, reference],
                    )
                    .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            }
            transaction
                .execute(
                    "INSERT INTO ai_message(id,conversation_id,role,content,created_at)
                     VALUES (?1,?2,'assistant',?3,?4)",
                    params![message_id, current.conversation_id, content, now],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .execute(
                    "UPDATE ai_conversation SET updated_at=?2 WHERE id=?1",
                    params![current.conversation_id, now],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        }
        let updated = transaction
            .execute(
                "UPDATE ai_run SET result_message_id=?2,status=?3,phase=?3,partial=?4,
                    safe_code=?5,committed_warning=?6,updated_at=?7,terminal_at=?7,version=version+1
                 WHERE id=?1 AND version=?8
                   AND status NOT IN ('completed','partial','failed','cancelled','aborted','interrupted')",
                params![
                    run_id,
                    result_message_id,
                    status,
                    partial as i64,
                    safe_code,
                    committed_warning as i64,
                    now,
                    current.version
                ],
            )
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        if updated != 1 {
            return Err(RunLedgerError::new("agent-run-state-conflict"));
        }
        if let (Some(message_id), Some(action_truth)) = (&result_message_id, action_truth) {
            transaction
                .execute(
                    "INSERT INTO ai_message_action_truth(
                         message_id,workspace_status,execution_status,created_at
                     ) VALUES (?1,?2,?3,?4)",
                    params![
                        message_id,
                        action_truth.workspace.as_str(),
                        action_truth.execution.as_str(),
                        now
                    ],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        }
        transaction
            .commit()
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        query_run(connection, run_id)?
            .ok_or_else(|| RunLedgerError::new("agent-run-not-found"))
        });
        if result.is_ok() {
            self.release_runtime_owner(run_id);
        }
        result
    }

    pub(crate) fn reconcile_startup_terminals(&self) -> Result<u32, RunLedgerError> {
        let active_ids = self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id FROM ai_run
                     WHERE status IN ('queued','running','planning','gathering','synthesizing','awaiting-approval')
                     ORDER BY created_at",
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(ids)
        })?;
        let mut updated = 0_u32;
        for run_id in active_ids {
            self.settle(
                &run_id,
                RunTerminal::Agent(AgentTerminalProposal {
                    observed: AgentObservedTerminal::Interrupted,
                    assistant_content: None,
                    partial: false,
                    cited_references: Vec::new(),
                    receipt_summary: None,
                    action_truth: None,
                }),
            )?;
            updated = updated.saturating_add(1);
        }
        let mut runtime = self
            .runtime
            .state
            .lock()
            .unwrap_or_else(|value| value.into_inner());
        if let Some(owner) = runtime.owner.take() {
            owner.cancelled.store(true, Ordering::SeqCst);
        }
        self.runtime.changed.notify_all();
        Ok(updated)
    }

    pub(crate) fn get(&self, run_id: &str) -> Result<DurableRunSnapshot, RunLedgerError> {
        validate_id(run_id)?;
        self.with_connection(|connection| {
            query_run(connection, run_id)?.ok_or_else(|| RunLedgerError::new("agent-run-not-found"))
        })
    }

    pub(crate) fn list(&self, limit: u32) -> Result<Vec<DurableRunSnapshot>, RunLedgerError> {
        let limit = limit.clamp(1, 100);
        self.with_connection(|connection| {
        let mut statement = connection
            .prepare(
                "SELECT id,conversation_id,trigger_message_id,result_message_id,kind,execution_mode,
                        policy_id,status,phase,partial,model_used,tool_used,source_count,candidate_count,
                        elapsed_ms,safe_code,committed_warning,restart_of_run_id,created_at,started_at,
                        updated_at,terminal_at,version
                 FROM ai_run ORDER BY created_at DESC LIMIT ?1",
            )
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        let items = statement
            .query_map([limit], map_run)
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
        Ok(items)
        })
    }

    pub(crate) fn list_details(
        &self,
        limit: u32,
    ) -> Result<Vec<DurableRunDetails>, RunLedgerError> {
        self.list(limit)?
            .into_iter()
            .map(|run| {
                let run_id = run.id.clone();
                Ok(DurableRunDetails {
                    run,
                    sources: self.list_sources(&run_id)?,
                    artifacts: self.list_artifacts(&run_id)?,
                })
            })
            .collect()
    }

    pub(crate) fn cleanup_retention(&self) -> Result<u32, RunLedgerError> {
        const TERMINAL_LIMIT: usize = 500;
        const CONVERSATION_LIMIT: usize = 100;
        const PAYLOAD_LIMIT: usize = 16 * 1024 * 1024;
        let completed_cutoff = (chrono::Utc::now() - chrono::Duration::days(90)).to_rfc3339();
        let failed_cutoff = (chrono::Utc::now() - chrono::Duration::days(30)).to_rfc3339();
        self.with_connection(|connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .execute(
                    "CREATE TEMP TABLE IF NOT EXISTS lr_run_cleanup(id TEXT PRIMARY KEY)",
                    [],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .execute("DELETE FROM lr_run_cleanup", [])
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO lr_run_cleanup
                     SELECT id FROM ai_run
                     WHERE (status IN ('completed','partial') AND terminal_at < ?1)
                        OR (status IN ('failed','cancelled','aborted','interrupted') AND terminal_at < ?2)",
                    params![completed_cutoff, failed_cutoff],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            let mut terminal = {
                let mut statement = transaction
                    .prepare(
                        "SELECT id,conversation_id,
                                length(id)+length(conversation_id)+length(trigger_message_id)+
                                length(COALESCE(result_message_id,''))+length(kind)+length(phase)+
                                length(COALESCE(safe_code,''))+length(COALESCE(restart_of_run_id,''))+
                                COALESCE((
                                  SELECT SUM(
                                    length(reference_label)+length(source_token)+length(kind)+
                                    length(COALESCE(host,''))
                                  ) FROM ai_run_source WHERE run_id=ai_run.id
                                ),0)+
                                COALESCE((
                                  SELECT SUM(
                                    length(id)+length(public_token)+length(entity_kind)+
                                    length(entity_ref)+length(operation_digest)+
                                    length(COALESCE(expected_revision,''))+
                                    length(COALESCE(new_revision,''))+length(receipt_state)+
                                    length(display_name)+length(status)
                                  ) FROM ai_run_artifact WHERE run_id=ai_run.id
                                ),0),
                                terminal_at
                         FROM ai_run
                         WHERE terminal_at IS NOT NULL
                         ORDER BY terminal_at DESC",
                    )
                    .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?.max(0) as usize,
                            row.get::<_, String>(3)?,
                        ))
                    })
                    .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
                rows
            };
            let mut per_conversation = std::collections::HashMap::<String, usize>::new();
            let mut payload = 0usize;
            for (index, (id, conversation_id, row_bytes, _)) in terminal.drain(..).enumerate() {
                let conversation_count = per_conversation
                    .entry(conversation_id)
                    .and_modify(|count| *count += 1)
                    .or_insert(1);
                payload = payload.saturating_add(row_bytes);
                if index >= TERMINAL_LIMIT
                    || *conversation_count > CONVERSATION_LIMIT
                    || payload > PAYLOAD_LIMIT
                {
                    transaction
                        .execute("INSERT OR IGNORE INTO lr_run_cleanup(id) VALUES (?1)", [id])
                        .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
                }
            }
            let count: u32 = transaction
                .query_row("SELECT COUNT(*) FROM lr_run_cleanup", [], |row| row.get(0))
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .execute(
                    "DELETE FROM ai_run_source WHERE run_id IN (SELECT id FROM lr_run_cleanup)",
                    [],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .execute(
                    "DELETE FROM ai_run_artifact WHERE run_id IN (SELECT id FROM lr_run_cleanup)",
                    [],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .execute(
                    "DELETE FROM ai_run WHERE id IN (SELECT id FROM lr_run_cleanup)",
                    [],
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            transaction
                .commit()
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))?;
            Ok(count)
        })
    }

    pub(crate) fn restart_spec(&self, run_id: &str) -> Result<RestartSpec, RunLedgerError> {
        let snapshot = self.get(run_id)?;
        if !TERMINAL_STATUSES.contains(&snapshot.status.as_str()) {
            return Err(RunLedgerError::new("agent-run-not-terminal"));
        }
        let input = self.with_connection(|connection| {
            connection
            .query_row(
                "SELECT content FROM ai_message WHERE id=?1 AND conversation_id=?2 AND role='user'",
                params![snapshot.trigger_message_id, snapshot.conversation_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))
        })?;
        Ok(RestartSpec {
            conversation_id: snapshot.conversation_id,
            input,
            kind: if snapshot.kind == "research" {
                RunKind::Research
            } else {
                RunKind::Agent
            },
            policy_id: snapshot.policy_id,
            execution_mode: if snapshot.execution_mode == "background" {
                RunExecutionMode::Background
            } else {
                RunExecutionMode::Foreground
            },
            restart_of: snapshot.id,
            trigger_message_id: snapshot.trigger_message_id,
        })
    }

    #[cfg(test)]
    fn message_count(&self, conversation_id: &str, role: &str) -> u32 {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM ai_message WHERE conversation_id=?1 AND role=?2",
                    params![conversation_id, role],
                    |row| row.get(0),
                )
                .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))
        })
        .unwrap()
    }
}

fn query_run(
    connection: &Connection,
    run_id: &str,
) -> Result<Option<DurableRunSnapshot>, RunLedgerError> {
    connection
        .query_row(
            "SELECT id,conversation_id,trigger_message_id,result_message_id,kind,execution_mode,
                    policy_id,status,phase,partial,model_used,tool_used,source_count,candidate_count,
                    elapsed_ms,safe_code,committed_warning,restart_of_run_id,created_at,started_at,
                    updated_at,terminal_at,version
             FROM ai_run WHERE id=?1",
            [run_id],
            map_run,
        )
        .optional()
        .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))
}

fn query_artifact(
    connection: &Connection,
    artifact_id: &str,
) -> Result<Option<DurableRunArtifact>, RunLedgerError> {
    connection
        .query_row(
            "SELECT public_token,display_name,status,receipt_state
             FROM ai_run_artifact WHERE id=?1",
            [artifact_id],
            |row| {
                Ok(DurableRunArtifact {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    status: row.get(2)?,
                    receipt_state: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))
}

fn map_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<DurableRunSnapshot> {
    Ok(DurableRunSnapshot {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        trigger_message_id: row.get(2)?,
        result_message_id: row.get(3)?,
        kind: row.get(4)?,
        execution_mode: row.get(5)?,
        policy_id: row.get(6)?,
        status: row.get(7)?,
        phase: row.get(8)?,
        partial: row.get::<_, i64>(9)? != 0,
        model_used: row.get(10)?,
        tool_used: row.get(11)?,
        source_count: row.get(12)?,
        candidate_count: row.get(13)?,
        elapsed_ms: row.get(14)?,
        safe_code: row.get(15)?,
        committed_warning: row.get::<_, i64>(16)? != 0,
        restart_of: row.get(17)?,
        created_at: row.get(18)?,
        started_at: row.get(19)?,
        updated_at: row.get(20)?,
        terminal_at: row.get(21)?,
        version: row.get(22)?,
    })
}

fn map_conversation_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentConversationSummary> {
    Ok(AgentConversationSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        agent_mode: row.get(4)?,
        project_id: row.get(5)?,
        pinned_at: row.get(6)?,
        archived_at: row.get(7)?,
    })
}

fn validate_id(value: &str) -> Result<(), RunLedgerError> {
    if value.is_empty()
        || value.as_bytes().len() > RUN_ID_MAX_BYTES
        || value.chars().any(|character| character.is_control())
    {
        return Err(RunLedgerError::new("agent-run-protocol-invalid"));
    }
    Ok(())
}

fn validate_safe_label(value: &str) -> Result<(), RunLedgerError> {
    if value.is_empty()
        || value.as_bytes().len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(RunLedgerError::new("agent-run-protocol-invalid"));
    }
    Ok(())
}

fn validate_safe_host(value: &str) -> Result<(), RunLedgerError> {
    if value.is_empty()
        || value.as_bytes().len() > 253
        || value.chars().any(char::is_control)
        || value.contains(['/', '\\', '?', '#', '@'])
    {
        return Err(RunLedgerError::new("agent-run-protocol-invalid"));
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<(), RunLedgerError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(RunLedgerError::new("agent-run-protocol-invalid"));
    }
    Ok(())
}

fn validate_internal_ref(value: &str) -> Result<(), RunLedgerError> {
    if value.is_empty() || value.as_bytes().len() > 4096 || value.chars().any(char::is_control) {
        return Err(RunLedgerError::new("agent-run-protocol-invalid"));
    }
    Ok(())
}

fn validate_optional_revision(value: Option<&str>) -> Result<(), RunLedgerError> {
    if value.is_some_and(|value| {
        value.is_empty() || value.as_bytes().len() > 256 || value.chars().any(char::is_control)
    }) {
        return Err(RunLedgerError::new("agent-run-protocol-invalid"));
    }
    Ok(())
}

fn validate_display_name(value: &str) -> Result<(), RunLedgerError> {
    if value.is_empty()
        || value.as_bytes().len() > 256
        || value.chars().any(char::is_control)
        || value.contains(['/', '\\', ':', '?', '#'])
    {
        return Err(RunLedgerError::new("agent-run-protocol-invalid"));
    }
    Ok(())
}

fn canvas_artifact_stage(value: &str) -> bool {
    matches!(
        value,
        "provider-requested"
            | "provider-succeeded"
            | "provider-uncertain"
            | "materializing"
            | "material-committed"
            | "canvas-attaching"
            | "canvas-committed"
    )
}

fn canvas_artifact_transition(current: &str, next: &str) -> bool {
    matches!(
        (current, next),
        ("prepared", "provider-requested")
            | ("prepared", "canvas-attaching")
            | ("provider-requested", "provider-succeeded")
            | ("provider-requested", "provider-uncertain")
            | ("provider-succeeded", "materializing")
            | ("provider-succeeded", "canvas-attaching")
            | ("materializing", "material-committed")
            | ("material-committed", "canvas-attaching")
            | ("canvas-attaching", "canvas-committed")
    )
}

fn parse_canvas_artifact_binding(
    value: &str,
    stage: &str,
) -> Result<CanvasArtifactBinding, RunLedgerError> {
    let binding = if value.starts_with('{') {
        serde_json::from_str::<CanvasArtifactBinding>(value)
            .map_err(|_| RunLedgerError::new("agent-run-artifact-invalid"))?
    } else {
        CanvasArtifactBinding {
            canvas_id: value.to_owned(),
            stage: stage.to_owned(),
            material_id: None,
            output_digest: None,
        }
    };
    validate_id(&binding.canvas_id)?;
    if binding.stage != stage {
        return Err(RunLedgerError::new("agent-run-artifact-invalid"));
    }
    if let Some(material_id) = binding.material_id.as_deref() {
        validate_id(material_id)?;
    }
    if let Some(output_digest) = binding.output_digest.as_deref() {
        validate_digest(output_digest)?;
    }
    Ok(binding)
}

fn reconcile_artifact_revision(
    expected_revision: Option<&str>,
    new_revision: Option<&str>,
    current_revision: Option<&str>,
) -> ArtifactReconciliation {
    if new_revision.is_some() && new_revision == current_revision {
        return ArtifactReconciliation::Committed;
    }
    if current_revision == expected_revision {
        return ArtifactReconciliation::NotCommitted;
    }
    ArtifactReconciliation::Uncertain
}

fn random_hex(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::{
        reconcile_artifact_revision, AgentActionTruth, AgentConversationMode,
        AgentObservedTerminal, AgentTerminalProposal, ArtifactReconciliation, DurableRunProgress,
        DurableRunSource, ExecutionActionTruth, RunAdmission, RunCoordinator, RunExecutionMode,
        RunKind, RunLedgerError, RunStopCause, RunTerminal, StopTransportObservation,
        WorkspaceActionTruth,
    };
    use crate::canvas_agent::{CanvasAgentReceipt, CanvasAgentService, CanvasDocument};
    use crate::knowledge::{
        KnowledgeCreateInput, KnowledgeDocumentRef, KnowledgeService, KnowledgeSetTagsInput,
        KnowledgeVaultRegistration, KnowledgeWriteInput,
    };
    use rusqlite::Connection;
    use serde_json::{json, Map, Value};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "luckyray-run-ledger-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn test_coordinator() -> RunCoordinator {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE ai_conversation (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    agent_mode TEXT NOT NULL DEFAULT 'standard',
                    project_id TEXT,
                    pinned_at TEXT,
                    archived_at TEXT
                 );
                 CREATE TABLE ai_message (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                 );
                 INSERT INTO ai_conversation(id,title,created_at,updated_at)
                 VALUES ('conversation-receipts','Receipts','now','now');",
            )
            .unwrap();
        RunCoordinator::apply_schema(&connection).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS ai_message_action_truth (
                    message_id TEXT PRIMARY KEY,
                    workspace_status TEXT NOT NULL,
                    execution_status TEXT NOT NULL,
                    created_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        RunCoordinator::from_connection(connection)
    }

    fn admit_agent_run(coordinator: &RunCoordinator, label: &str) -> super::AdmittedRun {
        let conversation = coordinator.create_standard_conversation(label).unwrap();
        let admitted = coordinator
            .admit(RunAdmission {
                conversation_id: conversation.id,
                user_content: label.to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "f".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        coordinator
            .mark_running(&admitted.run_id, "running")
            .unwrap();
        admitted
    }

    fn agent_proposal(observed: AgentObservedTerminal) -> RunTerminal {
        RunTerminal::Agent(AgentTerminalProposal {
            observed,
            assistant_content: Some("安全正文".to_owned()),
            partial: false,
            cited_references: Vec::new(),
            receipt_summary: None,
            action_truth: Some(AgentActionTruth::new(
                WorkspaceActionTruth::NotRequested,
                ExecutionActionTruth::NotRequested,
            )),
        })
    }

    #[test]
    fn terminal_reducer_linearizes_causes_effects_and_retry_exactly_once() {
        let coordinator = test_coordinator();

        let explicit_first = admit_agent_run(&coordinator, "explicit first");
        assert_eq!(
            coordinator
                .record_stop_cause(&explicit_first.run_id, RunStopCause::ExplicitCancel)
                .unwrap(),
            RunStopCause::ExplicitCancel
        );
        assert_eq!(
            coordinator
                .record_stop_cause(&explicit_first.run_id, RunStopCause::SafetyAbort)
                .unwrap(),
            RunStopCause::ExplicitCancel,
            "the first accepted cause is monotonic"
        );
        coordinator
            .record_stop_transport(
                &explicit_first.run_id,
                StopTransportObservation::Acknowledged,
            )
            .unwrap();
        let cancelled = coordinator
            .settle(
                &explicit_first.run_id,
                agent_proposal(AgentObservedTerminal::Aborted),
            )
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");

        let safety_first = admit_agent_run(&coordinator, "safety first");
        coordinator
            .record_stop_cause(&safety_first.run_id, RunStopCause::SafetyAbort)
            .unwrap();
        assert_eq!(
            coordinator
                .record_stop_cause(&safety_first.run_id, RunStopCause::ExplicitCancel)
                .unwrap(),
            RunStopCause::SafetyAbort
        );
        coordinator
            .record_stop_transport(&safety_first.run_id, StopTransportObservation::Acknowledged)
            .unwrap();
        let aborted = coordinator
            .settle(
                &safety_first.run_id,
                agent_proposal(AgentObservedTerminal::Cancelled),
            )
            .unwrap();
        assert_eq!(aborted.status, "aborted");

        for (label, cause) in [
            ("unknown then explicit", RunStopCause::ExplicitCancel),
            ("unknown then safety", RunStopCause::SafetyAbort),
        ] {
            let admitted = admit_agent_run(&coordinator, label);
            let artifact = coordinator
                .prepare_artifact(
                    &admitted.run_id,
                    &format!("token-{label}"),
                    "workspace-file",
                    "private-ref",
                    &"a".repeat(64),
                    Some("before"),
                    "after",
                    "授权文件",
                )
                .unwrap();
            coordinator.mark_artifact_uncertain(&artifact).unwrap();
            coordinator
                .record_stop_cause(&admitted.run_id, cause)
                .unwrap();
            let failed = coordinator
                .settle(
                    &admitted.run_id,
                    agent_proposal(AgentObservedTerminal::Aborted),
                )
                .unwrap();
            assert_eq!(failed.status, "failed");
            assert_eq!(
                failed.safe_code.as_deref(),
                Some("agent-engine-workspace-write-uncertain")
            );
            assert!(failed.committed_warning);
        }

        for (label, cause) in [
            ("explicit then unknown", RunStopCause::ExplicitCancel),
            ("safety then unknown", RunStopCause::SafetyAbort),
        ] {
            let admitted = admit_agent_run(&coordinator, label);
            coordinator
                .record_stop_cause(&admitted.run_id, cause)
                .unwrap();
            let artifact = coordinator
                .prepare_artifact(
                    &admitted.run_id,
                    &format!("token-{label}"),
                    "workspace-file",
                    "private-ref",
                    &"c".repeat(64),
                    Some("before"),
                    "after",
                    "授权文件",
                )
                .unwrap();
            coordinator.mark_artifact_uncertain(&artifact).unwrap();
            let failed = coordinator
                .settle(
                    &admitted.run_id,
                    agent_proposal(AgentObservedTerminal::Cancelled),
                )
                .unwrap();
            assert_eq!(failed.status, "failed");
            assert_eq!(
                failed.safe_code.as_deref(),
                Some("agent-engine-workspace-write-uncertain")
            );
        }

        let committed = admit_agent_run(&coordinator, "committed then stop");
        let committed_artifact = coordinator
            .prepare_artifact(
                &committed.run_id,
                "token-committed-stop",
                "workspace-file",
                "private-ref",
                &"d".repeat(64),
                Some("before"),
                "after",
                "授权文件",
            )
            .unwrap();
        coordinator
            .commit_artifact(&committed_artifact, "after", "committed", "授权文件")
            .unwrap();
        coordinator
            .record_stop_cause(&committed.run_id, RunStopCause::ExplicitCancel)
            .unwrap();
        coordinator
            .record_stop_transport(&committed.run_id, StopTransportObservation::Acknowledged)
            .unwrap();
        let mut committed_proposal = match agent_proposal(AgentObservedTerminal::Aborted) {
            RunTerminal::Agent(proposal) => proposal,
            _ => unreachable!(),
        };
        committed_proposal.receipt_summary = Some("文件变更已保留。".to_owned());
        let committed_stop = coordinator
            .settle(&committed.run_id, RunTerminal::Agent(committed_proposal))
            .unwrap();
        assert_eq!(committed_stop.status, "cancelled");
        assert!(committed_stop.committed_warning);

        let transport_failed = admit_agent_run(&coordinator, "transport failed");
        coordinator
            .record_stop_cause(&transport_failed.run_id, RunStopCause::ExplicitCancel)
            .unwrap();
        let transport_proposal = match agent_proposal(AgentObservedTerminal::Completed) {
            RunTerminal::Agent(proposal) => proposal,
            _ => unreachable!(),
        };
        coordinator
            .record_stop_transport(&transport_failed.run_id, StopTransportObservation::Failed)
            .unwrap();
        let transport_terminal = coordinator
            .settle(
                &transport_failed.run_id,
                RunTerminal::Agent(transport_proposal),
            )
            .unwrap();
        assert_eq!(transport_terminal.status, "aborted");

        let transport_pending = admit_agent_run(&coordinator, "transport pending");
        coordinator
            .record_stop_cause(&transport_pending.run_id, RunStopCause::ExplicitCancel)
            .unwrap();
        let pending_proposal = agent_proposal(AgentObservedTerminal::Aborted);
        let pending_error = coordinator
            .settle(&transport_pending.run_id, pending_proposal.clone())
            .unwrap_err();
        assert_eq!(pending_error.code, "agent-run-settlement-pending");
        assert_eq!(
            coordinator.get(&transport_pending.run_id).unwrap().status,
            "running",
            "an unresolved runtime Stop transport cannot publish a terminal"
        );
        coordinator
            .record_stop_transport(
                &transport_pending.run_id,
                StopTransportObservation::Acknowledged,
            )
            .unwrap();
        assert_eq!(
            coordinator
                .settle(&transport_pending.run_id, pending_proposal)
                .unwrap()
                .status,
            "cancelled"
        );

        let completed_after_stop = admit_agent_run(&coordinator, "completed after stop");
        coordinator
            .record_stop_cause(&completed_after_stop.run_id, RunStopCause::ExplicitCancel)
            .unwrap();
        coordinator
            .record_stop_transport(
                &completed_after_stop.run_id,
                StopTransportObservation::Acknowledged,
            )
            .unwrap();
        assert_eq!(
            coordinator
                .settle(
                    &completed_after_stop.run_id,
                    agent_proposal(AgentObservedTerminal::Completed),
                )
                .unwrap()
                .status,
            "cancelled",
            "child completion is evidence and cannot erase an accepted Stop"
        );

        let independent_failure = admit_agent_run(&coordinator, "failure after stop");
        coordinator
            .record_stop_cause(&independent_failure.run_id, RunStopCause::SafetyAbort)
            .unwrap();
        let failed = coordinator
            .settle(
                &independent_failure.run_id,
                agent_proposal(AgentObservedTerminal::Failed {
                    code: "agent-engine-provider-invalid-response".to_owned(),
                }),
            )
            .unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(
            failed.safe_code.as_deref(),
            Some("agent-engine-provider-invalid-response"),
            "an independent typed failure is not washed into a Stop status"
        );

        let retry = admit_agent_run(&coordinator, "settle retry");
        coordinator.fail_next_settle();
        assert!(coordinator
            .settle(
                &retry.run_id,
                agent_proposal(AgentObservedTerminal::Completed)
            )
            .is_err());
        assert_eq!(coordinator.get(&retry.run_id).unwrap().status, "running");
        let first = coordinator
            .settle(
                &retry.run_id,
                agent_proposal(AgentObservedTerminal::Completed),
            )
            .unwrap();
        let duplicate = coordinator
            .settle(
                &retry.run_id,
                agent_proposal(AgentObservedTerminal::Failed {
                    code: "agent-engine-failed".to_owned(),
                }),
            )
            .unwrap();
        assert_eq!(first.result_message_id, duplicate.result_message_id);
        assert_eq!(first.status, "completed");
        assert_eq!(
            coordinator.message_count(&first.conversation_id, "assistant"),
            1
        );
    }

    #[test]
    fn restart_reducer_preserves_stop_intent_and_uncertain_receipt_without_replay() {
        let coordinator = test_coordinator();
        let cancelled = admit_agent_run(&coordinator, "restart explicit");
        coordinator
            .record_stop_cause(&cancelled.run_id, RunStopCause::ExplicitCancel)
            .unwrap();
        let cancelled_run_id = cancelled.run_id.clone();
        drop(cancelled.lease);
        assert_eq!(coordinator.reconcile_startup_terminals().unwrap(), 1);
        let cancelled_snapshot = coordinator.get(&cancelled_run_id).unwrap();
        assert_eq!(cancelled_snapshot.status, "aborted");

        let uncertain = admit_agent_run(&coordinator, "restart uncertain");
        let artifact = coordinator
            .prepare_artifact(
                &uncertain.run_id,
                "token-restart-uncertain",
                "workspace-file",
                "private-ref",
                &"b".repeat(64),
                Some("before"),
                "after",
                "授权文件",
            )
            .unwrap();
        coordinator.mark_artifact_uncertain(&artifact).unwrap();
        let uncertain_run_id = uncertain.run_id.clone();
        drop(uncertain.lease);

        assert_eq!(coordinator.reconcile_startup_terminals().unwrap(), 1);
        let uncertain_snapshot = coordinator.get(&uncertain_run_id).unwrap();
        assert_eq!(uncertain_snapshot.status, "failed");
        assert_eq!(
            uncertain_snapshot.safe_code.as_deref(),
            Some("agent-engine-workspace-write-uncertain")
        );
        assert_eq!(coordinator.reconcile_startup_terminals().unwrap(), 0);
        assert_eq!(
            coordinator.message_count(&cancelled_snapshot.conversation_id, "assistant"),
            1
        );
        assert_eq!(
            coordinator.message_count(&uncertain_snapshot.conversation_id, "assistant"),
            1
        );
    }

    #[test]
    fn draft_conversation_compensation_discards_only_proven_empty_rows() {
        let coordinator = test_coordinator();
        let empty = coordinator
            .create_standard_conversation("First real message")
            .unwrap();
        assert!(coordinator
            .discard_empty_draft_conversation(&empty.id)
            .unwrap());
        assert!(coordinator
            .list_conversations(20)
            .unwrap()
            .iter()
            .all(|conversation| conversation.id != empty.id));

        let admitted = coordinator
            .create_standard_conversation("Durable first message")
            .unwrap();
        let run = coordinator
            .admit(RunAdmission {
                conversation_id: admitted.id.clone(),
                user_content: "Durable first message".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "d".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        assert!(!coordinator
            .discard_empty_draft_conversation(&admitted.id)
            .unwrap());
        assert_eq!(coordinator.message_count(&admitted.id, "user"), 1);
        assert_eq!(
            coordinator.get(&run.run_id).unwrap().conversation_id,
            admitted.id
        );
    }

    #[test]
    fn cancelled_and_aborted_runs_persist_one_durable_safe_result_message() {
        let coordinator = test_coordinator();
        let conversation = coordinator
            .create_standard_conversation("Stop durable result")
            .unwrap();
        let cancelled = coordinator
            .admit(RunAdmission {
                conversation_id: conversation.id.clone(),
                user_content: "Stop this turn".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "a".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        coordinator
            .mark_running(&cancelled.run_id, "running")
            .unwrap();

        let first = coordinator
            .settle(
                &cancelled.run_id,
                RunTerminal::Cancelled { action_truth: None },
            )
            .unwrap();
        let duplicate = coordinator
            .settle(
                &cancelled.run_id,
                RunTerminal::Cancelled { action_truth: None },
            )
            .unwrap();
        assert_eq!(first.status, "cancelled");
        assert_eq!(first.result_message_id, duplicate.result_message_id);
        assert!(first.result_message_id.is_some());
        assert_eq!(coordinator.message_count(&conversation.id, "assistant"), 1);
        let cancelled_content = coordinator
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT content FROM ai_message WHERE id=?1",
                        [first.result_message_id.as_deref().unwrap()],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))
            })
            .unwrap();
        assert_eq!(cancelled_content, "Agent 已停止");
        let aborted = coordinator
            .admit(RunAdmission {
                conversation_id: conversation.id.clone(),
                user_content: "Leave this route".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "b".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        let settled = coordinator
            .settle(&aborted.run_id, RunTerminal::Aborted { action_truth: None })
            .unwrap();
        assert_eq!(settled.status, "aborted");
        assert!(settled.result_message_id.is_some());
        assert_eq!(coordinator.message_count(&conversation.id, "assistant"), 2);
        let aborted_content = coordinator
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT content FROM ai_message WHERE id=?1",
                        [settled.result_message_id.as_deref().unwrap()],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|_| RunLedgerError::new("agent-run-ledger-unavailable"))
            })
            .unwrap();
        assert_eq!(aborted_content, "Agent 已安全终止");
    }

    fn write_canvas_reconcile_fixture(
        root: &PathBuf,
        canvas_id: &str,
        receipt: Option<(&str, &str)>,
    ) {
        let canvas_dir = root.join("canvases");
        std::fs::create_dir_all(&canvas_dir).unwrap();
        let mut document = CanvasDocument {
            schema_version: 2,
            canvas_id: canvas_id.to_owned(),
            name: "Reconcile fixture".to_owned(),
            created_at: "2026-07-29T00:00:00Z".to_owned(),
            updated_at: "2026-07-29T00:00:00Z".to_owned(),
            nodes: json!([]),
            edges: json!([]),
            viewport: json!({"x":0,"y":0,"zoom":1}),
            generation_history: json!([]),
            revision: receipt.map_or(1, |_| 2),
            content_digest: String::new(),
            agent_receipts: receipt
                .map(|(operation_digest, material_id)| {
                    vec![CanvasAgentReceipt {
                        operation_digest: operation_digest.to_owned(),
                        revision: 2,
                        metadata: Map::from_iter([(
                            "materialId".to_owned(),
                            Value::String(material_id.to_owned()),
                        )]),
                    }]
                })
                .unwrap_or_default(),
        };
        document.content_digest = crate::canvas_agent::content_digest(&document).unwrap();
        std::fs::write(
            canvas_dir.join(format!("{canvas_id}.json")),
            serde_json::to_vec_pretty(&document).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn transient_and_durable_runs_share_one_atomic_runtime_owner() {
        let coordinator = test_coordinator();
        let notes = coordinator.acquire_transient("notes-inline").unwrap();
        assert!(notes.run_id().starts_with("transient-notes-inline-"));

        let busy = match coordinator.admit(RunAdmission {
            conversation_id: "conversation-receipts".to_owned(),
            user_content: "must not be persisted while notes owns runtime".to_owned(),
            kind: RunKind::Research,
            execution_mode: RunExecutionMode::Background,
            policy_id: "research-v1".to_owned(),
            vault_binding_digest: "d".repeat(64),
            restart_of: None,
            existing_trigger_message_id: None,
            schedule_fire_id: None,
        }) {
            Ok(_) => panic!("durable run must not bypass the transient runtime owner"),
            Err(error) => error,
        };
        assert_eq!(busy.code, "agent-engine-busy");
        assert_eq!(
            coordinator.message_count("conversation-receipts", "user"),
            0
        );
        assert!(coordinator.cancel_transient("notes-inline").unwrap());
        assert!(notes.is_cancelled());
        drop(notes);

        let admitted = coordinator
            .admit(RunAdmission {
                conversation_id: "conversation-receipts".to_owned(),
                user_content: "research now owns the single runtime".to_owned(),
                kind: RunKind::Research,
                execution_mode: RunExecutionMode::Background,
                policy_id: "research-v1".to_owned(),
                vault_binding_digest: "e".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        let canvas_busy = match coordinator.acquire_transient("canvas-generation") {
            Ok(_) => panic!("canvas transient must not bypass the durable runtime owner"),
            Err(error) => error,
        };
        assert_eq!(canvas_busy.code, "agent-engine-busy");
        coordinator.cancel_active();
        assert!(admitted.lease.is_cancelled());
    }

    #[test]
    fn conversation_mode_is_backend_owned_and_project_identity_persists_across_turns() {
        let coordinator = test_coordinator();
        assert_eq!(
            coordinator
                .conversation_mode("conversation-receipts")
                .unwrap(),
            AgentConversationMode::Standard
        );

        let project = coordinator
            .create_project_conversation("Persistent project")
            .unwrap();
        assert_eq!(project.agent_mode, "project-task");
        for _ in 0..2 {
            assert_eq!(
                coordinator.conversation_mode(&project.id).unwrap(),
                AgentConversationMode::ProjectTask,
                "each turn derives ProjectTask from the same Backend conversation row"
            );
        }
        let listed = coordinator.list_conversations(10).unwrap();
        assert!(listed
            .iter()
            .any(|item| { item.id == project.id && item.agent_mode == "project-task" }));
        assert_eq!(
            coordinator
                .conversation_mode("conversation-forged")
                .unwrap_err()
                .code,
            "agent-run-conversation-unavailable"
        );
    }

    #[test]
    fn scheduled_admission_atomically_links_one_fire_to_one_background_run() {
        let coordinator = test_coordinator();
        coordinator
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "CREATE TABLE agent_schedule (
                            id TEXT PRIMARY KEY, last_run_id TEXT, last_safe_code TEXT,
                            updated_at TEXT NOT NULL
                         );
                         CREATE TABLE agent_schedule_fire (
                            id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL,
                            state TEXT NOT NULL, run_id TEXT, updated_at TEXT NOT NULL
                         );
                         INSERT INTO agent_schedule(id,updated_at)
                         VALUES ('schedule-atomic','now');
                         INSERT INTO agent_schedule_fire(id,schedule_id,state,updated_at)
                         VALUES ('fire-atomic','schedule-atomic','starting','now');",
                    )
                    .map_err(|_| super::RunLedgerError::new("agent-run-ledger-unavailable"))?;
                Ok(())
            })
            .unwrap();
        let admitted = coordinator
            .admit(RunAdmission {
                conversation_id: "conversation-receipts".to_owned(),
                user_content: "scheduled fixture".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Background,
                policy_id: "schedule-v1".to_owned(),
                vault_binding_digest: "a".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: Some("fire-atomic".to_owned()),
            })
            .unwrap();
        let linked = coordinator
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT state,run_id FROM agent_schedule_fire WHERE id='fire-atomic'",
                        [],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )
                    .map_err(|_| super::RunLedgerError::new("agent-run-ledger-unavailable"))
            })
            .unwrap();
        assert_eq!(linked.0, "running");
        assert_eq!(linked.1, admitted.run_id);
        let run = coordinator.get(&admitted.run_id).unwrap();
        assert_eq!(run.execution_mode, "background");
        assert_eq!(run.policy_id, "schedule-v1");
    }

    #[test]
    fn prepared_execution_receipt_becomes_uncertain_on_restart_and_is_never_replayed() {
        let coordinator = test_coordinator();
        let admitted = coordinator
            .admit(RunAdmission {
                conversation_id: "conversation-receipts".to_owned(),
                user_content: "run a controlled project check".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Foreground,
                policy_id: "project-task-v1".to_owned(),
                vault_binding_digest: "a".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        let public_token = format!("artifact-{}", "e".repeat(32));
        let artifact_id = coordinator
            .prepare_artifact(
                &admitted.run_id,
                &public_token,
                "execution",
                "private-execution-locator",
                &"b".repeat(64),
                Some(&"c".repeat(64)),
                &"b".repeat(64),
                "项目清单检查",
            )
            .unwrap();
        coordinator.reconcile_execution_artifacts().unwrap();
        let origin = coordinator.artifact_origin(&public_token).unwrap();
        assert_eq!(origin.receipt_state, "uncertain");
        assert_eq!(origin.entity_ref, "private-execution-locator");
        assert_eq!(
            coordinator.get(&admitted.run_id).unwrap().committed_warning,
            false,
            "unknown execution does not become a fabricated committed result"
        );
        coordinator.reconcile_execution_artifacts().unwrap();
        let repeated = coordinator.artifact_origin(&public_token).unwrap();
        assert_eq!(repeated.receipt_state, "uncertain");
        assert_eq!(repeated.entity_ref, "private-execution-locator");

        let known_no_start_token = format!("artifact-{}", "f".repeat(32));
        let known_no_start = coordinator
            .prepare_artifact(
                &admitted.run_id,
                &known_no_start_token,
                "execution",
                "private-pre-spawn-locator",
                &"d".repeat(64),
                Some(&"e".repeat(64)),
                &"d".repeat(64),
                "项目清单检查",
            )
            .unwrap();
        coordinator
            .discard_prepared_execution_artifact(&known_no_start)
            .unwrap();
        assert_eq!(
            coordinator
                .artifact_origin(&known_no_start_token)
                .unwrap_err()
                .code,
            "agent-run-artifact-not-found"
        );
        // The reconciliation pass only visits remaining prepared rows, so it
        // cannot resurrect or replay a receipt that was proven pre-spawn.
        coordinator.reconcile_execution_artifacts().unwrap();
        assert_eq!(
            coordinator
                .artifact_origin(&public_token)
                .unwrap()
                .receipt_state,
            "uncertain"
        );
        let _ = artifact_id;
    }

    #[test]
    fn canvas_generation_receipt_stages_are_linear_and_restart_safe() {
        let coordinator = test_coordinator();
        let admitted = coordinator
            .admit(RunAdmission {
                conversation_id: "conversation-receipts".to_owned(),
                user_content: "generate canvas media".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Foreground,
                policy_id: "canvas-v1".to_owned(),
                vault_binding_digest: "a".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        let public_token = format!("artifact-{}", "b".repeat(32));
        let artifact_id = coordinator
            .prepare_artifact(
                &admitted.run_id,
                &public_token,
                "canvas",
                "canvas-safe",
                &"c".repeat(64),
                Some("1"),
                "2",
                "Canvas generation",
            )
            .unwrap();
        coordinator.mark_artifact_uncertain(&artifact_id).unwrap();
        assert_eq!(
            coordinator.artifact_origin(&public_token).unwrap().receipt_state,
            "prepared",
            "a Canvas artifact that never crossed a durable dangerous-stage boundary is known not requested"
        );
        assert_eq!(
            coordinator
                .transition_canvas_artifact_stage(
                    &artifact_id,
                    "canvas-safe",
                    "material-committed",
                    None,
                    None,
                )
                .unwrap_err()
                .code,
            "agent-run-state-conflict"
        );
        for (stage, material_id, output_digest) in [
            ("provider-requested", None, None),
            ("provider-succeeded", None, None),
            ("materializing", None, Some("d".repeat(64))),
            (
                "material-committed",
                Some("material-safe".to_owned()),
                Some("d".repeat(64)),
            ),
            ("canvas-attaching", None, None),
            ("canvas-committed", None, None),
        ] {
            coordinator
                .transition_canvas_artifact_stage(
                    &artifact_id,
                    "canvas-safe",
                    stage,
                    material_id.as_deref(),
                    output_digest.as_deref(),
                )
                .unwrap();
            coordinator
                .transition_canvas_artifact_stage(
                    &artifact_id,
                    "canvas-safe",
                    stage,
                    material_id.as_deref(),
                    output_digest.as_deref(),
                )
                .unwrap();
        }
        let committed = coordinator
            .commit_artifact(&artifact_id, "2", "committed", "Canvas generation")
            .unwrap();
        assert_eq!(committed.receipt_state, "ledger-committed");
        let origin = coordinator.artifact_origin(&public_token).unwrap();
        assert_eq!(origin.canvas_id().unwrap(), "canvas-safe");

        let uncertain_token = format!("artifact-{}", "e".repeat(32));
        let uncertain_id = coordinator
            .prepare_artifact(
                &admitted.run_id,
                &uncertain_token,
                "canvas",
                "canvas-safe",
                &"f".repeat(64),
                Some("2"),
                "3",
                "Canvas retry boundary",
            )
            .unwrap();
        coordinator
            .transition_canvas_artifact_stage(
                &uncertain_id,
                "canvas-safe",
                "provider-requested",
                None,
                None,
            )
            .unwrap();
        coordinator.mark_artifact_uncertain(&uncertain_id).unwrap();
        let uncertain = coordinator.artifact_origin(&uncertain_token).unwrap();
        assert_eq!(uncertain.receipt_state, "provider-uncertain");
        assert_eq!(uncertain.canvas_id().unwrap(), "canvas-safe");
        coordinator.mark_artifact_uncertain(&uncertain_id).unwrap();
        let repeated = coordinator.artifact_origin(&uncertain_token).unwrap();
        assert_eq!(repeated.receipt_state, "provider-uncertain");
        assert_eq!(repeated.canvas_id().unwrap(), "canvas-safe");
    }

    #[test]
    fn canvas_startup_reconcile_is_stage_aware_idempotent_and_never_replays() {
        let root = temp_path("canvas-stage-reconcile");
        let coordinator = test_coordinator();
        let run = coordinator
            .admit(RunAdmission {
                conversation_id: "conversation-receipts".to_owned(),
                user_content: "reconcile staged canvas generation".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Background,
                policy_id: "canvas-v1".to_owned(),
                vault_binding_digest: "a".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        let canvas = CanvasAgentService::new(&root);

        let prepare = |label: &str, operation_digest: &str| {
            let token = format!("artifact-{label}");
            let id = coordinator
                .prepare_artifact(
                    &run.run_id,
                    &token,
                    "canvas",
                    &format!("canvas-{label}"),
                    operation_digest,
                    Some("1"),
                    "2",
                    "Canvas generation",
                )
                .unwrap();
            (token, id)
        };
        let transition =
            |artifact_id: &str, canvas_id: &str, stage: &str, material: Option<&str>| {
                coordinator
                    .transition_canvas_artifact_stage(artifact_id, canvas_id, stage, material, None)
                    .unwrap();
            };

        let prepared_digest = "1".repeat(64);
        let (prepared_token, _) = prepare("prepared-safe", &prepared_digest);
        write_canvas_reconcile_fixture(&root, "canvas-prepared-safe", None);

        let requested_digest = "2".repeat(64);
        let (requested_token, requested_id) = prepare("requested-safe", &requested_digest);
        write_canvas_reconcile_fixture(&root, "canvas-requested-safe", None);
        transition(
            &requested_id,
            "canvas-requested-safe",
            "provider-requested",
            None,
        );

        let succeeded_digest = "3".repeat(64);
        let (succeeded_token, succeeded_id) = prepare("succeeded-safe", &succeeded_digest);
        write_canvas_reconcile_fixture(&root, "canvas-succeeded-safe", None);
        transition(
            &succeeded_id,
            "canvas-succeeded-safe",
            "provider-requested",
            None,
        );
        transition(
            &succeeded_id,
            "canvas-succeeded-safe",
            "provider-succeeded",
            None,
        );

        let attached_digest = "4".repeat(64);
        let (attached_token, attached_id) = prepare("attached-safe", &attached_digest);
        write_canvas_reconcile_fixture(
            &root,
            "canvas-attached-safe",
            Some((&attached_digest, "material-safe")),
        );
        for stage in ["provider-requested", "provider-succeeded", "materializing"] {
            transition(&attached_id, "canvas-attached-safe", stage, None);
        }
        transition(
            &attached_id,
            "canvas-attached-safe",
            "material-committed",
            Some("material-safe"),
        );
        transition(
            &attached_id,
            "canvas-attached-safe",
            "canvas-attaching",
            None,
        );

        let mismatch_digest = "5".repeat(64);
        let (mismatch_token, mismatch_id) = prepare("mismatch-safe", &mismatch_digest);
        write_canvas_reconcile_fixture(
            &root,
            "canvas-mismatch-safe",
            Some((&mismatch_digest, "different-material")),
        );
        for stage in ["provider-requested", "provider-succeeded", "materializing"] {
            transition(&mismatch_id, "canvas-mismatch-safe", stage, None);
        }
        transition(
            &mismatch_id,
            "canvas-mismatch-safe",
            "material-committed",
            Some("recorded-material"),
        );
        transition(
            &mismatch_id,
            "canvas-mismatch-safe",
            "canvas-attaching",
            None,
        );

        let mut uncommitted_dangerous_tokens = Vec::new();
        for (label, digest_byte, final_stage) in [
            ("materializing-safe", "6", "materializing"),
            ("material-committed-safe", "7", "material-committed"),
            ("attaching-empty-safe", "8", "canvas-attaching"),
            ("committed-empty-safe", "9", "canvas-committed"),
        ] {
            let digest = digest_byte.repeat(64);
            let (token, artifact_id) = prepare(label, &digest);
            let canvas_id = format!("canvas-{label}");
            write_canvas_reconcile_fixture(&root, &canvas_id, None);
            transition(&artifact_id, &canvas_id, "provider-requested", None);
            transition(&artifact_id, &canvas_id, "provider-succeeded", None);
            transition(&artifact_id, &canvas_id, "materializing", None);
            if final_stage != "materializing" {
                transition(
                    &artifact_id,
                    &canvas_id,
                    "material-committed",
                    Some("material-safe"),
                );
            }
            if matches!(final_stage, "canvas-attaching" | "canvas-committed") {
                transition(&artifact_id, &canvas_id, "canvas-attaching", None);
            }
            if final_stage == "canvas-committed" {
                transition(&artifact_id, &canvas_id, "canvas-committed", None);
            }
            uncommitted_dangerous_tokens.push(token);
        }

        coordinator.reconcile_canvas_artifacts(&canvas).unwrap();
        coordinator.reconcile_canvas_artifacts(&canvas).unwrap();

        assert_eq!(
            coordinator
                .artifact_origin(&prepared_token)
                .unwrap()
                .receipt_state,
            "prepared"
        );
        assert_eq!(
            coordinator
                .artifact_origin(&requested_token)
                .unwrap()
                .receipt_state,
            "provider-uncertain"
        );
        assert_eq!(
            coordinator
                .artifact_origin(&succeeded_token)
                .unwrap()
                .receipt_state,
            "uncertain"
        );
        assert_eq!(
            coordinator
                .artifact_origin(&attached_token)
                .unwrap()
                .receipt_state,
            "ledger-committed"
        );
        assert_eq!(
            coordinator
                .artifact_origin(&mismatch_token)
                .unwrap()
                .receipt_state,
            "uncertain"
        );
        for token in uncommitted_dangerous_tokens {
            assert_eq!(
                coordinator.artifact_origin(&token).unwrap().receipt_state,
                "uncertain",
                "{token} must not replay or claim a Canvas commit without a matching receipt"
            );
        }
        let artifacts = coordinator.list_artifacts(&run.run_id).unwrap();
        assert_eq!(
            artifacts
                .iter()
                .find(|artifact| artifact.id == attached_token)
                .unwrap()
                .status,
            "committed-warning"
        );
        assert!(coordinator.get(&run.run_id).unwrap().committed_warning);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ledger_admission_and_terminal_are_atomic_and_reconcile_interrupted_runs() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE ai_conversation (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                 );
                 CREATE TABLE ai_message (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                 );
                 CREATE TABLE ai_message_action_truth (
                    message_id TEXT PRIMARY KEY,
                    workspace_status TEXT NOT NULL,
                    execution_status TEXT NOT NULL,
                    created_at TEXT NOT NULL
                 );
                 INSERT INTO ai_conversation(id,title,created_at,updated_at)
                 VALUES ('conversation-1','Research','now','now');",
            )
            .unwrap();
        RunCoordinator::apply_schema(&connection).unwrap();
        let coordinator = RunCoordinator::from_connection(connection);

        let admission = coordinator
            .admit(RunAdmission {
                conversation_id: "conversation-1".to_owned(),
                user_content: "PRIVATE-RESEARCH-QUESTION".to_owned(),
                kind: RunKind::Research,
                execution_mode: RunExecutionMode::Background,
                policy_id: "research-v1".to_owned(),
                vault_binding_digest: "d".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        let queued = coordinator.get(&admission.run_id).unwrap();
        assert_eq!(queued.status, "queued");
        assert_eq!(coordinator.message_count("conversation-1", "user"), 1);

        coordinator
            .mark_running(&admission.run_id, "gathering")
            .unwrap();
        coordinator
            .publish_progress(
                &admission.run_id,
                DurableRunProgress {
                    phase: "gathering".to_owned(),
                    model_used: 3,
                    tool_used: 5,
                    source_count: 0,
                    candidate_count: 8,
                    elapsed_ms: 1_250,
                    partial: false,
                    awaiting_approval: false,
                },
            )
            .unwrap();
        coordinator
            .record_source(
                &admission.run_id,
                DurableRunSource {
                    reference_label: "R1".to_owned(),
                    source_token: format!("src-w-{}", "a".repeat(64)),
                    kind: "web".to_owned(),
                    host: Some("example.com".to_owned()),
                    retained: true,
                    cited: false,
                },
            )
            .unwrap();
        coordinator
            .record_source(
                &admission.run_id,
                DurableRunSource {
                    reference_label: "R1".to_owned(),
                    source_token: format!("src-w-{}", "a".repeat(64)),
                    kind: "web".to_owned(),
                    host: Some("example.com".to_owned()),
                    retained: true,
                    cited: false,
                },
            )
            .unwrap();
        let artifact_id = coordinator
            .prepare_artifact(
                &admission.run_id,
                &format!("artifact-{}", "b".repeat(32)),
                "knowledge",
                r#"{"vaultId":"vault-safe","relativePath":"Research.md"}"#,
                &"c".repeat(64),
                Some("revision-before"),
                "revision-after",
                "Research note",
            )
            .unwrap();
        let artifact = coordinator
            .commit_artifact(&artifact_id, "revision-after", "committed", "Research note")
            .unwrap();
        assert_eq!(artifact.receipt_state, "committed");
        assert_eq!(
            coordinator.list_sources(&admission.run_id).unwrap().len(),
            1
        );
        assert_eq!(
            coordinator.list_artifacts(&admission.run_id).unwrap().len(),
            1
        );
        let public_details = coordinator.list_details(10).unwrap();
        let public_json = serde_json::to_string(&public_details).unwrap();
        for private in [
            "Research.md",
            "vault-safe",
            "revision-before",
            "PRIVATE-KEY",
            "Authorization",
            "fetchRef",
            "navigationRef",
            "browserRef",
            "<think>",
        ] {
            assert!(
                !public_json.contains(private),
                "public run projection leaked {private}"
            );
        }
        let settled = coordinator
            .settle(
                &admission.run_id,
                RunTerminal::Completed {
                    assistant_content: "Safe synthesis".to_owned(),
                    partial: false,
                    cited_references: vec!["R1".to_owned(), "R999".to_owned()],
                    action_truth: None,
                },
            )
            .unwrap();
        assert_eq!(settled.status, "completed");
        assert_eq!(coordinator.message_count("conversation-1", "assistant"), 1);
        let details = coordinator.list_details(10).unwrap();
        let persisted = details
            .iter()
            .find(|details| details.run.id == admission.run_id)
            .unwrap();
        assert_eq!(persisted.run.candidate_count, 8);
        assert_eq!(persisted.sources.len(), 1);
        assert!(persisted.sources[0].cited);

        let duplicate = coordinator
            .settle(
                &admission.run_id,
                RunTerminal::Completed {
                    assistant_content: "must not duplicate".to_owned(),
                    partial: false,
                    cited_references: Vec::new(),
                    action_truth: None,
                },
            )
            .unwrap();
        assert_eq!(duplicate.result_message_id, settled.result_message_id);
        assert_eq!(coordinator.message_count("conversation-1", "assistant"), 1);

        let interrupted = coordinator
            .admit(RunAdmission {
                conversation_id: "conversation-1".to_owned(),
                user_content: "second question".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "e".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        coordinator
            .mark_running(&interrupted.run_id, "running")
            .unwrap();
        coordinator
            .publish_progress(
                &interrupted.run_id,
                DurableRunProgress {
                    phase: "awaiting-approval".to_owned(),
                    model_used: 0,
                    tool_used: 1,
                    source_count: 0,
                    candidate_count: 0,
                    elapsed_ms: 10,
                    partial: false,
                    awaiting_approval: true,
                },
            )
            .unwrap();
        assert_eq!(
            coordinator.get(&interrupted.run_id).unwrap().status,
            "awaiting-approval"
        );
        assert_eq!(coordinator.reconcile_startup_terminals().unwrap(), 1);
        assert_eq!(
            coordinator.get(&interrupted.run_id).unwrap().status,
            "interrupted"
        );
        let restart = coordinator.restart_spec(&interrupted.run_id).unwrap();
        let restarted = coordinator
            .admit(RunAdmission {
                conversation_id: restart.conversation_id,
                user_content: restart.input,
                kind: restart.kind,
                execution_mode: restart.execution_mode,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "f".repeat(64),
                restart_of: Some(restart.restart_of),
                existing_trigger_message_id: Some(restart.trigger_message_id),
                schedule_fire_id: None,
            })
            .unwrap();
        assert_ne!(restarted.run_id, interrupted.run_id);
        assert_eq!(coordinator.message_count("conversation-1", "user"), 2);
        assert_eq!(
            coordinator
                .get(&restarted.run_id)
                .unwrap()
                .restart_of
                .as_deref(),
            Some(interrupted.run_id.as_str())
        );
    }

    #[test]
    fn knowledge_receipt_reconciliation_never_replays_uncertain_writes() {
        for tool_id in ["knowledge.create", "knowledge.append", "knowledge.set_tags"] {
            let expected = (tool_id != "knowledge.create").then_some("old");
            assert_eq!(
                reconcile_artifact_revision(expected, Some("new"), Some("new")),
                ArtifactReconciliation::Committed
            );
            assert_eq!(
                reconcile_artifact_revision(expected, Some("new"), expected),
                ArtifactReconciliation::NotCommitted
            );
            assert_eq!(
                reconcile_artifact_revision(expected, Some("new"), Some("other")),
                ArtifactReconciliation::Uncertain
            );
        }
    }

    #[test]
    fn startup_reconciles_committed_create_append_and_set_tags_without_replaying() {
        let app_data = temp_path("receipt-app");
        let vault_root = temp_path("receipt-vault");
        std::fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let vault = KnowledgeVaultRegistration {
            id: "vault-receipts".to_owned(),
            name: "Receipts".to_owned(),
            root_path: vault_root.to_string_lossy().to_string(),
            mode: "vault-bound".to_owned(),
            created_at: "2026-07-29T00:00:00Z".to_owned(),
            last_opened_at: "2026-07-29T00:00:00Z".to_owned(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        std::fs::write(
            vault_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&vault).unwrap(),
        )
        .unwrap();
        let knowledge = KnowledgeService::initialize(&app_data).unwrap();
        knowledge.register_current_vault(&vault).unwrap();

        let coordinator = test_coordinator();
        let run = coordinator
            .admit(RunAdmission {
                conversation_id: "conversation-receipts".to_owned(),
                user_content: "create append and tag".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "a".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();

        let create_ref = KnowledgeDocumentRef {
            vault_id: vault.id.clone(),
            relative_path: "Created.md".to_owned(),
        };
        let create_planned = knowledge
            .preview_agent_create_revision(&create_ref, "created once")
            .unwrap();
        let create_token = format!("artifact-{}", "1".repeat(32));
        coordinator
            .prepare_artifact(
                &run.run_id,
                &create_token,
                "knowledge",
                &serde_json::to_string(&create_ref).unwrap(),
                &"1".repeat(64),
                None,
                &create_planned,
                "Create receipt",
            )
            .unwrap();
        let created = knowledge
            .create_document_for_expected_vault_with_receipt(
                &vault.id,
                &KnowledgeCreateInput {
                    title: "Created".to_owned(),
                    parent_relative_path: None,
                    content: "created once".to_owned(),
                },
            )
            .unwrap();
        assert_eq!(created.document.revision, create_planned);

        let append_ref = KnowledgeDocumentRef {
            vault_id: vault.id.clone(),
            relative_path: "Append.md".to_owned(),
        };
        let append_base = knowledge
            .create_document_for_expected_vault(
                &vault.id,
                &KnowledgeCreateInput {
                    title: "Append".to_owned(),
                    parent_relative_path: None,
                    content: "base\n".to_owned(),
                },
            )
            .unwrap();
        let append_planned = knowledge
            .preview_agent_append_revision(&append_ref, &append_base.revision, "delta\n")
            .unwrap();
        let append_token = format!("artifact-{}", "2".repeat(32));
        coordinator
            .prepare_artifact(
                &run.run_id,
                &append_token,
                "knowledge",
                &serde_json::to_string(&append_ref).unwrap(),
                &"2".repeat(64),
                Some(&append_base.revision),
                &append_planned,
                "Append receipt",
            )
            .unwrap();
        let appended = knowledge
            .append_document(&KnowledgeWriteInput {
                document_ref: append_ref.clone(),
                content: "delta\n".to_owned(),
                expected_revision: Some(append_base.revision),
            })
            .unwrap();
        assert_eq!(appended.document.revision, append_planned);

        let tags_ref = KnowledgeDocumentRef {
            vault_id: vault.id.clone(),
            relative_path: "Tags.md".to_owned(),
        };
        let tags_base = knowledge
            .create_document_for_expected_vault(
                &vault.id,
                &KnowledgeCreateInput {
                    title: "Tags".to_owned(),
                    parent_relative_path: None,
                    content: "# Tags\n".to_owned(),
                },
            )
            .unwrap();
        let tags = vec!["research".to_owned(), "durable".to_owned()];
        let tags_planned = knowledge
            .preview_agent_set_tags_revision(&tags_ref, &tags_base.revision, &tags)
            .unwrap();
        let tags_token = format!("artifact-{}", "3".repeat(32));
        coordinator
            .prepare_artifact(
                &run.run_id,
                &tags_token,
                "knowledge",
                &serde_json::to_string(&tags_ref).unwrap(),
                &"3".repeat(64),
                Some(&tags_base.revision),
                &tags_planned,
                "Tags receipt",
            )
            .unwrap();
        let tagged = knowledge
            .set_document_tags(&KnowledgeSetTagsInput {
                document_ref: tags_ref,
                expected_revision: tags_base.revision,
                tags,
            })
            .unwrap();
        assert_eq!(tagged.document.revision, tags_planned);

        let append_bytes_before = std::fs::read(vault_root.join("Append.md")).unwrap();
        let tags_bytes_before = std::fs::read(vault_root.join("Tags.md")).unwrap();
        coordinator
            .reconcile_knowledge_artifacts(&knowledge)
            .unwrap();
        for token in [&create_token, &append_token, &tags_token] {
            assert_eq!(
                coordinator.artifact_origin(token).unwrap().receipt_state,
                "committed"
            );
        }
        coordinator
            .reconcile_knowledge_artifacts(&knowledge)
            .unwrap();
        assert_eq!(
            std::fs::read(vault_root.join("Append.md")).unwrap(),
            append_bytes_before
        );
        assert_eq!(
            std::fs::read(vault_root.join("Tags.md")).unwrap(),
            tags_bytes_before
        );

        drop(knowledge);
        std::fs::remove_dir_all(app_data).unwrap();
        std::fs::remove_dir_all(vault_root).unwrap();
    }

    #[test]
    fn retention_caps_terminal_metadata_without_deleting_active_runs_or_messages() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE ai_conversation (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                 );
                 CREATE TABLE ai_message (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                 );
                 INSERT INTO ai_conversation(id,title,created_at,updated_at)
                 VALUES ('conversation-retention','Retention','now','now');
                 INSERT INTO ai_message(id,conversation_id,role,content,created_at)
                 VALUES ('message-retained','conversation-retention','assistant','safe result','now');",
            )
            .unwrap();
        RunCoordinator::apply_schema(&connection).unwrap();
        for index in 0..101 {
            connection
                .execute(
                    "INSERT INTO ai_run(
                       id,conversation_id,trigger_message_id,kind,execution_mode,policy_id,
                       status,phase,created_at,updated_at,terminal_at
                     ) VALUES (?1,'conversation-retention',?2,'research','background','research-v1',
                       'completed','completed',?3,?3,?3)",
                    rusqlite::params![
                        format!("run-terminal-{index:03}"),
                        format!("trigger-{index:03}"),
                        format!("2026-07-29T00:{:02}:00Z", index % 60)
                    ],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO ai_run(
                   id,conversation_id,trigger_message_id,kind,execution_mode,policy_id,
                   status,phase,created_at,updated_at
                 ) VALUES ('run-active','conversation-retention','trigger-active','research',
                   'background','research-v1','running','gathering','now','now')",
                [],
            )
            .unwrap();
        let coordinator = RunCoordinator::from_connection(connection);

        assert_eq!(coordinator.cleanup_retention().unwrap(), 1);
        coordinator
            .with_connection(|connection| {
                let terminal_count: u32 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM ai_run WHERE terminal_at IS NOT NULL",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                let active_count: u32 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM ai_run WHERE id='run-active' AND status='running'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                let message_count: u32 = connection
                    .query_row("SELECT COUNT(*) FROM ai_message", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(terminal_count, 100);
                assert_eq!(active_count, 1);
                assert_eq!(message_count, 1);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn workspace_artifacts_reconcile_by_digest_without_replay_or_fake_success() {
        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("app.db");
        let connection = Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE ai_conversation (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                 );
                 CREATE TABLE ai_message (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                 );
                 INSERT INTO ai_conversation(id,title,created_at,updated_at)
                 VALUES ('conversation-reconcile','Reconcile','now','now');
                 CREATE TABLE agent_workspace_grant (
                    id TEXT PRIMARY KEY, label TEXT NOT NULL, canonical_root TEXT NOT NULL,
                    root_name TEXT NOT NULL, root_digest TEXT NOT NULL, enabled INTEGER NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        RunCoordinator::apply_schema(&connection).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE ai_message_action_truth (
                    message_id TEXT PRIMARY KEY,
                    workspace_status TEXT NOT NULL,
                    execution_status TEXT NOT NULL,
                    created_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        drop(connection);
        let coordinator = RunCoordinator::from_connection(Connection::open(&db_path).unwrap());
        let workspace = crate::agent_workspace::WorkspaceGrantService::new(&db_path);
        let root_dir = tempfile::tempdir().unwrap();
        let notes = root_dir.path().join("notes.txt");
        std::fs::write(&notes, "original content").unwrap();
        let grant = workspace.add(root_dir.path(), "Reconcile Root").unwrap();

        let admission = coordinator
            .admit(RunAdmission {
                conversation_id: "conversation-reconcile".to_owned(),
                user_content: "reconcile fixture".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "d".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        coordinator
            .mark_running(&admission.run_id, "running")
            .unwrap();
        let planned_digest = {
            use sha2::Digest as _;
            format!("{:x}", sha2::Sha256::digest("patched content".as_bytes()))
        };
        let root_digest = workspace.read(&grant.id, "notes.txt").unwrap().root_digest;
        let locator = crate::agent_workspace::WorkspaceWriteLocator {
            grant_id: grant.id.clone(),
            relative_path: "notes.txt".to_owned(),
            root_digest,
        };
        let original_digest = {
            use sha2::Digest as _;
            format!("{:x}", sha2::Sha256::digest("original content".as_bytes()))
        };
        let no_write_public_token = format!("artifact-{}", "a".repeat(32));
        coordinator
            .prepare_artifact(
                &admission.run_id,
                &no_write_public_token,
                "workspace-file",
                &serde_json::to_string(&locator).unwrap(),
                &"e".repeat(64),
                Some(&original_digest),
                &planned_digest,
                "更新文件",
            )
            .unwrap();

        // Crash before the write: the prepared receipt is known no-write and
        // must disappear rather than becoming a permanently hanging artifact.
        coordinator
            .reconcile_workspace_artifacts(&workspace)
            .unwrap();
        assert_eq!(
            coordinator
                .artifact_origin(&no_write_public_token)
                .unwrap_err()
                .code,
            "agent-run-artifact-not-found",
            "a no-write recovery never replays or publishes an artifact"
        );

        // Crash after the write but before ledger settlement: the file
        // exactly matches the planned digest, so reconciliation projects a
        // committed warning (write1, receipt lost) and never rewrites.
        std::fs::write(&notes, "patched content").unwrap();
        let first_public_token = format!("artifact-{}", "d".repeat(32));
        let artifact_id = coordinator
            .prepare_artifact(
                &admission.run_id,
                &first_public_token,
                "workspace-file",
                &serde_json::to_string(&locator).unwrap(),
                &"e".repeat(64),
                Some(&original_digest),
                &planned_digest,
                "更新文件",
            )
            .unwrap();
        coordinator
            .reconcile_workspace_artifacts(&workspace)
            .unwrap();
        let probe = Connection::open(&db_path).unwrap();
        let artifact_status: String = probe
            .query_row(
                "SELECT status FROM ai_run_artifact WHERE id=?1",
                [&artifact_id],
                |row| row.get(0),
            )
            .unwrap();
        let run_warning: i64 = probe
            .query_row(
                "SELECT committed_warning FROM ai_run WHERE id=?1",
                [&admission.run_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(artifact_status, "committed-warning");
        assert_eq!(run_warning, 1);
        assert_eq!(
            std::fs::read_to_string(&notes).unwrap(),
            "patched content",
            "reconciliation never rewrites the file"
        );
        // Idempotent: a second pass does not change the settled receipt.
        coordinator
            .reconcile_workspace_artifacts(&workspace)
            .unwrap();
        let origin = coordinator.artifact_origin(&first_public_token).unwrap();
        assert_eq!(origin.receipt_state, "committed");

        // Create goes through the same Backend-owned private locator as a
        // patch: the model alias never reaches `entity_ref`, while the real
        // grant/root identity makes a post-file/pre-ledger crash reconcilable.
        let create_preview = workspace
            .create_text_preview(&grant.id, "created.txt", "created once\n")
            .unwrap();
        let create_binding = workspace.create_binding(
            &grant.id,
            "Safe Alias",
            "created.txt",
            &create_preview,
            [9u8; 32],
            "conversation-reconcile",
        );
        let create_locator = crate::agent_workspace::WorkspaceWriteLocator {
            grant_id: create_binding.grant_id.clone(),
            relative_path: create_binding.relative_path.clone(),
            root_digest: create_binding.root_digest.clone(),
        };
        let create_public_token = format!("artifact-{}", "e".repeat(32));
        coordinator
            .prepare_artifact(
                &admission.run_id,
                &create_public_token,
                "workspace-file",
                &serde_json::to_string(&create_locator).unwrap(),
                &"b".repeat(64),
                None,
                &create_preview.planned_digest,
                "创建文件",
            )
            .unwrap();
        workspace
            .commit_create_text(&create_binding, "created once\n")
            .unwrap();
        coordinator
            .reconcile_workspace_artifacts(&workspace)
            .unwrap();
        let create_origin = coordinator.artifact_origin(&create_public_token).unwrap();
        assert_eq!(create_origin.receipt_state, "committed");
        let create_status: String = Connection::open(&db_path)
            .unwrap()
            .query_row(
                "SELECT status FROM ai_run_artifact WHERE id=?1",
                [&create_origin.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(create_status, "committed-warning");
        assert!(
            !create_origin.entity_ref.contains("Safe Alias"),
            "the durable locator must retain only Backend identity"
        );

        // A file that matches neither the expected nor the planned digest is
        // uncertain, never a fake success.
        let second_public_token = format!("artifact-{}", "b".repeat(32));
        let _second_artifact = coordinator
            .prepare_artifact(
                &admission.run_id,
                &second_public_token,
                "workspace-file",
                &serde_json::to_string(&locator).unwrap(),
                &"f".repeat(64),
                Some(&original_digest),
                &planned_digest,
                "更新文件",
            )
            .unwrap();
        std::fs::write(&notes, "unrelated external content").unwrap();
        coordinator
            .reconcile_workspace_artifacts(&workspace)
            .unwrap();
        let origin = coordinator.artifact_origin(&second_public_token).unwrap();
        assert_eq!(origin.receipt_state, "uncertain");

        // A create-style locator (no expected revision) whose target never
        // appeared is also known not written, so the prepared receipt is
        // discarded instead of lingering in the artifact ledger.
        let third_public_token = format!("artifact-{}", "c".repeat(32));
        let _third_artifact = coordinator
            .prepare_artifact(
                &admission.run_id,
                &third_public_token,
                "workspace-file",
                &serde_json::to_string(&locator).unwrap(),
                &"a".repeat(64),
                None,
                &planned_digest,
                "创建文件",
            )
            .unwrap();
        std::fs::remove_file(&notes).unwrap();
        coordinator
            .reconcile_workspace_artifacts(&workspace)
            .unwrap();
        assert_eq!(
            coordinator
                .artifact_origin(&third_public_token)
                .unwrap_err()
                .code,
            "agent-run-artifact-not-found"
        );

        let admission_run_id = admission.run_id.clone();
        drop(admission.lease);
        assert_eq!(coordinator.reconcile_startup_terminals().unwrap(), 1);
        let terminal = coordinator.get(&admission_run_id).unwrap();
        assert_eq!(terminal.status, "failed");
        assert_eq!(
            terminal.safe_code.as_deref(),
            Some("agent-engine-workspace-write-uncertain")
        );
        assert!(terminal.result_message_id.is_some());
        let assistant = coordinator
            .list_messages("conversation-reconcile")
            .unwrap()
            .into_iter()
            .filter(|message| message.role == "assistant")
            .collect::<Vec<_>>();
        assert_eq!(assistant.len(), 1);
        assert_eq!(
            assistant[0].action_truth,
            Some(AgentActionTruth::new(
                WorkspaceActionTruth::Uncertain,
                ExecutionActionTruth::NotRequested,
            ))
        );
        assert_eq!(coordinator.reconcile_startup_terminals().unwrap(), 0);
        assert_eq!(
            coordinator.message_count("conversation-reconcile", "assistant"),
            1
        );
    }

    #[test]
    fn workspace_change_set_artifact_reconciles_each_private_locator_without_replaying_any_file() {
        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("app.db");
        let connection = Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE ai_conversation (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                 );
                 CREATE TABLE ai_message (
                    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
                 );
                 INSERT INTO ai_conversation(id,title,created_at,updated_at)
                 VALUES ('conversation-change-set','Change set','now','now');
                 CREATE TABLE agent_workspace_grant (
                    id TEXT PRIMARY KEY, label TEXT NOT NULL, canonical_root TEXT NOT NULL,
                    root_name TEXT NOT NULL, root_digest TEXT NOT NULL, enabled INTEGER NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        RunCoordinator::apply_schema(&connection).unwrap();
        drop(connection);
        let coordinator = RunCoordinator::from_connection(Connection::open(&db_path).unwrap());
        let workspace = crate::agent_workspace::WorkspaceGrantService::new(&db_path);
        let root_dir = tempfile::tempdir().unwrap();
        let patched = root_dir.path().join("notes.md");
        let created = root_dir.path().join("created.md");
        std::fs::write(&patched, "before\n").unwrap();
        let grant = workspace.add(root_dir.path(), "Change set root").unwrap();
        let root_digest = workspace.read(&grant.id, "notes.md").unwrap().root_digest;
        let digest = |value: &str| {
            use sha2::Digest as _;
            format!("{:x}", sha2::Sha256::digest(value.as_bytes()))
        };
        let original_digest = digest("before\n");
        let planned_patch = digest("after\n");
        let planned_create = digest("# Created\n");
        let locator = crate::agent_workspace::WorkspaceChangeSetLocator {
            version: 1,
            items: vec![
                crate::agent_workspace::WorkspaceChangeSetLocatorItem {
                    operation: "patch".to_owned(),
                    locator: crate::agent_workspace::WorkspaceWriteLocator {
                        grant_id: grant.id.clone(),
                        relative_path: "notes.md".to_owned(),
                        root_digest: root_digest.clone(),
                    },
                    expected_digest: Some(original_digest.clone()),
                    planned_digest: planned_patch.clone(),
                    open_token: format!("workspace-open-{}", "a".repeat(32)),
                },
                crate::agent_workspace::WorkspaceChangeSetLocatorItem {
                    operation: "create".to_owned(),
                    locator: crate::agent_workspace::WorkspaceWriteLocator {
                        grant_id: grant.id.clone(),
                        relative_path: "created.md".to_owned(),
                        root_digest,
                    },
                    expected_digest: None,
                    planned_digest: planned_create.clone(),
                    open_token: format!("workspace-open-{}", "b".repeat(32)),
                },
            ],
        };
        let admission = coordinator
            .admit(RunAdmission {
                conversation_id: "conversation-change-set".to_owned(),
                user_content: "change set crash fixture".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "d".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        coordinator
            .mark_running(&admission.run_id, "running")
            .unwrap();

        // A crash before the sequential writer reaches its first target is a
        // proved no-write set; the prepared receipt disappears, never replays.
        let no_write_token = format!("artifact-{}", "a".repeat(32));
        coordinator
            .prepare_artifact(
                &admission.run_id,
                &no_write_token,
                "workspace-change-set",
                &serde_json::to_string(&locator).unwrap(),
                &"e".repeat(64),
                Some(&original_digest),
                &"f".repeat(64),
                "应用多文件变更",
            )
            .unwrap();
        coordinator
            .reconcile_workspace_artifacts(&workspace)
            .unwrap();
        assert_eq!(
            coordinator
                .artifact_origin(&no_write_token)
                .unwrap_err()
                .code,
            "agent-run-artifact-not-found"
        );
        assert_eq!(std::fs::read_to_string(&patched).unwrap(), "before\n");
        assert!(!created.exists());

        // Both file writes happened, but the ledger was lost before commit.
        // Reconcile uses each private item digest, marks warning exactly once,
        // and never runs a writer itself.
        std::fs::write(&patched, "after\n").unwrap();
        std::fs::write(&created, "# Created\n").unwrap();
        let committed_token = format!("artifact-{}", "b".repeat(32));
        let artifact_id = coordinator
            .prepare_artifact(
                &admission.run_id,
                &committed_token,
                "workspace-change-set",
                &serde_json::to_string(&locator).unwrap(),
                &"e".repeat(64),
                Some(&original_digest),
                &"f".repeat(64),
                "应用多文件变更",
            )
            .unwrap();
        coordinator
            .reconcile_workspace_artifacts(&workspace)
            .unwrap();
        let status: String = Connection::open(&db_path)
            .unwrap()
            .query_row(
                "SELECT status FROM ai_run_artifact WHERE id=?1",
                [&artifact_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "committed-warning");
        assert_eq!(std::fs::read_to_string(&patched).unwrap(), "after\n");
        assert_eq!(std::fs::read_to_string(&created).unwrap(), "# Created\n");
        coordinator
            .reconcile_workspace_artifacts(&workspace)
            .unwrap();
        assert_eq!(
            coordinator
                .artifact_origin(&committed_token)
                .unwrap()
                .receipt_state,
            "committed",
            "a repeated startup pass is idempotent and does not replay the set"
        );

        // A mixed state stays an honest warning/partial truth; no subsequent
        // reconcile may fill in the missing file on the user's behalf.
        std::fs::remove_file(&created).unwrap();
        let partial_token = format!("artifact-{}", "c".repeat(32));
        let partial_id = coordinator
            .prepare_artifact(
                &admission.run_id,
                &partial_token,
                "workspace-change-set",
                &serde_json::to_string(&locator).unwrap(),
                &"e".repeat(64),
                Some(&original_digest),
                &"f".repeat(64),
                "应用多文件变更",
            )
            .unwrap();
        coordinator
            .reconcile_workspace_artifacts(&workspace)
            .unwrap();
        let partial_status: String = Connection::open(&db_path)
            .unwrap()
            .query_row(
                "SELECT status FROM ai_run_artifact WHERE id=?1",
                [&partial_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(partial_status, "committed-warning");
        assert!(
            !created.exists(),
            "partial reconciliation never recreates an absent file"
        );
    }
}
