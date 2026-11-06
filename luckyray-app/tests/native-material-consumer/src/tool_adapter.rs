//! Compiles and exercises the actual native adapter, with source-extracted
//! registry schema validation. This does not stand in for full registry/auth tests.
use crate::backend::BackendServices;
use serde_json::{json,Map,Value};
const MAX_TOOL_OUTPUT_BYTES:usize=512*1024;
const MAX_JSON_DEPTH:usize=16;
const MAX_JSON_NODES:usize=20_000;
#[derive(Debug)]
struct ToolError { code:&'static str, message:String }
impl ToolError {
    fn new(code:&'static str,message:impl Into<String>)->Self { Self {code,message:message.into()} }
}
include!(concat!(env!("OUT_DIR"),"/tool_contract.rs"));
#[path="../../../src-tauri/src/tools/native_materials.rs"] mod native_materials;

pub(crate) fn run(backend:&BackendServices,principal:&crate::local_transport::VerifiedTransportPrincipal) {
    let definitions=native_materials::definitions();
    validate_definitions(&definitions).unwrap();
    assert_eq!(definitions.len(),8);
    let call=|id:&str,input:Value|->Result<Value,ToolError> {
        let definition=definitions.iter().find(|def|def.id==id).expect("known native tool");
        validate_schema(&definition.input_schema,&input,"input")?;
        validate_json_limits(&input)?;
        assert!(serde_json::to_vec(&input).unwrap().len()<=definition.max_input_bytes);
        if definition.risk>=ToolRisk::Write { validate_request_id(required_string(&input,"requestId")?)?; }
        native_materials::authorize(backend,principal,id,&input)?;
        let value=native_materials::execute(backend,principal,id,&input)?;
        validate_schema(&definition.output_schema,&value,"output")?;
        assert!(serde_json::to_vec(&value).unwrap().len()<=definition.max_output_bytes);
        Ok(value)
    };
    let registry=call("materials.libraries",json!({})).unwrap();
    let library=registry["libraries"].as_array().unwrap().iter().find(|item|item["capabilities"]["import"]==true).unwrap()["libraryId"].as_str().unwrap();
    let imported=call("materials.import_bytes",json!({"libraryId":library,"requestId":"adapter.import.1","name":"adapter.md","mimeType":"text/markdown","bytesBase64":"IyBBZGFwdGVyIGZpeHR1cmU="})).unwrap();
    let id=imported["assetId"].as_str().unwrap();
    let detail=call("materials.detail",json!({"libraryId":library,"assetId":id})).unwrap();
    let preview=call("materials.library_preview",json!({"libraryId":library,"assetId":id})).unwrap();
    assert_eq!(preview["content"],"# Adapter fixture");
    let tag=call("materials.organize",json!({"libraryId":library,"requestId":"adapter.tag","action":{"op":"create_tag","name":"adapter"}})).unwrap();
    let updated=call("materials.update",json!({"libraryId":library,"assetId":id,"requestId":"adapter.update","expectedRevision":detail["asset"]["revision"],"patch":{"rating":5,"dominantColor":"#abc"}})).unwrap();
    assert_eq!(updated["asset"]["rating"],5);
    assert_eq!(updated["asset"]["dominantColor"],"#abc");
    let tagged=call("materials.organize",json!({"libraryId":library,"requestId":"adapter.tags","action":{"op":"set_tags","assetId":id,"expectedRevision":updated["asset"]["revision"],"tagIds":[tag["tag"]["id"]]}})).unwrap();
    assert_eq!(tagged["asset"]["tagIds"][0],tag["tag"]["id"]);
    let first=call("materials.list",json!({"libraryId":library,"filter":{"limit":1}})).unwrap();
    let next=first["nextOffset"].as_u64().expect("second fixture asset available");
    let second=call("materials.list",json!({"libraryId":library,"filter":{"limit":1},"offset":next})).unwrap();
    assert_eq!(first["items"].as_array().unwrap().len(),1);
    assert_eq!(second["items"].as_array().unwrap().len(),1);
    assert_ne!(first["items"][0]["id"],second["items"][0]["id"]);
    assert!(second["nextOffset"].is_null());
    let recent=call("materials.list",json!({"libraryId":library,"filter":{"limit":100,"recentOnly":true},"offset":50})).unwrap();
    assert_eq!(recent["items"],json!([]));
    assert!(recent["nextOffset"].is_null());
    assert!(call("materials.library_taxonomy",json!({"libraryId":library})).is_ok());
    assert!(call("materials.update",json!({"libraryId":library,"assetId":id,"requestId":"adapter.invalid","expectedRevision":tagged["asset"]["revision"],"patch":{"originalPath":"/not-authorized"}})).is_err());
    for definition in definitions.iter().filter(|def|def.risk>=ToolRisk::Write) {
        validate_schema(&definition.output_schema,&json!({"committed":true,"outputUnavailable":true}),"output").unwrap();
    }
    println!("PASS actual native-material adapter: all 8 definitions, schema/dispatch, receipt fallback, CAS writes and path-field rejection");
}
