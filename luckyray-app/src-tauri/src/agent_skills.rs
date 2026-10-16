use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

const MAX_SKILL_MD_BYTES: usize = 64 * 1024;
const MAX_RESOURCE_BYTES: usize = 64 * 1024;
const MAX_PACKAGE_BYTES: usize = 512 * 1024;
const MAX_RESOURCES: usize = 64;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SkillScopeKind {
    Global,
    Vault,
}

impl SkillScopeKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Vault => "vault",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillScope {
    pub(crate) kind: SkillScopeKind,
    #[serde(default)]
    pub(crate) vault_id: Option<String>,
}

impl SkillScope {
    pub(crate) fn global() -> Self {
        Self {
            kind: SkillScopeKind::Global,
            vault_id: None,
        }
    }

    fn validate(&self) -> Result<(), SkillError> {
        match self.kind {
            SkillScopeKind::Global if self.vault_id.is_some() => Err(SkillError::new(
                "skill-scope-invalid",
                "Global Skill scope cannot carry a Vault identity",
            )),
            SkillScopeKind::Vault => {
                let vault_id = self.vault_id.as_deref().ok_or_else(|| {
                    SkillError::new("skill-scope-invalid", "Vault Skill requires a Vault")
                })?;
                validate_public_id(vault_id, "skill-scope-invalid")
            }
            SkillScopeKind::Global => Ok(()),
        }
    }

    fn scope_id(&self) -> Option<&str> {
        self.vault_id.as_deref()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillResourceInput {
    pub(crate) path: String,
    pub(crate) content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillPackageInput {
    pub(crate) skill_id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) version: String,
    pub(crate) scope: SkillScope,
    pub(crate) skill_md: String,
    #[serde(default)]
    pub(crate) resources: Vec<SkillResourceInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillCreateInput {
    pub(crate) package: SkillPackageInput,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillPatchInput {
    pub(crate) expected_digest: String,
    pub(crate) package: SkillPackageInput,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillSummary {
    pub(crate) skill_id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) version: String,
    pub(crate) digest: String,
    pub(crate) source: String,
    pub(crate) scope: SkillScope,
    pub(crate) enabled: bool,
    pub(crate) resource_count: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillInvocationSummary {
    pub(crate) invocation_id: String,
    pub(crate) skill_id: String,
    pub(crate) name: String,
    pub(crate) description: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillInvocationSnapshot {
    pub(crate) generation: u64,
    pub(crate) skills: Vec<SkillInvocationSummary>,
    #[serde(skip)]
    pub(crate) catalog_fence: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillView {
    pub(crate) skill: SkillSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) skill_md: Option<String>,
    pub(crate) resource_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) resource_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) resource_content: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SkillError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl SkillError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SkillError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SkillError {}

#[derive(Clone, Debug)]
pub(crate) struct SkillCatalog {
    db_path: PathBuf,
}

impl SkillCatalog {
    pub(crate) fn initialize(db_path: impl Into<PathBuf>) -> Result<Self, SkillError> {
        let catalog = Self {
            db_path: db_path.into(),
        };
        catalog.seed_builtin()?;
        Ok(catalog)
    }

    pub(crate) fn list(&self, vault_id: Option<&str>) -> Result<Vec<SkillSummary>, SkillError> {
        if let Some(vault_id) = vault_id {
            validate_public_id(vault_id, "skill-scope-invalid")?;
        }
        let connection = self.open_read()?;
        let mut statement = connection
            .prepare(
                "SELECT p.skill_id, p.name, p.description, p.version, p.digest,
                        p.source, p.scope_kind, p.scope_id, s.enabled,
                        json_array_length(p.resources_json)
                 FROM agent_skill_state s
                 JOIN agent_skill_package p ON p.digest = s.current_digest
                 WHERE s.enabled = 1
                   AND (
                     p.scope_kind = 'global'
                     OR (?1 IS NOT NULL AND p.scope_kind = 'vault' AND p.scope_id = ?1)
                   )
                 ORDER BY p.name COLLATE NOCASE, p.skill_id",
            )
            .map_err(|_| skill_database_error())?;
        let rows = statement
            .query_map([vault_id], map_summary_row)
            .map_err(|_| skill_database_error())?;
        let mut skills = Vec::new();
        for row in rows {
            skills.push(row.map_err(|_| skill_database_error())?);
        }
        Ok(skills)
    }

    pub(crate) fn list_all_for_ui(&self) -> Result<Vec<SkillSummary>, SkillError> {
        let connection = self.open_read()?;
        let mut statement = connection
            .prepare(
                "SELECT p.skill_id, p.name, p.description, p.version, p.digest,
                        p.source, p.scope_kind, p.scope_id, s.enabled,
                        json_array_length(p.resources_json)
                 FROM agent_skill_state s
                 JOIN agent_skill_package p ON p.digest = s.current_digest
                 ORDER BY p.name COLLATE NOCASE, p.skill_id",
            )
            .map_err(|_| skill_database_error())?;
        let rows = statement
            .query_map([], map_summary_row)
            .map_err(|_| skill_database_error())?;
        let mut skills = Vec::new();
        for row in rows {
            skills.push(row.map_err(|_| skill_database_error())?);
        }
        Ok(skills)
    }

    /// Produces the invocation palette projection from one SQLite read
    /// snapshot shared by the capability generation, Skills pack state and
    /// current immutable Skill packages. This is deliberately separate from
    /// `list_all_for_ui`, which remains the Community management view.
    pub(crate) fn list_invocation_snapshot(
        &self,
        vault_id: Option<&str>,
    ) -> Result<SkillInvocationSnapshot, SkillError> {
        if let Some(vault_id) = vault_id {
            validate_public_id(vault_id, "skill-scope-invalid")?;
        }
        let mut connection = self.open_read()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| skill_database_error())?;
        let generation = transaction
            .query_row(
                "SELECT generation FROM agent_capability_registry_meta WHERE singleton=?1",
                [crate::agent_capabilities::CAPABILITY_GENERATION_SINGLETON],
                |row| row.get::<_, u64>(0),
            )
            .map_err(|_| skill_database_error())?;
        if generation == 0 {
            return Err(SkillError::new(
                "skill-invocation-unavailable",
                "Runnable Skills are unavailable",
            ));
        }
        let pack_enabled = transaction
            .query_row(
                "SELECT enabled FROM agent_capability_state WHERE pack_id='skills'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|_| skill_database_error())?
            == Some(1);
        let (skills, fence_parts) = if pack_enabled {
            let mut statement = transaction
                .prepare(
                    "SELECT p.skill_id,p.name,p.description,p.digest,s.revision
                     FROM agent_skill_state s
                     JOIN agent_skill_package p ON p.digest=s.current_digest
                     WHERE s.enabled=1
                       AND p.source='builtin-audited'
                       AND lower(p.skill_id) NOT IN ('research','schedule')
                       AND (
                         p.scope_kind='global'
                         OR (?1 IS NOT NULL AND p.scope_kind='vault' AND p.scope_id=?1)
                       )
                     ORDER BY p.name COLLATE NOCASE,p.skill_id",
                )
                .map_err(|_| skill_database_error())?;
            let rows = statement
                .query_map([vault_id], |row| {
                    let skill_id = row.get::<_, String>(0)?;
                    let digest = row.get::<_, String>(3)?;
                    let revision = row.get::<_, i64>(4)?;
                    Ok((
                        SkillInvocationSummary {
                            invocation_id: format!("agent-skill:{skill_id}"),
                            skill_id: skill_id.clone(),
                            name: row.get(1)?,
                            description: row.get(2)?,
                        },
                        (skill_id, digest, revision),
                    ))
                })
                .map_err(|_| skill_database_error())?;
            let mut skills = Vec::new();
            let mut fence_parts = Vec::new();
            for row in rows {
                let (skill, fence_part) = row.map_err(|_| skill_database_error())?;
                skills.push(skill);
                fence_parts.push(fence_part);
            }
            (skills, fence_parts)
        } else {
            (Vec::new(), Vec::new())
        };
        let catalog_fence = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&fence_parts).map_err(|_| skill_database_error())?)
        );
        transaction.commit().map_err(|_| skill_database_error())?;
        Ok(SkillInvocationSnapshot {
            generation,
            skills,
            catalog_fence,
        })
    }

    pub(crate) fn view(
        &self,
        skill_id: &str,
        vault_id: Option<&str>,
        resource_path: Option<&str>,
    ) -> Result<SkillView, SkillError> {
        validate_public_id(skill_id, "skill-identity-invalid")?;
        if let Some(vault_id) = vault_id {
            validate_public_id(vault_id, "skill-scope-invalid")?;
        }
        let connection = self.open_read()?;
        let row = connection
            .query_row(
                "SELECT p.skill_id, p.name, p.description, p.version, p.digest,
                        p.source, p.scope_kind, p.scope_id, s.enabled,
                        json_array_length(p.resources_json),
                        p.skill_md, p.resources_json
                 FROM agent_skill_state s
                 JOIN agent_skill_package p ON p.digest = s.current_digest
                 WHERE s.skill_id = ?1 AND s.enabled = 1
                   AND (
                     p.scope_kind = 'global'
                     OR (?2 IS NOT NULL AND p.scope_kind = 'vault' AND p.scope_id = ?2)
                   )",
                params![skill_id, vault_id],
                |row| {
                    Ok((
                        map_summary_row(row)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| skill_database_error())?
            .ok_or_else(|| SkillError::new("skill-not-found", "Skill is unavailable"))?;
        let resources: Vec<SkillResourceInput> =
            serde_json::from_str(&row.2).map_err(|_| skill_database_error())?;
        let resource_paths = resources
            .iter()
            .map(|resource| resource.path.clone())
            .collect::<Vec<_>>();
        if let Some(resource_path) = resource_path {
            validate_resource_path(resource_path)?;
            let resource = resources
                .iter()
                .find(|resource| resource.path == resource_path)
                .ok_or_else(|| {
                    SkillError::new("skill-resource-not-found", "Skill resource is unavailable")
                })?;
            Ok(SkillView {
                skill: row.0,
                skill_md: None,
                resource_paths,
                resource_path: Some(resource.path.clone()),
                resource_content: Some(resource.content.clone()),
            })
        } else {
            Ok(SkillView {
                skill: row.0,
                skill_md: Some(row.1),
                resource_paths,
                resource_path: None,
                resource_content: None,
            })
        }
    }

    pub(crate) fn create(
        &self,
        input: SkillCreateInput,
        source: &str,
    ) -> Result<SkillSummary, SkillError> {
        let validated = validate_package(input.package)?;
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| skill_database_error())?;
        let exists = transaction
            .query_row(
                "SELECT 1 FROM agent_skill_state WHERE skill_id = ?1",
                [&validated.package.skill_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| skill_database_error())?
            .is_some();
        if exists {
            return Err(SkillError::new(
                "skill-name-conflict",
                "Skill already exists; use a patch proposal",
            ));
        }
        insert_immutable_package(&transaction, &validated, source)?;
        transaction
            .execute(
                "INSERT INTO agent_skill_state(skill_id, current_digest, enabled, revision, updated_at)
                 VALUES (?1, ?2, 1, 1, ?3)",
                params![
                    validated.package.skill_id,
                    validated.digest,
                    chrono::Utc::now().to_rfc3339()
                ],
            )
            .map_err(|_| skill_database_error())?;
        transaction.commit().map_err(|_| skill_database_error())?;
        self.summary_by_id(&validated.package.skill_id)
    }

    pub(crate) fn patch(
        &self,
        input: SkillPatchInput,
        source: &str,
    ) -> Result<SkillSummary, SkillError> {
        validate_digest(&input.expected_digest)?;
        let validated = validate_package(input.package)?;
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| skill_database_error())?;
        let current = transaction
            .query_row(
                "SELECT current_digest, revision FROM agent_skill_state WHERE skill_id = ?1",
                [&validated.package.skill_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|_| skill_database_error())?
            .ok_or_else(|| SkillError::new("skill-not-found", "Skill no longer exists"))?;
        if current.0 != input.expected_digest {
            return Err(SkillError::new(
                "skill-revision-conflict",
                "Skill changed; reload before applying this proposal",
            ));
        }
        insert_immutable_package(&transaction, &validated, source)?;
        let changed = transaction
            .execute(
                "UPDATE agent_skill_state
                 SET current_digest = ?2, revision = revision + 1, updated_at = ?3
                 WHERE skill_id = ?1 AND current_digest = ?4 AND revision = ?5",
                params![
                    validated.package.skill_id,
                    validated.digest,
                    chrono::Utc::now().to_rfc3339(),
                    input.expected_digest,
                    current.1
                ],
            )
            .map_err(|_| skill_database_error())?;
        if changed != 1 {
            return Err(SkillError::new(
                "skill-revision-conflict",
                "Skill changed; reload before applying this proposal",
            ));
        }
        transaction.commit().map_err(|_| skill_database_error())?;
        self.summary_by_id(&validated.package.skill_id)
    }

    pub(crate) fn set_enabled(
        &self,
        skill_id: &str,
        enabled: bool,
    ) -> Result<SkillSummary, SkillError> {
        validate_public_id(skill_id, "skill-identity-invalid")?;
        let connection = self.open_write()?;
        let changed = connection
            .execute(
                "UPDATE agent_skill_state
                 SET enabled = ?2, revision = revision + 1, updated_at = ?3
                 WHERE skill_id = ?1",
                params![
                    skill_id,
                    i64::from(enabled),
                    chrono::Utc::now().to_rfc3339()
                ],
            )
            .map_err(|_| skill_database_error())?;
        if changed != 1 {
            return Err(SkillError::new("skill-not-found", "Skill no longer exists"));
        }
        self.summary_by_id(skill_id)
    }

    pub(crate) fn enabled_digest(&self, vault_id: Option<&str>) -> Result<String, SkillError> {
        let skills = self.list(vault_id)?;
        let body = skills
            .iter()
            .map(|skill| json!({"id": skill.skill_id, "digest": skill.digest}))
            .collect::<Vec<_>>();
        let canonical = serde_json::to_vec(&body).map_err(|_| skill_database_error())?;
        Ok(format!("{:x}", Sha256::digest(canonical)))
    }

    pub(crate) fn prompt_index(&self, vault_id: Option<&str>) -> Result<String, SkillError> {
        let skills = self.list(vault_id)?;
        if skills.is_empty() {
            return Ok(String::new());
        }
        let mut output = String::from(
            "\n\n<luckyray_skill_index>\nSkills are progressively disclosed. Call skills.view before relying on a Skill.\n",
        );
        for skill in skills {
            output.push_str(&format!(
                "- {} @ {} ({}): {}\n",
                skill.skill_id, skill.version, skill.digest, skill.description
            ));
        }
        output.push_str("</luckyray_skill_index>");
        Ok(output)
    }

    fn summary_by_id(&self, skill_id: &str) -> Result<SkillSummary, SkillError> {
        let connection = self.open_read()?;
        connection
            .query_row(
                "SELECT p.skill_id, p.name, p.description, p.version, p.digest,
                        p.source, p.scope_kind, p.scope_id, s.enabled,
                        json_array_length(p.resources_json)
                 FROM agent_skill_state s
                 JOIN agent_skill_package p ON p.digest = s.current_digest
                 WHERE s.skill_id = ?1",
                [skill_id],
                map_summary_row,
            )
            .optional()
            .map_err(|_| skill_database_error())?
            .ok_or_else(|| SkillError::new("skill-not-found", "Skill no longer exists"))
    }

    fn seed_builtin(&self) -> Result<(), SkillError> {
        let input = SkillPackageInput {
            skill_id: "luckyray-evidence-synthesis".to_owned(),
            name: "证据综合".to_owned(),
            description: "用可核对的网页与本地来源形成带引用的简洁综合。".to_owned(),
            version: "1.0.0".to_owned(),
            scope: SkillScope::global(),
            skill_md: concat!(
                "---\n",
                "name: 证据综合\n",
                "description: 用可核对的网页与本地来源形成带引用的简洁综合。\n",
                "---\n\n",
                "# 证据综合\n\n",
                "1. 先判断用户是在做简单的应用内状态确认，还是明确要求比较、核实或完整证据报告。\n",
                "2. 简单状态确认默认依据 Backend 已提交结果给出简短结论，不自行扩写为审计报告。\n",
                "3. 只有用户明确要求完整报告时，才展开已验证结论、不确定之处与证据缺口。\n",
                "4. 使用本次 capability snapshot 中真实存在的读取工具。\n",
                "5. 区分网页证据、本地知识与推断；单个可选来源失败时保留已验证证据。\n",
                "6. 最终回答必须由同一 Agent 形成，并只引用本次 RunLedger 给出的 R 编号。\n",
                "7. 不泄露绝对路径、私密正文、原始 provider body、内部身份或工具参数。\n"
            )
            .to_owned(),
            resources: vec![SkillResourceInput {
                path: "references/citation-checklist.md".to_owned(),
                content: concat!(
                    "# 引用检查\n\n",
                    "- 每个 R 引用都必须对应本次 run 的 retained source。\n",
                    "- 不把搜索结果摘要冒充已读取正文。\n",
                    "- 清楚标记由来源支持的事实和 Agent 推断。\n"
                )
                .to_owned(),
            }],
        };
        let validated = validate_package(input)?;
        let mut connection = self.open_write()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| skill_database_error())?;
        insert_immutable_package(&transaction, &validated, "builtin-audited")?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO agent_skill_state(
                    skill_id, current_digest, enabled, revision, updated_at
                 ) VALUES (?1, ?2, 1, 1, ?3)",
                params![
                    validated.package.skill_id,
                    validated.digest,
                    chrono::Utc::now().to_rfc3339()
                ],
            )
            .map_err(|_| skill_database_error())?;
        transaction.commit().map_err(|_| skill_database_error())?;
        Ok(())
    }

    fn open_read(&self) -> Result<Connection, SkillError> {
        open_connection(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }

    fn open_write(&self) -> Result<Connection, SkillError> {
        open_connection(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }
}

struct ValidatedPackage {
    package: SkillPackageInput,
    resources_json: String,
    digest: String,
}

fn validate_package(mut package: SkillPackageInput) -> Result<ValidatedPackage, SkillError> {
    validate_public_id(&package.skill_id, "skill-identity-invalid")?;
    package.scope.validate()?;
    package.name = package.name.trim().to_owned();
    package.description = package.description.trim().to_owned();
    package.version = package.version.trim().to_owned();
    package.skill_md = package.skill_md.trim().to_owned();
    if package.name.is_empty()
        || package.name.chars().count() > 120
        || package.description.is_empty()
        || package.description.chars().count() > 500
        || !valid_version(&package.version)
        || package.skill_md.is_empty()
        || package.skill_md.as_bytes().len() > MAX_SKILL_MD_BYTES
    {
        return Err(SkillError::new(
            "skill-package-invalid",
            "Skill package metadata or SKILL.md is invalid",
        ));
    }
    if package.resources.len() > MAX_RESOURCES {
        return Err(SkillError::new(
            "skill-package-invalid",
            "Skill package contains too many resources",
        ));
    }
    let mut seen = BTreeMap::new();
    let mut total_bytes = package.skill_md.as_bytes().len();
    for resource in &mut package.resources {
        validate_resource_path(&resource.path)?;
        if resource.content.as_bytes().len() > MAX_RESOURCE_BYTES || resource.content.contains('\0')
        {
            return Err(SkillError::new(
                "skill-resource-invalid",
                "Skill resource is invalid",
            ));
        }
        total_bytes = total_bytes.saturating_add(resource.content.as_bytes().len());
        if seen.insert(resource.path.clone(), ()).is_some() {
            return Err(SkillError::new(
                "skill-resource-invalid",
                "Skill resource paths must be unique",
            ));
        }
    }
    if total_bytes > MAX_PACKAGE_BYTES {
        return Err(SkillError::new(
            "skill-package-invalid",
            "Skill package is too large",
        ));
    }
    package
        .resources
        .sort_by(|left, right| left.path.cmp(&right.path));
    let resources_json =
        serde_json::to_string(&package.resources).map_err(|_| skill_database_error())?;
    let canonical = json!({
        "skillId": package.skill_id,
        "name": package.name,
        "description": package.description,
        "version": package.version,
        "scope": package.scope,
        "skillMd": package.skill_md,
        "resources": package.resources,
    });
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonical).map_err(|_| skill_database_error())?)
    );
    Ok(ValidatedPackage {
        package,
        resources_json,
        digest,
    })
}

fn insert_immutable_package(
    connection: &Connection,
    package: &ValidatedPackage,
    source: &str,
) -> Result<(), SkillError> {
    connection
        .execute(
            "INSERT OR IGNORE INTO agent_skill_package(
                digest, skill_id, name, description, version, source,
                scope_kind, scope_id, skill_md, resources_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                package.digest,
                package.package.skill_id,
                package.package.name,
                package.package.description,
                package.package.version,
                source,
                package.package.scope.kind.as_str(),
                package.package.scope.scope_id(),
                package.package.skill_md,
                package.resources_json,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|_| skill_database_error())?;
    Ok(())
}

fn map_summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SkillSummary> {
    let scope_kind = match row.get::<_, String>(6)?.as_str() {
        "vault" => SkillScopeKind::Vault,
        _ => SkillScopeKind::Global,
    };
    Ok(SkillSummary {
        skill_id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        version: row.get(3)?,
        digest: row.get(4)?,
        source: row.get(5)?,
        scope: SkillScope {
            kind: scope_kind,
            vault_id: row.get(7)?,
        },
        enabled: row.get::<_, i64>(8)? != 0,
        resource_count: row.get::<_, i64>(9)?.max(0) as usize,
    })
}

fn validate_resource_path(path: &str) -> Result<(), SkillError> {
    if path.is_empty()
        || path.as_bytes().len() > 240
        || path.contains('\\')
        || path.contains('\0')
        || Path::new(path).is_absolute()
    {
        return Err(SkillError::new(
            "skill-resource-path-invalid",
            "Skill resource path is invalid",
        ));
    }
    let mut components = Path::new(path).components();
    let Some(Component::Normal(root)) = components.next() else {
        return Err(SkillError::new(
            "skill-resource-path-invalid",
            "Skill resource path is invalid",
        ));
    };
    let root = root.to_string_lossy();
    if !matches!(
        root.as_ref(),
        "references" | "templates" | "examples" | "assets"
    ) || components.any(|component| !matches!(component, Component::Normal(_)))
        || path.to_ascii_lowercase().ends_with(".exe")
        || path.to_ascii_lowercase().ends_with(".dll")
        || path.to_ascii_lowercase().ends_with(".ps1")
        || path.to_ascii_lowercase().ends_with(".bat")
        || path.to_ascii_lowercase().ends_with(".cmd")
        || path.to_ascii_lowercase().ends_with(".py")
        || path.to_ascii_lowercase().ends_with(".js")
        || path.to_ascii_lowercase().ends_with(".mjs")
        || path.to_ascii_lowercase().ends_with(".sh")
    {
        return Err(SkillError::new(
            "skill-resource-path-invalid",
            "Only non-executable audited Skill resources are allowed",
        ));
    }
    Ok(())
}

fn validate_public_id(value: &str, code: &'static str) -> Result<(), SkillError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err(SkillError::new(code, "Skill identity is invalid"));
    }
    Ok(())
}

fn valid_version(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 6 && part.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn validate_digest(value: &str) -> Result<(), SkillError> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(SkillError::new(
            "skill-digest-invalid",
            "Skill digest is invalid",
        ))
    }
}

fn open_connection(path: &Path, flags: OpenFlags) -> Result<Connection, SkillError> {
    let connection =
        Connection::open_with_flags(path, flags).map_err(|_| skill_database_error())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| skill_database_error())?;
    Ok(connection)
}

fn skill_database_error() -> SkillError {
    SkillError::new("skill-catalog-unavailable", "Skill catalog is unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded_catalog() -> (tempfile::TempDir, SkillCatalog) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("skills.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE agent_skill_package (
                    digest TEXT PRIMARY KEY, skill_id TEXT NOT NULL, name TEXT NOT NULL,
                    description TEXT NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL,
                    scope_kind TEXT NOT NULL, scope_id TEXT, skill_md TEXT NOT NULL,
                    resources_json TEXT NOT NULL, created_at TEXT NOT NULL
                 );
                 CREATE TABLE agent_skill_state (
                    skill_id TEXT PRIMARY KEY, current_digest TEXT NOT NULL,
                    enabled INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL
                 );
                 CREATE TABLE agent_capability_registry_meta (
                    singleton INTEGER PRIMARY KEY, generation INTEGER NOT NULL,
                    updated_at TEXT NOT NULL
                 );
                 CREATE TABLE agent_capability_state (
                    pack_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at TEXT NOT NULL
                 );
                 INSERT INTO agent_capability_registry_meta(singleton,generation,updated_at)
                    VALUES (1,7,'now');
                 INSERT INTO agent_capability_state(pack_id,enabled,updated_at)
                    VALUES ('skills',1,'now');",
            )
            .unwrap();
        let catalog = SkillCatalog::initialize(path).unwrap();
        (temp, catalog)
    }

    fn insert_audited_test_skill(catalog: &SkillCatalog, skill_id: &str, scope: SkillScope) {
        let validated = validate_package(SkillPackageInput {
            skill_id: skill_id.to_owned(),
            name: format!("Skill {skill_id}"),
            description: "Audited test skill".to_owned(),
            version: "1.0.0".to_owned(),
            scope,
            skill_md: "# Audited".to_owned(),
            resources: vec![],
        })
        .unwrap();
        let mut connection = catalog.open_write().unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        insert_immutable_package(&transaction, &validated, "builtin-audited").unwrap();
        transaction
            .execute(
                "INSERT INTO agent_skill_state(skill_id,current_digest,enabled,revision,updated_at)
                 VALUES (?1,?2,1,1,'now')",
                params![skill_id, validated.digest],
            )
            .unwrap();
        transaction.commit().unwrap();
    }

    #[test]
    fn runnable_snapshot_is_backend_owned_pack_enabled_and_generation_bound() {
        let (_temp, catalog) = seeded_catalog();
        let snapshot = catalog.list_invocation_snapshot(None).unwrap();
        assert_eq!(snapshot.generation, 7);
        assert_eq!(snapshot.skills.len(), 1);
        assert_eq!(snapshot.skills[0].skill_id, "luckyray-evidence-synthesis");
        assert_eq!(
            snapshot.skills[0].invocation_id,
            "agent-skill:luckyray-evidence-synthesis"
        );
        let public = serde_json::to_value(&snapshot).unwrap();
        assert!(public.get("catalogFence").is_none());
        assert!(public.to_string().contains("digest") == false);

        catalog
            .open_write()
            .unwrap()
            .execute(
                "UPDATE agent_capability_state SET enabled=0 WHERE pack_id='skills'",
                [],
            )
            .unwrap();
        assert!(catalog
            .list_invocation_snapshot(None)
            .unwrap()
            .skills
            .is_empty());
    }

    #[test]
    fn runnable_snapshot_rejects_disabled_wrong_vault_non_audited_and_reserved_skills() {
        let (_temp, catalog) = seeded_catalog();
        insert_audited_test_skill(
            &catalog,
            "vault-a-only",
            SkillScope {
                kind: SkillScopeKind::Vault,
                vault_id: Some("vault-a".to_owned()),
            },
        );
        insert_audited_test_skill(&catalog, "schedule", SkillScope::global());
        insert_audited_test_skill(&catalog, "research", SkillScope::global());
        catalog
            .create(
                SkillCreateInput {
                    package: SkillPackageInput {
                        skill_id: "local-user-skill".to_owned(),
                        name: "Local".to_owned(),
                        description: "Not audited".to_owned(),
                        version: "1.0.0".to_owned(),
                        scope: SkillScope::global(),
                        skill_md: "# Local".to_owned(),
                        resources: vec![],
                    },
                },
                "user",
            )
            .unwrap();
        catalog
            .set_enabled("luckyray-evidence-synthesis", false)
            .unwrap();

        assert!(catalog
            .list_invocation_snapshot(Some("vault-b"))
            .unwrap()
            .skills
            .is_empty());
        assert_eq!(
            catalog
                .list_invocation_snapshot(Some("vault-a"))
                .unwrap()
                .skills
                .iter()
                .map(|skill| skill.skill_id.as_str())
                .collect::<Vec<_>>(),
            vec!["vault-a-only"]
        );
    }

    #[test]
    fn progressive_disclosure_returns_one_resource() {
        let (_temp, catalog) = seeded_catalog();
        let index = catalog.list(None).unwrap();
        assert_eq!(index.len(), 1);
        let skill = catalog
            .view("luckyray-evidence-synthesis", None, None)
            .unwrap();
        assert!(skill.skill_md.is_some());
        let skill_md = skill.skill_md.as_deref().unwrap_or_default();
        assert!(skill_md.contains("简单状态确认默认"));
        assert!(skill_md.contains("只有用户明确要求完整报告时"));
        assert!(skill.resource_content.is_none());
        let resource = catalog
            .view(
                "luckyray-evidence-synthesis",
                None,
                Some("references/citation-checklist.md"),
            )
            .unwrap();
        assert!(resource.skill_md.is_none());
        assert!(resource.resource_content.is_some());
    }

    #[test]
    fn executable_or_traversal_resources_are_rejected() {
        for path in ["scripts/run.py", "../secret.md", "references\\x.md"] {
            assert!(validate_resource_path(path).is_err(), "{path}");
        }
    }

    #[test]
    fn immutable_patch_requires_current_digest() {
        let (_temp, catalog) = seeded_catalog();
        let current = catalog.list(None).unwrap().into_iter().next().unwrap();
        let mut package = SkillPackageInput {
            skill_id: current.skill_id.clone(),
            name: current.name,
            description: "updated description".into(),
            version: "1.0.1".into(),
            scope: SkillScope::global(),
            skill_md: "# Updated".into(),
            resources: vec![],
        };
        let conflict = catalog
            .patch(
                SkillPatchInput {
                    expected_digest: "0".repeat(64),
                    package: package.clone(),
                },
                "user",
            )
            .unwrap_err();
        assert_eq!(conflict.code, "skill-revision-conflict");
        package.description = "approved update".into();
        let updated = catalog
            .patch(
                SkillPatchInput {
                    expected_digest: current.digest,
                    package,
                },
                "user",
            )
            .unwrap();
        assert_eq!(updated.version, "1.0.1");
    }
}
