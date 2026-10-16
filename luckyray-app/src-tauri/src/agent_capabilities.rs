use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::tools::{ToolDefinition, ToolRisk};

const REGISTRY_SCHEMA_VERSION: u32 = 1;
pub(crate) const CAPABILITY_GENERATION_SINGLETON: i64 = 1;

const PUBLIC_PACKS: &[CapabilityPackSeed] = &[
    CapabilityPackSeed {
        id: "web-research",
        title: "网页研究",
        description: "搜索公开网页并在隔离的只读 Agent Browser 中读取动态页面。",
        data_scope: "公开网页与本次 Agent Browser 会话",
        permission_level: "只读网络",
        source: "内置能力",
        default_enabled: true,
    },
    CapabilityPackSeed {
        id: "memory",
        title: "记忆",
        description: "在全局或当前知识库范围检索跨会话简短上下文；任何变更都需要明确预览与批准。",
        data_scope: "全局或当前知识库",
        permission_level: "读取；写入需批准",
        source: "内置能力",
        default_enabled: true,
    },
    CapabilityPackSeed {
        id: "skills",
        title: "技能",
        description: "按需查看受审计的技能内容；创建或修改会生成不可变版本并请求批准。",
        data_scope: "应用内置技能目录",
        permission_level: "读取；变更需批准",
        source: "内置能力",
        default_enabled: true,
    },
    CapabilityPackSeed {
        id: "materials",
        title: "素材库",
        description: "检查、预览和引用素材；标签、分类或授权导入需要批准。",
        data_scope: "LuckyRay 素材库",
        permission_level: "读取；变更需批准",
        source: "内置能力",
        default_enabled: true,
    },
    CapabilityPackSeed {
        id: "workspace",
        title: "工作区文件",
        description: "在用户明确授权的根内读取文本文件；可提交有界的创建和修改变更集，任何写入都需要完整预览与批准。",
        data_scope: "用户授权根",
        permission_level: "读取；写入需批准",
        source: "内置能力",
        default_enabled: true,
    },
    CapabilityPackSeed {
        id: "execution",
        title: "项目检查",
        description: "仅运行 LuckyRay 内置的只读项目清单检查；不会执行项目脚本、安装依赖或访问网络。",
        data_scope: "用户授权项目根",
        permission_level: "每次运行需确认",
        source: "LuckyRay 内置检查",
        default_enabled: true,
    },
    CapabilityPackSeed {
        id: "schedules",
        title: "定时任务",
        description: "管理应用存活期间的后台任务；每次触发都创建新的后台运行。",
        data_scope: "应用自有调度记录",
        permission_level: "读取；变更需批准",
        source: "内置能力",
        default_enabled: true,
    },
];

const INTERNAL_PACKS: &[CapabilityPackSeed] = &[
    CapabilityPackSeed {
        id: "knowledge",
        title: "知识库",
        description: "检索当前 Vault；知识写入继续使用既有审批与 revision CAS。",
        data_scope: "当前 Vault",
        permission_level: "读取；写入需批准",
        source: "LuckyRay KnowledgeService",
        default_enabled: true,
    },
    CapabilityPackSeed {
        id: "canvas-compat",
        title: "Canvas compatibility",
        description: "Compatibility pack for the retained Canvas capability records.",
        data_scope: "Current Canvas",
        permission_level: "Existing Canvas policy",
        source: "LuckyRay CanvasAgent",
        default_enabled: true,
    },
    CapabilityPackSeed {
        id: "legacy-capability",
        title: "Legacy capability bridge",
        description: "Compatibility bridge for existing app-owned local capabilities.",
        data_scope: "Current Vault",
        permission_level: "Existing capability policy",
        source: "LuckyRay",
        default_enabled: true,
    },
];

#[derive(Clone, Copy)]
struct CapabilityPackSeed {
    id: &'static str,
    title: &'static str,
    description: &'static str,
    data_scope: &'static str,
    permission_level: &'static str,
    source: &'static str,
    default_enabled: bool,
}

/// Project a pack to its product-facing user state and a fixed safe next
/// action id. The action id is an enum, never a tool id, grant id, revision,
/// digest, safe code or service class name.
fn pack_user_state(
    seed: &CapabilityPackSeed,
    enabled: bool,
    requires_configuration: bool,
    runtime: &CapabilityRuntimeState,
) -> (&'static str, Option<&'static str>) {
    if !enabled {
        return ("已暂停", None);
    }
    if requires_configuration {
        return match seed.id {
            "workspace" => ("需要设置", Some("authorize-folder")),
            "web-research" => ("需要设置", Some("set-search")),
            _ => ("需要设置", None),
        };
    }
    if !runtime.engine_ready {
        return ("暂不可用", Some("set-model"));
    }
    let action = match seed.id {
        "memory" => Some("manage-memory"),
        "skills" => Some("view-skills"),
        "materials" => Some("view-materials"),
        "schedules" => Some("manage-schedules"),
        _ => None,
    };
    ("可用", action)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CapabilityProfile {
    Standard,
    /// An explicit, foreground project task. It retains the ordinary
    /// read-only project context but intentionally exposes just the bounded
    /// change-set write route so it cannot silently degrade to per-file writes.
    ProjectTask,
    Research,
    CanvasCompat,
}

impl CapabilityProfile {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            // The pinned H1 child accepts only its established execution
            // profiles. Project-task is a LuckyRay R5 policy with a narrower
            // authenticated tool snapshot, so it intentionally reuses the
            // child-side standard execution profile instead of changing Vendor
            // protocol or creating a second runtime path.
            Self::ProjectTask => "standard",
            Self::Research => "research-v1",
            Self::CanvasCompat => "canvas-v1",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "standard" => Some(Self::Standard),
            "research-v1" => Some(Self::Research),
            "canvas-v1" => Some(Self::CanvasCompat),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityToolManifest {
    pub(crate) id: String,
    pub(crate) version: u32,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) pack_id: String,
    pub(crate) handler: String,
    pub(crate) risk: ToolRisk,
    pub(crate) scope: String,
    pub(crate) input_schema: Value,
    pub(crate) output_schema: Value,
    pub(crate) idempotency: String,
    pub(crate) max_input_bytes: usize,
    pub(crate) max_output_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityBootstrapManifest {
    pub(crate) schema_version: u32,
    pub(crate) environment_probe: bool,
    pub(crate) tools: Vec<CapabilityToolManifest>,
    pub(crate) digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilitySnapshot {
    pub(crate) schema_version: u32,
    pub(crate) generation: u64,
    pub(crate) profile: String,
    pub(crate) tools: Vec<CapabilityToolManifest>,
    pub(crate) prompt: String,
    pub(crate) digest: String,
}

impl CapabilitySnapshot {
    pub(crate) fn allows(&self, tool_id: &str) -> bool {
        self.tools.iter().any(|tool| tool.id == tool_id)
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityPackView {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) description: String,
    pub(crate) enabled: bool,
    pub(crate) configured: bool,
    pub(crate) data_scope: String,
    pub(crate) permission_level: String,
    pub(crate) source: String,
    pub(crate) status: String,
    pub(crate) requires_configuration: bool,
    /// Product-facing user state. Only ever one of
    /// `可用` / `需要设置` / `已暂停` / `暂不可用`.
    pub(crate) user_status: String,
    /// Fixed safe next action id (never a tool id, grant id or internal key).
    pub(crate) next_action: Option<String>,
}

/// Server-owned runtime facts used to project a product-facing capability
/// center. The UI never re-derives readiness on its own.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub(crate) struct CapabilityRuntimeState {
    pub(crate) workspace_configured: bool,
    pub(crate) web_configured: bool,
    pub(crate) vault_available: bool,
    pub(crate) engine_ready: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityEngineView {
    /// One of `可用` / `需要设置` / `暂不可用`.
    pub(crate) user_status: String,
    /// Fixed safe next action id.
    pub(crate) next_action: Option<String>,
    pub(crate) provider_label: Option<String>,
    pub(crate) model_label: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityVaultView {
    /// True when a knowledge base is currently open. The UI never reports a
    /// Vault authority of its own; this is the Backend's current Vault state.
    pub(crate) available: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityCenterSnapshot {
    pub(crate) generation: u64,
    pub(crate) engine: CapabilityEngineView,
    pub(crate) vault: CapabilityVaultView,
    pub(crate) packs: Vec<CapabilityPackView>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CapabilityError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl CapabilityError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CapabilityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CapabilityError {}

#[derive(Clone, Debug)]
pub(crate) struct AgentCapabilityRegistry {
    db_path: PathBuf,
}

impl AgentCapabilityRegistry {
    pub(crate) fn initialize(db_path: impl Into<PathBuf>) -> Result<Self, CapabilityError> {
        let registry = Self {
            db_path: db_path.into(),
        };
        let mut connection = registry.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| {
                CapabilityError::new(
                    "agent-capability-state-unavailable",
                    "Capability state is unavailable",
                )
            })?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO agent_capability_registry_meta(singleton, generation, updated_at)
                 VALUES (?1, 1, ?2)",
                params![
                    CAPABILITY_GENERATION_SINGLETON,
                    chrono::Utc::now().to_rfc3339()
                ],
            )
            .map_err(|_| {
                CapabilityError::new(
                    "agent-capability-state-unavailable",
                    "Capability state is unavailable",
                )
            })?;
        for seed in all_pack_seeds() {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO agent_capability_state(
                        pack_id, enabled, updated_at
                     ) VALUES (?1, ?2, ?3)",
                    params![
                        seed.id,
                        i64::from(seed.default_enabled),
                        chrono::Utc::now().to_rfc3339()
                    ],
                )
                .map_err(|_| {
                    CapabilityError::new(
                        "agent-capability-state-unavailable",
                        "Capability state is unavailable",
                    )
                })?;
        }
        transaction.commit().map_err(|_| {
            CapabilityError::new(
                "agent-capability-state-unavailable",
                "Capability state is unavailable",
            )
        })?;
        Ok(registry)
    }

    pub(crate) fn center_snapshot(
        &self,
        runtime: CapabilityRuntimeState,
    ) -> Result<CapabilityCenterSnapshot, CapabilityError> {
        let connection = self.open_read()?;
        let generation = read_generation(&connection)?;
        let states = read_states(&connection)?;
        let packs = PUBLIC_PACKS
            .iter()
            .map(|seed| {
                let enabled = states.get(seed.id).copied().unwrap_or(seed.default_enabled);
                let configured = match seed.id {
                    "workspace" => runtime.workspace_configured,
                    "web-research" => runtime.web_configured,
                    _ => true,
                };
                let requires_configuration =
                    matches!(seed.id, "workspace" | "web-research") && !configured;
                // Product-facing user state. `可用`/`需要设置`/`已暂停`/`暂不可用`
                // only: never an engine-safe code, tool id, digest or service name.
                let (user_status, next_action) =
                    pack_user_state(seed, enabled, requires_configuration, &runtime);
                CapabilityPackView {
                    id: seed.id.to_owned(),
                    title: seed.title.to_owned(),
                    description: seed.description.to_owned(),
                    enabled,
                    configured,
                    data_scope: seed.data_scope.to_owned(),
                    permission_level: seed.permission_level.to_owned(),
                    source: seed.source.to_owned(),
                    status: if !enabled {
                        "disabled".to_owned()
                    } else if requires_configuration {
                        "configuration-required".to_owned()
                    } else {
                        "ready".to_owned()
                    },
                    requires_configuration,
                    user_status: user_status.to_owned(),
                    next_action: next_action.map(str::to_owned),
                }
            })
            .collect();
        let (engine_status, engine_action) = if !runtime.engine_ready {
            ("暂不可用", Some("set-model"))
        } else {
            ("可用", None)
        };
        Ok(CapabilityCenterSnapshot {
            generation,
            engine: CapabilityEngineView {
                user_status: engine_status.to_owned(),
                next_action: engine_action.map(str::to_owned),
                provider_label: None,
                model_label: None,
            },
            vault: CapabilityVaultView {
                available: runtime.vault_available,
            },
            packs,
        })
    }

    pub(crate) fn set_enabled(
        &self,
        pack_id: &str,
        enabled: bool,
    ) -> Result<CapabilityCenterSnapshot, CapabilityError> {
        let seed = PUBLIC_PACKS
            .iter()
            .find(|seed| seed.id == pack_id)
            .ok_or_else(|| {
                CapabilityError::new("agent-capability-not-found", "Unknown Agent capability")
            })?;
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| {
                CapabilityError::new(
                    "agent-capability-state-unavailable",
                    "Capability state is unavailable",
                )
            })?;
        let current = transaction
            .query_row(
                "SELECT enabled FROM agent_capability_state WHERE pack_id = ?1",
                [pack_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|_| {
                CapabilityError::new(
                    "agent-capability-state-unavailable",
                    "Capability state is unavailable",
                )
            })?
            .unwrap_or(i64::from(seed.default_enabled));
        if current != i64::from(enabled) {
            transaction
                .execute(
                    "INSERT INTO agent_capability_state(pack_id, enabled, updated_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(pack_id) DO UPDATE SET
                        enabled = excluded.enabled,
                        updated_at = excluded.updated_at",
                    params![pack_id, i64::from(enabled), chrono::Utc::now().to_rfc3339()],
                )
                .map_err(|_| {
                    CapabilityError::new(
                        "agent-capability-state-unavailable",
                        "Capability state is unavailable",
                    )
                })?;
            transaction
                .execute(
                    "UPDATE agent_capability_registry_meta
                     SET generation = generation + 1, updated_at = ?2
                     WHERE singleton = ?1",
                    params![
                        CAPABILITY_GENERATION_SINGLETON,
                        chrono::Utc::now().to_rfc3339()
                    ],
                )
                .map_err(|_| {
                    CapabilityError::new(
                        "agent-capability-state-unavailable",
                        "Capability state is unavailable",
                    )
                })?;
        }
        transaction.commit().map_err(|_| {
            CapabilityError::new(
                "agent-capability-state-unavailable",
                "Capability state is unavailable",
            )
        })?;
        // Configuration is projected by BackendServices; this return value is
        // deliberately conservative until that projection is supplied.
        self.center_snapshot(CapabilityRuntimeState::default())
    }

    pub(crate) fn filter_live_definitions(
        &self,
        mut definitions: Vec<ToolDefinition>,
    ) -> Result<Vec<ToolDefinition>, CapabilityError> {
        let connection = self.open_read()?;
        let states = read_states(&connection)?;
        definitions.retain(|definition| {
            states
                .get(pack_for_tool(definition.id()))
                .copied()
                .unwrap_or(true)
        });
        Ok(definitions)
    }

    pub(crate) fn is_pack_enabled(&self, pack_id: &str) -> Result<bool, CapabilityError> {
        let seed = all_pack_seeds()
            .find(|seed| seed.id == pack_id)
            .ok_or_else(|| {
                CapabilityError::new("agent-capability-not-found", "Unknown Agent capability")
            })?;
        let connection = self.open_read()?;
        let states = read_states(&connection)?;
        Ok(states.get(pack_id).copied().unwrap_or(seed.default_enabled))
    }

    pub(crate) fn current_generation(&self) -> Result<u64, CapabilityError> {
        let connection = self.open_read()?;
        read_generation(&connection)
    }

    pub(crate) fn bootstrap_manifest(
        &self,
        definitions: Vec<ToolDefinition>,
    ) -> Result<CapabilityBootstrapManifest, CapabilityError> {
        let mut tools = definitions
            .into_iter()
            .map(tool_manifest)
            .collect::<Result<Vec<_>, _>>()?;
        tools.sort_by(|left, right| left.id.cmp(&right.id));
        let body = json!({
            "schemaVersion": REGISTRY_SCHEMA_VERSION,
            "environmentProbe": false,
            "tools": tools,
        });
        let digest = canonical_digest(&body)?;
        Ok(CapabilityBootstrapManifest {
            schema_version: REGISTRY_SCHEMA_VERSION,
            environment_probe: false,
            tools,
            digest,
        })
    }

    pub(crate) fn build_snapshot(
        &self,
        profile: CapabilityProfile,
        _input: &str,
        definitions: Vec<ToolDefinition>,
    ) -> Result<CapabilitySnapshot, CapabilityError> {
        let connection = self.open_read()?;
        let generation = read_generation(&connection)?;
        let states = read_states(&connection)?;
        let mut tools = definitions
            .into_iter()
            .filter(|definition| {
                definition.is_available() && definition.risk() != ToolRisk::Dangerous
            })
            .map(tool_manifest)
            .collect::<Result<Vec<_>, _>>()?;
        tools.retain(|tool| {
            let pack_enabled = states.get(&tool.pack_id).copied().unwrap_or(true);
            if !pack_enabled {
                return false;
            }
            profile_allows_tool(profile, tool)
        });
        tools.sort_by(|left, right| left.id.cmp(&right.id));
        let prompt = build_capability_prompt(profile, &tools);
        let body = json!({
            "schemaVersion": REGISTRY_SCHEMA_VERSION,
            "generation": generation,
            "profile": profile.as_str(),
            "tools": tools,
            "prompt": prompt,
        });
        let digest = canonical_digest(&body)?;
        Ok(CapabilitySnapshot {
            schema_version: REGISTRY_SCHEMA_VERSION,
            generation,
            profile: profile.as_str().to_owned(),
            tools,
            prompt,
            digest,
        })
    }

    pub(crate) fn assert_snapshot_current(
        &self,
        snapshot: &CapabilitySnapshot,
        tool_id: &str,
    ) -> Result<(), CapabilityError> {
        validate_snapshot_integrity(snapshot)?;
        if !snapshot.allows(tool_id) {
            return Err(CapabilityError::new(
                "agent-capability-denied",
                "Tool is not present in this run capability snapshot",
            ));
        }
        let connection = self.open_read()?;
        if read_generation(&connection)? != snapshot.generation {
            return Err(CapabilityError::new(
                "agent-capability-stale",
                "Agent capability settings changed; start a new run",
            ));
        }
        let states = read_states(&connection)?;
        let pack_id = snapshot
            .tools
            .iter()
            .find(|tool| tool.id == tool_id)
            .map(|tool| tool.pack_id.as_str())
            .ok_or_else(|| {
                CapabilityError::new(
                    "agent-capability-denied",
                    "Tool is not present in this run capability snapshot",
                )
            })?;
        if !states.get(pack_id).copied().unwrap_or(true) {
            return Err(CapabilityError::new(
                "agent-capability-disabled",
                "Agent capability is disabled",
            ));
        }
        Ok(())
    }

    pub(crate) fn persist_run_snapshot(
        &self,
        run_id: &str,
        snapshot: &CapabilitySnapshot,
        provider_digest: &str,
        skill_digest: &str,
        scope_digest: &str,
    ) -> Result<(), CapabilityError> {
        let manifest_json = serde_json::to_string(snapshot).map_err(|_| {
            CapabilityError::new(
                "agent-capability-snapshot-invalid",
                "Capability snapshot is invalid",
            )
        })?;
        let connection = self.open_write()?;
        connection
            .execute(
                "INSERT INTO ai_run_capability_snapshot(
                    run_id, schema_version, generation, profile, digest, manifest_json,
                    provider_digest, skill_digest, scope_digest, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    run_id,
                    snapshot.schema_version,
                    snapshot.generation,
                    snapshot.profile,
                    snapshot.digest,
                    manifest_json,
                    provider_digest,
                    skill_digest,
                    scope_digest,
                    chrono::Utc::now().to_rfc3339()
                ],
            )
            .map_err(|_| {
                CapabilityError::new(
                    "agent-capability-snapshot-unavailable",
                    "Could not persist the run capability snapshot",
                )
            })?;
        Ok(())
    }

    fn open_read(&self) -> Result<Connection, CapabilityError> {
        open_connection(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }

    fn open_write(&self) -> Result<Connection, CapabilityError> {
        open_connection(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }
}

fn open_connection(path: &Path, flags: OpenFlags) -> Result<Connection, CapabilityError> {
    let connection = Connection::open_with_flags(path, flags).map_err(|_| {
        CapabilityError::new(
            "agent-capability-state-unavailable",
            "Capability state is unavailable",
        )
    })?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| {
            CapabilityError::new(
                "agent-capability-state-unavailable",
                "Capability state is unavailable",
            )
        })?;
    Ok(connection)
}

fn read_generation(connection: &Connection) -> Result<u64, CapabilityError> {
    connection
        .query_row(
            "SELECT generation FROM agent_capability_registry_meta WHERE singleton = ?1",
            [CAPABILITY_GENERATION_SINGLETON],
            |row| row.get(0),
        )
        .map_err(|_| {
            CapabilityError::new(
                "agent-capability-state-unavailable",
                "Capability state is unavailable",
            )
        })
}

fn read_states(connection: &Connection) -> Result<BTreeMap<String, bool>, CapabilityError> {
    let mut statement = connection
        .prepare("SELECT pack_id, enabled FROM agent_capability_state ORDER BY pack_id")
        .map_err(|_| {
            CapabilityError::new(
                "agent-capability-state-unavailable",
                "Capability state is unavailable",
            )
        })?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
        })
        .map_err(|_| {
            CapabilityError::new(
                "agent-capability-state-unavailable",
                "Capability state is unavailable",
            )
        })?;
    let mut states = BTreeMap::new();
    for row in rows {
        let (id, enabled) = row.map_err(|_| {
            CapabilityError::new(
                "agent-capability-state-unavailable",
                "Capability state is unavailable",
            )
        })?;
        states.insert(id, enabled);
    }
    Ok(states)
}

fn all_pack_seeds() -> impl Iterator<Item = &'static CapabilityPackSeed> {
    PUBLIC_PACKS.iter().chain(INTERNAL_PACKS.iter())
}

fn tool_manifest(definition: ToolDefinition) -> Result<CapabilityToolManifest, CapabilityError> {
    let id = definition.id().to_owned();
    let pack_id = pack_for_tool(&id).to_owned();
    let input_schema =
        agent_visible_input_schema(&id, definition.risk(), definition.input_schema().clone());
    Ok(CapabilityToolManifest {
        id: id.clone(),
        version: definition.version(),
        title: definition.title().to_owned(),
        description: definition.description().to_owned(),
        pack_id,
        handler: format!("backend:{id}"),
        risk: definition.risk(),
        scope: scope_for_tool(&id).to_owned(),
        input_schema,
        output_schema: definition.output_schema().clone(),
        idempotency: definition.idempotency().to_owned(),
        max_input_bytes: definition.max_input_bytes(),
        max_output_bytes: definition.max_output_bytes(),
    })
}

/// A capability manifest is the child/model contract, not the ToolRegistry's
/// internal execution contract. The Backend owns per-call request ids and
/// authoritative bindings, so those fields must never be discoverable as
/// values a model is expected to invent. The parent injects them immediately
/// before the internal ToolRegistry schema is validated.
fn agent_visible_input_schema(tool_id: &str, risk: ToolRisk, mut schema: Value) -> Value {
    let mut server_owned = BTreeSet::new();
    if risk >= ToolRisk::Write {
        server_owned.insert("requestId");
    }
    if tool_id.starts_with("knowledge.") || tool_id == "capability.run" {
        server_owned.insert("expectedVaultId");
    }
    if matches!(tool_id, "materials.set_tags" | "materials.categorize") {
        // A current-material run always replaces this with the revision from
        // the server-bound asset, never with a model-provided value.
        server_owned.insert("expectedRevision");
    }
    if !server_owned.is_empty() {
        strip_server_owned_schema_fields(&mut schema, &server_owned);
    }
    schema
}

fn strip_server_owned_schema_fields(schema: &mut Value, server_owned: &BTreeSet<&str>) {
    match schema {
        Value::Object(object) => {
            if let Some(Value::Object(properties)) = object.get_mut("properties") {
                for field in server_owned {
                    properties.remove(*field);
                }
                for child in properties.values_mut() {
                    strip_server_owned_schema_fields(child, server_owned);
                }
            }
            if let Some(Value::Array(required)) = object.get_mut("required") {
                required.retain(|field| {
                    !field
                        .as_str()
                        .is_some_and(|field| server_owned.contains(field))
                });
            }
            for (key, child) in object.iter_mut() {
                if key != "properties" && key != "required" {
                    strip_server_owned_schema_fields(child, server_owned);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                strip_server_owned_schema_fields(item, server_owned);
            }
        }
        _ => {}
    }
}

pub(crate) fn pack_for_tool(tool_id: &str) -> &'static str {
    if tool_id.starts_with("web.") || tool_id.starts_with("browser.") {
        "web-research"
    } else if tool_id.starts_with("memory.") {
        "memory"
    } else if tool_id.starts_with("skills.") {
        "skills"
    } else if tool_id.starts_with("materials.") {
        "materials"
    } else if tool_id.starts_with("workspace.") {
        "workspace"
    } else if tool_id.starts_with("execution.") {
        "execution"
    } else if tool_id.starts_with("schedule.") {
        "schedules"
    } else if tool_id.starts_with("knowledge.") {
        "knowledge"
    } else if tool_id.starts_with("canvas.") {
        "canvas-compat"
    } else {
        "legacy-capability"
    }
}

fn scope_for_tool(tool_id: &str) -> &'static str {
    if tool_id.starts_with("browser.") || tool_id.starts_with("web.") {
        "run-network"
    } else if tool_id.starts_with("workspace.") {
        "workspace-grant"
    } else if tool_id.starts_with("execution.") {
        "workspace-grant"
    } else if tool_id.starts_with("memory.") {
        "global-or-vault"
    } else if tool_id.starts_with("knowledge.") {
        "current-vault"
    } else if tool_id.starts_with("canvas.") {
        "current-canvas"
    } else if tool_id.starts_with("materials.") {
        "material-catalog"
    } else if tool_id.starts_with("skills.") {
        "skill-catalog"
    } else if tool_id.starts_with("schedule.") {
        "app-scheduler"
    } else {
        "app-owned"
    }
}

fn is_frozen_canvas_compat_tool(tool_id: &str) -> bool {
    matches!(
        tool_id,
        "knowledge.search"
            | "knowledge.read"
            | "materials.search"
            | "web.search"
            | "web.fetch"
            | "browser.open"
            | "browser.read"
            | "browser.extract"
            | "knowledge.create"
            | "knowledge.append"
            | "knowledge.set_tags"
            | "canvas.inspect"
            | "canvas.mutate"
            | "canvas.generate"
    )
}

fn profile_allows_tool(profile: CapabilityProfile, tool: &CapabilityToolManifest) -> bool {
    match profile {
        CapabilityProfile::CanvasCompat => is_frozen_canvas_compat_tool(&tool.id),
        CapabilityProfile::ProjectTask => {
            !tool.id.starts_with("canvas.")
                && (tool.risk == ToolRisk::Read
                    || tool.id == "workspace.change_set"
                    || tool.id.starts_with("execution."))
        }
        CapabilityProfile::Research => {
            tool.risk == ToolRisk::Read
                && !tool.id.starts_with("canvas.")
                && !tool.id.starts_with("execution.")
        }
        CapabilityProfile::Standard => {
            !tool.id.starts_with("canvas.") && !tool.id.starts_with("execution.")
        }
    }
}

fn build_capability_prompt(profile: CapabilityProfile, tools: &[CapabilityToolManifest]) -> String {
    let mut packs = BTreeSet::new();
    let mut lines = vec![
        "Use only the tools in this authenticated LuckyRay capability snapshot."
            .to_owned(),
        "LuckyRay Backend is the sole execution and permission authority. Never claim a tool, file, network, memory, skill, or write capability that is absent."
            .to_owned(),
        "Do not expose chain-of-thought, raw credentials, provider bodies, absolute paths, or private memory text in status messages."
            .to_owned(),
        "Writes are proposals: show the bounded preview and wait for LuckyRay approval. A rejected, expired, stale, or conflicted write must not be retried automatically."
            .to_owned(),
    ];
    if profile == CapabilityProfile::Research {
        lines.push(
            "For research, collect evidence with available web/browser and local read tools, then produce one final synthesis with valid R references."
                .to_owned(),
        );
    }
    // Historical project-task records used the `standard` profile name. Their
    // Backend-authenticated tool shape remains sufficient to validate stored
    // snapshots without creating a new runtime profile.
    let project_task_toolset = profile == CapabilityProfile::ProjectTask
        || (profile == CapabilityProfile::Standard && is_project_task_toolset(tools));
    if project_task_toolset {
        lines.push(
            "This is an explicit project task. First inspect authorized workspace evidence with workspace.search or workspace.read, then form a concise plan. Only workspace.change_set may propose file changes, and it always requires one full preview and LuckyRay confirmation. If a file changed, re-read it at most once before preparing a new proposal. If a controlled project check is available, first list its Backend-issued recipe and then request one confirmation to run that exact recipe. It never grants a shell, project scripts, dependency installation, or network access. Do not claim project checks, builds, or tests ran unless the Backend observation confirms the check result."
                .to_owned(),
        );
    }
    for tool in tools {
        packs.insert(tool.pack_id.as_str());
        lines.push(format!(
            "- {} [{}]: {}",
            tool.id,
            match tool.risk {
                ToolRisk::Read => "read",
                ToolRisk::Write => "approval-required",
                ToolRisk::Dangerous => "restricted",
            },
            tool.description
        ));
    }
    if packs.contains("materials") {
        lines.push(
            "For materials: If a server-owned assetId is present in context, operate directly on that assetId. If materials.search returns multiple candidate matches for a name, ask the user once to clarify which asset to use. Never inspect or preview candidates endlessly when non-unique."
                .to_owned(),
        );
    }
    if packs.contains("web-research") {
        lines.push(
            "For web research: If web.fetch or browser.open fails with a network/unreachable error for a URL, inform the user once that the site is unreachable. Never repeat navigation/fetch retries on a broken site or issue endless searches to guess missing content."
                .to_owned(),
        );
    }
    if tools.is_empty() {
        lines
            .push("No tools are enabled for this run. Answer only from the user input.".to_owned());
    } else {
        lines.insert(
            4,
            format!(
                "Enabled capability packs: {}.",
                packs.into_iter().collect::<Vec<_>>().join(", ")
            ),
        );
    }
    lines.join("\n")
}

/// The pinned H1 protocol serializes a ProjectTask snapshot as `standard`.
/// Its authenticated tool shape is therefore the only safe discriminator at
/// integrity-validation time. A normal Standard snapshot retains direct
/// single-file tools; a ProjectTask has the bounded change-set route and
/// deliberately excludes them. This lets the existing child profile remain
/// unchanged without permitting `execution.*` in an ordinary standard run.
fn is_project_task_toolset(tools: &[CapabilityToolManifest]) -> bool {
    tools.iter().any(|tool| tool.id == "workspace.change_set")
        && tools.iter().all(|tool| {
            !matches!(
                tool.id.as_str(),
                "workspace.create_text" | "workspace.patch_text"
            )
        })
}

fn snapshot_profile(snapshot: &CapabilitySnapshot) -> Option<CapabilityProfile> {
    let profile = CapabilityProfile::parse(&snapshot.profile)?;
    if profile == CapabilityProfile::Standard && is_project_task_toolset(&snapshot.tools) {
        Some(CapabilityProfile::ProjectTask)
    } else {
        Some(profile)
    }
}

fn canonical_digest(value: &Value) -> Result<String, CapabilityError> {
    let canonical = canonicalize(value);
    let bytes = serde_json::to_vec(&canonical).map_err(|_| {
        CapabilityError::new(
            "agent-capability-snapshot-invalid",
            "Capability snapshot is invalid",
        )
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        Value::Object(object) => {
            let mut ordered = BTreeMap::new();
            for (key, value) in object {
                ordered.insert(key, canonicalize(value));
            }
            let mut canonical = Map::new();
            for (key, value) in ordered {
                canonical.insert(key.clone(), value);
            }
            Value::Object(canonical)
        }
        _ => value.clone(),
    }
}

fn validate_snapshot_integrity(snapshot: &CapabilitySnapshot) -> Result<(), CapabilityError> {
    let profile = snapshot_profile(snapshot).ok_or_else(|| {
        CapabilityError::new(
            "agent-capability-snapshot-invalid",
            "Agent capability snapshot is invalid",
        )
    })?;
    if snapshot.schema_version != REGISTRY_SCHEMA_VERSION
        || snapshot.generation == 0
        || snapshot.tools.len() > 128
    {
        return Err(CapabilityError::new(
            "agent-capability-snapshot-invalid",
            "Agent capability snapshot is invalid",
        ));
    }
    let mut previous: Option<&str> = None;
    for tool in &snapshot.tools {
        if tool.id.is_empty()
            || previous.is_some_and(|value| value >= tool.id.as_str())
            || tool.handler != format!("backend:{}", tool.id)
            || tool.pack_id != pack_for_tool(&tool.id)
            || tool.risk == ToolRisk::Dangerous
            || !profile_allows_tool(profile, tool)
            || tool.version == 0
            || tool.max_input_bytes == 0
            || tool.max_output_bytes == 0
            || tool.max_input_bytes > 1024 * 1024
            || tool.max_output_bytes > 1024 * 1024
        {
            return Err(CapabilityError::new(
                "agent-capability-snapshot-invalid",
                "Agent capability snapshot is invalid",
            ));
        }
        previous = Some(&tool.id);
    }
    if snapshot.prompt != build_capability_prompt(profile, &snapshot.tools) {
        return Err(CapabilityError::new(
            "agent-capability-snapshot-invalid",
            "Agent capability snapshot prompt is invalid",
        ));
    }
    let body = json!({
        "schemaVersion": snapshot.schema_version,
        "generation": snapshot.generation,
        "profile": snapshot.profile,
        "tools": snapshot.tools,
        "prompt": snapshot.prompt,
    });
    let digest = canonical_digest(&body)?;
    if digest != snapshot.digest {
        return Err(CapabilityError::new(
            "agent-capability-snapshot-invalid",
            "Agent capability snapshot digest is invalid",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_digest_is_key_order_independent() {
        let first = json!({"b": 2, "a": {"d": 4, "c": 3}});
        let second = json!({"a": {"c": 3, "d": 4}, "b": 2});
        assert_eq!(
            canonical_digest(&first).unwrap(),
            canonical_digest(&second).unwrap()
        );
    }

    #[test]
    fn canvas_compat_stays_frozen() {
        assert!(is_frozen_canvas_compat_tool("canvas.inspect"));
        assert!(is_frozen_canvas_compat_tool("knowledge.search"));
        assert!(!is_frozen_canvas_compat_tool("memory.search"));
        assert!(!is_frozen_canvas_compat_tool("workspace.read"));
    }

    #[test]
    fn schedule_capability_projects_a_distinct_management_action_only_when_usable() {
        let schedules = PUBLIC_PACKS
            .iter()
            .find(|seed| seed.id == "schedules")
            .expect("schedules pack");
        let ready = CapabilityRuntimeState {
            engine_ready: true,
            ..CapabilityRuntimeState::default()
        };
        assert_eq!(
            pack_user_state(schedules, true, false, &ready),
            ("可用", Some("manage-schedules"))
        );
        assert_eq!(
            pack_user_state(schedules, false, false, &ready),
            ("已暂停", None)
        );
        assert_eq!(
            pack_user_state(schedules, true, false, &CapabilityRuntimeState::default()),
            ("暂不可用", Some("set-model"))
        );
    }

    #[test]
    fn forged_snapshot_prompt_or_digest_is_rejected() {
        let mut snapshot = CapabilitySnapshot {
            schema_version: REGISTRY_SCHEMA_VERSION,
            generation: 1,
            profile: CapabilityProfile::Standard.as_str().to_owned(),
            tools: Vec::new(),
            prompt: build_capability_prompt(CapabilityProfile::Standard, &[]),
            digest: String::new(),
        };
        let body = json!({
            "schemaVersion": snapshot.schema_version,
            "generation": snapshot.generation,
            "profile": snapshot.profile,
            "tools": snapshot.tools,
            "prompt": snapshot.prompt,
        });
        snapshot.digest = canonical_digest(&body).unwrap();
        assert!(validate_snapshot_integrity(&snapshot).is_ok());
        snapshot.prompt.push_str("\nforged");
        assert_eq!(
            validate_snapshot_integrity(&snapshot).unwrap_err().code,
            "agent-capability-snapshot-invalid"
        );
    }

    #[test]
    fn research_snapshot_rejects_write_tools_even_with_a_valid_digest() {
        let tools = vec![CapabilityToolManifest {
            id: "knowledge.append".to_owned(),
            version: 1,
            title: "Append".to_owned(),
            description: "Append to a knowledge document".to_owned(),
            pack_id: "knowledge".to_owned(),
            handler: "backend:knowledge.append".to_owned(),
            risk: ToolRisk::Write,
            scope: "current-vault".to_owned(),
            input_schema: json!({"type":"object","properties":{}}),
            output_schema: json!({"type":"object","properties":{}}),
            idempotency: "receipt".to_owned(),
            max_input_bytes: 1024,
            max_output_bytes: 1024,
        }];
        let prompt = build_capability_prompt(CapabilityProfile::Research, &tools);
        let body = json!({
            "schemaVersion": REGISTRY_SCHEMA_VERSION,
            "generation": 1,
            "profile": CapabilityProfile::Research.as_str(),
            "tools": tools,
            "prompt": prompt,
        });
        let snapshot = CapabilitySnapshot {
            schema_version: REGISTRY_SCHEMA_VERSION,
            generation: 1,
            profile: CapabilityProfile::Research.as_str().to_owned(),
            tools: body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .cloned()
                .map(|value| serde_json::from_value(value).unwrap())
                .collect(),
            prompt: body["prompt"].as_str().unwrap().to_owned(),
            digest: canonical_digest(&body).unwrap(),
        };

        assert_eq!(
            validate_snapshot_integrity(&snapshot).unwrap_err().code,
            "agent-capability-snapshot-invalid"
        );
        assert!(!profile_allows_tool(
            CapabilityProfile::Research,
            &snapshot.tools[0]
        ));
        assert!(profile_allows_tool(
            CapabilityProfile::Standard,
            &snapshot.tools[0]
        ));
    }

    fn write_manifest(id: &str) -> CapabilityToolManifest {
        CapabilityToolManifest {
            id: id.to_owned(),
            version: 1,
            title: id.to_owned(),
            description: "write tool".to_owned(),
            pack_id: pack_for_tool(id).to_owned(),
            handler: format!("backend:{id}"),
            risk: ToolRisk::Write,
            scope: "workspace-grant".to_owned(),
            input_schema: json!({
                "type":"object",
                "additionalProperties":false,
                "required":["requestId"],
                "properties":{"requestId":{"type":"string","minLength":1,"maxLength":96}}
            }),
            output_schema: json!({"type":"object","properties":{}}),
            idempotency: "approval-one-shot-cas".to_owned(),
            max_input_bytes: 1024,
            max_output_bytes: 1024,
        }
    }

    #[test]
    fn workspace_write_tools_are_standard_only_and_never_research_or_canvas() {
        let create = write_manifest("workspace.create_text");
        let patch = write_manifest("workspace.patch_text");
        let change_set = write_manifest("workspace.change_set");
        assert_eq!(create.pack_id, "workspace");
        assert_eq!(patch.pack_id, "workspace");
        assert_eq!(change_set.pack_id, "workspace");
        assert!(profile_allows_tool(CapabilityProfile::Standard, &create));
        assert!(profile_allows_tool(CapabilityProfile::Standard, &patch));
        assert!(profile_allows_tool(
            CapabilityProfile::Standard,
            &change_set
        ));
        assert!(
            !profile_allows_tool(CapabilityProfile::Research, &create),
            "Research snapshots never carry workspace write tools"
        );
        assert!(
            !profile_allows_tool(CapabilityProfile::Research, &patch),
            "Research snapshots never carry workspace write tools"
        );
        assert!(
            !profile_allows_tool(CapabilityProfile::Research, &change_set),
            "Research snapshots never carry multi-file workspace writes"
        );
        assert!(
            !profile_allows_tool(CapabilityProfile::CanvasCompat, &create),
            "the frozen Canvas compatibility pack never gains workspace writes"
        );
        assert!(
            !profile_allows_tool(CapabilityProfile::CanvasCompat, &change_set),
            "the frozen Canvas compatibility pack never gains multi-file workspace writes"
        );
        assert!(
            profile_allows_tool(CapabilityProfile::ProjectTask, &change_set),
            "the explicit project-task profile may propose only the bounded change-set path"
        );
        assert!(
            !profile_allows_tool(CapabilityProfile::ProjectTask, &create)
                && !profile_allows_tool(CapabilityProfile::ProjectTask, &patch),
            "a project task must not silently fall back to single-file workspace writes"
        );
        // Agent-visible schema strips the server-owned requestId from the
        // model contract, while the internal schema still requires it.
        let internal = object_schema_for_test(&create);
        let visible = agent_visible_input_schema(&create.id, create.risk, internal.clone());
        assert!(visible
            .get("properties")
            .and_then(Value::as_object)
            .is_some());
        assert!(
            visible
                .get("properties")
                .and_then(Value::as_object)
                .is_none_or(|properties| !properties.contains_key("requestId")),
            "requestId must be stripped from the model-visible schema"
        );
        assert!(internal
            .get("properties")
            .and_then(Value::as_object)
            .is_some_and(|properties| properties.contains_key("requestId")));
    }

    #[test]
    fn controlled_execution_is_project_task_only_and_never_reaches_other_profiles() {
        let mut list = write_manifest("execution.list");
        list.risk = ToolRisk::Read;
        let run = write_manifest("execution.run");

        assert_eq!(list.pack_id, "execution");
        assert_eq!(run.pack_id, "execution");
        assert!(profile_allows_tool(CapabilityProfile::ProjectTask, &list));
        assert!(profile_allows_tool(CapabilityProfile::ProjectTask, &run));
        assert!(!profile_allows_tool(CapabilityProfile::Standard, &list));
        assert!(!profile_allows_tool(CapabilityProfile::Standard, &run));
        assert!(!profile_allows_tool(CapabilityProfile::Research, &list));
        assert!(!profile_allows_tool(CapabilityProfile::Research, &run));
        assert!(!profile_allows_tool(CapabilityProfile::CanvasCompat, &list));
        assert!(!profile_allows_tool(CapabilityProfile::CanvasCompat, &run));
    }

    fn object_schema_for_test(manifest: &CapabilityToolManifest) -> Value {
        manifest.input_schema.clone()
    }
}
