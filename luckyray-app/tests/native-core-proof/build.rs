use std::{env, fs, path::PathBuf};
fn item(source: &str, start: &str) -> String {
    let at = source
        .match_indices(start)
        .find(|(i, _)| {
            source
                .as_bytes()
                .get(i + start.len())
                .is_none_or(|c| !c.is_ascii_alphanumeric() && *c != b'_')
        })
        .map(|(i, _)| i)
        .unwrap_or_else(|| panic!("missing source item {start}"));
    let tail = &source[at..];
    let end = tail.find("\n}\n").expect("column-zero item close") + 3;
    tail[..end].to_owned()
}
fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../..")
        .canonicalize()
        .unwrap();
    let registry = root.join("src-tauri/src/tools/mod.rs");
    let source = fs::read_to_string(&registry).unwrap();
    println!("cargo:rerun-if-changed={}", registry.display());
    let mut generated = String::new();
    for name in ["ToolAvailability", "ToolDefinition"] {
        generated.push_str("#[derive(Clone,Debug,serde::Serialize)]\n");
        generated.push_str(&item(&source, &format!("pub(crate) struct {name}")));
    }
    for name in [
        "definition",
        "available",
        "unavailable",
        "object_schema",
        "string_schema",
        "integer_schema",
        "enum_schema",
        "document_ref_schema",
        "document_identity_schema",
        "document_mutation_schema",
        "generic_output_schema",
        "document_output_schema",
        "mutation_value",
        "document_value",
        "parse_document_ref",
        "required_string",
        "optional_u64",
        "split_markdown_path",
        "require_live_vault",
        "require_expected_vault",
        "validate_schema",
        "validate_schema_shape",
        "validate_definitions",
        "validate_json_limits",
        "validate_request_id",
    ] {
        generated.push_str(&item(&source, &format!("fn {name}")));
        generated.push('\n');
    }
    generated.push_str(&format!(
        "#[path={:?}] mod native;\n",
        root.join("src-tauri/src/tools/native.rs")
    ));
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("registry_helpers.rs"),
        generated,
    )
    .unwrap();
    let source = fs::read_to_string(root.join("src-tauri/src/attachment_file_moves.rs")).unwrap();
    let definition = item(&source, "pub(crate) struct MaterialFileMove");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("material_move_dto.rs"),format!("#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]\n#[serde(rename_all=\"camelCase\")]\n{definition}")).unwrap();
    let knowledge_root = root.join("src-tauri/src/knowledge");
    let original = fs::read_to_string(knowledge_root.join("mod.rs")).unwrap();
    let mut knowledge = String::new();
    for line in original.lines() {
        if let Some(name) = line.strip_prefix("mod ").and_then(|s| s.strip_suffix(';')) {
            knowledge.push_str(&format!(
                "#[path={:?}] mod {name};\n",
                knowledge_root.join(format!("{name}.rs"))
            ));
        } else {
            knowledge.push_str(line);
            knowledge.push('\n');
        }
    }
    // The shipping owner intentionally refuses existing-document mutations on
    // non-Windows. Its attachment modules nevertheless reference two Windows-
    // gated symbols. This fixture supplies ONLY fail-closed missing symbols;
    // it never emulates or enables the Windows write path.
    knowledge.push_str(r#"
#[cfg(not(windows))]
fn write_new_synced(_: &Path, _: &[u8]) -> Result<(), KnowledgeError> {
    Err(error("knowledge-exclusive-write-unsupported", "Fixture platform has no Windows file commit"))
}
#[cfg(not(windows))]
fn move_file_no_replace(_: &Path, _: &Path) -> Result<(), KnowledgeError> {
    Err(error("knowledge-exclusive-write-unsupported", "Fixture platform has no Windows file commit"))
}
"#);
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("knowledge_owner.rs"),
        knowledge,
    )
    .unwrap();
    for file in [
        "tools/native.rs",
        "knowledge/mod.rs",
        "canvas_agent.rs",
        "agent_workspace.rs",
        "workspace_graph.rs",
        "attachment_file_moves.rs",
    ] {
        println!(
            "cargo:rerun-if-changed={}",
            root.join("src-tauri/src").join(file).display()
        );
    }
}
