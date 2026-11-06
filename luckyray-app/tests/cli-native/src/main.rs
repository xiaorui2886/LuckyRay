//! Runs the production CLI parser, dispatcher, and HTTP client without Tauri.
//! The only substituted boundary is local credential/proof cryptography. This
//! fixture cannot validate production credential storage/HMAC and does not claim
//! to; the full app's tool_client/local_transport unit tests cover that boundary.
#![allow(dead_code)]

#[path = "../../../src-tauri/src/tool_cli.rs"]
mod tool_cli;
#[path = "../../../src-tauri/src/tool_client.rs"]
mod tool_client;

mod local_transport {
    use std::path::Path;
    pub(crate) const LOCAL_TRANSPORT_PROTOCOL_VERSION: u32 = 1;

    pub(crate) fn load_native_credential(root: &Path) -> Result<String, String> {
        std::fs::read_to_string(root.join("fixture-native-credential"))
            .map_err(|_| "app-unavailable".to_string())
    }

    pub(crate) fn verify_native_proof(
        credential: &str,
        _port: u16,
        _client_nonce: &str,
        _server_nonce: &str,
        proof: &str,
    ) -> bool {
        credential == "PRIVATE-FIXTURE-CREDENTIAL-SENTINEL" && proof == "f".repeat(64)
    }
}

fn main() {
    std::process::exit(tool_cli::run());
}
