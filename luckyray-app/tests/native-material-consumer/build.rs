use std::{env,fs,path::PathBuf};
fn block(source:&str, start:&str)->String {
    let offset=source.find(start).unwrap_or_else(||panic!("production contract missing {start}"));
    let tail=&source[offset..];
    let end=tail.find("\n}\n").expect("top-level source block")+3;
    tail[..end].to_owned()
}
fn main() {
    let source=PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../src-tauri/src/tools/mod.rs");
    println!("cargo:rerun-if-changed={}",source.display());
    let source=fs::read_to_string(source).unwrap();
    let mut extracted=String::from("// Source-extracted production schema helpers; never substituted business operations.\n");
    for name in ["definition","available","object_schema","string_schema","integer_schema","enum_schema","nullable_string_schema","nullable_integer_schema","required_string","validate_schema","validate_schema_shape","validate_definitions","validate_json_limits","validate_request_id"] {
        extracted.push_str(&block(&source,&format!("fn {name}")));extracted.push('\n');
    }
    for name in ["ToolDefinition","ToolAvailability"] {
        extracted.push_str("#[derive(Clone,Debug,serde::Serialize,serde::Deserialize)]\n#[serde(rename_all=\"camelCase\")]\n");
        extracted.push_str(&block(&source,&format!("pub(crate) struct {name}")));extracted.push('\n');
    }
    extracted.push_str("#[derive(Clone,Copy,Debug,PartialEq,Eq,PartialOrd,Ord,serde::Serialize,serde::Deserialize)]\n#[serde(rename_all=\"lowercase\")]\n");
    extracted.push_str(&block(&source,"pub(crate) enum ToolRisk"));
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("tool_contract.rs"),extracted).unwrap();
}
