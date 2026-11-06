//! AI remains host-owned: a plugin receives only sanitized text, never settings.
use crate::extension_broker::{AiSelection, Rpc, Session};
use crate::extension_ai_redactor::Redactor;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{path::Path, sync::{Arc, OnceLock, atomic::{AtomicBool, Ordering}}, time::Duration};

type HmacSha256 = Hmac<Sha256>;
fn fingerprint(config: &crate::AiModelConfig) -> String {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    let mut mac = HmacSha256::new_from_slice(KEY.get_or_init(rand::random)).expect("valid HMAC key");
    // The keyed token freezes even credential/endpoint changes without exposing either.
    mac.update(&serde_json::to_vec(&json!([config.provider, config.protocol, config.model, config.custom_url, config.api_key])).expect("settings serialize"));
    mac.finalize().into_bytes().iter().map(|byte| format!("{byte:02x}")).collect()
}
pub fn selection(root: &Path) -> Result<AiSelection, String> {
    let config = crate::load_ai_model_config_read_only(&root.join("luckyray.db"))
        .map_err(|_| "plugin-ai-unavailable")?;
    if config.model.trim().is_empty() || config.provider.trim().is_empty() {
        return Err("plugin-ai-unavailable".into());
    }
    Ok(AiSelection { provider: config.provider.clone(), model: config.model.clone(), fingerprint: fingerprint(&config) })
}

async fn wait_for_retirement(live: Arc<AtomicBool>, stop: Arc<AtomicBool>) {
    while live.load(Ordering::SeqCst) && !stop.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
async fn bounded<T>(
    operation: impl std::future::Future<Output = Result<T, String>>,
    live: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    deadline: Duration,
) -> Result<T, String> {
    tokio::select! {
        result = operation => result,
        _ = wait_for_retirement(live, stop) => Err("plugin-retired".into()),
        _ = tokio::time::sleep(deadline) => Err("plugin-ai-timeout".into()),
    }
}

pub fn dispatch(root: &Path, session: &mut Session, call: &Rpc) -> Result<Value, String> {
    let selected = session.scope.ai_selection.as_ref().ok_or("plugin-ai-not-selected")?;
    let config = crate::load_ai_model_config_read_only(&root.join("luckyray.db")).map_err(|_| "plugin-ai-unavailable")?;
    if fingerprint(&config) != selected.fingerprint || config.provider != selected.provider || config.model != selected.model {
        return Err("plugin-ai-selection-changed".into());
    }
    let prompt = call.params.get("prompt").and_then(Value::as_str).ok_or("plugin-parameters")?;
    if prompt.trim().is_empty() || prompt.len() > 16_000 { return Err("plugin-ai-input-limit".into()); }
    let secret = crate::normalize_ai_api_key(&config.api_key);
    let live = session.live_flag();
    let stop = Arc::new(AtomicBool::new(false));
    let msg = crate::AiChatRequestMessage { role: "user".into(), content: json!(prompt) };
    let deadline = Duration::from_secs(60);
    if call.method == "ai.generate" {
        let request = crate::AiChatRequest { messages: vec![msg], system_prompt: None, temperature: None, max_tokens: Some(1024), model: None };
        let result = tauri::async_runtime::block_on(bounded(async {
            crate::plugin_ai_complete_transport(config, request, deadline).await.map_err(|_| "plugin-ai-failed".to_string())
        }, live, stop, deadline))?;
        if !result.success { return Err(format!("plugin-ai-{}", result.error_kind.unwrap_or_else(|| "failed".into()))); }
        let text = result.content.unwrap_or_default();
        if text.len() > 32_000 { return Err("plugin-ai-output-limit".into()); }
        return Ok(json!({"text": if secret.is_empty() { text } else { text.replace(&secret, "[redacted]") }}));
    }
    let request = crate::AiChatStreamRequest { stream_id: format!("plugin-{:032x}", rand::random::<u128>()), messages: vec![msg], system_prompt: None, temperature: None, max_tokens: Some(1024) };
    let mut redactor = Redactor::new(secret.clone());
    let mut bytes = 0usize;
    let cancelled = stop.clone();
    let output_limited = Arc::new(AtomicBool::new(false));
    let limit_flag = output_limited.clone();
    let result = tauri::async_runtime::block_on(async {
        let stream = crate::ai_chat_stream_with_config(config, request, true, |event| {
            if let Some(delta) = event.delta {
                bytes = bytes.saturating_add(delta.len());
                if bytes > 32_000 { limit_flag.store(true, Ordering::SeqCst); cancelled.store(true, Ordering::SeqCst); return; }
                let safe = redactor.push(&delta, false);
                if !safe.is_empty() && session.stream_chunk(&safe).is_err() { cancelled.store(true, Ordering::SeqCst); }
            }
        });
        bounded(async { stream.await.map_err(|_| "plugin-ai-failed".to_string()) }, live, stop, deadline).await
    });
    if output_limited.load(Ordering::SeqCst) { return Err("plugin-ai-output-limit".into()); }
    let result = result?;
    if !result.success { return Err(format!("plugin-ai-{}", result.error_kind.unwrap_or_else(|| "failed".into()))); }
    let tail = redactor.push("", true);
    if !tail.is_empty() { session.stream_chunk(&tail)?; }
    let text = result.content.unwrap_or_default();
    if text.len() > 32_000 { return Err("plugin-ai-output-limit".into()); }
    Ok(json!({"text": if secret.is_empty() { text } else { text.replace(&secret, "[redacted]") }}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_never_migrates_plaintext_and_never_projects_credentials() {
        let root = tempfile::tempdir().unwrap();
        let db = rusqlite::Connection::open(root.path().join("luckyray.db")).unwrap();
        db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES('aiApiKey','synthetic-plaintext');").unwrap();
        assert!(selection(root.path()).is_err());
        let stored: String = db.query_row("SELECT value FROM settings WHERE key='aiApiKey'", [], |row| row.get(0)).unwrap();
        assert_eq!(stored, "synthetic-plaintext");
        #[cfg(windows)] {
            crate::ai_secret_store::write(&db, "aiApiKey", "synthetic-protected-key").unwrap();
            let first = selection(root.path()).unwrap();
            let serialized = serde_json::to_string(&first).unwrap();
            assert!(!serialized.contains("synthetic-protected-key"));
            db.execute("INSERT OR REPLACE INTO settings VALUES('aiModel','fixture-other-model')", []).unwrap();
            assert_ne!(first.fingerprint, selection(root.path()).unwrap().fingerprint);
        }
    }
    #[test]
    fn timeout_and_retirement_drop_a_pending_operation() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        let live = Arc::new(AtomicBool::new(true));
        let stop = Arc::new(AtomicBool::new(false));
        let pending = || async { std::future::pending::<Result<(), String>>().await };
        assert_eq!(rt.block_on(bounded(pending(), live.clone(), stop.clone(), Duration::from_millis(20))), Err("plugin-ai-timeout".into()));
        live.store(false, Ordering::SeqCst);
        assert_eq!(rt.block_on(bounded(pending(), live, stop, Duration::from_secs(1))), Err("plugin-retired".into()));
    }
}
