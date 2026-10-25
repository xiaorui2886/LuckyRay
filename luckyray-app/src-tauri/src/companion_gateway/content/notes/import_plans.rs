//! Bounded metadata reservations and exact full-body publication. No placeholders.
use super::*;
use crate::knowledge::companion_import_path_key;
use serde::{Deserialize, Serialize};
const MAX_ENTRIES: usize = 256;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Item {
    source_note_id: String,
    note_id: String,
    title: String,
    #[serde(default)]
    parent_relative_path: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    op_id: String,
    vault_id: String,
    source_fingerprint: String,
    items: Vec<Item>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Commit {
    op_id: String,
    vault_id: String,
    mapping_hash: String,
    content: String,
    content_sha256: String,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Mapping {
    source_note_id: String,
    note_id: String,
    relative_path: String,
}
struct Plan {
    vault: String,
    target: String,
    identity: String,
    mapping_hash: String,
    mapping: Value,
}
fn schema(db: &Connection) -> ContentResult<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS companion_import_plan(
 plan_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,op_id TEXT NOT NULL,vault_key TEXT NOT NULL,
 target_id TEXT NOT NULL,identity_digest TEXT NOT NULL,mapping_hash TEXT NOT NULL,mapping TEXT NOT NULL,
 UNIQUE(device_id,op_id));
 CREATE TABLE IF NOT EXISTS companion_import_entry(
 plan_id TEXT NOT NULL,note_id TEXT NOT NULL,source_note_id TEXT NOT NULL,vault_key TEXT NOT NULL,
 relative_path TEXT NOT NULL,path_key TEXT NOT NULL,ordinal INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared',op_id TEXT,request TEXT,stage_path TEXT,stage_object TEXT,receipt TEXT,
 PRIMARY KEY(plan_id,note_id),UNIQUE(vault_key,note_id),UNIQUE(vault_key,path_key));").map_err(db_error)
}
fn digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn mapping_hash(vault: &str, fingerprint: &str, items: &[Mapping]) -> String {
    let mut h = Sha256::new();
    h.update(b"lr-import-plan-v1\0");
    fn field(h: &mut Sha256, s: &str) {
        h.update((s.len() as u64).to_be_bytes());
        h.update(s.as_bytes());
    }
    field(&mut h, vault);
    field(&mut h, fingerprint);
    h.update((items.len() as u64).to_be_bytes());
    for i in items {
        field(&mut h, &i.source_note_id);
        field(&mut h, &i.note_id);
        field(&mut h, &i.relative_path);
    }
    format!("{:x}", h.finalize())
}
fn load(
    db: &Connection,
    device: &str,
    plan: &str,
    target: &KnowledgeTargetIdentity,
    vault: &str,
) -> ContentResult<Plan> {
    let p:Option<(String,String,String,String,String)>=db.query_row("SELECT vault_key,target_id,identity_digest,mapping_hash,mapping FROM companion_import_plan WHERE plan_id=?1 AND device_id=?2",params![plan,device],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(db_error)?;
    let Some((v, t, i, h, m)) = p else {
        return Err((404, "IMPORT_PLAN_NOT_FOUND"));
    };
    if v != vault || t != target.target_id || i != target.identity_digest {
        return Err((409, "IMPORT_TARGET_CHANGED"));
    }
    Ok(Plan {
        vault: v,
        target: t,
        identity: i,
        mapping_hash: h,
        mapping: serde_json::from_str(&m).map_err(|_| (503, "CONTENT_STORE_UNAVAILABLE"))?,
    })
}
fn operation(
    db: &Connection,
    device: &str,
    op: &str,
) -> ContentResult<Option<(String, Option<String>)>> {
    db.query_row(
        "SELECT payload,result FROM companion_content_operation WHERE device_id=?1 AND op_id=?2",
        params![device, op],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(db_error)
}
fn claim(
    db: &Connection,
    device: &str,
    op: &str,
    vault: &str,
    note: &str,
    payload: &str,
) -> ContentResult<()> {
    db.execute("INSERT INTO companion_content_operation(device_id,op_id,vault_key,note_id,payload,before_document,stage,created_at) VALUES(?1,?2,?3,?4,?5,'{}','intent',?6)",params![device,op,vault,note,payload,chrono::Utc::now().to_rfc3339()]).map_err(db_error)?;
    Ok(())
}
fn finish(db: &Connection, device: &str, op: &str, result: &Value) -> ContentResult<()> {
    db.execute("UPDATE companion_content_operation SET stage='completed',result=?3 WHERE device_id=?1 AND op_id=?2",params![device,op,result.to_string()]).map_err(db_error)?;
    Ok(())
}
pub(super) fn route(gateway: &CompanionGateway, request: &HttpRequest) -> ContentResult<Value> {
    super::super::access(gateway, request)?;
    let device = presented_device_id(request).ok_or((401, "PAIRING_REQUIRED"))?;
    let (target, vault) = target(gateway)?;
    let path = request.path.split('?').next().unwrap_or("");
    let rest = path
        .strip_prefix("/v1/notes/import-plans")
        .ok_or((404, "NOT_FOUND"))?;
    if rest.contains("//") || rest.ends_with('/') {
        return Err((404, "NOT_FOUND"));
    }
    let parts = rest
        .strip_prefix('/')
        .unwrap_or(rest)
        .split('/')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let mut state = gateway
        .content_state
        .lock()
        .map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
    let mut db = database(gateway)?;
    if request.method == "POST" {
        schema(&db)?;
    } else {
        let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_import_plan')",[],|r|r.get(0)).map_err(db_error)?;
        if !exists {
            return Err((404, "IMPORT_PLAN_NOT_FOUND"));
        }
    }
    let result = match (request.method.as_str(), parts.as_slice()) {
        ("POST", []) if path == "/v1/notes/import-plans" => {
            query(&request.path, &[])?;
            prepare(gateway, request, &mut db, &device, &target, &vault)?
        }
        ("POST", [plan, "entries", note]) if valid_id(plan) && valid_id(note) => {
            query(&request.path, &[])?;
            commit(
                gateway, request, &mut db, &device, &target, &vault, plan, note,
            )?
        }
        ("GET", [plan]) if valid_id(plan) => {
            let q = query(&request.path, &["vault"])?;
            if q.get("vault") != Some(&vault) {
                return Err((409, "VAULT_CHANGED"));
            }
            status(&db, &device, &target, &vault, plan)?
        }
        _ => return Err((405, "METHOD_NOT_ALLOWED")),
    };
    if request.method == "POST" && parts.len() == 3 {
        state.reconciled.remove(&vault);
    }
    gateway
        .knowledge()
        .with_current_target_response_lease(&target, || result)
        .map_err(|_| (409, "VAULT_CHANGED"))
}
fn prepare(
    gateway: &CompanionGateway,
    request: &HttpRequest,
    db: &mut Connection,
    device: &str,
    target: &KnowledgeTargetIdentity,
    vault: &str,
) -> ContentResult<Value> {
    let input: Prepare =
        serde_json::from_slice(&request.body).map_err(|_| (400, "IMPORT_INPUT_INVALID"))?;
    if !valid_id(&input.op_id)
        || !digest(&input.source_fingerprint)
        || input.items.is_empty()
        || input.items.len() > MAX_ENTRIES
    {
        return Err((400, "IMPORT_INPUT_INVALID"));
    }
    if input.vault_id != vault {
        return Err((409, "VAULT_CHANGED"));
    }
    let payload = format!(
        "import-plan:{}",
        serde_json::to_string(&input).map_err(|_| (400, "IMPORT_INPUT_INVALID"))?
    );
    if let Some((old, result)) = operation(db, device, &input.op_id)? {
        if old != payload {
            return Err((409, "OP_ID_REUSED"));
        }
        let result: Value = serde_json::from_str(&result.ok_or((409, "IMPORT_PLAN_UNCERTAIN"))?)
            .map_err(|_| (503, "CONTENT_STORE_UNAVAILABLE"))?;
        load(
            db,
            device,
            result["planId"]
                .as_str()
                .ok_or((503, "CONTENT_STORE_UNAVAILABLE"))?,
            target,
            vault,
        )?;
        return Ok(result);
    }
    let mut sources = HashSet::new();
    let mut ids = HashSet::new();
    for i in &input.items {
        if i.source_note_id.is_empty()
            || i.source_note_id.len() > 256
            || i.source_note_id.chars().any(char::is_control)
            || !sources.insert(&i.source_note_id)
            || !i.note_id.starts_with("kn-")
            || !valid_id(&i.note_id)
            || !ids.insert(&i.note_id)
            || i.title.len() > 240
            || i.parent_relative_path.len() > 4096
        {
            return Err((400, "IMPORT_INPUT_INVALID"));
        }
        let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM companion_content_note WHERE vault_key=?1 AND note_id=?2)",params![vault,i.note_id],|r|r.get(0)).map_err(db_error)?;
        let reserved:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM companion_import_entry WHERE vault_key=?1 AND note_id=?2)",params![vault,i.note_id],|r|r.get(0)).map_err(db_error)?;
        let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM companion_content_operation WHERE vault_key=?1 AND note_id=?2)",params![vault,i.note_id],|r|r.get(0)).map_err(db_error)?;
        if exists || reserved || pending {
            return Err((409, "IMPORT_NOTE_ID_CONFLICT"));
        }
    }
    let count:u64=db.query_row("SELECT COUNT(*) FROM companion_import_entry e JOIN companion_import_plan p ON p.plan_id=e.plan_id WHERE p.device_id=?1",[device],|r|r.get(0)).map_err(db_error)?;
    if count + input.items.len() as u64 > 4096 {
        return Err((409, "IMPORT_PLAN_CAPACITY"));
    }
    let reserved = {
        let mut s = db
            .prepare("SELECT path_key FROM companion_import_entry WHERE vault_key=?1")
            .map_err(db_error)?;
        let rows = s
            .query_map([vault], |r| r.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<HashSet<_>, _>>()
            .map_err(db_error)?;
        rows
    };
    let requests = input
        .items
        .iter()
        .map(|i| (i.title.clone(), i.parent_relative_path.clone()))
        .collect::<Vec<_>>();
    let paths = gateway
        .knowledge()
        .companion_import_plan_paths(target, &requests, &reserved)
        .map_err(import_error)?;
    let mappings = input
        .items
        .iter()
        .zip(paths)
        .map(|(i, p)| Mapping {
            source_note_id: i.source_note_id.clone(),
            note_id: i.note_id.clone(),
            relative_path: p,
        })
        .collect::<Vec<_>>();
    let hash = mapping_hash(vault, &input.source_fingerprint, &mappings);
    let plan = format!("ip-{}", random_hex(16));
    let result = json!({"version":1,"planId":plan,"vaultId":vault,"sourceFingerprint":input.source_fingerprint,"mappingHash":hash,"state":"prepared","items":mappings});
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    claim(&tx, device, &input.op_id, vault, "", &payload)?;
    tx.execute("INSERT INTO companion_import_plan(plan_id,device_id,op_id,vault_key,target_id,identity_digest,mapping_hash,mapping) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![plan,device,input.op_id,vault,target.target_id,target.identity_digest,hash,result.to_string()]).map_err(db_error)?;
    for (ordinal, i) in mappings.iter().enumerate() {
        tx.execute("INSERT INTO companion_import_entry(plan_id,note_id,source_note_id,vault_key,relative_path,path_key,ordinal) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![plan,i.note_id,i.source_note_id,vault,i.relative_path,companion_import_path_key(&i.relative_path).map_err(import_error)?,ordinal as u32]).map_err(db_error)?;
    }
    finish(&tx, device, &input.op_id, &result)?;
    tx.commit().map_err(db_error)?;
    Ok(result)
}
fn import_error(e: KnowledgeError) -> (u16, &'static str) {
    match e.code {
        "knowledge-import-path-conflict" | "knowledge-name-conflict" => {
            (409, "IMPORT_PATH_CONFLICT")
        }
        "knowledge-parent-missing" => (409, "IMPORT_PARENT_MISSING"),
        "knowledge-path-invalid"
        | "knowledge-path-outside-vault"
        | "knowledge-invalid-title"
        | "knowledge-invalid-document-ref" => (400, "IMPORT_INPUT_INVALID"),
        _ => (409, "IMPORT_PUBLICATION_UNCERTAIN"),
    }
}
fn commit(
    gateway: &CompanionGateway,
    request: &HttpRequest,
    db: &mut Connection,
    device: &str,
    target: &KnowledgeTargetIdentity,
    vault: &str,
    plan_id: &str,
    note_id: &str,
) -> ContentResult<Value> {
    let input: Commit =
        serde_json::from_slice(&request.body).map_err(|_| (400, "IMPORT_INPUT_INVALID"))?;
    if !valid_id(&input.op_id)
        || !digest(&input.content_sha256)
        || input.content.len() > 4 * 1024 * 1024
        || input.content.starts_with('\u{feff}')
        || format!("{:x}", Sha256::digest(input.content.as_bytes())) != input.content_sha256
    {
        return Err((400, "IMPORT_CONTENT_INVALID"));
    }
    if input.vault_id != vault {
        return Err((409, "VAULT_CHANGED"));
    }
    let plan = load(db, device, plan_id, target, vault)?;
    if input.mapping_hash != plan.mapping_hash {
        return Err((409, "IMPORT_MAPPING_CHANGED"));
    }
    let payload = format!(
        "import-entry:{plan_id}:{note_id}:{}",
        serde_json::to_string(&input).map_err(|_| (400, "IMPORT_INPUT_INVALID"))?
    );
    let entry:Option<(String,Option<String>,Option<String>,Option<String>,Option<String>,Option<String>)>=db.query_row("SELECT relative_path,op_id,request,stage_path,stage_object,receipt FROM companion_import_entry WHERE plan_id=?1 AND note_id=?2",params![plan_id,note_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(db_error)?;
    let Some((path, old_op, old_request, stage, object, receipt)) = entry else {
        return Err((404, "IMPORT_ENTRY_NOT_FOUND"));
    };
    if old_op.as_deref().is_some_and(|s| s != input.op_id)
        || old_request.as_deref().is_some_and(|s| s != payload)
    {
        return Err((409, "OP_ID_REUSED"));
    }
    if let Some((old, result)) = operation(db, device, &input.op_id)? {
        if old != payload {
            return Err((409, "OP_ID_REUSED"));
        }
        if let Some(result) = result {
            if receipt.as_deref() != Some(&result) {
                return Err((409, "IMPORT_PUBLICATION_UNCERTAIN"));
            }
            return serde_json::from_str(&result).map_err(|_| (503, "CONTENT_STORE_UNAVAILABLE"));
        }
    } else {
        if old_op.is_some() || receipt.is_some() {
            return Err((409, "IMPORT_PUBLICATION_UNCERTAIN"));
        }
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        claim(&tx, device, &input.op_id, vault, note_id, &payload)?;
        tx.execute(
            "UPDATE companion_import_entry SET op_id=?3,request=?4 WHERE plan_id=?1 AND note_id=?2",
            params![plan_id, note_id, input.op_id, payload],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
    }
    let occupied:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM companion_content_note WHERE vault_key=?1 AND (note_id=?2 OR (path=?3 AND deleted=0)))",params![vault,note_id,path],|r|r.get(0)).map_err(db_error)?;
    let foreign_operation:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM companion_content_operation WHERE vault_key=?1 AND note_id=?2 AND (device_id<>?3 OR op_id<>?4))",params![vault,note_id,device,input.op_id],|r|r.get(0)).map_err(db_error)?;
    if occupied || foreign_operation {
        return Err((409, "IMPORT_NOTE_ID_CONFLICT"));
    }
    if stage.is_some() != object.is_some() {
        return Err((409, "IMPORT_PUBLICATION_UNCERTAIN"));
    }
    let prior = stage.as_deref().zip(object.as_deref());
    let knowledge = gateway.knowledge();
    let outcome=knowledge.companion_import_publish(target,&path,&input.content,prior,|staged,object|{
  db.execute("UPDATE companion_import_entry SET stage_path=?3,stage_object=?4,state='staged' WHERE plan_id=?1 AND note_id=?2 AND stage_object IS NULL",params![plan_id,note_id,staged,object])
   .map_err(|_|KnowledgeError{code:"knowledge-import-uncertain",message:"Cannot journal import staging".into()}).and_then(|n|if n==1{Ok(())}else{Err(KnowledgeError{code:"knowledge-import-uncertain",message:"Import staging changed".into()})})
 });
    let doc = match outcome {
        Ok(r) => r.document,
        Err(e) => {
            let e = import_error(e);
            let state = if e.1 == "IMPORT_PATH_CONFLICT" {
                "conflict"
            } else {
                "uncertain"
            };
            db.execute(
                "UPDATE companion_import_entry SET state=?3 WHERE plan_id=?1 AND note_id=?2",
                params![plan_id, note_id, state],
            )
            .map_err(db_error)?;
            return Err(e);
        }
    };
    let value = document_value(gateway, vault, note_id, &doc)?;
    let object = knowledge
        .companion_document_identity(&doc.summary.document_ref, target)
        .map_err(import_error)?
        .ok_or((409, "IMPORT_PUBLICATION_UNCERTAIN"))?;
    let owned: String = db
        .query_row(
            "SELECT stage_object FROM companion_import_entry WHERE plan_id=?1 AND note_id=?2",
            params![plan_id, note_id],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    if object != owned || doc.content != input.content {
        return Err((409, "IMPORT_PUBLICATION_UNCERTAIN"));
    }
    let rev = value["revision"]
        .as_str()
        .ok_or((503, "CONTENT_UNAVAILABLE"))?;
    let mut summary = value.clone();
    summary.as_object_mut().unwrap().remove("content");
    summary.as_object_mut().unwrap().remove("resources");
    let result = json!({"opId":input.op_id,"planId":plan_id,"mappingHash":plan.mapping_hash,"noteId":note_id,"state":"committed","document":value});
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    tx.execute("INSERT INTO companion_content_note(vault_key,note_id,path,revision,file_revision,object_id,summary,deleted) VALUES(?1,?2,?3,?4,?5,?6,?7,0)",params![vault,note_id,path,rev,doc.revision,object,summary.to_string()]).map_err(db_error)?;
    change(&tx, vault, note_id, rev, false)?;
    tx.execute("UPDATE companion_import_entry SET state='committed',receipt=?3 WHERE plan_id=?1 AND note_id=?2",params![plan_id,note_id,result.to_string()]).map_err(db_error)?;
    finish(&tx, device, &input.op_id, &result)?;
    tx.commit().map_err(db_error)?;
    knowledge.notify_companion_committed(&doc.summary.document_ref.vault_id, vec![path]);
    Ok(result)
}
fn status(
    db: &Connection,
    device: &str,
    target: &KnowledgeTargetIdentity,
    vault: &str,
    id: &str,
) -> ContentResult<Value> {
    let plan = load(db, device, id, target, vault)?;
    let mut value = plan.mapping;
    let mut s=db.prepare("SELECT note_id,state,receipt FROM companion_import_entry WHERE plan_id=?1 ORDER BY ordinal").map_err(db_error)?;
    let rows = s
        .query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    let mut entries = Vec::new();
    let mut complete = !rows.is_empty();
    for (note, state, receipt) in rows {
        complete &= state == "committed" && receipt.is_some();
        let receipt = receipt
            .map(|s| serde_json::from_str::<Value>(&s))
            .transpose()
            .map_err(|_| (503, "CONTENT_STORE_UNAVAILABLE"))?;
        entries.push(json!({"noteId":note,"state":state,"receipt":receipt}));
    }
    value["entries"] = json!(entries);
    value["complete"] = json!(complete);
    value["state"] = json!(if complete { "complete" } else { "pending" });
    Ok(value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mapping_hash_is_ordered_and_framed() {
        let a = Mapping {
            source_note_id: "a".into(),
            note_id: "kn-a".into(),
            relative_path: "A.md".into(),
        };
        let b = Mapping {
            source_note_id: "b".into(),
            note_id: "kn-b".into(),
            relative_path: "B.md".into(),
        };
        assert_ne!(
            mapping_hash("v", "f", &[a.clone(), b.clone()]),
            mapping_hash("v", "f", &[b, a])
        );
        assert_ne!(mapping_hash("ab", "c", &[]), mapping_hash("a", "bc", &[]));
    }
}
