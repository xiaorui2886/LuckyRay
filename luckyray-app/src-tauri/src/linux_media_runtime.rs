//! Linux gating of the native media commands (T16, T14 gap #1 pure-code slice).
//!
//! Windows verifies the packaged media engine and plays with its own player. On
//! Linux the same manifest authority is wired (see
//! `media_transfer::verified_local_video_tools`), but the player itself is not
//! ported yet, so every command reports honestly instead of pretending:
//! - a missing or unverified runtime is a capability refusal with its own code
//!   and "未做任何修改" (nothing is written, nothing is spawned);
//! - a verified runtime still reports the player as unavailable until the
//!   Linux player slice lands.
//! The payloads are `{code, message}` envelopes, the same shape
//! `normalizeKnowledgeError` already parses.
use serde_json::json;

pub(crate) const COMPONENT_MISSING: &str = "native-media-component-missing";
pub(crate) const COMPONENT_MISSING_MESSAGE: &str = "未找到媒体组件，未做任何修改";

/// Error for a missing or unverified packaged media engine. `verified` is the
/// result of `media_transfer::verified_local_video_tools`; a verified runtime is
/// deliberately *not* reported as a missing component.
pub(crate) fn component_missing_error(verified: &Result<std::path::PathBuf, String>) -> Option<String> {
    match verified {
        Ok(_) => None,
        Err(_) => Some(
            json!({"code": COMPONENT_MISSING, "message": COMPONENT_MISSING_MESSAGE}).to_string(),
        ),
    }
}

/// `material_native_video_command` capability answer. The Linux player is not
/// wired yet, so playback stays unavailable even when the runtime verifies;
/// `runtimeVerified` only reports the packaging state, which keeps the answer
/// honest for the frontend instead of implying a player exists.
pub(crate) fn capability_payload(verified: &Result<std::path::PathBuf, String>) -> serde_json::Value {
    json!({
        "available": false,
        "runtimeVerified": verified.is_ok(),
        "reason": if verified.is_ok() { "native-video-player-unported" } else { COMPONENT_MISSING },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn component_missing_error_is_reported_only_without_a_verified_runtime() {
        let verified: Result<std::path::PathBuf, String> = Ok(std::path::PathBuf::from("/synthetic"));
        assert!(component_missing_error(&verified).is_none());
        let unverified: Result<std::path::PathBuf, String> =
            Err("native-video-tools-unavailable".into());
        let payload = component_missing_error(&unverified).expect("missing runtime");
        let parsed: serde_json::Value = serde_json::from_str(&payload).expect("envelope");
        assert_eq!(parsed["code"], COMPONENT_MISSING);
        assert_eq!(parsed["message"], COMPONENT_MISSING_MESSAGE);
    }

    #[test]
    fn capability_payload_reports_the_player_and_the_runtime_honestly() {
        let verified: Result<std::path::PathBuf, String> = Ok(std::path::PathBuf::from("/synthetic"));
        let payload = capability_payload(&verified);
        assert_eq!(payload["available"], false);
        assert_eq!(payload["runtimeVerified"], true);
        assert_eq!(payload["reason"], "native-video-player-unported");
        let unverified: Result<std::path::PathBuf, String> = Err("missing".into());
        let payload = capability_payload(&unverified);
        assert_eq!(payload["available"], false);
        assert_eq!(payload["runtimeVerified"], false);
        assert_eq!(payload["reason"], COMPONENT_MISSING);
    }
}
