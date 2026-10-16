use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use crate::knowledge::KnowledgeService;
use crate::materials::{self, MaterialCatalog};
use crate::tools::{
    AgentWritePermit, AgentWriteScope, PreparedAgentWrite, ToolCallContext, ToolDefinition,
    ToolError, ToolRegistry, ToolRunRequest, ToolRunResult,
};

mod schema_compat;

const SCHEMA_VERSION: u32 = 26;
#[derive(Clone, Copy)]
struct TableSpec {
    name: &'static str,
    columns: &'static [ColumnSpec],
}

#[derive(Clone, Copy)]
struct ColumnSpec {
    name: &'static str,
    requirement: ColumnRequirement,
}

#[derive(Clone, Copy)]
enum ColumnRequirement {
    Present,
    PrimaryKey,
    NotNullPrimaryKey,
    NotNull,
    NotNullDefault(&'static str),
}

#[derive(Clone, Copy)]
struct FtsSpec {
    name: &'static str,
    columns: &'static [&'static str],
    allowed_external_content: Option<&'static str>,
}

#[derive(Clone, Copy)]
struct IndexSpec {
    name: &'static str,
    table: &'static str,
    columns: &'static [&'static str],
}

#[derive(Clone, Copy)]
struct TriggerSpec {
    name: &'static str,
    table: &'static str,
}

const REQUIRED_TABLES: &[TableSpec] = &[
    TableSpec { name: "companion_service_grant", columns: &[
        column("device_id", ColumnRequirement::NotNullPrimaryKey),
        column("grant_class", ColumnRequirement::NotNullPrimaryKey),
        column("scope_kind", ColumnRequirement::NotNullPrimaryKey),
        column("scope_id", ColumnRequirement::NotNullPrimaryKey),
        column("granted_at", ColumnRequirement::NotNull)] },
    TableSpec { name: "companion_service_operation", columns: &[
        column("instance_id", ColumnRequirement::NotNullPrimaryKey),
        column("device_id", ColumnRequirement::NotNullPrimaryKey),
        column("operation_id", ColumnRequirement::NotNullPrimaryKey),
        column("op_id", ColumnRequirement::NotNullPrimaryKey),
        column("target_key", ColumnRequirement::NotNull),
        column("payload_sha256", ColumnRequirement::NotNull),
        column("stage", ColumnRequirement::NotNull)] },
    TableSpec { name: "companion_service_upload", columns: &[
        column("job_id", ColumnRequirement::NotNullPrimaryKey),
        column("instance_id", ColumnRequirement::NotNull),
        column("device_id", ColumnRequirement::NotNull),
        column("op_id", ColumnRequirement::NotNull),
        column("manifest", ColumnRequirement::NotNull),
        column("committed_bytes", ColumnRequirement::NotNull),
        column("stage", ColumnRequirement::NotNull)] },
    TableSpec { name: "companion_service_change", columns: &[
        column("seq", ColumnRequirement::PrimaryKey),
        column("domain", ColumnRequirement::NotNull),
        column("scope_id", ColumnRequirement::NotNull),
        column("object_id", ColumnRequirement::NotNull),
        column("revision", ColumnRequirement::NotNull)] },
    TableSpec { name: "companion_service_search_snapshot", columns: &[
        column("snapshot_id", ColumnRequirement::NotNullPrimaryKey),
        column("instance_id", ColumnRequirement::NotNull),
        column("device_id", ColumnRequirement::NotNull),
        column("query_key", ColumnRequirement::NotNull),
        column("permission_revision", ColumnRequirement::NotNull),
        column("expires_at", ColumnRequirement::NotNull),
        column("items_json", ColumnRequirement::NotNull)] },
    TableSpec { name: "companion_content_note", columns: &[
        column("vault_key", ColumnRequirement::NotNullPrimaryKey), column("note_id", ColumnRequirement::NotNullPrimaryKey),
        column("path", ColumnRequirement::NotNull), column("revision", ColumnRequirement::NotNull), column("summary", ColumnRequirement::NotNull)] },
    TableSpec { name: "companion_content_change", columns: &[
        column("seq", ColumnRequirement::PrimaryKey), column("vault_key", ColumnRequirement::NotNull), column("note_id", ColumnRequirement::NotNull), column("deleted", ColumnRequirement::NotNull)] },
    TableSpec { name: "companion_content_cursor", columns: &[
        column("vault_key", ColumnRequirement::PrimaryKey), column("floor", ColumnRequirement::NotNull)] },
    TableSpec { name: "companion_content_operation", columns: &[
        column("device_id", ColumnRequirement::NotNullPrimaryKey), column("op_id", ColumnRequirement::NotNullPrimaryKey), column("payload", ColumnRequirement::NotNull), column("stage", ColumnRequirement::NotNull), column("result", ColumnRequirement::Present)] },
    TableSpec { name: "companion_content_upload", columns: &[
        column("device_id", ColumnRequirement::NotNullPrimaryKey), column("op_id", ColumnRequirement::NotNullPrimaryKey), column("manifest", ColumnRequirement::NotNull), column("committed_bytes", ColumnRequirement::NotNull), column("receipt", ColumnRequirement::Present)] },
    TableSpec {
        name: "ai_conversation",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("title", ColumnRequirement::NotNull),
            column("created_at", ColumnRequirement::NotNull),
            column("updated_at", ColumnRequirement::NotNull),
            column("agent_mode", ColumnRequirement::NotNullDefault("standard")),
            column("project_id", ColumnRequirement::Present),
            column("pinned_at", ColumnRequirement::Present),
            column("archived_at", ColumnRequirement::Present),
        ],
    },
    TableSpec {
        name: "agent_project",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("title", ColumnRequirement::NotNull),
            column("primary_workspace_grant_id", ColumnRequirement::NotNull),
            column("sort_order", ColumnRequirement::NotNullDefault("0")),
            column("created_at", ColumnRequirement::NotNull),
            column("updated_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "agent_project_knowledge_binding",
        columns: &[
            column("project_id", ColumnRequirement::NotNullPrimaryKey),
            column("knowledge_target_id", ColumnRequirement::NotNullPrimaryKey),
            column("target_identity_digest", ColumnRequirement::NotNull),
            column("target_label", ColumnRequirement::NotNull),
            column("created_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "ai_message",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("conversation_id", ColumnRequirement::NotNull),
            column("role", ColumnRequirement::NotNull),
            column("content", ColumnRequirement::NotNull),
            column("created_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "ai_message_action_truth",
        columns: &[
            column("message_id", ColumnRequirement::PrimaryKey),
            column("workspace_status", ColumnRequirement::NotNull),
            column("execution_status", ColumnRequirement::NotNull),
            column("created_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "ai_run",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("conversation_id", ColumnRequirement::NotNull),
            column("trigger_message_id", ColumnRequirement::NotNull),
            column("result_message_id", ColumnRequirement::Present),
            column("kind", ColumnRequirement::NotNull),
            column("execution_mode", ColumnRequirement::NotNull),
            column("policy_id", ColumnRequirement::NotNull),
            column("policy_version", ColumnRequirement::NotNullDefault("1")),
            column("status", ColumnRequirement::NotNull),
            column("phase", ColumnRequirement::NotNull),
            column("partial", ColumnRequirement::NotNullDefault("0")),
            column("model_used", ColumnRequirement::NotNullDefault("0")),
            column("tool_used", ColumnRequirement::NotNullDefault("0")),
            column("source_count", ColumnRequirement::NotNullDefault("0")),
            column("candidate_count", ColumnRequirement::NotNullDefault("0")),
            column("elapsed_ms", ColumnRequirement::NotNullDefault("0")),
            column("safe_code", ColumnRequirement::Present),
            column("committed_warning", ColumnRequirement::NotNullDefault("0")),
            column("stop_cause", ColumnRequirement::Present),
            column("stop_transport", ColumnRequirement::Present),
            column("restart_of_run_id", ColumnRequirement::Present),
            column("vault_binding_digest", ColumnRequirement::Present),
            column("created_at", ColumnRequirement::NotNull),
            column("started_at", ColumnRequirement::Present),
            column("updated_at", ColumnRequirement::NotNull),
            column("terminal_at", ColumnRequirement::Present),
            column("version", ColumnRequirement::NotNullDefault("0")),
        ],
    },
    TableSpec {
        name: "ai_run_source",
        columns: &[
            column("run_id", ColumnRequirement::NotNull),
            column("ordinal", ColumnRequirement::NotNull),
            column("reference_label", ColumnRequirement::NotNull),
            column("source_token", ColumnRequirement::NotNull),
            column("kind", ColumnRequirement::NotNull),
            column("host", ColumnRequirement::Present),
            column("retained", ColumnRequirement::NotNullDefault("1")),
            column("cited", ColumnRequirement::NotNullDefault("0")),
        ],
    },
    TableSpec {
        name: "ai_run_artifact",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("run_id", ColumnRequirement::NotNull),
            column("public_token", ColumnRequirement::NotNull),
            column("entity_kind", ColumnRequirement::NotNull),
            column("entity_ref", ColumnRequirement::NotNull),
            column("operation_digest", ColumnRequirement::NotNull),
            column("expected_revision", ColumnRequirement::Present),
            column("new_revision", ColumnRequirement::Present),
            column("receipt_state", ColumnRequirement::NotNull),
            column("display_name", ColumnRequirement::NotNull),
            column("status", ColumnRequirement::NotNull),
            column("action_truth", ColumnRequirement::Present),
            column("safe_result_summary", ColumnRequirement::Present),
            column("created_at", ColumnRequirement::NotNull),
            column("updated_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "asset",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("name", ColumnRequirement::NotNull),
            column("original_path", ColumnRequirement::NotNull),
            column("library_path", ColumnRequirement::Present),
            column("storage_mode", ColumnRequirement::NotNullDefault("linked")),
            column("kind", ColumnRequirement::NotNull),
            column("mime_type", ColumnRequirement::Present),
            column("size_bytes", ColumnRequirement::Present),
            column("thumbnail_url", ColumnRequirement::Present),
            column("description", ColumnRequirement::Present),
            column("rating", ColumnRequirement::Present),
            column("dominant_color", ColumnRequirement::Present),
            column("folder_id", ColumnRequirement::Present),
            column("imported_at", ColumnRequirement::NotNull),
            column("updated_at", ColumnRequirement::Present),
            column("content_hash", ColumnRequirement::Present),
        ],
    },
    TableSpec {
        name: "asset_ai",
        columns: &[
            column("asset_id", ColumnRequirement::PrimaryKey),
            column("description", ColumnRequirement::Present),
            column("auto_tags", ColumnRequirement::Present),
            column("status", ColumnRequirement::NotNullDefault("pending")),
            column("error", ColumnRequirement::Present),
            column("processed_at", ColumnRequirement::Present),
        ],
    },
    TableSpec {
        name: "backend_schema_migration",
        columns: &[
            column("version", ColumnRequirement::PrimaryKey),
            column("name", ColumnRequirement::NotNull),
            column("applied_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "collection_failure",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("source", ColumnRequirement::NotNull),
            column("payload", ColumnRequirement::NotNull),
            column("error", ColumnRequirement::NotNull),
            column("created_at", ColumnRequirement::NotNull),
            column("reason", ColumnRequirement::NotNullDefault("unknown")),
        ],
    },
    TableSpec {
        name: "collection_item",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("type", ColumnRequirement::NotNull),
            column("content", ColumnRequirement::NotNull),
            column("asset_id", ColumnRequirement::Present),
            column("url_metadata", ColumnRequirement::Present),
            column("source", ColumnRequirement::Present),
            column("created_at", ColumnRequirement::NotNull),
            column("processed_at", ColumnRequirement::Present),
            column("processed_note_id", ColumnRequirement::Present),
            column("processed_action", ColumnRequirement::Present),
            column("thumbnail", ColumnRequirement::Present),
            column("browser", ColumnRequirement::Present),
            column("trigger", ColumnRequirement::Present),
            column("processed_asset_id", ColumnRequirement::Present),
        ],
    },
    TableSpec {
        name: "folder",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("scope", ColumnRequirement::NotNull),
            column("parent_id", ColumnRequirement::Present),
            column("name", ColumnRequirement::NotNull),
            column("sort_order", ColumnRequirement::NotNullDefault("0")),
            column("open", ColumnRequirement::NotNullDefault("1")),
            column("created_at", ColumnRequirement::NotNull),
            column("updated_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "favorite_item",
        columns: &[
            column("item_type", ColumnRequirement::NotNullPrimaryKey),
            column("item_id", ColumnRequirement::NotNullPrimaryKey),
            column("theme", ColumnRequirement::NotNullDefault("")),
            column("copy", ColumnRequirement::NotNullDefault("")),
            column("favorited_at", ColumnRequirement::NotNull),
            column("note_updated_at", ColumnRequirement::Present),
        ],
    },
    TableSpec {
        name: "smart_folder_definition",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("name", ColumnRequirement::NotNull),
            column("source", ColumnRequirement::NotNull),
            column("criteria_version", ColumnRequirement::NotNull),
            column("criteria_json", ColumnRequirement::NotNull),
            column("sort", ColumnRequirement::NotNull),
            column("created_at", ColumnRequirement::NotNull),
            column("updated_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "companion_identity",
        columns: &[
            column("singleton", ColumnRequirement::PrimaryKey),
            column("desktop_instance_id", ColumnRequirement::NotNull),
            column("certificate_der", ColumnRequirement::NotNull),
            column("certificate_fingerprint", ColumnRequirement::NotNull),
            column("created_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "companion_device",
        columns: &[
            column("device_id", ColumnRequirement::PrimaryKey),
            column("label", ColumnRequirement::NotNull),
            column("credential_verifier", ColumnRequirement::NotNull),
            column("created_at", ColumnRequirement::NotNull),
            column("last_authenticated_at", ColumnRequirement::Present),
            column("revoked_at", ColumnRequirement::Present),
        ],
    },
    TableSpec {
        name: "companion_security_audit",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("action", ColumnRequirement::NotNull),
            column("device_id", ColumnRequirement::Present),
            column("occurred_at", ColumnRequirement::NotNull),
            column("result", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "item_tag",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("item_type", ColumnRequirement::NotNull),
            column("item_id", ColumnRequirement::NotNull),
            column("tag_id", ColumnRequirement::NotNull),
            column("created_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "local_capability",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("type", ColumnRequirement::NotNull),
            column("name", ColumnRequirement::NotNull),
            column("description", ColumnRequirement::NotNull),
            column("enabled", ColumnRequirement::NotNullDefault("1")),
            column("status", ColumnRequirement::NotNullDefault("ready")),
            column("last_run_at", ColumnRequirement::Present),
            column("last_result", ColumnRequirement::Present),
            column("last_error", ColumnRequirement::Present),
            column("created_at", ColumnRequirement::NotNull),
            column("updated_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "material_change_state",
        columns: &[
            column("singleton", ColumnRequirement::PrimaryKey),
            column("version", ColumnRequirement::NotNullDefault("0")),
            column("reason", ColumnRequirement::NotNullDefault("bootstrap")),
            column("affected_ids_json", ColumnRequirement::NotNullDefault("[]")),
            column("folders_changed", ColumnRequirement::NotNullDefault("0")),
            column("occurred_at", ColumnRequirement::NotNullDefault("")),
        ],
    },
    TableSpec {
        name: "material_delete_pending_identity",
        columns: &[
            column("token", ColumnRequirement::PrimaryKey),
            column("asset_id", ColumnRequirement::NotNull),
            column("storage_mode", ColumnRequirement::NotNull),
            column("content_hash", ColumnRequirement::NotNull),
            column("canonical_path", ColumnRequirement::NotNull),
            column("root_id", ColumnRequirement::Present),
            column("created_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "memory_entries",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("content", ColumnRequirement::NotNull),
            column("source", ColumnRequirement::Present),
            column("importance", ColumnRequirement::Present),
            column("created_at", ColumnRequirement::Present),
            column("accessed_count", ColumnRequirement::Present),
            column("scope_kind", ColumnRequirement::NotNullDefault("global")),
            column("scope_id", ColumnRequirement::Present),
            column("revision", ColumnRequirement::NotNullDefault("1")),
            column("updated_at", ColumnRequirement::NotNullDefault("")),
            column("expires_at", ColumnRequirement::Present),
            column("source_kind", ColumnRequirement::NotNullDefault("legacy")),
            column("source_ref", ColumnRequirement::Present),
        ],
    },
    TableSpec {
        name: "agent_capability_registry_meta",
        columns: &[
            column("singleton", ColumnRequirement::PrimaryKey),
            column("generation", ColumnRequirement::NotNullDefault("1")),
            column("updated_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "agent_capability_state",
        columns: &[
            column("pack_id", ColumnRequirement::PrimaryKey),
            column("enabled", ColumnRequirement::NotNullDefault("1")),
            column("updated_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "ai_run_capability_snapshot",
        columns: &[
            column("run_id", ColumnRequirement::PrimaryKey),
            column("schema_version", ColumnRequirement::NotNull),
            column("generation", ColumnRequirement::NotNull),
            column("profile", ColumnRequirement::NotNull),
            column("digest", ColumnRequirement::NotNull),
            column("manifest_json", ColumnRequirement::NotNull),
            column("provider_digest", ColumnRequirement::NotNull),
            column("skill_digest", ColumnRequirement::NotNull),
            column("scope_digest", ColumnRequirement::NotNull),
            column("created_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "agent_skill_package",
        columns: &[
            column("digest", ColumnRequirement::PrimaryKey),
            column("skill_id", ColumnRequirement::NotNull),
            column("name", ColumnRequirement::NotNull),
            column("description", ColumnRequirement::NotNull),
            column("version", ColumnRequirement::NotNull),
            column("source", ColumnRequirement::NotNull),
            column("scope_kind", ColumnRequirement::NotNull),
            column("scope_id", ColumnRequirement::Present),
            column("skill_md", ColumnRequirement::NotNull),
            column("resources_json", ColumnRequirement::NotNull),
            column("created_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "agent_skill_state",
        columns: &[
            column("skill_id", ColumnRequirement::PrimaryKey),
            column("current_digest", ColumnRequirement::NotNull),
            column("enabled", ColumnRequirement::NotNullDefault("1")),
            column("revision", ColumnRequirement::NotNullDefault("1")),
            column("updated_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "agent_workspace_grant",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("label", ColumnRequirement::NotNull),
            column("canonical_root", ColumnRequirement::NotNull),
            column("root_name", ColumnRequirement::NotNull),
            column("root_digest", ColumnRequirement::NotNull),
            column("enabled", ColumnRequirement::NotNullDefault("1")),
            column("created_at", ColumnRequirement::NotNull),
            column("updated_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "agent_schedule",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("title", ColumnRequirement::NotNull),
            column("prompt", ColumnRequirement::NotNull),
            column("conversation_id", ColumnRequirement::NotNull),
            column("kind", ColumnRequirement::NotNull),
            column("interval_seconds", ColumnRequirement::Present),
            column("next_fire_at", ColumnRequirement::Present),
            column("status", ColumnRequirement::NotNull),
            column("revision", ColumnRequirement::NotNullDefault("1")),
            column("last_run_id", ColumnRequirement::Present),
            column("last_safe_code", ColumnRequirement::Present),
            column("retired_at", ColumnRequirement::Present),
            column("completed_at", ColumnRequirement::Present),
            column("created_at", ColumnRequirement::NotNull),
            column("updated_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "agent_schedule_fire",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("schedule_id", ColumnRequirement::NotNull),
            column("due_at", ColumnRequirement::NotNull),
            column("trigger_kind", ColumnRequirement::NotNull),
            column("state", ColumnRequirement::NotNull),
            column("run_id", ColumnRequirement::Present),
            column("safe_code", ColumnRequirement::Present),
            column("stop_requested_at", ColumnRequirement::Present),
            column("created_at", ColumnRequirement::NotNull),
            column("updated_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "settings",
        columns: &[
            column("key", ColumnRequirement::PrimaryKey),
            column("value", ColumnRequirement::Present),
        ],
    },
    TableSpec {
        name: "tag",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("name", ColumnRequirement::NotNull),
            column("color", ColumnRequirement::Present),
            column("created_at", ColumnRequirement::NotNull),
            column("updated_at", ColumnRequirement::NotNull),
        ],
    },
];

const fn column(name: &'static str, requirement: ColumnRequirement) -> ColumnSpec {
    ColumnSpec { name, requirement }
}

const REQUIRED_FTS: &[FtsSpec] = &[
    FtsSpec {
        name: "asset_search",
        columns: &["id", "name", "description", "original_path"],
        allowed_external_content: None,
    },
    FtsSpec {
        name: "collection_item_search",
        columns: &["title", "url", "selection"],
        allowed_external_content: Some("collection_item"),
    },
];

const REQUIRED_INDEXES: &[IndexSpec] = &[
    IndexSpec {
        name: "idx_agent_project_knowledge_target",
        table: "agent_project_knowledge_binding",
        columns: &["knowledge_target_id", "project_id"],
    },
    IndexSpec {
        name: "idx_agent_project_sort",
        table: "agent_project",
        columns: &["sort_order", "updated_at"],
    },
    IndexSpec {
        name: "idx_ai_conversation_project_updated",
        table: "ai_conversation",
        columns: &["project_id", "updated_at"],
    },
    IndexSpec {
        name: "idx_ai_conversation_agent_mode_updated",
        table: "ai_conversation",
        columns: &["agent_mode", "updated_at"],
    },
    IndexSpec {
        name: "idx_ai_msg_conv",
        table: "ai_message",
        columns: &["conversation_id", "created_at"],
    },
    IndexSpec {
        name: "idx_ai_run_status_updated",
        table: "ai_run",
        columns: &["status", "updated_at"],
    },
    IndexSpec {
        name: "idx_ai_run_conversation_created",
        table: "ai_run",
        columns: &["conversation_id", "created_at"],
    },
    IndexSpec {
        name: "idx_memory_scope_updated",
        table: "memory_entries",
        columns: &["scope_kind", "scope_id", "updated_at"],
    },
    IndexSpec {
        name: "idx_agent_skill_package_id",
        table: "agent_skill_package",
        columns: &["skill_id", "created_at"],
    },
    IndexSpec {
        name: "idx_agent_schedule_due",
        table: "agent_schedule",
        columns: &["status", "next_fire_at"],
    },
    IndexSpec {
        name: "idx_agent_schedule_fire_state",
        table: "agent_schedule_fire",
        columns: &["state", "created_at"],
    },
    IndexSpec {
        name: "idx_agent_schedule_fire_run",
        table: "agent_schedule_fire",
        columns: &["run_id"],
    },
    IndexSpec {
        name: "idx_agent_schedule_fire_schedule",
        table: "agent_schedule_fire",
        columns: &["schedule_id", "created_at"],
    },
    IndexSpec {
        name: "idx_ai_run_terminal",
        table: "ai_run",
        columns: &["terminal_at"],
    },
    IndexSpec {
        name: "idx_ai_run_source_run",
        table: "ai_run_source",
        columns: &["run_id", "ordinal"],
    },
    IndexSpec {
        name: "idx_ai_run_artifact_run",
        table: "ai_run_artifact",
        columns: &["run_id", "created_at"],
    },
    IndexSpec {
        name: "idx_asset_content_hash",
        table: "asset",
        columns: &["content_hash"],
    },
    IndexSpec {
        name: "idx_asset_imported_at",
        table: "asset",
        columns: &["imported_at"],
    },
    IndexSpec {
        name: "idx_collection_processed",
        table: "collection_item",
        columns: &["processed_at", "created_at"],
    },
    IndexSpec {
        name: "idx_collection_processed_action",
        table: "collection_item",
        columns: &["processed_action", "processed_at"],
    },
    IndexSpec {
        name: "idx_collection_source",
        table: "collection_item",
        columns: &["source", "created_at"],
    },
    IndexSpec {
        name: "idx_collection_type",
        table: "collection_item",
        columns: &["type"],
    },
    IndexSpec {
        name: "idx_collection_type_processed",
        table: "collection_item",
        columns: &["type", "processed_action", "created_at"],
    },
    IndexSpec {
        name: "idx_folder_scope_parent",
        table: "folder",
        columns: &["scope", "parent_id", "sort_order"],
    },
    IndexSpec {
        name: "idx_favorite_item_type_favorited",
        table: "favorite_item",
        columns: &["item_type", "favorited_at"],
    },
    IndexSpec {
        name: "idx_item_tag_item",
        table: "item_tag",
        columns: &["item_type", "item_id"],
    },
    IndexSpec {
        name: "idx_item_tag_tag",
        table: "item_tag",
        columns: &["tag_id"],
    },
];

const REQUIRED_TRIGGERS: &[TriggerSpec] = &[
    TriggerSpec {
        name: "ai_message_action_truth_insert_guard",
        table: "ai_message_action_truth",
    },
    TriggerSpec {
        name: "ai_message_action_truth_immutable",
        table: "ai_message_action_truth",
    },
    TriggerSpec {
        name: "agent_project_knowledge_insert",
        table: "agent_project_knowledge_binding",
    },
    TriggerSpec {
        name: "agent_project_knowledge_update",
        table: "agent_project_knowledge_binding",
    },
    TriggerSpec {
        name: "agent_project_knowledge_project_delete",
        table: "agent_project",
    },
    TriggerSpec {
        name: "ai_conversation_project_insert",
        table: "ai_conversation",
    },
    TriggerSpec {
        name: "ai_conversation_project_update",
        table: "ai_conversation",
    },
    TriggerSpec {
        name: "asset_search_ad",
        table: "asset",
    },
    TriggerSpec {
        name: "asset_search_ai",
        table: "asset",
    },
    TriggerSpec {
        name: "asset_search_au",
        table: "asset",
    },
    TriggerSpec {
        name: "collection_item_ad",
        table: "collection_item",
    },
    TriggerSpec {
        name: "collection_item_ai",
        table: "collection_item",
    },
    TriggerSpec {
        name: "collection_item_au",
        table: "collection_item",
    },
    TriggerSpec {
        name: "material_change_asset_delete",
        table: "asset",
    },
    TriggerSpec {
        name: "material_change_asset_insert",
        table: "asset",
    },
    TriggerSpec {
        name: "material_change_asset_tag_delete",
        table: "item_tag",
    },
    TriggerSpec {
        name: "material_change_asset_tag_insert",
        table: "item_tag",
    },
    TriggerSpec {
        name: "material_change_asset_update",
        table: "asset",
    },
    TriggerSpec {
        name: "material_change_folder_delete",
        table: "folder",
    },
    TriggerSpec {
        name: "material_change_folder_insert",
        table: "folder",
    },
    TriggerSpec {
        name: "material_change_folder_update",
        table: "folder",
    },
    TriggerSpec {
        name: "material_change_tag_delete",
        table: "tag",
    },
    TriggerSpec {
        name: "material_change_tag_insert",
        table: "tag",
    },
    TriggerSpec {
        name: "material_change_tag_update",
        table: "tag",
    },
];

const RETIRED_NOTE_TABLES: &[TableSpec] = &[
    TableSpec {
        name: "note",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("title", ColumnRequirement::NotNull),
            column("content_json", ColumnRequirement::Present),
            column("content_text", ColumnRequirement::Present),
            column("folder_id", ColumnRequirement::Present),
            column("color", ColumnRequirement::Present),
            column("created_at", ColumnRequirement::NotNull),
            column("updated_at", ColumnRequirement::NotNull),
            column("deleted_at", ColumnRequirement::Present),
        ],
    },
    TableSpec {
        name: "note_ai",
        columns: &[
            column("note_id", ColumnRequirement::PrimaryKey),
            column("summary", ColumnRequirement::Present),
            column("auto_tags", ColumnRequirement::Present),
            column("status", ColumnRequirement::NotNullDefault("pending")),
            column("error", ColumnRequirement::Present),
            column("processed_at", ColumnRequirement::Present),
        ],
    },
    TableSpec {
        name: "note_asset_embed",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("note_id", ColumnRequirement::NotNull),
            column("asset_id", ColumnRequirement::Present),
            column("target_name", ColumnRequirement::NotNull),
            column("is_missing", ColumnRequirement::NotNullDefault("0")),
            column("created_at", ColumnRequirement::NotNull),
        ],
    },
    TableSpec {
        name: "note_link",
        columns: &[
            column("id", ColumnRequirement::PrimaryKey),
            column("from_note_id", ColumnRequirement::NotNull),
            column("to_note_id", ColumnRequirement::Present),
            column("target_title", ColumnRequirement::NotNull),
            column("is_missing", ColumnRequirement::NotNullDefault("0")),
            column("created_at", ColumnRequirement::NotNull),
        ],
    },
];

const RETIRED_NOTE_FTS: FtsSpec = FtsSpec {
    name: "note_search",
    columns: &["id", "title", "content_text"],
    allowed_external_content: None,
};

const RETIRED_NOTE_INDEXES: &[IndexSpec] = &[
    IndexSpec {
        name: "idx_note_asset_embed_asset",
        table: "note_asset_embed",
        columns: &["asset_id"],
    },
    IndexSpec {
        name: "idx_note_asset_embed_note",
        table: "note_asset_embed",
        columns: &["note_id"],
    },
    IndexSpec {
        name: "idx_note_folder",
        table: "note",
        columns: &["folder_id"],
    },
    IndexSpec {
        name: "idx_note_link_from",
        table: "note_link",
        columns: &["from_note_id"],
    },
    IndexSpec {
        name: "idx_note_link_to",
        table: "note_link",
        columns: &["to_note_id"],
    },
    IndexSpec {
        name: "idx_note_updated",
        table: "note",
        columns: &["updated_at"],
    },
];

const RETIRED_NOTE_TRIGGERS: &[TriggerSpec] = &[
    TriggerSpec {
        name: "note_search_ad",
        table: "note",
    },
    TriggerSpec {
        name: "note_search_ai",
        table: "note",
    },
    TriggerSpec {
        name: "note_search_au",
        table: "note",
    },
];

const RETIRED_NOTE_SCHEMA_OBJECTS: &[&str] = &[
    "note",
    "note_ai",
    "note_asset_embed",
    "note_link",
    "note_search",
    "note_search_data",
    "note_search_idx",
    "note_search_content",
    "note_search_docsize",
    "note_search_config",
    "idx_note_asset_embed_asset",
    "idx_note_asset_embed_note",
    "idx_note_folder",
    "idx_note_link_from",
    "idx_note_link_to",
    "idx_note_updated",
    "note_search_ad",
    "note_search_ai",
    "note_search_au",
];

const RETIRED_NOTE_DATA_TABLES: &[&str] = &[
    "note",
    "note_ai",
    "note_asset_embed",
    "note_link",
    "note_search",
];

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendBootstrapStatus {
    pub ready: bool,
    pub schema_version: u32,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BackendBootstrapError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for BackendBootstrapError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for BackendBootstrapError {}

#[derive(Clone)]
pub(crate) struct BackendServices {
    app_data_dir: PathBuf,
    db_path: PathBuf,
    material_catalog: MaterialCatalog,
    media_transfer: crate::media_transfer::MediaTransferService,
    knowledge: KnowledgeService,
    tools: ToolRegistry,
    agent_capabilities: crate::agent_capabilities::AgentCapabilityRegistry,
    memory: crate::agent_memory::MemoryService,
    projects: crate::agent_projects::AgentProjectService,
    skills: crate::agent_skills::SkillCatalog,
    workspace: crate::agent_workspace::WorkspaceGrantService,
    agent_materials: crate::agent_materials::AgentMaterialService,
    schedules: crate::agent_schedules::AgentScheduleService,
    execution: crate::agent_execution::ExecutionRecipeCatalog,
    web_tools: crate::web_tools::WebToolService,
    agent_browser: crate::agent_browser::AgentBrowserRuntime,
    agent_runs: crate::agent_runs::RunCoordinator,
    notes_inline: crate::notes_inline::NotesInlineService,
    canvas_agent: crate::canvas_agent::CanvasAgentService,
    status: BackendBootstrapStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BootstrapFault {
    None,
    AfterCoreSchema,
    AfterLegacyCollectionColumns,
    AfterRetiredNoteDrop,
}

impl BackendServices {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn initialize(
        app_data_dir: impl AsRef<Path>,
    ) -> Result<Self, BackendBootstrapError> {
        Self::initialize_internal(app_data_dir.as_ref(), BootstrapFault::None)
    }

    pub(crate) fn initialize_product(
        app_data_dir: impl AsRef<Path>,
        resource_dir: impl AsRef<Path>,
    ) -> Result<Self, BackendBootstrapError> {
        let mut backend = Self::initialize_internal(app_data_dir.as_ref(), BootstrapFault::None)?;
        backend.media_transfer = backend
            .media_transfer
            .with_app_owned_resolver(resource_dir.as_ref());
        backend.agent_browser = crate::agent_browser::AgentBrowserRuntime::initialize()
            .unwrap_or_else(|_| crate::agent_browser::AgentBrowserRuntime::unavailable());
        backend.execution =
            crate::agent_execution::ExecutionRecipeCatalog::app_owned(resource_dir.as_ref());
        Ok(backend)
    }

    #[cfg(test)]
    fn initialize_with_test_failure(
        app_data_dir: impl AsRef<Path>,
    ) -> Result<Self, BackendBootstrapError> {
        Self::initialize_internal(app_data_dir.as_ref(), BootstrapFault::AfterCoreSchema)
    }

    #[cfg(test)]
    fn initialize_with_v2_test_failure(
        app_data_dir: impl AsRef<Path>,
    ) -> Result<Self, BackendBootstrapError> {
        Self::initialize_internal(
            app_data_dir.as_ref(),
            BootstrapFault::AfterLegacyCollectionColumns,
        )
    }

    #[cfg(test)]
    fn initialize_with_v3_test_failure(
        app_data_dir: impl AsRef<Path>,
    ) -> Result<Self, BackendBootstrapError> {
        Self::initialize_internal(app_data_dir.as_ref(), BootstrapFault::AfterRetiredNoteDrop)
    }

    fn initialize_internal(
        app_data_dir: &Path,
        fault: BootstrapFault,
    ) -> Result<Self, BackendBootstrapError> {
        let app_data_dir = app_data_dir.to_path_buf();
        std::fs::create_dir_all(&app_data_dir).map_err(|error| BackendBootstrapError {
            code: "backend-app-data-unavailable",
            message: format!("无法创建应用数据目录: {error}"),
        })?;
        let db_path = app_data_dir.join("luckyray.db");
        let mut connection = open_bootstrap_connection(&db_path)?;
        migrate_schema(&mut connection, fault)?;
        let material_catalog = MaterialCatalog::new(&db_path, &app_data_dir);
        let _ = material_catalog.retry_pending_deletions();
        let media_transfer = crate::media_transfer::MediaTransferService::new(
            &app_data_dir,
            material_catalog.clone(),
        )
        .map_err(|_| BackendBootstrapError {
            code: "backend-media-transfer-unavailable",
            message: "媒体传输服务初始化失败".to_string(),
        })?;
        let knowledge =
            KnowledgeService::initialize(&app_data_dir).map_err(|error| BackendBootstrapError {
                code: error.code,
                message: error.message,
            })?;
        let tools = ToolRegistry::initialize().map_err(|error| BackendBootstrapError {
            code: error.code,
            message: error.message,
        })?;
        let agent_capabilities = crate::agent_capabilities::AgentCapabilityRegistry::initialize(
            &db_path,
        )
        .map_err(|error| BackendBootstrapError {
            code: error.code,
            message: error.message,
        })?;
        let memory = crate::agent_memory::MemoryService::new(&db_path);
        let skills = crate::agent_skills::SkillCatalog::initialize(&db_path).map_err(|error| {
            BackendBootstrapError {
                code: error.code,
                message: error.message,
            }
        })?;
        let workspace = crate::agent_workspace::WorkspaceGrantService::new_with_management(
            &db_path,
            Arc::new(crate::agent_workspace::WorkspaceManagementBindings::default()),
        );
        let projects = crate::agent_projects::AgentProjectService::new(
            &db_path,
            workspace.clone(),
            knowledge.clone(),
        );
        let agent_materials = crate::agent_materials::AgentMaterialService::new(
            material_catalog.clone(),
            workspace.clone(),
        );
        let schedules = crate::agent_schedules::AgentScheduleService::initialize(&db_path)
            .map_err(|error| BackendBootstrapError {
                code: error.code,
                message: error.message,
            })?;
        let web_tools = crate::web_tools::WebToolService::new();
        let execution = crate::agent_execution::ExecutionRecipeCatalog::unavailable();
        let agent_browser = crate::agent_browser::AgentBrowserRuntime::unavailable();
        let agent_runs = crate::agent_runs::RunCoordinator::open(&db_path).map_err(|error| {
            BackendBootstrapError {
                code: error.code,
                message: "Agent run ledger initialization failed".to_owned(),
            }
        })?;
        let notes_inline = crate::notes_inline::NotesInlineService::default();
        let canvas_agent = crate::canvas_agent::CanvasAgentService::new(&app_data_dir);
        Ok(Self {
            app_data_dir,
            db_path,
            material_catalog,
            media_transfer,
            knowledge,
            tools,
            agent_capabilities,
            memory,
            projects,
            skills,
            workspace,
            agent_materials,
            schedules,
            execution,
            web_tools,
            agent_browser,
            agent_runs,
            notes_inline,
            canvas_agent,
            status: BackendBootstrapStatus {
                ready: true,
                schema_version: SCHEMA_VERSION,
                error: None,
            },
        })
    }

    pub(crate) fn status(&self) -> BackendBootstrapStatus {
        self.status.clone()
    }

    pub(crate) fn app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    pub(crate) fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub(crate) fn material_catalog(&self) -> MaterialCatalog {
        self.material_catalog.clone()
    }

    pub(crate) fn media_transfer(&self) -> crate::media_transfer::MediaTransferService {
        self.media_transfer.clone()
    }

    #[cfg(test)]
    pub(crate) fn with_loopback_media_for_test(mut self) -> Self {
        self.media_transfer = self.media_transfer.with_loopback_http_for_test();
        self
    }

    pub(crate) fn knowledge(&self) -> KnowledgeService {
        self.knowledge.clone()
    }

    pub(crate) fn agent_capabilities(&self) -> crate::agent_capabilities::AgentCapabilityRegistry {
        self.agent_capabilities.clone()
    }

    pub(crate) fn memory(&self) -> crate::agent_memory::MemoryService {
        self.memory.clone()
    }

    pub(crate) fn projects(&self) -> crate::agent_projects::AgentProjectService {
        self.projects.clone()
    }

    pub(crate) fn skills(&self) -> crate::agent_skills::SkillCatalog {
        self.skills.clone()
    }

    pub(crate) fn workspace(&self) -> crate::agent_workspace::WorkspaceGrantService {
        self.workspace.clone()
    }

    pub(crate) fn agent_materials(&self) -> crate::agent_materials::AgentMaterialService {
        self.agent_materials.clone()
    }

    pub(crate) fn schedules(&self) -> crate::agent_schedules::AgentScheduleService {
        self.schedules.clone()
    }

    pub(crate) fn execution(&self) -> crate::agent_execution::ExecutionRecipeCatalog {
        self.execution.clone()
    }

    #[cfg(test)]
    pub(crate) fn set_execution_catalog(
        &mut self,
        execution: crate::agent_execution::ExecutionRecipeCatalog,
    ) {
        self.execution = execution;
    }

    pub(crate) fn web_tools(&self) -> crate::web_tools::WebToolService {
        self.web_tools.clone()
    }

    pub(crate) fn agent_browser(&self) -> crate::agent_browser::AgentBrowserRuntime {
        self.agent_browser.clone()
    }

    #[cfg(test)]
    pub(crate) fn install_agent_browser_for_test(
        &mut self,
        runtime: crate::agent_browser::AgentBrowserRuntime,
    ) {
        self.agent_browser = runtime;
    }

    pub(crate) fn agent_runs(&self) -> crate::agent_runs::RunCoordinator {
        self.agent_runs.clone()
    }

    #[cfg(test)]
    fn delete_conversation(&self, conversation_id: &str) -> Result<(), String> {
        self.agent_runs
            .delete_conversation(conversation_id)
            .map_err(|error| error.code.to_owned())
    }

    pub(crate) fn notes_inline(&self) -> crate::notes_inline::NotesInlineService {
        self.notes_inline.clone()
    }

    pub(crate) fn canvas_agent(&self) -> crate::canvas_agent::CanvasAgentService {
        self.canvas_agent.clone()
    }

    pub(crate) fn stop_all_runs_and_wait(&self, timeout: std::time::Duration) -> bool {
        self.agent_runs.cancel_active();
        self.notes_inline.revoke_all();
        self.agent_runs.wait_for_idle(timeout)
    }

    pub(crate) fn list_tools(
        &self,
        context: &ToolCallContext,
    ) -> Result<Vec<ToolDefinition>, ToolError> {
        self.tools.list_tools(self, context)
    }

    pub(crate) fn agent_tool_catalog(&self) -> Vec<ToolDefinition> {
        self.tools.agent_catalog_definitions(self)
    }

    pub(crate) fn run_tool(
        &self,
        context: &ToolCallContext,
        request: ToolRunRequest,
    ) -> Result<ToolRunResult, ToolError> {
        self.tools.run_tool(self, context, request)
    }

    pub(crate) fn prepare_agent_write(
        &self,
        context: &ToolCallContext,
        request: ToolRunRequest,
        scope: AgentWriteScope,
    ) -> Result<PreparedAgentWrite, ToolError> {
        self.tools
            .prepare_agent_write(self, context, request, scope)
    }

    pub(crate) fn run_prepared_agent_write(
        &self,
        context: &ToolCallContext,
        prepared: PreparedAgentWrite,
        permit: &dyn AgentWritePermit,
    ) -> Result<ToolRunResult, ToolError> {
        self.tools
            .run_prepared_agent_write(self, context, prepared, permit)
    }

    pub(crate) fn run_prepared_agent_write_with_cancel(
        &self,
        context: &ToolCallContext,
        prepared: PreparedAgentWrite,
        permit: &dyn AgentWritePermit,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<ToolRunResult, ToolError> {
        self.tools
            .run_prepared_agent_write_with_cancel(self, context, prepared, permit, cancelled)
    }

    pub(crate) fn prepare_canvas_write(
        &self,
        context: &ToolCallContext,
        request: ToolRunRequest,
        scope: crate::canvas_agent::CanvasWriteScope,
    ) -> Result<crate::canvas_agent::PreparedCanvasWrite, ToolError> {
        self.tools
            .prepare_canvas_write(self, context, request, scope)
    }

    pub(crate) fn run_prepared_canvas_write(
        &self,
        context: &ToolCallContext,
        prepared: crate::canvas_agent::PreparedCanvasWrite,
        permit: &dyn crate::canvas_agent::CanvasWritePermit,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
        journal: &dyn crate::canvas_agent::CanvasGenerationJournal,
    ) -> Result<ToolRunResult, ToolError> {
        self.tools
            .run_prepared_canvas_write(self, context, prepared, permit, cancelled, journal)
    }

    #[cfg(test)]
    pub(crate) fn tool_request_cache_snapshot(&self) -> crate::tools::RequestCacheSnapshot {
        self.tools.request_cache_snapshot()
    }

    #[cfg(test)]
    pub(crate) fn expire_settled_tool_requests(&self) {
        self.tools.expire_settled_requests();
    }

    #[cfg(test)]
    pub(crate) fn backdate_inflight_tool_request(&self, request_id: &str) {
        self.tools.backdate_inflight_request(request_id);
    }

    pub(crate) fn open_read(&self) -> Result<Connection, BackendBootstrapError> {
        open_connection(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }

    pub(crate) fn open_write(&self) -> Result<Connection, BackendBootstrapError> {
        open_connection(
            &self.db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    }
}

fn open_bootstrap_connection(db_path: &Path) -> Result<Connection, BackendBootstrapError> {
    let connection = open_connection(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    set_journal_mode_wal(&connection)?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| database_error("backend-pragma-failed", error))?;
    Ok(connection)
}

fn set_journal_mode_wal(connection: &Connection) -> Result<(), BackendBootstrapError> {
    const MAX_ATTEMPTS: usize = 20;
    for attempt in 0..MAX_ATTEMPTS {
        match connection.pragma_update(None, "journal_mode", "WAL") {
            Ok(()) => return Ok(()),
            Err(error)
                if matches!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
                ) && attempt + 1 < MAX_ATTEMPTS =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(database_error("backend-pragma-failed", error)),
        }
    }
    unreachable!("bounded journal mode retry always returns")
}

fn open_connection(db_path: &Path, flags: OpenFlags) -> Result<Connection, BackendBootstrapError> {
    let connection = Connection::open_with_flags(db_path, flags)
        .map_err(|error| database_error("backend-database-open-failed", error))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| database_error("backend-busy-timeout-failed", error))?;
    Ok(connection)
}

fn migrate_schema(
    connection: &mut Connection,
    fault: BootstrapFault,
) -> Result<(), BackendBootstrapError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| database_error("backend-migration-lock-failed", error))?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS backend_schema_migration (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL
             );",
        )
        .map_err(|error| database_error("backend-schema-ledger-failed", error))?;
    let current_version = transaction
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM backend_schema_migration",
            [],
            |row| row.get::<_, u32>(0),
        )
        .map_err(|error| database_error("backend-schema-version-failed", error))?;
    if current_version > SCHEMA_VERSION {
        return Err(BackendBootstrapError {
            code: "backend-schema-too-new",
            message: format!(
                "数据库 schema 版本 {current_version} 高于当前支持版本 {SCHEMA_VERSION}"
            ),
        });
    }
    if current_version < 1 {
        apply_schema_v1(&transaction, fault)?;
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at) VALUES (1, 'backend-owned-schema', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    let needs_v2 = current_version < 2;
    if needs_v2 {
        apply_schema_v2(&transaction, fault)?;
    }
    let needs_v3 = current_version < 3;
    if needs_v3 {
        apply_schema_v3(&transaction, fault)?;
    }
    let needs_v4 = current_version < 4;
    if needs_v4 {
        crate::agent_runs::RunCoordinator::apply_schema(&transaction)
            .map_err(|error| database_error("backend-agent-run-schema-failed", error))?;
    }
    let needs_v5 = current_version < 5;
    if needs_v5 {
        apply_schema_v5(&transaction)?;
    }
    let needs_v6 = current_version < 6;
    if needs_v6 {
        apply_schema_v6(&transaction)?;
    }
    let needs_v7 = current_version < 7;
    if needs_v7 {
        apply_schema_v7(&transaction)?;
    }
    let needs_v8 = current_version < 8;
    if needs_v8 {
        apply_schema_v8(&transaction)?;
    }
    let needs_v9 = current_version < 9;
    if needs_v9 {
        apply_schema_v9(&transaction)?;
    }
    let needs_v10 = current_version < 10;
    if needs_v10 {
        apply_schema_v10(&transaction)?;
    }
    let needs_v11 = current_version < 11;
    if needs_v11 {
        apply_schema_v11(&transaction)?;
    }
    let needs_v12 = current_version < 12;
    if needs_v12 {
        apply_schema_v12(&transaction)?;
    }
    schema_compat::migrate_schema_13_to_17(&transaction, current_version)?;
    let needs_v18 = current_version < 18;
    if needs_v18 {
        apply_schema_v18(&transaction)?;
    }
    let needs_v19 = current_version < 19;
    if needs_v19 {
        apply_schema_v19(&transaction)?;
    }
    let needs_v20 = current_version < 20;
    if needs_v20 {
        apply_schema_v20(&transaction)?;
    }
    if current_version < 21 {
        crate::companion_gateway::content::notes::apply_schema(&transaction)
            .map_err(|error| database_error("backend-content-schema-failed", error))?;
        transaction.execute("INSERT INTO backend_schema_migration(version,name,applied_at) VALUES(21,'companion-content-notes',?1)", [chrono::Utc::now().to_rfc3339()])
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    let needs_v22 = current_version < 22;
    if needs_v22 {
        apply_schema_v22(&transaction)?;
    }
    if current_version < 23 {
        apply_schema_v23(&transaction)?;
    }
    if current_version < 24 {
        materials::apply_library_schema(&transaction).map_err(|error|BackendBootstrapError{code:"backend-material-libraries-migration-failed",message:error.message})?;
        transaction.execute("INSERT INTO backend_schema_migration(version,name,applied_at) VALUES(24,'material-libraries-r1',?1)",[chrono::Utc::now().to_rfc3339()]).map_err(|error|database_error("backend-migration-record-failed",error))?;
    }
    materials::verify_library_schema(&transaction).map_err(|error|BackendBootstrapError{code:"backend-material-libraries-schema-invalid",message:error.message})?;
    if current_version < 25 {
        materials::apply_transfer_schema_v25(&transaction).map_err(|error|BackendBootstrapError{code:"backend-material-library-transfer-migration-failed",message:error.message})?;
        transaction.execute("INSERT INTO backend_schema_migration(version,name,applied_at) VALUES(25,'material-library-transfer-r2',?1)",[chrono::Utc::now().to_rfc3339()]).map_err(|error|database_error("backend-migration-record-failed",error))?;
    }
    if current_version < 26 {
        materials::migrate_transfer_schema_v26(&transaction).map_err(|error|BackendBootstrapError{code:"backend-material-library-transfer-migration-failed",message:error.message})?;
        transaction.execute("INSERT INTO backend_schema_migration(version,name,applied_at) VALUES(26,'material-library-move-r3',?1)",[chrono::Utc::now().to_rfc3339()]).map_err(|error|database_error("backend-migration-record-failed",error))?;
    }
    materials::verify_transfer_schema(&transaction).map_err(|error|BackendBootstrapError{code:"backend-material-library-transfer-schema-invalid",message:error.message})?;
    repair_reintroduced_empty_retired_note_schema(&transaction)?;
    verify_required_schema(&transaction)?;
    verify_retired_note_schema_absent(&transaction)?;
    if needs_v2 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at) VALUES (2, 'collection-external-content-compatibility', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    if needs_v3 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at) VALUES (3, 'retire-sqlite-note-domain', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    if needs_v4 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at)
                 VALUES (4, 'durable-agent-run-ledger', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    if needs_v5 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at)
                 VALUES (5, 'agent-capability-registry-memory-skills-workspace-schedules', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    if needs_v6 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at)
                 VALUES (6, 'schedule-product-lifecycle-and-history', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    if needs_v7 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at)
                 VALUES (7, 'agent-conversation-mode', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    if needs_v8 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at)
                 VALUES (8, 'agent-project-workspace-binding-and-conversation-lifecycle', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    if needs_v9 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at)
                 VALUES (9, 'agent-project-knowledge-authorization', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    if needs_v10 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at)
                 VALUES (10, 'agent-message-action-truth-projection', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    if needs_v11 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at)
                 VALUES (11, 'agent-run-terminal-cause-linearization', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    if needs_v12 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at)
                 VALUES (12, 'agent-terminal-recovery-facts', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    if needs_v18 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at)
                 VALUES (18, 'favorite-inspiration-shelf', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    if needs_v19 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at)
                 VALUES (19, 'smart-folder-definitions', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    if needs_v20 {
        transaction
            .execute(
                "INSERT INTO backend_schema_migration(version, name, applied_at)
                 VALUES (20, 'desktop-companion-gateway-foundation', ?1)",
                [chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| database_error("backend-migration-record-failed", error))?;
    }
    transaction
        .commit()
        .map_err(|error| database_error("backend-migration-commit-failed", error))?;
    Ok(())
}

fn apply_schema_v18(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection
        .execute_batch(
            "CREATE TABLE favorite_item (
                item_type TEXT NOT NULL CHECK(item_type IN ('material','note','canvas')),
                item_id TEXT NOT NULL,
                theme TEXT NOT NULL DEFAULT '',
                copy TEXT NOT NULL DEFAULT '',
                favorited_at TEXT NOT NULL,
                note_updated_at TEXT,
                PRIMARY KEY(item_type,item_id)
             );
             CREATE INDEX idx_favorite_item_type_favorited
             ON favorite_item(item_type,favorited_at);",
        )
        .map_err(|error| database_error("backend-favorite-schema-failed", error))
}

fn apply_schema_v19(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection
        .execute_batch(
            "CREATE TABLE smart_folder_definition (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                source TEXT NOT NULL CHECK(source IN ('material','note','canvas')),
                criteria_version INTEGER NOT NULL,
                criteria_json TEXT NOT NULL,
                sort TEXT NOT NULL CHECK(sort IN ('added-desc','modified-desc','modified-asc','name-asc')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );",
        )
        .map_err(|error| database_error("backend-smart-folder-schema-failed", error))
}

/// v22: per-device LSH remote surface permission. NULL = not granted; the
/// timestamp records the explicit grant. Revocation clears the column and is
/// paired with live-session teardown in the gateway.
fn apply_schema_v22(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection
        .execute_batch(
            "ALTER TABLE companion_device ADD COLUMN lsh_remote_surface_granted_at TEXT;
             INSERT INTO backend_schema_migration(version, name, applied_at) VALUES (22, 'companion-device-lsh-remote-grant', strftime('%Y-%m-%dT%H:%M:%fZ','now'));",
        )
        .map_err(|error| database_error("backend-companion-lsh-remote-schema-failed", error))
}

/// v23 is additive. Existing paired devices acquire no Services V1 grant;
/// every row is created only by an explicit Desktop Settings action.
fn apply_schema_v23(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection.execute_batch(
        "ALTER TABLE companion_device ADD COLUMN services_permission_revision INTEGER NOT NULL DEFAULT 0;
         CREATE TABLE companion_service_grant (
            device_id TEXT NOT NULL REFERENCES companion_device(device_id) ON DELETE CASCADE,
            grant_class TEXT NOT NULL CHECK(grant_class IN ('content.read','content.write','ingest.write','desktop.open')),
            scope_kind TEXT NOT NULL CHECK(scope_kind IN ('catalog','vault')),
            scope_id TEXT NOT NULL,
            granted_at TEXT NOT NULL,
            PRIMARY KEY(device_id,grant_class,scope_kind,scope_id),
            CHECK((scope_kind='catalog' AND scope_id='') OR (scope_kind='vault' AND length(scope_id)>0))
         );
         CREATE INDEX idx_companion_service_grant_device ON companion_service_grant(device_id,scope_kind,scope_id);
         CREATE TABLE companion_service_operation (
            instance_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            op_id TEXT NOT NULL,
            target_key TEXT NOT NULL,
            payload_sha256 TEXT NOT NULL,
            stage TEXT NOT NULL CHECK(stage IN ('pending','committed','expired')),
            receipt TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(instance_id,device_id,operation_id,op_id)
         );
         CREATE TABLE companion_service_upload (
            job_id TEXT NOT NULL PRIMARY KEY,
            instance_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            op_id TEXT NOT NULL,
            manifest TEXT NOT NULL,
            committed_bytes INTEGER NOT NULL DEFAULT 0,
            stage TEXT NOT NULL CHECK(stage IN ('staging','committing','completed','cancelled','expired')),
            receipt TEXT,
            updated_at TEXT NOT NULL,
            UNIQUE(instance_id,device_id,op_id)
         );
         CREATE INDEX idx_companion_service_upload_owner ON companion_service_upload(instance_id,device_id,stage);
         CREATE TABLE IF NOT EXISTS companion_service_change (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            domain TEXT NOT NULL CHECK(domain IN ('materials','knowledge')),
            scope_id TEXT NOT NULL,
            object_id TEXT NOT NULL,
            revision TEXT NOT NULL,
            kind TEXT NOT NULL,
            tombstone INTEGER NOT NULL DEFAULT 0,
            occurred_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_companion_service_change_scope ON companion_service_change(domain,scope_id,seq);
         CREATE TABLE companion_service_search_snapshot (
            snapshot_id TEXT NOT NULL PRIMARY KEY,
            instance_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            query_key TEXT NOT NULL,
            permission_revision INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            items_json TEXT NOT NULL
         );
         CREATE INDEX idx_companion_service_search_expiry ON companion_service_search_snapshot(expires_at);
         CREATE TRIGGER companion_service_favorite_insert AFTER INSERT ON favorite_item
         WHEN NEW.item_type='material' BEGIN
            INSERT INTO companion_service_change(domain,scope_id,object_id,revision,kind,tombstone,occurred_at)
            VALUES('materials','',NEW.item_id,NEW.favorited_at,'favorited',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
         END;
         CREATE TRIGGER companion_service_favorite_delete AFTER DELETE ON favorite_item
         WHEN OLD.item_type='material' BEGIN
            INSERT INTO companion_service_change(domain,scope_id,object_id,revision,kind,tombstone,occurred_at)
            VALUES('materials','',OLD.item_id,OLD.favorited_at,'favorited',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
         END;
         CREATE TRIGGER companion_service_note_change AFTER INSERT ON companion_content_change BEGIN
            INSERT INTO companion_service_change(domain,scope_id,object_id,revision,kind,tombstone,occurred_at)
            VALUES('knowledge',NEW.vault_key,NEW.note_id,NEW.revision,
                CASE WHEN NEW.deleted=1 THEN 'removed' ELSE 'updated' END,NEW.deleted,NEW.at);
         END;
         INSERT INTO backend_schema_migration(version,name,applied_at)
         VALUES(23,'companion-services-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));"
    ).map_err(|error| database_error("backend-companion-services-schema-failed", error))
}

fn apply_schema_v20(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection
        .execute_batch(
            "CREATE TABLE companion_identity (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                desktop_instance_id TEXT NOT NULL UNIQUE,
                certificate_der BLOB NOT NULL,
                certificate_fingerprint TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
             );
             CREATE TABLE companion_device (
                device_id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                credential_verifier BLOB NOT NULL,
                created_at TEXT NOT NULL,
                last_authenticated_at TEXT,
                revoked_at TEXT
             );
             CREATE INDEX idx_companion_device_active
             ON companion_device(revoked_at,created_at);
             CREATE TABLE companion_security_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                device_id TEXT,
                occurred_at TEXT NOT NULL,
                result TEXT NOT NULL
             );
             CREATE INDEX idx_companion_security_audit_time
             ON companion_security_audit(occurred_at,id);",
        )
        .map_err(|error| database_error("backend-companion-schema-failed", error))
}

fn apply_schema_v5(connection: &Connection) -> Result<(), BackendBootstrapError> {
    for (column, declaration) in [
        ("scope_kind", "scope_kind TEXT NOT NULL DEFAULT 'global'"),
        ("scope_id", "scope_id TEXT"),
        ("revision", "revision INTEGER NOT NULL DEFAULT 1"),
        ("updated_at", "updated_at TEXT NOT NULL DEFAULT ''"),
        ("expires_at", "expires_at TEXT"),
        ("source_kind", "source_kind TEXT NOT NULL DEFAULT 'legacy'"),
        ("source_ref", "source_ref TEXT"),
    ] {
        ensure_column(connection, "memory_entries", column, declaration)?;
    }
    connection
        .execute(
            "UPDATE memory_entries
             SET updated_at = CASE
                 WHEN updated_at = '' THEN COALESCE(created_at, ?1)
                 ELSE updated_at
             END,
             revision = CASE WHEN revision < 1 THEN 1 ELSE revision END,
             scope_kind = CASE
                 WHEN scope_kind IN ('global','vault') THEN scope_kind
                 ELSE 'global'
             END",
            [chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|error| database_error("backend-memory-migration-failed", error))?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_capability_registry_meta (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                generation INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS agent_capability_state (
                pack_id TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS ai_run_capability_snapshot (
                run_id TEXT PRIMARY KEY,
                schema_version INTEGER NOT NULL,
                generation INTEGER NOT NULL,
                profile TEXT NOT NULL,
                digest TEXT NOT NULL,
                manifest_json TEXT NOT NULL,
                provider_digest TEXT NOT NULL,
                skill_digest TEXT NOT NULL,
                scope_digest TEXT NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS agent_skill_package (
                digest TEXT PRIMARY KEY,
                skill_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                version TEXT NOT NULL,
                source TEXT NOT NULL,
                scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','vault')),
                scope_id TEXT,
                skill_md TEXT NOT NULL,
                resources_json TEXT NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS agent_skill_state (
                skill_id TEXT PRIMARY KEY,
                current_digest TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                revision INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS agent_workspace_grant (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                canonical_root TEXT NOT NULL UNIQUE,
                root_name TEXT NOT NULL,
                root_digest TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS agent_schedule (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                prompt TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('once','interval')),
                interval_seconds INTEGER,
                next_fire_at TEXT,
                status TEXT NOT NULL CHECK(status IN ('active','paused')),
                revision INTEGER NOT NULL DEFAULT 1,
                last_run_id TEXT,
                last_safe_code TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS agent_schedule_fire (
                id TEXT PRIMARY KEY,
                schedule_id TEXT NOT NULL,
                due_at TEXT NOT NULL,
                trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('scheduled','manual')),
                state TEXT NOT NULL CHECK(state IN (
                    'prepared','starting','running','awaiting-approval',
                    'completed','partial','failed','cancelled','aborted','interrupted'
                )),
                run_id TEXT,
                safe_code TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_memory_scope_updated
                ON memory_entries(scope_kind, scope_id, updated_at);
             CREATE INDEX IF NOT EXISTS idx_agent_skill_package_id
                ON agent_skill_package(skill_id, created_at);
             CREATE INDEX IF NOT EXISTS idx_agent_schedule_due
                ON agent_schedule(status, next_fire_at);
             CREATE INDEX IF NOT EXISTS idx_agent_schedule_fire_state
                ON agent_schedule_fire(state, created_at);
             CREATE INDEX IF NOT EXISTS idx_agent_schedule_fire_run
                ON agent_schedule_fire(run_id);",
        )
        .map_err(|error| database_error("backend-agent-capability-schema-failed", error))?;
    Ok(())
}

fn apply_schema_v6(connection: &Connection) -> Result<(), BackendBootstrapError> {
    for (table, column, declaration) in [
        ("agent_schedule", "retired_at", "retired_at TEXT"),
        ("agent_schedule", "completed_at", "completed_at TEXT"),
        (
            "agent_schedule_fire",
            "stop_requested_at",
            "stop_requested_at TEXT",
        ),
    ] {
        ensure_column(connection, table, column, declaration)?;
    }
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_agent_schedule_fire_schedule
                ON agent_schedule_fire(schedule_id, created_at);",
        )
        .map_err(|error| database_error("backend-schedule-v6-migration-failed", error))?;
    Ok(())
}

fn apply_schema_v7(connection: &Connection) -> Result<(), BackendBootstrapError> {
    ensure_column(
        connection,
        "ai_conversation",
        "agent_mode",
        "agent_mode TEXT NOT NULL DEFAULT 'standard' CHECK(agent_mode IN ('standard','project-task'))",
    )?;
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_ai_conversation_agent_mode_updated
                ON ai_conversation(agent_mode, updated_at);",
        )
        .map_err(|error| database_error("backend-conversation-mode-migration-failed", error))?;
    Ok(())
}

fn apply_schema_v8(connection: &Connection) -> Result<(), BackendBootstrapError> {
    for (table, column, declaration) in [
        ("ai_conversation", "project_id", "project_id TEXT"),
        ("ai_conversation", "pinned_at", "pinned_at TEXT"),
        ("ai_conversation", "archived_at", "archived_at TEXT"),
    ] {
        ensure_column(connection, table, column, declaration)?;
    }
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_project (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                primary_workspace_grant_id TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_agent_project_sort
                ON agent_project(sort_order, updated_at);
             CREATE INDEX IF NOT EXISTS idx_ai_conversation_project_updated
                ON ai_conversation(project_id, updated_at);
             CREATE TRIGGER IF NOT EXISTS ai_conversation_project_insert
             BEFORE INSERT ON ai_conversation
             WHEN NEW.project_id IS NOT NULL AND (
                 NEW.agent_mode <> 'project-task'
                 OR NOT EXISTS (SELECT 1 FROM agent_project WHERE id = NEW.project_id)
             )
             BEGIN
                 SELECT RAISE(ABORT, 'ai-conversation-project-mode-mismatch');
             END;
             CREATE TRIGGER IF NOT EXISTS ai_conversation_project_update
             BEFORE UPDATE OF project_id, agent_mode ON ai_conversation
             WHEN NEW.project_id IS NOT NULL AND (
                 NEW.agent_mode <> 'project-task'
                 OR NOT EXISTS (SELECT 1 FROM agent_project WHERE id = NEW.project_id)
             )
             BEGIN
                 SELECT RAISE(ABORT, 'ai-conversation-project-mode-mismatch');
             END;",
        )
        .map_err(|error| database_error("backend-project-schema-migration-failed", error))?;
    Ok(())
}

fn apply_schema_v9(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_project_knowledge_binding (
                project_id TEXT NOT NULL,
                knowledge_target_id TEXT NOT NULL,
                target_identity_digest TEXT NOT NULL,
                target_label TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY(project_id, knowledge_target_id),
                FOREIGN KEY(project_id) REFERENCES agent_project(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_agent_project_knowledge_target
                ON agent_project_knowledge_binding(knowledge_target_id, project_id);
             CREATE TRIGGER IF NOT EXISTS agent_project_knowledge_insert
             BEFORE INSERT ON agent_project_knowledge_binding
             WHEN NOT EXISTS (SELECT 1 FROM agent_project WHERE id = NEW.project_id)
             BEGIN
                 SELECT RAISE(ABORT, 'agent-project-knowledge-project-missing');
             END;
             CREATE TRIGGER IF NOT EXISTS agent_project_knowledge_update
             BEFORE UPDATE OF project_id ON agent_project_knowledge_binding
             WHEN NOT EXISTS (SELECT 1 FROM agent_project WHERE id = NEW.project_id)
             BEGIN
                 SELECT RAISE(ABORT, 'agent-project-knowledge-project-missing');
             END;
             CREATE TRIGGER IF NOT EXISTS agent_project_knowledge_project_delete
             AFTER DELETE ON agent_project
             BEGIN
                 DELETE FROM agent_project_knowledge_binding WHERE project_id = OLD.id;
             END;",
        )
        .map_err(|error| {
            database_error("backend-project-knowledge-schema-migration-failed", error)
        })?;
    Ok(())
}

fn apply_schema_v10(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS ai_message_action_truth (
                message_id TEXT PRIMARY KEY,
                workspace_status TEXT NOT NULL CHECK(workspace_status IN (
                    'not-requested','not-applied','verified','partial','uncertain'
                )),
                execution_status TEXT NOT NULL CHECK(execution_status IN (
                    'not-requested','no-result','verified','uncertain'
                )),
                created_at TEXT NOT NULL,
                FOREIGN KEY(message_id) REFERENCES ai_message(id) ON DELETE CASCADE
             );
             CREATE TRIGGER IF NOT EXISTS ai_message_action_truth_insert_guard
             BEFORE INSERT ON ai_message_action_truth
             WHEN NOT EXISTS (
                 SELECT 1
                 FROM ai_message AS message
                 JOIN ai_run AS run ON run.result_message_id = message.id
                 WHERE message.id = NEW.message_id
                   AND message.role = 'assistant'
                   AND run.status IN (
                       'completed','partial','failed','cancelled','aborted','interrupted'
                   )
             )
             BEGIN
                 SELECT RAISE(ABORT, 'ai-message-action-truth-unbound');
             END;
             CREATE TRIGGER IF NOT EXISTS ai_message_action_truth_immutable
             BEFORE UPDATE ON ai_message_action_truth
             BEGIN
                 SELECT RAISE(ABORT, 'ai-message-action-truth-immutable');
             END;",
        )
        .map_err(|error| database_error("backend-action-truth-schema-migration-failed", error))?;
    Ok(())
}

fn apply_schema_v11(connection: &Connection) -> Result<(), BackendBootstrapError> {
    ensure_column(
        connection,
        "ai_run",
        "stop_cause",
        "stop_cause TEXT CHECK(stop_cause IS NULL OR stop_cause IN ('explicit-cancel','safety-abort'))",
    )
}

fn apply_schema_v12(connection: &Connection) -> Result<(), BackendBootstrapError> {
    ensure_column(
        connection,
        "ai_run",
        "stop_transport",
        "stop_transport TEXT CHECK(stop_transport IS NULL OR stop_transport IN ('unknown','acknowledged','failed'))",
    )?;
    ensure_column(
        connection,
        "ai_run_artifact",
        "action_truth",
        "action_truth TEXT CHECK(action_truth IS NULL OR action_truth IN ('workspace-verified','workspace-partial','workspace-uncertain','execution-verified','execution-uncertain'))",
    )?;
    ensure_column(
        connection,
        "ai_run_artifact",
        "safe_result_summary",
        "safe_result_summary TEXT",
    )
}

const PUBLISHED_COLLECTION_COLUMNS: &[(&str, &str, bool, bool)] = &[
    ("id", "TEXT", false, true),
    ("type", "TEXT", true, false),
    ("content", "TEXT", true, false),
    ("asset_id", "TEXT", false, false),
    ("url_metadata", "TEXT", false, false),
    ("source", "TEXT", false, false),
    ("created_at", "TEXT", true, false),
    ("processed_at", "TEXT", false, false),
    ("processed_note_id", "TEXT", false, false),
    ("processed_action", "TEXT", false, false),
    ("thumbnail", "TEXT", false, false),
    ("browser", "TEXT", false, false),
    ("trigger", "TEXT", false, false),
    ("processed_asset_id", "TEXT", false, false),
];

const PUBLISHED_COLLECTION_FTS_SQL: &str = "
    CREATE VIRTUAL TABLE collection_item_search USING fts5(
        title, url, selection,
        content='collection_item',
        content_rowid='rowid',
        tokenize='unicode61'
    )";

const PUBLISHED_COLLECTION_TRIGGERS: &[(&str, &str)] = &[
    (
        "collection_item_ai",
        "CREATE TRIGGER collection_item_ai AFTER INSERT ON collection_item BEGIN
            INSERT INTO collection_item_search(rowid, title, url, selection)
            VALUES (new.rowid, COALESCE(new.content,''), COALESCE((SELECT json_extract(new.url_metadata,'$.url')),''), COALESCE((SELECT json_extract(new.url_metadata,'$.selection')),''));
         END",
    ),
    (
        "collection_item_ad",
        "CREATE TRIGGER collection_item_ad AFTER DELETE ON collection_item BEGIN
            INSERT INTO collection_item_search(collection_item_search, rowid, title, url, selection)
            VALUES ('delete', old.rowid, COALESCE(old.content,''), '', '');
         END",
    ),
    (
        "collection_item_au",
        "CREATE TRIGGER collection_item_au AFTER UPDATE ON collection_item BEGIN
            INSERT INTO collection_item_search(collection_item_search, rowid, title, url, selection)
            VALUES ('delete', old.rowid, COALESCE(old.content,''), '', '');
            INSERT INTO collection_item_search(rowid, title, url, selection)
            VALUES (new.rowid, COALESCE(new.content,''), COALESCE((SELECT json_extract(new.url_metadata,'$.url')),''), COALESCE((SELECT json_extract(new.url_metadata,'$.selection')),''));
         END",
    ),
];

const FINAL_INDEPENDENT_COLLECTION_FTS_SQL: &str = "
    CREATE VIRTUAL TABLE collection_item_search USING fts5(
        title, url, selection, tokenize='unicode61'
    )";

const FINAL_INDEPENDENT_COLLECTION_TRIGGERS: &[(&str, &str)] = &[
    (
        "collection_item_ai",
        "CREATE TRIGGER collection_item_ai AFTER INSERT ON collection_item BEGIN
            INSERT INTO collection_item_search(rowid, title, url, selection)
            VALUES (new.rowid, COALESCE(new.content,''), COALESCE(json_extract(new.url_metadata,'$.url'),''), COALESCE(json_extract(new.url_metadata,'$.selection'),''));
         END",
    ),
    (
        "collection_item_ad",
        "CREATE TRIGGER collection_item_ad AFTER DELETE ON collection_item BEGIN
            DELETE FROM collection_item_search WHERE rowid = old.rowid;
         END",
    ),
    (
        "collection_item_au",
        "CREATE TRIGGER collection_item_au AFTER UPDATE ON collection_item BEGIN
            DELETE FROM collection_item_search WHERE rowid = old.rowid;
            INSERT INTO collection_item_search(rowid, title, url, selection)
            VALUES (new.rowid, COALESCE(new.content,''), COALESCE(json_extract(new.url_metadata,'$.url'),''), COALESCE(json_extract(new.url_metadata,'$.selection'),''));
         END",
    ),
];

fn apply_schema_v2(
    connection: &Connection,
    fault: BootstrapFault,
) -> Result<(), BackendBootstrapError> {
    let search = required_schema_entry(connection, "collection_item_search")?;
    let normalized_search = normalize_schema_sql(&search.sql);
    if !normalized_search.contains("content=collection_item") {
        if is_final_independent_collection_signature(connection, &search)? {
            return Ok(());
        }
        return Err(legacy_collection_signature_error("collection_item_search"));
    }
    verify_published_collection_external_signature(connection, &search)?;
    connection
        .execute_batch(
            "ALTER TABLE collection_item ADD COLUMN title TEXT GENERATED ALWAYS AS (COALESCE(content, '')) VIRTUAL;
             ALTER TABLE collection_item ADD COLUMN url TEXT GENERATED ALWAYS AS (COALESCE(json_extract(url_metadata, '$.url'), '')) VIRTUAL;
             ALTER TABLE collection_item ADD COLUMN selection TEXT GENERATED ALWAYS AS (COALESCE(json_extract(url_metadata, '$.selection'), '')) VIRTUAL;",
        )
        .map_err(|_| BackendBootstrapError {
            code: "backend-collection-legacy-migration-failed",
            message: "collection_item_search legacy migration failed".to_string(),
        })?;
    if fault == BootstrapFault::AfterLegacyCollectionColumns {
        return Err(BackendBootstrapError {
            code: "backend-test-injected",
            message: "injected collection migration failure".to_string(),
        });
    }
    connection
        .execute_batch(
            "DROP TRIGGER collection_item_ai;
             DROP TRIGGER collection_item_ad;
             DROP TRIGGER collection_item_au;
             CREATE TRIGGER collection_item_ai AFTER INSERT ON collection_item BEGIN
                INSERT INTO collection_item_search(rowid, title, url, selection)
                VALUES (new.rowid, new.title, new.url, new.selection);
             END;
             CREATE TRIGGER collection_item_ad AFTER DELETE ON collection_item BEGIN
                INSERT INTO collection_item_search(collection_item_search, rowid, title, url, selection)
                VALUES ('delete', old.rowid, old.title, old.url, old.selection);
             END;
             CREATE TRIGGER collection_item_au AFTER UPDATE ON collection_item BEGIN
                INSERT INTO collection_item_search(collection_item_search, rowid, title, url, selection)
                VALUES ('delete', old.rowid, old.title, old.url, old.selection);
                INSERT INTO collection_item_search(rowid, title, url, selection)
                VALUES (new.rowid, new.title, new.url, new.selection);
             END;
             INSERT INTO collection_item_search(collection_item_search) VALUES('rebuild');",
        )
        .map_err(|_| BackendBootstrapError {
            code: "backend-collection-legacy-migration-failed",
            message: "collection_item_search legacy migration failed".to_string(),
        })?;
    Ok(())
}

fn apply_schema_v3(
    connection: &Connection,
    fault: BootstrapFault,
) -> Result<(), BackendBootstrapError> {
    verify_retired_note_schema_for_migration(connection)?;
    connection
        .execute_batch(
            "DELETE FROM item_tag WHERE item_type = 'note';
             DELETE FROM folder
              WHERE scope = 'notes'
                AND NOT EXISTS (SELECT 1 FROM asset WHERE asset.folder_id = folder.id);",
        )
        .map_err(|_| BackendBootstrapError {
            code: "backend-note-retirement-failed",
            message: "retired note schema migration failed".to_string(),
        })?;
    drop_retired_note_schema_objects(connection)?;
    if fault == BootstrapFault::AfterRetiredNoteDrop {
        return Err(BackendBootstrapError {
            code: "backend-test-injected",
            message: "injected retired note migration failure".to_string(),
        });
    }
    verify_retired_note_schema_absent(connection)
}

fn drop_retired_note_schema_objects(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection
        .execute_batch(
            "DROP TRIGGER note_search_ai;
             DROP TRIGGER note_search_ad;
             DROP TRIGGER note_search_au;
             DROP INDEX idx_note_folder;
             DROP INDEX idx_note_updated;
             DROP INDEX idx_note_link_from;
             DROP INDEX idx_note_link_to;
             DROP INDEX idx_note_asset_embed_note;
             DROP INDEX idx_note_asset_embed_asset;
             DROP TABLE note_search;
             DROP TABLE note_ai;
             DROP TABLE note_asset_embed;
             DROP TABLE note_link;
             DROP TABLE note;",
        )
        .map_err(|_| BackendBootstrapError {
            code: "backend-note-retirement-failed",
            message: "retired note schema migration failed".to_string(),
        })
}

fn repair_reintroduced_empty_retired_note_schema(
    connection: &Connection,
) -> Result<(), BackendBootstrapError> {
    let mut found_retired_object = false;
    for object in RETIRED_NOTE_SCHEMA_OBJECTS {
        let present = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = ?1)",
                [object],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| database_error("backend-schema-verification-failed", error))?;
        found_retired_object |= present;
    }
    if !found_retired_object {
        return Ok(());
    }

    verify_retired_note_schema_for_migration(connection)?;
    for table in RETIRED_NOTE_DATA_TABLES {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        let rows = connection
            .query_row(&sql, [], |row| row.get::<_, i64>(0))
            .map_err(|error| database_error("backend-schema-verification-failed", error))?;
        if rows != 0 {
            return Err(BackendBootstrapError {
                code: "backend-retired-schema-nonempty",
                message: format!(
                    "schema verification failed for {table}: retired note data is not empty"
                ),
            });
        }
    }

    drop_retired_note_schema_objects(connection)?;
    verify_retired_note_schema_absent(connection)
}

fn verify_retired_note_schema_for_migration(
    connection: &Connection,
) -> Result<(), BackendBootstrapError> {
    for table in RETIRED_NOTE_TABLES {
        verify_ordinary_table_spec(connection, table)?;
    }
    verify_fts_spec(connection, &RETIRED_NOTE_FTS)?;
    for index in RETIRED_NOTE_INDEXES {
        verify_index_spec(connection, index)?;
    }
    for trigger in RETIRED_NOTE_TRIGGERS {
        verify_trigger_spec(connection, trigger)?;
    }
    run_rollback_verification(
        connection,
        "retired_note_schema_smoke",
        "retired-note-smoke",
        verify_retired_note_search_behavior,
    )
}

fn verify_retired_note_search_behavior(
    transaction: &Connection,
) -> Result<(), BackendBootstrapError> {
    let suffix = schema_probe_suffix();
    let note_id = format!("__retired_note_{suffix}");
    let old_title = format!("lrretiredold{suffix}");
    let new_title = format!("lrretirednew{suffix}");
    let now = "2000-01-01T00:00:00Z";
    transaction
        .execute(
            "INSERT INTO note(id, title, content_json, content_text, folder_id, color, created_at, updated_at, deleted_at)
             VALUES (?1, ?2, NULL, '', NULL, NULL, ?3, ?3, NULL)",
            rusqlite::params![note_id, old_title, now],
        )
        .map_err(|_| search_behavior_error("note_search_ai", "note insert failed"))?;
    expect_named_fts_match(transaction, "note_search", "id", &note_id, &old_title, true)?;
    transaction
        .execute(
            "UPDATE note SET title = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![new_title, now, note_id],
        )
        .map_err(|_| search_behavior_error("note_search_au", "note update failed"))?;
    expect_named_fts_match(
        transaction,
        "note_search",
        "id",
        &note_id,
        &old_title,
        false,
    )?;
    expect_named_fts_match(transaction, "note_search", "id", &note_id, &new_title, true)?;
    transaction
        .execute("DELETE FROM note WHERE id = ?1", [&note_id])
        .map_err(|_| search_behavior_error("note_search_ad", "note delete failed"))?;
    expect_named_fts_match(
        transaction,
        "note_search",
        "id",
        &note_id,
        &new_title,
        false,
    )
}

fn verify_retired_note_schema_absent(connection: &Connection) -> Result<(), BackendBootstrapError> {
    for object in RETIRED_NOTE_SCHEMA_OBJECTS {
        let present = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = ?1)",
                [object],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| database_error("backend-schema-verification-failed", error))?;
        if present {
            return Err(schema_verification_error(
                "backend-retired-schema-present",
                object,
                "retired note object is still present",
            ));
        }
    }
    Ok(())
}

fn is_final_independent_collection_signature(
    connection: &Connection,
    search: &SchemaEntry,
) -> Result<bool, BackendBootstrapError> {
    if search.object_type != "table"
        || search.table_name != "collection_item_search"
        || normalized_legacy_sql(&search.sql)
            != normalized_legacy_sql(FINAL_INDEPENDENT_COLLECTION_FTS_SQL)
    {
        return Ok(false);
    }
    for (name, expected_sql) in FINAL_INDEPENDENT_COLLECTION_TRIGGERS {
        let entry = required_schema_entry(connection, name)?;
        if entry.object_type != "trigger"
            || entry.table_name != "collection_item"
            || normalized_legacy_sql(&entry.sql) != normalized_legacy_sql(expected_sql)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn verify_published_collection_external_signature(
    connection: &Connection,
    search: &SchemaEntry,
) -> Result<(), BackendBootstrapError> {
    let table = required_schema_entry(connection, "collection_item")?;
    if table.object_type != "table"
        || table.table_name != "collection_item"
        || normalize_schema_sql(&table.sql).contains("createvirtualtable")
    {
        return Err(legacy_collection_signature_error("collection_item"));
    }
    let mut statement = connection
        .prepare(
            "SELECT name, type, [notnull], dflt_value, pk, hidden
             FROM pragma_table_xinfo('collection_item') ORDER BY cid",
        )
        .map_err(|_| legacy_collection_signature_error("collection_item"))?;
    let columns = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?.to_uppercase(),
                row.get::<_, bool>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|_| legacy_collection_signature_error("collection_item"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| legacy_collection_signature_error("collection_item"))?;
    let expected = PUBLISHED_COLLECTION_COLUMNS
        .iter()
        .map(|(name, data_type, not_null, primary_key)| {
            (
                (*name).to_string(),
                (*data_type).to_string(),
                *not_null,
                None,
                *primary_key,
                0_i64,
            )
        })
        .collect::<Vec<_>>();
    if columns != expected {
        return Err(legacy_collection_signature_error("collection_item"));
    }
    if search.object_type != "table"
        || search.table_name != "collection_item_search"
        || normalized_legacy_sql(&search.sql) != normalized_legacy_sql(PUBLISHED_COLLECTION_FTS_SQL)
    {
        return Err(legacy_collection_signature_error("collection_item_search"));
    }
    for (name, expected_sql) in PUBLISHED_COLLECTION_TRIGGERS {
        let entry = required_schema_entry(connection, name)?;
        if entry.object_type != "trigger"
            || entry.table_name != "collection_item"
            || normalized_legacy_sql(&entry.sql) != normalized_legacy_sql(expected_sql)
        {
            return Err(legacy_collection_signature_error(name));
        }
    }
    for index in REQUIRED_INDEXES
        .iter()
        .filter(|index| index.table == "collection_item")
    {
        let entry = required_schema_entry(connection, index.name)?;
        if entry.object_type != "index" || entry.table_name != index.table {
            return Err(legacy_collection_signature_error(index.name));
        }
        let columns = connection
            .prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
            .and_then(|mut statement| {
                statement
                    .query_map([index.name], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(|_| legacy_collection_signature_error(index.name))?;
        if columns != index.columns {
            return Err(legacy_collection_signature_error(index.name));
        }
    }
    Ok(())
}

fn normalized_legacy_sql(sql: &str) -> String {
    normalize_schema_sql(sql).replace("ifnotexists", "")
}

fn legacy_collection_signature_error(object: &'static str) -> BackendBootstrapError {
    BackendBootstrapError {
        code: "backend-collection-legacy-signature-mismatch",
        message: format!("legacy schema signature mismatch for {object}"),
    }
}

fn apply_schema_v1(
    connection: &Connection,
    fault: BootstrapFault,
) -> Result<(), BackendBootstrapError> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS asset (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, original_path TEXT NOT NULL,
                library_path TEXT, storage_mode TEXT NOT NULL DEFAULT 'linked', kind TEXT NOT NULL,
                mime_type TEXT, size_bytes INTEGER, thumbnail_url TEXT, description TEXT,
                rating INTEGER, dominant_color TEXT, folder_id TEXT, imported_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, content_hash TEXT
             );
             CREATE TABLE IF NOT EXISTS folder (
                id TEXT PRIMARY KEY, scope TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0, open INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tag (
                id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS item_tag (
                id TEXT PRIMARY KEY, item_type TEXT NOT NULL, item_id TEXT NOT NULL,
                tag_id TEXT NOT NULL, created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS note (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, content_json TEXT, content_text TEXT,
                folder_id TEXT, color TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                deleted_at TEXT
             );
             CREATE TABLE IF NOT EXISTS note_asset_embed (
                id TEXT PRIMARY KEY, note_id TEXT NOT NULL, asset_id TEXT,
                target_name TEXT NOT NULL, is_missing INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY, value TEXT
             );
             CREATE TABLE IF NOT EXISTS note_link (
                id TEXT PRIMARY KEY, from_note_id TEXT NOT NULL, to_note_id TEXT,
                target_title TEXT NOT NULL, is_missing INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS ai_conversation (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS ai_message (
                id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
                content TEXT NOT NULL, created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS collection_item (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL CHECK(type IN ('text', 'link', 'file')),
                content TEXT NOT NULL, asset_id TEXT, url_metadata TEXT, source TEXT,
                created_at TEXT NOT NULL, processed_at TEXT, processed_note_id TEXT,
                processed_action TEXT, thumbnail TEXT, browser TEXT, trigger TEXT,
                processed_asset_id TEXT
             );
             CREATE TABLE IF NOT EXISTS asset_ai (
                asset_id TEXT PRIMARY KEY, description TEXT, auto_tags TEXT,
                status TEXT NOT NULL DEFAULT 'pending', error TEXT, processed_at TEXT
             );
             CREATE TABLE IF NOT EXISTS note_ai (
                note_id TEXT PRIMARY KEY, summary TEXT, auto_tags TEXT,
                status TEXT NOT NULL DEFAULT 'pending', error TEXT, processed_at TEXT
             );
             CREATE TABLE IF NOT EXISTS memory_entries (
                id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT,
                importance REAL DEFAULT 0.5, created_at TEXT,
                accessed_count INTEGER DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS collection_failure (
                id TEXT PRIMARY KEY, source TEXT NOT NULL, payload TEXT NOT NULL,
                error TEXT NOT NULL, created_at TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT 'unknown'
             );
             CREATE TABLE IF NOT EXISTS local_capability (
                id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
                description TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'ready', last_run_at TEXT,
                last_result TEXT, last_error TEXT, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );",
        )
        .map_err(|error| database_error("backend-schema-failed", error))?;
    if fault == BootstrapFault::AfterCoreSchema {
        return Err(BackendBootstrapError {
            code: "backend-test-injected",
            message: "injected backend migration failure".to_string(),
        });
    }

    for (table, column, declaration) in [
        ("asset", "library_path", "library_path TEXT"),
        (
            "asset",
            "storage_mode",
            "storage_mode TEXT NOT NULL DEFAULT 'linked'",
        ),
        ("asset", "thumbnail_url", "thumbnail_url TEXT"),
        ("asset", "description", "description TEXT"),
        ("asset", "rating", "rating INTEGER"),
        ("asset", "dominant_color", "dominant_color TEXT"),
        ("asset", "updated_at", "updated_at TEXT"),
        ("asset", "folder_id", "folder_id TEXT"),
        ("asset", "content_hash", "content_hash TEXT"),
        ("note", "deleted_at", "deleted_at TEXT"),
        ("collection_item", "thumbnail", "thumbnail TEXT"),
        ("collection_item", "browser", "browser TEXT"),
        ("collection_item", "trigger", "trigger TEXT"),
        (
            "collection_item",
            "processed_asset_id",
            "processed_asset_id TEXT",
        ),
        (
            "collection_failure",
            "reason",
            "reason TEXT NOT NULL DEFAULT 'unknown'",
        ),
    ] {
        ensure_column(connection, table, column, declaration)?;
    }

    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_asset_content_hash ON asset(content_hash);
             CREATE INDEX IF NOT EXISTS idx_asset_imported_at ON asset(imported_at DESC);
             CREATE INDEX IF NOT EXISTS idx_folder_scope_parent ON folder(scope, parent_id, sort_order);
             CREATE INDEX IF NOT EXISTS idx_item_tag_item ON item_tag(item_type, item_id);
             CREATE INDEX IF NOT EXISTS idx_item_tag_tag ON item_tag(tag_id);
             CREATE INDEX IF NOT EXISTS idx_note_folder ON note(folder_id);
             CREATE INDEX IF NOT EXISTS idx_note_updated ON note(updated_at DESC);
             CREATE INDEX IF NOT EXISTS idx_note_link_from ON note_link(from_note_id);
             CREATE INDEX IF NOT EXISTS idx_note_link_to ON note_link(to_note_id);
             CREATE INDEX IF NOT EXISTS idx_note_asset_embed_note ON note_asset_embed(note_id);
             CREATE INDEX IF NOT EXISTS idx_note_asset_embed_asset ON note_asset_embed(asset_id);
             CREATE INDEX IF NOT EXISTS idx_ai_msg_conv ON ai_message(conversation_id, created_at);
             CREATE INDEX IF NOT EXISTS idx_collection_processed ON collection_item(processed_at, created_at);
             CREATE INDEX IF NOT EXISTS idx_collection_type ON collection_item(type);
             CREATE INDEX IF NOT EXISTS idx_collection_source ON collection_item(source, created_at DESC);
             CREATE INDEX IF NOT EXISTS idx_collection_processed_action ON collection_item(processed_action, processed_at);
             CREATE INDEX IF NOT EXISTS idx_collection_type_processed ON collection_item(type, processed_action, created_at DESC);
             CREATE VIRTUAL TABLE IF NOT EXISTS asset_search USING fts5(
                id, name, description, original_path, tokenize = 'unicode61'
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS note_search USING fts5(
                id, title, content_text, tokenize = 'unicode61'
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS collection_item_search USING fts5(
                title, url, selection, tokenize='unicode61'
             );
             CREATE TRIGGER IF NOT EXISTS asset_search_ai AFTER INSERT ON asset BEGIN
                INSERT INTO asset_search(id, name, description, original_path)
                VALUES (new.id, new.name, COALESCE(new.description, ''), COALESCE(new.original_path, ''));
             END;
             CREATE TRIGGER IF NOT EXISTS asset_search_ad AFTER DELETE ON asset BEGIN
                DELETE FROM asset_search WHERE id = old.id;
             END;
             CREATE TRIGGER IF NOT EXISTS asset_search_au AFTER UPDATE ON asset BEGIN
                DELETE FROM asset_search WHERE id = old.id;
                INSERT INTO asset_search(id, name, description, original_path)
                VALUES (new.id, new.name, COALESCE(new.description, ''), COALESCE(new.original_path, ''));
             END;
             CREATE TRIGGER IF NOT EXISTS note_search_ai AFTER INSERT ON note BEGIN
                INSERT INTO note_search(id, title, content_text)
                VALUES (new.id, new.title, COALESCE(new.content_text, ''));
             END;
             CREATE TRIGGER IF NOT EXISTS note_search_ad AFTER DELETE ON note BEGIN
                DELETE FROM note_search WHERE id = old.id;
             END;
             CREATE TRIGGER IF NOT EXISTS note_search_au AFTER UPDATE ON note BEGIN
                DELETE FROM note_search WHERE id = old.id;
                INSERT INTO note_search(id, title, content_text)
                VALUES (new.id, new.title, COALESCE(new.content_text, ''));
             END;
             CREATE TRIGGER IF NOT EXISTS collection_item_ai AFTER INSERT ON collection_item BEGIN
                INSERT INTO collection_item_search(rowid, title, url, selection)
                VALUES (new.rowid, COALESCE(new.content,''), COALESCE(json_extract(new.url_metadata,'$.url'),''), COALESCE(json_extract(new.url_metadata,'$.selection'),''));
             END;
             CREATE TRIGGER IF NOT EXISTS collection_item_ad AFTER DELETE ON collection_item BEGIN
                DELETE FROM collection_item_search WHERE rowid = old.rowid;
             END;
             CREATE TRIGGER IF NOT EXISTS collection_item_au AFTER UPDATE ON collection_item BEGIN
                DELETE FROM collection_item_search WHERE rowid = old.rowid;
                INSERT INTO collection_item_search(rowid, title, url, selection)
                VALUES (new.rowid, COALESCE(new.content,''), COALESCE(json_extract(new.url_metadata,'$.url'),''), COALESCE(json_extract(new.url_metadata,'$.selection'),''));
             END;
             INSERT OR IGNORE INTO asset_search(id, name, description, original_path)
                SELECT id, name, COALESCE(description, ''), COALESCE(original_path, '') FROM asset;
             INSERT OR IGNORE INTO note_search(id, title, content_text)
                SELECT id, title, COALESCE(content_text, '') FROM note WHERE deleted_at IS NULL;",
        )
        .map_err(|error| database_error("backend-search-schema-failed", error))?;
    let collection_search_sql = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'collection_item_search'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| database_error("backend-search-inspection-failed", error))?;
    if !collection_search_sql.contains("content='collection_item'") {
        connection
            .execute_batch(
                "INSERT OR IGNORE INTO collection_item_search(rowid, title, url, selection)
                 SELECT rowid, COALESCE(content,''), COALESCE(json_extract(url_metadata,'$.url'),''), COALESCE(json_extract(url_metadata,'$.selection'),'')
                 FROM collection_item;",
            )
            .map_err(|error| database_error("backend-search-backfill-failed", error))?;
    }

    materials::ensure_change_schema(connection).map_err(|error| BackendBootstrapError {
        code: "backend-material-schema-failed",
        message: error.message,
    })?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<(), BackendBootstrapError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| database_error("backend-column-inspection-failed", error))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| database_error("backend-column-inspection-failed", error))?;
    for existing in columns {
        if existing.map_err(|error| database_error("backend-column-inspection-failed", error))?
            == column
        {
            return Ok(());
        }
    }
    drop(statement);
    connection
        .execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {declaration}"))
        .map_err(|error| database_error("backend-column-migration-failed", error))
}

fn verify_required_schema(connection: &Connection) -> Result<(), BackendBootstrapError> {
    for table in REQUIRED_TABLES {
        verify_ordinary_table_spec(connection, table)?;
    }
    for fts in REQUIRED_FTS {
        verify_fts_spec(connection, fts)?;
    }
    for index in REQUIRED_INDEXES {
        verify_index_spec(connection, index)?;
    }
    for trigger in REQUIRED_TRIGGERS {
        verify_trigger_spec(connection, trigger)?;
    }
    verify_search_behavior(connection)?;
    verify_material_change_behavior(connection)?;
    Ok(())
}

fn verify_ordinary_table_spec(
    connection: &Connection,
    table: &TableSpec,
) -> Result<(), BackendBootstrapError> {
    let entry = required_schema_entry(connection, table.name)?;
    let normalized = normalize_schema_sql(&entry.sql);
    if entry.object_type != "table"
        || entry.table_name != table.name
        || normalized.contains("createvirtualtable")
    {
        return Err(schema_verification_error(
            "backend-schema-object-type",
            table.name,
            "expected ordinary table",
        ));
    }
    verify_table_columns(connection, table)
}

fn verify_fts_spec(connection: &Connection, fts: &FtsSpec) -> Result<(), BackendBootstrapError> {
    let entry = required_schema_entry(connection, fts.name)?;
    let normalized = normalize_schema_sql(&entry.sql);
    if entry.object_type != "table"
        || entry.table_name != fts.name
        || !normalized.contains("createvirtualtable")
        || !normalized.contains("usingfts5")
    {
        return Err(schema_verification_error(
            "backend-schema-object-type",
            fts.name,
            "expected FTS5 virtual table",
        ));
    }
    if normalized.contains("content=")
        && !fts
            .allowed_external_content
            .is_some_and(|table| normalized.contains(&format!("content={table}")))
    {
        return Err(schema_verification_error(
            "backend-schema-fts-unusable",
            fts.name,
            "unsupported external-content mapping",
        ));
    }
    let mut statement = connection
        .prepare("SELECT name FROM pragma_table_xinfo(?1) WHERE hidden = 0 ORDER BY cid")
        .map_err(|_| {
            schema_verification_error(
                "backend-schema-verification-failed",
                fts.name,
                "FTS column metadata query failed",
            )
        })?;
    let columns = statement
        .query_map([fts.name], |row| row.get::<_, String>(0))
        .map_err(|_| {
            schema_verification_error(
                "backend-schema-verification-failed",
                fts.name,
                "FTS column metadata query failed",
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| {
            schema_verification_error(
                "backend-schema-verification-failed",
                fts.name,
                "FTS column metadata query failed",
            )
        })?;
    if columns != fts.columns {
        return Err(schema_verification_error(
            "backend-schema-fts-unusable",
            fts.name,
            "FTS columns are incompatible",
        ));
    }
    Ok(())
}

fn verify_index_spec(
    connection: &Connection,
    index: &IndexSpec,
) -> Result<(), BackendBootstrapError> {
    let entry = required_schema_entry(connection, index.name)?;
    if entry.object_type != "index" || entry.table_name != index.table {
        return Err(schema_verification_error(
            "backend-schema-index-mismatch",
            index.name,
            "wrong index owner",
        ));
    }
    let mut statement = connection
        .prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
        .map_err(|_| {
            schema_verification_error(
                "backend-schema-verification-failed",
                index.name,
                "index metadata query failed",
            )
        })?;
    let columns = statement
        .query_map([index.name], |row| row.get::<_, Option<String>>(0))
        .map_err(|_| {
            schema_verification_error(
                "backend-schema-verification-failed",
                index.name,
                "index metadata query failed",
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| {
            schema_verification_error(
                "backend-schema-verification-failed",
                index.name,
                "index metadata query failed",
            )
        })?;
    let expected = index
        .columns
        .iter()
        .map(|column| Some((*column).to_string()))
        .collect::<Vec<_>>();
    if columns != expected {
        return Err(schema_verification_error(
            "backend-schema-index-mismatch",
            index.name,
            "indexed columns are incompatible",
        ));
    }
    Ok(())
}

fn verify_trigger_spec(
    connection: &Connection,
    trigger: &TriggerSpec,
) -> Result<(), BackendBootstrapError> {
    let entry = required_schema_entry(connection, trigger.name)?;
    if entry.object_type != "trigger" || entry.table_name != trigger.table {
        return Err(schema_verification_error(
            "backend-schema-trigger-mismatch",
            trigger.name,
            "wrong trigger owner",
        ));
    }
    Ok(())
}

fn verify_search_behavior(connection: &Connection) -> Result<(), BackendBootstrapError> {
    run_rollback_verification(
        connection,
        "schema_search_smoke",
        "search-smoke",
        verify_search_behavior_in_savepoint,
    )
}

fn verify_search_behavior_in_savepoint(
    transaction: &Connection,
) -> Result<(), BackendBootstrapError> {
    let suffix = schema_probe_suffix();
    let now = "2000-01-01T00:00:00Z";

    let asset_id = format!("__schema_asset_{suffix}");
    let asset_old = format!("lrassetold{suffix}");
    let asset_new = format!("lrassetnew{suffix}");
    transaction
        .execute(
            "INSERT INTO asset(
                id, name, original_path, library_path, storage_mode, kind, mime_type,
                size_bytes, thumbnail_url, description, rating, dominant_color,
                folder_id, imported_at, updated_at, content_hash
             ) VALUES (?1, ?2, ?3, NULL, 'linked', 'image', 'image/png', 1, NULL, '', NULL, NULL, NULL, ?4, ?4, NULL)",
            rusqlite::params![asset_id, asset_old, format!("C:/schema/{suffix}.png"), now],
        )
        .map_err(|_| search_behavior_error("asset_search_ai", "asset insert failed"))?;
    expect_named_fts_match(
        &transaction,
        "asset_search",
        "id",
        &asset_id,
        &asset_old,
        true,
    )?;
    transaction
        .execute(
            "UPDATE asset SET name = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![asset_new, now, asset_id],
        )
        .map_err(|_| search_behavior_error("asset_search_au", "asset update failed"))?;
    expect_named_fts_match(
        &transaction,
        "asset_search",
        "id",
        &asset_id,
        &asset_old,
        false,
    )?;
    expect_named_fts_match(
        &transaction,
        "asset_search",
        "id",
        &asset_id,
        &asset_new,
        true,
    )?;
    transaction
        .execute("DELETE FROM asset WHERE id = ?1", [&asset_id])
        .map_err(|_| search_behavior_error("asset_search_ad", "asset delete failed"))?;
    expect_named_fts_match(
        &transaction,
        "asset_search",
        "id",
        &asset_id,
        &asset_new,
        false,
    )?;

    let collection_id = format!("__schema_collection_{suffix}");
    let collection_old = format!("lrcollectionold{suffix}");
    let collection_new = format!("lrcollectionnew{suffix}");
    let old_url = format!("https://schema.invalid/{collection_old}");
    let new_url = format!("https://schema.invalid/{collection_new}");
    let old_metadata = serde_json::json!({
        "url": old_url,
        "selection": format!("selection{collection_old}"),
    })
    .to_string();
    let new_metadata = serde_json::json!({
        "url": new_url,
        "selection": format!("selection{collection_new}"),
    })
    .to_string();
    transaction
        .execute(
            "INSERT INTO collection_item(
                id, type, content, asset_id, url_metadata, source, created_at,
                processed_at, processed_note_id, processed_action, thumbnail,
                browser, trigger, processed_asset_id
             ) VALUES (?1, 'link', ?2, NULL, ?3, 'schema-verifier', ?4, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
            rusqlite::params![collection_id, collection_old, old_metadata, now],
        )
        .map_err(|_| search_behavior_error("collection_item_ai", "collection insert failed"))?;
    let collection_rowid = transaction
        .query_row(
            "SELECT rowid FROM collection_item WHERE id = ?1",
            [&collection_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| {
            search_behavior_error("collection_item_search", "collection row lookup failed")
        })?;
    expect_collection_fts_match(
        &transaction,
        collection_rowid,
        &collection_old,
        &old_url,
        true,
    )?;
    transaction
        .execute(
            "UPDATE collection_item SET content = ?1, url_metadata = ?2 WHERE id = ?3",
            rusqlite::params![collection_new, new_metadata, collection_id],
        )
        .map_err(|_| search_behavior_error("collection_item_au", "collection update failed"))?;
    expect_collection_fts_match(
        &transaction,
        collection_rowid,
        &collection_old,
        &old_url,
        false,
    )?;
    expect_collection_fts_match(
        &transaction,
        collection_rowid,
        &collection_new,
        &new_url,
        true,
    )?;
    transaction
        .execute(
            "DELETE FROM collection_item WHERE id = ?1",
            [&collection_id],
        )
        .map_err(|_| search_behavior_error("collection_item_ad", "collection delete failed"))?;
    expect_collection_fts_match(
        &transaction,
        collection_rowid,
        &collection_new,
        &new_url,
        false,
    )?;

    Ok(())
}

fn expect_named_fts_match(
    connection: &Connection,
    fts_table: &str,
    identity_column: &str,
    identity: &str,
    query: &str,
    expected: bool,
) -> Result<(), BackendBootstrapError> {
    let sql = format!(
        "SELECT EXISTS(SELECT 1 FROM {fts_table} WHERE {fts_table} MATCH ?1 AND {identity_column} = ?2)"
    );
    let matched = connection
        .query_row(&sql, rusqlite::params![query, identity], |row| {
            row.get::<_, bool>(0)
        })
        .map_err(|_| search_behavior_error(fts_table, "MATCH query failed"))?;
    if matched != expected {
        return Err(search_behavior_error(
            fts_table,
            "insert/update/delete synchronization is incompatible",
        ));
    }
    Ok(())
}

fn expect_collection_fts_match(
    connection: &Connection,
    rowid: i64,
    query: &str,
    expected_title: &str,
    expected: bool,
) -> Result<(), BackendBootstrapError> {
    let result = connection
        .query_row(
            "SELECT title, url, selection FROM collection_item_search
             WHERE collection_item_search MATCH ?1 AND rowid = ?2",
            rusqlite::params![query, rowid],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| search_behavior_error("collection_item_search", "MATCH query failed"))?;
    if expected {
        let Some((title, url, selection)) = result else {
            return Err(search_behavior_error(
                "collection_item_search",
                "expected indexed row is missing",
            ));
        };
        if title != query || url != expected_title || selection.is_empty() {
            return Err(search_behavior_error(
                "collection_item_search",
                "indexed columns are incompatible",
            ));
        }
    } else if result.is_some() {
        return Err(search_behavior_error(
            "collection_item_search",
            "stale indexed row remains",
        ));
    }
    Ok(())
}

fn verify_material_change_behavior(connection: &Connection) -> Result<(), BackendBootstrapError> {
    run_rollback_verification(
        connection,
        "schema_material_change_smoke",
        "material-change-smoke",
        verify_material_change_behavior_in_savepoint,
    )
}

fn verify_material_change_behavior_in_savepoint(
    transaction: &Connection,
) -> Result<(), BackendBootstrapError> {
    let suffix = schema_probe_suffix();
    let now = "2000-01-01T00:00:00Z";
    let mut version = material_change_version(transaction)?;

    let asset_id = format!("__schema_change_asset_{suffix}");
    transaction
        .execute(
            "INSERT INTO asset(
                id, name, original_path, library_path, storage_mode, kind, mime_type,
                size_bytes, thumbnail_url, description, rating, dominant_color,
                folder_id, imported_at, updated_at, content_hash
             ) VALUES (?1, 'schema change asset', ?2, NULL, 'linked', 'image', 'image/png', 1, NULL, '', NULL, NULL, NULL, ?3, ?3, NULL)",
            rusqlite::params![asset_id, format!("C:/schema/change-{suffix}.png"), now],
        )
        .map_err(|_| trigger_behavior_error("material_change_asset_insert"))?;
    version = expect_material_change(
        &transaction,
        version,
        "asset-insert",
        false,
        "material_change_asset_insert",
    )?;
    transaction
        .execute(
            "UPDATE asset SET name = 'schema changed asset' WHERE id = ?1",
            [&asset_id],
        )
        .map_err(|_| trigger_behavior_error("material_change_asset_update"))?;
    version = expect_material_change(
        &transaction,
        version,
        "asset-update",
        false,
        "material_change_asset_update",
    )?;
    transaction
        .execute("DELETE FROM asset WHERE id = ?1", [&asset_id])
        .map_err(|_| trigger_behavior_error("material_change_asset_delete"))?;
    version = expect_material_change(
        &transaction,
        version,
        "asset-delete",
        false,
        "material_change_asset_delete",
    )?;

    let folder_id = format!("__schema_change_folder_{suffix}");
    transaction
        .execute(
            "INSERT INTO folder(id, scope, parent_id, name, sort_order, open, created_at, updated_at)
             VALUES (?1, 'materials', NULL, 'schema folder', 0, 1, ?2, ?2)",
            rusqlite::params![folder_id, now],
        )
        .map_err(|_| trigger_behavior_error("material_change_folder_insert"))?;
    version = expect_material_change(
        &transaction,
        version,
        "folder-insert",
        true,
        "material_change_folder_insert",
    )?;
    transaction
        .execute(
            "UPDATE folder SET name = 'schema changed folder' WHERE id = ?1",
            [&folder_id],
        )
        .map_err(|_| trigger_behavior_error("material_change_folder_update"))?;
    version = expect_material_change(
        &transaction,
        version,
        "folder-update",
        true,
        "material_change_folder_update",
    )?;
    transaction
        .execute("DELETE FROM folder WHERE id = ?1", [&folder_id])
        .map_err(|_| trigger_behavior_error("material_change_folder_delete"))?;
    version = expect_material_change(
        &transaction,
        version,
        "folder-delete",
        true,
        "material_change_folder_delete",
    )?;

    let tag_id = format!("__schema_change_tag_{suffix}");
    transaction
        .execute(
            "INSERT INTO tag(id, name, color, created_at, updated_at) VALUES (?1, ?2, NULL, ?3, ?3)",
            rusqlite::params![tag_id, format!("schema-tag-{suffix}"), now],
        )
        .map_err(|_| trigger_behavior_error("material_change_tag_insert"))?;
    version = expect_material_change(
        &transaction,
        version,
        "tag-insert",
        false,
        "material_change_tag_insert",
    )?;
    transaction
        .execute("UPDATE tag SET color = '#000000' WHERE id = ?1", [&tag_id])
        .map_err(|_| trigger_behavior_error("material_change_tag_update"))?;
    version = expect_material_change(
        &transaction,
        version,
        "tag-update",
        false,
        "material_change_tag_update",
    )?;

    let item_tag_id = format!("__schema_change_item_tag_{suffix}");
    transaction
        .execute(
            "INSERT INTO item_tag(id, item_type, item_id, tag_id, created_at)
             VALUES (?1, 'asset', ?2, ?3, ?4)",
            rusqlite::params![item_tag_id, format!("schema-item-{suffix}"), tag_id, now],
        )
        .map_err(|_| trigger_behavior_error("material_change_asset_tag_insert"))?;
    version = expect_material_change(
        &transaction,
        version,
        "asset-tag-insert",
        false,
        "material_change_asset_tag_insert",
    )?;
    transaction
        .execute("DELETE FROM item_tag WHERE id = ?1", [&item_tag_id])
        .map_err(|_| trigger_behavior_error("material_change_asset_tag_delete"))?;
    version = expect_material_change(
        &transaction,
        version,
        "asset-tag-delete",
        false,
        "material_change_asset_tag_delete",
    )?;
    transaction
        .execute("DELETE FROM tag WHERE id = ?1", [&tag_id])
        .map_err(|_| trigger_behavior_error("material_change_tag_delete"))?;
    let _ = expect_material_change(
        &transaction,
        version,
        "tag-delete",
        false,
        "material_change_tag_delete",
    )?;

    Ok(())
}

fn run_rollback_verification(
    connection: &Connection,
    savepoint: &'static str,
    object: &'static str,
    verify: impl FnOnce(&Connection) -> Result<(), BackendBootstrapError>,
) -> Result<(), BackendBootstrapError> {
    connection
        .execute_batch(&format!("SAVEPOINT {savepoint}"))
        .map_err(|_| {
            schema_verification_error(
                "backend-schema-verification-failed",
                object,
                "could not start verification savepoint",
            )
        })?;
    let result = verify(connection);
    let rollback =
        connection.execute_batch(&format!("ROLLBACK TO {savepoint}; RELEASE {savepoint};"));
    if rollback.is_err() {
        return Err(schema_verification_error(
            "backend-schema-verification-failed",
            object,
            "verification rollback failed",
        ));
    }
    result
}

fn material_change_version(connection: &Connection) -> Result<i64, BackendBootstrapError> {
    connection
        .query_row(
            "SELECT version FROM material_change_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| {
            schema_verification_error(
                "backend-schema-trigger-mismatch",
                "material_change_state",
                "change singleton is unavailable",
            )
        })
}

fn expect_material_change(
    connection: &Connection,
    previous_version: i64,
    expected_reason: &str,
    expected_folders_changed: bool,
    trigger: &str,
) -> Result<i64, BackendBootstrapError> {
    let (version, reason, folders_changed) = connection
        .query_row(
            "SELECT version, reason, folders_changed FROM material_change_state WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            },
        )
        .map_err(|_| trigger_behavior_error(trigger))?;
    if version != previous_version + 1
        || reason != expected_reason
        || folders_changed != expected_folders_changed
    {
        return Err(trigger_behavior_error(trigger));
    }
    Ok(version)
}

fn schema_probe_suffix() -> String {
    format!(
        "{:x}{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn search_behavior_error(object: &str, reason: &str) -> BackendBootstrapError {
    schema_verification_error("backend-schema-fts-unusable", object, reason)
}

fn trigger_behavior_error(trigger: &str) -> BackendBootstrapError {
    schema_verification_error(
        "backend-schema-trigger-mismatch",
        trigger,
        "trigger behavior is incompatible",
    )
}

fn verify_table_columns(
    connection: &Connection,
    table: &TableSpec,
) -> Result<(), BackendBootstrapError> {
    for expected in table.columns {
        let metadata = connection
            .query_row(
                "SELECT [notnull], dflt_value, pk FROM pragma_table_xinfo(?1) WHERE name = ?2",
                rusqlite::params![table.name, expected.name],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)? != 0,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i64>(2)? != 0,
                    ))
                },
            )
            .optional()
            .map_err(|_| {
                schema_verification_error(
                    "backend-schema-verification-failed",
                    table.name,
                    "column metadata query failed",
                )
            })?;
        let Some((not_null, default_value, primary_key)) = metadata else {
            return Err(schema_verification_error(
                "backend-schema-column-mismatch",
                &format!("{}.{}", table.name, expected.name),
                "required column is missing",
            ));
        };
        let valid = match expected.requirement {
            ColumnRequirement::Present => true,
            ColumnRequirement::PrimaryKey => primary_key,
            ColumnRequirement::NotNullPrimaryKey => not_null && primary_key,
            ColumnRequirement::NotNull => not_null,
            ColumnRequirement::NotNullDefault(expected_default) => {
                not_null
                    && default_value
                        .as_deref()
                        .is_some_and(|actual| normalize_default(actual) == expected_default)
            }
        };
        if !valid {
            return Err(schema_verification_error(
                "backend-schema-column-mismatch",
                &format!("{}.{}", table.name, expected.name),
                "column contract is incompatible",
            ));
        }
    }
    Ok(())
}

fn normalize_default(value: &str) -> String {
    let mut normalized = value.trim();
    while normalized.starts_with('(') && normalized.ends_with(')') && normalized.len() >= 2 {
        normalized = normalized[1..normalized.len() - 1].trim();
    }
    normalized
        .trim_matches(|character| matches!(character, '\'' | '"'))
        .to_lowercase()
}

struct SchemaEntry {
    object_type: String,
    table_name: String,
    sql: String,
}

fn required_schema_entry(
    connection: &Connection,
    name: &str,
) -> Result<SchemaEntry, BackendBootstrapError> {
    connection
        .query_row(
            "SELECT type, tbl_name, COALESCE(sql, '') FROM sqlite_schema WHERE name = ?1",
            [name],
            |row| {
                Ok(SchemaEntry {
                    object_type: row.get(0)?,
                    table_name: row.get(1)?,
                    sql: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|_| {
            schema_verification_error(
                "backend-schema-verification-failed",
                name,
                "metadata query failed",
            )
        })?
        .ok_or_else(|| {
            schema_verification_error(
                "backend-schema-incomplete",
                name,
                "required object is missing",
            )
        })
}

fn normalize_schema_sql(sql: &str) -> String {
    sql.chars()
        .filter(|character| !character.is_whitespace() && !matches!(character, '\'' | '"' | '`'))
        .flat_map(char::to_lowercase)
        .collect()
}

fn schema_verification_error(
    code: &'static str,
    object: &str,
    reason: &str,
) -> BackendBootstrapError {
    BackendBootstrapError {
        code,
        message: format!("schema verification failed for {object}: {reason}"),
    }
}

fn database_error(code: &'static str, error: rusqlite::Error) -> BackendBootstrapError {
    let code = if matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
    ) {
        "backend-database-corrupt"
    } else {
        code
    };
    BackendBootstrapError {
        code,
        message: error.to_string(),
    }
}

#[cfg(test)]
#[path = "../materials/library_backend_tests.rs"]
mod material_library_r2_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::materials::{MaterialBytesInput, MaterialFilter, MaterialImportOptions};

    #[test]
    fn material_library_r1_bootstrap_ledger24_restart_and_default_boundary() {
        let app_data=temp_app_data("material-library-r1-bootstrap");
        let backend=BackendServices::initialize(&app_data).unwrap();
        let catalog=backend.material_catalog();
        let root=app_data.join("second-library");std::fs::create_dir(&root).unwrap();
        let library=catalog.create_library("第二库",&root,"managed").unwrap();
        let scoped=catalog.for_library(&library.id).unwrap();
        let asset=scoped.import_bytes(vec![MaterialBytesInput{name:"second.bin".into(),original_path:"https://example.test/source".into(),mime_type:"application/octet-stream".into(),bytes:b"temporary bytes".to_vec(),description:None}],&MaterialImportOptions::default()).unwrap().value.assets.remove(0);
        catalog.select_library(&library.id).unwrap();
        assert_eq!(backend.status().schema_version,SCHEMA_VERSION);
        assert!(catalog.list_assets(&MaterialFilter::default()).unwrap().is_empty());
        assert!(catalog.companion_resource(&asset.id,false).is_err());
        drop(scoped);drop(catalog);drop(backend);
        let restarted=BackendServices::initialize(&app_data).unwrap();
        let conn=restarted.open_read().unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM backend_schema_migration WHERE version=24",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(restarted.material_catalog().library_state().unwrap().1,library.id);
        assert_eq!(restarted.material_catalog().for_library(&library.id).unwrap().get_assets(&[asset.id]).unwrap().len(),1);
        drop(conn);drop(restarted);std::fs::remove_dir_all(app_data).unwrap();
    }

    fn temp_app_data(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "luckyray-backend-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn assert_collection_fts_round_trip(connection: &Connection, label: &str) {
        let id = format!("collection-{label}");
        let old_term = format!("oldterm{label}");
        let new_term = format!("newterm{label}");
        let old_url_term = format!("oldurl{label}");
        let new_url_term = format!("newurl{label}");
        let old_selection_term = format!("oldselection{label}");
        let new_selection_term = format!("newselection{label}");
        let old_url = format!("https://example.test/{old_url_term}");
        let new_url = format!("https://example.test/{new_url_term}");
        let old_metadata = serde_json::json!({
            "url": old_url,
            "selection": old_selection_term,
        })
        .to_string();
        let new_metadata = serde_json::json!({
            "url": new_url,
            "selection": new_selection_term,
        })
        .to_string();
        connection
            .execute(
                "INSERT INTO collection_item(
                    id, type, content, asset_id, url_metadata, source, created_at,
                    processed_at, processed_note_id, processed_action, thumbnail,
                    browser, trigger, processed_asset_id
                 ) VALUES (?1, 'link', ?2, NULL, ?3, 'schema-test', '2000-01-01T00:00:00Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
                rusqlite::params![id, old_term, old_metadata],
            )
            .unwrap();
        let rowid = connection
            .query_row(
                "SELECT rowid FROM collection_item WHERE id = ?1",
                [&id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        let old = collection_fts_row(connection, rowid, &old_term).unwrap();
        assert_eq!(old.0, old_term);
        assert_eq!(old.1, old_url);
        assert!(!old.2.is_empty());
        assert!(collection_fts_row(connection, rowid, &old_url_term).is_some());
        assert!(collection_fts_row(connection, rowid, &old_selection_term).is_some());
        assert_eq!(
            production_collection_search_ids(connection, &old_term),
            vec![id.clone()]
        );

        connection
            .execute(
                "UPDATE collection_item SET content = ?1, url_metadata = ?2 WHERE id = ?3",
                rusqlite::params![new_term, new_metadata, id],
            )
            .unwrap();
        assert!(collection_fts_row(connection, rowid, &old_term).is_none());
        let new = collection_fts_row(connection, rowid, &new_term).unwrap();
        assert_eq!(new.0, new_term);
        assert_eq!(new.1, new_url);
        assert!(!new.2.is_empty());
        assert!(collection_fts_row(connection, rowid, &new_url_term).is_some());
        assert!(collection_fts_row(connection, rowid, &new_selection_term).is_some());
        for stale in [&old_term, &old_url_term, &old_selection_term] {
            assert!(collection_fts_row(connection, rowid, stale).is_none());
        }
        assert_eq!(
            production_collection_search_ids(connection, &new_term),
            vec![id.clone()]
        );

        connection
            .execute("DELETE FROM collection_item WHERE id = ?1", [&id])
            .unwrap();
        assert!(collection_fts_row(connection, rowid, &new_term).is_none());
        assert!(collection_fts_row(connection, rowid, &new_url_term).is_none());
        assert!(collection_fts_row(connection, rowid, &new_selection_term).is_none());
        assert!(production_collection_search_ids(connection, &new_term).is_empty());
    }

    fn production_collection_search_ids(connection: &Connection, query: &str) -> Vec<String> {
        let mut statement = connection
            .prepare(
                "SELECT ci.id
                 FROM collection_item_search cis
                 JOIN collection_item ci ON ci.rowid = cis.rowid
                 WHERE collection_item_search MATCH ?1
                   AND (ci.processed_action IS NULL OR ci.processed_action != 'deleted')
                 ORDER BY rank, ci.created_at DESC",
            )
            .unwrap();
        statement
            .query_map([query], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    fn collection_fts_row(
        connection: &Connection,
        rowid: i64,
        query: &str,
    ) -> Option<(String, String, String)> {
        connection
            .query_row(
                "SELECT title, url, selection FROM collection_item_search
                 WHERE collection_item_search MATCH ?1 AND rowid = ?2",
                rusqlite::params![query, rowid],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .unwrap()
    }

    fn create_published_legacy_collection_database(app_data: &Path) -> Connection {
        std::fs::create_dir_all(app_data).unwrap();
        let mut connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        apply_schema_v1(&transaction, BootstrapFault::None).unwrap();
        transaction
            .execute_batch(
                "DROP TRIGGER collection_item_ai;
                 DROP TRIGGER collection_item_ad;
                 DROP TRIGGER collection_item_au;
                 DROP TABLE collection_item_search;
                 DROP TABLE collection_item;
                 CREATE TABLE collection_item (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL CHECK(type IN ('text', 'link', 'file')),
                    content TEXT NOT NULL,
                    asset_id TEXT,
                    url_metadata TEXT,
                    source TEXT,
                    created_at TEXT NOT NULL,
                    processed_at TEXT,
                    processed_note_id TEXT,
                    processed_action TEXT,
                    thumbnail TEXT,
                    browser TEXT,
                    trigger TEXT,
                    processed_asset_id TEXT
                 );
                 CREATE INDEX idx_collection_processed ON collection_item(processed_at, created_at);
                 CREATE INDEX idx_collection_type ON collection_item(type);
                 CREATE INDEX idx_collection_source ON collection_item(source, created_at DESC);
                 CREATE INDEX idx_collection_processed_action ON collection_item(processed_action, processed_at);
                 CREATE INDEX idx_collection_type_processed ON collection_item(type, processed_action, created_at DESC);
                 CREATE VIRTUAL TABLE collection_item_search USING fts5(
                    title, url, selection,
                    content='collection_item',
                    content_rowid='rowid',
                    tokenize='unicode61'
                 );
                 CREATE TRIGGER collection_item_ai AFTER INSERT ON collection_item BEGIN
                    INSERT INTO collection_item_search(rowid, title, url, selection)
                    VALUES (new.rowid, COALESCE(new.content,''), COALESCE((SELECT json_extract(new.url_metadata,'$.url')),''), COALESCE((SELECT json_extract(new.url_metadata,'$.selection')),''));
                 END;
                 CREATE TRIGGER collection_item_ad AFTER DELETE ON collection_item BEGIN
                    INSERT INTO collection_item_search(collection_item_search, rowid, title, url, selection)
                    VALUES ('delete', old.rowid, COALESCE(old.content,''), '', '');
                 END;
                 CREATE TRIGGER collection_item_au AFTER UPDATE ON collection_item BEGIN
                    INSERT INTO collection_item_search(collection_item_search, rowid, title, url, selection)
                    VALUES ('delete', old.rowid, COALESCE(old.content,''), '', '');
                    INSERT INTO collection_item_search(rowid, title, url, selection)
                    VALUES (new.rowid, COALESCE(new.content,''), COALESCE((SELECT json_extract(new.url_metadata,'$.url')),''), COALESCE((SELECT json_extract(new.url_metadata,'$.selection')),''));
                 END;
                 CREATE TABLE backend_schema_migration (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at TEXT NOT NULL
                 );
                 INSERT INTO backend_schema_migration(version, name, applied_at)
                    VALUES (1, 'backend-owned-schema', '2000-01-01T00:00:00Z');",
            )
            .unwrap();
        transaction.commit().unwrap();
        connection
    }

    fn create_schema_v2_database(app_data: &Path) -> Connection {
        std::fs::create_dir_all(app_data).unwrap();
        let mut connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        apply_schema_v1(&transaction, BootstrapFault::None).unwrap();
        apply_schema_v2(&transaction, BootstrapFault::None).unwrap();
        transaction
            .execute_batch(
                "CREATE TABLE backend_schema_migration (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at TEXT NOT NULL
                 );
                 INSERT INTO backend_schema_migration(version, name, applied_at)
                    VALUES (1, 'backend-owned-schema', '2000-01-01T00:00:00Z');
                 INSERT INTO backend_schema_migration(version, name, applied_at)
                    VALUES (2, 'collection-external-content-compatibility', '2000-01-02T00:00:00Z');",
            )
            .unwrap();
        transaction.commit().unwrap();
        connection
    }

    fn create_schema_v7_database(app_data: &Path) -> Connection {
        std::fs::create_dir_all(app_data).unwrap();
        let mut connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        apply_schema_v1(&transaction, BootstrapFault::None).unwrap();
        apply_schema_v2(&transaction, BootstrapFault::None).unwrap();
        apply_schema_v3(&transaction, BootstrapFault::None).unwrap();
        crate::agent_runs::RunCoordinator::apply_schema(&transaction).unwrap();
        apply_schema_v5(&transaction).unwrap();
        apply_schema_v6(&transaction).unwrap();
        apply_schema_v7(&transaction).unwrap();
        transaction
            .execute_batch(
                "CREATE TABLE backend_schema_migration (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        for (version, name) in [
            (1, "backend-owned-schema"),
            (2, "collection-external-content-compatibility"),
            (3, "retire-sqlite-note-domain"),
            (4, "durable-agent-run-ledger"),
            (
                5,
                "agent-capability-registry-memory-skills-workspace-schedules",
            ),
            (6, "schedule-product-lifecycle-and-history"),
            (7, "agent-conversation-mode"),
        ] {
            transaction
                .execute(
                    "INSERT INTO backend_schema_migration(version,name,applied_at)
                     VALUES (?1,?2,?3)",
                    rusqlite::params![version, name, format!("2000-01-{version:02}")],
                )
                .unwrap();
        }
        transaction
            .execute(
                "INSERT INTO ai_conversation(
                     id,title,created_at,updated_at,agent_mode
                 ) VALUES ('legacy-project-task','Legacy','2000-01-01','2000-01-01','project-task')",
                [],
            )
            .unwrap();
        transaction.commit().unwrap();
        connection
    }

    fn insert_v2_domain_sentinels(connection: &Connection) {
        connection
            .execute_batch(
                "INSERT INTO folder(id, scope, parent_id, name, sort_order, open, created_at, updated_at)
                    VALUES ('folder-material', 'materials', NULL, 'Materials', 0, 1, '2000-01-01', '2000-01-01');
                 INSERT INTO folder(id, scope, parent_id, name, sort_order, open, created_at, updated_at)
                    VALUES ('folder-note', 'notes', NULL, 'Notes', 0, 1, '2000-01-01', '2000-01-01');
                 INSERT INTO tag(id, name, color, created_at, updated_at)
                    VALUES ('tag-shared', 'Shared', '#123456', '2000-01-01', '2000-01-01');
                 INSERT INTO asset(
                    id, name, original_path, library_path, storage_mode, kind, mime_type,
                    size_bytes, thumbnail_url, description, rating, dominant_color,
                    folder_id, imported_at, updated_at, content_hash
                 ) VALUES (
                    'asset-sentinel', 'Asset', 'C:/asset.png', NULL, 'linked', 'image',
                    'image/png', 7, NULL, 'keep', 4, '#123456', 'folder-material',
                    '2000-01-01', '2000-01-01', 'asset-hash'
                 );
                 INSERT INTO item_tag(id, item_type, item_id, tag_id, created_at)
                    VALUES ('item-tag-asset', 'asset', 'asset-sentinel', 'tag-shared', '2000-01-01');
                 INSERT INTO item_tag(id, item_type, item_id, tag_id, created_at)
                    VALUES ('item-tag-note', 'note', 'note-sentinel', 'tag-shared', '2000-01-01');
                 INSERT INTO settings(key, value) VALUES ('sentinel-setting', 'keep-setting');
                 INSERT INTO ai_conversation(id, title, created_at, updated_at)
                    VALUES ('conversation-sentinel', 'Keep conversation', '2000-01-01', '2000-01-01');
                 INSERT INTO collection_item(
                    id, type, content, asset_id, url_metadata, source, created_at,
                    processed_at, processed_note_id, processed_action, thumbnail,
                    browser, trigger, processed_asset_id
                 ) VALUES (
                    'collection-sentinel', 'text', 'keep collection', NULL, NULL, 'test',
                    '2000-01-01', NULL, 'legacy-note-id', NULL, NULL, NULL, NULL, NULL
                 );
                 INSERT INTO note(
                    id, title, content_json, content_text, folder_id, color,
                    created_at, updated_at, deleted_at
                 ) VALUES (
                    'note-sentinel', 'Retire note', NULL, 'retire body', 'folder-note', NULL,
                    '2000-01-01', '2000-01-01', NULL
                 );
                 INSERT INTO note_ai(note_id, summary, auto_tags, status, error, processed_at)
                    VALUES ('note-sentinel', 'retire summary', NULL, 'ready', NULL, '2000-01-01');
                 INSERT INTO note_link(id, from_note_id, to_note_id, target_title, is_missing, created_at)
                    VALUES ('link-sentinel', 'note-sentinel', NULL, 'Missing', 1, '2000-01-01');
                 INSERT INTO note_asset_embed(id, note_id, asset_id, target_name, is_missing, created_at)
                    VALUES ('embed-sentinel', 'note-sentinel', 'asset-sentinel', 'Asset', 0, '2000-01-01');",
            )
            .unwrap();
    }

    #[test]
    fn fresh_backend_bootstrap_exposes_materials_and_knowledge_without_a_webview() {
        let app_data = temp_app_data("fresh");
        let backend = BackendServices::initialize(&app_data).unwrap();

        assert!(backend.status().ready);
        assert_eq!(backend.status().schema_version, SCHEMA_VERSION);
        assert!(backend.material_catalog().list_folders().is_ok());
        let error = backend.knowledge().list_documents().unwrap_err();
        assert_eq!(error.code, "knowledge-vault-required");

        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn fresh_backend_owns_the_media_transfer_service() {
        let app_data = temp_app_data("media-transfer");
        let backend = BackendServices::initialize(&app_data).unwrap();

        let started = backend
            .media_transfer()
            .start(crate::media_transfer::MediaTransferRequest {
                url: "file:///C:/private/video.mp4?token=PRIVATE".into(),
                audio_url: None,
                file_name: "video.mp4".into(),
                mime_type: Some("video/mp4".into()),
                source_page_url: None,
                target_folder_id: None,
                new_folder_name: None,
                parent_folder_id: None,
                site_auth: None,
            })
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let failed = loop {
            let snapshot = backend
                .media_transfer()
                .status(&started.transfer_id)
                .unwrap();
            if matches!(
                snapshot.state,
                crate::media_transfer::MediaTransferState::Failed
            ) {
                break snapshot;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        };
        assert_eq!(failed.error_code.as_deref(), Some("media-network-denied"));
        let serialized = serde_json::to_string(&failed).unwrap();
        assert!(!serialized.contains("PRIVATE"));
        assert!(!serialized.contains("C:/private"));

        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn fresh_backend_retires_legacy_note_schema_without_touching_shared_domains() {
        let app_data = temp_app_data("fresh-retired-notes");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let connection = backend.open_read().unwrap();

        assert_eq!(backend.status().schema_version, SCHEMA_VERSION);
        for object in [
            "note",
            "note_ai",
            "note_asset_embed",
            "note_link",
            "note_search",
            "note_search_ai",
            "note_search_ad",
            "note_search_au",
        ] {
            let present: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = ?1)",
                    [object],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(!present, "retired schema object {object} is still present");
        }
        for object in [
            "asset",
            "folder",
            "tag",
            "item_tag",
            "settings",
            "ai_conversation",
            "collection_item",
        ] {
            let present: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = ?1)",
                    [object],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(present, "shared schema object {object} is missing");
        }

        drop(connection);
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn schema_v4_adds_durable_run_ledger_and_restart_is_a_noop() {
        let app_data = temp_app_data("v3-domain-retirement");
        let connection = create_schema_v2_database(&app_data);
        insert_v2_domain_sentinels(&connection);
        drop(connection);

        let first = BackendServices::initialize(&app_data).unwrap();
        let connection = first.open_write().unwrap();
        assert_eq!(first.status().schema_version, SCHEMA_VERSION);
        verify_retired_note_schema_absent(&connection).unwrap();
        for (table, identity_column, identity) in [
            ("asset", "id", "asset-sentinel"),
            ("folder", "id", "folder-material"),
            ("tag", "id", "tag-shared"),
            ("item_tag", "id", "item-tag-asset"),
            ("settings", "key", "sentinel-setting"),
            ("ai_conversation", "id", "conversation-sentinel"),
            ("collection_item", "id", "collection-sentinel"),
        ] {
            let sql = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {identity_column} = ?1)");
            assert!(
                connection
                    .query_row(&sql, [identity], |row| row.get::<_, bool>(0))
                    .unwrap(),
                "shared sentinel {table}.{identity} was lost"
            );
        }
        assert!(!connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM item_tag WHERE item_type = 'note')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
        assert!(!connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM folder WHERE scope = 'notes')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
        assert_eq!(
            connection
                .query_row(
                    "SELECT processed_note_id FROM collection_item WHERE id = 'collection-sentinel'",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap()
                .as_deref(),
            Some("legacy-note-id")
        );
        assert_eq!(
            connection
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        let foreign_key_violations: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(foreign_key_violations, 0);
        for table in ["ai_run", "ai_run_source", "ai_run_artifact"] {
            assert!(connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap());
        }
        let applied_at: String = connection
            .query_row(
                "SELECT applied_at FROM backend_schema_migration WHERE version = 4",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);
        drop(first);

        let second = BackendServices::initialize(&app_data).unwrap();
        let connection = second.open_read().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT applied_at FROM backend_schema_migration WHERE version = 4",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            applied_at
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM backend_schema_migration", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            SCHEMA_VERSION as i64
        );

        drop(connection);
        drop(second);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn recorded_v3_repairs_reintroduced_empty_retired_note_schema() {
        let app_data = temp_app_data("v3-reintroduced-empty-note-schema");
        let first = BackendServices::initialize(&app_data).unwrap();
        let mut connection = first.open_write().unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        apply_schema_v1(&transaction, BootstrapFault::None).unwrap();
        transaction.commit().unwrap();
        drop(connection);
        drop(first);

        let repaired = BackendServices::initialize(&app_data).unwrap();
        let connection = repaired.open_read().unwrap();
        verify_retired_note_schema_absent(&connection).unwrap();

        drop(connection);
        drop(repaired);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn recorded_v3_refuses_to_remove_reintroduced_retired_note_data() {
        let app_data = temp_app_data("v3-reintroduced-nonempty-note-schema");
        let first = BackendServices::initialize(&app_data).unwrap();
        let mut connection = first.open_write().unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        apply_schema_v1(&transaction, BootstrapFault::None).unwrap();
        transaction
            .execute(
                "INSERT INTO note(
                    id, title, content_json, content_text, folder_id, color,
                    created_at, updated_at, deleted_at
                 ) VALUES (
                    'must-survive', 'Must survive', NULL, '', NULL, NULL,
                    '2000-01-01', '2000-01-01', NULL
                 )",
                [],
            )
            .unwrap();
        transaction.commit().unwrap();
        drop(connection);
        drop(first);

        let error = BackendServices::initialize(&app_data).err().unwrap();
        assert_eq!(error.code, "backend-retired-schema-nonempty");
        let connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM note WHERE id = 'must-survive'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );

        drop(connection);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn schema_v3_failure_rolls_back_schema_shared_data_and_ledger() {
        let app_data = temp_app_data("v3-rollback");
        let connection = create_schema_v2_database(&app_data);
        insert_v2_domain_sentinels(&connection);
        drop(connection);

        let error = BackendServices::initialize_with_v3_test_failure(&app_data)
            .err()
            .unwrap();
        assert_eq!(error.code, "backend-test-injected");
        let connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        for object in [
            "note",
            "note_ai",
            "note_asset_embed",
            "note_link",
            "note_search",
        ] {
            assert!(
                connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = ?1)",
                        [object],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap(),
                "rollback lost {object}"
            );
        }
        for (table, identity_column, identity) in [
            ("asset", "id", "asset-sentinel"),
            ("item_tag", "id", "item-tag-note"),
            ("folder", "id", "folder-note"),
            ("settings", "key", "sentinel-setting"),
        ] {
            let sql = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {identity_column} = ?1)");
            assert!(
                connection
                    .query_row(&sql, [identity], |row| row.get::<_, bool>(0))
                    .unwrap(),
                "rollback lost {table}.{identity}"
            );
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT COALESCE(MAX(version), 0) FROM backend_schema_migration",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );
        drop(connection);

        let recovered = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(recovered.status().schema_version, SCHEMA_VERSION);
        verify_retired_note_schema_absent(&recovered.open_read().unwrap()).unwrap();
        drop(recovered);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn schema_v3_rejects_drifted_retired_objects_without_deleting_shared_data() {
        let app_data = temp_app_data("v3-drift");
        let connection = create_schema_v2_database(&app_data);
        insert_v2_domain_sentinels(&connection);
        connection
            .execute_batch(
                "DROP TRIGGER note_search_ai;
                 CREATE TRIGGER note_search_ai AFTER INSERT ON asset BEGIN SELECT 1; END;",
            )
            .unwrap();
        drop(connection);

        let error = BackendServices::initialize(&app_data).err().unwrap();
        assert_eq!(error.code, "backend-schema-trigger-mismatch");
        assert!(error.message.contains("note_search_ai"));
        let connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        assert!(connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM asset WHERE id = 'asset-sentinel')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
        assert!(connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM note WHERE id = 'note-sentinel')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
        assert_eq!(
            connection
                .query_row(
                    "SELECT COALESCE(MAX(version), 0) FROM backend_schema_migration",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );

        drop(connection);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn webview_free_material_import_is_queryable_and_duplicate_is_a_noop() {
        let app_data = temp_app_data("webview-free-material");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let catalog = backend.material_catalog();
        let input = MaterialBytesInput {
            name: "backend.png".to_string(),
            original_path: "https://example.test/backend.png".to_string(),
            mime_type: "image/png".to_string(),
            description: Some("backend bootstrap fixture".to_string()),
            bytes: b"backend-owned-material".to_vec(),
        };
        let version_before = catalog.read_change().unwrap().version;

        let imported = catalog
            .import_bytes(vec![input.clone()], &MaterialImportOptions::default())
            .unwrap();
        assert_eq!(imported.value.imported_count, 1);
        assert_eq!(imported.value.skipped_duplicate_count, 0);
        assert!(imported.change.is_some());
        assert_eq!(catalog.read_change().unwrap().version, version_before + 1);

        let listed = catalog.list_assets(&MaterialFilter::default()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "backend.png");

        let duplicate = catalog
            .import_bytes(vec![input], &MaterialImportOptions::default())
            .unwrap();
        assert_eq!(duplicate.value.imported_count, 0);
        assert_eq!(duplicate.value.skipped_duplicate_count, 1);
        assert!(duplicate.change.is_none());
        assert_eq!(catalog.read_change().unwrap().version, version_before + 1);

        drop(catalog);
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn fresh_backend_contains_the_required_application_schema_manifest() {
        let app_data = temp_app_data("manifest");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let connection = backend.open_write().unwrap();

        for name in REQUIRED_TABLES
            .iter()
            .map(|spec| spec.name)
            .chain(REQUIRED_FTS.iter().map(|spec| spec.name))
        {
            let present: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = ?1)",
                    [name],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(present, "required schema object {name} is missing");
        }

        for name in REQUIRED_INDEXES
            .iter()
            .map(|spec| spec.name)
            .chain(REQUIRED_TRIGGERS.iter().map(|spec| spec.name))
        {
            let present: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = ?1)",
                    [name],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(present, "required schema object {name} is missing");
        }
        assert!(verify_required_schema(&connection).is_ok());

        drop(connection);
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn fresh_collection_fts_supports_production_insert_update_delete_and_match() {
        let app_data = temp_app_data("fresh-collection-fts");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let connection = backend.open_write().unwrap();

        assert_eq!(backend.status().schema_version, SCHEMA_VERSION);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM backend_schema_migration", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            SCHEMA_VERSION as i64
        );
        let search_sql = connection
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE name = 'collection_item_search'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert!(!normalize_schema_sql(&search_sql).contains("content="));
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_xinfo('collection_item') WHERE name IN ('title', 'url', 'selection')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_collection_fts_round_trip(&connection, "fresh");
        let applied_at = connection
            .query_row(
                "SELECT applied_at FROM backend_schema_migration WHERE version = 2",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();

        drop(connection);
        drop(backend);
        let restarted = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(
            restarted
                .open_read()
                .unwrap()
                .query_row(
                    "SELECT applied_at FROM backend_schema_migration WHERE version = 2",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            applied_at
        );
        drop(restarted);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn compatible_legacy_external_collection_fts_is_verified_without_data_loss() {
        let app_data = temp_app_data("legacy-external-fts");
        let connection = create_published_legacy_collection_database(&app_data);
        let legacy_metadata = serde_json::json!({
            "url": "https://example.test/legacyexistingtoken",
            "selection": "legacy selection",
        })
        .to_string();
        connection
            .execute(
                "INSERT INTO collection_item(
                    id, type, content, asset_id, url_metadata, source, created_at,
                    processed_at, processed_note_id, processed_action, thumbnail,
                    browser, trigger, processed_asset_id
                 ) VALUES ('legacy-collection', 'link', 'legacyexistingtoken', NULL, ?1, 'legacy', '2000-01-01T00:00:00Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
                [&legacy_metadata],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO collection_item(
                    id, type, content, asset_id, url_metadata, source, created_at,
                    processed_at, processed_note_id, processed_action, thumbnail,
                    browser, trigger, processed_asset_id
                 ) VALUES ('legacy-second', 'text', 'secondlegacytoken', NULL, '{}', 'legacy', '2000-01-02T00:00:00Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
                [],
            )
            .unwrap();
        let legacy_rowid = connection
            .query_row(
                "SELECT rowid FROM collection_item WHERE id = 'legacy-collection'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        drop(connection);

        let first = BackendServices::initialize(&app_data).unwrap();
        let connection = first.open_write().unwrap();
        let existing_rowid = connection
            .query_row(
                "SELECT rowid FROM collection_item WHERE id = 'legacy-collection' AND content = 'legacyexistingtoken'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(existing_rowid, legacy_rowid);
        let existing =
            collection_fts_row(&connection, existing_rowid, "legacyexistingtoken").unwrap();
        assert_eq!(existing.0, "legacyexistingtoken");
        assert_eq!(existing.1, "https://example.test/legacyexistingtoken");
        assert_eq!(existing.2, "legacy selection");
        assert_eq!(
            connection
                .query_row(
                    "SELECT content, url_metadata FROM collection_item WHERE id = 'legacy-collection'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .unwrap(),
            ("legacyexistingtoken".to_string(), legacy_metadata)
        );
        let second_rowid = connection
            .query_row(
                "SELECT rowid FROM collection_item WHERE id = 'legacy-second'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert!(collection_fts_row(&connection, second_rowid, "secondlegacytoken").is_some());
        assert_collection_fts_round_trip(&connection, "legacyexternal");
        let migration_v2_applied_at = connection
            .query_row(
                "SELECT applied_at FROM backend_schema_migration WHERE version = 2",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        drop(connection);
        drop(first);

        let second = BackendServices::initialize(&app_data).unwrap();
        let connection = second.open_read().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT applied_at FROM backend_schema_migration WHERE version = 2",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            migration_v2_applied_at
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM backend_schema_migration", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            SCHEMA_VERSION as i64
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_xinfo('collection_item') WHERE name IN ('title', 'url', 'selection')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            3
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT content FROM collection_item WHERE id = 'legacy-collection'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "legacyexistingtoken"
        );

        drop(connection);
        drop(second);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn legacy_collection_v2_failure_rolls_back_schema_fts_ledger_and_user_data() {
        let app_data = temp_app_data("legacy-external-fts-rollback");
        let connection = create_published_legacy_collection_database(&app_data);
        connection
            .execute(
                "INSERT INTO collection_item(id, type, content, url_metadata, source, created_at)
                 VALUES ('rollback-sentinel', 'link', 'rollbacktoken', '{\"url\":\"https://example.test/rollbacktoken\"}', 'legacy', '2000-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        let original_fts_sql = connection
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE name = 'collection_item_search'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let original_trigger_sql = connection
            .query_row(
                "SELECT sql FROM sqlite_schema WHERE name = 'collection_item_au'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        drop(connection);

        let error = BackendServices::initialize_with_v2_test_failure(&app_data)
            .err()
            .unwrap();
        assert_eq!(error.code, "backend-test-injected");

        let connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COALESCE(MAX(version), 0) FROM backend_schema_migration",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_xinfo('collection_item') WHERE name IN ('title', 'url', 'selection')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT sql FROM sqlite_schema WHERE name = 'collection_item_search'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            original_fts_sql
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT sql FROM sqlite_schema WHERE name = 'collection_item_au'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            original_trigger_sql
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT content FROM collection_item WHERE id = 'rollback-sentinel'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "rollbacktoken"
        );
        drop(connection);

        let recovered = BackendServices::initialize(&app_data).unwrap();
        assert!(recovered.status().ready);
        drop(recovered);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn concurrent_legacy_v1_initializers_apply_collection_v2_exactly_once() {
        let app_data = temp_app_data("legacy-external-fts-concurrent");
        let connection = create_published_legacy_collection_database(&app_data);
        connection
            .execute(
                "INSERT INTO collection_item(id, type, content, url_metadata, source, created_at)
                 VALUES ('concurrent-sentinel', 'link', 'concurrentlegacytoken', '{\"url\":\"https://example.test/concurrentlegacytoken\"}', 'legacy', '2000-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(connection);

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let first_path = app_data.clone();
        let first_barrier = barrier.clone();
        let first = std::thread::spawn(move || {
            first_barrier.wait();
            BackendServices::initialize(first_path)
        });
        let second_path = app_data.clone();
        let second_barrier = barrier.clone();
        let second = std::thread::spawn(move || {
            second_barrier.wait();
            BackendServices::initialize(second_path)
        });
        barrier.wait();

        let first = first.join().unwrap().unwrap();
        let second = second.join().unwrap().unwrap();
        assert!(first.status().ready);
        assert_eq!(first.status(), second.status());
        let connection = first.open_write().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM backend_schema_migration", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            SCHEMA_VERSION as i64
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM backend_schema_migration WHERE version = 2",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        let rowid = connection
            .query_row(
                "SELECT rowid FROM collection_item WHERE id = 'concurrent-sentinel'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert!(collection_fts_row(&connection, rowid, "concurrentlegacytoken").is_some());
        assert!(verify_required_schema(&connection).is_ok());

        drop(connection);
        drop(first);
        drop(second);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    fn collection_legacy_schema_snapshot(
        connection: &Connection,
    ) -> Vec<(String, String, String, String)> {
        let mut statement = connection
            .prepare(
                "SELECT type, name, tbl_name, COALESCE(sql, '')
                 FROM sqlite_schema
                 WHERE name IN (
                    'collection_item', 'collection_item_search',
                    'collection_item_ai', 'collection_item_ad', 'collection_item_au',
                    'idx_collection_processed', 'idx_collection_type',
                    'idx_collection_source', 'idx_collection_processed_action',
                    'idx_collection_type_processed'
                 )
                 ORDER BY type, name",
            )
            .unwrap();
        statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    fn assert_published_legacy_drift_fails_closed(
        label: &str,
        expected_code: &str,
        mutate: impl FnOnce(&Connection),
    ) {
        let app_data = temp_app_data(label);
        let connection = create_published_legacy_collection_database(&app_data);
        connection
            .execute(
                "INSERT INTO collection_item(id, type, content, url_metadata, source, created_at)
                 VALUES ('drift-sentinel', 'link', 'preserve-drift-sentinel', '{\"url\":\"https://example.test/preserve\"}', 'legacy', '2000-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        mutate(&connection);
        let schema_before = collection_legacy_schema_snapshot(&connection);
        let rowid_before = connection
            .query_row(
                "SELECT rowid FROM collection_item WHERE id = 'drift-sentinel'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        let applied_at = connection
            .query_row(
                "SELECT applied_at FROM backend_schema_migration WHERE version = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        drop(connection);

        let error = BackendServices::initialize(&app_data).err().unwrap();
        assert_eq!(error.code, expected_code);

        let connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        assert_eq!(
            collection_legacy_schema_snapshot(&connection),
            schema_before
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT rowid, content FROM collection_item WHERE id = 'drift-sentinel'",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .unwrap(),
            (rowid_before, "preserve-drift-sentinel".to_string())
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT applied_at FROM backend_schema_migration WHERE version = 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            applied_at
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM backend_schema_migration", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        drop(connection);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn published_legacy_wrong_external_content_fails_closed_without_data_changes() {
        assert_published_legacy_drift_fails_closed(
            "legacy-wrong-content",
            "backend-collection-legacy-signature-mismatch",
            |connection| {
                connection
                    .execute_batch(
                        "DROP TABLE collection_item_search;
                         CREATE VIRTUAL TABLE collection_item_search USING fts5(
                            title, url, selection,
                            content='note', content_rowid='rowid', tokenize='unicode61'
                         );",
                    )
                    .unwrap();
            },
        );
    }

    #[test]
    fn published_legacy_missing_key_column_fails_closed_without_data_changes() {
        assert_published_legacy_drift_fails_closed(
            "legacy-missing-column",
            "backend-collection-legacy-signature-mismatch",
            |connection| {
                connection
                    .execute_batch(
                        "DROP TRIGGER collection_item_ai;
                         DROP TRIGGER collection_item_ad;
                         DROP TRIGGER collection_item_au;
                         ALTER TABLE collection_item DROP COLUMN url_metadata;
                         CREATE TRIGGER collection_item_ai AFTER INSERT ON collection_item BEGIN
                            INSERT INTO collection_item_search(rowid, title, url, selection)
                            VALUES (new.rowid, new.content, '', '');
                         END;
                         CREATE TRIGGER collection_item_ad AFTER DELETE ON collection_item BEGIN
                            INSERT INTO collection_item_search(collection_item_search, rowid, title, url, selection)
                            VALUES ('delete', old.rowid, old.content, '', '');
                         END;
                         CREATE TRIGGER collection_item_au AFTER UPDATE ON collection_item BEGIN
                            INSERT INTO collection_item_search(collection_item_search, rowid, title, url, selection)
                            VALUES ('delete', old.rowid, old.content, '', '');
                            INSERT INTO collection_item_search(rowid, title, url, selection)
                            VALUES (new.rowid, new.content, '', '');
                         END;",
                    )
                    .unwrap();
            },
        );
    }

    #[test]
    fn published_legacy_ordinary_table_fts_fails_closed_without_data_changes() {
        assert_published_legacy_drift_fails_closed(
            "legacy-ordinary-fts",
            "backend-collection-legacy-signature-mismatch",
            |connection| {
                connection
                    .execute_batch(
                        "DROP TABLE collection_item_search;
                         CREATE TABLE collection_item_search(title TEXT, url TEXT, selection TEXT);",
                    )
                    .unwrap();
            },
        );
    }

    #[test]
    fn published_legacy_wrong_trigger_fails_closed_without_data_changes() {
        assert_published_legacy_drift_fails_closed(
            "legacy-wrong-trigger",
            "backend-collection-legacy-signature-mismatch",
            |connection| {
                connection
                    .execute_batch(
                        "DROP TRIGGER collection_item_au;
                         CREATE TRIGGER collection_item_au AFTER UPDATE ON collection_item BEGIN
                            SELECT 1;
                         END;",
                    )
                    .unwrap();
            },
        );
    }

    #[test]
    fn ledger_v1_rejects_an_ordinary_table_impersonating_required_fts() {
        let app_data = temp_app_data("wrong-fts-type");
        let backend = BackendServices::initialize(&app_data).unwrap();
        drop(backend);
        let connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        connection
            .execute_batch(
                "DROP TABLE collection_item_search;
                 CREATE TABLE collection_item_search (
                    title TEXT, url TEXT, selection TEXT
                 );",
            )
            .unwrap();
        drop(connection);

        let error = BackendServices::initialize(&app_data).err().unwrap();
        assert_eq!(error.code, "backend-schema-object-type");
        assert!(error.message.contains("collection_item_search"));

        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn current_ledger_rejects_a_required_table_missing_critical_columns() {
        let app_data = temp_app_data("missing-table-column");
        let backend = BackendServices::initialize(&app_data).unwrap();
        drop(backend);
        let connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        connection
            .execute_batch(
                "DROP TABLE asset;
                 CREATE TABLE asset (id TEXT PRIMARY KEY);",
            )
            .unwrap();
        drop(connection);

        let error = BackendServices::initialize(&app_data).err().unwrap();
        assert_eq!(error.code, "backend-schema-column-mismatch");
        assert!(error.message.contains("asset.name"));

        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn current_ledger_rejects_a_same_name_index_with_wrong_columns() {
        let app_data = temp_app_data("wrong-index-columns");
        let backend = BackendServices::initialize(&app_data).unwrap();
        drop(backend);
        let connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        connection
            .execute_batch(
                "DROP INDEX idx_asset_content_hash;
                 CREATE INDEX idx_asset_content_hash ON asset(name);",
            )
            .unwrap();
        drop(connection);

        let error = BackendServices::initialize(&app_data).err().unwrap();
        assert_eq!(error.code, "backend-schema-index-mismatch");
        assert!(error.message.contains("idx_asset_content_hash"));

        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn current_ledger_rejects_a_same_name_index_owned_by_the_wrong_table() {
        let app_data = temp_app_data("wrong-index-owner");
        let backend = BackendServices::initialize(&app_data).unwrap();
        drop(backend);
        let connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        connection
            .execute_batch(
                "DROP INDEX idx_asset_content_hash;
                 CREATE INDEX idx_asset_content_hash ON folder(parent_id);",
            )
            .unwrap();
        drop(connection);

        let error = BackendServices::initialize(&app_data).err().unwrap();
        assert_eq!(error.code, "backend-schema-index-mismatch");
        assert!(error.message.contains("idx_asset_content_hash"));

        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn ledger_v1_rejects_a_same_name_trigger_with_wrong_behavior() {
        let app_data = temp_app_data("wrong-trigger-behavior");
        let backend = BackendServices::initialize(&app_data).unwrap();
        drop(backend);
        let connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER material_change_asset_insert;
                 CREATE TRIGGER material_change_asset_insert AFTER INSERT ON asset BEGIN
                    SELECT 1;
                 END;",
            )
            .unwrap();
        drop(connection);

        let error = BackendServices::initialize(&app_data).err().unwrap();
        assert_eq!(error.code, "backend-schema-trigger-mismatch");
        assert!(error.message.contains("material_change_asset_insert"));

        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn current_ledger_rejects_a_same_name_trigger_owned_by_the_wrong_table() {
        let app_data = temp_app_data("wrong-trigger-owner");
        let backend = BackendServices::initialize(&app_data).unwrap();
        drop(backend);
        let connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER material_change_asset_insert;
                 CREATE TRIGGER material_change_asset_insert AFTER INSERT ON folder BEGIN
                    SELECT 1;
                 END;",
            )
            .unwrap();
        drop(connection);

        let error = BackendServices::initialize(&app_data).err().unwrap();
        assert_eq!(error.code, "backend-schema-trigger-mismatch");
        assert!(error.message.contains("material_change_asset_insert"));

        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn existing_database_is_migrated_once_without_losing_user_data() {
        let app_data = temp_app_data("existing");
        std::fs::create_dir_all(&app_data).unwrap();
        let db_path = app_data.join("luckyray.db");
        let connection = Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE asset (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, original_path TEXT NOT NULL,
                    kind TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER,
                    imported_at TEXT NOT NULL
                 );
                 CREATE TABLE folder (
                    id TEXT PRIMARY KEY, scope TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0, open INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                 );
                 CREATE TABLE tag (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                 );
                 CREATE TABLE item_tag (
                    id TEXT PRIMARY KEY, item_type TEXT NOT NULL, item_id TEXT NOT NULL,
                    tag_id TEXT NOT NULL, created_at TEXT NOT NULL
                 );
                 CREATE TABLE note (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, content_json TEXT,
                    content_text TEXT, folder_id TEXT, color TEXT, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, deleted_at TEXT
                 );
                 CREATE TABLE collection_item (
                    id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
                    asset_id TEXT, url_metadata TEXT, source TEXT, created_at TEXT NOT NULL,
                    processed_at TEXT, processed_note_id TEXT, processed_action TEXT
                 );
                 CREATE TABLE collection_failure (
                    id TEXT PRIMARY KEY, source TEXT NOT NULL, payload TEXT NOT NULL,
                    error TEXT NOT NULL, created_at TEXT NOT NULL
                 );
                 INSERT INTO asset(id, name, original_path, kind, mime_type, size_bytes, imported_at)
                    VALUES ('legacy-asset', 'Legacy.png', 'C:/legacy.png', 'image', 'image/png', 7, '2025-01-01T00:00:00Z');
                 INSERT INTO note(id, title, content_text, created_at, updated_at)
                    VALUES ('legacy-note', 'Legacy note', 'preserve me', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');",
            )
            .unwrap();
        drop(connection);

        let first = BackendServices::initialize(&app_data).unwrap();
        let assets = first
            .material_catalog()
            .list_assets(&crate::materials::MaterialFilter::default())
            .unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].id, "legacy-asset");
        let first_connection = first.open_read().unwrap();
        assert!(!first_connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'note')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
        let migration_count: i64 = first_connection
            .query_row("SELECT COUNT(*) FROM backend_schema_migration", [], |row| {
                row.get(0)
            })
            .unwrap();
        let applied_at: String = first_connection
            .query_row(
                "SELECT applied_at FROM backend_schema_migration WHERE version = 3",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migration_count, SCHEMA_VERSION as i64);
        let failure_reason_present: bool = first_connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('collection_failure') WHERE name = 'reason')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(failure_reason_present);
        drop(first_connection);
        drop(first);

        let second = BackendServices::initialize(&app_data).unwrap();
        let second_connection = second.open_read().unwrap();
        assert_eq!(
            second_connection
                .query_row("SELECT COUNT(*) FROM backend_schema_migration", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            SCHEMA_VERSION as i64
        );
        assert_eq!(
            second_connection
                .query_row(
                    "SELECT applied_at FROM backend_schema_migration WHERE version = 3",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            applied_at
        );
        drop(second_connection);
        drop(second);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn schedule_v6_upgrade_is_additive_and_noop_safe() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE agent_schedule (
                    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                 );
                 CREATE TABLE agent_schedule_fire (
                    id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                 );
                 INSERT INTO agent_schedule(id,created_at,updated_at)
                 VALUES ('schedule-preserved','old','old');
                 INSERT INTO agent_schedule_fire(id,schedule_id,created_at,updated_at)
                 VALUES ('fire-preserved','schedule-preserved','old','old');",
            )
            .unwrap();
        apply_schema_v6(&connection).unwrap();
        apply_schema_v6(&connection).unwrap();
        for (table, column) in [
            ("agent_schedule", "retired_at"),
            ("agent_schedule", "completed_at"),
            ("agent_schedule_fire", "stop_requested_at"),
        ] {
            let exists = connection
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2
                     )",
                    rusqlite::params![table, column],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap();
            assert!(exists, "missing additive {table}.{column}");
        }
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM agent_schedule", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1,
            "upgrade and no-op must preserve schedule data"
        );
    }

    #[test]
    fn conversation_mode_v7_upgrade_is_additive_defaulted_and_noop_safe() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE ai_conversation (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                 );
                 INSERT INTO ai_conversation(id,title,created_at,updated_at)
                 VALUES ('conversation-preserved','Preserved','old','old');",
            )
            .unwrap();
        apply_schema_v7(&connection).unwrap();
        apply_schema_v7(&connection).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT agent_mode FROM ai_conversation WHERE id='conversation-preserved'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "standard"
        );
        assert!(connection
            .execute(
                "UPDATE ai_conversation SET agent_mode='project-task' WHERE id='conversation-preserved'",
                [],
            )
            .is_ok());
        assert!(connection
            .execute(
                "UPDATE ai_conversation SET agent_mode='forged' WHERE id='conversation-preserved'",
                [],
            )
            .is_err());
    }

    #[test]
    fn schema_v7_to_v8_preserves_legacy_project_task_as_uncategorized_and_restart_is_noop() {
        let app_data = temp_app_data("v7-to-v8-project");
        let connection = create_schema_v7_database(&app_data);
        drop(connection);

        let first = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(first.status().schema_version, SCHEMA_VERSION);
        let connection = first.open_read().unwrap();
        for column in ["project_id", "pinned_at", "archived_at"] {
            assert!(connection
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM pragma_table_info('ai_conversation') WHERE name=?1
                     )",
                    [column],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap());
        }
        let lifecycle: (Option<String>, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT project_id,pinned_at,archived_at
                 FROM ai_conversation WHERE id='legacy-project-task'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(lifecycle, (None, None, None));
        assert_eq!(
            connection
                .query_row(
                    "SELECT name FROM backend_schema_migration WHERE version=8",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "agent-project-workspace-binding-and-conversation-lifecycle"
        );
        let applied_at: String = connection
            .query_row(
                "SELECT applied_at FROM backend_schema_migration WHERE version=8",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);
        drop(first);

        let second = BackendServices::initialize(&app_data).unwrap();
        let connection = second.open_read().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT applied_at FROM backend_schema_migration WHERE version=8",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            applied_at
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM backend_schema_migration", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            SCHEMA_VERSION as i64
        );
        let summary = second
            .agent_runs()
            .list_conversations(10)
            .unwrap()
            .into_iter()
            .find(|item| item.id == "legacy-project-task")
            .unwrap();
        assert_eq!(summary.agent_mode, "project-task");
        assert_eq!(summary.project_id, None);
        drop(connection);
        drop(second);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn concurrent_cold_start_returns_one_complete_schema_to_both_callers() {
        let app_data = temp_app_data("concurrent");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let first_path = app_data.clone();
        let first_barrier = barrier.clone();
        let first = std::thread::spawn(move || {
            first_barrier.wait();
            BackendServices::initialize(first_path)
        });
        let second_path = app_data.clone();
        let second_barrier = barrier.clone();
        let second = std::thread::spawn(move || {
            second_barrier.wait();
            BackendServices::initialize(second_path)
        });
        barrier.wait();

        let first = first.join().unwrap().unwrap();
        let second = second.join().unwrap().unwrap();
        assert_eq!(first.status(), second.status());
        assert!(first.material_catalog().list_folders().is_ok());
        assert!(second.material_catalog().list_folders().is_ok());
        let connection = first.open_write().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM backend_schema_migration", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            SCHEMA_VERSION as i64
        );
        assert!(verify_required_schema(&connection).is_ok());
        for (object_type, name) in [
            ("table", "agent_project"),
            ("table", "agent_project_knowledge_binding"),
            ("index", "idx_agent_project_knowledge_target"),
            ("trigger", "agent_project_knowledge_insert"),
            ("trigger", "agent_project_knowledge_update"),
            ("trigger", "agent_project_knowledge_project_delete"),
            ("trigger", "ai_conversation_project_insert"),
            ("trigger", "ai_conversation_project_update"),
        ] {
            assert!(
                connection
                    .query_row(
                        "SELECT EXISTS(
                             SELECT 1 FROM sqlite_schema WHERE type=?1 AND name=?2
                         )",
                        rusqlite::params![object_type, name],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap(),
                "concurrent cold start did not publish {object_type} {name}"
            );
        }
        drop(connection);
        drop(first);
        drop(second);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn bootstrap_failures_are_stable_and_never_publish_ready() {
        let file_instead_of_directory = temp_app_data("not-a-directory");
        std::fs::write(&file_instead_of_directory, b"not a directory").unwrap();
        let path_error = BackendServices::initialize(&file_instead_of_directory)
            .err()
            .unwrap();
        assert_eq!(path_error.code, "backend-app-data-unavailable");
        std::fs::remove_file(file_instead_of_directory).unwrap();

        let corrupt_app_data = temp_app_data("corrupt");
        std::fs::create_dir_all(&corrupt_app_data).unwrap();
        std::fs::write(
            corrupt_app_data.join("luckyray.db"),
            b"not a sqlite database",
        )
        .unwrap();
        let corrupt_error = BackendServices::initialize(&corrupt_app_data)
            .err()
            .unwrap();
        assert_eq!(corrupt_error.code, "backend-database-corrupt");
        std::fs::remove_dir_all(corrupt_app_data).unwrap();

        let injected_app_data = temp_app_data("injected");
        let injected = BackendServices::initialize_with_test_failure(&injected_app_data)
            .err()
            .unwrap();
        assert_eq!(injected.code, "backend-test-injected");
        let connection = Connection::open(injected_app_data.join("luckyray.db")).unwrap();
        let application_tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('asset', 'note', 'backend_schema_migration')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(application_tables, 0);
        drop(connection);
        let recovered = BackendServices::initialize(&injected_app_data).unwrap();
        assert!(recovered.status().ready);
        drop(recovered);
        std::fs::remove_dir_all(injected_app_data).unwrap();
    }

    #[test]
    fn d1_fresh_backend_publishes_project_schema_v8_and_conversation_binding_columns() {
        let app_data = temp_app_data("d1-fresh-project-schema");
        let backend = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(backend.status().schema_version, SCHEMA_VERSION);
        let connection = backend.open_read().unwrap();
        for (table, column) in [
            ("agent_project", "primary_workspace_grant_id"),
            ("ai_conversation", "project_id"),
            ("ai_conversation", "pinned_at"),
            ("ai_conversation", "archived_at"),
        ] {
            assert!(
                connection
                    .query_row(
                        "SELECT EXISTS(
                             SELECT 1 FROM sqlite_schema
                             WHERE type='table' AND name=?1
                         ) AND EXISTS(
                             SELECT 1 FROM pragma_table_info(?1) WHERE name=?2
                         )",
                        rusqlite::params![table, column],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap(),
                "D1 schema object {table}.{column} is missing"
            );
        }
        drop(connection);
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn d3_fresh_backend_publishes_project_knowledge_binding_schema_v9() {
        let app_data = temp_app_data("d3-fresh-project-knowledge-schema");
        let backend = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(backend.status().schema_version, SCHEMA_VERSION);
        let connection = backend.open_read().unwrap();
        for column in [
            "project_id",
            "knowledge_target_id",
            "target_identity_digest",
            "target_label",
            "created_at",
        ] {
            assert!(
                connection
                    .query_row(
                        "SELECT EXISTS(
                             SELECT 1 FROM pragma_table_info('agent_project_knowledge_binding')
                             WHERE name=?1
                         )",
                        [column],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap(),
                "D3 project Knowledge binding column {column} is missing"
            );
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('agent_project_knowledge_binding')
                     WHERE pk > 0",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2,
            "project and Knowledge target form the durable composite identity"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_foreign_key_list('agent_project_knowledge_binding')
                     WHERE \"table\"='agent_project' AND \"from\"='project_id'
                       AND on_delete='CASCADE'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1,
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT name FROM backend_schema_migration WHERE version=9",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "agent-project-knowledge-authorization"
        );
        drop(connection);
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn schema_v8_to_v9_is_additive_default_off_and_restart_noop() {
        let app_data = temp_app_data("v8-to-v9-project-knowledge");
        let workspace_root = app_data.join("project-root");
        std::fs::create_dir_all(&workspace_root).unwrap();
        let initial = BackendServices::initialize(&app_data).unwrap();
        let grant = initial
            .workspace()
            .add(&workspace_root, "Project Root")
            .unwrap();
        let project = initial
            .projects()
            .create("Preserved Project", &grant.id)
            .unwrap();
        drop(initial);

        let connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER IF EXISTS ai_message_action_truth_insert_guard;
                 DROP TRIGGER IF EXISTS ai_message_action_truth_immutable;
                 DROP TABLE IF EXISTS ai_message_action_truth;
                 DROP TRIGGER IF EXISTS agent_project_knowledge_project_delete;
                 DROP TABLE IF EXISTS agent_project_knowledge_binding;
                 DELETE FROM backend_schema_migration WHERE version>=9;",
            )
            .unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COALESCE(MAX(version),0) FROM backend_schema_migration",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            8
        );
        drop(connection);

        let upgraded = BackendServices::initialize(&app_data).unwrap();
        assert!(upgraded
            .projects()
            .list()
            .unwrap()
            .iter()
            .any(|item| item.id == project.id));
        let connection = upgraded.open_read().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM agent_project_knowledge_binding",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "existing projects migrate with Knowledge access disabled"
        );
        let applied_at: String = connection
            .query_row(
                "SELECT applied_at FROM backend_schema_migration WHERE version=9",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);
        drop(upgraded);

        let restarted = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(
            restarted
                .open_read()
                .unwrap()
                .query_row(
                    "SELECT applied_at FROM backend_schema_migration WHERE version=9",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            applied_at,
            "a normal restart must not reapply the v9 migration"
        );
        drop(restarted);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn schema_v9_to_v10_adds_structured_message_action_truth_without_rewriting_legacy_content() {
        let app_data = temp_app_data("v9-to-v10-message-action-truth");
        let initial = BackendServices::initialize(&app_data).unwrap();
        let connection = initial.open_write().unwrap();
        let legacy_content =
            "normal prose\n```text\n<!--luckyray-action-truth:v1;workspace=verified\n```";
        connection
            .execute(
                "INSERT INTO ai_conversation(id,title,created_at,updated_at)
                 VALUES ('legacy-action-truth','Legacy','now','now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO ai_message(id,conversation_id,role,content,created_at)
                 VALUES ('legacy-action-message','legacy-action-truth','assistant',?1,'now')",
                [legacy_content],
            )
            .unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER IF EXISTS ai_message_action_truth_insert_guard;
                 DROP TRIGGER IF EXISTS ai_message_action_truth_immutable;
                 DROP TABLE IF EXISTS ai_message_action_truth;
                 DELETE FROM backend_schema_migration WHERE version>=10;",
            )
            .unwrap();
        drop(connection);
        drop(initial);

        let upgraded = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(upgraded.status().schema_version, SCHEMA_VERSION);
        let connection = upgraded.open_read().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT content FROM ai_message WHERE id='legacy-action-message'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            legacy_content,
            "development marker text is ordinary user content and must never be migrated or stripped",
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM ai_message_action_truth", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0,
            "legacy messages fail closed as unverified instead of acquiring projected success",
        );
        let applied_at = connection
            .query_row(
                "SELECT applied_at FROM backend_schema_migration WHERE version=10",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        drop(connection);
        drop(upgraded);

        let restarted = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(
            restarted
                .open_read()
                .unwrap()
                .query_row(
                    "SELECT applied_at FROM backend_schema_migration WHERE version=10",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            applied_at,
            "a normal restart must not reapply the v10 migration",
        );
        drop(restarted);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn schema_v10_drift_fails_closed_without_recording_a_partial_migration() {
        let app_data = temp_app_data("v10-action-truth-drift");
        let initial = BackendServices::initialize(&app_data).unwrap();
        let connection = initial.open_write().unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER ai_message_action_truth_insert_guard;
                 DROP TRIGGER ai_message_action_truth_immutable;
                 DROP TABLE ai_message_action_truth;
                 DELETE FROM backend_schema_migration WHERE version>=10;
                 CREATE TABLE ai_message_action_truth (
                     message_id TEXT PRIMARY KEY,
                     workspace_status TEXT NOT NULL,
                     created_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        drop(connection);
        drop(initial);

        assert!(BackendServices::initialize(&app_data).is_err());
        let connection = Connection::open(app_data.join("luckyray.db")).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COALESCE(MAX(version),0) FROM backend_schema_migration",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            9,
            "a failed v10 schema gate must not publish a migration record",
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('ai_message_action_truth')
                     WHERE name='execution_status'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0,
            "the pre-existing drifted table is not silently rewritten",
        );
        drop(connection);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn schema_v10_to_v11_adds_typed_run_stop_cause_and_restart_is_noop() {
        let app_data = temp_app_data("v10-to-v11-terminal-cause");
        let initial = BackendServices::initialize(&app_data).unwrap();
        let connection = initial.open_write().unwrap();
        connection
            .execute_batch(
                "ALTER TABLE ai_run DROP COLUMN stop_cause;
                 DELETE FROM backend_schema_migration WHERE version>=11;",
            )
            .unwrap();
        drop(connection);
        drop(initial);

        let upgraded = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(upgraded.status().schema_version, SCHEMA_VERSION);
        let connection = upgraded.open_read().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('ai_run') WHERE name='stop_cause'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        let applied_at: String = connection
            .query_row(
                "SELECT applied_at FROM backend_schema_migration WHERE version=11",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);
        drop(upgraded);

        let restarted = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(
            restarted
                .open_read()
                .unwrap()
                .query_row(
                    "SELECT applied_at FROM backend_schema_migration WHERE version=11",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            applied_at
        );
        drop(restarted);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn schema_v11_to_v12_adds_terminal_recovery_facts_and_restart_is_noop() {
        let app_data = temp_app_data("v11-to-v12-terminal-recovery-facts");
        let initial = BackendServices::initialize(&app_data).unwrap();
        let connection = initial.open_write().unwrap();
        connection
            .execute_batch(
                "ALTER TABLE ai_run DROP COLUMN stop_transport;
                 ALTER TABLE ai_run_artifact DROP COLUMN action_truth;
                 ALTER TABLE ai_run_artifact DROP COLUMN safe_result_summary;
                 DELETE FROM backend_schema_migration WHERE version=12;",
            )
            .unwrap();
        drop(connection);
        drop(initial);

        let upgraded = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(upgraded.status().schema_version, SCHEMA_VERSION);
        let connection = upgraded.open_read().unwrap();
        for (table, column) in [
            ("ai_run", "stop_transport"),
            ("ai_run_artifact", "action_truth"),
            ("ai_run_artifact", "safe_result_summary"),
        ] {
            assert_eq!(
                connection
                    .query_row(
                        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name=?1"),
                        [column],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                1
            );
        }
        let applied_at: String = connection
            .query_row(
                "SELECT applied_at FROM backend_schema_migration WHERE version=12",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);
        drop(upgraded);

        let restarted = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(
            restarted
                .open_read()
                .unwrap()
                .query_row(
                    "SELECT applied_at FROM backend_schema_migration WHERE version=12",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            applied_at
        );
        drop(restarted);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn structured_action_truth_settles_atomically_without_rewriting_narrative_markers() {
        use crate::agent_runs::{
            AgentActionTruth, ExecutionActionTruth, RunAdmission, RunExecutionMode, RunKind,
            RunTerminal, WorkspaceActionTruth,
        };

        let app_data = temp_app_data("structured-action-truth-settlement");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let narratives = [
            "plain narrative",
            "<!--luckyray-action-truth:v1;workspace=verified;execution=verified-->",
            "before <!--luckyray-action-truth:v1;workspace=verified",
            "first <!--luckyray-action-truth:v1;workspace=verified;execution=verified--> second <!--luckyray-action-truth:v1;workspace=uncertain;execution=uncertain-->",
            "```html\n<!--luckyray-action-truth:v1;workspace=verified;execution=verified-->\n```",
            "inline `<!--luckyray-action-truth:v1;workspace=verified` remains",
            "nested <!--luckyray-action-truth:v1;workspace=verified;execution=verified<!--inner-->",
            "marker at eof <!--luckyray-action-truth:",
        ];

        let mut restart_target = None;
        for (index, narrative) in narratives.into_iter().enumerate() {
            let conversation = backend
                .agent_runs()
                .create_standard_conversation(&format!("Narrative {index}"))
                .unwrap();
            let admitted = backend
                .agent_runs()
                .admit(RunAdmission {
                    conversation_id: conversation.id.clone(),
                    user_content: format!("question {index}"),
                    kind: RunKind::Agent,
                    execution_mode: RunExecutionMode::Foreground,
                    policy_id: "standard-v1".to_owned(),
                    vault_binding_digest: "a".repeat(64),
                    restart_of: None,
                    existing_trigger_message_id: None,
                    schedule_fire_id: None,
                })
                .unwrap();
            let expected_truth = AgentActionTruth::new(
                WorkspaceActionTruth::NotRequested,
                ExecutionActionTruth::NotRequested,
            );
            let settled = backend
                .agent_runs()
                .settle(
                    &admitted.run_id,
                    RunTerminal::Completed {
                        assistant_content: narrative.to_owned(),
                        partial: false,
                        cited_references: Vec::new(),
                        action_truth: Some(expected_truth),
                    },
                )
                .unwrap();
            let result_message_id = settled.result_message_id.clone().unwrap();
            let message = backend
                .agent_runs()
                .list_messages(&conversation.id)
                .unwrap()
                .into_iter()
                .find(|message| message.id == result_message_id)
                .unwrap();
            assert_eq!(message.content, narrative, "case {index} changed content");
            assert_eq!(message.action_truth, Some(expected_truth));
            if index == 0 {
                restart_target = Some((
                    conversation.id.clone(),
                    result_message_id.clone(),
                    narrative.to_owned(),
                ));
            }

            let duplicate = backend
                .agent_runs()
                .settle(
                    &admitted.run_id,
                    RunTerminal::Completed {
                        assistant_content: "must not replace content".to_owned(),
                        partial: false,
                        cited_references: Vec::new(),
                        action_truth: Some(AgentActionTruth::new(
                            WorkspaceActionTruth::Verified,
                            ExecutionActionTruth::Verified,
                        )),
                    },
                )
                .unwrap();
            assert_eq!(
                duplicate.result_message_id.as_deref(),
                Some(result_message_id.as_str())
            );
            let messages = backend
                .agent_runs()
                .list_messages(&conversation.id)
                .unwrap();
            assert_eq!(
                messages
                    .iter()
                    .filter(|message| message.role == "assistant")
                    .count(),
                1,
            );
            let message = messages
                .into_iter()
                .find(|message| message.id == result_message_id)
                .unwrap();
            assert_eq!(message.content, narrative);
            assert_eq!(message.action_truth, Some(expected_truth));
        }

        let unicode = format!("{}终", "😀".repeat((128 * 1024 - 3) / 4));
        assert!(unicode.len() <= 128 * 1024);
        assert!(unicode.is_char_boundary(unicode.len()));
        let conversation = backend
            .agent_runs()
            .create_standard_conversation("Unicode boundary")
            .unwrap();
        let admitted = backend
            .agent_runs()
            .admit(RunAdmission {
                conversation_id: conversation.id.clone(),
                user_content: "unicode".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "b".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        backend
            .agent_runs()
            .settle(
                &admitted.run_id,
                RunTerminal::Completed {
                    assistant_content: unicode.clone(),
                    partial: false,
                    cited_references: Vec::new(),
                    action_truth: Some(AgentActionTruth::new(
                        WorkspaceActionTruth::NotRequested,
                        ExecutionActionTruth::NotRequested,
                    )),
                },
            )
            .unwrap();
        assert_eq!(
            backend
                .agent_runs()
                .list_messages(&conversation.id)
                .unwrap()
                .last()
                .unwrap()
                .content,
            unicode,
        );

        drop(backend);
        let restarted = BackendServices::initialize(&app_data).unwrap();
        let (conversation_id, message_id, narrative) = restart_target.unwrap();
        let message = restarted
            .agent_runs()
            .list_messages(&conversation_id)
            .unwrap()
            .into_iter()
            .find(|message| message.id == message_id)
            .unwrap();
        assert_eq!(message.content, narrative);
        assert_eq!(
            message.action_truth,
            Some(AgentActionTruth::new(
                WorkspaceActionTruth::NotRequested,
                ExecutionActionTruth::NotRequested,
            )),
            "restart/remount reads the same structured truth without parsing content",
        );
        drop(restarted);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn invalid_stored_action_truth_tuple_fails_closed_on_message_query() {
        use crate::agent_runs::{
            AgentActionTruth, ExecutionActionTruth, RunAdmission, RunExecutionMode, RunKind,
            RunTerminal, WorkspaceActionTruth,
        };

        let app_data = temp_app_data("structured-action-truth-invalid-query");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let conversation = backend
            .agent_runs()
            .create_standard_conversation("Invalid tuple")
            .unwrap();
        let admitted = backend
            .agent_runs()
            .admit(RunAdmission {
                conversation_id: conversation.id.clone(),
                user_content: "invalid tuple".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "d".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        let settled = backend
            .agent_runs()
            .settle(
                &admitted.run_id,
                RunTerminal::Completed {
                    assistant_content: "safe narrative".to_owned(),
                    partial: false,
                    cited_references: Vec::new(),
                    action_truth: Some(AgentActionTruth::new(
                        WorkspaceActionTruth::NotRequested,
                        ExecutionActionTruth::NotRequested,
                    )),
                },
            )
            .unwrap();
        let message_id = settled.result_message_id.unwrap();
        let connection = backend.open_write().unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER ai_message_action_truth_immutable;
                 PRAGMA ignore_check_constraints=ON;",
            )
            .unwrap();
        connection
            .execute(
                "UPDATE ai_message_action_truth
                 SET workspace_status='forged-success',execution_status='passed'
                 WHERE message_id=?1",
                [&message_id],
            )
            .unwrap();
        drop(connection);
        let message = backend
            .agent_runs()
            .list_messages(&conversation.id)
            .unwrap()
            .into_iter()
            .find(|message| message.id == message_id)
            .unwrap();
        assert_eq!(message.content, "safe narrative");
        assert_eq!(
            message.action_truth, None,
            "an invalid durable tuple fails closed instead of projecting success",
        );

        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn message_and_action_truth_rollback_together_when_projection_insert_fails() {
        use crate::agent_runs::{
            AgentActionTruth, ExecutionActionTruth, RunAdmission, RunExecutionMode, RunKind,
            RunTerminal, WorkspaceActionTruth,
        };

        let app_data = temp_app_data("structured-action-truth-rollback");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let conversation = backend
            .agent_runs()
            .create_standard_conversation("Atomic truth")
            .unwrap();
        let admitted = backend
            .agent_runs()
            .admit(RunAdmission {
                conversation_id: conversation.id.clone(),
                user_content: "atomic".to_owned(),
                kind: RunKind::Agent,
                execution_mode: RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "c".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        backend
            .open_write()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER test_action_truth_abort
                 BEFORE INSERT ON ai_message_action_truth
                 BEGIN SELECT RAISE(ABORT, 'test-action-truth-abort'); END;",
            )
            .unwrap();
        let terminal = RunTerminal::Completed {
            assistant_content: "narrative survives only with truth".to_owned(),
            partial: false,
            cited_references: Vec::new(),
            action_truth: Some(AgentActionTruth::new(
                WorkspaceActionTruth::NotRequested,
                ExecutionActionTruth::NotRequested,
            )),
        };
        assert_eq!(
            backend
                .agent_runs()
                .settle(&admitted.run_id, terminal.clone())
                .unwrap_err()
                .code,
            "agent-run-ledger-unavailable",
        );
        assert!(backend
            .agent_runs()
            .get(&admitted.run_id)
            .unwrap()
            .result_message_id
            .is_none());
        assert_eq!(
            backend
                .agent_runs()
                .list_messages(&conversation.id)
                .unwrap()
                .iter()
                .filter(|message| message.role == "assistant")
                .count(),
            0,
        );
        backend
            .open_write()
            .unwrap()
            .execute_batch("DROP TRIGGER test_action_truth_abort;")
            .unwrap();
        backend
            .agent_runs()
            .settle(&admitted.run_id, terminal)
            .unwrap();
        let assistant = backend
            .agent_runs()
            .list_messages(&conversation.id)
            .unwrap()
            .into_iter()
            .find(|message| message.role == "assistant")
            .unwrap();
        assert_eq!(assistant.content, "narrative survives only with truth");
        assert!(assistant.action_truth.is_some());

        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn d1_project_create_binds_one_existing_workspace_grant_and_lists_safe_metadata() {
        let app_data = temp_app_data("d1-project-create");
        let workspace_root = app_data.join("project-root");
        std::fs::create_dir_all(&workspace_root).unwrap();
        let backend = BackendServices::initialize(&app_data).unwrap();
        let grant = backend
            .workspace()
            .add(&workspace_root, "Project Root")
            .unwrap();
        let project = backend
            .projects()
            .create("Project Alpha", &grant.id)
            .unwrap();
        assert_eq!(project.title, "Project Alpha");
        assert_eq!(project.primary_workspace_label, "Project Root");
        assert_eq!(project.primary_workspace_root_name, "project-root");
        assert_eq!(project.sort_order, 0);
        let listed = backend.projects().list().unwrap();
        assert_eq!(listed, vec![project]);
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn d1_project_update_reorder_and_delete_are_backend_atomic_and_non_empty_delete_is_blocked() {
        let app_data = temp_app_data("d1-project-crud");
        let workspace_a = app_data.join("project-a");
        let workspace_b = app_data.join("project-b");
        std::fs::create_dir_all(&workspace_a).unwrap();
        std::fs::create_dir_all(&workspace_b).unwrap();
        let backend = BackendServices::initialize(&app_data).unwrap();
        let grant_a = backend
            .workspace()
            .add(&workspace_a, "Workspace A")
            .unwrap();
        let grant_b = backend
            .workspace()
            .add(&workspace_b, "Workspace B")
            .unwrap();
        let project_a = backend.projects().create("Project A", &grant_a.id).unwrap();
        let project_b = backend.projects().create("Project B", &grant_b.id).unwrap();
        let updated = backend
            .projects()
            .update(&project_a.id, "Project A renamed", Some(&grant_b.id))
            .unwrap();
        assert_eq!(updated.title, "Project A renamed");
        assert_eq!(updated.primary_workspace_label, "Workspace B");
        let reordered = backend
            .projects()
            .reorder(&[project_b.id.clone(), project_a.id.clone()])
            .unwrap();
        assert_eq!(
            reordered
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec![project_b.id.as_str(), project_a.id.as_str()]
        );
        let conversation = backend
            .agent_runs()
            .create_project_conversation_in_project("Non-empty", &project_a.id)
            .unwrap();
        assert_eq!(
            backend.projects().delete(&project_a.id).unwrap_err().code,
            "agent-project-not-empty"
        );
        backend.delete_conversation(&conversation.id).unwrap();
        backend.projects().delete(&project_a.id).unwrap();
        assert_eq!(
            backend.projects().get(&project_a.id).unwrap_err().code,
            "agent-project-not-found"
        );
        assert!(backend.projects().get(&project_b.id).is_ok());
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn d2_p2_project_update_remove_race_rejects_stale_grant_without_mutating_binding() {
        let app_data = temp_app_data("d2-p2-project-update-remove-race");
        let workspace_a = app_data.join("project-a");
        let workspace_b = app_data.join("project-b");
        std::fs::create_dir_all(&workspace_a).unwrap();
        std::fs::create_dir_all(&workspace_b).unwrap();
        let backend = BackendServices::initialize(&app_data).unwrap();
        let grant_a = backend
            .workspace()
            .add(&workspace_a, "Workspace A")
            .unwrap();
        let grant_b = backend
            .workspace()
            .add(&workspace_b, "Workspace B")
            .unwrap();
        let project = backend.projects().create("Project A", &grant_a.id).unwrap();

        let mut writer = Connection::open(backend.db_path()).unwrap();
        writer
            .busy_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let transaction = writer
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        transaction
            .execute(
                "DELETE FROM agent_workspace_grant WHERE id=?1",
                [&grant_b.id],
            )
            .unwrap();

        let service = backend.projects().clone();
        let project_id = project.id.clone();
        let grant_b_id = grant_b.id.clone();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let updater = std::thread::spawn(move || {
            result_tx
                .send(service.update(&project_id, "Project A raced", Some(&grant_b_id)))
                .unwrap();
        });
        match result_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Ok(result) => panic!("project update crossed the grant removal lock: {result:?}"),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                panic!("project update worker exited before the grant removal committed")
            }
        }
        transaction.commit().unwrap();

        let result = result_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let error = result.unwrap_err();
        assert_eq!(error.code, "workspace-grant-not-found");
        assert!(!error.message.contains("project-b"));
        assert!(!error.message.contains("SELECT"));
        updater.join().unwrap();

        let unchanged = backend.projects().get(&project.id).unwrap();
        assert_eq!(unchanged.title, "Project A");
        assert_eq!(unchanged.primary_workspace_label, "Workspace A");
        drop(writer);
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn d2_p2_workspace_remove_rejects_a_project_bound_grant_without_mutating_binding() {
        let app_data = temp_app_data("d2-p2-bound-grant-remove");
        let workspace_root = app_data.join("project-root");
        std::fs::create_dir_all(&workspace_root).unwrap();
        let backend = BackendServices::initialize(&app_data).unwrap();
        let grant = backend
            .workspace()
            .add(&workspace_root, "Project Workspace")
            .unwrap();
        let project = backend
            .projects()
            .create("Bound Project", &grant.id)
            .unwrap();

        let error = backend.workspace().remove(&grant.id).unwrap_err();
        assert_eq!(error.code, "workspace-grant-project-bound");
        assert!(!error.message.contains("project-root"));
        assert!(!error.message.contains("SELECT"));
        assert!(backend
            .workspace()
            .list()
            .unwrap()
            .iter()
            .any(|item| item.id == grant.id && item.enabled));
        assert_eq!(
            backend
                .projects()
                .get(&project.id)
                .unwrap()
                .primary_workspace_label,
            "Project Workspace"
        );

        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn d2_p2_project_update_disabled_missing_or_replaced_grant_keeps_original_binding() {
        for case in ["disabled", "missing", "replaced"] {
            let app_data = temp_app_data(&format!("d2-p2-project-update-{case}"));
            let workspace_a = app_data.join("project-a");
            let workspace_b = app_data.join("project-b");
            std::fs::create_dir_all(&workspace_a).unwrap();
            std::fs::create_dir_all(&workspace_b).unwrap();
            let backend = BackendServices::initialize(&app_data).unwrap();
            let grant_a = backend
                .workspace()
                .add(&workspace_a, "Workspace A")
                .unwrap();
            let grant_b = backend
                .workspace()
                .add(&workspace_b, "Workspace B")
                .unwrap();
            let project = backend
                .projects()
                .create("Original Project", &grant_a.id)
                .unwrap();
            let expected_error = match case {
                "disabled" => {
                    backend.workspace().set_enabled(&grant_b.id, false).unwrap();
                    "workspace-grant-not-found"
                }
                "missing" => {
                    backend.workspace().remove(&grant_b.id).unwrap();
                    "workspace-grant-not-found"
                }
                "replaced" => {
                    std::fs::remove_dir_all(&workspace_b).unwrap();
                    std::fs::create_dir_all(&workspace_b).unwrap();
                    "workspace-grant-changed"
                }
                _ => unreachable!("test case is fixed"),
            };
            let error = backend
                .projects()
                .update(&project.id, "Must not apply", Some(&grant_b.id))
                .unwrap_err();
            assert_eq!(error.code, expected_error, "failed update case: {case}");
            assert!(!error.message.contains("project-b"));
            assert!(!error.message.contains("SELECT"));
            let unchanged = backend.projects().get(&project.id).unwrap();
            assert_eq!(unchanged.title, "Original Project");
            assert_eq!(unchanged.primary_workspace_label, "Workspace A");
            drop(backend);
            std::fs::remove_dir_all(app_data).unwrap();
        }
    }

    #[test]
    fn d2_project_create_with_conversation_returns_one_atomic_backend_bound_result() {
        let app_data = temp_app_data("d2-project-create-with-conversation");
        let workspace_root = app_data.join("project-root");
        std::fs::create_dir_all(&workspace_root).unwrap();
        let backend = BackendServices::initialize(&app_data).unwrap();
        let grant = backend
            .workspace()
            .add(&workspace_root, "Project Workspace")
            .unwrap();

        let created = backend
            .projects()
            .create_with_conversation("Atomic Project", &grant.id)
            .unwrap();
        assert_eq!(created.project.title, "Atomic Project");
        assert_eq!(created.project.primary_workspace_label, "Project Workspace");
        assert_eq!(created.conversation.agent_mode, "project-task");
        assert_eq!(
            created.conversation.project_id.as_deref(),
            Some(created.project.id.as_str())
        );
        let listed = backend.agent_runs().list_conversations(20).unwrap();
        assert!(listed.iter().any(|item| item.id == created.conversation.id));
        assert_eq!(
            backend
                .projects()
                .workspace_grant_for_conversation(&created.conversation.id)
                .unwrap(),
            Some(grant.id.clone())
        );

        let project_count = backend.projects().list().unwrap().len();
        let conversation_count = backend.agent_runs().list_conversations(20).unwrap().len();
        let error = backend
            .projects()
            .create_with_conversation("Should Roll Back", "workspace-grant-missing")
            .unwrap_err();
        assert_eq!(error.code, "workspace-grant-not-found");
        assert!(!error.message.contains("workspace-grant-missing"));
        assert_eq!(backend.projects().list().unwrap().len(), project_count);
        assert_eq!(
            backend.agent_runs().list_conversations(20).unwrap().len(),
            conversation_count
        );

        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn d1_project_conversation_creation_persists_backend_project_binding() {
        let app_data = temp_app_data("d1-project-conversation");
        let workspace_root = app_data.join("project-root");
        std::fs::create_dir_all(&workspace_root).unwrap();
        let backend = BackendServices::initialize(&app_data).unwrap();
        let grant = backend
            .workspace()
            .add(&workspace_root, "Project Root")
            .unwrap();
        let project = backend
            .projects()
            .create("Project Alpha", &grant.id)
            .unwrap();
        let conversation = backend
            .agent_runs()
            .create_project_conversation_in_project("Bound conversation", &project.id)
            .unwrap();
        assert_eq!(conversation.agent_mode, "project-task");
        assert_eq!(
            conversation.project_id.as_deref(),
            Some(project.id.as_str())
        );
        let listed = backend.agent_runs().list_conversations(10).unwrap();
        let listed_conversation = listed
            .into_iter()
            .find(|item| item.id == conversation.id)
            .unwrap();
        assert_eq!(listed_conversation.project_id, conversation.project_id);
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn d1_forged_project_id_and_standard_project_binding_are_rejected_by_backend_schema() {
        let app_data = temp_app_data("d1-forged-project-id");
        let workspace_root = app_data.join("project-root");
        std::fs::create_dir_all(&workspace_root).unwrap();
        let backend = BackendServices::initialize(&app_data).unwrap();
        let grant = backend
            .workspace()
            .add(&workspace_root, "Project Root")
            .unwrap();
        let project = backend
            .projects()
            .create("Project Alpha", &grant.id)
            .unwrap();
        let forged = backend
            .agent_runs()
            .create_project_conversation_in_project("Forged", "project-forged");
        assert_eq!(forged.unwrap_err().code, "agent-project-not-found");
        let standard_insert = backend.open_write().unwrap().execute(
            "INSERT INTO ai_conversation(
                 id,title,created_at,updated_at,agent_mode,project_id
             ) VALUES ('forged-standard','Forged','now','now','standard',?1)",
            [&project.id],
        );
        assert!(standard_insert.is_err());
        assert!(!backend
            .agent_runs()
            .list_conversations(10)
            .unwrap()
            .iter()
            .any(|item| item.id == "forged-standard"));
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn d1_ordinary_conversation_has_no_project_binding_authority() {
        let app_data = temp_app_data("d1-ordinary-conversation");
        let workspace_root = app_data.join("ordinary-root");
        std::fs::create_dir_all(&workspace_root).unwrap();
        let backend = BackendServices::initialize(&app_data).unwrap();
        let grant = backend
            .workspace()
            .add(&workspace_root, "Ordinary Workspace")
            .unwrap();
        let project = backend
            .projects()
            .create("Bound Project", &grant.id)
            .unwrap();
        backend
            .open_write()
            .unwrap()
            .execute(
                "INSERT INTO ai_conversation(
                     id,title,created_at,updated_at,agent_mode
                 ) VALUES ('ordinary-conversation','Ordinary','now','now','standard')",
                [],
            )
            .unwrap();
        let summary = backend
            .agent_runs()
            .list_conversations(10)
            .unwrap()
            .into_iter()
            .find(|item| item.id == "ordinary-conversation")
            .unwrap();
        assert_eq!(summary.agent_mode, "standard");
        assert_eq!(summary.project_id, None);
        assert_eq!(
            backend
                .projects()
                .workspace_grant_for_conversation("ordinary-conversation")
                .unwrap_err()
                .code,
            "agent-project-conversation-not-found"
        );
        assert!(backend.projects().get(&project.id).is_ok());
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn d2_standard_conversation_creation_is_backend_unbound_and_not_project_task() {
        let app_data = temp_app_data("d2-standard-conversation");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let conversation = backend
            .agent_runs()
            .create_standard_conversation("普通新对话")
            .unwrap();
        assert_eq!(conversation.agent_mode, "standard");
        assert_eq!(conversation.project_id, None);
        assert_eq!(conversation.pinned_at, None);
        assert_eq!(conversation.archived_at, None);
        assert_eq!(
            backend
                .projects()
                .workspace_grant_for_conversation(&conversation.id)
                .unwrap_err()
                .code,
            "agent-project-conversation-not-found"
        );
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn d1_conversation_pin_archive_restore_are_persistent_backend_state() {
        let app_data = temp_app_data("d1-conversation-lifecycle");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let conversation = backend
            .agent_runs()
            .create_project_conversation("Lifecycle conversation")
            .unwrap();
        let pinned = backend
            .agent_runs()
            .set_conversation_pinned(&conversation.id, true)
            .unwrap();
        assert!(pinned.pinned_at.is_some());
        assert!(pinned.archived_at.is_none());
        let archived = backend
            .agent_runs()
            .set_conversation_archived(&conversation.id, true)
            .unwrap();
        assert!(archived.archived_at.is_some());
        let restored = backend
            .agent_runs()
            .set_conversation_archived(&conversation.id, false)
            .unwrap();
        assert!(restored.archived_at.is_none());
        let listed = backend.agent_runs().list_conversations(10).unwrap();
        let persisted = listed
            .into_iter()
            .find(|item| item.id == conversation.id)
            .unwrap();
        assert!(
            persisted.pinned_at.is_none(),
            "restore keeps an archived conversation unpinned"
        );
        assert!(persisted.archived_at.is_none());
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn d1_conversation_delete_rejects_a_non_terminal_run_without_mutating_history() {
        let app_data = temp_app_data("d1-conversation-delete-safety");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let conversation = backend
            .agent_runs()
            .create_project_conversation("Protected conversation")
            .unwrap();
        let admitted = backend
            .agent_runs()
            .admit(crate::agent_runs::RunAdmission {
                conversation_id: conversation.id.clone(),
                user_content: "active run".to_owned(),
                kind: crate::agent_runs::RunKind::Agent,
                execution_mode: crate::agent_runs::RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "a".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        let run_id = admitted.run_id.clone();
        drop(admitted);
        assert_eq!(
            backend.delete_conversation(&conversation.id).unwrap_err(),
            "agent-conversation-delete-blocked"
        );
        assert!(backend
            .agent_runs()
            .list_conversations(10)
            .unwrap()
            .iter()
            .any(|item| item.id == conversation.id));
        backend
            .agent_runs()
            .settle(
                &run_id,
                crate::agent_runs::RunTerminal::Cancelled { action_truth: None },
            )
            .unwrap();
        backend.delete_conversation(&conversation.id).unwrap();
        assert!(backend
            .agent_runs()
            .list_conversations(10)
            .unwrap()
            .iter()
            .all(|item| item.id != conversation.id));
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn p1_conversation_delete_rejects_terminal_failed_prepared_receipt_and_preserves_reconciliation_truth(
    ) {
        let app_data = temp_app_data("p1-terminal-prepared-receipt");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let journal_path = app_data.join(".lrw-p1-reconciliation.journal");
        std::fs::write(&journal_path, "durable reconciliation journal").unwrap();
        let conversation = backend
            .agent_runs()
            .create_project_conversation("Prepared receipt protection")
            .unwrap();
        let admitted = backend
            .agent_runs()
            .admit(crate::agent_runs::RunAdmission {
                conversation_id: conversation.id.clone(),
                user_content: "retain the reconciliation input".to_owned(),
                kind: crate::agent_runs::RunKind::Agent,
                execution_mode: crate::agent_runs::RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "a".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        let run_id = admitted.run_id.clone();
        drop(admitted);
        let public_token = format!("artifact-{}", "p".repeat(32));
        backend
            .agent_runs()
            .prepare_artifact(
                &run_id,
                &public_token,
                "execution",
                "private-reconciliation-locator",
                &"b".repeat(64),
                Some(&"c".repeat(64)),
                &"b".repeat(64),
                "reconciliation receipt",
            )
            .unwrap();
        backend
            .agent_runs()
            .settle(
                &run_id,
                crate::agent_runs::RunTerminal::Failed {
                    code: "agent-engine-failed".to_owned(),
                    committed_warning: false,
                },
            )
            .unwrap();

        let before = backend.agent_runs().artifact_origin(&public_token).unwrap();
        assert_eq!(before.receipt_state, "prepared");
        assert_eq!(before.entity_ref, "private-reconciliation-locator");

        let error = backend.delete_conversation(&conversation.id).unwrap_err();
        assert_eq!(error, "agent-conversation-delete-receipt-retained");
        assert!(!error.contains("private"));
        assert!(!error.contains("SELECT"));

        assert_eq!(backend.agent_runs().get(&run_id).unwrap().status, "failed");
        assert_eq!(
            backend.agent_runs().restart_spec(&run_id).unwrap().input,
            "retain the reconciliation input"
        );
        let after = backend.agent_runs().artifact_origin(&public_token).unwrap();
        assert_eq!(after, before);
        assert_eq!(
            std::fs::read_to_string(&journal_path).unwrap(),
            "durable reconciliation journal"
        );
        assert!(backend
            .agent_runs()
            .list_conversations(10)
            .unwrap()
            .iter()
            .any(|item| item.id == conversation.id));

        backend
            .agent_runs()
            .reconcile_execution_artifacts()
            .unwrap();
        let reconciled = backend.agent_runs().artifact_origin(&public_token).unwrap();
        assert_eq!(reconciled.receipt_state, "uncertain");
        assert_eq!(reconciled.entity_ref, "private-reconciliation-locator");
        assert_eq!(backend.agent_runs().get(&run_id).unwrap().status, "failed");

        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn p1_conversation_delete_rejects_terminal_interrupted_uncertain_receipt() {
        let app_data = temp_app_data("p1-terminal-uncertain-receipt");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let conversation = backend
            .agent_runs()
            .create_project_conversation("Uncertain receipt protection")
            .unwrap();
        let admitted = backend
            .agent_runs()
            .admit(crate::agent_runs::RunAdmission {
                conversation_id: conversation.id.clone(),
                user_content: "retain interrupted reconciliation input".to_owned(),
                kind: crate::agent_runs::RunKind::Agent,
                execution_mode: crate::agent_runs::RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "a".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        let run_id = admitted.run_id.clone();
        drop(admitted);
        let public_token = format!("artifact-{}", "u".repeat(32));
        let artifact_id = backend
            .agent_runs()
            .prepare_artifact(
                &run_id,
                &public_token,
                "execution",
                "private-interrupted-locator",
                &"b".repeat(64),
                Some(&"c".repeat(64)),
                &"b".repeat(64),
                "uncertain reconciliation receipt",
            )
            .unwrap();
        backend.agent_runs().reconcile_startup_terminals().unwrap();
        backend
            .agent_runs()
            .mark_artifact_uncertain(&artifact_id)
            .unwrap();
        assert_eq!(
            backend.agent_runs().get(&run_id).unwrap().status,
            "interrupted"
        );
        assert_eq!(
            backend
                .agent_runs()
                .artifact_origin(&public_token)
                .unwrap()
                .receipt_state,
            "uncertain"
        );

        assert_eq!(
            backend.delete_conversation(&conversation.id).unwrap_err(),
            "agent-conversation-delete-receipt-retained"
        );
        assert_eq!(
            backend.agent_runs().get(&run_id).unwrap().status,
            "interrupted"
        );
        assert_eq!(
            backend
                .agent_runs()
                .artifact_origin(&public_token)
                .unwrap()
                .entity_ref,
            "private-interrupted-locator"
        );

        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn startup_recovers_prepared_execution_before_agent_terminal_reduction() {
        let app_data = temp_app_data("startup-execution-before-terminal");
        let (conversation_id, run_id) = {
            let backend = BackendServices::initialize(&app_data).unwrap();
            let conversation = backend
                .agent_runs()
                .create_standard_conversation("Execution recovery ordering")
                .unwrap();
            let admitted = backend
                .agent_runs()
                .admit(crate::agent_runs::RunAdmission {
                    conversation_id: conversation.id.clone(),
                    user_content: "check the project manifest".to_owned(),
                    kind: crate::agent_runs::RunKind::Agent,
                    execution_mode: crate::agent_runs::RunExecutionMode::Foreground,
                    policy_id: "standard-v1".to_owned(),
                    vault_binding_digest: "a".repeat(64),
                    restart_of: None,
                    existing_trigger_message_id: None,
                    schedule_fire_id: None,
                })
                .unwrap();
            backend
                .agent_runs()
                .mark_running(&admitted.run_id, "running")
                .unwrap();
            backend
                .agent_runs()
                .prepare_artifact(
                    &admitted.run_id,
                    &format!("artifact-{}", "e".repeat(32)),
                    "execution",
                    "private-recovery-locator",
                    &"b".repeat(64),
                    Some(&"c".repeat(64)),
                    &"d".repeat(64),
                    "项目清单检查",
                )
                .unwrap();
            let run_id = admitted.run_id.clone();
            drop(admitted);
            (conversation.id, run_id)
        };

        let recovered = BackendServices::initialize(&app_data).unwrap();
        let run = recovered.agent_runs().get(&run_id).unwrap();
        assert_eq!(run.status, "failed");
        assert_eq!(
            run.safe_code.as_deref(),
            Some("agent-engine-execution-result-uncertain")
        );
        assert!(run.result_message_id.is_some());
        let messages = recovered
            .agent_runs()
            .list_messages(&conversation_id)
            .unwrap();
        let assistant = messages
            .iter()
            .filter(|message| message.role == "assistant")
            .collect::<Vec<_>>();
        assert_eq!(assistant.len(), 1);
        assert_eq!(
            assistant[0].action_truth,
            Some(crate::agent_runs::AgentActionTruth::new(
                crate::agent_runs::WorkspaceActionTruth::NotRequested,
                crate::agent_runs::ExecutionActionTruth::Uncertain,
            ))
        );
        assert!(assistant[0].content.contains("待核对"));

        drop(recovered);
        let restarted = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(
            restarted
                .agent_runs()
                .list_messages(&conversation_id)
                .unwrap()
                .iter()
                .filter(|message| message.role == "assistant")
                .count(),
            1,
            "a second startup cannot append another terminal result"
        );
        drop(restarted);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn startup_reconstructs_verified_execution_result_from_durable_artifact_only() {
        let app_data = temp_app_data("startup-verified-execution-result");
        let (conversation_id, run_id) = {
            let backend = BackendServices::initialize(&app_data).unwrap();
            let conversation = backend
                .agent_runs()
                .create_standard_conversation("Verified execution recovery")
                .unwrap();
            let admitted = backend
                .agent_runs()
                .admit(crate::agent_runs::RunAdmission {
                    conversation_id: conversation.id.clone(),
                    user_content: "retain the verified manifest result".to_owned(),
                    kind: crate::agent_runs::RunKind::Agent,
                    execution_mode: crate::agent_runs::RunExecutionMode::Foreground,
                    policy_id: "standard-v1".to_owned(),
                    vault_binding_digest: "f".repeat(64),
                    restart_of: None,
                    existing_trigger_message_id: None,
                    schedule_fire_id: None,
                })
                .unwrap();
            let artifact = backend
                .agent_runs()
                .prepare_artifact(
                    &admitted.run_id,
                    &format!("artifact-{}", "v".repeat(32)),
                    "execution",
                    "private-verified-locator",
                    &"a".repeat(64),
                    Some(&"b".repeat(64)),
                    &"c".repeat(64),
                    "package.json",
                )
                .unwrap();
            backend
                .agent_runs()
                .commit_artifact_with_action_truth(
                    &artifact,
                    &"c".repeat(64),
                    "committed",
                    "package.json",
                    Some(crate::agent_runs::DurableArtifactActionTruth::ExecutionVerified),
                    Some("项目检查：项目清单检查已通过（package.json）。"),
                )
                .unwrap();
            let run_id = admitted.run_id.clone();
            drop(admitted);
            (conversation.id, run_id)
        };

        let recovered = BackendServices::initialize(&app_data).unwrap();
        let run = recovered.agent_runs().get(&run_id).unwrap();
        assert_eq!(run.status, "interrupted");
        assert!(run.committed_warning);
        assert!(run.result_message_id.is_some());
        let assistant = recovered
            .agent_runs()
            .list_messages(&conversation_id)
            .unwrap()
            .into_iter()
            .filter(|message| message.role == "assistant")
            .collect::<Vec<_>>();
        assert_eq!(assistant.len(), 1);
        assert_eq!(
            assistant[0].action_truth,
            Some(crate::agent_runs::AgentActionTruth::new(
                crate::agent_runs::WorkspaceActionTruth::NotRequested,
                crate::agent_runs::ExecutionActionTruth::Verified,
            ))
        );
        assert!(assistant[0].content.contains("package.json"));
        drop(recovered);
        let restarted = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(
            restarted
                .agent_runs()
                .list_messages(&conversation_id)
                .unwrap()
                .iter()
                .filter(|message| message.role == "assistant")
                .count(),
            1
        );
        drop(restarted);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn failed_terminal_commits_remain_active_until_restart_uses_the_same_reducer() {
        let app_data = temp_app_data("terminal-settle-failure-restart");
        let (conversation_id, run_id) = {
            let backend = BackendServices::initialize(&app_data).unwrap();
            let conversation = backend
                .agent_runs()
                .create_standard_conversation("Settlement recovery")
                .unwrap();
            let admitted = backend
                .agent_runs()
                .admit(crate::agent_runs::RunAdmission {
                    conversation_id: conversation.id.clone(),
                    user_content: "persist only through the Backend reducer".to_owned(),
                    kind: crate::agent_runs::RunKind::Agent,
                    execution_mode: crate::agent_runs::RunExecutionMode::Foreground,
                    policy_id: "standard-v1".to_owned(),
                    vault_binding_digest: "d".repeat(64),
                    restart_of: None,
                    existing_trigger_message_id: None,
                    schedule_fire_id: None,
                })
                .unwrap();
            backend
                .agent_runs()
                .mark_running(&admitted.run_id, "running")
                .unwrap();
            backend.agent_runs().fail_next_settles(2);
            let proposal = || {
                crate::agent_runs::RunTerminal::Agent(crate::agent_runs::AgentTerminalProposal {
                    observed: crate::agent_runs::AgentObservedTerminal::Interrupted,
                    assistant_content: None,
                    partial: false,
                    cited_references: Vec::new(),
                    receipt_summary: None,
                    action_truth: None,
                })
            };
            assert!(backend
                .agent_runs()
                .settle(&admitted.run_id, proposal())
                .is_err());
            assert!(backend
                .agent_runs()
                .settle(&admitted.run_id, proposal())
                .is_err());
            let active = backend.agent_runs().get(&admitted.run_id).unwrap();
            assert_eq!(active.status, "running");
            assert!(active.result_message_id.is_none());
            assert_eq!(
                backend
                    .agent_runs()
                    .list_messages(&conversation.id)
                    .unwrap()
                    .into_iter()
                    .filter(|message| message.role == "assistant")
                    .count(),
                0
            );
            let run_id = admitted.run_id.clone();
            drop(admitted);
            (conversation.id, run_id)
        };

        let restarted = BackendServices::initialize(&app_data).unwrap();
        let terminal = restarted.agent_runs().get(&run_id).unwrap();
        assert_eq!(terminal.status, "interrupted");
        assert!(terminal.result_message_id.is_some());
        assert_eq!(
            restarted
                .agent_runs()
                .list_messages(&conversation_id)
                .unwrap()
                .into_iter()
                .filter(|message| message.role == "assistant")
                .count(),
            1
        );
        drop(restarted);
        let second_restart = BackendServices::initialize(&app_data).unwrap();
        assert_eq!(
            second_restart
                .agent_runs()
                .list_messages(&conversation_id)
                .unwrap()
                .into_iter()
                .filter(|message| message.role == "assistant")
                .count(),
            1
        );
        drop(second_restart);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn startup_workspace_recovery_precedes_terminal_for_committed_uncertain_and_no_write_matrix() {
        use sha2::{Digest as _, Sha256};

        let run_case =
            |case: &str,
             file_after_crash: &str,
             stop_cause: Option<crate::agent_runs::RunStopCause>,
             expected_status: &str,
             expected_code: Option<&str>,
             expected_truth: crate::agent_runs::WorkspaceActionTruth| {
                let app_data = temp_app_data(&format!("startup-workspace-{case}"));
                let workspace_root = app_data.join("workspace");
                std::fs::create_dir_all(&workspace_root).unwrap();
                let target = workspace_root.join("notes.txt");
                std::fs::write(&target, "before").unwrap();
                let (conversation_id, run_id) = {
                    let backend = BackendServices::initialize(&app_data).unwrap();
                    let grant = backend
                        .workspace()
                        .add(&workspace_root, "Recovery Workspace")
                        .unwrap();
                    let conversation = backend
                        .agent_runs()
                        .create_standard_conversation("Workspace recovery")
                        .unwrap();
                    let admitted = backend
                        .agent_runs()
                        .admit(crate::agent_runs::RunAdmission {
                            conversation_id: conversation.id.clone(),
                            user_content: "recover the durable workspace result".to_owned(),
                            kind: crate::agent_runs::RunKind::Agent,
                            execution_mode: crate::agent_runs::RunExecutionMode::Foreground,
                            policy_id: "standard-v1".to_owned(),
                            vault_binding_digest: "a".repeat(64),
                            restart_of: None,
                            existing_trigger_message_id: None,
                            schedule_fire_id: None,
                        })
                        .unwrap();
                    let read = backend.workspace().read(&grant.id, "notes.txt").unwrap();
                    let locator = crate::agent_workspace::WorkspaceWriteLocator {
                        grant_id: grant.id,
                        relative_path: "notes.txt".to_owned(),
                        root_digest: read.root_digest,
                    };
                    let expected = format!("{:x}", Sha256::digest(b"before"));
                    let planned = format!("{:x}", Sha256::digest(b"after"));
                    backend
                        .agent_runs()
                        .prepare_artifact(
                            &admitted.run_id,
                            &format!("artifact-{}", case.replace('-', "a")),
                            "workspace-file",
                            &serde_json::to_string(&locator).unwrap(),
                            &"b".repeat(64),
                            Some(&expected),
                            &planned,
                            "notes.txt",
                        )
                        .unwrap();
                    if let Some(cause) = stop_cause {
                        backend
                            .agent_runs()
                            .record_stop_cause(&admitted.run_id, cause)
                            .unwrap();
                        backend
                            .agent_runs()
                            .record_stop_transport(
                                &admitted.run_id,
                                crate::agent_runs::StopTransportObservation::Acknowledged,
                            )
                            .unwrap();
                    }
                    std::fs::write(&target, file_after_crash).unwrap();
                    let run_id = admitted.run_id.clone();
                    drop(admitted);
                    (conversation.id, run_id)
                };

                let recovered = BackendServices::initialize(&app_data).unwrap();
                let run = recovered.agent_runs().get(&run_id).unwrap();
                assert_eq!(run.status, expected_status, "{case}");
                assert_eq!(run.safe_code.as_deref(), expected_code, "{case}");
                let assistant = recovered
                    .agent_runs()
                    .list_messages(&conversation_id)
                    .unwrap()
                    .into_iter()
                    .filter(|message| message.role == "assistant")
                    .collect::<Vec<_>>();
                assert_eq!(assistant.len(), 1, "{case}");
                assert_eq!(
                    assistant[0].action_truth,
                    Some(crate::agent_runs::AgentActionTruth::new(
                        expected_truth,
                        crate::agent_runs::ExecutionActionTruth::NotRequested,
                    )),
                    "{case}"
                );
                drop(recovered);
                let restarted = BackendServices::initialize(&app_data).unwrap();
                assert_eq!(
                    restarted
                        .agent_runs()
                        .list_messages(&conversation_id)
                        .unwrap()
                        .into_iter()
                        .filter(|message| message.role == "assistant")
                        .count(),
                    1,
                    "{case}"
                );
                drop(restarted);
                std::fs::remove_dir_all(app_data).unwrap();
            };

        for (suffix, cause) in [
            ("none", None),
            (
                "explicit",
                Some(crate::agent_runs::RunStopCause::ExplicitCancel),
            ),
            ("safety", Some(crate::agent_runs::RunStopCause::SafetyAbort)),
        ] {
            run_case(
                &format!("committed-{suffix}"),
                "after",
                cause,
                "interrupted",
                Some("agent-run-app-restarted"),
                crate::agent_runs::WorkspaceActionTruth::Verified,
            );
            run_case(
                &format!("uncertain-{suffix}"),
                "external",
                cause,
                "failed",
                Some("agent-engine-workspace-write-uncertain"),
                crate::agent_runs::WorkspaceActionTruth::Uncertain,
            );
            let (status, code) = match cause {
                None => ("interrupted", Some("agent-run-app-restarted")),
                Some(crate::agent_runs::RunStopCause::ExplicitCancel) => {
                    ("cancelled", Some("agent-engine-cancelled"))
                }
                Some(crate::agent_runs::RunStopCause::SafetyAbort) => {
                    ("aborted", Some("agent-engine-aborted"))
                }
            };
            run_case(
                &format!("no-write-{suffix}"),
                "before",
                cause,
                status,
                code,
                crate::agent_runs::WorkspaceActionTruth::NotRequested,
            );
        }
    }

    #[test]
    fn p1_conversation_delete_rejects_prepared_or_uncertain_receipts_for_completed_and_cancelled_runs(
    ) {
        for (case, terminal, receipt_state) in [
            ("completed-prepared", "completed", "prepared"),
            ("completed-uncertain", "completed", "uncertain"),
            ("cancelled-prepared", "cancelled", "prepared"),
            ("cancelled-uncertain", "cancelled", "uncertain"),
        ] {
            let app_data = temp_app_data(&format!("p1-terminal-matrix-{case}"));
            let backend = BackendServices::initialize(&app_data).unwrap();
            let conversation = backend
                .agent_runs()
                .create_project_conversation("Terminal receipt matrix")
                .unwrap();
            let admitted = backend
                .agent_runs()
                .admit(crate::agent_runs::RunAdmission {
                    conversation_id: conversation.id.clone(),
                    user_content: format!("retain {case}"),
                    kind: crate::agent_runs::RunKind::Agent,
                    execution_mode: crate::agent_runs::RunExecutionMode::Foreground,
                    policy_id: "standard-v1".to_owned(),
                    vault_binding_digest: "a".repeat(64),
                    restart_of: None,
                    existing_trigger_message_id: None,
                    schedule_fire_id: None,
                })
                .unwrap();
            let run_id = admitted.run_id.clone();
            drop(admitted);
            let public_token = format!("artifact-{}", "m".repeat(32));
            let artifact_id = backend
                .agent_runs()
                .prepare_artifact(
                    &run_id,
                    &public_token,
                    "execution",
                    "private-terminal-matrix-locator",
                    &"b".repeat(64),
                    Some(&"c".repeat(64)),
                    &"b".repeat(64),
                    "terminal matrix receipt",
                )
                .unwrap();
            if receipt_state == "uncertain" {
                backend
                    .agent_runs()
                    .mark_artifact_uncertain(&artifact_id)
                    .unwrap();
            }
            match terminal {
                "completed" => {
                    backend
                        .agent_runs()
                        .settle(
                            &run_id,
                            crate::agent_runs::RunTerminal::Completed {
                                assistant_content: "completed safely".to_owned(),
                                partial: false,
                                cited_references: Vec::new(),
                                action_truth: None,
                            },
                        )
                        .unwrap();
                }
                "cancelled" => {
                    backend
                        .agent_runs()
                        .settle(
                            &run_id,
                            crate::agent_runs::RunTerminal::Cancelled { action_truth: None },
                        )
                        .unwrap();
                }
                _ => unreachable!("test matrix terminal is fixed"),
            }

            assert_eq!(backend.agent_runs().get(&run_id).unwrap().status, terminal);
            assert_eq!(
                backend
                    .agent_runs()
                    .artifact_origin(&public_token)
                    .unwrap()
                    .receipt_state,
                receipt_state
            );
            assert_eq!(
                backend.delete_conversation(&conversation.id).unwrap_err(),
                "agent-conversation-delete-receipt-retained",
                "receipt gate must protect {case}"
            );
            assert!(backend
                .agent_runs()
                .list_conversations(10)
                .unwrap()
                .iter()
                .any(|item| item.id == conversation.id));
            assert_eq!(
                backend
                    .agent_runs()
                    .artifact_origin(&public_token)
                    .unwrap()
                    .entity_ref,
                "private-terminal-matrix-locator"
            );

            drop(backend);
            std::fs::remove_dir_all(app_data).unwrap();
        }
    }

    #[test]
    fn p1_conversation_delete_allows_committed_receipts_and_empty_archived_conversations() {
        for (case, artifact_status, terminal) in [
            ("committed", "committed", "completed"),
            ("committed-warning", "committed-warning", "cancelled"),
        ] {
            let app_data = temp_app_data(&format!("p1-allowed-receipt-{case}"));
            let backend = BackendServices::initialize(&app_data).unwrap();
            let conversation = backend
                .agent_runs()
                .create_project_conversation("Committed receipt")
                .unwrap();
            let admitted = backend
                .agent_runs()
                .admit(crate::agent_runs::RunAdmission {
                    conversation_id: conversation.id.clone(),
                    user_content: format!("delete {case} after durable settlement"),
                    kind: crate::agent_runs::RunKind::Agent,
                    execution_mode: crate::agent_runs::RunExecutionMode::Foreground,
                    policy_id: "standard-v1".to_owned(),
                    vault_binding_digest: "a".repeat(64),
                    restart_of: None,
                    existing_trigger_message_id: None,
                    schedule_fire_id: None,
                })
                .unwrap();
            let run_id = admitted.run_id.clone();
            drop(admitted);
            let public_token = format!("artifact-{}", "c".repeat(32));
            let artifact_id = backend
                .agent_runs()
                .prepare_artifact(
                    &run_id,
                    &public_token,
                    "execution",
                    "private-committed-locator",
                    &"b".repeat(64),
                    Some(&"c".repeat(64)),
                    &"b".repeat(64),
                    "committed receipt",
                )
                .unwrap();
            let committed = backend
                .agent_runs()
                .commit_artifact(
                    &artifact_id,
                    &"b".repeat(64),
                    artifact_status,
                    "committed receipt",
                )
                .unwrap();
            assert_eq!(committed.receipt_state, "committed");
            assert_eq!(committed.status, artifact_status);
            match terminal {
                "completed" => {
                    backend
                        .agent_runs()
                        .settle(
                            &run_id,
                            crate::agent_runs::RunTerminal::Completed {
                                assistant_content: "committed result".to_owned(),
                                partial: false,
                                cited_references: Vec::new(),
                                action_truth: None,
                            },
                        )
                        .unwrap();
                }
                "cancelled" => {
                    backend
                        .agent_runs()
                        .settle(
                            &run_id,
                            crate::agent_runs::RunTerminal::Cancelled { action_truth: None },
                        )
                        .unwrap();
                }
                _ => unreachable!("test case terminal is fixed"),
            }
            backend.delete_conversation(&conversation.id).unwrap();
            assert!(backend
                .agent_runs()
                .list_conversations(10)
                .unwrap()
                .iter()
                .all(|item| item.id != conversation.id));
            assert_eq!(
                backend
                    .agent_runs()
                    .artifact_origin(&public_token)
                    .unwrap_err()
                    .code,
                "agent-run-artifact-not-found"
            );
            drop(backend);
            std::fs::remove_dir_all(app_data).unwrap();
        }

        let app_data = temp_app_data("p1-allowed-empty-archived");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let conversation = backend
            .agent_runs()
            .create_project_conversation("Empty archived conversation")
            .unwrap();
        backend
            .agent_runs()
            .set_conversation_archived(&conversation.id, true)
            .unwrap();
        backend.delete_conversation(&conversation.id).unwrap();
        assert!(backend
            .agent_runs()
            .list_conversations(10)
            .unwrap()
            .iter()
            .all(|item| item.id != conversation.id));
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn p1_conversation_delete_receipt_gate_is_linearized_with_a_concurrent_receipt_writer() {
        let app_data = temp_app_data("p1-concurrent-receipt-writer");
        let backend = BackendServices::initialize(&app_data).unwrap();
        let conversation = backend
            .agent_runs()
            .create_project_conversation("Concurrent receipt protection")
            .unwrap();
        let admitted = backend
            .agent_runs()
            .admit(crate::agent_runs::RunAdmission {
                conversation_id: conversation.id.clone(),
                user_content: "serialize deletion with receipt commit".to_owned(),
                kind: crate::agent_runs::RunKind::Agent,
                execution_mode: crate::agent_runs::RunExecutionMode::Foreground,
                policy_id: "standard-v1".to_owned(),
                vault_binding_digest: "a".repeat(64),
                restart_of: None,
                existing_trigger_message_id: None,
                schedule_fire_id: None,
            })
            .unwrap();
        let run_id = admitted.run_id.clone();
        drop(admitted);
        backend
            .agent_runs()
            .settle(
                &run_id,
                crate::agent_runs::RunTerminal::Cancelled { action_truth: None },
            )
            .unwrap();

        let public_token = format!("artifact-{}", "l".repeat(32));
        let mut writer = Connection::open(backend.db_path()).unwrap();
        writer
            .busy_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let transaction = writer
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        transaction
            .execute(
                "INSERT INTO ai_run_artifact(
                    id,run_id,public_token,entity_kind,entity_ref,operation_digest,
                    expected_revision,new_revision,receipt_state,display_name,status,created_at,updated_at
                 ) VALUES ('artifact-concurrent-receipt',?1,?2,'execution',
                    'private-concurrent-locator',?3,?4,?3,'uncertain',
                    'concurrent receipt','interrupted','now','now')",
                rusqlite::params![
                    run_id,
                    public_token,
                    "d".repeat(64),
                    "e".repeat(64)
                ],
            )
            .unwrap();

        let coordinator = backend.agent_runs().clone();
        let conversation_id = conversation.id.clone();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let deleter = std::thread::spawn(move || {
            result_tx
                .send(coordinator.delete_conversation(&conversation_id))
                .unwrap();
        });
        match result_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Ok(result) => panic!(
                "delete must not cross the writer lock before the uncertain receipt commits: {result:?}"
            ),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                panic!("delete worker exited before the receipt writer committed")
            }
        }
        transaction.commit().unwrap();

        assert_eq!(
            result_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            Err(crate::agent_runs::RunLedgerError {
                code: "agent-conversation-delete-receipt-retained"
            })
        );
        deleter.join().unwrap();
        assert_eq!(
            backend
                .agent_runs()
                .artifact_origin(&public_token)
                .unwrap()
                .entity_ref,
            "private-concurrent-locator"
        );
        assert!(backend
            .agent_runs()
            .list_conversations(10)
            .unwrap()
            .iter()
            .any(|item| item.id == conversation.id));

        drop(writer);
        drop(backend);
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn companion_gateway_schema_is_additive_restart_safe_and_migrates_from_v19() {
        fn assert_schema(db_path: &Path) {
            let connection = Connection::open(db_path).unwrap();
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COALESCE(MAX(version), 0) FROM backend_schema_migration",
                        [],
                        |row| row.get::<_, u32>(0),
                    )
                    .unwrap(),
                  SCHEMA_VERSION
            );
            assert_eq!(
                connection
                    .query_row(
                        "SELECT name FROM backend_schema_migration WHERE version=20",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap(),
                "desktop-companion-gateway-foundation"
            );
            for table in [
                "companion_identity",
                "companion_device",
                "companion_security_audit",
                "companion_content_note",
                "companion_content_change",
                "companion_content_cursor",
                "companion_content_operation",
                "companion_content_upload",
                "companion_service_grant",
                "companion_service_operation",
                "companion_service_upload",
                "companion_service_change",
                "companion_service_search_snapshot",
            ] {
                assert_eq!(
                    connection
                        .query_row(
                            "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name=?1",
                            [table],
                            |row| row.get::<_, i64>(0),
                        )
                        .unwrap(),
                    1,
                    "missing companion table {table}"
                );
            }
            let audit_columns = connection
                .prepare("PRAGMA table_info(companion_security_audit)")
                .unwrap()
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(
                audit_columns,
                ["id", "action", "device_id", "occurred_at", "result"]
            );
        }

        let app_data = temp_app_data("companion-schema-v20");
        let first = BackendServices::initialize(&app_data).unwrap();
        let db_path = first.db_path().to_path_buf();
        assert_schema(&db_path);
        drop(first);

        let restarted = BackendServices::initialize(&app_data).unwrap();
        assert_schema(restarted.db_path());
        drop(restarted);

        let connection = Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER companion_service_favorite_insert;
                 DROP TRIGGER companion_service_favorite_delete;
                 DROP TRIGGER companion_service_note_change;
                 DROP TRIGGER companion_service_asset_insert;
                 DROP TRIGGER companion_service_asset_update;
                 DROP TRIGGER companion_service_asset_delete;
                 DROP TRIGGER companion_service_asset_tag_insert;
                 DROP TRIGGER companion_service_asset_tag_delete;
                 DROP TRIGGER companion_service_source_page_insert;
                 DROP TABLE companion_service_grant;
                 DROP TABLE companion_service_operation;
                 DROP TABLE companion_service_upload;
                 DROP TABLE companion_service_change;
                 DROP TABLE companion_service_search_snapshot;
                 DROP INDEX idx_companion_security_audit_time;
                 DROP INDEX idx_companion_device_active;
                 DROP TABLE companion_security_audit;
                 DROP TABLE companion_device;
                 DROP TABLE companion_identity;
                   DROP TABLE companion_content_note;
                   DROP TABLE companion_content_change;
                   DROP TABLE companion_content_cursor;
                   DROP TABLE companion_content_operation;
                   DROP TABLE companion_content_upload;
                   DELETE FROM backend_schema_migration WHERE version>=20;",
            )
            .unwrap();
        drop(connection);

        let migrated = BackendServices::initialize(&app_data).unwrap();
        assert_schema(migrated.db_path());
        drop(migrated);
        std::fs::remove_dir_all(app_data).unwrap();
    }
}
