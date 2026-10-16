//! Durable schema compatibility for databases created by the accepted R6.2-F
//! and pre-release DSH lineages. This module deliberately owns no runtime
//! service: it only preserves data and enforces the historical schema fences
//! needed to open an existing database safely.

use rusqlite::{Connection, OptionalExtension};

use super::{database_error, schema_verification_error, BackendBootstrapError};

const LEGACY_R62F_V13: &str = "agent-turn-control-v2";
const LEGACY_R62F_V14: &str = "agent-composer-turn-ux-v2";
const DSH_V13: &str = "dsh-permission-session-profile-generation-authority";
const DSH_V14: &str = "dsh-memory-operation-receipt-immutable-truth";
const DSH_V15: &str = "dsh-conversation-native-session-binding";
const DSH_V16: &str = "reconcile-r62f-dsh-schema-lineage";
const DSH_V17: &str = "dsh-conversation-provider-binding-fence";

const DSH_V13_OBJECTS: &[&str] = &[
    "dsh_permission_session",
    "dsh_permission_snapshot",
    "idx_dsh_permission_snapshot_active",
    "dsh_permission_snapshot_payload_immutable",
    "dsh_permission_snapshot_state_transition_guard",
    "dsh_permission_session_current_guard",
];

const DSH_V14_OBJECTS: &[&str] = &[
    "dsh_memory_operation_receipt",
    "idx_dsh_memory_operation_receipt_idempotency",
    "dsh_memory_operation_receipt_update_immutable",
    "dsh_memory_operation_receipt_delete_immutable",
];

const DSH_V15_OBJECTS: &[&str] = &[
    "dsh_conversation_start",
    "idx_dsh_conversation_start_native",
    "idx_ai_conversation_dsh_session",
    "idx_ai_conversation_dsh_permission",
];

const DSH_V17_OBJECTS: &[&str] = &[
    "dsh_conversation_start_insert_guard",
    "dsh_conversation_start_update_guard",
    "ai_conversation_runtime_kind_insert",
    "ai_conversation_runtime_kind_update",
];

pub(super) fn migrate_schema_13_to_17(
    connection: &Connection,
    current_version: u32,
) -> Result<(), BackendBootstrapError> {
    if current_version >= 17 {
        verify_existing_schema17_before_mutation(connection)?;
    }
    if current_version < 13 {
        apply_schema_v13(connection)?;
    }
    if current_version < 14 {
        apply_schema_v14(connection)?;
    }
    if current_version < 15 {
        apply_schema_v15(connection)?;
    }
    if current_version < 16 {
        reconcile_lineages(connection, current_version)?;
    }
    if current_version < 17 {
        apply_schema_v17(connection)?;
    }

    if current_version < 17 {
        refresh_conversation_guards(connection)?;
    }
    verify_lineage_records(connection, current_version)?;
    verify_compatibility_indexes(connection)?;
    verify_permission_semantics(connection)?;
    verify_memory_receipt_semantics(connection)?;
    verify_conversation_semantics(connection)?;

    for (version, name) in [
        (13, DSH_V13),
        (14, DSH_V14),
        (15, DSH_V15),
        (16, DSH_V16),
        (17, DSH_V17),
    ] {
        if current_version < version {
            connection
                .execute(
                    "INSERT INTO backend_schema_migration(version,name,applied_at) VALUES(?1,?2,?3)",
                    rusqlite::params![version, name, chrono::Utc::now().to_rfc3339()],
                )
                .map_err(|error| database_error("backend-migration-record-failed", error))?;
        }
    }
    Ok(())
}

fn verify_existing_schema17_before_mutation(
    connection: &Connection,
) -> Result<(), BackendBootstrapError> {
    verify_lineage_records(connection, 17)?;
    require_complete_object_set(connection, "dsh-permission-v13", DSH_V13_OBJECTS)?;
    require_complete_object_set(connection, "dsh-memory-receipt-v14", DSH_V14_OBJECTS)?;
    require_complete_object_set(connection, "dsh-conversation-v15", DSH_V15_OBJECTS)?;
    require_complete_object_set(connection, "dsh-conversation-v17", DSH_V17_OBJECTS)?;
    verify_compatibility_indexes(connection)?;
    require_column(connection, "ai_conversation", "dsh_provider_binding_digest")?;
    require_column(
        connection,
        "dsh_conversation_start",
        "provider_binding_digest",
    )?;
    verify_permission_semantics(connection)?;
    verify_memory_receipt_semantics(connection)?;
    verify_conversation_semantics(connection)
}

fn migration_name(
    connection: &Connection,
    version: u32,
) -> Result<Option<String>, BackendBootstrapError> {
    connection
        .query_row(
            "SELECT name FROM backend_schema_migration WHERE version=?1",
            [version],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| database_error("backend-schema-lineage-query-failed", error))
}

fn reconcile_lineages(
    connection: &Connection,
    current_version: u32,
) -> Result<(), BackendBootstrapError> {
    reconcile_lineage(
        connection,
        current_version,
        13,
        DSH_V13,
        LEGACY_R62F_V13,
        "dsh-permission-v13",
        DSH_V13_OBJECTS,
        apply_schema_v13,
    )?;
    reconcile_lineage(
        connection,
        current_version,
        14,
        DSH_V14,
        LEGACY_R62F_V14,
        "dsh-memory-receipt-v14",
        DSH_V14_OBJECTS,
        apply_schema_v14,
    )
}

#[allow(clippy::too_many_arguments)]
fn reconcile_lineage(
    connection: &Connection,
    current_version: u32,
    version: u32,
    dsh_name: &str,
    legacy_name: &str,
    label: &str,
    objects: &[&str],
    apply: fn(&Connection) -> Result<(), BackendBootstrapError>,
) -> Result<(), BackendBootstrapError> {
    if current_version < version {
        return require_complete_object_set(connection, label, objects);
    }
    match migration_name(connection, version)?.as_deref() {
        Some(name) if name == dsh_name => require_complete_object_set(connection, label, objects),
        Some(name) if name == legacy_name => {
            let present = count_objects(connection, objects)?;
            if present == 0 {
                apply(connection)
            } else if present == objects.len() {
                Ok(())
            } else {
                Err(lineage_error("backend-schema-lineage-incomplete", label))
            }
        }
        _ => Err(lineage_error("backend-schema-lineage-unknown", label)),
    }
}

fn verify_lineage_records(
    connection: &Connection,
    original_version: u32,
) -> Result<(), BackendBootstrapError> {
    if original_version >= 13
        && !matches!(
            migration_name(connection, 13)?.as_deref(),
            Some(DSH_V13 | LEGACY_R62F_V13)
        )
    {
        return Err(lineage_error("backend-schema-lineage-unknown", "v13"));
    }
    if original_version >= 14
        && !matches!(
            migration_name(connection, 14)?.as_deref(),
            Some(DSH_V14 | LEGACY_R62F_V14)
        )
    {
        return Err(lineage_error("backend-schema-lineage-unknown", "v14"));
    }
    for (version, expected) in [(15, DSH_V15), (16, DSH_V16), (17, DSH_V17)] {
        if original_version >= version
            && migration_name(connection, version)?.as_deref() != Some(expected)
        {
            return Err(lineage_error(
                "backend-schema-lineage-unknown",
                &format!("v{version}"),
            ));
        }
    }
    Ok(())
}

fn lineage_error(code: &'static str, label: &str) -> BackendBootstrapError {
    BackendBootstrapError {
        code,
        message: format!("schema lineage reconciliation failed for {label}"),
    }
}

fn count_objects(
    connection: &Connection,
    objects: &[&str],
) -> Result<usize, BackendBootstrapError> {
    let mut present = 0usize;
    for name in objects {
        present += connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name=?1)",
                [name],
                |row| row.get::<_, usize>(0),
            )
            .map_err(|error| database_error("backend-schema-lineage-query-failed", error))?;
    }
    Ok(present)
}

fn require_complete_object_set(
    connection: &Connection,
    label: &str,
    objects: &[&str],
) -> Result<(), BackendBootstrapError> {
    if count_objects(connection, objects)? == objects.len() {
        Ok(())
    } else {
        Err(lineage_error("backend-schema-lineage-incomplete", label))
    }
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<(), BackendBootstrapError> {
    let exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
            rusqlite::params![table, column],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| database_error("backend-schema-column-query-failed", error))?;
    if exists {
        return Ok(());
    }
    connection
        .execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {declaration};"))
        .map_err(|error| database_error("backend-schema-column-migration-failed", error))
}

fn require_column(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<(), BackendBootstrapError> {
    let exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
            rusqlite::params![table, column],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| database_error("backend-schema-column-query-failed", error))?;
    if exists {
        Ok(())
    } else {
        Err(lineage_error(
            "backend-schema-lineage-incomplete",
            &format!("{table}.{column}"),
        ))
    }
}

fn require_unique_index(
    connection: &Connection,
    table: &str,
    index: &str,
    expected_columns: &[&str],
    expected_partial: bool,
) -> Result<(), BackendBootstrapError> {
    let metadata = connection
        .query_row(
            "SELECT \"unique\",partial FROM pragma_index_list(?1) WHERE name=?2",
            rusqlite::params![table, index],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()
        .map_err(|error| database_error("backend-schema-index-query-failed", error))?;
    let mut statement = connection
        .prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
        .map_err(|error| database_error("backend-schema-index-query-failed", error))?;
    let actual_columns = statement
        .query_map([index], |row| row.get::<_, String>(0))
        .map_err(|error| database_error("backend-schema-index-query-failed", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| database_error("backend-schema-index-query-failed", error))?;
    let expected_columns = expected_columns
        .iter()
        .map(|column| (*column).to_string())
        .collect::<Vec<_>>();
    if metadata == Some((true, expected_partial)) && actual_columns == expected_columns {
        Ok(())
    } else {
        Err(schema_verification_error(
            "backend-schema-lineage-incomplete",
            index,
            "required unique index shape is not enforced",
        ))
    }
}

fn verify_compatibility_indexes(connection: &Connection) -> Result<(), BackendBootstrapError> {
    require_unique_index(
        connection,
        "dsh_permission_snapshot",
        "idx_dsh_permission_snapshot_active",
        &["session_key"],
        true,
    )?;
    require_unique_index(
        connection,
        "dsh_memory_operation_receipt",
        "idx_dsh_memory_operation_receipt_idempotency",
        &[
            "permission_session_key",
            "permission_generation",
            "native_correlation_digest",
        ],
        false,
    )?;
    require_unique_index(
        connection,
        "dsh_conversation_start",
        "idx_dsh_conversation_start_native",
        &["native_session_ref"],
        false,
    )?;
    require_unique_index(
        connection,
        "ai_conversation",
        "idx_ai_conversation_dsh_session",
        &["dsh_session_ref"],
        true,
    )?;
    require_unique_index(
        connection,
        "ai_conversation",
        "idx_ai_conversation_dsh_permission",
        &["dsh_permission_session_key"],
        true,
    )
}

fn apply_schema_v13(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS dsh_permission_session(
            session_key TEXT PRIMARY KEY,
            current_generation INTEGER NOT NULL CHECK(current_generation>0),
            transition_revision INTEGER NOT NULL CHECK(transition_revision>0),
            phase TEXT NOT NULL CHECK(phase IN('active','preparing-upgrade','revoking','degraded-read-only','retired')),
            pending_generation INTEGER CHECK(pending_generation IS NULL OR pending_generation>0),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            CHECK((phase='preparing-upgrade')=(pending_generation IS NOT NULL))
         );
         CREATE TABLE IF NOT EXISTS dsh_permission_snapshot(
            session_key TEXT NOT NULL,
            generation INTEGER NOT NULL CHECK(generation>0),
            profile TEXT NOT NULL CHECK(profile IN('read-only','workspace-write','full-access')),
            context_kind TEXT NOT NULL CHECK(context_kind IN('diagnostic','standard-conversation','project-conversation')),
            project_id TEXT, workspace_grant_id TEXT, knowledge_target_id TEXT,
            knowledge_identity TEXT, vault_identity TEXT,
            capability_manifest_json TEXT NOT NULL CHECK(json_valid(capability_manifest_json)),
            capability_digest TEXT NOT NULL CHECK(length(capability_digest)=64),
            composition_digest TEXT NOT NULL CHECK(length(composition_digest)=64),
            activation_state TEXT NOT NULL CHECK(activation_state IN('prepared','active','superseded','revoked')),
            created_at TEXT NOT NULL, activated_at TEXT, revoked_at TEXT,
            PRIMARY KEY(session_key,generation),
            FOREIGN KEY(session_key) REFERENCES dsh_permission_session(session_key) ON DELETE CASCADE,
            CHECK((knowledge_target_id IS NULL)=(knowledge_identity IS NULL)),
            CHECK(context_kind='project-conversation' OR project_id IS NULL)
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_dsh_permission_snapshot_active
           ON dsh_permission_snapshot(session_key) WHERE activation_state='active';
         CREATE TRIGGER IF NOT EXISTS dsh_permission_snapshot_payload_immutable
         BEFORE UPDATE ON dsh_permission_snapshot
         WHEN OLD.session_key!=NEW.session_key OR OLD.generation!=NEW.generation
           OR OLD.profile!=NEW.profile OR OLD.context_kind!=NEW.context_kind
           OR OLD.project_id IS NOT NEW.project_id
           OR OLD.workspace_grant_id IS NOT NEW.workspace_grant_id
           OR OLD.knowledge_target_id IS NOT NEW.knowledge_target_id
           OR OLD.knowledge_identity IS NOT NEW.knowledge_identity
           OR OLD.vault_identity IS NOT NEW.vault_identity
           OR OLD.capability_manifest_json!=NEW.capability_manifest_json
           OR OLD.capability_digest!=NEW.capability_digest
           OR OLD.composition_digest!=NEW.composition_digest
           OR OLD.created_at!=NEW.created_at
         BEGIN SELECT RAISE(ABORT,'dsh-permission-snapshot-payload-immutable'); END;
         CREATE TRIGGER IF NOT EXISTS dsh_permission_snapshot_state_transition_guard
         BEFORE UPDATE OF activation_state ON dsh_permission_snapshot
         WHEN OLD.activation_state!=NEW.activation_state AND NOT(
           (OLD.activation_state='prepared' AND NEW.activation_state IN('active','revoked'))
           OR (OLD.activation_state='active' AND NEW.activation_state IN('superseded','revoked')))
         BEGIN SELECT RAISE(ABORT,'dsh-permission-snapshot-transition-invalid'); END;
         CREATE TRIGGER IF NOT EXISTS dsh_permission_session_current_guard
         BEFORE UPDATE OF current_generation,phase ON dsh_permission_session
         WHEN NEW.phase IN('active','revoking','degraded-read-only') AND NOT EXISTS(
           SELECT 1 FROM dsh_permission_snapshot s WHERE s.session_key=NEW.session_key
           AND s.generation=NEW.current_generation AND s.activation_state='active')
         BEGIN SELECT RAISE(ABORT,'dsh-permission-current-generation-invalid'); END;",
    ).map_err(|error| database_error("backend-dsh-permission-schema-migration-failed", error))
}

fn apply_schema_v14(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS dsh_memory_operation_receipt(
            operation_ref TEXT PRIMARY KEY,
            permission_session_key TEXT NOT NULL,
            permission_generation INTEGER NOT NULL CHECK(permission_generation>0),
            native_correlation_digest TEXT NOT NULL CHECK(length(native_correlation_digest)=64),
            operation_kind TEXT NOT NULL CHECK(operation_kind IN('memory-create','memory-update')),
            request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
            scope_kind TEXT NOT NULL CHECK(scope_kind IN('global','current-vault')),
            scope_identity_digest TEXT CHECK(scope_identity_digest IS NULL OR length(scope_identity_digest)=64),
            source_entry_id TEXT,
            source_revision INTEGER CHECK(source_revision IS NULL OR source_revision>0),
            result_entry_id TEXT NOT NULL,
            result_revision INTEGER NOT NULL CHECK(result_revision>0),
            committed_at TEXT NOT NULL,
            FOREIGN KEY(permission_session_key,permission_generation)
              REFERENCES dsh_permission_snapshot(session_key,generation) ON DELETE RESTRICT,
            CHECK((operation_kind='memory-create' AND source_entry_id IS NULL AND source_revision IS NULL)
               OR (operation_kind='memory-update' AND source_entry_id IS NOT NULL AND source_revision IS NOT NULL)),
            CHECK((scope_kind='global' AND scope_identity_digest IS NULL)
               OR (scope_kind='current-vault' AND scope_identity_digest IS NOT NULL))
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_dsh_memory_operation_receipt_idempotency
           ON dsh_memory_operation_receipt(permission_session_key,permission_generation,native_correlation_digest);
         CREATE TRIGGER IF NOT EXISTS dsh_memory_operation_receipt_update_immutable
         BEFORE UPDATE ON dsh_memory_operation_receipt
         BEGIN SELECT RAISE(ABORT,'dsh-memory-operation-receipt-immutable'); END;
         CREATE TRIGGER IF NOT EXISTS dsh_memory_operation_receipt_delete_immutable
         BEFORE DELETE ON dsh_memory_operation_receipt
         BEGIN SELECT RAISE(ABORT,'dsh-memory-operation-receipt-immutable'); END;",
    ).map_err(|error| database_error("backend-dsh-memory-receipt-schema-migration-failed", error))
}

fn apply_schema_v15(connection: &Connection) -> Result<(), BackendBootstrapError> {
    ensure_column(
        connection,
        "ai_conversation",
        "runtime_kind",
        "runtime_kind TEXT NOT NULL DEFAULT 'legacy'",
    )?;
    ensure_column(
        connection,
        "ai_conversation",
        "dsh_session_ref",
        "dsh_session_ref TEXT",
    )?;
    ensure_column(
        connection,
        "ai_conversation",
        "dsh_permission_session_key",
        "dsh_permission_session_key TEXT",
    )?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS dsh_conversation_start(
            start_ref TEXT PRIMARY KEY NOT NULL,
            conversation_id TEXT NOT NULL UNIQUE,
            native_session_ref TEXT NOT NULL UNIQUE,
            permission_session_key TEXT NOT NULL UNIQUE,
            prompt_rpc_id TEXT NOT NULL UNIQUE,
            content TEXT NOT NULL, content_digest TEXT NOT NULL, title TEXT NOT NULL,
            agent_mode TEXT NOT NULL, project_id TEXT, state TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            CHECK(state IN('prepared','committed')),
            CHECK(agent_mode IN('standard','project-task')),
            CHECK((agent_mode='standard' AND project_id IS NULL)
               OR (agent_mode='project-task' AND project_id IS NOT NULL))
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_dsh_conversation_start_native
           ON dsh_conversation_start(native_session_ref);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_conversation_dsh_session
           ON ai_conversation(dsh_session_ref) WHERE dsh_session_ref IS NOT NULL;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_conversation_dsh_permission
           ON ai_conversation(dsh_permission_session_key) WHERE dsh_permission_session_key IS NOT NULL;",
    ).map_err(|error| database_error("backend-ai-conversation-dsh-schema-migration-failed", error))
}

fn apply_schema_v17(connection: &Connection) -> Result<(), BackendBootstrapError> {
    ensure_column(
        connection,
        "ai_conversation",
        "dsh_provider_binding_digest",
        "dsh_provider_binding_digest TEXT",
    )?;
    ensure_column(
        connection,
        "dsh_conversation_start",
        "provider_binding_digest",
        "provider_binding_digest TEXT",
    )
}

fn refresh_conversation_guards(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection.execute_batch(
        "DROP TRIGGER IF EXISTS dsh_conversation_start_insert_guard;
         DROP TRIGGER IF EXISTS dsh_conversation_start_update_guard;
         CREATE TRIGGER dsh_conversation_start_insert_guard
         BEFORE INSERT ON dsh_conversation_start FOR EACH ROW BEGIN
           SELECT CASE WHEN NEW.provider_binding_digest IS NULL
             OR length(NEW.provider_binding_digest)!=64
             OR NEW.provider_binding_digest GLOB '*[^0-9a-f]*'
             THEN RAISE(ABORT,'dsh-conversation-provider-binding-invalid') END;
         END;
         CREATE TRIGGER dsh_conversation_start_update_guard
         BEFORE UPDATE ON dsh_conversation_start FOR EACH ROW BEGIN
           SELECT CASE
             WHEN NEW.start_ref!=OLD.start_ref OR NEW.conversation_id!=OLD.conversation_id
               OR NEW.native_session_ref!=OLD.native_session_ref
               OR NEW.permission_session_key!=OLD.permission_session_key
               OR NEW.prompt_rpc_id!=OLD.prompt_rpc_id
               OR NEW.provider_binding_digest IS NOT OLD.provider_binding_digest
               OR (NEW.content!=OLD.content AND NOT(OLD.state='prepared' AND NEW.state='committed' AND NEW.content=''))
               OR NEW.content_digest!=OLD.content_digest OR NEW.title!=OLD.title
               OR NEW.agent_mode!=OLD.agent_mode OR NEW.project_id IS NOT OLD.project_id
               OR NEW.created_at!=OLD.created_at
               THEN RAISE(ABORT,'dsh-conversation-start-immutable')
             WHEN NOT(NEW.state=OLD.state OR (OLD.state='prepared' AND NEW.state='committed'))
               THEN RAISE(ABORT,'dsh-conversation-start-transition-invalid') END;
         END;
         DROP TRIGGER IF EXISTS ai_conversation_runtime_kind_insert;
         DROP TRIGGER IF EXISTS ai_conversation_runtime_kind_update;
         CREATE TRIGGER ai_conversation_runtime_kind_insert
         BEFORE INSERT ON ai_conversation FOR EACH ROW BEGIN
           SELECT CASE
             WHEN NEW.runtime_kind NOT IN('legacy','dsh') THEN RAISE(ABORT,'ai-conversation-runtime-kind-invalid')
             WHEN NEW.runtime_kind='legacy' AND (NEW.dsh_session_ref IS NOT NULL
               OR NEW.dsh_permission_session_key IS NOT NULL OR NEW.dsh_provider_binding_digest IS NOT NULL)
               THEN RAISE(ABORT,'ai-conversation-legacy-binding-invalid')
             WHEN NEW.runtime_kind='dsh' AND (NEW.dsh_session_ref IS NULL
               OR NEW.dsh_permission_session_key IS NULL OR length(NEW.dsh_session_ref)=0
               OR length(NEW.dsh_permission_session_key)=0 OR NEW.dsh_provider_binding_digest IS NULL
               OR length(NEW.dsh_provider_binding_digest)!=64
               OR NEW.dsh_provider_binding_digest GLOB '*[^0-9a-f]*')
               THEN RAISE(ABORT,'ai-conversation-dsh-binding-invalid') END;
         END;
         CREATE TRIGGER ai_conversation_runtime_kind_update
         BEFORE UPDATE ON ai_conversation FOR EACH ROW BEGIN
           SELECT CASE
             WHEN OLD.runtime_kind='dsh' AND (NEW.runtime_kind!='dsh'
               OR NEW.dsh_session_ref!=OLD.dsh_session_ref
               OR NEW.dsh_permission_session_key!=OLD.dsh_permission_session_key
               OR NEW.dsh_provider_binding_digest IS NOT OLD.dsh_provider_binding_digest)
               THEN RAISE(ABORT,'ai-conversation-dsh-binding-immutable')
             WHEN OLD.runtime_kind='legacy' AND (NEW.runtime_kind!='legacy'
               OR NEW.dsh_session_ref IS NOT NULL OR NEW.dsh_permission_session_key IS NOT NULL
               OR NEW.dsh_provider_binding_digest IS NOT NULL)
               THEN RAISE(ABORT,'ai-conversation-legacy-binding-immutable')
             WHEN NEW.runtime_kind NOT IN('legacy','dsh') THEN RAISE(ABORT,'ai-conversation-runtime-kind-invalid') END;
         END;",
    ).map_err(|error| database_error("backend-ai-conversation-dsh-schema-migration-failed", error))
}

fn verify_permission_semantics(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection
        .execute_batch("SAVEPOINT dsh_permission_schema_probe;")
        .map_err(|error| database_error("backend-dsh-permission-schema-probe-failed", error))?;
    let result = (|| {
        connection.execute("INSERT INTO dsh_permission_session(session_key,current_generation,transition_revision,phase,pending_generation,created_at,updated_at) VALUES('__compat_permission_probe__',1,1,'active',NULL,'t','t')",[])
            .map_err(|error| database_error("backend-dsh-permission-schema-probe-failed",error))?;
        connection.execute("INSERT INTO dsh_permission_snapshot(session_key,generation,profile,context_kind,capability_manifest_json,capability_digest,composition_digest,activation_state,created_at,activated_at) VALUES('__compat_permission_probe__',1,'read-only','diagnostic','{}',?1,?1,'active','t','t')",["a".repeat(64)])
            .map_err(|error| database_error("backend-dsh-permission-schema-probe-failed",error))?;
        let invalid_profile = connection.execute("INSERT INTO dsh_permission_snapshot(session_key,generation,profile,context_kind,capability_manifest_json,capability_digest,composition_digest,activation_state,created_at) VALUES('__compat_permission_probe__',2,'invalid','diagnostic','{}',?1,?1,'prepared','t')",["b".repeat(64)]).is_err();
        let duplicate_active = connection.execute("INSERT INTO dsh_permission_snapshot(session_key,generation,profile,context_kind,capability_manifest_json,capability_digest,composition_digest,activation_state,created_at) VALUES('__compat_permission_probe__',2,'read-only','diagnostic','{}',?1,?1,'active','t')",["b".repeat(64)]).is_err();
        let state_regression = connection.execute("UPDATE dsh_permission_snapshot SET activation_state='prepared' WHERE session_key='__compat_permission_probe__' AND generation=1",[]).is_err();
        let payload_mutation = connection.execute("UPDATE dsh_permission_snapshot SET profile='workspace-write' WHERE session_key='__compat_permission_probe__' AND generation=1",[]).is_err();
        let bad_pointer = connection.execute("UPDATE dsh_permission_session SET current_generation=999 WHERE session_key='__compat_permission_probe__'",[]).is_err();
        if invalid_profile
            && duplicate_active
            && state_regression
            && payload_mutation
            && bad_pointer
        {
            Ok(())
        } else {
            Err(schema_verification_error(
                "backend-schema-dsh-permission-semantics",
                "dsh_permission_snapshot",
                "required authority constraints are not enforced",
            ))
        }
    })();
    let rollback = connection.execute_batch(
        "ROLLBACK TO dsh_permission_schema_probe; RELEASE dsh_permission_schema_probe;",
    );
    if rollback.is_err() {
        return Err(schema_verification_error(
            "backend-schema-dsh-permission-semantics",
            "dsh_permission_snapshot",
            "schema probe rollback failed",
        ));
    }
    result
}

fn verify_memory_receipt_semantics(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection
        .execute_batch("SAVEPOINT dsh_memory_receipt_schema_probe;")
        .map_err(|error| database_error("backend-dsh-memory-receipt-schema-probe-failed", error))?;
    let result = (|| {
        connection.execute("INSERT INTO dsh_permission_session(session_key,current_generation,transition_revision,phase,pending_generation,created_at,updated_at) VALUES('__compat_receipt_probe__',1,1,'active',NULL,'t','t')",[])
            .map_err(|error| database_error("backend-dsh-memory-receipt-schema-probe-failed",error))?;
        connection.execute("INSERT INTO dsh_permission_snapshot(session_key,generation,profile,context_kind,capability_manifest_json,capability_digest,composition_digest,activation_state,created_at,activated_at) VALUES('__compat_receipt_probe__',1,'read-only','diagnostic','{}',?1,?1,'active','t','t')",["a".repeat(64)])
            .map_err(|error| database_error("backend-dsh-memory-receipt-schema-probe-failed",error))?;
        let insert = |operation_ref: &str, correlation: &str| {
            connection.execute(
            "INSERT INTO dsh_memory_operation_receipt(operation_ref,permission_session_key,permission_generation,native_correlation_digest,operation_kind,request_digest,scope_kind,result_entry_id,result_revision,committed_at) VALUES(?1,'__compat_receipt_probe__',1,?2,'memory-create',?3,'global','result',1,'t')",
            rusqlite::params![operation_ref,correlation,"b".repeat(64)])
        };
        let valid = insert("compat-receipt-1", &"c".repeat(64)).is_ok();
        let duplicate = insert("compat-receipt-2", &"c".repeat(64)).is_err();
        let update = connection.execute("UPDATE dsh_memory_operation_receipt SET result_revision=2 WHERE operation_ref='compat-receipt-1'",[]).is_err();
        let delete = connection
            .execute(
                "DELETE FROM dsh_memory_operation_receipt WHERE operation_ref='compat-receipt-1'",
                [],
            )
            .is_err();
        if valid && duplicate && update && delete {
            Ok(())
        } else {
            Err(schema_verification_error(
                "backend-schema-dsh-memory-receipt-semantics",
                "dsh_memory_operation_receipt",
                "immutable receipt constraints are not enforced",
            ))
        }
    })();
    let rollback = connection.execute_batch(
        "ROLLBACK TO dsh_memory_receipt_schema_probe; RELEASE dsh_memory_receipt_schema_probe;",
    );
    if rollback.is_err() {
        return Err(schema_verification_error(
            "backend-schema-dsh-memory-receipt-semantics",
            "dsh_memory_operation_receipt",
            "schema probe rollback failed",
        ));
    }
    result
}

fn verify_conversation_semantics(connection: &Connection) -> Result<(), BackendBootstrapError> {
    connection
        .execute_batch("SAVEPOINT dsh_conversation_schema_probe;")
        .map_err(|error| {
            database_error("backend-ai-conversation-dsh-schema-probe-failed", error)
        })?;
    let result = (|| {
        let legacy = connection.execute("INSERT INTO ai_conversation(id,title,created_at,updated_at,agent_mode,runtime_kind) VALUES('__compat_legacy__','x','t','t','standard','legacy')",[]).is_ok();
        let dsh = connection.execute("INSERT INTO ai_conversation(id,title,created_at,updated_at,agent_mode,runtime_kind,dsh_session_ref,dsh_permission_session_key,dsh_provider_binding_digest) VALUES('__compat_dsh__','x','t','t','standard','dsh','native-a','permission-a',?1)",["a".repeat(64)]).is_ok();
        let duplicate_session_binding = connection.execute("INSERT INTO ai_conversation(id,title,created_at,updated_at,agent_mode,runtime_kind,dsh_session_ref,dsh_permission_session_key,dsh_provider_binding_digest) VALUES('__compat_duplicate_session__','x','t','t','standard','dsh','native-a','permission-b',?1)",["b".repeat(64)]).is_err();
        let duplicate_permission_binding = connection.execute("INSERT INTO ai_conversation(id,title,created_at,updated_at,agent_mode,runtime_kind,dsh_session_ref,dsh_permission_session_key,dsh_provider_binding_digest) VALUES('__compat_duplicate_permission__','x','t','t','standard','dsh','native-b','permission-a',?1)",["b".repeat(64)]).is_err();
        let forged = connection.execute("UPDATE ai_conversation SET runtime_kind='dsh',dsh_session_ref='n',dsh_permission_session_key='p',dsh_provider_binding_digest=?1 WHERE id='__compat_legacy__'",["b".repeat(64)]).is_err();
        let invalid_dsh = connection.execute("INSERT INTO ai_conversation(id,title,created_at,updated_at,agent_mode,runtime_kind,dsh_session_ref,dsh_permission_session_key,dsh_provider_binding_digest) VALUES('__compat_invalid_dsh__','x','t','t','standard','dsh','native-b','permission-b','invalid')",[]).is_err();
        let start = connection.execute("INSERT INTO dsh_conversation_start(start_ref,conversation_id,native_session_ref,permission_session_key,prompt_rpc_id,provider_binding_digest,content,content_digest,title,agent_mode,state,created_at,updated_at) VALUES('compat-start','compat-conversation','compat-native','compat-permission','compat-rpc',?1,'hello','digest','title','standard','prepared','t','t')",["a".repeat(64)]).is_ok();
        let invalid_start = connection.execute("INSERT INTO dsh_conversation_start(start_ref,conversation_id,native_session_ref,permission_session_key,prompt_rpc_id,provider_binding_digest,content,content_digest,title,agent_mode,state,created_at,updated_at) VALUES('compat-invalid-start','compat-invalid-conversation','compat-invalid-native','compat-invalid-permission','compat-invalid-rpc','invalid','hello','digest','title','standard','prepared','t','t')",[]).is_err();
        let duplicate_start = connection.execute("INSERT INTO dsh_conversation_start(start_ref,conversation_id,native_session_ref,permission_session_key,prompt_rpc_id,provider_binding_digest,content,content_digest,title,agent_mode,state,created_at,updated_at) VALUES('compat-duplicate-start','compat-duplicate-conversation','compat-native','compat-duplicate-permission','compat-duplicate-rpc',?1,'hello','digest','title','standard','prepared','t','t')",["b".repeat(64)]).is_err();
        let commit = connection.execute("UPDATE dsh_conversation_start SET state='committed',content='',updated_at='t2' WHERE start_ref='compat-start'",[]).is_ok();
        let mutate = connection.execute("UPDATE dsh_conversation_start SET prompt_rpc_id='forged' WHERE start_ref='compat-start'",[]).is_err();
        if legacy
            && dsh
            && duplicate_session_binding
            && duplicate_permission_binding
            && forged
            && invalid_dsh
            && start
            && invalid_start
            && duplicate_start
            && commit
            && mutate
        {
            Ok(())
        } else {
            Err(schema_verification_error(
                "backend-schema-ai-conversation-dsh-semantics",
                "ai_conversation",
                "DSH compatibility fences are not enforced",
            ))
        }
    })();
    let rollback = connection.execute_batch(
        "ROLLBACK TO dsh_conversation_schema_probe; RELEASE dsh_conversation_schema_probe;",
    );
    if rollback.is_err() {
        return Err(schema_verification_error(
            "backend-schema-ai-conversation-dsh-semantics",
            "ai_conversation",
            "schema probe rollback failed",
        ));
    }
    result
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use rusqlite::Connection;

    use super::super::BackendServices;

    fn temp_app_data(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "luckyray-schema-compat-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn mutate_schema17_and_expect_failure(
        label: &str,
        mutation: &str,
        expected_code: &'static str,
    ) {
        let root = temp_app_data(label);
        let first = BackendServices::initialize(&root).unwrap();
        let db_path = first.db_path().to_path_buf();
        drop(first);
        let db = Connection::open(&db_path).unwrap();
        db.execute_batch(mutation).unwrap();
        drop(db);

        let error = match BackendServices::initialize(&root) {
            Ok(service) => {
                drop(service);
                panic!("schema 17 mutation {label} must fail closed")
            }
            Err(error) => error,
        };
        assert_eq!(error.code, expected_code, "{label}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fresh_schema_reaches_v19_and_restart_is_idempotent() {
        let root = temp_app_data("fresh");
        let first = BackendServices::initialize(&root).unwrap();
        assert_eq!(first.status().schema_version, 19);
        drop(first);
        let second = BackendServices::initialize(&root).unwrap();
        assert_eq!(second.status().schema_version, 19);
        let db = Connection::open(second.db_path()).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM backend_schema_migration", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
            19
        );
        drop(db);
        drop(second);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn schema18_upgrades_to_smart_folder_definitions_without_result_storage() {
        let root = temp_app_data("schema18-smart-folders");
        let first = BackendServices::initialize(&root).unwrap();
        let db = Connection::open(first.db_path()).unwrap();
        db.execute_batch(
            "DELETE FROM backend_schema_migration WHERE version=19;
             DROP TABLE smart_folder_definition;",
        )
        .unwrap();
        drop(db);
        drop(first);

        let upgraded = BackendServices::initialize(&root).unwrap();
        assert_eq!(upgraded.status().schema_version, 19);
        let db = Connection::open(upgraded.db_path()).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='smart_folder_definition'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name GLOB 'smart_folder_*'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
        let smart_folder_sql: String = db
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='smart_folder_definition'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(smart_folder_sql.contains("'modified-asc'"));
        drop(db);
        drop(upgraded);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_v13_v14_names_reconcile_without_rewriting_history() {
        let root = temp_app_data("legacy-lineage");
        let first = BackendServices::initialize(&root).unwrap();
        let db = Connection::open(first.db_path()).unwrap();
        db.execute_batch(
            "DELETE FROM backend_schema_migration WHERE version>=13;
          DROP TRIGGER dsh_memory_operation_receipt_delete_immutable;
          DROP TRIGGER dsh_memory_operation_receipt_update_immutable;
          DROP INDEX idx_dsh_memory_operation_receipt_idempotency;
          DROP TABLE dsh_memory_operation_receipt;
          DROP TRIGGER dsh_permission_session_current_guard;
          DROP TRIGGER dsh_permission_snapshot_state_transition_guard;
          DROP TRIGGER dsh_permission_snapshot_payload_immutable;
          DROP INDEX idx_dsh_permission_snapshot_active;
          DROP TABLE dsh_permission_snapshot;
          DROP TABLE dsh_permission_session;
          DROP INDEX idx_favorite_item_type_favorited;
          DROP TABLE favorite_item;
          DROP TABLE smart_folder_definition;
          INSERT INTO backend_schema_migration VALUES(13,'agent-turn-control-v2','legacy');
          INSERT INTO backend_schema_migration VALUES(14,'agent-composer-turn-ux-v2','legacy');",
        )
        .unwrap();
        drop(db);
        drop(first);
        let upgraded = BackendServices::initialize(&root).unwrap();
        let db = Connection::open(upgraded.db_path()).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT name FROM backend_schema_migration WHERE version=13",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "agent-turn-control-v2"
        );
        assert_eq!(
            db.query_row(
                "SELECT name FROM backend_schema_migration WHERE version=14",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "agent-composer-turn-ux-v2"
        );
        assert_eq!(upgraded.status().schema_version, 19);
        drop(db);
        drop(upgraded);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_schema17_missing_historical_permission_guard_fails_closed() {
        mutate_schema17_and_expect_failure(
            "missing-v13-guard",
            "DROP TRIGGER dsh_permission_snapshot_state_transition_guard;",
            "backend-schema-lineage-incomplete",
        );
    }

    #[test]
    fn existing_schema17_same_named_weakened_permission_guard_fails_semantic_probe() {
        mutate_schema17_and_expect_failure(
            "weakened-v13-guard",
            "DROP TRIGGER dsh_permission_snapshot_state_transition_guard;
             CREATE TRIGGER dsh_permission_snapshot_state_transition_guard
             BEFORE UPDATE OF activation_state ON dsh_permission_snapshot
             BEGIN SELECT 1; END;",
            "backend-schema-dsh-permission-semantics",
        );
    }

    #[test]
    fn existing_schema17_missing_conversation_index_fails_closed() {
        mutate_schema17_and_expect_failure(
            "missing-v15-index",
            "DROP INDEX idx_dsh_conversation_start_native;",
            "backend-schema-lineage-incomplete",
        );
    }

    #[test]
    fn existing_schema17_same_named_wrong_index_shape_fails_closed() {
        mutate_schema17_and_expect_failure(
            "weakened-v15-index",
            "DROP INDEX idx_dsh_conversation_start_native;
             CREATE INDEX idx_dsh_conversation_start_native
             ON dsh_conversation_start(title);",
            "backend-schema-lineage-incomplete",
        );
    }

    #[test]
    fn existing_schema17_wrong_dsh_session_partial_predicate_fails_semantic_probe() {
        mutate_schema17_and_expect_failure(
            "weakened-v15-session-predicate",
            "DROP INDEX idx_ai_conversation_dsh_session;
             CREATE UNIQUE INDEX idx_ai_conversation_dsh_session
             ON ai_conversation(dsh_session_ref)
             WHERE dsh_session_ref IS NULL;",
            "backend-schema-ai-conversation-dsh-semantics",
        );
    }

    #[test]
    fn existing_schema17_wrong_dsh_permission_partial_predicate_fails_semantic_probe() {
        mutate_schema17_and_expect_failure(
            "weakened-v15-permission-predicate",
            "DROP INDEX idx_ai_conversation_dsh_permission;
             CREATE UNIQUE INDEX idx_ai_conversation_dsh_permission
             ON ai_conversation(dsh_permission_session_key)
             WHERE dsh_permission_session_key IS NULL;",
            "backend-schema-ai-conversation-dsh-semantics",
        );
    }

    #[test]
    fn existing_schema17_same_named_weakened_provider_guard_fails_semantic_probe() {
        mutate_schema17_and_expect_failure(
            "weakened-v17-guard",
            "DROP TRIGGER dsh_conversation_start_insert_guard;
             CREATE TRIGGER dsh_conversation_start_insert_guard
             BEFORE INSERT ON dsh_conversation_start
             BEGIN SELECT 1; END;",
            "backend-schema-ai-conversation-dsh-semantics",
        );
    }

    #[test]
    fn supplied_schema17_database_copy_opens_read_write_and_restarts() {
        let Some(source) = std::env::var_os("LUCKYRAY_SCHEMA17_FIXTURE_DB") else {
            return;
        };
        let root = temp_app_data("real-copy");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::copy(source, root.join("luckyray.db")).unwrap();
        let before = std::fs::metadata(root.join("luckyray.db")).unwrap().len();
        let first = BackendServices::initialize(&root).unwrap();
        assert_eq!(first.status().schema_version, 19);
        drop(first);
        let second = BackendServices::initialize(&root).unwrap();
        assert_eq!(second.status().schema_version, 19);
        let db = Connection::open(second.db_path()).unwrap();
        assert_eq!(
            db.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert!(std::fs::metadata(root.join("luckyray.db")).unwrap().len() >= before);
        drop(db);
        drop(second);
        std::fs::remove_dir_all(root).unwrap();
    }
}
