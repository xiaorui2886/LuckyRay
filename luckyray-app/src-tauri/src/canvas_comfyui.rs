//! Loopback-only ComfyUI workflow bridge. Jobs are bound before submitting; ambiguous submissions are never replayed.
#[path = "canvas_comfy_template.rs"]
mod template;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use serde_json::Value;
use std::{path::Path, time::Duration};

const KEY: &str = "canvasComfyui.baseUrl.v1";
const DEFAULT: &str = "http://127.0.0.1:8188";
const INVALID: &str = "comfyui-local-address-invalid";
const UNAVAILABLE: &str = "comfyui-settings-unavailable";
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Config {
    pub base_url: String,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_name: Option<String>,
}
#[derive(Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SavedWorkflow { revision: u64, workflow_json: Option<String>, workflow_name: Option<String> }
const WORKFLOW_KEY: &str = "canvasComfyui.workflow.v1";
fn saved_workflow(conn: &Connection) -> Result<SavedWorkflow, &'static str> {
    let raw: Option<String> = conn.query_row("SELECT value FROM settings WHERE key=?1", [WORKFLOW_KEY], |r| r.get(0)).optional().map_err(|_| UNAVAILABLE)?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|_| UNAVAILABLE)).unwrap_or(Ok(SavedWorkflow::default()))
}
fn save_workflow_record(conn: &Connection, value: &SavedWorkflow) -> Result<(), &'static str> {
    let json = serde_json::to_string(value).map_err(|_| UNAVAILABLE)?;
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [WORKFLOW_KEY, &json]).map_err(|_| UNAVAILABLE)?;
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionResult {
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
/// Deliberately loopback-only in this foundation. No DNS lookup, redirects,
/// auth material, query parameters, or implicit remote/LAN server support.
pub(crate) fn validated_base(input: &str) -> Result<String, &'static str> {
    let raw = input.trim();
    if raw.is_empty() || raw.len() > 2048 || raw.chars().any(char::is_control) || raw.contains('\\') { return Err(INVALID); }
    let mut url = reqwest::Url::parse(raw).map_err(|_| INVALID)?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some() { return Err(INVALID); }
    // Inspect original spelling too: URL parsers accept alternate numeric IPs.
    let authority = raw.split_once("://").ok_or(INVALID)?.1.split('/').next().ok_or(INVALID)?;
    let literal = if authority.starts_with('[') { authority.split(']').next().map(|s| format!("{s}]")) }
        else { authority.split(':').next().map(str::to_owned) }.ok_or(INVALID)?;
    if !matches!(literal.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "[::1]") { return Err(INVALID); }
    if url.host_str() == Some("localhost") { url.set_host(Some("127.0.0.1")).map_err(|_| INVALID)?; }
    if !matches!(url.host_str(), Some("127.0.0.1" | "[::1]")) || url.port() == Some(0) { return Err(INVALID); }
    // ComfyUI lives at the server root in this version, not arbitrary routes.
    if url.path() != "/" && !url.path().is_empty() { return Err(INVALID); }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
fn open(path: &Path) -> Result<Connection, &'static str> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|_| UNAVAILABLE)?;
    conn.busy_timeout(Duration::from_secs(3)).map_err(|_| UNAVAILABLE)?;
    Ok(conn)
}
pub(crate) fn get(path: &Path) -> Result<Config, &'static str> {
    let conn = open(path)?;
    let saved: Option<String> = conn.query_row("SELECT value FROM settings WHERE key=?1", [KEY], |r| r.get(0)).optional().map_err(|_| UNAVAILABLE)?;
    let workflow = saved_workflow(&conn)?;
    Ok(Config { base_url: validated_base(saved.as_deref().unwrap_or(DEFAULT))?, revision: workflow.revision,
        workflow_json: workflow.workflow_json, workflow_name: workflow.workflow_name })
}
pub(crate) fn set(path: &Path, input: &str) -> Result<Config, &'static str> {
    let base_url = validated_base(input)?;
    let mut conn = open(path)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| UNAVAILABLE)?;
    let mut workflow = saved_workflow(&tx)?;
    workflow.revision = workflow.revision.checked_add(1).ok_or(UNAVAILABLE)?;
    tx.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [KEY, &base_url]).map_err(|_| UNAVAILABLE)?;
    save_workflow_record(&tx, &workflow)?;
    tx.commit().map_err(|_| UNAVAILABLE)?;
    get(path)
}
pub(crate) fn set_workflow(path: &Path, workflow_json: Option<String>, workflow_name: Option<String>, expected_revision: u64) -> Result<Config, &'static str> {
    if let Some(json) = workflow_json.as_ref() {
        if json.len() > MAX_WORKFLOW_BYTES { return Err("comfyui-workflow-too-large"); }
        let graph: Value = serde_json::from_str(json).map_err(|_| "comfyui-workflow-invalid")?;
        validate_workflow(&graph)?;
        if !workflow_name.as_ref().is_some_and(|name| !name.trim().is_empty() && name.len() <= 240 && !name.chars().any(char::is_control)) { return Err("comfyui-workflow-name-invalid"); }
    }
    let mut conn = open(path)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| UNAVAILABLE)?;
    let previous = saved_workflow(&tx)?;
    if previous.revision != expected_revision { return Err("comfyui-config-changed"); }
    let next = SavedWorkflow { revision: previous.revision.checked_add(1).ok_or(UNAVAILABLE)?, workflow_name: if workflow_json.is_some() { workflow_name } else { None }, workflow_json };
    save_workflow_record(&tx, &next)?;
    tx.commit().map_err(|_| UNAVAILABLE)?;
    get(path)
}
fn failed(error: &'static str) -> ConnectionResult {
    ConnectionResult { reachable: false, version: None, error: Some(error.into()) }
}
fn inspect(value: &Value) -> ConnectionResult {
    // A generic server returning JSON/HTTP 200 is not proof of ComfyUI.
    let Some(system) = value.get("system").and_then(Value::as_object) else { return failed("comfyui-unexpected-response"); };
    if !value.get("devices").is_some_and(Value::is_array)
        || !system.get("python_version").is_some_and(Value::is_string) { return failed("comfyui-unexpected-response"); }
    let version = system.get("comfyui_version").and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 80 && !v.chars().any(char::is_control)).map(str::to_owned);
    ConnectionResult { reachable: true, version, error: None }
}
pub(crate) async fn test(input: &str) -> Result<ConnectionResult, &'static str> {
    let base = validated_base(input)?;
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3)).timeout(Duration::from_secs(8)).build().map_err(|_| UNAVAILABLE)?;
    let response = match client.get(format!("{base}/system_stats")).send().await {
        Ok(response) => response,
        Err(error) => return Ok(failed(if error.is_timeout() { "comfyui-timeout" } else { "comfyui-unreachable" })),
    };
    if !response.status().is_success() { return Ok(failed("comfyui-http-error")); }
    let body = match crate::read_ai_response_body_bounded(response, 64 * 1024, "comfyui-unexpected-response").await {
        Ok(body) => body,
        Err(_) => return Ok(failed("comfyui-unexpected-response")),
    };
    Ok(match serde_json::from_str::<Value>(&body) { Ok(value) => inspect(&value), Err(_) => failed("comfyui-unexpected-response") })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comfyui_accepts_only_explicit_loopback_root() {
        assert_eq!(validated_base("http://localhost:8188/"), Ok(DEFAULT.into()));
        assert_eq!(validated_base("http://[::1]:8188"), Ok("http://[::1]:8188".into()));
        for input in ["http://127.1:8188", "http://2130706433", "http://0x7f000001", "http://192.168.1.3:8188", "https://example.com", "http://localhost.evil", "http://u:p@localhost:8188", "http://127.0.0.1:8188?token=x", "http://127.0.0.1:8188/#x", "http://127.0.0.1:8188/prompt", "file:///tmp", "http://127.0.0.1:0"] {
            assert!(validated_base(input).is_err(), "{input}");
        }
    }
    #[test]
    fn comfyui_recognizes_stats_without_exposing_device_details() {
        let result = inspect(&serde_json::json!({"system":{"python_version":"3.12", "comfyui_version":"0.3.1", "argv":["secret"]},"devices":[{"name":"private"}]}));
        assert!(result.reachable);
        let json = serde_json::to_string(&result).unwrap();
        assert!(!json.contains("private") && !json.contains("secret"));
        assert!(!inspect(&serde_json::json!({"ok":true})).reachable);
        assert!(!inspect(&serde_json::json!({"system":{},"devices":[]})).reachable);
    }
    #[test]
    fn comfyui_settings_roundtrip_keeps_other_settings() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let conn = Connection::open(tmp.path()).unwrap();
        conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES('other','keep');").unwrap();
        assert_eq!(get(tmp.path()).unwrap().base_url, DEFAULT);
        set(tmp.path(), "http://localhost:9000").unwrap();
        assert_eq!(get(tmp.path()).unwrap().base_url, "http://127.0.0.1:9000");
        assert!(set(tmp.path(), "https://example.com").is_err());
        assert_eq!(get(tmp.path()).unwrap().base_url, "http://127.0.0.1:9000");
        assert_eq!(conn.query_row("SELECT value FROM settings WHERE key='other'", [], |r| r.get::<_,String>(0)).unwrap(), "keep");
    }
}


const MAX_WORKFLOW_BYTES: usize = 256 * 1024;
const MAX_VIDEO_BYTES: usize = 1024 * 1024 * 1024;
const MAX_REFERENCE_BYTES: usize = 20 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES: usize = 40 * 1024 * 1024;
fn schema_keys(class: &str) -> Option<&'static [&'static str]> {
    match class {
        "VAELoader" => Some(&["vae_name"]),
        "LoadImage" => Some(&["image"]),
        "UNETLoader" => Some(&["unet_name", "weight_dtype"]),
        "PrimitiveStringMultiline" => Some(&["value"]),
        "ResolutionSelector" => Some(&["aspect_ratio", "megapixels", "multiple"]),
        "PrimitiveFloat" => Some(&["value"]),
        "CLIPLoader" => Some(&["clip_name", "type", "device"]),
        "ReservedVRAMSetter" => Some(&["reserved", "mode", "seed", "auto_max_reserved", "clean_gpu_before", "anything"]),
        "MiniMaxH3MemoryEfficientSageAttentionPatch" => Some(&["model"]),
        "MiniMaxH3AVDecodeT8" => Some(&["av_latent", "video_vae", "audio_vae"]),
        "SamplerCustomAdvanced" => Some(&["noise", "guider", "sampler", "sigmas", "latent_image"]),
        "VHS_VideoCombine" => Some(&["frame_rate", "loop_count", "filename_prefix", "format", "pix_fmt", "crf", "save_metadata", "trim_to_audio", "pingpong", "save_output", "images", "audio"]),
        "MiniMaxH3MultiRateSamplerEXPT8" => Some(&["video_steps", "audio_steps", "shift_video", "shift_audio", "model", "av_latent"]),
        "BasicGuider" => Some(&["model", "conditioning"]),
        "RandomNoise" => Some(&["noise_seed"]),
        "MiniMaxH3AudioConditioningT8" => Some(&["prompt", "width", "height", "length", "task_type", "audio_mode", "audio_denoise_strength", "add_source_as_reference", "prompt_primary_audio_ordinal", "strict_prompt_tags", "ref_image_size", "reference_video_policy", "clip", "video_vae", "audio_vae"]),
        "ComfyMathExpression" => Some(&["expression", "values.a"]),
        "UniBlockSwap" => Some(&["num_blocks"]),
        "LoraLoaderModelOnly" => Some(&["lora_name", "strength_model", "model"]),
        _ => None,
    }
}
fn safe_relative(value: &str, allow_empty: bool) -> bool {
    (allow_empty || !value.is_empty()) && value.len() <= 512 && !value.contains(['\\', ':', '?', '#'])
        && !value.starts_with('/') && !value.chars().any(char::is_control)
        && (value.is_empty() || value.split('/').all(|part| !part.is_empty() && part != "." && part != ".."))
}
fn safe_id(value: &str) -> bool { !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) }
// The new preset is a fixed, reviewed graph. Compare every node and wire with
// the bundled mapping after applying only the exposed, bounded parameters.
// This keeps the pre-existing arbitrary-node restrictions intact.
fn validate_workfisher_video(graph: &Value) -> Result<String, &'static str> {
    let invalid = "comfyui-workflow-unsupported";
    let nodes = graph.as_object().ok_or(invalid)?;
    let inputs = |id: &str| nodes.get(id).and_then(|n| n.get("inputs")).and_then(Value::as_object).ok_or(invalid);
    let c = inputs("136")?;
    let count = c.keys().filter(|k| k.starts_with("ref_images.ref_image_")).count();
    if !(1..=MAX_REFERENCE_IMAGES).contains(&count) { return Err(invalid); }
    let scalar = |id: &str, key: &str| inputs(id)?.get(key).cloned().ok_or(invalid);
    let prompt = scalar("138", "value")?;
    if !prompt.as_str().is_some_and(|s| s.encode_utf16().count() <= 20000 && !s.contains('\0')) { return Err(invalid); }
    let aspect = scalar("115", "aspect_ratio")?;
    if !aspect.as_str().is_some_and(|s| ["1:1 (Square)","2:3 (Portrait Photo)","3:2 (Photo)","3:4 (Portrait Standard)","4:3 (Standard)","9:16 (Portrait Widescreen)","16:9 (Widescreen)","21:9 (Ultrawide)"].contains(&s)) { return Err(invalid); }
    let number = |value: &Value, min: f64, max: f64, integer: bool| value.as_f64().is_some_and(|n| n.is_finite() && n>=min && n<=max && (!integer || n.fract()==0.0));
    let mp=scalar("115","megapixels")?; let duration=scalar("132","value")?;
    let seed=scalar("129","noise_seed")?; let steps=scalar("163","value")?;
    if !number(&mp,0.1,2.0,false) || !number(&duration,2.0,15.0,false) || !number(&seed,0.0,9007199254740991.0,true) || !number(&steps,1.0,100.0,true) { return Err(invalid); }
    let model=scalar("157","unet_name")?;
    if !model.as_str().is_some_and(|s| safe_relative(s,false) && s.len()<=300) { return Err(invalid); }
    let size=c.get("ref_image_size").cloned().ok_or(invalid)?;
    if size!="max" && size!="match" { return Err(invalid); }
    let source:Value=serde_json::from_str(include_str!("../../src/core/canvas/workFisherData.json")).map_err(|_| invalid)?;
    let mut expected=source.get("video").cloned().ok_or(invalid)?;
    let expected_nodes=expected.as_object_mut().ok_or(invalid)?;
    expected_nodes.remove("137");
    expected_nodes.get_mut("136").and_then(|n|n["inputs"].as_object_mut()).ok_or(invalid)?.remove("ref_images.ref_image_0");
    for index in 0..count {
        let id=(9000+index).to_string();
        expected_nodes.insert(id.clone(),serde_json::json!({"class_type":"LoadImage","inputs":{"image":format!("luckyray-ref-{index}.png")}}));
        expected_nodes.get_mut("136").ok_or(invalid)?["inputs"][format!("ref_images.ref_image_{index}")]=serde_json::json!([id,0]);
    }
    expected_nodes.get_mut("136").ok_or(invalid)?["inputs"]["ref_image_size"]=size;
    for (id,key,value) in [("138","value",prompt),("115","aspect_ratio",aspect),("115","megapixels",mp),("132","value",duration),("129","noise_seed",seed),("163","value",steps),("157","unet_name",model)] {
        expected_nodes.get_mut(id).ok_or(invalid)?["inputs"][key]=value;
    }
    let sol=nodes.contains_key("155");let mystic=nodes.contains_key("288");let turbo=nodes.contains_key("151");
    if !sol {expected_nodes.remove("155");} if !mystic {expected_nodes.remove("288");} if !turbo {expected_nodes.remove("151");}
    let mut current=if sol {"155"} else {"153"};
    if mystic {expected_nodes.get_mut("288").ok_or(invalid)?["inputs"]["model"]=serde_json::json!([current,0]);current="288";}
    if turbo {expected_nodes.get_mut("151").ok_or(invalid)?["inputs"]["model"]=serde_json::json!([current,0]);current="151";}
    for id in ["151","288"] {if nodes.contains_key(id) {
        let name=scalar(id,"lora_name")?;let strength=scalar(id,"strength_model")?;
        if !name.as_str().is_some_and(|s|safe_relative(s,false)&&s.len()<=300)||!number(&strength,-10.0,10.0,false){return Err(invalid);}
        expected_nodes.get_mut(id).ok_or(invalid)?["inputs"]["lora_name"]=name;
        expected_nodes.get_mut(id).ok_or(invalid)?["inputs"]["strength_model"]=strength;
    }}
    expected_nodes.get_mut("124").ok_or(invalid)?["inputs"]["model"]=serde_json::json!([current,0]);
    expected_nodes.get_mut("126").ok_or(invalid)?["inputs"]["model"]=serde_json::json!([current,0]);
    if expected != *graph { return Err(invalid); }
    Ok("156".into())
}
fn validate_workfisher_image(graph: &Value) -> Result<String, &'static str> {
    let invalid="comfyui-workflow-unsupported";
    let nodes=graph.as_object().ok_or(invalid)?;
    let candidates=[("241","character","248","text","235","251","252"),("267","scene","277","text","261","275","276"),("212","threeView","214","prompt","211","","")];
    let matches:Vec<_>=candidates.iter().filter(|(id,..)|nodes.get(*id).and_then(|n|n.get("class_type")).and_then(Value::as_str)==Some("SaveImage")).collect();
    if matches.len()!=1 {return Err(invalid);}
    let (out,kind,text,text_key,sampler,width_id,height_id)=*matches[0];
    let field=|id:&str,key:&str|nodes.get(id).and_then(|n|n.get("inputs")).and_then(|n|n.get(key)).cloned().ok_or(invalid);
    let prompt=field(text,text_key)?;
    if !prompt.as_str().is_some_and(|s|s.encode_utf16().count()<=20000&&!s.contains('\0')) {return Err(invalid);}
    let seed=field(sampler,"seed")?;
    if !seed.as_u64().is_some_and(|v|v<=9007199254740991) {return Err(invalid);}
    let source:Value=serde_json::from_str(include_str!("../../src/core/canvas/workFisherData.json")).map_err(|_|invalid)?;
    let mut expected=source.get(kind).cloned().ok_or(invalid)?;
    let map=expected.as_object_mut().ok_or(invalid)?;
    map.get_mut(text).ok_or(invalid)?["inputs"][text_key]=prompt;
    map.get_mut(sampler).ok_or(invalid)?["inputs"]["seed"]=seed.clone();
    let lora_ids:Vec<String>=map.iter().filter(|(_,n)|n["class_type"]=="LoraLoaderModelOnly").map(|(id,_)|id.clone()).collect();
    for id in lora_ids {
        let name=field(&id,"lora_name")?;let strength=field(&id,"strength_model")?;
        if !name.as_str().is_some_and(|s|safe_relative(s,false)&&s.len()<=300)
          || !strength.as_f64().is_some_and(|v|v.is_finite()&&(-10.0..=10.0).contains(&v)){return Err(invalid);}
        map.get_mut(&id).ok_or(invalid)?["inputs"]["lora_name"]=name;
        map.get_mut(&id).ok_or(invalid)?["inputs"]["strength_model"]=strength;
    }
    if kind=="threeView" {
        let aspect=field("213","aspect_ratio")?;let mp=field("213","megapixels")?;
        if !aspect.as_str().is_some_and(|s|["1:1 (Square)","2:3 (Portrait Photo)","3:2 (Photo)","3:4 (Portrait Standard)","4:3 (Standard)","9:16 (Portrait Widescreen)","16:9 (Widescreen)","21:9 (Ultrawide)"].contains(&s))
          || !mp.as_f64().is_some_and(|n|n.is_finite()&&(0.1..=2.0).contains(&n)) {return Err(invalid);}
        map.get_mut("213").ok_or(invalid)?["inputs"]["aspect_ratio"]=aspect;
        map.get_mut("213").ok_or(invalid)?["inputs"]["megapixels"]=mp;
        map.remove("215");map.insert("9000".into(),serde_json::json!({"class_type":"LoadImage","inputs":{"image":"luckyray-ref-0.png"}}));
        map.get_mut("206").ok_or(invalid)?["inputs"]["images.image_1"]=serde_json::json!(["9000",0]);
    } else {
        for id in [width_id,height_id] {
            let value=field(id,"value")?;
            if !value.as_u64().is_some_and(|n|(256..=2048).contains(&n)&&n%8==0) {return Err(invalid);}
            map.get_mut(id).ok_or(invalid)?["inputs"]["value"]=value;
        }
    }
    if nodes.contains_key("231") {
        let resolution=field("237","value")?;
        if !resolution.as_u64().is_some_and(|n|(512..=4096).contains(&n)&&n%2==0){return Err(invalid);}
        let mut extra:Value=serde_json::from_str(include_str!("../../src/core/canvas/workFisherUpscaleData.json")).map_err(|_|invalid)?;
        extra["234"]["inputs"]["image"]=serde_json::json!([if kind=="threeView"{"202"}else if kind=="character"{"236"}else{"262"},0]);
        extra["231"]["inputs"]["seed"]=serde_json::json!(seed.as_u64().ok_or(invalid)?%4294967296);
        extra["237"]["inputs"]["value"]=resolution;
        map.extend(extra.as_object().ok_or(invalid)?.iter().map(|(id,n)|(id.clone(),n.clone())));
        map.get_mut(out).ok_or(invalid)?["inputs"]["images"]=serde_json::json!(["231",0]);
    }
    if expected!=*graph {return Err(invalid);}
    Ok(format!("image:{out}"))
}
/// Intentionally accepts the reviewed H3 native-audio T2VA/Ref2VA family, not arbitrary
/// ComfyUI code/HTTP/file nodes. Frontend graph bindings add exact port checks.
const MAX_REFERENCE_IMAGES: usize = 9; // T8 ref_images Autogrow maximum; not a hardware recommendation.
fn validate_workflow(graph: &Value) -> Result<String, &'static str> {
    let invalid = "comfyui-workflow-unsupported";
    if serde_json::to_vec(graph).map_err(|_| invalid)?.len() > MAX_WORKFLOW_BYTES { return Err("comfyui-workflow-too-large"); }
    if graph.pointer("/136/class_type").and_then(Value::as_str)==Some("MiniMaxH3ReferenceToVideo") { return validate_workfisher_video(graph); }
    if ["241","267","212"].iter().any(|id|graph.get(*id).and_then(|n|n.get("class_type")).and_then(Value::as_str)==Some("SaveImage")) {return validate_workfisher_image(graph);}
    let nodes = graph.as_object().ok_or(invalid)?;
    if !(18..=19 + MAX_REFERENCE_IMAGES).contains(&nodes.len()) { return Err(invalid); }
    let mut counts = std::collections::BTreeMap::<&str, usize>::new();
    let mut output_id = None;
    for (id, node) in nodes {
        if id.is_empty() || id.len() > 12 || !id.bytes().all(|b| b.is_ascii_digit()) { return Err(invalid); }
        let node = node.as_object().ok_or(invalid)?;
        if node.keys().any(|key| !matches!(key.as_str(), "class_type" | "inputs" | "_meta")) { return Err(invalid); }
        let class = node.get("class_type").and_then(Value::as_str).ok_or(invalid)?;
        let keys = schema_keys(class).ok_or(invalid)?;
        let inputs = node.get("inputs").and_then(Value::as_object).ok_or(invalid)?;
        let reference_key = |key: &str| class == "MiniMaxH3AudioConditioningT8" && key.strip_prefix("ref_images.ref_image_").is_some_and(|suffix| suffix.len() == 1 && suffix.parse::<usize>().is_ok_and(|index| index < MAX_REFERENCE_IMAGES));
        if keys.iter().any(|key| !inputs.contains_key(*key)) || inputs.keys().any(|key| !keys.contains(&key.as_str()) && !reference_key(key)) { return Err(invalid); }
        *counts.entry(class).or_default() += 1;
        for (key, value) in inputs {
            if let Some(link) = value.as_array() {
                if link.len() != 2 || !link[0].as_str().is_some_and(|other| other != id && nodes.contains_key(other)) || !link[1].as_u64().is_some_and(|port| port <= 8) { return Err(invalid); }
            } else if value.is_object() || value.is_null() { return Err(invalid); }
            if value.as_str().is_some_and(|s| s.len() > 80000 || s.contains('\0')) { return Err(invalid); }
            if matches!(key.as_str(), "vae_name" | "unet_name" | "clip_name" | "lora_name" | "filename_prefix") && !value.as_str().is_some_and(|s| safe_relative(s, false)) { return Err(invalid); }
        }
        if class == "ComfyMathExpression" && inputs.get("expression").and_then(Value::as_str).map(|s| s.chars().filter(|c| !c.is_whitespace()).collect::<String>()).as_deref() != Some("max(5,round(a*24))+(5-(max(5,round(a*24))%17))%17") { return Err(invalid); }
        if class == "MiniMaxH3AudioConditioningT8" && (inputs.get("task_type").and_then(Value::as_str).is_none_or(|v| !matches!(v, "T2VA" | "Ref2VA" | "auto")) || inputs.get("audio_mode").and_then(Value::as_str) != Some("native")) { return Err(invalid); }
        if class == "VHS_VideoCombine" {
            if inputs.get("format").and_then(Value::as_str) != Some("video/h264-mp4") || inputs.get("save_output").and_then(Value::as_bool) != Some(true) || inputs.get("frame_rate").and_then(Value::as_f64) != Some(24.0) { return Err(invalid); }
            output_id = Some(id.clone());
        }
    }
    for required in ["VAELoader", "UNETLoader", "PrimitiveStringMultiline", "ResolutionSelector", "PrimitiveFloat", "CLIPLoader", "ReservedVRAMSetter", "MiniMaxH3MemoryEfficientSageAttentionPatch", "MiniMaxH3AVDecodeT8", "SamplerCustomAdvanced", "VHS_VideoCombine", "MiniMaxH3MultiRateSamplerEXPT8", "BasicGuider", "RandomNoise", "MiniMaxH3AudioConditioningT8", "ComfyMathExpression", "LoraLoaderModelOnly"] {
        if counts.get(required).copied() != Some(if required == "VAELoader" { 2 } else { 1 }) { return Err(invalid); }
    }
    if counts.get("UniBlockSwap").is_some_and(|n| *n != 1) { return Err(invalid); }
    let number = |inputs: &serde_json::Map<String,Value>, key: &str, min: f64, max: f64, integer: bool| inputs.get(key).and_then(Value::as_f64).is_some_and(|n| n.is_finite() && n >= min && n <= max && (!integer || n.fract() == 0.0));
    for node in nodes.values() {
        let class=node["class_type"].as_str().unwrap(); let inputs=node["inputs"].as_object().unwrap();
        let valid = match class {
            "PrimitiveFloat" => number(inputs,"value",2.0,15.0,false),
            "PrimitiveStringMultiline" => inputs["value"].as_str().is_some_and(|s| s.encode_utf16().count() <= 20000),
            "ResolutionSelector" => number(inputs,"megapixels",0.1,2.0,false) && inputs["multiple"]==32 && inputs["aspect_ratio"].as_str().is_some_and(|s| ["1:1 (Square)","2:3 (Portrait Photo)","3:2 (Photo)","3:4 (Portrait Standard)","4:3 (Standard)","9:16 (Portrait Widescreen)","16:9 (Widescreen)","21:9 (Ultrawide)"].contains(&s)),
            "RandomNoise" => number(inputs,"noise_seed",0.0,9007199254740991.0,true),
            "ReservedVRAMSetter" => number(inputs,"reserved",0.0,24.0,false) && number(inputs,"auto_max_reserved",0.0,24.0,false) && number(inputs,"seed",0.0,9007199254740991.0,true) && inputs["mode"]=="manual" && inputs["clean_gpu_before"].is_boolean(),
            "MiniMaxH3MultiRateSamplerEXPT8" => number(inputs,"video_steps",1.0,100.0,true) && number(inputs,"audio_steps",1.0,100.0,true) && number(inputs,"shift_video",0.0,100.0,false) && number(inputs,"shift_audio",0.0,100.0,false),
            "UniBlockSwap" => inputs["num_blocks"] == -1,
            "LoadImage" => inputs["image"].as_str().is_some_and(|s| safe_relative(s,false)),
            "LoraLoaderModelOnly" => number(inputs,"strength_model",-10.0,10.0,false),
            "CLIPLoader" => inputs["type"] == "minimax" && (inputs["device"] == "default" || inputs["device"] == "cpu"),
            "UNETLoader" => inputs["weight_dtype"] == "default",
            "MiniMaxH3AudioConditioningT8" => inputs["add_source_as_reference"]==false && inputs["prompt_primary_audio_ordinal"]==0 && inputs["audio_denoise_strength"]==1 && inputs["strict_prompt_tags"].is_boolean() && (inputs["ref_image_size"]=="max" || ((inputs["task_type"]=="Ref2VA" || inputs["task_type"]=="auto") && inputs["ref_image_size"]=="match")) && inputs["reference_video_policy"]=="official_2_to_15s",
            "VHS_VideoCombine" => inputs["loop_count"]==0 && inputs["pix_fmt"]=="yuv420p" && inputs["trim_to_audio"]==false && inputs["pingpong"]==false && inputs["save_metadata"].is_boolean() && number(inputs,"crf",0.0,51.0,true),
            _ => true,
        };
        if !valid { return Err(invalid); }
    }
    let by_class: std::collections::HashMap<&str,&str> = nodes.iter().map(|(id,node)| (node["class_type"].as_str().unwrap(),id.as_str())).collect();
    let id_for = |class: &str| *by_class.get(class).unwrap();
    let c = &nodes[id_for("MiniMaxH3AudioConditioningT8")]["inputs"];
    let image_count = counts.get("LoadImage").copied().unwrap_or(0);
    let ref_count = c.as_object().unwrap().keys().filter(|key| key.starts_with("ref_images.")).count();
    if (c["task_type"] == "T2VA" && (image_count != 0 || ref_count != 0))
        || (c["task_type"] == "Ref2VA" && image_count == 0)
        || image_count > MAX_REFERENCE_IMAGES || image_count != ref_count { return Err(invalid); }
    let mut reference_nodes = std::collections::HashSet::new();
    for index in 0..image_count {
        let value = c.get(format!("ref_images.ref_image_{index}")).and_then(Value::as_array).ok_or(invalid)?;
        let target = value[0].as_str().ok_or(invalid)?;
        if value[1].as_u64() != Some(0) || nodes[target]["class_type"] != "LoadImage" || !reference_nodes.insert(target) { return Err(invalid); }
    }
    let vae_id = |field: &str| c.get(field).and_then(Value::as_array).and_then(|v| v.first()).and_then(Value::as_str);
    let video_vae=vae_id("video_vae").ok_or(invalid)?; let audio_vae=vae_id("audio_vae").ok_or(invalid)?;
    if video_vae==audio_vae || nodes[video_vae]["class_type"]!="VAELoader" || nodes[audio_vae]["class_type"]!="VAELoader" { return Err(invalid); }
    let linked = |source: &str, field: &str, target: &str, port: u64| nodes[source]["inputs"].get(field).and_then(Value::as_array).is_some_and(|link| link[0].as_str()==Some(target) && link[1].as_u64()==Some(port));
    for (source,field,target,port) in [
        ("VHS_VideoCombine","images","MiniMaxH3AVDecodeT8",0),("VHS_VideoCombine","audio","MiniMaxH3AVDecodeT8",1),
        ("MiniMaxH3AVDecodeT8","av_latent","SamplerCustomAdvanced",0),
        ("SamplerCustomAdvanced","noise","RandomNoise",0),("SamplerCustomAdvanced","guider","BasicGuider",0),
        ("SamplerCustomAdvanced","sampler","MiniMaxH3MultiRateSamplerEXPT8",1),("SamplerCustomAdvanced","sigmas","MiniMaxH3MultiRateSamplerEXPT8",2),
        ("SamplerCustomAdvanced","latent_image","MiniMaxH3AudioConditioningT8",1),
        ("BasicGuider","model","MiniMaxH3MultiRateSamplerEXPT8",0),("BasicGuider","conditioning","MiniMaxH3AudioConditioningT8",0),
        ("MiniMaxH3MultiRateSamplerEXPT8","av_latent","MiniMaxH3AudioConditioningT8",1),("MiniMaxH3MultiRateSamplerEXPT8","model","LoraLoaderModelOnly",0),
        ("LoraLoaderModelOnly","model","MiniMaxH3MemoryEfficientSageAttentionPatch",0),
        ("MiniMaxH3MemoryEfficientSageAttentionPatch","model","ReservedVRAMSetter",0),("ReservedVRAMSetter","anything","UNETLoader",0),
        ("MiniMaxH3AudioConditioningT8","prompt","PrimitiveStringMultiline",0),
        ("MiniMaxH3AudioConditioningT8","width","ResolutionSelector",0),("MiniMaxH3AudioConditioningT8","height","ResolutionSelector",1),
        ("MiniMaxH3AudioConditioningT8","length","ComfyMathExpression",1),("MiniMaxH3AudioConditioningT8","clip","CLIPLoader",0),
        ("ComfyMathExpression","values.a","PrimitiveFloat",0),
    ] { if !linked(id_for(source),field,id_for(target),port) { return Err(invalid); } }
    for class in ["MiniMaxH3AudioConditioningT8","MiniMaxH3AVDecodeT8"] {
        if !linked(id_for(class),"video_vae",video_vae,0) || !linked(id_for(class),"audio_vae",audio_vae,0) { return Err(invalid); }
    }
    // Reject cycles even if all node classes are individually supported.
    fn visit<'a>(id: &'a str, nodes: &'a serde_json::Map<String, Value>, visiting: &mut std::collections::HashSet<&'a str>, done: &mut std::collections::HashSet<&'a str>) -> bool {
        if done.contains(id) { return true; }
        if !visiting.insert(id) { return false; }
        if let Some(inputs) = nodes[id].get("inputs").and_then(Value::as_object) {
            for value in inputs.values() {
                if let Some(link) = value.as_array() { if !visit(link[0].as_str().unwrap(), nodes, visiting, done) { return false; } }
            }
        }
        visiting.remove(id); done.insert(id); true
    }
    let mut visiting = std::collections::HashSet::new(); let mut done = std::collections::HashSet::new();
    for id in nodes.keys() { if !visit(id, nodes, &mut visiting, &mut done) { return Err(invalid); } }
    output_id.ok_or(invalid)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubmitRequest {
    pub client_task_id: String, pub base_url: String, pub workflow: Value,
    #[serde(default)] pub images: Vec<ReferenceImage>,
    #[serde(default)] pub image_sources: Vec<String>,
    #[serde(default)] pub resume_only: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReferenceImage { pub node_id: String, pub data_url: String }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Job {
    pub client_task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preflight { pub ready: bool, pub missing_classes: Vec<String>, pub missing_models: Vec<String>, pub invalid_inputs: Vec<String>, pub installed_unet_models: Vec<String>, pub installed_lora_models: Vec<String> }
#[derive(Clone)]
struct StoredJob { job: Job, base: String, digest: String, output_node: String, output: Option<String>, created_at: i64 }
fn ledger(path: &Path) -> Result<Connection, &'static str> {
    let conn = open(path)?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS canvas_comfyui_jobs_v1(client_id TEXT PRIMARY KEY,base TEXT NOT NULL,digest TEXT NOT NULL,prompt_id TEXT,state TEXT NOT NULL,error TEXT,output_node TEXT NOT NULL,output TEXT,video_path TEXT,created_at INTEGER NOT NULL DEFAULT 0);").map_err(|_| UNAVAILABLE)?;
    Ok(conn)
}
fn read_job(conn: &Connection, id: &str) -> Result<StoredJob, &'static str> {
    if !safe_id(id) { return Err("comfyui-task-id-invalid"); }
    conn.query_row("SELECT base,digest,prompt_id,state,error,output_node,output,video_path,created_at FROM canvas_comfyui_jobs_v1 WHERE client_id=?1", [id], |r| {
        let output_node:String=r.get(5)?;let path:Option<String>=r.get(7)?;let is_image=output_node.starts_with("image:");
        Ok(StoredJob {base:r.get(0)?,digest:r.get(1)?,output_node,output:r.get(6)?,created_at:r.get(8)?,job:Job {client_task_id:id.to_owned(),prompt_id:r.get(2)?,state:r.get(3)?,error:r.get(4)?,video_path:if is_image {None} else {path.clone()},image_path:if is_image {path} else {None}}})
    }).optional().map_err(|_| UNAVAILABLE)?.ok_or("comfyui-task-not-found")
}
fn update_job(conn: &Connection, stored: &StoredJob) -> Result<(), &'static str> {
    let path=if stored.output_node.starts_with("image:") {&stored.job.image_path} else {&stored.job.video_path};
    conn.execute("UPDATE canvas_comfyui_jobs_v1 SET prompt_id=?2,state=?3,error=?4,output=?5,video_path=?6 WHERE client_id=?1", rusqlite::params![stored.job.client_task_id,stored.job.prompt_id,stored.job.state,stored.job.error,stored.output,path]).map_err(|_| UNAVAILABLE)?;
    Ok(())
}
fn http_client(seconds: u64) -> Result<reqwest::Client, &'static str> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(4)).timeout(Duration::from_secs(seconds)).build().map_err(|_| UNAVAILABLE)
}
async fn json_response(response: reqwest::Response, limit: usize) -> Result<Value, &'static str> {
    if !response.status().is_success() { return Err("comfyui-http-error"); }
    let body = crate::read_ai_response_body_bounded(response,limit,"comfyui-response-invalid").await.map_err(|_| "comfyui-response-invalid")?;
    serde_json::from_str(&body).map_err(|_| "comfyui-response-invalid")
}
pub(crate) async fn preflight(base: &str, workflow: &Value) -> Result<Preflight, &'static str> {
    if template::is_template(workflow) { template::validate(workflow)?; } else { validate_workflow(workflow)?; }
    let base = validated_base(base)?;
    let response = http_client(20)?.get(format!("{base}/object_info")).send().await.map_err(|_| "comfyui-unreachable")?;
    let info = json_response(response,16 * 1024 * 1024).await?;
    if template::is_template(workflow) { return Ok(template::dependencies(workflow,&info)); }
    let mut result=inspect_dependencies(workflow,&info);
    if workflow.get("231").is_some() {
        // SeedVR2's COMBO includes downloadable models. Check the existing-file
        // endpoint as well, so an absent model cannot trigger an implicit download.
        let response=http_client(10)?.get(format!("{base}/models/seedvr2")).send().await.map_err(|_|"comfyui-upscale-models-unverified")?;
        let files=json_response(response,1024*1024).await.map_err(|_|"comfyui-upscale-models-unverified")?;
        check_seedvr_files(&mut result,&files);
    }
    Ok(result)
}
fn check_seedvr_files(result:&mut Preflight,files:&Value) {
    for name in ["seedvr2_ema_7b-Q8_0.gguf","ema_vae_fp16.safetensors"] {
        if !files.as_array().is_some_and(|items|items.iter().any(|v|v.as_str()==Some(name)))&&!result.missing_models.iter().any(|v|v==name){result.missing_models.push(name.into());}
    }
    result.ready=result.missing_classes.is_empty()&&result.missing_models.is_empty()&&result.invalid_inputs.is_empty();
}
// Validate the installed T8 schema, not just the maximum known to this adapter.
// Core v3 exposes Autogrow as one container; some versions expand its exact slots.
fn supports_reference_slot(definition: &Value, index: usize) -> bool {
    let key = format!("ref_images.ref_image_{index}");
    if ["required", "optional"].iter().any(|section| definition.pointer(&format!("/input/{section}/{key}/0")).and_then(Value::as_str) == Some("IMAGE")) { return true; }
    ["required", "optional"].iter().any(|section| {
        let Some(container) = definition.pointer(&format!("/input/{section}/ref_images")) else { return false; };
        container.get(0).and_then(Value::as_str) == Some("COMFY_AUTOGROW_V3")
            && container.pointer("/1/template/prefix").and_then(Value::as_str) == Some("ref_image_")
            && container.pointer("/1/template/max").and_then(Value::as_u64).is_some_and(|max| index < MAX_REFERENCE_IMAGES && (index as u64) < max)
            && container.pointer("/1/template/input/required/ref_image/0").and_then(Value::as_str) == Some("IMAGE")
    })
}
// VHS declares codec-specific widgets inside the selected format's schema,
// rather than as top-level node inputs. Require that actual installed schema.
fn supports_vhs_widget(definition:&Value,format:&str,key:&str,value:&Value)->bool {
    let widgets=definition.pointer("/input/required/format/1/formats").and_then(|v|v.get(format)).and_then(Value::as_array);
    let Some(widget)=widgets.and_then(|items|items.iter().find(|item|item.get(0).and_then(Value::as_str)==Some(key))) else{return false;};
    let Some(kind)=widget.get(1) else{return false;};
    if let Some(choices)=kind.as_array() {return choices.contains(value);}
    match kind.as_str() {
        Some("BOOLEAN")=>value.is_boolean(),
        Some("INT")=>value.as_i64().is_some_and(|n| {
            let limits=widget.get(2);let min=limits.and_then(|v|v.get("min")).and_then(Value::as_i64).unwrap_or(i64::MIN);
            let max=limits.and_then(|v|v.get("max")).and_then(Value::as_i64).unwrap_or(i64::MAX);n>=min&&n<=max
        }),
        _=>false,
    }
}
fn supports_named_autogrow(definition:&Value,group:&str,name:&str,input:&str,kind:&str)->bool {
    ["required","optional"].iter().any(|section| {
        let Some(container)=definition.pointer(&format!("/input/{section}/{group}")) else{return false;};
        let template=container.pointer("/1/template");
        let has_name=template.and_then(|v|v.get("names")).and_then(Value::as_array).is_some_and(|names|names.iter().any(|n|n.as_str()==Some(name)));
        let expected=template.and_then(|v|v.pointer(&format!("/input/required/{input}/0"))).and_then(Value::as_str)
            .is_some_and(|types|types.split(',').any(|item|item==kind));
        container.get(0).and_then(Value::as_str)==Some("COMFY_AUTOGROW_V3")&&has_name&&expected
    })
}
fn inspect_dependencies(workflow: &Value, info: &Value) -> Preflight {
    let mut missing_classes = std::collections::BTreeSet::new();
    let mut missing_models = std::collections::BTreeSet::new();
    let mut invalid_inputs = std::collections::BTreeSet::new();
    let workfisher = workflow.pointer("/136/class_type").and_then(Value::as_str)==Some("MiniMaxH3ReferenceToVideo")
        || ["241","267","212"].iter().any(|id|workflow.get(*id).and_then(|n|n.get("class_type")).and_then(Value::as_str)==Some("SaveImage"));
    for node in workflow.as_object().unwrap().values() {
        let class = node["class_type"].as_str().unwrap();
        if class == "UniBlockSwap" { continue; }
        let Some(definition) = info.get(class).filter(|v| v.is_object()) else { missing_classes.insert(class.to_owned()); continue; };
        for (key,selected) in node["inputs"].as_object().unwrap() {
            let field=definition.pointer(&format!("/input/required/{key}")).or_else(|| definition.pointer(&format!("/input/optional/{key}")));
            let dynamic_reference = class == "MiniMaxH3ReferenceToVideo" && key.starts_with("ref_images.ref_image_");
            let qwen_reference = class == "TextEncodeQwenImage21" && key == "images.image_1";
            let math_value = class == "ComfyMathExpression" && key == "values.a";
            let codec_widget = class=="VHS_VideoCombine" && ["pix_fmt","crf","save_metadata"].contains(&key.as_str());
            // A fixed mapping is only a candidate until the installed schema
            // confirms every input. Do not submit an unknown field on trust.
            if workfisher && field.is_none() && !dynamic_reference && !qwen_reference && !math_value && !(codec_widget && node["inputs"]["format"].as_str().is_some_and(|format|supports_vhs_widget(definition,format,key,selected))) {invalid_inputs.insert(format!("{class}.{key}"));}
            if workfisher && math_value && field.is_none() && !supports_named_autogrow(definition,"values","a","value","FLOAT") {invalid_inputs.insert(format!("{class}.{key}"));}
            if qwen_reference && field.is_none() {
                let valid=["required","optional"].iter().any(|section| {
                    let Some(container)=definition.pointer(&format!("/input/{section}/images")) else{return false;};
                    container.get(0).and_then(Value::as_str)==Some("COMFY_AUTOGROW_V3")
                        && container.pointer("/1/template/prefix").and_then(Value::as_str)==Some("image_")
                        && container.pointer("/1/template/input/required/image/0").and_then(Value::as_str)==Some("IMAGE")
                }) || supports_named_autogrow(definition,"images","image_1","image","IMAGE");
                if !valid {invalid_inputs.insert(format!("{class}.{key}"));}
            }
            if qwen_reference && field.is_some() && field.and_then(|f|f.get(0)).and_then(Value::as_str)!=Some("IMAGE") {invalid_inputs.insert(format!("{class}.{key}"));}
            let entry=field.and_then(|field| field.get(0));
            let choices=entry.and_then(Value::as_array).or_else(|| {
                if entry.and_then(Value::as_str) == Some("COMBO") {
                    field.and_then(|field| field.pointer("/1/options")).and_then(Value::as_array)
                } else { None }
            });
            if class == "MiniMaxH3AudioConditioningT8" || class == "MiniMaxH3ReferenceToVideo" {
                if let Some(index) = key.strip_prefix("ref_images.ref_image_").and_then(|suffix| suffix.parse::<usize>().ok()) {
                    if !supports_reference_slot(definition, index) { invalid_inputs.insert(format!("{class}.{key}")); }
                }
                if class == "MiniMaxH3AudioConditioningT8" && key == "task_type" && !choices.is_some_and(|values| values.iter().any(|v| v == selected)) {
                    invalid_inputs.insert(format!("{class}.{key}"));
                }
            }
            // Upload names are owned by this submission, not pre-existing COMBO choices.
            if class == "LoadImage" && key == "image" { continue; }
            if ["unet_name", "vae_name", "clip_name", "lora_name"].contains(&key.as_str()) {
                if let Some(model)=selected.as_str() {
                    if !choices.is_some_and(|values| values.iter().any(|v| v.as_str()==Some(model))) { missing_models.insert(model.to_owned()); }
                }
            } else if let Some(selected)=selected.as_str() {
                // An array in the first schema position is a COMBO enum. A
                // bare STRING/INT/etc declaration is not an enum of characters.
                if choices.is_some_and(|values| !values.iter().any(|v| v.as_str()==Some(selected))) {
                    invalid_inputs.insert(format!("{class}.{key}"));
                }
            }
        }
        if workfisher {
            if let Some(required)=definition.pointer("/input/required").and_then(Value::as_object) {
                let supplied=node["inputs"].as_object().unwrap();
                for (key,spec) in required {
                    if !supplied.contains_key(key) && !(class=="MiniMaxH3ReferenceToVideo" && key=="ref_images")
                        && spec.get(0).and_then(Value::as_str)!=Some("COMFY_AUTOGROW_V3") {
                        invalid_inputs.insert(format!("{class}.{key}"));
                    }
                }
            } else {invalid_inputs.insert(format!("{class}.input-schema"));}
        }
    }
    let installed_unet_models = info.pointer("/UNETLoader/input/required/unet_name/0").and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).filter(|s| safe_relative(s,false)).take(200).map(str::to_owned).collect()).unwrap_or_default();
    let lora_field=info.pointer("/LoraLoaderModelOnly/input/required/lora_name");
    let installed_lora_models=lora_field.and_then(|f|f.get(0)).and_then(Value::as_array).or_else(||lora_field.and_then(|f|f.pointer("/1/options")).and_then(Value::as_array))
        .map(|items|items.iter().filter_map(Value::as_str).filter(|s|safe_relative(s,false)).take(200).map(str::to_owned).collect()).unwrap_or_default();
    Preflight { ready:missing_classes.is_empty() && missing_models.is_empty() && invalid_inputs.is_empty(), missing_classes:missing_classes.into_iter().collect(), missing_models:missing_models.into_iter().collect(), invalid_inputs:invalid_inputs.into_iter().collect(), installed_unet_models, installed_lora_models }
}

struct PreparedImage { node_id: String, bytes: Vec<u8>, mime: &'static str, filename: String }
/// Only bytes already resolved by the existing canvas media path cross this
/// command. It never reads an arbitrary path or fetches a reference URL.
fn prepare_images(graph: &Value, images: &[ReferenceImage]) -> Result<Vec<PreparedImage>, &'static str> {
    use base64::Engine as _;
    let invalid = "comfyui-reference-invalid";
    if images.len() > MAX_REFERENCE_IMAGES { return Err(invalid); }
    let execution = if template::is_template(graph) {Some(graph)} else {None};
    let graph = execution.map(|v| &v["graph"]).unwrap_or(graph);
    let nodes = graph.as_object().ok_or(invalid)?;
    let count = nodes.values().filter(|node| node["class_type"] == "LoadImage").count();
    if count != images.len() { return Err(invalid); }
    if count==0 {return Ok(Vec::new());}
    let conditioning = nodes.values().find(|node| node["class_type"] == "MiniMaxH3AudioConditioningT8" || node["class_type"] == "MiniMaxH3ReferenceToVideo" || node["class_type"] == "TextEncodeQwenImage21");
    if execution.is_none() && conditioning.is_none() {return Err(invalid);}
    let mut result = Vec::with_capacity(count);
    let mut total = 0usize;
    for (index, image) in images.iter().enumerate() {
        let target = if let Some(execution)=execution {execution["images"].get(index).and_then(Value::as_str).ok_or(invalid)?} else {
            let conditioning=conditioning.ok_or(invalid)?;
            let field=if conditioning["class_type"]=="TextEncodeQwenImage21" {format!("images.image_{}",index+1)} else {format!("ref_images.ref_image_{index}")};
            conditioning["inputs"].get(field).and_then(Value::as_array).and_then(|link| link.first()).and_then(Value::as_str).ok_or(invalid)?
        };
        if image.node_id != target || nodes[&image.node_id]["class_type"] != "LoadImage" { return Err(invalid); }
        let (header, encoded) = image.data_url.split_once(";base64,").ok_or(invalid)?;
        let (mime, extension) = match header { "data:image/png" => ("image/png","png"), "data:image/jpeg" => ("image/jpeg","jpg"), "data:image/webp" => ("image/webp","webp"), _ => return Err(invalid) };
        if encoded.len() > MAX_REFERENCE_BYTES * 4 / 3 + 16 { return Err("comfyui-reference-too-large"); }
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| invalid)?;
        if bytes.is_empty() || bytes.len() > MAX_REFERENCE_BYTES { return Err("comfyui-reference-too-large"); }
        total = total.checked_add(bytes.len()).ok_or("comfyui-reference-too-large")?;
        if total > MAX_REFERENCE_TOTAL_BYTES { return Err("comfyui-reference-too-large"); }
        let expected = match mime { "image/png" => image::ImageFormat::Png, "image/jpeg" => image::ImageFormat::Jpeg, _ => image::ImageFormat::WebP };
        if image::guess_format(&bytes).ok() != Some(expected) { return Err(invalid); }
        let (width,height) = image::ImageReader::with_format(std::io::Cursor::new(&bytes),expected).into_dimensions().map_err(|_| invalid)?;
        if width == 0 || height == 0 || width > 16384 || height > 16384 || u64::from(width) * u64::from(height) > 64_000_000 { return Err("comfyui-reference-too-large"); }
        let filename = format!("luckyray-{:x}.{extension}",Sha256::digest(&bytes));
        result.push(PreparedImage { node_id:image.node_id.clone(),bytes,mime,filename });
    }
    Ok(result)
}
fn submission_digest(workflow: &Value, images: &[PreparedImage]) -> Result<String, &'static str> {
    let mut digest=Sha256::new();
    digest.update(serde_json::to_vec(workflow).map_err(|_| "comfyui-workflow-invalid")?);
    // Preserve the original text-only digest so old task resumptions still bind.
    for image in images {
        digest.update(b"\0reference\0");digest.update(image.node_id.as_bytes());digest.update(b"\0");digest.update(Sha256::digest(&image.bytes));
    }
    Ok(format!("{:x}",digest.finalize()))
}
fn reference_request_digest(workflow: &Value, sources: &[String]) -> Result<Option<String>, &'static str> {
    let graph=if template::is_template(workflow) { &workflow["graph"] } else {workflow};
    let count=graph.as_object().ok_or("comfyui-workflow-invalid")?.values().filter(|node| node["class_type"]=="LoadImage").count();
    if sources.len()!=count || sources.iter().any(|source| source.is_empty() || source.len()>16*1024 || source.chars().any(char::is_control)) { return Err("comfyui-reference-identity-invalid"); }
    if count==0 { return Ok(None); }
    let mut digest=Sha256::new();digest.update(serde_json::to_vec(workflow).map_err(|_| "comfyui-workflow-invalid")?);
    digest.update(b"\0reference-sources\0");digest.update(serde_json::to_vec(sources).map_err(|_| "comfyui-reference-identity-invalid")?);
    Ok(Some(format!("{:x}",digest.finalize())))
}
fn matches_reference_request(stored_digest: &str, request_digest: &str) -> bool {
    stored_digest.split_once(':').is_some_and(|(request,bytes)| request==request_digest && bytes.len()==64 && bytes.bytes().all(|b| b.is_ascii_hexdigit()))
}
fn upload_descriptor(value: &Value, image: &PreparedImage) -> Result<String, &'static str> {
    if value.get("name").and_then(Value::as_str) != Some(image.filename.as_str())
        || value.get("subfolder").and_then(Value::as_str) != Some("luckyray")
        || value.get("type").and_then(Value::as_str) != Some("input") { return Err("comfyui-reference-upload-invalid"); }
    Ok(format!("luckyray/{}",image.filename))
}
async fn upload_reference(base: &str, image: &PreparedImage) -> Result<String, &'static str> {
    // A bounded, fixed-field multipart body avoids adding a new dependency or
    // accepting caller-controlled filenames, destinations or form fields.
    let boundary=format!("luckyray{:016x}",rand::random::<u64>());
    let mut body=Vec::with_capacity(image.bytes.len()+1024);
    for (name,value) in [("type","input"),("subfolder","luckyray"),("overwrite","false")] {
        write!(&mut body,"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").map_err(|_| "comfyui-reference-upload-failed")?;
    }
    write!(&mut body,"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",image.filename,image.mime).map_err(|_| "comfyui-reference-upload-failed")?;
    body.extend_from_slice(&image.bytes);write!(&mut body,"\r\n--{boundary}--\r\n").map_err(|_| "comfyui-reference-upload-failed")?;
    let response=http_client(90)?.post(format!("{base}/upload/image")).header(reqwest::header::CONTENT_TYPE,format!("multipart/form-data; boundary={boundary}")).body(body).send().await.map_err(|_| "comfyui-reference-upload-failed")?;
    let value=json_response(response,64*1024).await.map_err(|_| "comfyui-reference-upload-failed")?;
    upload_descriptor(&value,image)
}

pub(crate) async fn submit(path: &Path, request: SubmitRequest) -> Result<Job, &'static str> {
    if !safe_id(&request.client_task_id) { return Err("comfyui-task-id-invalid"); }
    let base = validated_base(&request.base_url)?;
    let output_node = if template::is_template(&request.workflow) {template::validate(&request.workflow)?} else {validate_workflow(&request.workflow)?};
    let request_digest=reference_request_digest(&request.workflow,&request.image_sources)?;
    if request.resume_only {
        // Read-only probe binds both the original graph/address and ordered
        // reference identities. No source bytes are reopened or uploaded.
        let request_digest=request_digest.ok_or("comfyui-reference-identity-invalid")?;
        if !request.images.is_empty() { return Err("comfyui-reference-identity-invalid"); }
        let conn=Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| UNAVAILABLE)?;
        let exists: bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='canvas_comfyui_jobs_v1')",[],|row| row.get(0)).map_err(|_| UNAVAILABLE)?;
        if !exists { return Err("comfyui-task-not-found"); }
        let existing=read_job(&conn,&request.client_task_id)?;
        if existing.base!=base || !matches_reference_request(&existing.digest,&request_digest) { return Err("comfyui-submission-binding-changed"); }
        return Ok(existing.job);
    }
    let images = prepare_images(&request.workflow,&request.images)?;
    let bytes_digest = submission_digest(&request.workflow,&images)?;
    let digest = request_digest.map(|request| format!("{request}:{bytes_digest}")).unwrap_or(bytes_digest);
    {
        let conn = ledger(path)?;
        if let Ok(existing) = read_job(&conn,&request.client_task_id) {
            if existing.base != base || existing.digest != digest { return Err("comfyui-submission-binding-changed"); }
            return Ok(existing.job);
        }
    }
    let check = preflight(&base,&request.workflow).await?;
    if check.invalid_inputs.iter().any(|key| key.starts_with("MiniMaxH3AudioConditioningT8.ref_images.") || key.starts_with("MiniMaxH3ReferenceToVideo.ref_images.")) { return Err("comfyui-reference-capacity"); }
    if !check.ready { return Err("comfyui-preflight-failed"); }
    // Reserve before the HTTP side effect. INSERT is an atomic per-job claim.
    let conn = ledger(path)?;
    let initial_state = if images.is_empty() { "submitting" } else { "uploading" };
    let inserted = conn.execute("INSERT OR IGNORE INTO canvas_comfyui_jobs_v1(client_id,base,digest,state,output_node,created_at) VALUES(?1,?2,?3,?6,?4,?5)",rusqlite::params![request.client_task_id,base,digest,output_node,chrono::Utc::now().timestamp_millis(),initial_state]).map_err(|_| UNAVAILABLE)?;
    let mut stored = read_job(&conn,&request.client_task_id)?;
    if stored.base != base || stored.digest != digest { return Err("comfyui-submission-binding-changed"); }
    if inserted == 0 { return Ok(stored.job); }
    drop(conn);
    let mut workflow=if template::is_template(&request.workflow) {request.workflow["graph"].clone()} else {request.workflow};
    for image in &images {
        match upload_reference(&base,image).await {
            Ok(filename) => { workflow[&image.node_id]["inputs"]["image"]=Value::String(filename); }
            Err(error) => {
                // Upload uncertainty is not generation uncertainty: no /prompt
                // has been sent. Keep a terminal result; never auto-resubmit.
                stored.job.state="failed".into();stored.job.error=Some(error.into());
                update_job(&ledger(path)?,&stored)?;return Ok(stored.job);
            }
        }
    }
    if !images.is_empty() {
        // The ambiguity timer starts at the generation POST, not image transfer.
        stored.job.state="submitting".into();stored.created_at=chrono::Utc::now().timestamp_millis();
        ledger(path)?.execute("UPDATE canvas_comfyui_jobs_v1 SET state='submitting',created_at=?2 WHERE client_id=?1 AND state='uploading'",rusqlite::params![request.client_task_id,stored.created_at]).map_err(|_| UNAVAILABLE)?;
    }
    let sent = http_client(30)?.post(format!("{base}/prompt")).json(&serde_json::json!({"prompt":workflow,"client_id":format!("luckyray-{}",request.client_task_id)})).send().await;
    match sent {
        Ok(response) if response.status().is_client_error() => { stored.job.state="failed".into(); stored.job.error=Some("comfyui-prompt-rejected".into()); }
        Ok(response) => match json_response(response,512*1024).await {
            Ok(value) => if let Some(id) = value.get("prompt_id").and_then(Value::as_str).filter(|id| safe_id(id)) {
                stored.job.prompt_id=Some(id.to_owned());stored.job.state="queued".into();
            } else { stored.job.state="unknown".into(); stored.job.error=Some("comfyui-submission-unknown".into()); },
            Err(_) => { stored.job.state="unknown".into(); stored.job.error=Some("comfyui-submission-unknown".into()); }
        },
        Err(_) => { stored.job.state="unknown".into(); stored.job.error=Some("comfyui-submission-unknown".into()); }
    }
    update_job(&ledger(path)?,&stored)?;
    Ok(stored.job)
}
fn video_descriptor(entry: &Value, output_node: &str) -> Option<Value> {
    let outputs = entry.get("outputs")?.get(output_node)?;
    for key in ["gifs", "videos", "images"] {
        if let Some(items) = outputs.get(key).and_then(Value::as_array) {
            for item in items {
                let Some(filename) = item.get("filename").and_then(Value::as_str) else { continue; };
                let folder = item.get("subfolder").and_then(Value::as_str).unwrap_or("");
                if !filename.to_ascii_lowercase().ends_with(".mp4") || filename.contains('/') || !safe_relative(filename,false) || !safe_relative(folder,true) || item.get("type").and_then(Value::as_str) != Some("output") { continue; }
                return Some(serde_json::json!({"filename":filename,"subfolder":folder,"type":"output"}));
            }
        }
    }
    None
}
fn image_descriptor(entry:&Value,output_node:&str)->Option<Value> {
    let images=entry.get("outputs")?.get(output_node)?.get("images")?.as_array()?;
    for image in images {
        let Some(filename)=image.get("filename").and_then(Value::as_str) else {continue;};
        let folder=image.get("subfolder").and_then(Value::as_str).unwrap_or("");
        if filename.to_ascii_lowercase().ends_with(".png") && !filename.contains('/') && safe_relative(filename,false) && safe_relative(folder,true) && image.get("type").and_then(Value::as_str)==Some("output") {
            return Some(serde_json::json!({"filename":filename,"subfolder":folder,"type":"output"}));
        }
    }
    None
}
fn classify_failure(entry: &Value) -> String {
    let messages = entry.pointer("/status/messages").and_then(Value::as_array);
    let host_buffer = messages.is_some_and(|messages| messages.iter().any(|message| message.get(1).and_then(|v| v.get("exception_message")).and_then(Value::as_str).is_some_and(|text| text.contains("HostBuffer.read_file_slice"))));
    if host_buffer { "comfyui-host-buffer-read-failed" } else { "comfyui-execution-failed" }.into()
}
fn apply_history(stored: &mut StoredJob, history: &Value, prompt: &str) -> bool {
    let Some(entry)=history.get(prompt) else { return false; };
    let status_name=entry.pointer("/status/status_str").and_then(Value::as_str);
    if status_name==Some("error") || entry.pointer("/status/messages").and_then(Value::as_array).is_some_and(|messages| messages.iter().any(|m| m.get(0).and_then(Value::as_str)==Some("execution_error") || m.get(0).and_then(Value::as_str)==Some("execution_interrupted"))) {
        stored.job.state="failed".into();stored.job.error=Some(classify_failure(entry));
    } else if entry.pointer("/status/completed").and_then(Value::as_bool)==Some(true) {
        let output=if let Some(id)=stored.output_node.strip_prefix("image:") {image_descriptor(entry,id)} else {video_descriptor(entry,&stored.output_node)};
        if let Some(output)=output {
            stored.job.state="succeeded".into();stored.job.error=None;stored.output=Some(output.to_string());
        } else { stored.job.state="failed".into();stored.job.error=Some(if stored.output_node.starts_with("image:"){"comfyui-image-output-missing"}else{"comfyui-video-output-missing"}.into()); }
    } else { stored.job.state="running".into();stored.job.error=None; }
    true
}
pub(crate) async fn status(path: &Path, id: &str) -> Result<Job, &'static str> {
    let mut stored = read_job(&ledger(path)?,id)?;
    if stored.job.state == "failed" || stored.job.state == "succeeded" { return Ok(stored.job); }
    let Some(prompt) = stored.job.prompt_id.clone() else {
        // A crash during POST cannot safely be distinguished from acceptance.
        if (stored.job.state == "submitting" && chrono::Utc::now().timestamp_millis().saturating_sub(stored.created_at) >= 45_000)
            || (stored.job.state == "uploading" && chrono::Utc::now().timestamp_millis().saturating_sub(stored.created_at) >= 300_000) {
            stored.job.state="unknown".into(); stored.job.error=Some("comfyui-submission-unknown".into());
        }
        return Ok(stored.job);
    };
    let client = http_client(15)?;
    let history = json_response(client.get(format!("{}/history/{prompt}",stored.base)).send().await.map_err(|_| "comfyui-unreachable")?,8*1024*1024).await?;
    if !apply_history(&mut stored,&history,&prompt) {
        let queue = json_response(client.get(format!("{}/queue",stored.base)).send().await.map_err(|_| "comfyui-unreachable")?,8*1024*1024).await?;
        let includes = |key: &str| queue.get(key).and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| item.get(1).and_then(Value::as_str) == Some(prompt.as_str())));
        if includes("queue_running") { stored.job.state="running".into();stored.job.error=None; }
        else if includes("queue_pending") { stored.job.state="queued".into();stored.job.error=None; }
        else {
            // Completion can move a task from queue to history between GETs.
            // One read-back closes that race without resubmitting anything.
            let history = json_response(client.get(format!("{}/history/{prompt}",stored.base)).send().await.map_err(|_| "comfyui-unreachable")?,8*1024*1024).await?;
            if !apply_history(&mut stored,&history,&prompt) { stored.job.state="unknown".into();stored.job.error=Some("comfyui-task-not-observed".into()); }
        }
    }
    // A concurrent materialize may have saved a durable result in the meantime.
    commit_observation(path,stored)
}
fn commit_observation(path: &Path, stored: StoredJob) -> Result<Job, &'static str> {
    let mut conn = ledger(path)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| UNAVAILABLE)?;
    let latest = read_job(&tx,&stored.job.client_task_id)?;
    if latest.job.video_path.is_some() || latest.job.image_path.is_some() || latest.job.state == "failed" || latest.job.state == "succeeded" { return Ok(latest.job); }
    update_job(&tx,&stored)?;
    tx.commit().map_err(|_| UNAVAILABLE)?;
    Ok(stored.job)
}
fn hash_video_file(path: &Path) -> Result<String, &'static str> {
    use std::io::Read;
    let mut file=std::fs::File::open(path).map_err(|_| "comfyui-video-invalid")?;
    let len=file.metadata().map_err(|_| "comfyui-video-invalid")?.len();
    if len < 12 || len > MAX_VIDEO_BYTES as u64 { return Err("comfyui-video-invalid"); }
    let mut digest=Sha256::new();let mut total=0usize;let mut prefix=Vec::new();let mut buffer=[0u8;64*1024];
    loop {
        let read=file.read(&mut buffer).map_err(|_| "comfyui-video-invalid")?;if read==0 {break;}
        total=total.checked_add(read).ok_or("comfyui-video-invalid")?;if total>MAX_VIDEO_BYTES{return Err("comfyui-video-invalid");}
        if prefix.len()<8 {prefix.extend_from_slice(&buffer[..read.min(8-prefix.len())]);}
        digest.update(&buffer[..read]);
    }
    if total<12 || prefix.len()<8 || &prefix[4..8]!=b"ftyp" {return Err("comfyui-video-invalid");}
    Ok(format!("{:x}",digest.finalize()))
}
pub(crate) async fn materialize(path: &Path, id: &str, output_dir: &Path) -> Result<Job, &'static str> {
    let _ = status(path,id).await?;
    let mut stored = read_job(&ledger(path)?,id)?;
    if stored.output_node.starts_with("image:") {return materialize_image(path,id,output_dir,stored).await;}
    if stored.job.state != "succeeded" { return Err("comfyui-video-not-ready"); }
    let mut output:Value = serde_json::from_str(stored.output.as_deref().ok_or("comfyui-video-output-missing")?).map_err(|_| "comfyui-video-output-missing")?;
    if let (Some(saved),Some(expected)) = (stored.job.video_path.as_deref(),output.get("downloadSha256").and_then(Value::as_str)) {
        if hash_video_file(Path::new(saved)).ok().as_deref()==Some(expected) { return Ok(stored.job); }
    }
    stored.job.video_path=None;
    let filename = output["filename"].as_str().ok_or("comfyui-video-output-missing")?;
    let subfolder = output["subfolder"].as_str().ok_or("comfyui-video-output-missing")?;
    let mut url = reqwest::Url::parse(&format!("{}/view",stored.base)).map_err(|_| INVALID)?;
    url.query_pairs_mut().append_pair("filename",filename).append_pair("subfolder",subfolder).append_pair("type","output");
    let mut response = http_client(180)?.get(url).send().await.map_err(|_| "comfyui-download-failed")?;
    if !response.status().is_success() || response.content_length().is_some_and(|size| size == 0 || size > MAX_VIDEO_BYTES as u64) { return Err("comfyui-download-failed"); }
    std::fs::create_dir_all(output_dir).map_err(|_| "comfyui-save-failed")?;
    let stem = format!("{:x}",Sha256::digest(format!("{}:{}",id,stored.digest).as_bytes()));
    let final_path=output_dir.join(format!("comfy-{stem}.mp4"));
    let partial_path=output_dir.join(format!("comfy-{stem}-{}.part",rand::random::<u64>()));
    let mut output_file = std::fs::OpenOptions::new().write(true).create_new(true).open(&partial_path).map_err(|_| "comfyui-save-failed")?;
    let transfer = async {
        let mut total=0usize;let mut prefix=Vec::new();let mut digest=Sha256::new();
        while let Some(chunk)=response.chunk().await.map_err(|_| "comfyui-download-failed")? {
            total=total.checked_add(chunk.len()).ok_or("comfyui-download-too-large")?;
            if total > MAX_VIDEO_BYTES { return Err("comfyui-download-too-large"); }
            if prefix.len()<16 { prefix.extend_from_slice(&chunk[..chunk.len().min(16-prefix.len())]); }
            digest.update(&chunk);
            output_file.write_all(&chunk).map_err(|_| "comfyui-save-failed")?;
        }
        if total<12 || prefix.len()<8 || &prefix[4..8]!=b"ftyp" { return Err("comfyui-video-invalid"); }
        output_file.sync_all().map_err(|_| "comfyui-save-failed")?;
        Ok(format!("{:x}",digest.finalize()))
    }.await;
    drop(output_file);
    let expected_hash=match transfer { Ok(hash)=>hash,Err(error)=>{let _=std::fs::remove_file(&partial_path);return Err(error);} };
    // Link installs atomically without overwriting an existing completed file.
    if let Err(error)=std::fs::hard_link(&partial_path,&final_path) {
        if error.kind()!=std::io::ErrorKind::AlreadyExists || hash_video_file(&final_path).ok().as_deref()!=Some(expected_hash.as_str()) {
            let _=std::fs::remove_file(&partial_path);return Err("comfyui-save-failed");
        }
    }
    let _=std::fs::remove_file(&partial_path);
    stored.job.video_path=Some(final_path.to_string_lossy().into_owned());
    output["downloadSha256"]=Value::String(expected_hash);
    stored.output=Some(output.to_string());
    update_job(&ledger(path)?,&stored)?;
    Ok(stored.job)
}

/// Local playback lease: a result name is not an arbitrary filesystem path.
/// Resolve it only through a successful task and its verified download binding.
pub(crate) struct VideoPlaybackLease {
    db: std::path::PathBuf,
    id: String,
    digest: String,
    hash: String,
    pub path: std::path::PathBuf,
    _file: std::fs::File,
}
impl VideoPlaybackLease {
    pub fn revision(&self) -> &str { &self.hash }
    pub fn verify(&self) -> Result<(), &'static str> {
        let conn=Connection::open_with_flags(&self.db,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| UNAVAILABLE)?;
        let stored=read_job(&conn,&self.id)?;
        let output:Value=serde_json::from_str(stored.output.as_deref().unwrap_or("")).map_err(|_|"comfyui-video-binding-changed")?;
        if stored.job.state!="succeeded" || stored.digest!=self.digest || stored.output_node.starts_with("image:")
            || stored.job.video_path.as_deref().and_then(|p|std::fs::canonicalize(p).ok()).as_ref()!=Some(&self.path)
            || output.get("downloadSha256").and_then(Value::as_str)!=Some(self.hash.as_str()) {
            return Err("comfyui-video-binding-changed");
        }
        Ok(())
    }
}
pub(crate) fn open_video_playback(db:&Path,output_dir:&Path,name:&str)->Result<VideoPlaybackLease,&'static str> {
    let stem=name.strip_prefix("comfy-").and_then(|s|s.strip_suffix(".mp4")).ok_or("comfyui-video-name-invalid")?;
    if stem.len()!=64 || !stem.bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c)) {return Err("comfyui-video-name-invalid");}
    let conn=Connection::open_with_flags(db,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_|UNAVAILABLE)?;
    let suffix=format!("/{name}");
    let mut query=conn.prepare("SELECT client_id FROM canvas_comfyui_jobs_v1 WHERE substr(replace(video_path, char(92), '/'), -length(?1))=?1 LIMIT 2").map_err(|_|UNAVAILABLE)?;
    let ids=query.query_map([suffix],|r|r.get::<_,String>(0)).map_err(|_|UNAVAILABLE)?.collect::<Result<Vec<_>,_>>().map_err(|_|UNAVAILABLE)?;
    if ids.len()!=1 {return Err("comfyui-video-binding-missing");}
    let stored=read_job(&conn,&ids[0])?;
    if stored.job.state!="succeeded" || stored.output_node.starts_with("image:") {return Err("comfyui-video-not-ready");}
    let expected_stem=format!("{:x}",Sha256::digest(format!("{}:{}",ids[0],stored.digest).as_bytes()));
    if stem!=expected_stem {return Err("comfyui-video-binding-changed");}
    let root=std::fs::canonicalize(output_dir).map_err(|_|"comfyui-video-unavailable")?;
    let path=std::fs::canonicalize(stored.job.video_path.as_deref().ok_or("comfyui-video-unavailable")?).map_err(|_|"comfyui-video-unavailable")?;
    if path.parent()!=Some(root.as_path()) || path.file_name().and_then(|s|s.to_str())!=Some(name) {return Err("comfyui-video-binding-changed");}
    let output:Value=serde_json::from_str(stored.output.as_deref().unwrap_or("")).map_err(|_|"comfyui-video-binding-changed")?;
    let hash=output.get("downloadSha256").and_then(Value::as_str).ok_or("comfyui-video-binding-changed")?.to_owned();
    let mut options=std::fs::OpenOptions::new();options.read(true);
    #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.share_mode(1);}
    let file=options.open(&path).map_err(|_|"comfyui-video-unavailable")?;
    if hash_video_file(&path)?!=hash {return Err("comfyui-video-content-changed");}
    let lease=VideoPlaybackLease{db:db.to_owned(),id:ids[0].clone(),digest:stored.digest,hash,path,_file:file};
    lease.verify()?;
    Ok(lease)
}

const MAX_RESULT_IMAGE_BYTES:usize=40*1024*1024;
fn valid_result_image(bytes:&[u8])->bool {
    if bytes.is_empty()||bytes.len()>MAX_RESULT_IMAGE_BYTES||image::guess_format(bytes).ok()!=Some(image::ImageFormat::Png) {return false;}
    let dimensions=image::ImageReader::with_format(std::io::Cursor::new(bytes),image::ImageFormat::Png).into_dimensions().ok();
    dimensions.is_some_and(|(w,h)|w>0&&h>0&&w<=16384&&h<=16384&&u64::from(w)*u64::from(h)<=64_000_000)
        && image::load_from_memory_with_format(bytes,image::ImageFormat::Png).is_ok()
}
fn hash_image_file(path:&Path)->Option<String> {
    use std::io::Read;
    let length=std::fs::metadata(path).ok()?.len();
    if length==0||length>MAX_RESULT_IMAGE_BYTES as u64 {return None;}
    let mut bytes=Vec::new();std::fs::File::open(path).ok()?.take((MAX_RESULT_IMAGE_BYTES+1) as u64).read_to_end(&mut bytes).ok()?;
    if !valid_result_image(&bytes) {return None;} Some(format!("{:x}",Sha256::digest(&bytes)))
}
async fn materialize_image(path:&Path,id:&str,output_dir:&Path,mut stored:StoredJob)->Result<Job,&'static str> {
    if stored.job.state!="succeeded" {return Err("comfyui-image-not-ready");}
    let mut output:Value=serde_json::from_str(stored.output.as_deref().ok_or("comfyui-image-output-missing")?).map_err(|_|"comfyui-image-output-missing")?;
    if let (Some(saved),Some(expected))=(stored.job.image_path.as_deref(),output.get("downloadSha256").and_then(Value::as_str)) {
        if hash_image_file(Path::new(saved)).as_deref()==Some(expected) {return Ok(stored.job);}
    }
    stored.job.image_path=None;
    let filename=output["filename"].as_str().ok_or("comfyui-image-output-missing")?;
    let subfolder=output["subfolder"].as_str().ok_or("comfyui-image-output-missing")?;
    let mut url=reqwest::Url::parse(&format!("{}/view",stored.base)).map_err(|_|INVALID)?;
    url.query_pairs_mut().append_pair("filename",filename).append_pair("subfolder",subfolder).append_pair("type","output");
    let mut response=http_client(180)?.get(url).send().await.map_err(|_|"comfyui-download-failed")?;
    if !response.status().is_success()||response.content_length().is_some_and(|n|n==0||n>MAX_RESULT_IMAGE_BYTES as u64) {return Err("comfyui-download-failed");}
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|"comfyui-download-failed")? {
        if bytes.len().checked_add(chunk.len()).is_none_or(|n|n>MAX_RESULT_IMAGE_BYTES) {return Err("comfyui-download-too-large");}
        bytes.extend_from_slice(&chunk);
    }
    if !valid_result_image(&bytes) {return Err("comfyui-image-invalid");}
    std::fs::create_dir_all(output_dir).map_err(|_|"comfyui-save-failed")?;
    let stem=format!("{:x}",Sha256::digest(format!("{}:{}",id,stored.digest).as_bytes()));
    let final_path=output_dir.join(format!("comfy-{stem}.png"));
    let partial_path=output_dir.join(format!("comfy-{stem}-{}.part",rand::random::<u64>()));
    let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&partial_path).map_err(|_|"comfyui-save-failed")?;
    let written=file.write_all(&bytes).and_then(|_|file.sync_all());drop(file);
    if written.is_err(){let _=std::fs::remove_file(&partial_path);return Err("comfyui-save-failed");}
    let hash=format!("{:x}",Sha256::digest(&bytes));
    if let Err(error)=std::fs::hard_link(&partial_path,&final_path) {
        if error.kind()!=std::io::ErrorKind::AlreadyExists||hash_image_file(&final_path).as_deref()!=Some(hash.as_str()) {let _=std::fs::remove_file(&partial_path);return Err("comfyui-save-failed");}
    }
    let _=std::fs::remove_file(&partial_path);
    stored.job.image_path=Some(final_path.to_string_lossy().into_owned());
    output["downloadSha256"]=Value::String(hash);stored.output=Some(output.to_string());
    update_job(&ledger(path)?,&stored)?;Ok(stored.job)
}

#[cfg(test)]
#[path = "canvas_comfyui_reliability_tests.rs"]
mod reliability_tests;

#[cfg(test)]
mod workflow_tests {
    use super::*;
    fn fixture() -> Value { serde_json::from_str(include_str!("../../tests/fixtures/comfy-h3-t2va.api.json")).unwrap() }
    fn database() -> tempfile::NamedTempFile {
        let file=tempfile::NamedTempFile::new().unwrap();
        Connection::open(file.path()).unwrap().execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);").unwrap(); file
    }
    #[test]
    fn native_playback_binds_successful_materialized_bytes_only() {
        let db=database();let conn=ledger(db.path()).unwrap();let dir=tempfile::tempdir().unwrap();
        let name=format!("comfy-{:x}.mp4",Sha256::digest(b"local-result:digest"));
        let file=dir.path().join(&name);std::fs::write(&file,b"\x00\x00\x00\x18ftypisom0000").unwrap();
        let hash=hash_video_file(&file).unwrap();
        let output=serde_json::json!({"downloadSha256":hash}).to_string();
        conn.execute("INSERT INTO canvas_comfyui_jobs_v1(client_id,base,digest,state,output_node,video_path,output) VALUES('local-result',?1,'digest','succeeded','303',?2,?3)",rusqlite::params![DEFAULT,file.to_string_lossy(),output]).unwrap();
        let lease=open_video_playback(db.path(),dir.path(),&name).unwrap();
        assert_eq!(lease.path,std::fs::canonicalize(&file).unwrap());assert!(lease.verify().is_ok());
        conn.execute("UPDATE canvas_comfyui_jobs_v1 SET digest='changed'",[]).unwrap();
        assert_eq!(lease.verify(),Err("comfyui-video-binding-changed"));drop(lease);
        conn.execute("UPDATE canvas_comfyui_jobs_v1 SET digest='digest'",[]).unwrap();
        for bad in [format!("../{name}"),file.to_string_lossy().into_owned(),"https://example.com/x.mp4".into(),"comfy-abc.mp4".into()] {
            assert!(matches!(open_video_playback(db.path(),dir.path(),&bad),Err("comfyui-video-name-invalid")));
        }
        let other=tempfile::tempdir().unwrap();
        assert!(matches!(open_video_playback(db.path(),other.path(),&name),Err("comfyui-video-binding-changed")));
        conn.execute("UPDATE canvas_comfyui_jobs_v1 SET state='running'",[]).unwrap();
        assert!(matches!(open_video_playback(db.path(),dir.path(),&name),Err("comfyui-video-not-ready")));
        conn.execute("UPDATE canvas_comfyui_jobs_v1 SET state='succeeded',output_node='image:303'",[]).unwrap();
        assert!(matches!(open_video_playback(db.path(),dir.path(),&name),Err("comfyui-video-not-ready")));
        conn.execute("UPDATE canvas_comfyui_jobs_v1 SET output_node='303',output='{}'",[]).unwrap();
        assert!(matches!(open_video_playback(db.path(),dir.path(),&name),Err("comfyui-video-binding-changed")));
        conn.execute("UPDATE canvas_comfyui_jobs_v1 SET output=?1",[output]).unwrap();
        std::fs::write(&file,b"\x00\x00\x00\x18ftypisom1111").unwrap();
        assert!(matches!(open_video_playback(db.path(),dir.path(),&name),Err("comfyui-video-content-changed")));
        conn.execute("INSERT INTO canvas_comfyui_jobs_v1(client_id,base,digest,state,output_node,video_path) VALUES('duplicate',?1,'digest','succeeded','303',?2)",rusqlite::params![DEFAULT,file.to_string_lossy()]).unwrap();
        assert!(matches!(open_video_playback(db.path(),dir.path(),&name),Err("comfyui-video-binding-missing")));
    }
    #[test]
    fn reviewed_graph_and_renamed_ids_are_valid() {
        let graph=fixture(); assert_eq!(validate_workflow(&graph).unwrap(),"303");
        let mut renamed=serde_json::Map::new();
        for (id,node) in graph.as_object().unwrap() {
            let mut node=node.clone();
            for value in node["inputs"].as_object_mut().unwrap().values_mut() {
                if let Some(link)=value.as_array_mut() { link[0]=Value::String(format!("9{}",link[0].as_str().unwrap())); }
            }
            renamed.insert(format!("9{id}"),node);
        }
        assert_eq!(validate_workflow(&Value::Object(renamed)).unwrap(),"9303");
    }
    #[test]
    fn unsafe_expression_links_nodes_and_bounds_are_rejected() {
        for (id,key,value) in [
            ("308","expression",serde_json::json!("__import__('os').system('unsafe')")),
            ("303","filename_prefix",serde_json::json!("../outside")),
            ("236","value",serde_json::json!(600)),
            ("235","megapixels",serde_json::json!(100)),
            ("302","sigmas",serde_json::json!(["304",0])),
            ("307","task_type",serde_json::json!("Ref2VA")),
        ] {
            let mut graph=fixture();graph[id]["inputs"][key]=value;assert!(validate_workflow(&graph).is_err(),"{id}:{key}");
        }
        let mut graph=fixture();graph["309"]["class_type"]=serde_json::json!("ArbitraryHttpNode");assert!(validate_workflow(&graph).is_err());
        let mut graph=fixture();graph["303"]["inputs"]["url"]=serde_json::json!("https://example.com");assert!(validate_workflow(&graph).is_err());
    }
    #[test]
    fn config_revision_conflicts_and_base_save_preserves_workflow() {
        let db=database();let initial=get(db.path()).unwrap();assert_eq!(initial.revision,0);
        let next=set_workflow(db.path(),Some(fixture().to_string()),Some("Synthetic H3".into()),0).unwrap();assert_eq!(next.revision,1);
        assert!(set_workflow(db.path(),None,None,0).is_err());
        let changed=set(db.path(),"http://localhost:8189").unwrap();assert_eq!(changed.revision,2);assert_eq!(changed.workflow_name.as_deref(),Some("Synthetic H3"));
        let cleared=set_workflow(db.path(),None,None,2).unwrap();assert_eq!(cleared.revision,3);assert!(cleared.workflow_json.is_none());
    }
    #[test]
    fn video_history_descriptor_requires_own_safe_output() {
        let entry=serde_json::json!({"outputs":{"303":{"gifs":[{"filename":"clip.mp4","subfolder":"MiniMaxH3","type":"output"}]},"999":{"gifs":[{"filename":"other.mp4","type":"output"}]}}});
        assert_eq!(video_descriptor(&entry,"303").unwrap()["filename"],"clip.mp4");
        assert!(video_descriptor(&entry,"missing").is_none());
        for name in ["../clip.mp4","C:\\clip.mp4","/clip.mp4","clip.png"] { let mut bad=entry.clone();bad["outputs"]["303"]["gifs"][0]["filename"]=serde_json::json!(name);assert!(video_descriptor(&bad,"303").is_none()); }
        let mut bad=entry.clone();bad["outputs"]["303"]["gifs"][0]["type"]=serde_json::json!("input");assert!(video_descriptor(&bad,"303").is_none());
    }
    #[test]
    fn ledger_claim_is_atomic_and_private() {
        let db=database();let conn=ledger(db.path()).unwrap();
        let sql="INSERT OR IGNORE INTO canvas_comfyui_jobs_v1(client_id,base,digest,state,output_node) VALUES(?1,?2,?3,'submitting','303')";
        assert_eq!(conn.execute(sql,rusqlite::params!["synthetic-task",DEFAULT,"digest"]).unwrap(),1);
        assert_eq!(conn.execute(sql,rusqlite::params!["synthetic-task",DEFAULT,"digest"]).unwrap(),0);
        let job=read_job(&conn,"synthetic-task").unwrap();assert_eq!(job.job.state,"submitting");
        let public=serde_json::to_string(&job.job).unwrap();assert!(!public.contains("digest") && !public.contains(DEFAULT));
        assert!(read_job(&conn,"../outside").is_err());
    }
    #[test]
    fn original_failure_is_classified_without_traceback() {
        let entry=serde_json::json!({"status":{"messages":[["execution_error",{"exception_message":"HostBuffer.read_file_slice failed secret/path/prompt"}]]}});
        assert_eq!(classify_failure(&entry),"comfyui-host-buffer-read-failed");
    }
    #[test]
    fn stale_poll_cannot_overwrite_completed_observation() {
        let db=database();let conn=ledger(db.path()).unwrap();
        conn.execute("INSERT INTO canvas_comfyui_jobs_v1(client_id,base,digest,state,output_node) VALUES('race-task',?1,'digest','running','303')",[DEFAULT]).unwrap();
        let mut stale=read_job(&conn,"race-task").unwrap();stale.job.state="queued".into();
        let mut done=stale.clone();done.job.state="succeeded".into();done.output=Some("{}".into());
        assert_eq!(commit_observation(db.path(),done).unwrap().state,"succeeded");
        assert_eq!(commit_observation(db.path(),stale).unwrap().state,"succeeded");
    }
    #[test]
    fn cached_output_validation_checks_container_and_bytes() {
        let tmp=tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(),b"\x00\x00\x00\x18ftypisom0000").unwrap();
        let original=hash_video_file(tmp.path()).unwrap();
        std::fs::write(tmp.path(),b"\x00\x00\x00\x18ftypisom9999").unwrap();
        assert_ne!(original,hash_video_file(tmp.path()).unwrap());
        std::fs::write(tmp.path(),b"not an mp4 file").unwrap();
        assert!(hash_video_file(tmp.path()).is_err());
    }

    #[test]
    fn preflight_checks_current_string_combos_not_bare_type_names() {
        let graph=fixture();let mut info=serde_json::json!({});
        for node in graph.as_object().unwrap().values() {
            let class=node["class_type"].as_str().unwrap();
            let entry=info.as_object_mut().unwrap().entry(class.to_owned()).or_insert_with(||serde_json::json!({"input":{"required":{}}}));
            for (key,value) in node["inputs"].as_object().unwrap() {
                if let Some(value)=value.as_str() {
                    let schema=&mut entry["input"]["required"];
                    if ["vae_name","unet_name","clip_name","lora_name"].contains(&key.as_str()) {
                        let options=schema.as_object_mut().unwrap().entry(key.clone()).or_insert_with(||serde_json::json!([[]]));options[0].as_array_mut().unwrap().push(serde_json::json!(value));
                    } else { schema[key]=serde_json::json!(["STRING"]); }
                }
            }
        }
        info["ResolutionSelector"]["input"]["required"]["aspect_ratio"]=serde_json::json!([["16:9 (Widescreen)"]]);
        info["MiniMaxH3AudioConditioningT8"]["input"]["required"]["task_type"] = serde_json::json!([["auto","T2VA","Ref2VA"]]);
        assert!(inspect_dependencies(&graph,&info).ready);
        // Installed T8 1.3.3 uses the V3 COMBO declaration, not the legacy array.
        info["MiniMaxH3AudioConditioningT8"]["input"]["required"]["task_type"] = serde_json::json!(["COMBO", {"options":["auto","T2VA","Ref2VA"]}]);
        let mut automatic=graph.clone();automatic["307"]["inputs"]["task_type"]=serde_json::json!("auto");
        assert!(inspect_dependencies(&automatic,&info).ready);
        info["MiniMaxH3AudioConditioningT8"]["input"]["required"]["task_type"][1]["options"] = serde_json::json!(["T2VA"]);
        assert_eq!(inspect_dependencies(&automatic,&info).invalid_inputs,vec!["MiniMaxH3AudioConditioningT8.task_type"]);
        info["MiniMaxH3AudioConditioningT8"]["input"]["required"]["task_type"][1]["options"] = serde_json::json!(["auto","T2VA","Ref2VA"]);
        info["ResolutionSelector"]["input"]["required"]["aspect_ratio"]=serde_json::json!([["16:9 Different Label"]]);
        let failed=inspect_dependencies(&graph,&info);assert!(!failed.ready);assert_eq!(failed.invalid_inputs,vec!["ResolutionSelector.aspect_ratio"]);
        info["ResolutionSelector"]["input"]["required"].as_object_mut().unwrap().remove("aspect_ratio");
        info["ResolutionSelector"]["input"]["optional"]=serde_json::json!({"aspect_ratio":[["1:1 (Square)"]]});
        assert!(!inspect_dependencies(&graph,&info).ready);
    }

    fn reference_fixture(count: usize) -> Value {
        let mut graph=fixture();
        graph["307"]["inputs"]["task_type"]=serde_json::json!("Ref2VA");
        graph["307"]["inputs"]["ref_image_size"]=serde_json::json!(if count == 1 { "max" } else { "match" });
        for index in 0..count {
            let id=format!("8{index}");
            graph[&id]=serde_json::json!({"class_type":"LoadImage","inputs":{"image":format!("luckyray-ref-{index}.png")}});
            graph["307"]["inputs"][format!("ref_images.ref_image_{index}")]=serde_json::json!([id,0]);
        }
        graph
    }
    fn reference_image(node_id: &str) -> ReferenceImage {
        ReferenceImage { node_id:node_id.into(), data_url:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==".into() }
    }
    #[test]
    fn workfisher_image_result_is_bound_to_its_output_and_preserves_ledger_identity() {
        use std::io::{Read,Write};
        let entry=serde_json::json!({"outputs":{"212":{"images":[{"filename":"result.png","subfolder":"short-drama","type":"output"}]},"999":{"images":[{"filename":"other.png","type":"output"}]}}});
        assert_eq!(image_descriptor(&entry,"212").unwrap()["filename"],"result.png");
        let mut bad=entry.clone();bad["outputs"]["212"]["images"][0]["filename"]=serde_json::json!("../private.png");assert!(image_descriptor(&bad,"212").is_none());
        let mut png=std::io::Cursor::new(Vec::new());image::DynamicImage::new_rgba8(2,2).write_to(&mut png,image::ImageFormat::Png).unwrap();let png=png.into_inner();
        assert!(valid_result_image(&png));assert!(!valid_result_image(&png[..png.len()-5]));
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();
        let server=std::thread::spawn(move||{
            let (mut stream,_)=listener.accept().unwrap();let mut request=[0u8;1024];let count=stream.read(&mut request).unwrap();assert!(String::from_utf8_lossy(&request[..count]).starts_with("GET /view?"));
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",png.len()).unwrap();stream.write_all(&png).unwrap();
        });
        let db=database();let conn=ledger(db.path()).unwrap();let descriptor=image_descriptor(&entry,"212").unwrap().to_string();
        conn.execute("INSERT INTO canvas_comfyui_jobs_v1(client_id,base,digest,state,output_node,output) VALUES('result-test',?1,'digest','succeeded','image:212',?2)",rusqlite::params![format!("http://{address}"),descriptor]).unwrap();drop(conn);
        let dir=tempfile::tempdir().unwrap();let runtime=tokio::runtime::Runtime::new().unwrap();
        let job=runtime.block_on(materialize(db.path(),"result-test",dir.path())).unwrap();server.join().unwrap();
        let path=job.image_path.unwrap();assert!(job.video_path.is_none());assert!(Path::new(&path).is_file());
        let cached=runtime.block_on(materialize(db.path(),"result-test",dir.path())).unwrap();assert_eq!(cached.image_path.as_deref(),Some(path.as_str()));
        std::fs::write(&path,b"corrupt").unwrap();assert!(runtime.block_on(materialize(db.path(),"result-test",dir.path())).is_err());
    }
    #[test]
    fn three_view_reference_uses_the_generated_input_slot() {
        let mut g:Value=serde_json::from_str(include_str!("../../src/core/canvas/workFisherData.json")).unwrap();let graph=&mut g["threeView"];
        graph.as_object_mut().unwrap().remove("215");graph["9000"]=serde_json::json!({"class_type":"LoadImage","inputs":{"image":"luckyray-ref-0.png"}});
        graph["206"]["inputs"]["images.image_1"]=serde_json::json!(["9000",0]);
        assert_eq!(validate_workflow(graph).unwrap(),"image:212");
        assert_eq!(prepare_images(graph,&[reference_image("9000")]).unwrap().len(),1);
        assert!(prepare_images(graph,&[reference_image("215")]).is_err());
    }
    #[test]
    fn workfisher_preflight_refuses_unverified_fields_models_and_reference_capacity() {
        let data:Value=serde_json::from_str(include_str!("../../src/core/canvas/workFisherData.json")).unwrap();
        let mut graph=data["video"].clone();graph.as_object_mut().unwrap().remove("137");graph.as_object_mut().unwrap().remove("288");
        graph["151"]["inputs"]["model"]=serde_json::json!(["155",0]);
        for index in 0..2 {
            let id=(9000+index).to_string();graph[&id]=serde_json::json!({"class_type":"LoadImage","inputs":{"image":format!("luckyray-ref-{index}.png")}});
            graph["136"]["inputs"][format!("ref_images.ref_image_{index}")]=serde_json::json!([id,0]);
        }
        assert_eq!(validate_workflow(&graph).unwrap(),"156");
        let mut info=serde_json::json!({});
        for node in graph.as_object().unwrap().values() {
            let class=node["class_type"].as_str().unwrap();
            let definition=info.as_object_mut().unwrap().entry(class.to_string()).or_insert_with(||serde_json::json!({"input":{"required":{}}}));
            for (key,value) in node["inputs"].as_object().unwrap() {
                let schema=&mut definition["input"]["required"];
                if ["vae_name","unet_name","clip_name","lora_name"].contains(&key.as_str()) {
                    let options=schema.as_object_mut().unwrap().entry(key.clone()).or_insert_with(||serde_json::json!([[]]));
                    options[0].as_array_mut().unwrap().push(value.clone());
                } else {schema[key]=serde_json::json!([if key.starts_with("ref_images."){"IMAGE"}else{"ANY"}]);}
            }
        }
        assert!(inspect_dependencies(&graph,&info).ready);
        info["ComfyMathExpression"]["input"]["required"].as_object_mut().unwrap().remove("values.a");
        info["ComfyMathExpression"]["input"]["required"]["values"]=serde_json::json!(["COMFY_AUTOGROW_V3",{"template":{"names":["a","b"],"min":1,"input":{"required":{"value":["FLOAT,INT,BOOLEAN"]}}}}]);
        assert!(inspect_dependencies(&graph,&info).ready);
        info["ComfyMathExpression"]["input"]["required"]["values"][1]["template"]["names"]=serde_json::json!(["b"]);
        assert!(inspect_dependencies(&graph,&info).invalid_inputs.contains(&"ComfyMathExpression.values.a".to_string()));
        info["ComfyMathExpression"]["input"]["required"]["values"][1]["template"]["names"]=serde_json::json!(["a","b"]);
        let qwen=serde_json::json!({"input":{"required":{"images":["COMFY_AUTOGROW_V3",{"template":{"names":["image_1","image_2"],"min":0,"input":{"required":{"image":["IMAGE"]}}}}]}}});
        assert!(supports_named_autogrow(&qwen,"images","image_1","image","IMAGE"));
        assert!(!supports_named_autogrow(&qwen,"images","image_3","image","IMAGE"));
        // VideoHelperSuite exposes these as format-specific widget metadata.
        {
            let vhs=&mut info["VHS_VideoCombine"]["input"]["required"];
            for key in ["pix_fmt","crf","save_metadata"] {vhs.as_object_mut().unwrap().remove(key);}
            vhs["format"]=serde_json::json!([["video/h265-mp4"],{"formats":{"video/h265-mp4":[["pix_fmt",["yuv420p10le","yuv420p"]],["crf","INT",{"min":0,"max":100}],["save_metadata","BOOLEAN",{"default":true}]]}}]);
        }
        assert!(inspect_dependencies(&graph,&info).ready);
        info["VHS_VideoCombine"]["input"]["required"]["format"][1]["formats"]["video/h265-mp4"][0][1]=serde_json::json!(["yuv420p"]);
        assert!(inspect_dependencies(&graph,&info).invalid_inputs.contains(&"VHS_VideoCombine.pix_fmt".to_string()));
        info["VHS_VideoCombine"]["input"]["required"]["format"][1]["formats"]["video/h265-mp4"][0][1]=serde_json::json!(["yuv420p10le"]);
        info["MiniMaxH3ReferenceToVideo"]["input"]["required"].as_object_mut().unwrap().remove("ref_images.ref_image_1");
        let result=inspect_dependencies(&graph,&info);assert!(!result.ready);assert!(result.invalid_inputs.contains(&"MiniMaxH3ReferenceToVideo.ref_images.ref_image_1".to_string()));
        info["MiniMaxH3ReferenceToVideo"]["input"]["required"]["ref_images.ref_image_1"]=serde_json::json!(["IMAGE"]);
        info["BasicScheduler"]["input"]["required"].as_object_mut().unwrap().remove("denoise");
        assert!(inspect_dependencies(&graph,&info).invalid_inputs.contains(&"BasicScheduler.denoise".to_string()));
        info["BasicScheduler"]["input"]["required"]["denoise"]=serde_json::json!(["FLOAT"]);
        info["UNETLoader"]["input"]["required"]["unet_name"]=serde_json::json!([[]]);
        assert!(!inspect_dependencies(&graph,&info).missing_models.is_empty());
    }
    #[test]
    fn ref2va_accepts_only_contiguous_distinct_owned_image_slots() {
        for count in 1..=MAX_REFERENCE_IMAGES { assert_eq!(validate_workflow(&reference_fixture(count)).unwrap(),"303"); }
        let mut wrong=reference_fixture(2);wrong["307"]["inputs"]["ref_images.ref_image_1"]=serde_json::json!(["80",0]);assert!(validate_workflow(&wrong).is_err());
        let mut wrong=reference_fixture(1);wrong["307"]["inputs"]["task_type"]=serde_json::json!("T2VA");assert!(validate_workflow(&wrong).is_err());
        let mut wrong=reference_fixture(1);wrong["307"]["inputs"]["ref_images.ref_image_0"]=serde_json::json!(["80",1]);assert!(validate_workflow(&wrong).is_err());
        let mut wrong=reference_fixture(1);wrong["81"]=serde_json::json!({"class_type":"LoadImage","inputs":{"image":"orphan.png"}});assert!(validate_workflow(&wrong).is_err());
        let mut wrong=reference_fixture(1);wrong["80"]["inputs"]["image"]=serde_json::json!("../private.png");assert!(validate_workflow(&wrong).is_err());
        assert!(validate_workflow(&reference_fixture(MAX_REFERENCE_IMAGES + 1)).is_err());
        for count in [0, 1, 2, 9] {
            let mut automatic = if count == 0 { fixture() } else { reference_fixture(count) };
            automatic["307"]["inputs"]["task_type"] = serde_json::json!("auto");
            assert_eq!(validate_workflow(&automatic).unwrap(), "303");
        }
    }
    #[test]
    fn reference_slots_follow_installed_autogrow_or_expanded_schema() {
        let mut info = serde_json::json!({"input":{"optional":{"ref_images":["COMFY_AUTOGROW_V3",{"template":{"prefix":"ref_image_","min":0,"max":9,"input":{"required":{"ref_image":["IMAGE",{}]}}}}]}}});
        for i in 0..9 { assert!(supports_reference_slot(&info, i)); }
        assert!(!supports_reference_slot(&info, 9));
        info["input"]["optional"]["ref_images"][1]["template"]["max"] = serde_json::json!(2);
        assert!(supports_reference_slot(&info, 1)); assert!(!supports_reference_slot(&info, 2));
        info["input"]["optional"]["ref_images"][1]["template"]["prefix"] = serde_json::json!("other_");
        assert!(!supports_reference_slot(&info, 0));
        let flat = serde_json::json!({"input":{"optional":{"ref_images.ref_image_0":["IMAGE",{}]}}});
        assert!(supports_reference_slot(&flat, 0)); assert!(!supports_reference_slot(&flat, 1));
        assert!(!supports_reference_slot(&serde_json::json!({}), 0));
    }
    #[test]
    fn reference_bytes_are_bounded_images_and_order_bound() {
        let graph=reference_fixture(1);
        let prepared=prepare_images(&graph,&[reference_image("80")]).unwrap();
        assert_eq!(prepared.len(),1);assert_eq!(prepared[0].mime,"image/png");
        assert!(prepared[0].filename.starts_with("luckyray-"));
        assert!(prepare_images(&graph,&[]).is_err());
        assert!(prepare_images(&graph,&[reference_image("81")]).is_err());
        for bad in ["C:\\secret.png","https://example.com/a.png","data:text/plain;base64,c2VjcmV0","data:image/png;base64,c2VjcmV0"] {
            assert!(prepare_images(&graph,&[ReferenceImage{node_id:"80".into(),data_url:bad.into()}]).is_err());
        }
        let mut wrong_mime=reference_image("80");wrong_mime.data_url=wrong_mime.data_url.replace("image/png","image/jpeg");assert!(prepare_images(&graph,&[wrong_mime]).is_err());
        let digest=submission_digest(&graph,&prepared).unwrap();
        let mut modified=reference_fixture(1);modified["306"]["inputs"]["noise_seed"]=serde_json::json!(777);assert_ne!(digest,submission_digest(&modified,&prepared).unwrap());
        let old=fixture();assert_eq!(submission_digest(&old,&[]).unwrap(),format!("{:x}",Sha256::digest(serde_json::to_vec(&old).unwrap())));
    }
    #[test]
    fn upload_response_cannot_redirect_to_another_image_or_folder() {
        let images=prepare_images(&reference_fixture(1),&[reference_image("80")]).unwrap();let image=&images[0];
        let descriptor=serde_json::json!({"name":image.filename,"subfolder":"luckyray","type":"input"});
        assert_eq!(upload_descriptor(&descriptor,image).unwrap(),format!("luckyray/{}",image.filename));
        for (key,value) in [("name","other.png"),("subfolder","../private"),("type","output")] {
            let mut wrong=descriptor.clone();wrong[key]=serde_json::json!(value);assert!(upload_descriptor(&wrong,image).is_err());
        }
    }

    #[test]
    fn reference_resume_probe_binds_graph_address_and_sources_without_bytes() {
        let runtime=tokio::runtime::Runtime::new().unwrap();
        let db=database();let graph=reference_fixture(1);let sources=vec!["[\"asset:test\",\"url-sha256\"]".to_string()];
        let request_digest=reference_request_digest(&graph,&sources).unwrap().unwrap();
        let digest=format!("{request_digest}:{}","a".repeat(64));
        let conn=ledger(db.path()).unwrap();
        conn.execute("INSERT INTO canvas_comfyui_jobs_v1(client_id,base,digest,prompt_id,state,output_node) VALUES('image-resume',?1,?2,'original-prompt','queued','303')",rusqlite::params![DEFAULT,digest]).unwrap();
        let request=|base: &str,workflow: Value,image_sources: Vec<String>| SubmitRequest{client_task_id:"image-resume".into(),base_url:base.into(),workflow,images:vec![],image_sources,resume_only:true};
        let resumed=runtime.block_on(submit(db.path(),request(DEFAULT,graph.clone(),sources.clone()))).unwrap();
        assert_eq!(resumed.prompt_id.as_deref(),Some("original-prompt"));
        assert_eq!(runtime.block_on(submit(db.path(),request("http://127.0.0.1:8189",graph.clone(),sources.clone()))).err(),Some("comfyui-submission-binding-changed"));
        let mut modified=graph.clone();modified["306"]["inputs"]["noise_seed"]=serde_json::json!(888);
        assert_eq!(runtime.block_on(submit(db.path(),request(DEFAULT,modified,sources.clone()))).err(),Some("comfyui-submission-binding-changed"));
        assert_eq!(runtime.block_on(submit(db.path(),request(DEFAULT,graph.clone(),vec!["changed-source".into()]))).err(),Some("comfyui-submission-binding-changed"));
        assert!(reference_request_digest(&graph,&[]).is_err());
        assert!(reference_request_digest(&graph,&["x".repeat(16*1024+1)]).is_err());
        let empty_db=database();
        assert_eq!(runtime.block_on(submit(empty_db.path(),request(DEFAULT,graph,sources))).err(),Some("comfyui-task-not-found"));
        let count:i64=Connection::open(empty_db.path()).unwrap().query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='canvas_comfyui_jobs_v1'",[],|row|row.get(0)).unwrap();assert_eq!(count,0);
    }

    #[test]
    fn image_options_bind_only_reviewed_loras_and_the_seedvr_image_output() {
        let source:Value=serde_json::from_str(include_str!("../../src/core/canvas/workFisherData.json")).unwrap();
        let extra:Value=serde_json::from_str(include_str!("../../src/core/canvas/workFisherUpscaleData.json")).unwrap();
        for (kind,out,decode,lora) in [("character","241","236","240"),("scene","267","262","266")] {
            let mut graph=source[kind].clone();assert_eq!(validate_workflow(&graph).unwrap(),format!("image:{out}"));
            graph[lora]["inputs"]["strength_model"]=serde_json::json!(0);
            graph[lora]["inputs"]["lora_name"]=serde_json::json!("Synthetic.safetensors");
            graph.as_object_mut().unwrap().extend(extra.as_object().unwrap().iter().map(|(id,n)|(id.clone(),n.clone())));
            graph["234"]["inputs"]["image"]=serde_json::json!([decode,0]);graph[out]["inputs"]["images"]=serde_json::json!(["231",0]);
            assert_eq!(validate_workflow(&graph).unwrap(),format!("image:{out}"));
            for (id,key,bad) in [(out,"images",serde_json::json!([decode,0])),("233","model",serde_json::json!("unapproved.gguf")),("237","value",serde_json::json!(4097)),(lora,"lora_name",serde_json::json!("../unsafe"))] {
                let mut changed=graph.clone();changed[id]["inputs"][key]=bad;assert!(validate_workflow(&changed).is_err());
            }
        }
    }
    #[test]
    fn seedvr_requires_existing_files_not_just_downloadable_catalog_entries() {
        let clean=||Preflight{ready:true,missing_classes:vec![],missing_models:vec![],invalid_inputs:vec![],installed_unet_models:vec![],installed_lora_models:vec![]};
        let mut result=clean();check_seedvr_files(&mut result,&serde_json::json!([]));assert!(!result.ready);assert_eq!(result.missing_models.len(),2);
        let mut result=clean();check_seedvr_files(&mut result,&serde_json::json!(["seedvr2_ema_7b-Q8_0.gguf","ema_vae_fp16.safetensors"]));assert!(result.ready);
        let mut result=clean();check_seedvr_files(&mut result,&serde_json::json!({"catalog":"model names do not prove files"}));assert!(!result.ready);
    }
}
