//! Tauri app commands are not restricted by the plugin capability list alone.
//! This outer gate runs before the production generated command dispatcher.
//! Other window families keep their existing policies; registered workspace
//! content can reach only its scoped dispatcher, which validates each grant.

const WORKSPACE_COMMAND: &str = "workspace_window_command";
const DENIED: &str = "workspace-command-not-allowed";

pub(crate) fn allowed(label: &str, command: &str) -> bool {
    !label.starts_with("workspace-") || command == WORKSPACE_COMMAND
}

// Checked against the pinned Tauri 2.11.2 ipc/mod.rs. No plugin grants are added.
pub(crate) fn guard<R, F>(handler: F) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static
where
    R: tauri::Runtime,
    F: Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
{
    move |invoke| {
        if !allowed(invoke.message.webview_ref().label(), invoke.message.command()) {
            invoke.resolver.reject(DENIED);
            return true;
        }
        handler(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_windows_have_one_exact_scoped_entry_point() {
        for label in ["workspace-real", "workspace-forged", "workspace-"] {
            assert!(allowed(label, WORKSPACE_COMMAND));
            for command in ["get_local_transport_client_config", "read_notes_vault_markdown_file",
                "write_notes_vault_markdown_file", "knowledge_activate_ui_source",
                "knowledge_read_document", "material_catalog_list_assets", "close_window",
                "workspace_window_command_extra", "workspace_fixture_report", "future_app_command"] {
                assert!(!allowed(label, command), "{label} reached {command}");
            }
        }
    }

    #[test]
    fn other_window_families_keep_their_existing_handler_checks() {
        for label in ["main", "extension-window", "material-video-preview", "browser-host"] {
            for command in [WORKSPACE_COMMAND, "close_window", "knowledge_read_document", "future_app_command"] {
                assert!(allowed(label, command));
            }
        }
    }

    #[test]
    fn every_production_legacy_command_is_denied_by_default() {
        let source = include_str!("lib.rs");
        let start = source.find(".invoke_handler(workspace_command_policy::guard(tauri::generate_handler![").unwrap();
        let commands = source[start..].split_once("![").unwrap().1.split_once("]))").unwrap().0;
        let mut checked = 0;
        for line in commands.lines() {
            let command = line.trim().trim_end_matches(',').rsplit("::").next().unwrap_or("");
            if command.is_empty() || command.starts_with("//") { continue; }
            assert_eq!(allowed("workspace-production", command), command == WORKSPACE_COMMAND, "{command}");
            checked += 1;
        }
        assert!(checked > 100, "the test must inventory the full production command table");
    }
}
