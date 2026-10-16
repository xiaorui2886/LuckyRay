use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rand::RngCore;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::agent_runs::{AgentConversationMode, AgentConversationSummary};
use crate::agent_workspace::{WorkspaceError, WorkspaceGrantService};
use crate::knowledge::{KnowledgeRunScope, KnowledgeService, KnowledgeTargetIdentity};

const PROJECT_ID_MAX_BYTES: usize = 128;
const PROJECT_TITLE_MAX_BYTES: usize = 120;
const KNOWLEDGE_MANAGEMENT_REF_TTL: Duration = Duration::from_secs(10 * 60);
const KNOWLEDGE_MANAGEMENT_REF_LIMIT: usize = 512;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProjectSummary {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) primary_workspace_label: String,
    pub(crate) primary_workspace_root_name: String,
    pub(crate) sort_order: i64,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProjectCreateResult {
    pub(crate) project: AgentProjectSummary,
    pub(crate) conversation: AgentConversationSummary,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProjectKnowledgeTargetView {
    pub(crate) management_ref: String,
    pub(crate) label: String,
    pub(crate) selected: bool,
    pub(crate) status: AgentProjectKnowledgeTargetStatus,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AgentProjectKnowledgeTargetStatus {
    Available,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProjectKnowledgeAccessView {
    pub(crate) project_title: String,
    pub(crate) primary_workspace_label: String,
    pub(crate) primary_workspace_root_name: String,
    pub(crate) enabled: bool,
    pub(crate) targets: Vec<AgentProjectKnowledgeTargetView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) clear_management_ref: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProjectContextView {
    pub(crate) project_title: String,
    pub(crate) knowledge_enabled: bool,
    pub(crate) knowledge_usable: bool,
}

/// One immutable project authority snapshot captured under the same SQLite
/// write lock. Workspace and Knowledge remain separate capabilities, but a
/// run can never combine the folder from one project with the Knowledge grant
/// from another if the conversation is reassigned concurrently.
#[derive(Clone)]
pub(crate) struct AgentProjectRunAuthority {
    pub(crate) workspace_grant_id: Option<String>,
    pub(crate) knowledge_scope: KnowledgeRunScope,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentProjectError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl AgentProjectError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AgentProjectError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AgentProjectError {}

#[derive(Clone)]
pub(crate) struct AgentProjectService {
    db_path: PathBuf,
    workspace: WorkspaceGrantService,
    knowledge: KnowledgeService,
    knowledge_management: Arc<Mutex<ProjectKnowledgeManagementState>>,
}

#[derive(Clone)]
struct StoredKnowledgeBinding {
    target_id: String,
    identity_digest: String,
    label: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProjectKnowledgeManagementAction {
    Add,
    Remove,
    Clear,
}

#[derive(Clone)]
struct ProjectKnowledgeManagementBinding {
    project_id: String,
    target: Option<KnowledgeTargetIdentity>,
    expected_set_digest: String,
    action: ProjectKnowledgeManagementAction,
    issued_at: Instant,
}

#[derive(Default)]
struct ProjectKnowledgeManagementState {
    entries: HashMap<String, ProjectKnowledgeManagementBinding>,
}

impl AgentProjectService {
    pub(crate) fn new(
        db_path: impl Into<PathBuf>,
        workspace: WorkspaceGrantService,
        knowledge: KnowledgeService,
    ) -> Self {
        Self {
            db_path: db_path.into(),
            workspace,
            knowledge,
            knowledge_management: Arc::new(Mutex::new(ProjectKnowledgeManagementState::default())),
        }
    }

    pub(crate) fn list(&self) -> Result<Vec<AgentProjectSummary>, AgentProjectError> {
        let connection = self.open_read()?;
        let mut statement = connection
            .prepare(
                "SELECT p.id,p.title,
                        COALESCE(w.label,'工作区不可用'),
                        COALESCE(w.root_name,'工作区不可用'),
                        p.sort_order,p.created_at,p.updated_at
                 FROM agent_project p
                 LEFT JOIN agent_workspace_grant w
                   ON w.id=p.primary_workspace_grant_id
                 ORDER BY p.sort_order ASC,p.updated_at DESC,p.id ASC",
            )
            .map_err(|_| self.store_error())?;
        let rows = statement
            .query_map([], map_project)
            .map_err(|_| self.store_error())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| self.store_error())
    }

    pub(crate) fn get(&self, project_id: &str) -> Result<AgentProjectSummary, AgentProjectError> {
        validate_id(project_id)?;
        let connection = self.open_read()?;
        connection
            .query_row(
                "SELECT p.id,p.title,
                        COALESCE(w.label,'工作区不可用'),
                        COALESCE(w.root_name,'工作区不可用'),
                        p.sort_order,p.created_at,p.updated_at
                 FROM agent_project p
                 LEFT JOIN agent_workspace_grant w
                   ON w.id=p.primary_workspace_grant_id
                 WHERE p.id=?1",
                [project_id],
                map_project,
            )
            .optional()
            .map_err(|_| self.store_error())?
            .ok_or_else(|| AgentProjectError::new("agent-project-not-found", "项目不存在"))
    }

    pub(crate) fn create(
        &self,
        title: &str,
        primary_workspace_grant_id: &str,
    ) -> Result<AgentProjectSummary, AgentProjectError> {
        validate_title(title)?;
        validate_id(primary_workspace_grant_id)?;
        let id = format!("project-{}", random_id());
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| self.store_error())?;
        self.workspace
            .validate_enabled_grant_in_transaction(&transaction, primary_workspace_grant_id)
            .map_err(map_workspace_error)?;
        let sort_order: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(sort_order),-1)+1 FROM agent_project",
                [],
                |row| row.get(0),
            )
            .map_err(|_| self.store_error())?;
        transaction
            .execute(
                "INSERT INTO agent_project(
                     id,title,primary_workspace_grant_id,sort_order,created_at,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,?5)",
                params![
                    id,
                    title.trim(),
                    primary_workspace_grant_id,
                    sort_order,
                    now
                ],
            )
            .map_err(|_| self.store_error())?;
        transaction.commit().map_err(|_| self.store_error())?;
        self.get(&id)
    }

    pub(crate) fn create_with_conversation(
        &self,
        title: &str,
        primary_workspace_grant_id: &str,
    ) -> Result<AgentProjectCreateResult, AgentProjectError> {
        validate_title(title)?;
        validate_id(primary_workspace_grant_id)?;
        let project_id = format!("project-{}", random_id());
        let conversation_id = format!("conv-{}", random_id());
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| self.store_error())?;
        let grant = self
            .workspace
            .validate_enabled_grant_in_transaction(&transaction, primary_workspace_grant_id)
            .map_err(map_workspace_error)?;
        let sort_order: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(sort_order),-1)+1 FROM agent_project",
                [],
                |row| row.get(0),
            )
            .map_err(|_| self.store_error())?;
        transaction
            .execute(
                "INSERT INTO agent_project(
                     id,title,primary_workspace_grant_id,sort_order,created_at,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,?5)",
                params![
                    project_id,
                    title.trim(),
                    primary_workspace_grant_id,
                    sort_order,
                    now
                ],
            )
            .map_err(|_| self.store_error())?;
        transaction
            .execute(
                "INSERT INTO ai_conversation(
                     id,title,created_at,updated_at,agent_mode,project_id
                 ) VALUES (?1,'新对话',?2,?2,'project-task',?3)",
                params![conversation_id, now, project_id],
            )
            .map_err(|_| self.store_error())?;
        let project = AgentProjectSummary {
            id: project_id.clone(),
            title: title.trim().to_owned(),
            primary_workspace_label: grant.label,
            primary_workspace_root_name: grant.root_name,
            sort_order,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        let conversation = AgentConversationSummary {
            id: conversation_id,
            title: "新对话".to_owned(),
            created_at: now.clone(),
            updated_at: now,
            agent_mode: AgentConversationMode::ProjectTask.as_str().to_owned(),
            project_id: Some(project_id),
            pinned_at: None,
            archived_at: None,
        };
        transaction.commit().map_err(|_| self.store_error())?;
        Ok(AgentProjectCreateResult {
            project,
            conversation,
        })
    }

    pub(crate) fn update(
        &self,
        project_id: &str,
        title: &str,
        primary_workspace_grant_id: Option<&str>,
    ) -> Result<AgentProjectSummary, AgentProjectError> {
        validate_id(project_id)?;
        validate_title(title)?;
        if let Some(grant_id) = primary_workspace_grant_id {
            validate_id(grant_id)?;
        }
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| self.store_error())?;
        if let Some(grant_id) = primary_workspace_grant_id {
            self.workspace
                .validate_enabled_grant_in_transaction(&transaction, grant_id)
                .map_err(map_workspace_error)?;
        }
        let changed = if let Some(grant_id) = primary_workspace_grant_id {
            transaction
                .execute(
                    "UPDATE agent_project
                     SET title=?2,primary_workspace_grant_id=?3,updated_at=?4
                     WHERE id=?1",
                    params![project_id, title.trim(), grant_id, now],
                )
                .map_err(|_| self.store_error())?
        } else {
            transaction
                .execute(
                    "UPDATE agent_project SET title=?2,updated_at=?3 WHERE id=?1",
                    params![project_id, title.trim(), now],
                )
                .map_err(|_| self.store_error())?
        };
        if changed != 1 {
            return Err(AgentProjectError::new(
                "agent-project-not-found",
                "项目不存在",
            ));
        }
        transaction.commit().map_err(|_| self.store_error())?;
        self.get(project_id)
    }

    pub(crate) fn delete(&self, project_id: &str) -> Result<(), AgentProjectError> {
        validate_id(project_id)?;
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| self.store_error())?;
        let conversation_count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM ai_conversation WHERE project_id=?1",
                [project_id],
                |row| row.get(0),
            )
            .map_err(|_| self.store_error())?;
        if conversation_count > 0 {
            return Err(AgentProjectError::new(
                "agent-project-not-empty",
                "项目仍包含对话，不能永久删除",
            ));
        }
        let changed = transaction
            .execute("DELETE FROM agent_project WHERE id=?1", [project_id])
            .map_err(|_| self.store_error())?;
        if changed != 1 {
            return Err(AgentProjectError::new(
                "agent-project-not-found",
                "项目不存在",
            ));
        }
        transaction.commit().map_err(|_| self.store_error())
    }

    pub(crate) fn reorder(
        &self,
        project_ids: &[String],
    ) -> Result<Vec<AgentProjectSummary>, AgentProjectError> {
        let unique = project_ids.iter().collect::<HashSet<_>>();
        if unique.len() != project_ids.len()
            || project_ids.iter().any(|id| validate_id(id).is_err())
        {
            return Err(AgentProjectError::new(
                "agent-project-order-invalid",
                "项目排序无效",
            ));
        }
        let now = chrono::Utc::now().to_rfc3339();
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| self.store_error())?;
        let count: usize = transaction
            .query_row("SELECT COUNT(*) FROM agent_project", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|_| self.store_error())?
            .try_into()
            .map_err(|_| self.store_error())?;
        if count != project_ids.len() {
            return Err(AgentProjectError::new(
                "agent-project-order-invalid",
                "项目排序不完整",
            ));
        }
        for (sort_order, project_id) in project_ids.iter().enumerate() {
            transaction
                .execute(
                    "UPDATE agent_project SET sort_order=?2,updated_at=?3 WHERE id=?1",
                    params![project_id, sort_order as i64, now],
                )
                .map_err(|_| self.store_error())?;
        }
        transaction.commit().map_err(|_| self.store_error())?;
        self.list()
    }

    /// Resolves the single primary workspace grant for a project-task
    /// conversation. A legacy project-task row with NULL project_id remains an
    /// uncategorized conversation and intentionally resolves to no grant.
    #[cfg(test)]
    pub(crate) fn workspace_grant_for_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<Option<String>, AgentProjectError> {
        validate_id(conversation_id)?;
        let connection = self.open_read()?;
        connection
            .query_row(
                "SELECT p.primary_workspace_grant_id
                 FROM ai_conversation c
                 LEFT JOIN agent_project p ON p.id=c.project_id
                 WHERE c.id=?1 AND c.agent_mode='project-task'",
                [conversation_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| self.store_error())?
            .ok_or_else(|| {
                AgentProjectError::new("agent-project-conversation-not-found", "对话不存在")
            })
    }

    /// Returns a renderer-safe management snapshot. Real Vault ids, identity
    /// digests, roots and index locators remain only in the short-lived
    /// Backend bindings below.
    pub(crate) fn knowledge_access(
        &self,
        project_id: &str,
    ) -> Result<AgentProjectKnowledgeAccessView, AgentProjectError> {
        validate_id(project_id)?;
        let current_target = match self.knowledge.current_target_identity() {
            Ok(target) => Some(target),
            Err(error) if error.code == "knowledge-vault-required" => None,
            Err(error) => return Err(map_knowledge_error(error)),
        };
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| self.store_error())?;
        let project = transaction
            .query_row(
                "SELECT p.id,p.title,
                        COALESCE(w.label,'工作区不可用'),
                        COALESCE(w.root_name,'工作区不可用'),
                        p.sort_order,p.created_at,p.updated_at
                 FROM agent_project p
                 LEFT JOIN agent_workspace_grant w
                   ON w.id=p.primary_workspace_grant_id
                 WHERE p.id=?1",
                [project_id],
                map_project,
            )
            .optional()
            .map_err(|_| self.store_error())?
            .ok_or_else(|| AgentProjectError::new("agent-project-not-found", "项目不存在"))?;
        let bindings = load_knowledge_bindings(&transaction, project_id, self)?;
        transaction.commit().map_err(|_| self.store_error())?;
        for binding in &bindings {
            validate_knowledge_label(&binding.label)?;
        }
        let set_digest = knowledge_binding_set_digest(&bindings);
        let mut state = self
            .knowledge_management
            .lock()
            .map_err(|_| self.store_error())?;
        expire_knowledge_management_refs(&mut state);
        state
            .entries
            .retain(|_, item| item.project_id != project_id);

        let mut targets = Vec::with_capacity(bindings.len().saturating_add(1));
        for binding in &bindings {
            let available = current_target.as_ref().is_some_and(|current| {
                current.target_id == binding.target_id
                    && current.identity_digest == binding.identity_digest
            });
            let display_label = current_target
                .as_ref()
                .filter(|current| {
                    current.target_id == binding.target_id
                        && current.identity_digest == binding.identity_digest
                })
                .map(|current| current.label.clone())
                .unwrap_or_else(|| binding.label.clone());
            let target = KnowledgeTargetIdentity {
                target_id: binding.target_id.clone(),
                identity_digest: binding.identity_digest.clone(),
                label: binding.label.clone(),
            };
            let management_ref = issue_knowledge_management_ref(
                &mut state,
                project_id,
                Some(target),
                &set_digest,
                ProjectKnowledgeManagementAction::Remove,
            );
            targets.push(AgentProjectKnowledgeTargetView {
                management_ref,
                label: display_label,
                selected: true,
                status: if available {
                    AgentProjectKnowledgeTargetStatus::Available
                } else {
                    AgentProjectKnowledgeTargetStatus::Unavailable
                },
            });
        }
        if let Some(current) = current_target {
            let already_bound = bindings.iter().any(|binding| {
                binding.target_id == current.target_id
                    && binding.identity_digest == current.identity_digest
            });
            if !already_bound {
                let management_ref = issue_knowledge_management_ref(
                    &mut state,
                    project_id,
                    Some(current.clone()),
                    &set_digest,
                    ProjectKnowledgeManagementAction::Add,
                );
                targets.push(AgentProjectKnowledgeTargetView {
                    management_ref,
                    label: current.label,
                    selected: false,
                    status: AgentProjectKnowledgeTargetStatus::Available,
                });
            }
        }
        let clear_management_ref = (!bindings.is_empty()).then(|| {
            issue_knowledge_management_ref(
                &mut state,
                project_id,
                None,
                &set_digest,
                ProjectKnowledgeManagementAction::Clear,
            )
        });
        targets.sort_by(|left, right| {
            right
                .selected
                .cmp(&left.selected)
                .then_with(|| left.label.cmp(&right.label))
        });
        Ok(AgentProjectKnowledgeAccessView {
            project_title: project.title,
            primary_workspace_label: project.primary_workspace_label,
            primary_workspace_root_name: project.primary_workspace_root_name,
            enabled: !bindings.is_empty(),
            targets,
            clear_management_ref,
        })
    }

    /// Read-only Context projection. It deliberately issues no management
    /// reference and exposes no target id, root, identity digest or locator.
    pub(crate) fn context_view(
        &self,
        project_id: &str,
    ) -> Result<AgentProjectContextView, AgentProjectError> {
        validate_id(project_id)?;
        let current_target = match self.knowledge.current_target_identity() {
            Ok(target) => Some(target),
            Err(error) if error.code == "knowledge-vault-required" => None,
            Err(error) => return Err(map_knowledge_error(error)),
        };
        let connection = self.open_read()?;
        let project_title = connection
            .query_row(
                "SELECT title FROM agent_project WHERE id=?1",
                [project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| self.store_error())?
            .ok_or_else(|| AgentProjectError::new("agent-project-not-found", "项目不存在"))?;
        let knowledge_enabled = connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM agent_project_knowledge_binding WHERE project_id=?1
                 )",
                [project_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|_| self.store_error())?;
        let knowledge_usable = match current_target {
            Some(target) => connection
                .query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM agent_project_knowledge_binding
                       WHERE project_id=?1 AND knowledge_target_id=?2
                         AND target_identity_digest=?3
                     )",
                    params![project_id, target.target_id, target.identity_digest],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|_| self.store_error())?,
            None => false,
        };
        Ok(AgentProjectContextView {
            project_title,
            knowledge_enabled,
            knowledge_usable,
        })
    }

    pub(crate) fn set_knowledge_access(
        &self,
        project_id: &str,
        management_ref: &str,
        enabled: bool,
    ) -> Result<AgentProjectKnowledgeAccessView, AgentProjectError> {
        validate_id(project_id)?;
        let binding = {
            let mut state = self
                .knowledge_management
                .lock()
                .map_err(|_| self.store_error())?;
            expire_knowledge_management_refs(&mut state);
            state.entries.remove(management_ref).ok_or_else(|| {
                AgentProjectError::new(
                    "agent-project-knowledge-reference-invalid",
                    "知识库授权引用无效或已过期",
                )
            })?
        };
        if binding.project_id != project_id
            || matches!(binding.action, ProjectKnowledgeManagementAction::Add) != enabled
            || (binding.action == ProjectKnowledgeManagementAction::Clear && enabled)
        {
            return Err(AgentProjectError::new(
                "agent-project-knowledge-reference-invalid",
                "知识库授权引用与操作不匹配",
            ));
        }
        if binding.action == ProjectKnowledgeManagementAction::Add {
            let expected = binding.target.as_ref().ok_or_else(|| self.store_error())?;
            let current = self
                .knowledge
                .current_target_identity()
                .map_err(map_knowledge_error)?;
            if &current != expected {
                return Err(AgentProjectError::new(
                    "agent-project-knowledge-target-changed",
                    "当前知识库已变化，请重新读取项目授权",
                ));
            }
        }

        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| self.store_error())?;
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_project WHERE id=?1)",
                [project_id],
                |row| row.get(0),
            )
            .map_err(|_| self.store_error())?;
        if !exists {
            return Err(AgentProjectError::new(
                "agent-project-not-found",
                "项目不存在",
            ));
        }
        let current_bindings = load_knowledge_bindings(&transaction, project_id, self)?;
        if knowledge_binding_set_digest(&current_bindings) != binding.expected_set_digest {
            return Err(AgentProjectError::new(
                "agent-project-knowledge-reference-stale",
                "知识库授权已变化，请刷新后重试",
            ));
        }
        match binding.action {
            ProjectKnowledgeManagementAction::Add => {
                let target = binding.target.ok_or_else(|| self.store_error())?;
                transaction
                    .execute(
                        "INSERT INTO agent_project_knowledge_binding(
                             project_id,knowledge_target_id,target_identity_digest,target_label,created_at
                         ) VALUES (?1,?2,?3,?4,?5)
                         ON CONFLICT(project_id,knowledge_target_id) DO UPDATE SET
                             target_identity_digest=excluded.target_identity_digest,
                             target_label=excluded.target_label,
                             created_at=excluded.created_at",
                        params![
                            project_id,
                            target.target_id,
                            target.identity_digest,
                            target.label,
                            chrono::Utc::now().to_rfc3339(),
                        ],
                    )
                    .map_err(|_| AgentProjectError::new(
                        "agent-project-knowledge-conflict",
                        "知识库授权已变化，请刷新后重试",
                    ))?;
            }
            ProjectKnowledgeManagementAction::Remove => {
                let target = binding.target.ok_or_else(|| self.store_error())?;
                let changed = transaction
                    .execute(
                        "DELETE FROM agent_project_knowledge_binding
                         WHERE project_id=?1 AND knowledge_target_id=?2
                           AND target_identity_digest=?3",
                        params![project_id, target.target_id, target.identity_digest],
                    )
                    .map_err(|_| self.store_error())?;
                if changed != 1 {
                    return Err(AgentProjectError::new(
                        "agent-project-knowledge-reference-stale",
                        "知识库授权已变化，请刷新后重试",
                    ));
                }
            }
            ProjectKnowledgeManagementAction::Clear => {
                transaction
                    .execute(
                        "DELETE FROM agent_project_knowledge_binding WHERE project_id=?1",
                        [project_id],
                    )
                    .map_err(|_| self.store_error())?;
            }
        }
        transaction.commit().map_err(|_| self.store_error())?;
        self.knowledge_access(project_id)
    }

    /// Linearizes a project-task run admission against grant/revoke/delete.
    /// The returned scope is immutable and contains at most the current real
    /// Vault. A legacy NULL project and a project with no explicit binding both
    /// receive the same empty scope.
    #[cfg(test)]
    pub(crate) fn knowledge_scope_for_conversation(
        &self,
        conversation_id: &str,
        current_target: Option<&KnowledgeTargetIdentity>,
    ) -> Result<KnowledgeRunScope, AgentProjectError> {
        self.run_authority_for_conversation(conversation_id, current_target)
            .map(|authority| authority.knowledge_scope)
    }

    /// Resolves the persisted conversation -> project -> primary workspace and
    /// Knowledge bindings at one linearization point. A legacy project-task
    /// conversation with NULL project_id receives neither authority.
    pub(crate) fn run_authority_for_conversation(
        &self,
        conversation_id: &str,
        current_target: Option<&KnowledgeTargetIdentity>,
    ) -> Result<AgentProjectRunAuthority, AgentProjectError> {
        validate_id(conversation_id)?;
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| self.store_error())?;
        let (project_id, workspace_grant_id) = transaction
            .query_row(
                "SELECT c.project_id,p.primary_workspace_grant_id
                 FROM ai_conversation c
                 LEFT JOIN agent_project p ON p.id=c.project_id
                 WHERE c.id=?1 AND c.agent_mode='project-task'",
                [conversation_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| self.store_error())?
            .ok_or_else(|| {
                AgentProjectError::new("agent-project-conversation-not-found", "项目对话不存在")
            })?;
        if project_id.is_some() && workspace_grant_id.is_none() {
            return Err(AgentProjectError::new(
                "agent-project-workspace-unavailable",
                "项目文件夹不可用",
            ));
        }
        let allowed = match (project_id.as_deref(), current_target) {
            (Some(project_id), Some(target)) => transaction
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM agent_project_knowledge_binding
                         WHERE project_id=?1 AND knowledge_target_id=?2
                           AND target_identity_digest=?3
                     )",
                    params![project_id, target.target_id, target.identity_digest],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|_| self.store_error())?,
            _ => false,
        };
        transaction.commit().map_err(|_| self.store_error())?;
        if !allowed {
            return Ok(AgentProjectRunAuthority {
                workspace_grant_id,
                knowledge_scope: KnowledgeRunScope::empty(),
            });
        }
        let target = current_target.cloned().ok_or_else(|| self.store_error())?;
        if self
            .knowledge
            .current_target_identity()
            .map_err(map_knowledge_error)?
            != target
        {
            return Err(AgentProjectError::new(
                "agent-project-knowledge-target-changed",
                "当前知识库在运行准入期间发生变化",
            ));
        }
        Ok(AgentProjectRunAuthority {
            workspace_grant_id,
            knowledge_scope: KnowledgeRunScope::for_target(target),
        })
    }

    fn open_read(&self) -> Result<Connection, AgentProjectError> {
        open_connection(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }

    fn open_write(&self) -> Result<Connection, AgentProjectError> {
        open_connection(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }

    fn store_error(&self) -> AgentProjectError {
        AgentProjectError::new("agent-project-store-unavailable", "项目存储不可用")
    }
}

fn map_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentProjectSummary> {
    Ok(AgentProjectSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        primary_workspace_label: row.get(2)?,
        primary_workspace_root_name: row.get(3)?,
        sort_order: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn validate_id(value: &str) -> Result<(), AgentProjectError> {
    if value.is_empty()
        || value.as_bytes().len() > PROJECT_ID_MAX_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(AgentProjectError::new(
            "agent-project-invalid",
            "项目标识无效",
        ));
    }
    Ok(())
}

fn validate_title(value: &str) -> Result<(), AgentProjectError> {
    let value = value.trim();
    if value.is_empty()
        || value.as_bytes().len() > PROJECT_TITLE_MAX_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(AgentProjectError::new(
            "agent-project-invalid",
            "项目名称无效",
        ));
    }
    Ok(())
}

fn map_workspace_error(error: WorkspaceError) -> AgentProjectError {
    AgentProjectError::new(error.code, error.message)
}

fn map_knowledge_error(error: crate::knowledge::KnowledgeError) -> AgentProjectError {
    AgentProjectError::new(error.code, error.message)
}

fn validate_knowledge_label(value: &str) -> Result<(), AgentProjectError> {
    let value = value.trim();
    if value.is_empty() || value.as_bytes().len() > 120 || value.chars().any(char::is_control) {
        return Err(AgentProjectError::new(
            "agent-project-knowledge-target-invalid",
            "知识库名称无效",
        ));
    }
    Ok(())
}

fn load_knowledge_bindings(
    connection: &Connection,
    project_id: &str,
    service: &AgentProjectService,
) -> Result<Vec<StoredKnowledgeBinding>, AgentProjectError> {
    let mut statement = connection
        .prepare(
            "SELECT knowledge_target_id,target_identity_digest,target_label
             FROM agent_project_knowledge_binding WHERE project_id=?1
             ORDER BY knowledge_target_id",
        )
        .map_err(|_| service.store_error())?;
    let bindings = statement
        .query_map([project_id], |row| {
            Ok(StoredKnowledgeBinding {
                target_id: row.get(0)?,
                identity_digest: row.get(1)?,
                label: row.get(2)?,
            })
        })
        .map_err(|_| service.store_error())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| service.store_error())?;
    Ok(bindings)
}

fn knowledge_binding_set_digest(bindings: &[StoredKnowledgeBinding]) -> String {
    let mut tuples = bindings
        .iter()
        .map(|binding| format!("{}\0{}", binding.target_id, binding.identity_digest))
        .collect::<Vec<_>>();
    tuples.sort();
    format!(
        "{:x}",
        Sha256::digest(
            [
                b"luckyray-project-knowledge-binding-set-v1\0".as_slice(),
                tuples.join("\0").as_bytes(),
            ]
            .concat(),
        )
    )
}

fn expire_knowledge_management_refs(state: &mut ProjectKnowledgeManagementState) {
    let now = Instant::now();
    state.entries.retain(|_, binding| {
        now.saturating_duration_since(binding.issued_at) <= KNOWLEDGE_MANAGEMENT_REF_TTL
    });
    if state.entries.len() > KNOWLEDGE_MANAGEMENT_REF_LIMIT {
        let mut oldest = state
            .entries
            .iter()
            .map(|(reference, binding)| (reference.clone(), binding.issued_at))
            .collect::<Vec<_>>();
        oldest.sort_by_key(|(_, issued_at)| *issued_at);
        for (reference, _) in oldest
            .into_iter()
            .take(state.entries.len() - KNOWLEDGE_MANAGEMENT_REF_LIMIT)
        {
            state.entries.remove(&reference);
        }
    }
}

fn issue_knowledge_management_ref(
    state: &mut ProjectKnowledgeManagementState,
    project_id: &str,
    target: Option<KnowledgeTargetIdentity>,
    expected_set_digest: &str,
    action: ProjectKnowledgeManagementAction,
) -> String {
    let reference = format!("project-knowledge-ref-{}", random_id());
    state.entries.insert(
        reference.clone(),
        ProjectKnowledgeManagementBinding {
            project_id: project_id.to_owned(),
            target,
            expected_set_digest: expected_set_digest.to_owned(),
            action,
            issued_at: Instant::now(),
        },
    );
    expire_knowledge_management_refs(state);
    reference
}

fn open_connection(path: &Path, flags: OpenFlags) -> Result<Connection, AgentProjectError> {
    let connection = Connection::open_with_flags(path, flags)
        .map_err(|_| AgentProjectError::new("agent-project-store-unavailable", "项目存储不可用"))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| AgentProjectError::new("agent-project-store-unavailable", "项目存储不可用"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|_| AgentProjectError::new("agent-project-store-unavailable", "项目存储不可用"))?;
    Ok(connection)
}

fn random_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::BackendServices;
    use crate::knowledge::{KnowledgeDocumentRef, KnowledgeVaultRegistration};
    use crate::tools::{ToolCallContext, ToolRunRequest};
    use std::sync::Arc;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "luckyray-d3-project-knowledge-{label}-{}",
            random_id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn vault(label: &str) -> (PathBuf, KnowledgeVaultRegistration) {
        let root = temp_dir(label);
        std::fs::create_dir_all(root.join(".luckyray")).unwrap();
        let registration = KnowledgeVaultRegistration {
            id: format!("vault-{}", random_id()),
            name: format!("知识库 {label}"),
            root_path: root.to_string_lossy().into_owned(),
            mode: "vault-bound".to_owned(),
            created_at: chrono::Utc::now().to_rfc3339(),
            last_opened_at: chrono::Utc::now().to_rfc3339(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        std::fs::write(
            root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&registration).unwrap(),
        )
        .unwrap();
        (root, registration)
    }

    #[test]
    fn project_knowledge_access_is_explicit_isolated_revocable_and_frozen() {
        let app_data = temp_dir("app");
        let workspace_root = temp_dir("workspace");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let workspace = backend
            .workspace()
            .add(&workspace_root, "项目文件夹")
            .unwrap();
        let (root_a, vault_a) = vault("A");
        let (root_b, vault_b) = vault("B");

        backend
            .knowledge()
            .register_current_vault(&vault_a)
            .unwrap();
        let project_a = backend
            .projects()
            .create_with_conversation("项目 A", &workspace.id)
            .unwrap();
        let project_b = backend
            .projects()
            .create_with_conversation("项目 B", &workspace.id)
            .unwrap();

        let initial_a = backend
            .projects()
            .knowledge_access(&project_a.project.id)
            .unwrap();
        let initial_context = backend
            .projects()
            .context_view(&project_a.project.id)
            .unwrap();
        assert_eq!(initial_context.project_title, "项目 A");
        assert!(!initial_context.knowledge_enabled);
        assert!(!initial_context.knowledge_usable);
        assert!(!initial_a.enabled);
        assert_eq!(initial_a.targets.len(), 1);
        assert!(!initial_a.targets[0].selected);
        assert_eq!(
            initial_a.targets[0].status,
            AgentProjectKnowledgeTargetStatus::Available
        );
        let public_json = serde_json::to_string(&initial_a).unwrap();
        for forbidden in [
            vault_a.id.as_str(),
            vault_a.root_path.as_str(),
            "knowledgeTargetId",
            "targetIdentityDigest",
            "createdAt",
            "updatedAt",
            "indexLocator",
        ] {
            assert!(
                !public_json.contains(forbidden),
                "renderer-safe project Knowledge DTO leaked {forbidden}"
            );
        }
        let initial_b = backend
            .projects()
            .knowledge_access(&project_b.project.id)
            .unwrap();
        let cross_project = backend.projects().set_knowledge_access(
            &project_a.project.id,
            &initial_b.targets[0].management_ref,
            true,
        );
        assert_eq!(
            cross_project.unwrap_err().code,
            "agent-project-knowledge-reference-invalid"
        );
        let enabled_a = backend
            .projects()
            .set_knowledge_access(
                &project_a.project.id,
                &initial_a.targets[0].management_ref,
                true,
            )
            .unwrap();
        assert!(enabled_a.enabled);
        assert!(enabled_a.targets[0].selected);
        let enabled_context = backend
            .projects()
            .context_view(&project_a.project.id)
            .unwrap();
        assert!(enabled_context.knowledge_enabled);
        assert!(enabled_context.knowledge_usable);
        let context_json = serde_json::to_string(&enabled_context).unwrap();
        for forbidden in [
            "managementRef",
            vault_a.id.as_str(),
            vault_a.root_path.as_str(),
            "digest",
            "locator",
        ] {
            assert!(!context_json.contains(forbidden));
        }

        let target_a = backend.knowledge().current_target_identity().unwrap();
        let frozen_a = backend
            .projects()
            .knowledge_scope_for_conversation(&project_a.conversation.id, Some(&target_a))
            .unwrap();
        assert!(frozen_a.allows(&target_a));
        let frozen_b_without_grant = backend
            .projects()
            .knowledge_scope_for_conversation(&project_b.conversation.id, Some(&target_a))
            .unwrap();
        assert!(!frozen_b_without_grant.allows(&target_a));

        backend
            .knowledge()
            .register_current_vault(&vault_b)
            .unwrap();
        let target_b = backend.knowledge().current_target_identity().unwrap();
        assert!(
            !frozen_a.allows(&target_b),
            "a frozen run never expands after a Vault switch"
        );
        let view_b = backend
            .projects()
            .knowledge_access(&project_b.project.id)
            .unwrap();
        let current_b = view_b
            .targets
            .iter()
            .find(|target| target.status == AgentProjectKnowledgeTargetStatus::Available)
            .unwrap();
        let stale_target_ref = current_b.management_ref.clone();
        backend
            .knowledge()
            .register_current_vault(&vault_a)
            .unwrap();
        let changed_target =
            backend
                .projects()
                .set_knowledge_access(&project_b.project.id, &stale_target_ref, true);
        assert_eq!(
            changed_target.unwrap_err().code,
            "agent-project-knowledge-target-changed"
        );
        backend
            .knowledge()
            .register_current_vault(&vault_b)
            .unwrap();
        let refreshed_b = backend
            .projects()
            .knowledge_access(&project_b.project.id)
            .unwrap();
        let current_b = refreshed_b
            .targets
            .iter()
            .find(|target| target.status == AgentProjectKnowledgeTargetStatus::Available)
            .unwrap();
        backend
            .projects()
            .set_knowledge_access(&project_b.project.id, &current_b.management_ref, true)
            .unwrap();
        let admitted_b = backend
            .projects()
            .knowledge_scope_for_conversation(&project_b.conversation.id, Some(&target_b))
            .unwrap();
        assert!(admitted_b.allows(&target_b));
        assert!(!admitted_b.allows(&target_a));

        let view_a = backend
            .projects()
            .knowledge_access(&project_a.project.id)
            .unwrap();
        let clear_ref = view_a.clear_management_ref.as_deref().unwrap();
        let cleared = backend
            .projects()
            .set_knowledge_access(&project_a.project.id, clear_ref, false)
            .unwrap();
        assert!(!cleared.enabled);
        assert!(
            frozen_a.allows(&target_a),
            "revocation does not mutate an admitted run"
        );

        let stale = backend.projects().set_knowledge_access(
            &project_a.project.id,
            &initial_a.targets[0].management_ref,
            true,
        );
        assert_eq!(
            stale.unwrap_err().code,
            "agent-project-knowledge-reference-invalid"
        );

        std::fs::remove_file(app_data.join("notes-vault-current.json")).unwrap();
        let unavailable = backend
            .projects()
            .knowledge_access(&project_b.project.id)
            .unwrap();
        assert!(unavailable.enabled);
        assert!(unavailable.targets.iter().any(|target| {
            target.selected && target.status == AgentProjectKnowledgeTargetStatus::Unavailable
        }));
        assert!(!backend
            .projects()
            .knowledge_scope_for_conversation(&project_b.conversation.id, None)
            .unwrap()
            .allows(&target_b));

        std::fs::write(app_data.join("notes-vault-current.json"), b"{").unwrap();
        let malformed = backend
            .projects()
            .knowledge_access(&project_a.project.id)
            .unwrap_err();
        assert_eq!(malformed.code, "knowledge-vault-registry-invalid");

        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
        std::fs::remove_dir_all(workspace_root).unwrap();
        std::fs::remove_dir_all(root_a).unwrap();
        std::fs::remove_dir_all(root_b).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn same_path_vault_replacement_requires_explicit_reauthorization_before_next_run() {
        let app_data = temp_dir("same-path-app");
        let workspace_root = temp_dir("same-path-workspace");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let workspace = backend
            .workspace()
            .add(&workspace_root, "项目文件夹")
            .unwrap();
        let (vault_root, registration) = vault("same-path");
        std::fs::write(vault_root.join("original.md"), "original-root-marker").unwrap();
        backend
            .knowledge()
            .register_current_vault(&registration)
            .unwrap();
        let project = backend
            .projects()
            .create_with_conversation("同路径替换", &workspace.id)
            .unwrap();
        let initial = backend
            .projects()
            .knowledge_access(&project.project.id)
            .unwrap();
        backend
            .projects()
            .set_knowledge_access(
                &project.project.id,
                &initial.targets[0].management_ref,
                true,
            )
            .unwrap();
        let target_a = backend.knowledge().current_target_identity().unwrap();
        let admitted_a = backend
            .projects()
            .run_authority_for_conversation(&project.conversation.id, Some(&target_a))
            .unwrap();
        let context_a = ToolCallContext::agent_read([73; 32])
            .with_knowledge_scope(Arc::new(admitted_a.knowledge_scope.clone()));

        std::fs::remove_dir_all(&vault_root).unwrap();
        std::fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        std::fs::write(
            vault_root.join("replacement.md"),
            "replacement-root-marker-only",
        )
        .unwrap();
        std::fs::write(
            vault_root.join(".luckyray").join("vault.json"),
            serde_json::to_vec_pretty(&registration).unwrap(),
        )
        .unwrap();
        backend
            .knowledge()
            .register_current_vault(&registration)
            .unwrap();
        let target_b = backend.knowledge().current_target_identity().unwrap();
        assert_eq!(target_b.target_id, target_a.target_id);
        assert_ne!(target_b.identity_digest, target_a.identity_digest);

        let unavailable = backend
            .projects()
            .knowledge_access(&project.project.id)
            .unwrap();
        assert!(unavailable.targets.iter().any(|target| {
            target.selected && target.status == AgentProjectKnowledgeTargetStatus::Unavailable
        }));
        let future_before_reauthorization = backend
            .projects()
            .run_authority_for_conversation(&project.conversation.id, Some(&target_b))
            .unwrap();
        assert!(!future_before_reauthorization
            .knowledge_scope
            .allows(&target_b));
        assert!(backend
            .list_tools(&context_a)
            .unwrap()
            .iter()
            .all(|tool| !tool.id().starts_with("knowledge.")));
        let denied_search = backend
            .run_tool(
                &context_a,
                ToolRunRequest::read(
                    "knowledge.search".to_owned(),
                    serde_json::json!({"query":"replacement-root-marker-only"}),
                ),
            )
            .unwrap_err();
        let denied_read = backend
            .run_tool(
                &context_a,
                ToolRunRequest::read(
                    "knowledge.read".to_owned(),
                    serde_json::json!({
                        "documentRef": KnowledgeDocumentRef {
                            vault_id: registration.id.clone(),
                            relative_path: "replacement.md".to_owned(),
                        }
                    }),
                ),
            )
            .unwrap_err();
        let denied_text = format!("{denied_search:?}{denied_read:?}");
        assert!(!denied_text.contains("replacement-root-marker-only"));

        let current = unavailable
            .targets
            .iter()
            .find(|target| {
                !target.selected && target.status == AgentProjectKnowledgeTargetStatus::Available
            })
            .expect("replacement target requires an explicit new authorization");
        backend
            .projects()
            .set_knowledge_access(&project.project.id, &current.management_ref, true)
            .unwrap();
        assert!(backend
            .list_tools(&context_a)
            .unwrap()
            .iter()
            .all(|tool| !tool.id().starts_with("knowledge.")));

        let admitted_b = backend
            .projects()
            .run_authority_for_conversation(&project.conversation.id, Some(&target_b))
            .unwrap();
        assert_eq!(
            admitted_b.workspace_grant_id.as_deref(),
            Some(workspace.id.as_str())
        );
        assert!(admitted_b.knowledge_scope.allows(&target_b));
        let context_b = ToolCallContext::agent_read([74; 32])
            .with_knowledge_scope(Arc::new(admitted_b.knowledge_scope));
        let result = backend
            .run_tool(
                &context_b,
                ToolRunRequest::read(
                    "knowledge.search".to_owned(),
                    serde_json::json!({"query":"replacement-root-marker-only"}),
                ),
            )
            .unwrap();
        assert!(serde_json::to_string(result.result())
            .unwrap()
            .contains("replacement-root-marker-only"));

        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
        std::fs::remove_dir_all(workspace_root).unwrap();
        std::fs::remove_dir_all(vault_root).unwrap();
    }

    #[test]
    fn deleting_a_project_cascades_knowledge_bindings_and_stale_refs_cannot_reauthorize() {
        let app_data = temp_dir("delete-cascade-app");
        let workspace_root = temp_dir("delete-cascade-workspace");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let workspace = backend
            .workspace()
            .add(&workspace_root, "项目文件夹")
            .unwrap();
        let (vault_root, registered) = vault("delete-cascade");
        backend
            .knowledge()
            .register_current_vault(&registered)
            .unwrap();
        let project = backend
            .projects()
            .create("待删除项目", &workspace.id)
            .unwrap();
        let access = backend.projects().knowledge_access(&project.id).unwrap();
        let granted = backend
            .projects()
            .set_knowledge_access(&project.id, &access.targets[0].management_ref, true)
            .unwrap();
        let stale_remove_ref = granted.targets[0].management_ref.clone();
        assert_eq!(
            backend
                .open_read()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM agent_project_knowledge_binding WHERE project_id=?1",
                    [&project.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );

        backend.projects().delete(&project.id).unwrap();
        assert_eq!(
            backend
                .open_read()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM agent_project_knowledge_binding WHERE project_id=?1",
                    [&project.id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        let stale = backend
            .projects()
            .set_knowledge_access(&project.id, &stale_remove_ref, false)
            .unwrap_err();
        assert_eq!(stale.code, "agent-project-not-found");
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
        std::fs::remove_dir_all(workspace_root).unwrap();
        std::fs::remove_dir_all(vault_root).unwrap();
    }

    #[test]
    fn run_admission_and_revoke_linearize_while_the_admitted_scope_stays_frozen() {
        let app_data = temp_dir("admission-revoke-app");
        let workspace_root = temp_dir("admission-revoke-workspace");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let workspace = backend
            .workspace()
            .add(&workspace_root, "项目文件夹")
            .unwrap();
        let (vault_root, registered) = vault("admission-revoke");
        backend
            .knowledge()
            .register_current_vault(&registered)
            .unwrap();
        let created = backend
            .projects()
            .create_with_conversation("并发项目", &workspace.id)
            .unwrap();
        let access = backend
            .projects()
            .knowledge_access(&created.project.id)
            .unwrap();
        backend
            .projects()
            .set_knowledge_access(&created.project.id, &access.targets[0].management_ref, true)
            .unwrap();
        let remove = backend
            .projects()
            .knowledge_access(&created.project.id)
            .unwrap()
            .targets
            .into_iter()
            .find(|target| target.selected)
            .unwrap()
            .management_ref;
        let target = backend.knowledge().current_target_identity().unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let admission_service = backend.projects();
        let admission_barrier = barrier.clone();
        let admission_conversation = created.conversation.id.clone();
        let admission_target = target.clone();
        let admission = std::thread::spawn(move || {
            admission_barrier.wait();
            admission_service
                .knowledge_scope_for_conversation(&admission_conversation, Some(&admission_target))
                .unwrap()
        });
        let revoke_service = backend.projects();
        let revoke_barrier = barrier.clone();
        let revoke_project = created.project.id.clone();
        let revoke = std::thread::spawn(move || {
            revoke_barrier.wait();
            revoke_service
                .set_knowledge_access(&revoke_project, &remove, false)
                .unwrap()
        });
        barrier.wait();
        let admitted = admission.join().unwrap();
        let revoked = revoke.join().unwrap();
        assert!(!revoked.enabled);
        let admitted_before_revoke = admitted.allows(&target);
        let expected_digest = if admitted_before_revoke {
            KnowledgeRunScope::for_target(target.clone())
                .digest()
                .to_owned()
        } else {
            KnowledgeRunScope::empty().digest().to_owned()
        };
        assert_eq!(
            admitted.digest(),
            expected_digest,
            "the race produces one complete pre- or post-revoke snapshot"
        );
        let next = backend
            .projects()
            .knowledge_scope_for_conversation(&created.conversation.id, Some(&target))
            .unwrap();
        assert!(
            !next.allows(&target),
            "the next run observes the committed revoke"
        );

        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
        std::fs::remove_dir_all(workspace_root).unwrap();
        std::fs::remove_dir_all(vault_root).unwrap();
    }

    #[test]
    fn conversation_project_move_cannot_mix_workspace_and_knowledge_authority() {
        let app_data = temp_dir("conversation-move-app");
        let workspace_a_root = temp_dir("conversation-move-workspace-a");
        let workspace_b_root = temp_dir("conversation-move-workspace-b");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let workspace_a = backend
            .workspace()
            .add(&workspace_a_root, "项目文件夹 A")
            .unwrap();
        let workspace_b = backend
            .workspace()
            .add(&workspace_b_root, "项目文件夹 B")
            .unwrap();
        let (vault_root, registered) = vault("conversation-move");
        backend
            .knowledge()
            .register_current_vault(&registered)
            .unwrap();
        let project_a = backend
            .projects()
            .create("项目 A", &workspace_a.id)
            .unwrap();
        let project_b = backend
            .projects()
            .create("项目 B", &workspace_b.id)
            .unwrap();
        let conversation = backend
            .agent_runs()
            .create_project_conversation_in_project("项目任务", &project_a.id)
            .unwrap();
        let access_a = backend.projects().knowledge_access(&project_a.id).unwrap();
        backend
            .projects()
            .set_knowledge_access(&project_a.id, &access_a.targets[0].management_ref, true)
            .unwrap();
        let target = backend.knowledge().current_target_identity().unwrap();

        let barrier = Arc::new(std::sync::Barrier::new(3));
        let admission_service = backend.projects();
        let admission_barrier = barrier.clone();
        let admission_conversation = conversation.id.clone();
        let admission_target = target.clone();
        let admitted = std::thread::spawn(move || {
            admission_barrier.wait();
            admission_service
                .run_authority_for_conversation(&admission_conversation, Some(&admission_target))
                .unwrap()
        });
        let move_barrier = barrier.clone();
        let move_db_path = app_data.join("luckyray.db");
        let move_conversation = conversation.id.clone();
        let move_project = project_b.id.clone();
        let moved = std::thread::spawn(move || {
            let mut connection = Connection::open(move_db_path).unwrap();
            connection.busy_timeout(Duration::from_secs(5)).unwrap();
            move_barrier.wait();
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            assert_eq!(
                transaction
                    .execute(
                        "UPDATE ai_conversation SET project_id=?2 WHERE id=?1",
                        params![move_conversation, move_project],
                    )
                    .unwrap(),
                1
            );
            transaction.commit().unwrap();
        });
        barrier.wait();
        let authority = admitted.join().unwrap();
        moved.join().unwrap();
        match authority.workspace_grant_id.as_deref() {
            Some(grant_id) if grant_id == workspace_a.id => {
                assert!(authority.knowledge_scope.allows(&target));
            }
            Some(grant_id) if grant_id == workspace_b.id => {
                assert!(!authority.knowledge_scope.allows(&target));
            }
            other => panic!("unexpected project authority snapshot: {other:?}"),
        }
        let next = backend
            .projects()
            .run_authority_for_conversation(&conversation.id, Some(&target))
            .unwrap();
        assert_eq!(
            next.workspace_grant_id.as_deref(),
            Some(workspace_b.id.as_str())
        );
        assert!(!next.knowledge_scope.allows(&target));

        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
        std::fs::remove_dir_all(workspace_a_root).unwrap();
        std::fs::remove_dir_all(workspace_b_root).unwrap();
        std::fs::remove_dir_all(vault_root).unwrap();
    }
}
