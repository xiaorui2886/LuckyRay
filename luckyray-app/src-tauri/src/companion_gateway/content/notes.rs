use super::*;
use crate::knowledge::{
    companion_attachment_links, CompanionLinkSyntax, KnowledgeDocumentRef,
    KnowledgeDocumentSnapshot, KnowledgeTargetIdentity,
};
use std::collections::HashSet;
mod uploads;
use crate::knowledge::{
    companion_note_name, companion_replaced_content, KnowledgeCreateInput, KnowledgeDeleteInput,
    KnowledgeError, KnowledgeMoveInput, KnowledgeWriteInput,
};

fn knowledge_error(error: KnowledgeError) -> (u16, &'static str) {
    match error.code {
        "knowledge-revision-conflict" | "knowledge-name-conflict" | "knowledge-not-found" => {
            (409, "REVISION_CONFLICT")
        }
        "knowledge-desktop-draft-busy" => (503, "DESKTOP_DRAFT_BUSY"),
        "knowledge-invalid-title" | "knowledge-path-invalid" => (400, "NOTE_INPUT_INVALID"),
        _ => (409, "KNOWLEDGE_CHANGED"),
    }
}

#[derive(Default)]
pub(crate) struct ContentState {
    reconciled: HashMap<String, Instant>,
    search: HashMap<String, Vec<(String, String)>>,
    /// Relative paths whose last scan failed on their own bytes. A single-note
    /// read answers from the retained projection instead of failing the whole
    /// sync loop; a write still cannot proceed without reading the real file.
    unreadable: HashMap<String, HashSet<String>>,
}

pub(crate) fn apply_schema(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE companion_content_note (
        vault_key TEXT NOT NULL, note_id TEXT NOT NULL, path TEXT NOT NULL, revision TEXT NOT NULL,
        file_revision TEXT NOT NULL, object_id TEXT, summary TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(vault_key,note_id));
        CREATE UNIQUE INDEX companion_content_active_path ON companion_content_note(vault_key,path) WHERE deleted=0;
        CREATE TABLE companion_content_change (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, vault_key TEXT NOT NULL, note_id TEXT NOT NULL,
        revision TEXT NOT NULL, deleted INTEGER NOT NULL, at TEXT NOT NULL);
        CREATE INDEX companion_content_change_vault ON companion_content_change(vault_key,seq);
        CREATE TABLE companion_content_cursor (vault_key TEXT PRIMARY KEY, floor INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE companion_content_operation (
        device_id TEXT NOT NULL, op_id TEXT NOT NULL, vault_key TEXT NOT NULL, note_id TEXT NOT NULL,
        payload TEXT NOT NULL, before_document TEXT, stage TEXT NOT NULL, result TEXT,
        created_at TEXT NOT NULL, PRIMARY KEY(device_id,op_id));
        CREATE TABLE companion_content_upload (
        device_id TEXT NOT NULL, op_id TEXT NOT NULL, vault_key TEXT NOT NULL, note_id TEXT NOT NULL,
        manifest TEXT NOT NULL, committed_bytes INTEGER NOT NULL DEFAULT 0, receipt TEXT,
        PRIMARY KEY(device_id,op_id));")
}

fn db_error(_: rusqlite::Error) -> (u16, &'static str) {
    (503, "CONTENT_STORE_UNAVAILABLE")
}

fn database(gateway: &CompanionGateway) -> ContentResult<Connection> {
    open_connection(gateway.backend.db_path()).map_err(|_| (503, "CONTENT_STORE_UNAVAILABLE"))
}

pub(super) fn invalidate_service_reconcile(gateway: &CompanionGateway, vault_id: &str) {
    if let Ok(mut state) = gateway.content_state.lock() {
        state.reconciled.remove(vault_id);
    }
}

/// Preserve Content V1's stable note identity when the Services adapter uses
/// KnowledgeService's physical move authority. A move may replace the file
/// identity, so ordinary reconciliation cannot always infer this rename.
pub(super) fn remap_moved_note_for_service(
    gateway: &CompanionGateway, vault_id: &str, note_id: &str,
    relative_path: &str, file_revision: &str,
) -> ContentResult<String> {
    let mut db = database(gateway)?;
    let transaction = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
    let mut summary: Value = transaction.query_row(
        "SELECT summary FROM companion_content_note WHERE vault_key=?1 AND note_id=?2",
        params![vault_id, note_id], |row| row.get::<_, String>(0),
    ).optional().map_err(db_error)?.and_then(|text| serde_json::from_str(&text).ok())
        .ok_or((404, "NOTE_DELETED"))?;
    let updated_revision = revision(relative_path, file_revision);
    if let Some(other) = transaction.query_row(
        "SELECT note_id FROM companion_content_note WHERE vault_key=?1 AND path=?2 AND deleted=0",
        params![vault_id, relative_path], |row| row.get::<_, String>(0),
    ).optional().map_err(db_error)? {
        if other != note_id {
            transaction.execute(
                "UPDATE companion_content_note SET deleted=1 WHERE vault_key=?1 AND note_id=?2",
                params![vault_id, other],
            ).map_err(db_error)?;
            change(&transaction, vault_id, &other, &updated_revision, true)?;
        }
    }
    summary["relativePath"] = json!(relative_path);
    summary["revision"] = json!(updated_revision);
    transaction.execute(
        "UPDATE companion_content_note SET path=?1,revision=?2,file_revision=?3,summary=?4,deleted=0
         WHERE vault_key=?5 AND note_id=?6",
        params![relative_path, updated_revision, file_revision, summary.to_string(), vault_id, note_id],
    ).map_err(db_error)?;
    change(&transaction, vault_id, note_id, &updated_revision, false)?;
    transaction.commit().map_err(db_error)?;
    invalidate_service_reconcile(gateway, vault_id);
    if let Ok(registration) = gateway.backend.knowledge().current_vault_id() {
        gateway.backend.knowledge().notify_companion_committed(&registration, vec![relative_path.into()]);
    }
    Ok(updated_revision)
}

pub(crate) fn target(gateway: &CompanionGateway) -> ContentResult<(KnowledgeTargetIdentity, String)> {
    let target = gateway
        .backend
        .knowledge()
        .current_target_identity()
        .map_err(|_| (409, "VAULT_UNAVAILABLE"))?;
    let key = format!(
        "vault-{:x}",
        Sha256::digest(format!("{}:{}", target.target_id, target.identity_digest))
    );
    Ok((target, key))
}

fn revision(path: &str, file_revision: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{}:{path}{file_revision}", path.len()))
    )
}

#[derive(Clone)]
struct Entry {
    id: String,
    path: String,
    revision: String,
    object: Option<String>,
    deleted: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Mutation {
    op_id: String,
    note_id: Option<String>,
    vault_id: String,
    kind: String,
    expected_revision: Option<String>,
    title: Option<String>,
    content: Option<String>,
    parent_relative_path: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    before: Option<KnowledgeDocumentSnapshot>,
    planned_path: String,
    old_object: Option<String>,
    desired_content: Option<String>,
    #[serde(default)]
    created_object: Option<String>,
}

fn direct_document(
    gateway: &CompanionGateway,
    target: &KnowledgeTargetIdentity,
    path: &str,
) -> Result<KnowledgeDocumentSnapshot, KnowledgeError> {
    let knowledge = gateway.backend.knowledge();
    let reference = KnowledgeDocumentRef {
        vault_id: knowledge.current_vault_id()?,
        relative_path: path.to_owned(),
    };
    knowledge.read_document_for_target(target, &reference)
}

pub(in crate::companion_gateway) fn mutate_route(
    gateway: &CompanionGateway,
    request: &HttpRequest,
) -> ContentResult<Value> {
    mutate(gateway, request, false)
}

/// New Services operation reuses the Content journal without widening Content V1.
pub(crate) fn mutate_unique_route(gateway: &CompanionGateway, request: &HttpRequest) -> ContentResult<Value> {
    mutate(gateway, request, true)
}

fn mutate(gateway: &CompanionGateway, request: &HttpRequest, unique_create: bool) -> ContentResult<Value> {
    if request.path.contains("/attachments/") {
        return uploads::route(gateway, request);
    }
    query(&request.path, &[])?;
    let input: Mutation =
        serde_json::from_slice(&request.body).map_err(|_| (400, "NOTE_INPUT_INVALID"))?;
    if unique_create && (input.kind != "create" || input.expected_revision.as_ref().is_some_and(|value| !value.is_empty())) {
        return Err((400, "NOTE_INPUT_INVALID"));
    }
    if !valid_id(&input.op_id) {
        return Err((400, "OP_ID_INVALID"));
    }
    if input
        .note_id
        .as_ref()
        .is_some_and(|id| !id.starts_with("kn-") || !valid_id(id))
    {
        return Err((400, "NOTE_INPUT_INVALID"));
    }
    let route_id = request.path.strip_prefix("/v1/notes/");
    if !matches!(
        (
            request.method.as_str(),
            input.kind.as_str(),
            route_id.is_some()
        ),
        ("POST", "create", false)
            | ("PATCH", "update" | "rename", true)
            | ("DELETE", "delete", true)
    ) {
        return Err((405, "METHOD_NOT_ALLOWED"));
    }
    if route_id.is_some_and(|id| !valid_id(id)) {
        return Err((400, "NOTE_INPUT_INVALID"));
    }
    if input
        .content
        .as_ref()
        .is_some_and(|s| s.len() > 4 * 1024 * 1024)
    {
        return Err((413, "NOTE_TOO_LARGE"));
    }
    let device = presented_device_id(request).ok_or((401, "PAIRING_REQUIRED"))?;
    let (target, vault) = target(gateway)?;
    if input.vault_id != vault {
        return Err((409, "VAULT_CHANGED"));
    }
    let serialized = serde_json::to_string(&input).map_err(|_| (400, "NOTE_INPUT_INVALID"))?;
    let payload = if unique_create { format!("unique:{serialized}") } else { serialized };
    let mut state = gateway
        .content_state
        .lock()
        .map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
    let mut db = database(gateway)?;
    let stored: Option<(String, String, String, Option<String>)> = db.query_row(
        "SELECT note_id,payload,before_document,result FROM companion_content_operation WHERE device_id=?1 AND op_id=?2",
        params![device, input.op_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).optional().map_err(db_error)?;
    let (id, mut plan, retry) = if let Some((id, old_payload, plan, result)) = stored {
        if old_payload != payload || route_id.is_some_and(|route| route != id) {
            return Err((409, "OP_ID_REUSED"));
        }
        if let Some(result) = result {
            return serde_json::from_str(&result).map_err(|_| (503, "CONTENT_STORE_UNAVAILABLE"));
        }
        (
            id,
            serde_json::from_str::<Plan>(&plan).map_err(|_| (503, "CONTENT_STORE_UNAVAILABLE"))?,
            true,
        )
    } else {
        state.reconciled.remove(&vault);
        reconcile(gateway, &target, &vault, &mut state)?;
        let knowledge = gateway.backend.knowledge();
        let id = route_id
            .map(str::to_owned)
            .or(input.note_id.clone())
            .unwrap_or_else(|| format!("kn-{}", random_hex(16)));
        if input.kind == "create"
            && db
                .query_row(
                    "SELECT COUNT(*) FROM companion_content_note WHERE vault_key=?1 AND note_id=?2",
                    params![vault, id],
                    |r| r.get::<_, u32>(0),
                )
                .map_err(db_error)?
                > 0
        {
            return Err((409, "REVISION_CONFLICT"));
        }
        let before = if input.kind == "create" {
            None
        } else {
            Some(
                current_document(gateway, &target, &vault, &id)
                    .map_err(|_| (409, "REVISION_CONFLICT"))?,
            )
        };
        if before.as_ref().is_some_and(|before| {
            input.expected_revision.as_deref()
                != Some(&revision(&before.summary.relative_path, &before.revision))
        }) {
            return Err((409, "REVISION_CONFLICT"));
        }
        let planned_path = if matches!(input.kind.as_str(), "create" | "rename") {
            let name =
                companion_note_name(input.title.as_deref().ok_or((400, "NOTE_INPUT_INVALID"))?)
                    .map_err(knowledge_error)?;
            let parent = if input.kind == "create" {
                Path::new(input.parent_relative_path.as_deref().unwrap_or(""))
            } else {
                before
                    .as_ref()
                    .and_then(|d| Path::new(&d.summary.relative_path).parent())
                    .unwrap_or_else(|| Path::new(""))
            };
            parent.join(name).to_string_lossy().replace('\\', "/")
        } else {
            before.as_ref().unwrap().summary.relative_path.clone()
        };
        if input.kind == "create" && !unique_create && direct_document(gateway, &target, &planned_path).is_ok() {
            return Err((409, "REVISION_CONFLICT"));
        }
        let desired_content = match input.kind.as_str() {
            "create" => Some(input.content.clone().unwrap_or_default()),
            "update" => Some(
                companion_replaced_content(
                    &before.as_ref().unwrap().content,
                    input
                        .content
                        .as_deref()
                        .ok_or((400, "NOTE_INPUT_INVALID"))?,
                )
                .map_err(knowledge_error)?,
            ),
            _ => None,
        };
        let old_object = before
            .as_ref()
            .map(|doc| knowledge.companion_document_identity(&doc.summary.document_ref, &target))
            .transpose()
            .map_err(knowledge_error)?
            .flatten();
        let plan = Plan {
            before,
            planned_path,
            old_object,
            desired_content,
            created_object: None,
        };
        db.execute("INSERT INTO companion_content_operation(device_id,op_id,vault_key,note_id,payload,before_document,stage,created_at) VALUES(?1,?2,?3,?4,?5,?6,'intent',?7)",
            params![device, input.op_id, vault, id, payload, serde_json::to_string(&plan).unwrap(), chrono::Utc::now().to_rfc3339()]).map_err(db_error)?;
        (id, plan, false)
    };
    let knowledge = gateway.backend.knowledge();
    let before_ref = plan
        .before
        .as_ref()
        .map(|d| d.summary.document_ref.clone())
        .unwrap_or(KnowledgeDocumentRef {
            vault_id: knowledge.current_vault_id().map_err(knowledge_error)?,
            relative_path: plan.planned_path.clone(),
        });
    // An intent is durable before the existing Knowledge write begins. Recovery
    // only accepts an observed postcondition; it never retries over a third state.
    let observed = direct_document(gateway, &target, &plan.planned_path);
    let recovered = if retry {
        match input.kind.as_str() {
            "create" | "update" => observed
                .as_ref()
                .ok()
                .filter(|doc| Some(&doc.content) == plan.desired_content.as_ref())
                .filter(|doc| !unique_create || plan.created_object.is_some()
                    && knowledge.companion_document_identity(&doc.summary.document_ref, &target)
                        .ok().flatten() == plan.created_object)
                .cloned(),
            "rename" => observed
                .as_ref()
                .ok()
                .filter(|doc| {
                    plan.old_object.is_some()
                        && knowledge
                            .companion_document_identity(&doc.summary.document_ref, &target)
                            .ok()
                            .flatten()
                            == plan.old_object
                })
                .cloned(),
            _ => None,
        }
    } else {
        None
    };
    let deleted_recovered = retry
        && input.kind == "delete"
        && observed
            .as_ref()
            .is_err_and(|e| e.code == "knowledge-not-found");
    if unique_create && retry && plan.created_object.is_some() && recovered.is_none() {
        // A staged publish with no verifiable postcondition is uncertain. Never
        // create another file or claim a third-party file under the same opId.
        return Err((503, "CONTENT_STORE_UNAVAILABLE"));
    }
    let document = if let Some(doc) = recovered {
        Some(doc)
    } else if deleted_recovered {
        None
    } else if unique_create {
        let outcome = knowledge.create_unique_document_for_target(&target, &KnowledgeCreateInput {
            title: input.title.clone().ok_or((400, "NOTE_INPUT_INVALID"))?,
            content: plan.desired_content.clone().unwrap_or_default(),
            parent_relative_path: input.parent_relative_path.clone(),
        }, |path, object| {
            plan.planned_path = path.to_owned();
            plan.created_object = Some(object.to_owned());
            db.execute("UPDATE companion_content_operation SET before_document=?3 WHERE device_id=?1 AND op_id=?2 AND stage='intent'",
                params![device, input.op_id, serde_json::to_string(&plan).unwrap()])
                .map_err(|_| KnowledgeError { code: "knowledge-operation-unavailable", message: "Cannot journal unique creation".into() })?;
            Ok(())
        });
        match outcome {
            Ok(result) => Some(result.document),
            Err(failure) => {
                if failure.code == "knowledge-unique-create-uncertain" {
                    return Err((503, "CONTENT_STORE_UNAVAILABLE"));
                }
                // Domain failures before a successful publish confirm no file
                // was created. Keep payload/id but permit a safe same-op retry.
                plan.created_object = None;
                db.execute("UPDATE companion_content_operation SET before_document=?3 WHERE device_id=?1 AND op_id=?2 AND stage='intent'",
                    params![device, input.op_id, serde_json::to_string(&plan).unwrap()]).map_err(db_error)?;
                return Err(knowledge_error(failure));
            }
        }
    } else {
        if let Some(before) = &plan.before {
            let current = direct_document(gateway, &target, &before.summary.relative_path)
                .map_err(|_| (409, "REVISION_CONFLICT"))?;
            if current.revision != before.revision {
                return Err((409, "REVISION_CONFLICT"));
            }
        }
        knowledge
            .with_companion_draft_guard(&before_ref, || match input.kind.as_str() {
                "create" => knowledge
                    .create_document_for_target(
                        &target,
                        &KnowledgeCreateInput {
                            title: input.title.clone().unwrap(),
                            content: plan.desired_content.clone().unwrap(),
                            parent_relative_path: input.parent_relative_path.clone(),
                        },
                    )
                    .map(|r| Some(r.document)),
                "update" => knowledge
                    .replace_document_for_target(
                        &target,
                        &KnowledgeWriteInput {
                            document_ref: before_ref.clone(),
                            content: plan.desired_content.clone().unwrap(),
                            expected_revision: Some(plan.before.as_ref().unwrap().revision.clone()),
                        },
                    )
                    .map(|r| Some(r.document)),
                "rename" => knowledge
                    .move_document_for_target(
                        &target,
                        &KnowledgeMoveInput {
                            document_ref: before_ref.clone(),
                            title: input.title.clone().unwrap(),
                            expected_revision: plan.before.as_ref().unwrap().revision.clone(),
                            parent_relative_path: None,
                        },
                    )
                    .map(Some),
                "delete" => knowledge
                    .delete_document_for_target(
                        &target,
                        &KnowledgeDeleteInput {
                            document_ref: before_ref.clone(),
                            expected_revision: plan.before.as_ref().unwrap().revision.clone(),
                        },
                    )
                    .map(|_| None),
                _ => unreachable!(),
            })
            .map_err(knowledge_error)?
    };
    let value = if let Some(doc) = &document {
        document_value(gateway, &vault, &id, doc)?
    } else {
        json!({"noteId": id, "vaultId": vault, "deleted": true, "revision": input.expected_revision})
    };
    let rev = value["revision"].as_str().unwrap_or("");
    let object = document
        .as_ref()
        .map(|doc| knowledge.companion_document_identity(&doc.summary.document_ref, &target))
        .transpose()
        .map_err(knowledge_error)?
        .flatten();
    let transaction = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    if let Some(doc) = &document {
        let mut summary = value.clone();
        summary.as_object_mut().unwrap().remove("content");
        summary.as_object_mut().unwrap().remove("resources");
        transaction.execute("INSERT INTO companion_content_note(vault_key,note_id,path,revision,file_revision,object_id,summary,deleted)
            VALUES(?1,?2,?3,?4,?5,?6,?7,0) ON CONFLICT(vault_key,note_id) DO UPDATE SET path=excluded.path,revision=excluded.revision,file_revision=excluded.file_revision,object_id=excluded.object_id,summary=excluded.summary,deleted=0",
            params![vault, id, doc.summary.relative_path, rev, doc.revision, object, summary.to_string()]).map_err(db_error)?;
    } else {
        transaction
            .execute(
                "UPDATE companion_content_note SET deleted=1 WHERE vault_key=?1 AND note_id=?2",
                params![vault, id],
            )
            .map_err(db_error)?;
    }
    change(&transaction, &vault, &id, rev, document.is_none())?;
    let result = json!({"opId": input.op_id, "document": value});
    transaction.execute("UPDATE companion_content_operation SET stage='completed',result=?3 WHERE device_id=?1 AND op_id=?2", params![device, input.op_id, result.to_string()]).map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    state.reconciled.remove(&vault);
    let mut changed_paths = vec![plan.planned_path.clone()];
    if let Some(before) = &plan.before {
        if before.summary.relative_path != plan.planned_path { changed_paths.push(before.summary.relative_path.clone()); }
    }
    knowledge.notify_companion_committed(&before_ref.vault_id, changed_paths);
    knowledge
        .with_current_target_response_lease(&target, || result)
        .map_err(|_| (409, "VAULT_CHANGED"))
}

fn read_entries(db: &Connection, vault: &str) -> ContentResult<Vec<Entry>> {
    let mut statement = db.prepare("SELECT note_id,path,revision,object_id,deleted FROM companion_content_note WHERE vault_key=?1").map_err(db_error)?;
    let entries = statement
        .query_map([vault], |row| {
            Ok(Entry {
                id: row.get(0)?,
                path: row.get(1)?,
                revision: row.get(2)?,
                object: row.get(3)?,
                deleted: row.get(4)?,
            })
        })
        .map_err(db_error)?;
    entries.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

/// Projection lookup after the ordinary Content read has reconciled this target.
pub(crate) fn service_note_paths(gateway: &CompanionGateway, vault: &str) -> ContentResult<HashMap<String, String>> {
    Ok(read_entries(&database(gateway)?, vault)?.into_iter().filter(|entry| !entry.deleted)
        .map(|entry| (entry.path, entry.id)).collect())
}

pub(crate) fn service_vault_note_paths(gateway: &CompanionGateway, vault: &str)
    -> ContentResult<(KnowledgeTargetIdentity, HashMap<String, String>)> {
    let (expected, current) = target(gateway)?;
    if current != vault { return Err((409, "VAULT_CHANGED")); }
    let mut state = gateway.content_state.lock().map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
    reconcile(gateway, &expected, vault, &mut state)?;
    Ok((expected, service_note_paths(gateway, vault)?))
}

pub(crate) fn service_note_reference(gateway: &CompanionGateway, vault: &str, note: &str)
    -> ContentResult<(KnowledgeTargetIdentity, KnowledgeDocumentRef)> {
    let (expected, current) = target(gateway)?;
    if current != vault { return Err((409, "VAULT_CHANGED")); }
    let mut state = gateway.content_state.lock().map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
    reconcile(gateway, &expected, vault, &mut state)?;
    let path: String = database(gateway)?.query_row(
        "SELECT path FROM companion_content_note WHERE vault_key=?1 AND note_id=?2 AND deleted=0",
        params![vault, note], |row| row.get(0)).optional().map_err(db_error)?.ok_or((404, "NOTE_DELETED"))?;
    let reference = KnowledgeDocumentRef { vault_id: gateway.backend.knowledge().current_vault_id().map_err(knowledge_error)?, relative_path: path };
    Ok((expected, reference))
}

pub(crate) fn service_note_context(gateway: &CompanionGateway, vault: &str, note: &str, request: &HttpRequest)
    -> ContentResult<(KnowledgeTargetIdentity, KnowledgeDocumentSnapshot, String)> {
    let legacy = HttpRequest { method: "GET".into(), path: format!("/v1/notes/{note}?vault={vault}"), headers: request.headers.clone(), body: Vec::new() };
    let detail = read_route(gateway, &legacy)?;
    let (expected, current) = target(gateway)?;
    if current != vault { return Err((409, "VAULT_CHANGED")); }
    let path = detail["relativePath"].as_str().ok_or((503, "CONTENT_STORE_UNAVAILABLE"))?;
    let snapshot = direct_document(gateway, &expected, path).map_err(knowledge_error)?;
    let current_revision = revision(path, &snapshot.revision);
    if detail["revision"].as_str() != Some(&current_revision) { return Err((409, "REVISION_CONFLICT")); }
    Ok((expected, snapshot, current_revision))
}

/// The index reports per-document failures alongside a whole-vault `stale`
/// flag. Only failures that stay attributable to one named document may be
/// isolated; anything that could hide other documents (a failed directory
/// walk, a skipped reparse-point subtree, a permission problem, an
/// unattributable failure) must keep the whole projection unavailable.
///
/// `knowledge-encoding-unsupported` is the one bounded case: the file was
/// enumerated, opened and read successfully — only its text is not UTF-8. It
/// cannot conceal any other document, so the healthy library stays usable and
/// the named path is protected from a false deletion instead. An already
/// indexed file keeps its retained entry (stable ID, last confirmed revision);
/// a never-indexed file is simply absent until it becomes readable again.
///
/// `stale` is derived from `stale_document_retained`, which only those parse
/// failures set. A stale snapshot that no isolatable failure explains means the
/// index is holding state we cannot account for — that stays fatal.
fn unreadable_paths(
    snapshot: &crate::knowledge::KnowledgeIndexSnapshot,
) -> ContentResult<HashSet<String>> {
    if snapshot.refresh_error.is_some() {
        return Err((503, "KNOWLEDGE_INDEX_INCOMPLETE"));
    }
    let mut paths = HashSet::new();
    let mut explained_stale = false;
    for failure in &snapshot.errors {
        match failure.code.as_str() {
            "knowledge-encoding-unsupported" => {
                paths.insert(failure.relative_path.clone());
                explained_stale |= failure.stale_document_retained;
            }
            _ => return Err((503, "KNOWLEDGE_INDEX_INCOMPLETE")),
        }
    }
    if snapshot.stale && !explained_stale {
        return Err((503, "KNOWLEDGE_INDEX_INCOMPLETE"));
    }
    Ok(paths)
}

/// The existing Knowledge index handles actual filesystem reconciliation. This
/// durable projection records identity and changes, never a second editable body.
fn reconcile(
    gateway: &CompanionGateway,
    target: &KnowledgeTargetIdentity,
    vault: &str,
    state: &mut ContentState,
) -> ContentResult<()> {
    if state
        .reconciled
        .get(vault)
        .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
    {
        return Ok(());
    }
    let knowledge = gateway.backend.knowledge();
    let snapshot = knowledge
        .refresh_index_for_target(target)
        .map_err(|_| (503, "KNOWLEDGE_UNAVAILABLE"))?;
    // One unreadable document must not take the whole library offline, but an
    // incomplete scan must never be read as "these files are gone".
    let unreadable = unreadable_paths(&snapshot)?;
    state.unreadable.insert(vault.to_owned(), unreadable.clone());
    state.search.insert(
        vault.into(),
        snapshot
            .documents
            .iter()
            .map(|doc| {
                (
                    doc.relative_path.clone(),
                    format!("{}\n{}\n{}", doc.title, doc.relative_path, doc.plain_text)
                        .to_lowercase(),
                )
            })
            .collect(),
    );
    let mut db = database(gateway)?;
    let entries = read_entries(&db, vault)?;
    let mut pending_statement = db.prepare("SELECT note_id,before_document,payload FROM companion_content_operation WHERE vault_key=?1 AND stage='intent'").map_err(db_error)?;
    let pending = pending_statement
        .query_map([vault], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(pending_statement);
    let reservations = pending
        .into_iter()
        .filter_map(|(id, text, payload)| {
            serde_json::from_str::<Plan>(&text)
                .ok()
                .filter(|p| p.before.is_none() && (!payload.starts_with("unique:") || p.created_object.is_some()))
                .map(|p| (p.planned_path, (id, p.desired_content.unwrap_or_default(), p.created_object)))
        })
        .collect::<HashMap<_, _>>();
    let paths = snapshot
        .documents
        .iter()
        .map(|doc| doc.relative_path.as_str())
        .collect::<HashSet<_>>();
    let active_paths = entries
        .iter()
        .filter(|e| !e.deleted)
        .map(|e| (e.path.as_str(), e))
        .collect::<HashMap<_, _>>();
    let mut missing_objects: HashMap<&str, Vec<&Entry>> = HashMap::new();
    for entry in entries
        .iter()
        .filter(|e| !e.deleted && !paths.contains(e.path.as_str()))
    {
        if let Some(object) = entry.object.as_deref() {
            missing_objects.entry(object).or_default().push(entry);
        }
    }
    let mut seen = HashSet::new();
    let mut updates = Vec::new();
    for doc in &snapshot.documents {
        let rev = revision(&doc.relative_path, &doc.revision);
        let at_path = active_paths.get(doc.relative_path.as_str()).copied();
        if let Some(entry) = at_path.filter(|e| e.revision == rev) {
            seen.insert(entry.id.clone());
            continue;
        }
        // A retained entry for a currently unreadable file keeps its stable
        // identity and last confirmed revision: re-deriving it would let a
        // replaced file inherit the old note's ID, and re-projecting the
        // retained document as fresh would claim a revision nobody verified.
        if unreadable.contains(&doc.relative_path) {
            if let Some(entry) = at_path {
                seen.insert(entry.id.clone());
            }
            continue;
        }
        let object = knowledge
            .companion_document_identity(&doc.document_ref, target)
            .map_err(|_| (503, "KNOWLEDGE_CHANGING"))?;
        let renamed = object
            .as_deref()
            .and_then(|object| missing_objects.get(object))
            .filter(|rows| rows.len() == 1)
            .map(|rows| rows[0]);
        let reserved = reservations
            .get(&doc.relative_path)
            .filter(|(_, content, expected_object)| {
                format!("{:x}", Sha256::digest(content.as_bytes())) == doc.revision
                    && expected_object.as_ref().is_none_or(|expected| Some(expected) == object.as_ref())
            })
            .map(|(id, _, _)| id.clone());
        let id = at_path
            .or(renamed)
            .map(|e| e.id.clone())
            .or(reserved)
            .unwrap_or_else(|| format!("kn-{}", random_hex(16)));
        seen.insert(id.clone());
        let value = json!({"noteId": id, "vaultId": vault, "title": doc.title, "relativePath": doc.relative_path,
            "revision": rev, "updatedAt": doc.modified_at, "sizeBytes": doc.size, "tags": doc.tags});
        updates.push((
            id,
            doc.relative_path.clone(),
            rev,
            doc.revision.clone(),
            object,
            value.to_string(),
        ));
    }
    // All filesystem observations precede this short metadata transaction.
    let transaction = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    // An unreadable path proves nothing about deletion, so its entry is never
    // tombstoned here; a genuinely removed file produces no parse failure and
    // still propagates as a real deletion.
    for entry in entries.iter().filter(|e| {
        !e.deleted && !seen.contains(&e.id) && !unreadable.contains(e.path.as_str())
    }) {
        transaction
            .execute(
                "UPDATE companion_content_note SET deleted=1 WHERE vault_key=?1 AND note_id=?2",
                params![vault, entry.id],
            )
            .map_err(db_error)?;
        change(&transaction, vault, &entry.id, &entry.revision, true)?;
    }
    for (id, path, rev, file_rev, object, summary) in updates {
        transaction.execute("INSERT INTO companion_content_note(vault_key,note_id,path,revision,file_revision,object_id,summary,deleted)
            VALUES(?1,?2,?3,?4,?5,?6,?7,0) ON CONFLICT(vault_key,note_id) DO UPDATE SET
            path=excluded.path,revision=excluded.revision,file_revision=excluded.file_revision,object_id=excluded.object_id,summary=excluded.summary,deleted=0",
            params![vault, id, path, rev, file_rev, object, summary]).map_err(db_error)?;
        change(&transaction, vault, &id, &rev, false)?;
    }
    transaction
        .execute(
            "INSERT OR IGNORE INTO companion_content_cursor(vault_key,floor) VALUES(?1,0)",
            [vault],
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    knowledge
        .with_current_target_response_lease(target, || ())
        .map_err(|_| (409, "VAULT_CHANGED"))?;
    state.reconciled.insert(vault.to_owned(), Instant::now());
    Ok(())
}

fn change(
    db: &Connection,
    vault: &str,
    id: &str,
    revision: &str,
    deleted: bool,
) -> ContentResult<()> {
    db.execute("INSERT INTO companion_content_change(vault_key,note_id,revision,deleted,at) VALUES(?1,?2,?3,?4,?5)",
        params![vault, id, revision, deleted, chrono::Utc::now().to_rfc3339()]).map_err(db_error)?;
    Ok(())
}

fn current_document(
    gateway: &CompanionGateway,
    target: &KnowledgeTargetIdentity,
    vault: &str,
    id: &str,
) -> ContentResult<KnowledgeDocumentSnapshot> {
    if !valid_id(id) {
        return Err((404, "NOTE_NOT_FOUND"));
    }
    let db = database(gateway)?;
    let path: Option<String> = db.query_row("SELECT path FROM companion_content_note WHERE vault_key=?1 AND note_id=?2 AND deleted=0", params![vault, id], |r| r.get(0)).optional().map_err(db_error)?;
    let document_ref = KnowledgeDocumentRef {
        vault_id: gateway
            .backend
            .knowledge()
            .current_vault_id()
            .map_err(|_| (409, "VAULT_CHANGED"))?,
        relative_path: path.ok_or((404, "NOTE_DELETED"))?,
    };
    gateway
        .backend
        .knowledge()
        .read_document_for_target(target, &document_ref)
        .map_err(|_| (409, "NOTE_CHANGED"))
}

/// The projected relative path for a note id, if it is currently known.
fn current_note_path(gateway: &CompanionGateway, vault: &str, id: &str) -> Option<String> {
    if !valid_id(id) {
        return None;
    }
    database(gateway)
        .ok()?
        .query_row(
            "SELECT path FROM companion_content_note WHERE vault_key=?1 AND note_id=?2 AND deleted=0",
            params![vault, id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
}

/// The retained projection for a note whose file this process cannot decode.
/// Identity, title, path and last confirmed revision are real recorded facts;
/// `content` is deliberately absent so no client treats it as readable text.
fn unreadable_note_value(
    gateway: &CompanionGateway,
    vault: &str,
    id: &str,
) -> ContentResult<Value> {
    let summary: String = database(gateway)?
        .query_row(
            "SELECT summary FROM companion_content_note WHERE vault_key=?1 AND note_id=?2 AND deleted=0",
            params![vault, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or((404, "NOTE_NOT_FOUND"))?;
    let mut value: Value = serde_json::from_str(&summary)
        .map_err(|_| (503, "CONTENT_STORE_UNAVAILABLE"))?;
    if let Some(object) = value.as_object_mut() {
        object.remove("content");
        object.remove("resources");
    }
    Ok(value)
}

fn document_value(
    gateway: &CompanionGateway,
    vault: &str,
    id: &str,
    doc: &KnowledgeDocumentSnapshot,
) -> ContentResult<Value> {
    let knowledge = gateway.backend.knowledge();
    let approved = gateway
        .backend
        .material_catalog()
        .approved_note_attachment_paths(
            &doc.summary.document_ref.vault_id,
            &doc.summary.relative_path,
        )
        .map_err(|_| (503, "RESOURCE_AUTHORITY_UNAVAILABLE"))?;
    let resources = companion_attachment_links(&doc.content).into_iter().take(1000).map(|link| {
        let resource_id = format!("res-{:x}", Sha256::digest(link.destination.as_bytes()));
        let resolved = knowledge.resolve_attachment_with_approved_paths(&doc.summary.document_ref, &link.destination,
            link.syntax == CompanionLinkSyntax::Wiki, &approved);
        let (status, version) = resolved.map(|r| (r.status, r.version)).unwrap_or(("unavailable".into(), None));
        json!({"resourceId": resource_id, "target": link.destination, "status": status, "version": version,
            "mimeType": mime(&link.destination), "embedded": link.embedded})
    }).collect::<Vec<_>>();
    Ok(
        json!({"noteId": id, "vaultId": vault, "title": doc.summary.title, "relativePath": doc.summary.relative_path,
        "content": doc.content, "revision": revision(&doc.summary.relative_path, &doc.revision),
        "updatedAt": doc.summary.modified_at, "resources": resources}),
    )
}

pub(super) fn read_route(
    gateway: &CompanionGateway,
    request: &HttpRequest,
) -> ContentResult<Value> {
    if request.path.contains("/attachments/") {
        return uploads::route(gateway, request);
    }
    let path = request.path.split('?').next().unwrap_or("");
    let (target, vault) = target(gateway)?;
    if path == "/v1/vaults" {
        query(&request.path, &[])?;
        return Ok(json!({"items": [{"vaultId": vault, "name": target.label, "current": true}]}));
    }
    let allowed: &[&str] = match path {
        "/v1/notes" => &[
            "vault",
            "afterId",
            "limit",
            "q",
            "directory",
            "snapshotSeq",
            "page",
        ],
        "/v1/sync/changes" => &["vault", "after", "limit"],
        _ => &["vault"],
    };
    let q = query(&request.path, allowed)?;
    if q.get("vault") != Some(&vault) {
        return Err((409, "VAULT_CHANGED"));
    }
    let mut state = gateway
        .content_state
        .lock()
        .map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
    reconcile(gateway, &target, &vault, &mut state)?;
    let db = database(gateway)?;
    let high: u64 = db
        .query_row(
            "SELECT COALESCE(MAX(seq),0) FROM companion_content_change WHERE vault_key=?1",
            [&vault],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    let value = if path == "/v1/notes" {
        let limit = number(&q, "limit", 100, 100)?;
        let after = q.get("afterId").map(String::as_str).unwrap_or("");
        let search = q.get("q").map(String::as_str).unwrap_or("");
        let directory = q.get("directory").map(String::as_str).unwrap_or("");
        let page = number(&q, "page", 1, 1_000_000)?;
        let matches = state
            .search
            .get(&vault)
            .map(|rows| {
                rows.iter()
                    .filter(|(_, text)| text.contains(&search.to_lowercase()))
                    .map(|(path, _)| path)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mark = q
            .get("snapshotSeq")
            .map(|s| s.parse::<u64>())
            .transpose()
            .map_err(|_| (400, "INVALID_QUERY"))?
            .unwrap_or(high);
        if mark > high {
            return Err((410, "CURSOR_TOO_OLD"));
        }
        let mut statement = db.prepare("SELECT summary FROM companion_content_note WHERE vault_key=?1 AND deleted=0 AND note_id>?2
            AND (?3='' OR path IN (SELECT value FROM json_each(?6))) AND (?4='' OR substr(path,1,length(?4))=?4)
            ORDER BY note_id LIMIT ?5 OFFSET ?7").map_err(db_error)?;
        let rows = statement
            .query_map(
                params![
                    vault,
                    after,
                    search,
                    directory,
                    limit + 1,
                    serde_json::to_string(&matches).unwrap(),
                    (page - 1) * limit
                ],
                |r| r.get::<_, String>(0),
            )
            .map_err(db_error)?;
        let mut items = rows
            .map(|row| {
                row.map_err(db_error).and_then(|s| {
                    serde_json::from_str::<Value>(&s)
                        .map_err(|_| (503, "CONTENT_STORE_UNAVAILABLE"))
                })
            })
            .collect::<ContentResult<Vec<_>>>()?;
        let more = items.len() > limit as usize;
        items.truncate(limit as usize);
        json!({"snapshotSeq": mark, "hasMore": more, "nextId": items.last().map(|v| v["noteId"].clone()), "items": items})
    } else if path == "/v1/sync/changes" {
        let after = q
            .get("after")
            .map(|s| s.parse::<u64>())
            .transpose()
            .map_err(|_| (400, "INVALID_QUERY"))?
            .unwrap_or(0);
        let floor: u64 = db
            .query_row(
                "SELECT floor FROM companion_content_cursor WHERE vault_key=?1",
                [&vault],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if after < floor || after > high {
            return Err((410, "CURSOR_TOO_OLD"));
        }
        let limit = number(&q, "limit", 100, 200)?;
        let mut statement = db.prepare("SELECT seq,note_id,revision,deleted FROM companion_content_change WHERE vault_key=?1 AND seq>?2 ORDER BY seq LIMIT ?3").map_err(db_error)?;
        let rows = statement.query_map(params![vault, after, limit + 1], |r| Ok(json!({"seq": r.get::<_, u64>(0)?, "noteId": r.get::<_, String>(1)?, "revision": r.get::<_, String>(2)?, "deleted": r.get::<_, bool>(3)?, "domain": "note"}))).map_err(db_error)?;
        let mut changes = rows.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
        let more = changes.len() > limit as usize;
        changes.truncate(limit as usize);
        let cursor = changes
            .last()
            .and_then(|v| v["seq"].as_u64())
            .unwrap_or(after);
        json!({"changes": changes, "cursor": cursor, "hasMore": more})
    } else {
        let id = path.strip_prefix("/v1/notes/").ok_or((404, "NOT_FOUND"))?;
        match current_document(gateway, &target, &vault, id) {
            Ok(doc) => document_value(gateway, &vault, id, &doc)?,
            // An unreadable file answers from its retained projection: the
            // identity, title and last confirmed revision stay correct, and a
            // client syncing a list of changes is not stopped by one document
            // whose bytes this process cannot decode. No body is claimed —
            // `content` is absent, exactly like a list summary row.
            Err((409, "NOTE_CHANGED"))
                if state
                    .unreadable
                    .get(&vault)
                    .is_some_and(|paths| {
                        current_note_path(gateway, &vault, id)
                            .is_some_and(|path| paths.contains(&path))
                    }) =>
            {
                unreadable_note_value(gateway, &vault, id)?
            }
            Err(error) => return Err(error),
        }
    };
    gateway
        .backend
        .knowledge()
        .with_current_target_response_lease(&target, || value)
        .map_err(|_| (409, "VAULT_CHANGED"))
}

pub(super) fn resource_source_current(gateway: &CompanionGateway, request: &HttpRequest) -> bool {
    query(&request.path, &["vault"])
        .ok()
        .zip(target(gateway).ok())
        .is_some_and(|(q, (_, vault))| q.get("vault") == Some(&vault))
}

pub(super) fn resource(
    gateway: &CompanionGateway,
    request: &HttpRequest,
) -> ContentResult<(std::fs::File, String, String)> {
    if request.method != "GET" {
        return Err((405, "METHOD_NOT_ALLOWED"));
    }
    let q = query(&request.path, &["vault"])?;
    let (target, vault) = target(gateway)?;
    if q.get("vault") != Some(&vault) {
        return Err((409, "VAULT_CHANGED"));
    }
    let path = request.path.split('?').next().unwrap_or("");
    let (id, resource_id) = path
        .strip_prefix("/v1/notes/")
        .and_then(|s| s.split_once("/resources/"))
        .ok_or((404, "NOT_FOUND"))?;
    let doc = current_document(gateway, &target, &vault, id)?;
    let link = companion_attachment_links(&doc.content)
        .into_iter()
        .find(|link| {
            format!("res-{:x}", Sha256::digest(link.destination.as_bytes())) == resource_id
        })
        .ok_or((404, "RESOURCE_UNAVAILABLE"))?;
    let knowledge = gateway.backend.knowledge();
    let approved = gateway
        .backend
        .material_catalog()
        .approved_note_attachment_paths(
            &doc.summary.document_ref.vault_id,
            &doc.summary.relative_path,
        )
        .map_err(|_| (503, "RESOURCE_AUTHORITY_UNAVAILABLE"))?;
    let resolved = knowledge
        .resolve_attachment_with_approved_paths(
            &doc.summary.document_ref,
            &link.destination,
            link.syntax == CompanionLinkSyntax::Wiki,
            &approved,
        )
        .map_err(|_| (404, "RESOURCE_UNAVAILABLE"))?;
    if resolved.status != "resolved" {
        return Err((404, "RESOURCE_UNAVAILABLE"));
    }
    let resolved_path = resolved
        .absolute_path
        .or(resolved.relative_path)
        .ok_or((404, "RESOURCE_UNAVAILABLE"))?;
    let path = knowledge
        .attachment_absolute_path(&resolved_path)
        .map_err(|_| (404, "RESOURCE_UNAVAILABLE"))?;
    let file = open_resource(&path).map_err(|_| (404, "RESOURCE_UNAVAILABLE"))?;
    let metadata = file.metadata().map_err(|_| (404, "RESOURCE_UNAVAILABLE"))?;
    if !metadata.is_file() {
        return Err((404, "RESOURCE_UNAVAILABLE"));
    }
    knowledge
        .with_current_target_response_lease(&target, || ())
        .map_err(|_| (409, "VAULT_CHANGED"))?;
    let version = format!(
        "\"{:x}\"",
        Sha256::digest(format!(
            "{vault}:{id}:{resource_id}:{}:{:?}:{}",
            metadata.len(),
            metadata.modified().ok(),
            resolved.version.unwrap_or_default()
        ))
    );
    Ok((file, mime(&path.to_string_lossy()).into(), version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::KnowledgeVaultRegistration;
    #[derive(Default)]
    struct MemoryStore(Mutex<Option<Vec<u8>>>);
    impl ProtectedIdentityStore for MemoryStore {
        fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>, GatewayError> {
            Ok(self.0.lock().unwrap().clone().map(Zeroizing::new))
        }
        fn store(&self, bytes: &[u8]) -> Result<(), GatewayError> {
            *self.0.lock().unwrap() = Some(bytes.to_vec());
            Ok(())
        }
        fn remove(&self) -> Result<(), GatewayError> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }
    fn fixture() -> (
        tempfile::TempDir,
        Arc<CompanionGateway>,
        KnowledgeVaultRegistration,
        String,
    ) {
        let root = tempfile::tempdir().unwrap();
        let vault_root = root.path().join("vault");
        fs::create_dir_all(vault_root.join(".luckyray")).unwrap();
        let registration = KnowledgeVaultRegistration {
            id: "test-vault".into(),
            name: "测试库".into(),
            root_path: vault_root.to_string_lossy().into(),
            mode: "vault-bound".into(),
            created_at: "2026-09-12T00:00:00Z".into(),
            last_opened_at: "2026-09-12T00:00:00Z".into(),
            schema_version: 1,
            link_update_policy: Default::default(),
        };
        fs::write(
            vault_root.join(".luckyray/vault.json"),
            serde_json::to_vec(&registration).unwrap(),
        )
        .unwrap();
        let backend = Arc::new(BackendServices::initialize(&root.path().join("app")).unwrap());
        backend
            .knowledge()
            .register_current_vault(&registration)
            .unwrap();
        let gateway = CompanionGateway::initialize_with_store(
            backend,
            Arc::new(MemoryStore::default()),
            GatewayPolicy::default(),
        );
        let (_, vault) = target(&gateway).unwrap();
        (root, gateway, registration, vault)
    }
    fn request(method: &str, path: &str, payload: Value) -> HttpRequest {
        HttpRequest {
            method: method.into(),
            path: path.into(),
            headers: HashMap::from([(
                "authorization".into(),
                format!("Bearer device-{}.test", "a".repeat(32)),
            )]),
            body: serde_json::to_vec(&payload).unwrap(),
        }
    }
    fn create(gateway: &CompanionGateway, vault: &str, id: &str, title: &str) -> Value {
        mutate_route(gateway,&request("POST","/v1/notes",json!({"opId":format!("op-{id}"),"noteId":id,"vaultId":vault,"kind":"create","title":title,"content":"原文\n"}))).unwrap()["document"].clone()
    }
    fn list(gateway: &CompanionGateway, vault: &str) -> Value {
        gateway.content_state.lock().unwrap().reconciled.clear();
        read_route(
            gateway,
            &request("GET", &format!("/v1/notes?vault={vault}"), Value::Null),
        )
        .unwrap()
    }

    #[test]
    fn golden_contract_create_read_and_full_text_search() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../../../protocol/companion-v1/content-v1/golden.json"
        ))
        .unwrap();
        let (_root, gateway, _registration, vault) = fixture();
        let mut payload = golden["mutation"].clone();
        payload["vaultId"] = json!(vault);
        let result = mutate_route(&gateway, &request("POST", "/v1/notes", payload)).unwrap();
        for key in ["noteId", "title", "relativePath", "content"] {
            assert_eq!(result["document"][key], golden["document"][key]);
        }
        list(&gateway, &vault);
        let found = read_route(
            &gateway,
            &request(
                "GET",
                &format!(
                    "/v1/notes?vault={vault}&q={}",
                    "%E7%AC%AC%E4%B8%80%E6%AE%B5"
                ),
                Value::Null,
            ),
        )
        .unwrap();
        assert_eq!(found["items"].as_array().unwrap().len(), 1);
        let bogus = read_route(
            &gateway,
            &request(
                "GET",
                &format!("/v1/notes?vault={vault}&q=noteId"),
                Value::Null,
            ),
        )
        .unwrap();
        assert!(bogus["items"].as_array().unwrap().is_empty());
        assert_eq!(
            json_route(&gateway, &request("GET", "/v1/capabilities", Value::Null)).unwrap(),
            golden["capabilities"]
        );
    }

    #[test]
    fn upload_chunks_resume_after_partial_write_and_receipts_replay() {
        let (_root, gateway, registration, vault) = fixture();
        let doc = create(&gateway, &vault, "kn-upload", "附件测试");
        let bytes = b"attachment test bytes";
        let digest = format!("{:x}", Sha256::digest(bytes));
        let manifest = json!({"vaultId":vault,"expectedRevision":doc["revision"],"name":"中文 (附件).txt","mime":"text/plain","sizeBytes":bytes.len(),"sha256":digest});
        let path = "/v1/notes/kn-upload/attachments/upload-a";
        let begin = request("POST", path, manifest.clone());
        assert_eq!(uploads::route(&gateway, &begin).unwrap()["offset"], 0);
        let chunk = |start: usize, data: &[u8]| {
            request(
                "PUT",
                path,
                json!({"vaultId":vault,"offset":start,"data":BASE64.encode(data),"sha256":format!("{:x}",Sha256::digest(data))}),
            )
        };
        let first = chunk(0, &bytes[..5]);
        assert_eq!(uploads::route(&gateway, &first).unwrap()["offset"], 5);
        assert_eq!(uploads::route(&gateway, &first).unwrap()["offset"], 5);
        let staged = fs::read_dir(
            gateway
                .backend
                .app_data_dir()
                .join("companion-upload-staging"),
        )
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
        OpenOptions::new()
            .append(true)
            .open(&staged)
            .unwrap()
            .write_all(b"uncommitted")
            .unwrap();
        assert_eq!(uploads::route(&gateway, &begin).unwrap()["offset"], 5);
        assert_eq!(fs::metadata(&staged).unwrap().len(), 5);
        let mut reused = manifest;
        reused["name"] = json!("different.txt");
        assert_eq!(
            uploads::route(&gateway, &request("POST", path, reused)).unwrap_err(),
            (409, "OP_ID_REUSED")
        );
        let mut bad = chunk(5, &bytes[5..]);
        bad.body = serde_json::to_vec(
            &json!({"vaultId":vault,"offset":5,"data":BASE64.encode(&bytes[5..]),"sha256":"bad"}),
        )
        .unwrap();
        assert_eq!(
            uploads::route(&gateway, &bad).unwrap_err(),
            (400, "CHUNK_CHECKSUM_MISMATCH")
        );
        uploads::route(&gateway, &chunk(5, &bytes[5..])).unwrap();
        let finish = request(
            "POST",
            &format!("{path}/complete"),
            json!({"vaultId":vault}),
        );
        let receipt = uploads::route(&gateway, &finish).unwrap();
        assert_eq!(uploads::route(&gateway, &finish).unwrap(), receipt);
        assert!(receipt["publication"]["markdown"]
            .as_str()
            .unwrap()
            .contains("中文"));
        assert_eq!(
            fs::read_to_string(Path::new(&registration.root_path).join("附件测试.md")).unwrap(),
            "原文\n"
        );
        // Simulate publication succeeding before its receipt transaction.
        database(&gateway)
            .unwrap()
            .execute("UPDATE companion_content_upload SET receipt=NULL", [])
            .unwrap();
        fs::write(&staged, bytes).unwrap();
        let recovered = uploads::route(&gateway, &finish).unwrap();
        assert_eq!(
            recovered["publication"]["markdown"],
            receipt["publication"]["markdown"]
        );
    }

    #[test]
    fn note_operation_response_loss_replay_and_payload_reuse_guard() {
        let (_root, gateway, registration, vault) = fixture();
        let payload = json!({"opId":"op-create-a","noteId":"kn-a","vaultId":vault,"kind":"create","title":"中文 (测试)","content":"第一段\n"});
        let req = request("POST", "/v1/notes", payload.clone());
        let result = mutate_route(&gateway, &req).unwrap();
        assert_eq!(mutate_route(&gateway, &req).unwrap(), result);
        let mut other = payload;
        other["content"] = json!("不同请求");
        assert_eq!(
            mutate_route(&gateway, &request("POST", "/v1/notes", other)).unwrap_err(),
            (409, "OP_ID_REUSED")
        );
        assert_eq!(list(&gateway, &vault)["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            fs::read_to_string(Path::new(&registration.root_path).join("中文 (测试).md")).unwrap(),
            "第一段\n"
        );
        // Simulate the narrow file-committed/receipt-not-committed restart window.
        database(&gateway)
            .unwrap()
            .execute(
                "UPDATE companion_content_operation SET result=NULL,stage='intent'",
                [],
            )
            .unwrap();
        assert_eq!(mutate_route(&gateway, &req).unwrap(), result);
        assert_eq!(list(&gateway, &vault)["items"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn unique_create_preserves_caller_identity_and_empty_revision_payload_across_replay() {
        let (_root, gateway, registration, vault) = fixture();
        create(&gateway, &vault, "kn-original", "新笔记");
        let payload = json!({"opId":"unique-create-a","noteId":"kn-from-phone","vaultId":vault,"kind":"create",
            "expectedRevision":"","title":"新笔记","content":"手机正文\n"});
        let req = request("POST", "/v1/notes", payload.clone());
        let result = mutate_unique_route(&gateway, &req).unwrap();
        assert_eq!(result["document"]["noteId"], "kn-from-phone");
        assert_eq!(result["document"]["relativePath"], "新笔记（副本）.md");
        assert_eq!(result["document"]["title"], "新笔记（副本）");
        assert_eq!(mutate_unique_route(&gateway, &req).unwrap(), result);
        assert_eq!(mutate_route(&gateway, &req).unwrap_err(), (409,"OP_ID_REUSED"), "prepared unique operation never falls back to old Content create");
        let legacy_payload = json!({"opId":"legacy-prepared","noteId":"kn-legacy-prepared","vaultId":vault,
            "kind":"create","expectedRevision":"","title":"Legacy prepared","content":"legacy content"});
        let legacy = request("POST", "/v1/notes", legacy_payload);
        mutate_route(&gateway, &legacy).unwrap();
        assert_eq!(mutate_unique_route(&gateway, &legacy).unwrap_err(), (409,"OP_ID_REUSED"), "old prepared operation never switches to unique route");
        let mut changed = payload;
        changed["expectedRevision"] = Value::Null;
        assert_eq!(mutate_unique_route(&gateway, &request("POST", "/v1/notes", changed)).unwrap_err(), (409,"OP_ID_REUSED"));
        database(&gateway).unwrap().execute("UPDATE companion_content_operation SET stage='intent',result=NULL WHERE op_id='unique-create-a'", []).unwrap();
        assert_eq!(mutate_unique_route(&gateway, &req).unwrap(), result);
        assert_eq!(list(&gateway, &vault)["items"].as_array().unwrap().len(), 3);
        assert_eq!(fs::read_to_string(Path::new(&registration.root_path).join("新笔记.md")).unwrap(), "原文\n");
    }

    #[test]
    fn unique_create_uncertain_recovery_never_claims_same_content_third_party_file_or_creates_twice() {
        let (_root, gateway, registration, vault) = fixture();
        let req = request("POST", "/v1/notes", json!({"opId":"unique-uncertain","noteId":"kn-uncertain","vaultId":vault,
            "kind":"create","expectedRevision":"","title":"Recovery","content":"same bytes"}));
        let result = mutate_unique_route(&gateway, &req).unwrap();
        let path = Path::new(&registration.root_path).join(result["document"]["relativePath"].as_str().unwrap());
        // Rename retains the old object alive so filesystem ID reuse cannot make
        // the replacement accidentally inherit our staged object identity.
        fs::rename(&path, path.with_extension("saved")).unwrap();
        fs::write(&path, "same bytes").unwrap();
        database(&gateway).unwrap().execute("UPDATE companion_content_operation SET stage='intent',result=NULL WHERE op_id='unique-uncertain'", []).unwrap();
        assert_eq!(mutate_unique_route(&gateway, &req).unwrap_err(), (503,"CONTENT_STORE_UNAVAILABLE"));
        assert!(!path.with_file_name("Recovery（副本）.md").exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), "same bytes");
    }

    #[test]
    fn unique_unpublished_intent_does_not_reserve_an_external_notes_identity() {
        let (_root, gateway, registration, vault) = fixture();
        let payload = json!({"opId":"unique-before-stage","noteId":"kn-intended","vaultId":vault,
            "kind":"create","expectedRevision":"","title":"Intent","content":"same bytes"});
        let request = request("POST", "/v1/notes", payload);
        let input: Mutation = serde_json::from_slice(&request.body).unwrap();
        let device = presented_device_id(&request).unwrap();
        let plan = Plan { before:None, planned_path:"Intent.md".into(), old_object:None,
            desired_content:Some("same bytes".into()), created_object:None };
        database(&gateway).unwrap().execute(
            "INSERT INTO companion_content_operation(device_id,op_id,vault_key,note_id,payload,before_document,stage,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,'intent','2026-09-30T00:00:00Z')",
            params![device,input.op_id,vault,"kn-intended",format!("unique:{}",serde_json::to_string(&input).unwrap()),serde_json::to_string(&plan).unwrap()]).unwrap();
        fs::write(Path::new(&registration.root_path).join("Intent.md"), "same bytes").unwrap();
        let external = list(&gateway, &vault)["items"][0]["noteId"].clone();
        assert_ne!(external, "kn-intended");
        let receipt = mutate_unique_route(&gateway, &request).unwrap();
        assert_eq!(receipt["document"]["noteId"], "kn-intended");
        assert_eq!(receipt["document"]["relativePath"], "Intent（副本）.md");
        let items = list(&gateway, &vault)["items"].as_array().unwrap().clone();
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|note| note["noteId"] == external && note["relativePath"] == "Intent.md"));
    }

    #[test]
    fn offline_base_conflicts_and_desktop_dirty_draft_veto() {
        let (_root, gateway, registration, vault) = fixture();
        let doc = create(&gateway, &vault, "kn-a", "原笔记");
        let payload = json!({"opId":"op-edit-a","vaultId":vault,"kind":"update","expectedRevision":doc["revision"],"content":"手机输入"});
        let active = gateway
            .backend
            .knowledge()
            .activate_ui_source(&registration.id)
            .unwrap();
        gateway
            .backend
            .knowledge()
            .companion_set_desktop_drafts(active.source_epoch, 1, vec!["原笔记.md".into()])
            .unwrap();
        let req = request("PATCH", "/v1/notes/kn-a", payload.clone());
        assert_eq!(
            mutate_route(&gateway, &req).unwrap_err(),
            (503, "DESKTOP_DRAFT_BUSY")
        );
        assert_eq!(
            fs::read_to_string(Path::new(&registration.root_path).join("原笔记.md")).unwrap(),
            "原文\n"
        );
        gateway
            .backend
            .knowledge()
            .companion_set_desktop_drafts(active.source_epoch, 2, vec![])
            .unwrap();
        let saved = mutate_route(&gateway, &req).unwrap();
        assert_eq!(saved["document"]["content"], "手机输入\n");
        let mut stale = payload;
        stale["opId"] = json!("op-stale");
        stale["content"] = json!("旧基础上的编辑");
        assert_eq!(
            mutate_route(&gateway, &request("PATCH", "/v1/notes/kn-a", stale)).unwrap_err(),
            (409, "REVISION_CONFLICT")
        );
    }

    #[test]
    fn service_and_external_rename_keep_identity_and_delete_has_tombstone() {
        let (_root, gateway, registration, vault) = fixture();
        let doc = create(&gateway, &vault, "kn-a", "A");
        let renamed=mutate_route(&gateway,&request("PATCH","/v1/notes/kn-a",json!({"opId":"rename-a","vaultId":vault,"kind":"rename","expectedRevision":doc["revision"],"title":"B"}))).unwrap();
        assert_eq!(renamed["document"]["noteId"], "kn-a");
        assert_ne!(renamed["document"]["revision"], doc["revision"]);
        fs::rename(
            Path::new(&registration.root_path).join("B.md"),
            Path::new(&registration.root_path).join("外部重命名.md"),
        )
        .unwrap();
        let current = list(&gateway, &vault)["items"][0].clone();
        assert_eq!(current["noteId"], "kn-a");
        let delete = request(
            "DELETE",
            "/v1/notes/kn-a",
            json!({"opId":"delete-a","vaultId":vault,"kind":"delete","expectedRevision":current["revision"]}),
        );
        let result = mutate_route(&gateway, &delete).unwrap();
        assert_eq!(result["document"]["deleted"], true);
        assert_eq!(mutate_route(&gateway, &delete).unwrap(), result);
        let changes = read_route(
            &gateway,
            &request(
                "GET",
                &format!("/v1/sync/changes?vault={vault}&after=0"),
                Value::Null,
            ),
        )
        .unwrap();
        assert!(changes["changes"].as_array().unwrap().last().unwrap()["deleted"] == true);
        assert_eq!(mutate_route(&gateway,&request("PATCH","/v1/notes/kn-a",json!({"opId":"offline-after-delete","vaultId":vault,"kind":"update","expectedRevision":current["revision"],"content":"离线编辑"}))).unwrap_err(),(409,"REVISION_CONFLICT"));
    }

    #[test]
    fn keyset_snapshot_replays_concurrent_create_and_expired_cursor() {
        let (_root, gateway, _registration, vault) = fixture();
        create(&gateway, &vault, "kn-b", "B");
        create(&gateway, &vault, "kn-z", "Z");
        let first = read_route(
            &gateway,
            &request(
                "GET",
                &format!("/v1/notes?vault={vault}&limit=1"),
                Value::Null,
            ),
        )
        .unwrap();
        create(&gateway, &vault, "kn-a", "A");
        let page = read_route(
            &gateway,
            &request(
                "GET",
                &format!(
                    "/v1/notes?vault={vault}&limit=1&afterId=kn-b&snapshotSeq={}",
                    first["snapshotSeq"]
                ),
                Value::Null,
            ),
        )
        .unwrap();
        assert_eq!(page["items"][0]["noteId"], "kn-z");
        let changes = read_route(
            &gateway,
            &request(
                "GET",
                &format!(
                    "/v1/sync/changes?vault={vault}&after={}",
                    first["snapshotSeq"]
                ),
                Value::Null,
            ),
        )
        .unwrap();
        assert!(changes["changes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["noteId"] == "kn-a"));
        database(&gateway)
            .unwrap()
            .execute(
                "UPDATE companion_content_cursor SET floor=1 WHERE vault_key=?1",
                [&vault],
            )
            .unwrap();
        assert_eq!(
            read_route(
                &gateway,
                &request(
                    "GET",
                    &format!("/v1/sync/changes?vault={vault}&after=0"),
                    Value::Null
                )
            )
            .unwrap_err(),
            (410, "CURSOR_TOO_OLD")
        );
        assert_eq!(
            read_route(
                &gateway,
                &request("GET", "/v1/notes?vault=another-vault", Value::Null)
            )
            .unwrap_err(),
            (409, "VAULT_CHANGED")
        );
    }
    fn write_gbk_note(root: &std::path::Path, name: &str) {
        // GBK bytes for 中文; valid on disk, not valid UTF-8.
        fs::write(root.join(name), [0xB2u8, 0xE2, 0xCA, 0xD4, 0x0A]).unwrap();
    }

    #[test]
    fn zcode_review_healthy_library_stays_usable_with_one_unreadable_note() {
        let (root, gateway, registration, vault) = fixture();
        let vault_root = std::path::Path::new(&registration.root_path).to_path_buf();
        let healthy = create(&gateway, &vault, "kn-healthy", "健康笔记");
        write_gbk_note(&vault_root, "坏编码.md");
        let listed = list(&gateway, &vault);
        let ids = listed["items"].as_array().unwrap().iter().map(|v| v["noteId"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert!(ids.contains(&"kn-healthy".to_string()), "healthy note still listed: {ids:?}");
        let read = read_route(&gateway, &request("GET", &format!("/v1/notes/kn-healthy?vault={vault}"), Value::Null)).unwrap();
        assert_eq!(read["content"], healthy["content"]);
        let created = mutate_route(&gateway, &request("POST", "/v1/notes", json!({"opId":"op-after-bad","noteId":"kn-new","vaultId":vault,"kind":"create","title":"新建","content":"x\n"})));
        assert!(created.is_ok(), "create still works: {created:?}");
        let updated = mutate_route(&gateway, &request("PATCH", "/v1/notes/kn-healthy", json!({"opId":"op-upd","vaultId":vault,"kind":"update","expectedRevision":healthy["revision"],"content":"改后\n"})));
        assert!(updated.is_ok(), "update still works: {updated:?}");
        let changes = read_route(&gateway, &request("GET", &format!("/v1/sync/changes?vault={vault}&after=0"), Value::Null));
        assert!(changes.is_ok(), "changes still works: {changes:?}");
        assert_eq!(fs::read(vault_root.join("坏编码.md")).unwrap(), [0xB2u8, 0xE2, 0xCA, 0xD4, 0x0A], "user file untouched");
    }

    #[test]
    fn zcode_review_indexed_note_that_becomes_unreadable_keeps_identity_and_no_tombstone() {
        let (root, gateway, registration, vault) = fixture();
        let vault_root = std::path::Path::new(&registration.root_path).to_path_buf();
        let doc = create(&gateway, &vault, "kn-a", "先正常");
        list(&gateway, &vault);
        let before = read_route(&gateway, &request("GET", &format!("/v1/notes/kn-a?vault={vault}"), Value::Null)).unwrap();
        write_gbk_note(&vault_root, "先正常.md");
        let listed = list(&gateway, &vault);
        let entry = listed["items"].as_array().unwrap().iter().find(|v| v["noteId"] == "kn-a").cloned();
        assert!(entry.is_some(), "identity retained, not tombstoned: {listed}");
        assert_eq!(entry.unwrap()["revision"], before["revision"], "last confirmed revision kept");
        let changes = read_route(&gateway, &request("GET", &format!("/v1/sync/changes?vault={vault}&after=0"), Value::Null)).unwrap();
        assert!(!changes["changes"].as_array().unwrap().iter().any(|c| c["noteId"] == "kn-a" && c["deleted"] == true), "no false tombstone: {changes}");
        // A blind write must not transcode or overwrite the user's file.
        let blind = mutate_route(&gateway, &request("PATCH", "/v1/notes/kn-a", json!({"opId":"op-blind","vaultId":vault,"kind":"update","expectedRevision":before["revision"],"content":"覆盖\n"})));
        assert!(blind.is_err(), "unreadable original must not be written: {blind:?}");
        assert_eq!(fs::read(vault_root.join("先正常.md")).unwrap(), [0xB2u8, 0xE2, 0xCA, 0xD4, 0x0A], "user file untouched");
        let _ = doc;
    }

    #[test]
    fn zcode_review_recovery_real_deletion_and_incomplete_scan_are_distinct() {
        let (root, gateway, registration, vault) = fixture();
        let vault_root = std::path::Path::new(&registration.root_path).to_path_buf();
        create(&gateway, &vault, "kn-a", "甲");
        create(&gateway, &vault, "kn-b", "乙");
        list(&gateway, &vault);
        // A real deletion still propagates (no parse failure at all).
        fs::remove_file(vault_root.join("乙.md")).unwrap();
        let after_delete = list(&gateway, &vault);
        assert!(after_delete["items"].as_array().unwrap().iter().all(|v| v["noteId"] != "kn-b"), "real deletion propagates: {after_delete}");
        // Recovery: the same path becomes readable again.
        write_gbk_note(&vault_root, "甲.md");
        list(&gateway, &vault);
        fs::write(vault_root.join("甲.md"), "恢复后的正文\n").unwrap();
        let recovered = list(&gateway, &vault);
        let entry = recovered["items"].as_array().unwrap().iter().find(|v| v["noteId"] == "kn-a").cloned().expect("recovered");
        assert_eq!(entry["title"], "甲", "same identity after recovery");
        let read = read_route(&gateway, &request("GET", &format!("/v1/notes/kn-a?vault={vault}"), Value::Null)).unwrap();
        assert_eq!(read["content"], "恢复后的正文\n");
        // An incomplete scan (whole-vault failure) is never read as deletion.
        gateway.content_state.lock().unwrap().reconciled.clear();
        gateway.backend.knowledge().fail_next_index_refresh();
        let failed = read_route(&gateway, &request("GET", &format!("/v1/notes?vault={vault}"), Value::Null));
        assert!(failed.is_err(), "incomplete scan stays fatal: {failed:?}");
    }

    #[test]
    fn zcode_review_single_note_read_of_unreadable_file_does_not_stop_sync() {
        let (root, gateway, registration, vault) = fixture();
        let vault_root = std::path::Path::new(&registration.root_path).to_path_buf();
        create(&gateway, &vault, "kn-a", "会变坏的");
        list(&gateway, &vault);
        let before = read_route(&gateway, &request("GET", &format!("/v1/notes/kn-a?vault={vault}"), Value::Null)).unwrap();
        write_gbk_note(&vault_root, "会变坏的.md");
        list(&gateway, &vault);
        // A sync loop walking changed ids must not be stopped by one file it
        // cannot decode: the read answers with real identity and no body.
        let read = read_route(&gateway, &request("GET", &format!("/v1/notes/kn-a?vault={vault}"), Value::Null));
        let value = read.expect("single read must not fail the loop");
        assert_eq!(value["noteId"], "kn-a");
        assert_eq!(value["revision"], before["revision"], "last confirmed revision");
        assert!(value.get("content").is_none(), "no body is claimed for unreadable bytes: {value}");
        let _ = root;
    }

    #[test]
    fn zcode_review_rename_over_unreadable_path_does_not_inherit_identity() {
        let (root, gateway, registration, vault) = fixture();
        let vault_root = std::path::Path::new(&registration.root_path).to_path_buf();
        create(&gateway, &vault, "kn-a", "甲");
        list(&gateway, &vault);
        write_gbk_note(&vault_root, "甲.md");
        list(&gateway, &vault);
        // Replace the unreadable file with a different, readable document.
        fs::write(vault_root.join("甲.md"), "别人的内容\n").unwrap();
        let listed = list(&gateway, &vault);
        let entry = listed["items"].as_array().unwrap().iter().find(|v| v["relativePath"] == "甲.md").cloned().expect("listed");
        // Either the old identity is retained with its verified revision, or a
        // new identity is minted for genuinely different bytes — never the old
        // ID silently carrying unverified content.
        if entry["noteId"] == "kn-a" {
            assert_eq!(entry["revision"], revision("甲.md", &format!("{:x}", Sha256::digest("别人的内容\n"))), "retained ID must carry the verified revision");
        }
        let read = read_route(&gateway, &request("GET", &format!("/v1/notes/{}?vault={vault}", entry["noteId"].as_str().unwrap()), Value::Null)).unwrap();
        assert_eq!(read["content"], "别人的内容\n");
    }
}

