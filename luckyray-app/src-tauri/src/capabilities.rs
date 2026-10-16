use crate::{backend, canonical_knowledge_capability_id, knowledge, materials};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::sync::{Arc, Barrier, Mutex, OnceLock};

#[cfg(test)]
static FAIL_NEXT_POST_WRITE_INDEX_REFRESH: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
type CapabilityCreateBarrier = Arc<(Barrier, Barrier)>;

#[cfg(test)]
static BEFORE_CAPABILITY_CREATE: OnceLock<Mutex<Option<(String, CapabilityCreateBarrier)>>> =
    OnceLock::new();

#[cfg(test)]
pub(crate) fn fail_next_post_write_index_refresh() {
    FAIL_NEXT_POST_WRITE_INDEX_REFRESH.store(true, Ordering::Release);
}

#[cfg(test)]
pub(crate) fn block_before_capability_create(title: &str) -> CapabilityCreateBarrier {
    let barrier = Arc::new((Barrier::new(2), Barrier::new(2)));
    *BEFORE_CAPABILITY_CREATE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("capability create hook lock") = Some((title.to_string(), barrier.clone()));
    barrier
}

#[derive(Clone, Debug)]
pub(crate) struct KnowledgeCapabilityOutcome {
    pub(crate) last_result: String,
    pub(crate) summary: String,
    pub(crate) result: serde_json::Value,
    pub(crate) index_warning: Option<knowledge::KnowledgeMutationWarning>,
    pub(crate) index_stale: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct CapabilityExecutionError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl CapabilityExecutionError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn from_knowledge(error: knowledge::KnowledgeError) -> Self {
        Self::new(error.code, error.message)
    }

    pub(crate) fn storage_message(&self) -> String {
        format!("{}: {}", self.code, self.message)
    }
}

fn capability_object(
    input: Option<&serde_json::Value>,
) -> Option<&serde_json::Map<String, serde_json::Value>> {
    input.and_then(serde_json::Value::as_object)
}

fn capability_params(
    input: Option<&serde_json::Value>,
) -> Option<&serde_json::Map<String, serde_json::Value>> {
    capability_object(input)
        .and_then(|object| object.get("params"))
        .and_then(serde_json::Value::as_object)
}

fn capability_value<'a>(
    input: Option<&'a serde_json::Value>,
    key: &str,
) -> Option<&'a serde_json::Value> {
    capability_object(input)
        .and_then(|object| object.get(key))
        .or_else(|| capability_params(input).and_then(|params| params.get(key)))
}

fn capability_string(input: Option<&serde_json::Value>, key: &str) -> Option<String> {
    capability_value(input, key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn capability_text(input: Option<&serde_json::Value>) -> String {
    match input {
        Some(serde_json::Value::String(value)) => value.trim().to_string(),
        Some(_) => capability_string(input, "text").unwrap_or_default(),
        None => String::new(),
    }
}

fn capability_u64(input: Option<&serde_json::Value>, key: &str) -> Option<u64> {
    capability_value(input, key).and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
    })
}

fn capability_bool(input: Option<&serde_json::Value>, key: &str, default: bool) -> bool {
    capability_value(input, key)
        .and_then(|value| {
            value
                .as_bool()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
        .unwrap_or(default)
}

fn capability_document_ref(
    input: Option<&serde_json::Value>,
) -> Result<Option<knowledge::KnowledgeDocumentRef>, CapabilityExecutionError> {
    if let Some(value) = capability_value(input, "documentRef") {
        let document_ref = serde_json::from_value::<knowledge::KnowledgeDocumentRef>(value.clone())
            .map_err(|_| {
                CapabilityExecutionError::new(
                    "knowledge-invalid-document-ref",
                    "Knowledge document reference is invalid",
                )
            })?;
        return Ok(Some(document_ref));
    }
    capability_string(input, "documentId")
        .map(|value| {
            knowledge::KnowledgeService::parse_document_id(&value)
                .map_err(CapabilityExecutionError::from_knowledge)
        })
        .transpose()
}

fn resolve_capability_document(
    knowledge: &knowledge::KnowledgeService,
    input: Option<&serde_json::Value>,
) -> Result<knowledge::KnowledgeDocumentSnapshot, CapabilityExecutionError> {
    let (document_ref, context_revision) = match capability_document_ref(input)? {
        Some(document_ref) => (document_ref, None),
        None => {
            let context = knowledge
                .get_current_context()
                .map_err(CapabilityExecutionError::from_knowledge)?
                .ok_or_else(|| {
                    CapabilityExecutionError::new(
                        "knowledge-current-context-required",
                        "Select a Knowledge document before running this capability",
                    )
                })?;
            (context.document_ref, Some(context.expected_revision))
        }
    };
    let snapshot = knowledge
        .read_document(&document_ref)
        .map_err(CapabilityExecutionError::from_knowledge)?;
    let expected_revision = capability_string(input, "expectedRevision").or(context_revision);
    if expected_revision
        .as_deref()
        .is_some_and(|revision| revision != snapshot.revision)
    {
        return Err(CapabilityExecutionError::new(
            "knowledge-revision-conflict",
            "Knowledge document changed before the capability ran",
        ));
    }
    Ok(snapshot)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut output = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        output.push('…');
    }
    output
}

fn summarize_capability_text(value: &str, style: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return String::new();
    }
    let max_chars = max_chars.clamp(20, 2_000);
    match style {
        "bullets" => value
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("---"))
            .take(5)
            .map(|line| {
                format!(
                    "- {}",
                    truncate_chars(line.trim_start_matches('#').trim(), max_chars)
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        "actions" => {
            let actions = value
                .lines()
                .map(str::trim)
                .filter(|line| {
                    let lower = line.to_lowercase();
                    lower.contains("todo") || lower.contains("action") || line.contains("待办")
                })
                .take(5)
                .map(|line| format!("- [ ] {}", truncate_chars(line, max_chars)))
                .collect::<Vec<_>>();
            if actions.is_empty() {
                format!("- [ ] {}", truncate_chars(&compact, max_chars))
            } else {
                actions.join("\n")
            }
        }
        _ => truncate_chars(&compact, max_chars),
    }
}

fn knowledge_index_warning(
    snapshot: &knowledge::KnowledgeIndexSnapshot,
) -> Option<knowledge::KnowledgeMutationWarning> {
    if !snapshot.stale && snapshot.refresh_error.is_none() && snapshot.errors.is_empty() {
        return None;
    }
    let code = snapshot
        .refresh_error
        .as_ref()
        .map(|error| error.code.clone())
        .or_else(|| snapshot.errors.first().map(|error| error.code.clone()))
        .unwrap_or_else(|| "knowledge-index-stale".to_string());
    Some(knowledge::KnowledgeMutationWarning {
        code,
        message: "Document operation completed, but the Knowledge index is stale".to_string(),
    })
}

fn refresh_after_capability_write(
    knowledge: &knowledge::KnowledgeService,
) -> (Option<knowledge::KnowledgeMutationWarning>, bool) {
    #[cfg(test)]
    if FAIL_NEXT_POST_WRITE_INDEX_REFRESH.swap(false, Ordering::AcqRel) {
        knowledge.fail_next_index_refresh();
    }
    match knowledge.refresh_index() {
        Ok(snapshot) => {
            let stale =
                snapshot.stale || snapshot.refresh_error.is_some() || !snapshot.errors.is_empty();
            (knowledge_index_warning(&snapshot), stale)
        }
        Err(error) => (
            Some(knowledge::KnowledgeMutationWarning {
                code: error.code.to_string(),
                message: "Document was saved, but the Knowledge index refresh failed".to_string(),
            }),
            true,
        ),
    }
}

fn create_capability_document(
    knowledge: &knowledge::KnowledgeService,
    expected_vault_id: &str,
    input: Option<&serde_json::Value>,
    create: &knowledge::KnowledgeCreateInput,
) -> Result<knowledge::KnowledgeDocumentSnapshot, CapabilityExecutionError> {
    #[cfg(test)]
    let barrier = {
        let mut hook = BEFORE_CAPABILITY_CREATE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .expect("capability create hook lock");
        if hook
            .as_ref()
            .is_some_and(|(title, _)| title == &create.title)
        {
            hook.take().map(|(_, barrier)| barrier)
        } else {
            None
        }
    };
    #[cfg(test)]
    if let Some(barrier) = barrier {
        barrier.0.wait();
        barrier.1.wait();
    }
    match capability_u64(input, "sourceEpoch") {
        Some(source_epoch) => knowledge
            .create_document_from_ui(source_epoch, create)
            .map_err(CapabilityExecutionError::from_knowledge),
        None => knowledge
            .create_document_for_expected_vault(expected_vault_id, create)
            .map_err(CapabilityExecutionError::from_knowledge),
    }
}

fn validate_web_source_url(
    value: Option<String>,
) -> Result<Option<String>, CapabilityExecutionError> {
    let Some(value) = value else { return Ok(None) };
    if value.len() > 8_192
        || value.chars().any(char::is_control)
        || !(value.starts_with("https://") || value.starts_with("http://"))
    {
        return Err(CapabilityExecutionError::new(
            "capability-web-source-invalid",
            "Web source metadata must be an HTTP or HTTPS URL",
        ));
    }
    Ok(Some(value))
}

fn latest_collected_web_content(
    backend: &backend::BackendServices,
) -> Result<Option<(String, Option<String>, String)>, CapabilityExecutionError> {
    let connection = backend.open_read().map_err(|_| {
        CapabilityExecutionError::new(
            "capability-collection-unavailable",
            "Collected web content is unavailable",
        )
    })?;
    let row = connection.query_row(
        "SELECT content, url_metadata FROM collection_item WHERE type = 'link' ORDER BY created_at DESC, rowid DESC LIMIT 1",
        [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    );
    match row {
        Ok((content, metadata)) => {
            let metadata = serde_json::from_str::<serde_json::Value>(&metadata).unwrap_or_default();
            let title = metadata
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("网页收藏")
                .trim();
            let url = metadata
                .get("url")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            Ok(Some((
                if title.is_empty() {
                    "网页收藏"
                } else {
                    title
                }
                .to_string(),
                url,
                content,
            )))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(_) => Err(CapabilityExecutionError::new(
            "capability-collection-unavailable",
            "Collected web content is unavailable",
        )),
    }
}

pub(crate) fn execute_knowledge_capability(
    backend: &backend::BackendServices,
    id_or_run_kind: &str,
    input: Option<&serde_json::Value>,
) -> Result<KnowledgeCapabilityOutcome, CapabilityExecutionError> {
    let id = canonical_knowledge_capability_id(id_or_run_kind).ok_or_else(|| {
        CapabilityExecutionError::new(
            "capability-not-found",
            "Knowledge capability does not exist",
        )
    })?;
    let knowledge = backend.knowledge();
    let initial_index = knowledge
        .refresh_index()
        .map_err(CapabilityExecutionError::from_knowledge)?;
    let initial_vault_id = initial_index.vault_id.clone();
    let initial_warning = knowledge_index_warning(&initial_index);
    match id {
        "skill.summary" => {
            let explicit_text = capability_text(input);
            let (text, document) = if explicit_text.is_empty() {
                let document = resolve_capability_document(&knowledge, input)?;
                (document.content.clone(), Some(document))
            } else {
                (explicit_text, None)
            };
            let style = capability_string(input, "style").unwrap_or_else(|| "short".to_string());
            if !matches!(style.as_str(), "short" | "bullets" | "actions") {
                return Err(CapabilityExecutionError::new(
                    "capability-parameter-invalid",
                    "Summary style is invalid",
                ));
            }
            let max_chars = capability_u64(input, "maxChars")
                .unwrap_or(80)
                .clamp(20, 2_000) as usize;
            let summary = summarize_capability_text(&text, &style, max_chars);
            if summary.is_empty() {
                return Err(CapabilityExecutionError::new(
                    "capability-input-required",
                    "Summary input is empty",
                ));
            }
            let document_value = document.as_ref().map(|snapshot| {
                serde_json::json!({
                    "id": knowledge::KnowledgeService::document_id(&snapshot.summary.document_ref),
                    "documentRef": snapshot.summary.document_ref,
                    "title": snapshot.summary.title,
                    "revision": snapshot.revision,
                })
            });
            Ok(KnowledgeCapabilityOutcome {
                last_result: summary.clone(),
                summary: summary.clone(),
                result: serde_json::json!({
                    "kind": "summary",
                    "style": style,
                    "summary": summary,
                    "document": document_value,
                }),
                index_stale: initial_warning.is_some(),
                index_warning: initial_warning,
            })
        }
        "skill.search_intent" => {
            let query = capability_string(input, "query").unwrap_or_else(|| capability_text(input));
            let limit = capability_u64(input, "limit").unwrap_or(5).clamp(1, 50) as usize;
            let scope = capability_string(input, "scope").unwrap_or_else(|| "all".to_string());
            if !matches!(scope.as_str(), "all" | "notes" | "assets") {
                return Err(CapabilityExecutionError::new(
                    "capability-parameter-invalid",
                    "Search scope is invalid",
                ));
            }
            let warning = initial_warning;
            let index_stale = warning.is_some();
            let documents =
                if scope != "assets" {
                    let needle = query.to_lowercase();
                    initial_index
                    .documents
                    .into_iter()
                    .filter(|document| {
                        needle.is_empty()
                            || document.title.to_lowercase().contains(&needle)
                            || document.plain_text.to_lowercase().contains(&needle)
                    })
                    .take(limit)
                    .map(|document| serde_json::json!({
                        "id": knowledge::KnowledgeService::document_id(&document.document_ref),
                        "documentRef": document.document_ref,
                        "title": document.title,
                        "excerpt": document.excerpt,
                        "revision": document.revision,
                    }))
                    .collect::<Vec<_>>()
                } else {
                    Vec::new()
                };
            let assets = if scope != "notes" {
                let catalog = backend.material_catalog();
                if query.is_empty() {
                    catalog
                        .list_assets(&materials::MaterialFilter {
                            recent_only: true,
                            limit: Some(limit as u32),
                            ..Default::default()
                        })
                        .map_err(|error| CapabilityExecutionError::new("material-catalog-error", error.message))?
                        .into_iter()
                        .take(limit)
                        .map(|asset| serde_json::json!({ "id": asset.id, "name": asset.name, "kind": asset.kind }))
                        .collect::<Vec<_>>()
                } else {
                    let fts_query = format!("\"{}\"", query.replace('"', "\"\""));
                    catalog
                        .search_assets(&fts_query, limit)
                        .map_err(|error| {
                            CapabilityExecutionError::new("material-catalog-error", error.message)
                        })?
                        .into_iter()
                        .map(|hit| {
                            serde_json::json!({
                                "id": hit.asset.id,
                                "name": hit.asset.name,
                                "kind": hit.asset.kind,
                                "excerpt": hit.snippet,
                            })
                        })
                        .collect::<Vec<_>>()
                }
            } else {
                Vec::new()
            };
            let summary = format!(
                "找到 {} 篇知识文档、{} 个素材",
                documents.len(),
                assets.len()
            );
            Ok(KnowledgeCapabilityOutcome {
                last_result: summary.clone(),
                summary,
                result: serde_json::json!({
                    "kind": "search",
                    "query": query,
                    "scope": scope,
                    "documents": documents,
                    "assets": assets,
                }),
                index_warning: warning,
                index_stale,
            })
        }
        "wf.web_to_note" => {
            let supplied_content = capability_string(input, "content").or_else(|| {
                let text = capability_text(input);
                (!text.is_empty()).then_some(text)
            });
            let fallback = if supplied_content.is_none() {
                latest_collected_web_content(backend)?
            } else {
                None
            };
            let title = capability_string(input, "title")
                .or_else(|| fallback.as_ref().map(|value| value.0.clone()))
                .unwrap_or_else(|| "网页收藏".to_string());
            let url = validate_web_source_url(
                capability_string(input, "url")
                    .or_else(|| fallback.as_ref().and_then(|value| value.1.clone())),
            )?;
            let content = supplied_content
                .or_else(|| fallback.map(|value| value.2))
                .ok_or_else(|| {
                    CapabilityExecutionError::new(
                        "capability-input-required",
                        "Captured web content is required",
                    )
                })?;
            if content.as_bytes().len() > 512 * 1024 {
                return Err(CapabilityExecutionError::new(
                    "capability-input-too-large",
                    "Captured web content exceeds the capability limit",
                ));
            }
            if content.contains('\0') {
                return Err(CapabilityExecutionError::new(
                    "capability-input-invalid",
                    "Captured web content contains an invalid character",
                ));
            }
            let include_source = capability_bool(input, "includeSource", true);
            let body = if include_source {
                match url.as_deref() {
                    Some(url) => format!(
                        "---\nsource: {}\n---\n\n{}",
                        serde_json::to_string(url).unwrap_or_else(|_| "\"\"".to_string()),
                        content
                    ),
                    None => content,
                }
            } else {
                content
            };
            let document = create_capability_document(
                &knowledge,
                &initial_vault_id,
                input,
                &knowledge::KnowledgeCreateInput {
                    title,
                    parent_relative_path: capability_string(input, "parentRelativePath"),
                    content: body,
                },
            )?;
            let (index_warning, index_stale) = refresh_after_capability_write(&knowledge);
            let id = knowledge::KnowledgeService::document_id(&document.summary.document_ref);
            let summary = if index_warning.is_some() {
                "网页内容已保存到 Vault，索引刷新稍后重试".to_string()
            } else {
                "网页内容已保存到 Vault".to_string()
            };
            Ok(KnowledgeCapabilityOutcome {
                last_result: document.summary.title.clone(),
                summary,
                result: serde_json::json!({
                    "kind": "document-created",
                    "id": id,
                    "documentRef": document.summary.document_ref,
                    "title": document.summary.title,
                    "revision": document.revision,
                }),
                index_warning,
                index_stale,
            })
        }
        "wf.note_to_summary" => {
            let source = resolve_capability_document(&knowledge, input)?;
            let style = capability_string(input, "style").unwrap_or_else(|| "bullets".to_string());
            if !matches!(style.as_str(), "short" | "bullets" | "actions") {
                return Err(CapabilityExecutionError::new(
                    "capability-parameter-invalid",
                    "Summary style is invalid",
                ));
            }
            let summary_text = summarize_capability_text(&source.content, &style, 400);
            if summary_text.is_empty() {
                return Err(CapabilityExecutionError::new(
                    "capability-input-required",
                    "Knowledge document is empty",
                ));
            }
            let title = capability_string(input, "title")
                .unwrap_or_else(|| format!("{} 摘要", source.summary.title));
            let content = format!(
                "# {}\n\n来源文档：{}\n\n{}",
                title,
                knowledge::KnowledgeService::document_id(&source.summary.document_ref),
                summary_text
            );
            let document = create_capability_document(
                &knowledge,
                &initial_vault_id,
                input,
                &knowledge::KnowledgeCreateInput {
                    title,
                    parent_relative_path: capability_string(input, "parentRelativePath"),
                    content,
                },
            )?;
            let (index_warning, index_stale) = refresh_after_capability_write(&knowledge);
            let id = knowledge::KnowledgeService::document_id(&document.summary.document_ref);
            let summary = if index_warning.is_some() {
                "摘要笔记已写入 Vault，索引刷新稍后重试".to_string()
            } else {
                "摘要笔记已写入 Vault".to_string()
            };
            Ok(KnowledgeCapabilityOutcome {
                last_result: summary_text.clone(),
                summary,
                result: serde_json::json!({
                    "kind": "document-created",
                    "id": id,
                    "documentRef": document.summary.document_ref,
                    "title": document.summary.title,
                    "revision": document.revision,
                    "source": {
                        "id": knowledge::KnowledgeService::document_id(&source.summary.document_ref),
                        "documentRef": source.summary.document_ref,
                        "revision": source.revision,
                    },
                    "summary": summary_text,
                }),
                index_warning,
                index_stale,
            })
        }
        _ => unreachable!(),
    }
}
