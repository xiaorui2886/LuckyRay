//! Compile and exercise the production Linux Secret Service seams without Tauri.
//!
//! The module paths are kept identical to src-tauri (`crate::companion_keyring`)
//! so `community_mcp_secret.rs` compiles here unchanged.
#![cfg(target_os = "linux")]
#![allow(dead_code)]
#[path = "../../../src-tauri/src/companion_keyring.rs"]
pub mod companion_keyring;
#[path = "../../../src-tauri/src/community_mcp_secret.rs"]
pub mod community_mcp_secret;
#[cfg(test)]
mod live_secret_service;
