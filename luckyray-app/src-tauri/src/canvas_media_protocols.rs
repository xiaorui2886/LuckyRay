//! Explicit media protocols. Selecting a vendor never implies its models all
//! support the same operation. Only synthetic transport tests should run in CI.
use crate::{AiImageGenerateRequest, AiImageGenerateResponse, AiVideoGenerateRequest, AiVideoGenerateResponse};
use crate::canvas_media_profiles::RuntimeProfile;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use futures_util::StreamExt;
use std::io::Write;
use std::time::Duration;
use std::path::PathBuf;
use tauri::Manager;

type Error = &'static str;
#[path = "canvas_media_options.rs"]
mod options;

pub(crate) fn easycli_base<'a>(base:&'a str,protocol:&str)->std::borrow::Cow<'a,str> {
    if protocol=="easycli-auto" {
        if let Some(root)=base.trim_end_matches('/').strip_suffix("/v1beta") {
            return std::borrow::Cow::Owned(format!("{root}/v1"));
        }
    }
    std::borrow::Cow::Borrowed(base)
}

pub(crate) fn endpoint(base: &str, route: &str, gemini: bool) -> Result<String, Error> {
    let normalized=crate::canvas_media_profiles::validated_base(base).map_err(|_|"provider_error")?;
    let mut url = reqwest::Url::parse(&normalized).map_err(|_| "provider_error")?;
    let mut path = url.path().trim_end_matches('/').to_owned();
    if gemini {
        if path.ends_with("/v1") { path.truncate(path.len()-3); }
        if !path.ends_with("/v1beta") { path.push_str("/v1beta"); }
    } else if options::twelve_host(base) && path.ends_with("/v1beta") {
        path.truncate(path.len()-7);path.push_str("/v1");
    } else if path.is_empty() { path.push_str("/v1"); }
    url.set_path(&format!("{path}/{route}"));
    Ok(url.into())
}
// Local Gemini-compatible proxies accept X-Goog-Api-Key. Keep access keys out
// of local URL/request-line logs; retain established HTTPS provider behaviour.
fn gemini_auth(request: reqwest::RequestBuilder, base: &str, key: &str) -> reqwest::RequestBuilder {
    if base.trim().to_ascii_lowercase().starts_with("http://") { request.header("x-goog-api-key", key) }
    else { request.query(&[("key", key)]) }
}
fn client() -> Result<reqwest::Client,Error> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(90)).build().map_err(|_| "provider_error")
}
// Resolve once, reject every non-public answer, then pin the checked addresses.
// This closes DNS rebinding as well as redirects/proxy credential forwarding.
fn public_provider_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v) => {
            let [a,b,c,_]=v.octets();
            !(a==0 || a==10 || a==127 || a>=224 || (a==100 && (64..=127).contains(&b))
                || (a==169 && b==254) || (a==172 && (16..=31).contains(&b))
                || (a==192 && (b==168 || b==0 || (b==2)))
                || (a==198 && (b==18 || b==19 || (b==51 && c==100)))
                || (a==203 && b==0 && c==113))
        },
        std::net::IpAddr::V6(v) => {
            let s=v.segments();
            // Only global unicast; exclude documentation, transition and mapped ranges.
            (s[0]&0xe000)==0x2000 && !(s[0]==0x2001 && (s[1]<0x200 || s[1]==0xdb8)) && s[0]!=0x2002
        },
    }
}
async fn provider_client(base: &str) -> Result<reqwest::Client,Error> {
    let normalized=crate::canvas_media_profiles::validated_base(base).map_err(|_|"unsupported_input")?;
    let url=reqwest::Url::parse(&normalized).map_err(|_|"unsupported_input")?;
    if url.scheme()=="http" { return client(); } // validator permits explicit loopback only
    let host=url.host_str().ok_or("unsupported_input")?.trim_matches(['[',']']);
    let port=url.port_or_known_default().ok_or("unsupported_input")?;
    let addresses:Vec<std::net::SocketAddr>=tokio::time::timeout(Duration::from_secs(10),tokio::net::lookup_host((host,port)))
        .await.map_err(|_|"timeout")?.map_err(|_|"connection")?.collect();
    if addresses.is_empty() || addresses.iter().any(|address|!public_provider_ip(address.ip())) {return Err("unsupported_input");}
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host,&addresses).connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90)).build().map_err(|_|"provider_error")
}

fn bigmodel_state(value:&Value,id:&str)->Result<&'static str,Error> {
    if task_id(value)?!=id {return Err("invalid_response");}
    match value.get("task_status").and_then(Value::as_str) {
        Some("PROCESSING")=>Ok("generating"), Some("SUCCESS")=>Ok("completed"),
        Some("FAIL")=>Err("provider_error"), _=>Err("invalid_response"),
    }
}
fn bigmodel_body(model:&str,prompt:&str,references:&[String],request:&AiVideoGenerateRequest)->Result<Value,Error> {
    if prompt.chars().count()>512 {return Err("bigmodel_prompt_too_long");}
    if model!="cogvideox-flash" || references.len()>1
        || request.references.iter().any(|r|r.role=="lastFrame")
        || request.duration.is_some() || request.aspect.is_some() || request.quality.is_some() || request.sound.is_some() {
        return Err("unsupported_input");
    }
    Ok(json!({"model":model,"prompt":prompt}))
}

// Read only bounded structured error identifiers. Provider messages and bodies never
// leave this boundary, even when they contain echoed prompts, URLs or credentials.
fn response_error_kind(status: reqwest::StatusCode, body: &str) -> Error {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        let error = value.get("error").unwrap_or(&value);
        for key in ["code", "type", "status"] {
            let kind = match error.get(key).and_then(Value::as_str).unwrap_or("") {
                "moderation_blocked" | "content_policy_violation" | "content_blocked" | "safety_blocked" => Some("moderation_blocked"),
                "model_not_found" | "unsupported_model" | "model_unavailable" => Some("model_unavailable"),
                "unsupported_protocol" | "unsupported_endpoint" | "method_not_allowed" => Some("unsupported_protocol"),
                "invalid_api_key" | "UNAUTHENTICATED" | "PERMISSION_DENIED" => Some("unauthorized"),
                "rate_limit_exceeded" | "RESOURCE_EXHAUSTED" => Some("rate_limited"),
                _ => None,
            };
            if let Some(kind) = kind { return kind; }
        }
    }
    match status.as_u16() {
        400 | 422 => "invalid_request",
        404 | 405 => "unsupported_protocol",
        // Service unavailable alone does not establish a rate limit. Proxies may
        // return 503 for unavailable credentials, capacity, or upstream outages.
        // Explicit RESOURCE_EXHAUSTED above still retains its rate-limit kind.
        503 => "provider_error",
        _ => crate::canvas_generation_http_error_kind(status),
    }
}
fn response_safety_blocked(value: &Value) -> bool {
    let blocked = |reason: &str| matches!(reason, "SAFETY" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "IMAGE_SAFETY" | "IMAGE_PROHIBITED_CONTENT");
    value.pointer("/promptFeedback/blockReason").and_then(Value::as_str).is_some_and(blocked)
        || value.get("candidates").and_then(Value::as_array).is_some_and(|items|
            items.iter().any(|item| item.get("finishReason").and_then(Value::as_str).is_some_and(blocked)))
}
async fn response_json(request: reqwest::RequestBuilder, limit: usize) -> Result<Value,Error> {
    response_json_observed(request,limit,None,false,&[]).await
}

// Only this four-field projection may leave the transport. Never serialize a
// reqwest error, headers, response body, provider message, prompt or credential.
#[derive(serde::Serialize)]
#[serde(rename_all="camelCase")]
struct VideoDiagnostic {
    stage: &'static str,
    http_status: Option<u16>,
    vendor_code: Option<String>,
    request_id: Option<String>,
}
impl VideoDiagnostic {
    fn new(stage:&'static str)->Self {Self{stage,http_status:None,vendor_code:None,request_id:None}}
    fn begin(&mut self,stage:&'static str) {*self=Self::new(stage);}
    fn observe(&mut self,value:&Value,sensitive:&[&str]) {
        let error=value.get("error").unwrap_or(value);
        self.vendor_code=error.get("code").and_then(|v| match v {
            Value::String(s)=>safe_diagnostic_identifier(s,64,sensitive),
            Value::Number(n)=>safe_diagnostic_identifier(&n.to_string(),64,sensitive),
            _=>None,
        });
        if let Some(id)=value.get("request_id").or_else(||error.get("request_id")).and_then(Value::as_str)
            .and_then(|s|safe_diagnostic_identifier(s,128,sensitive)) {self.request_id=Some(id);}
    }
}
fn safe_diagnostic_identifier(value:&str,max:usize,sensitive:&[&str])->Option<String> {
    if value.is_empty() || value.len()>max || value.to_ascii_lowercase().starts_with("sk-")
        || value.to_ascii_lowercase().starts_with("sk_")
        || !value.bytes().all(|b|b.is_ascii_alphanumeric() || matches!(b,b'-'|b'_'))
        || sensitive.iter().any(|secret|!secret.is_empty() && value.contains(*secret)) {return None;}
    Some(value.to_owned())
}
// BigModel's numeric business code takes precedence over HTTP 429. An unknown
// code must not become an assertion about balance, permission or concurrency.
fn bigmodel_error_kind(status:reqwest::StatusCode,value:&Value)->Error {
    let code=value.get("error").unwrap_or(value).get("code").map(|v|v.as_str().map(str::to_owned).unwrap_or_else(||v.to_string()));
    match code.as_deref() {
        Some("1113")=>"insufficient_balance",
        Some("1302")=>"account_rate_limited",
        Some("1305")=>"provider_overloaded",
        Some("1220"|"1311"|"1315")=>"permission_denied",
        Some("1309"|"1313"|"1314")=>"account_restricted",
        Some("1308"|"1310"|"1316"|"1317"|"1318"|"1319"|"1320"|"1321")=>"usage_limit",
        Some("1000"|"1001"|"1003"|"1005")=>"unauthorized",
        Some("1211")=>"model_unavailable",
        Some("1212"|"1221"|"1222")=>"unsupported_protocol",
        Some("1210"|"1213"|"1214"|"1215"|"1261")=>"invalid_request",
        Some("1301")=>"moderation_blocked",
        Some(_)=>"provider_error",
        None=>response_error_kind(status,""),
    }
}
async fn response_json_observed(request:reqwest::RequestBuilder,limit:usize,mut diagnostic:Option<&mut VideoDiagnostic>,bigmodel:bool,sensitive:&[&str])->Result<Value,Error> {
    let response = request.send().await.map_err(|e| if e.is_timeout() {"timeout"} else {"connection"})?;
    let status = response.status();
    if let Some(d)=diagnostic.as_deref_mut() {
        d.http_status=Some(status.as_u16());
        d.request_id=["x-request-id","request-id"].iter().find_map(|name|response.headers().get(*name)
            .and_then(|v|v.to_str().ok()).and_then(|s|safe_diagnostic_identifier(s,128,sensitive)));
    }
    let text = crate::read_ai_response_body_bounded(response,if status.is_success(){limit}else{crate::AI_STREAM_MAX_ERROR_BODY_BYTES},"provider_error")
        .await.map_err(|_| "invalid_response")?;
    let value=serde_json::from_str::<Value>(&text);
    if let (Some(d),Ok(value))=(diagnostic,value.as_ref()) {d.observe(value,sensitive);}
    if !status.is_success() { return Err(if bigmodel {
        value.as_ref().map(|v|bigmodel_error_kind(status,v)).unwrap_or_else(|_|response_error_kind(status,""))
    }else{response_error_kind(status,&text)}); }
    let value=value.map_err(|_|"invalid_response")?;
    if bigmodel && value.get("error").is_some() {return Err(bigmodel_error_kind(status,&value));}
    if response_safety_blocked(&value) { return Err("moderation_blocked"); }
    Ok(value)
}
fn task_id(value: &Value) -> Result<&str,Error> {
    let id = value.get("id").and_then(Value::as_str).ok_or("invalid_response")?;
    if !crate::valid_provider_task_id(id) { return Err("invalid_response"); }
    Ok(id)
}
fn task_state(value: &Value,id: &str) -> Result<&'static str,Error> {
    if task_id(value)? != id { return Err("invalid_response"); }
    match value.get("status").and_then(Value::as_str) {
        Some("completed") => Ok("completed"),
        Some("queued"|"pending") => Ok("queued"),
        Some("processing"|"in_progress") => Ok("generating"),
        Some("failed"|"cancelled"|"canceled"|"partial_completed") => Err("provider_error"),
        _ => Err("invalid_response"),
    }
}
fn result_urls(value: &Value) -> Vec<String> {
    let mut urls = Vec::new();
    if let Some(url) = value.get("output").and_then(Value::as_str) { urls.push(url.to_owned()); }
    if let Some(items) = value.get("outputs").and_then(Value::as_array) {
        urls.extend(items.iter().filter_map(Value::as_str).take(4).map(str::to_owned));
    }
    urls.into_iter().filter(|raw| raw.len()<=4096 && reqwest::Url::parse(raw).ok().is_some_and(|url|
        url.scheme()=="https" && url.username().is_empty() && url.password().is_none())).collect()
}
/// Upstream model discovery for the profile editor. Queries the provider's
/// list-models endpoint with the caller-supplied (or already-stored) key and
/// returns sanitized model IDs only — no descriptions, pricing or metadata.
/// OpenAI-compatible relays use GET {base}/models; Gemini uses
/// GET {base}/v1beta/models with the key query parameter.
pub(crate) async fn list_models(base: &str, key: &str, gemini: bool) -> Result<Vec<String>, Error> {
    let key = key.trim();
    if key.is_empty() { return Err("no_api_key"); }
    let client = provider_client(base).await?;
    let request = if gemini {
        gemini_auth(client.get(endpoint(base, "models", true)?), base, key).query(&[("pageSize", "1000")])
    } else {
        client.get(endpoint(base, "models", false)?).bearer_auth(key)
    };
    let parsed = response_json(request, 2 * 1024 * 1024).await?;
    let mut ids: Vec<String> = Vec::new();
    if let Some(items) = parsed.get("data").and_then(Value::as_array) {
        for item in items {
            if let Some(id) = item.get("id").and_then(Value::as_str) {
                if safe_model(id) { ids.push(id.to_owned()); }
            }
        }
    } else if let Some(items) = parsed.get("models").and_then(Value::as_array) {
        for item in items {
            if let Some(name) = item.get("name").and_then(Value::as_str) {
                // Gemini names arrive as "models/{id}"; store the bare id the
                // generation call expects.
                let id = name.strip_prefix("models/").unwrap_or(name);
                if safe_model(id) { ids.push(id.to_owned()); }
            }
        }
    }
    ids.sort();
    ids.dedup();
    if ids.is_empty() { return Err("empty_response"); }
    ids.truncate(500);
    Ok(ids)
}

fn safe_model(model: &str) -> bool {
    !model.is_empty() && model.len() <= 128 && !model.chars().any(char::is_control)
}
async fn download_video_content(client: &reqwest::Client,base: &str,id: &str,key: &str,dir: &PathBuf,cancelled: &(dyn Fn()->bool+Send+Sync)) -> Result<String,Error> {
    // The key is sent only to the explicitly configured same-origin endpoint.
    // Redirects are disabled; public result URLs use the unauthenticated safe downloader.
    let response=client.get(endpoint(base,&format!("videos/{id}/content"),false)?).bearer_auth(key).send().await.map_err(|_|"connection")?;
    if !response.status().is_success(){return Err(crate::canvas_generation_http_error_kind(response.status()));}
    if response.content_length().is_some_and(|n|n==0||n>crate::CANVAS_GENERATION_MAX_VIDEO_BYTES as u64){return Err("invalid_response");}
    let mime=response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v|v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim();
    if !matches!(mime,"video/mp4"|"application/octet-stream"){return Err("invalid_response");}
    std::fs::create_dir_all(dir).map_err(|_|"provider_error")?;
    let name=format!("canvas-video-{:032x}.mp4",rand::random::<u128>());
    let final_path=dir.join(&name);let partial=dir.join(format!("{name}.part"));
    let result=async {
        let mut file=std::fs::OpenOptions::new().create_new(true).write(true).open(&partial).map_err(|_|"provider_error")?;
        let mut stream=response.bytes_stream();let mut total=0usize;let mut prefix=Vec::new();
        while let Some(chunk)=stream.next().await {
            if cancelled(){return Err("cancelled");}
            let chunk=chunk.map_err(|_|"connection")?;
            total=total.checked_add(chunk.len()).filter(|n|*n<=crate::CANVAS_GENERATION_MAX_VIDEO_BYTES).ok_or("invalid_response")?;
            if prefix.len()<16 {prefix.extend_from_slice(&chunk[..chunk.len().min(16-prefix.len())]);}
            file.write_all(&chunk).map_err(|_|"provider_error")?;
        }
        if total==0||prefix.len()<8||&prefix[4..8]!=b"ftyp"{return Err("invalid_response");}
        file.sync_all().map_err(|_|"provider_error")?;drop(file);
        if cancelled(){return Err("cancelled");}
        std::fs::rename(&partial,&final_path).map_err(|_|"provider_error")?;
        Ok(final_path.to_string_lossy().into_owned())
    }.await;
    if result.is_err(){let _=std::fs::remove_file(partial);}
    result
}
async fn reference_bytes(raw: String) -> Result<(Vec<u8>,String,&'static str),Error> {
    tokio::task::spawn_blocking(move || crate::materialize_canvas_image_bytes(&raw,&||false))
        .await.map_err(|_| "unsupported_input")?.map_err(|_| "unsupported_input")
}
async fn image_multipart(fields: &[(&str,String)], references: &[String], file_field: &str) -> Result<(String,Vec<u8>),Error> {
    // Fixed field names and filenames; prompt bytes remain body data, never headers.
    let boundary=format!("luckyray-{:032x}",rand::random::<u128>());
    let mut body=Vec::new();
    for (name,value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    for (i,raw) in references.iter().enumerate() {
        let (bytes,mime,ext)=reference_bytes(raw.clone()).await?;
        if body.len().saturating_add(bytes.len()) > crate::CANVAS_GENERATION_MAX_RESPONSE_BYTES { return Err("unsupported_input"); }
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"reference-{i}.{ext}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
        body.extend_from_slice(&bytes);body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok((format!("multipart/form-data; boundary={boundary}"),body))
}

pub(crate) async fn image(request: &AiImageGenerateRequest,config: &RuntimeProfile,cancelled: &(dyn Fn()->bool+Send+Sync)) -> AiImageGenerateResponse {
    match image_inner(request,config,cancelled).await {
        Ok(images) => AiImageGenerateResponse {success:true,images,error_kind:None,error_message:None,error_detail:None},
        Err(error) => crate::ai_image_failure(error),
    }
}
async fn image_inner(request: &AiImageGenerateRequest,config: &RuntimeProfile,cancelled: &(dyn Fn()->bool+Send+Sync)) -> Result<Vec<crate::AiGeneratedImage>,Error> {
    let model=if request.model.trim().is_empty(){config.profile.image_model.trim()}else{request.model.trim()};
    let prompt=request.prompt.trim();
    if !safe_model(model) || prompt.is_empty() || prompt.len()>crate::CANVAS_GENERATION_MAX_PROMPT_BYTES { return Err("unsupported_input"); }
    let references=crate::ordered_canvas_image_references(&request.references).ok_or("unsupported_input")?;
    let client=provider_client(&config.profile.base_url).await?;
    // A single EasyCLI connection accepts either advertised base URL; retain any
    // reverse-proxy prefix and never change the configured origin or credentials.
    let easy_base=easycli_base(&config.profile.base_url,&config.profile.image_protocol);
    let base=easy_base.as_ref();
    let protocol=options::image_protocol(base,model,config.profile.image_protocol.as_str());
    if protocol=="easycli-auto" {return Err("unsupported_model_protocol");}
    let native_spec=options::native_spec(model,protocol);
    if request.resolution.is_some() && !(matches!(protocol,"openai-image"|"12ai-task") && options::spec(model).is_some_and(|v|v["family"]=="gpt") && (protocol=="12ai-task"||options::twelve_host(base))) && !native_spec.is_some_and(|s|s.get("resolutions").is_some()) {return Err("unsupported_input");}
    let key=crate::normalize_ai_api_key(&config.api_key);
    if key.is_empty(){return Err("no_api_key");}
    let mut gemini=false;
    let pending = match protocol {
        "openai-image" => {
            let aspect=request.aspect.as_deref().unwrap_or("1:1");
            let mut size=match aspect {"7:4" if model.contains("dall-e-3")=>"1792x1024","4:7" if model.contains("dall-e-3")=>"1024x1792","3:2"=>if model.contains("dall-e-3"){"1792x1024"}else{"1536x1024"},"2:3"=>if model.contains("dall-e-3"){"1024x1792"}else{"1024x1536"},_=>crate::canvas_image_size(model,Some(aspect))}.to_owned();
            let mut quality=match request.quality.as_deref(){Some("low"|"标准")=>"low",Some("高清"|"超清"|"high"|"hd")=>"high",_=>"medium"}.to_owned();
            if options::twelve_host(base) && options::spec(model).is_some_and(|v|v["family"]=="gpt") {
                let selected=options::image_options_with_resolution(model,request.aspect.as_deref(),request.quality.as_deref(),request.resolution.as_deref(),false)?;
                size=selected["size"].as_str().ok_or("unsupported_input")?.to_owned();
                quality=selected["quality"].as_str().ok_or("unsupported_input")?.to_owned();
            } else if native_spec.is_some() {
                let selected=options::native_image_options(model,protocol,request.aspect.as_deref(),request.quality.as_deref(),request.resolution.as_deref())?;
                size=selected["size"].as_str().ok_or("unsupported_input")?.to_owned();
                quality=selected["quality"].as_str().ok_or("unsupported_input")?.to_owned();
            }
            // Build once from the original user prompt for both generation and
            // edit requests. Keep structured controls and stored prompt unchanged.
            let reinforced_prompt=options::easycli_image_prompt(prompt,&config.profile.image_protocol,model,request.aspect.as_deref(),&size);
            let prompt=reinforced_prompt.as_ref();
            if references.is_empty() {
                let mut body=json!({"model":model,"prompt":prompt,"n":request.count.unwrap_or(1).clamp(1,4)});
                if native_spec.is_some() || options::spec(model).is_some() || model.starts_with("gpt-image") || model.starts_with("dall-e-") || request.aspect.is_some() {body["size"]=json!(size);}
                if base.starts_with("http://") && !(model.starts_with("gpt-image") || native_spec.is_some_and(|s|s["family"]=="gpt")) {body["response_format"]=json!("b64_json");}
                if model.starts_with("gpt-image") || native_spec.is_some_and(|s|s["family"]=="gpt") {body["quality"]=json!(quality);}
                if model.contains("dall-e-3") {body["n"]=json!(1);body["quality"]=json!(if quality=="high"{"hd"}else{"standard"});}
                client.post(endpoint(base,"images/generations",false)?).bearer_auth(&key).json(&body)
            } else {
                let mut fields=vec![("model",model.to_owned()),("prompt",prompt.to_owned()),("n",request.count.unwrap_or(1).clamp(1,4).to_string())];
                if native_spec.is_some() || options::spec(model).is_some() || model.starts_with("gpt-image") || model.starts_with("dall-e-") || request.aspect.is_some() {fields.push(("size",size));}
                if base.starts_with("http://") && !(model.starts_with("gpt-image") || native_spec.is_some_and(|s|s["family"]=="gpt")) {fields.push(("response_format","b64_json".to_owned()));}
                if model.starts_with("gpt-image") || native_spec.is_some_and(|s|s["family"]=="gpt"){fields.push(("quality",quality.to_owned()));}
                let (mime,body)=image_multipart(&fields,&references,"image[]").await?;
                client.post(endpoint(base,"images/edits",false)?).bearer_auth(&key).header("Content-Type",mime).body(body)
            }
        },
        "gemini-image" => {
            let route=options::gemini_model_route(model)?;
            gemini=true;
            if request.count.unwrap_or(1)!=1{return Err("unsupported_input");}
            let mut parts=vec![json!({"text":prompt})];
            for raw in &references {let (bytes,mime,_)=reference_bytes(raw.clone()).await?;parts.push(json!({"inlineData":{"mimeType":mime,"data":STANDARD.encode(bytes)}}));}
            let size=match request.quality.as_deref(){Some("4K"|"超清")=>"4K",Some("2K"|"高清")=>"2K",_=>"1K"};
            let mut image_config=json!({"aspectRatio":request.aspect.as_deref().unwrap_or("1:1")});
            if !model.contains("gemini-2.5"){image_config["imageSize"]=json!(size);}
            if options::twelve_host(base) && options::spec(model).is_some_and(|v|v["family"]=="gemini"){
                let selected=options::spec(model).ok_or("unsupported_input")?;
                if references.len()>selected["maxReferences"].as_u64().unwrap_or(0)as usize{return Err("unsupported_input");}
                image_config=options::image_options_with_resolution(model,request.aspect.as_deref(),request.quality.as_deref(),request.resolution.as_deref(),false)?;
            } else if native_spec.is_some() {
                image_config=options::native_image_options(model,protocol,request.aspect.as_deref(),request.quality.as_deref(),request.resolution.as_deref())?;
            }
            let body=json!({"contents":[{"parts":parts}],"generationConfig":{"responseModalities":["IMAGE"],"imageConfig":image_config}});
            gemini_auth(client.post(endpoint(base,&route,true)?),base,&key).json(&body)
        },
        "12ai-task" => {
            if request.count.unwrap_or(1)!=1{return Err("unsupported_input");}
            let mut input=if options::spec(model).is_some_and(|v|v["kind"]=="image"){
                options::image_options_with_resolution(model,request.aspect.as_deref(),request.quality.as_deref(),request.resolution.as_deref(),true)?
            }else{
                if !references.is_empty()||request.aspect.is_some()||request.quality.is_some(){return Err("unsupported_input");}
                json!({})
            };
            input["prompt"]=json!(prompt);
            if !references.is_empty(){
                if options::spec(model).and_then(|v|v["maxReferences"].as_u64()).is_some_and(|max|references.len()>max as usize){return Err("unsupported_input");}
                let mut images=Vec::new();let mut total=0usize;
                for raw in references{let (bytes,mime,_)=reference_bytes(raw).await?;let encoded=format!("data:{mime};base64,{}",STANDARD.encode(bytes));total=total.saturating_add(encoded.len());if total>crate::CANVAS_GENERATION_MAX_RESPONSE_BYTES{return Err("unsupported_input");}images.push(encoded);}
                input["images"]=json!(images);
            }
            client.post(endpoint(base,"task/submit",false)?).bearer_auth(&key).json(&json!({"model":model,"input":input}))
        },
        _=>return Err("unsupported_input"),
    };
    if cancelled(){return Err("cancelled");}
    let mut parsed=response_json(pending,crate::CANVAS_GENERATION_MAX_RESPONSE_BYTES).await?;
    if protocol=="12ai-task" {
        let id=task_id(&parsed)?.to_owned();
        if parsed.get("status").is_none(){parsed=json!({"id":&id,"status":"queued"});}
        let deadline=tokio::time::Instant::now()+Duration::from_secs(600);
        loop {
            if cancelled(){return Err("cancelled");}
            if task_state(&parsed,&id)?=="completed" {break;}
            if tokio::time::Instant::now()>=deadline{return Err("timeout");}
            tokio::time::sleep(Duration::from_secs(5)).await;
            parsed=response_json(client.get(endpoint(base,&format!("task/{id}"),false)?).bearer_auth(&key),crate::CANVAS_GENERATION_MAX_POLL_BYTES).await?;
        }
        let images=result_urls(&parsed).into_iter().map(|url|crate::AiGeneratedImage{url,thumbnail_url:None}).collect::<Vec<_>>();
        return if images.is_empty(){Err("empty_response")}else{Ok(images)};
    }
    if cancelled(){return Err("cancelled");}
    let images=if gemini {
        parsed.get("candidates").and_then(Value::as_array).into_iter().flatten()
            .filter_map(|v|v.get("content").and_then(|v|v.get("parts")).and_then(Value::as_array)).flatten()
            .filter_map(|part|part.get("inlineData")).filter_map(|data| {
                let mime=data.get("mimeType")?.as_str()?;
                let encoded=data.get("data")?.as_str()?;
                if !matches!(mime,"image/png"|"image/jpeg"|"image/webp") || encoded.len()>crate::CANVAS_GENERATION_MAX_RESPONSE_BYTES {return None;}
                Some(crate::AiGeneratedImage{url:format!("data:{mime};base64,{encoded}"),thumbnail_url:None})
            }).take(4).collect()
    } else {
        let mut images=crate::extract_canvas_generated_images(&parsed);
        for image in &mut images {
            if let Some(encoded)=image.url.strip_prefix("data:image/png;base64,") {
                let bytes=STANDARD.decode(encoded).map_err(|_|"invalid_response")?;
                let mime=if bytes.starts_with(b"\x89PNG\r\n\x1a\n"){"image/png"}
                    else if bytes.starts_with(&[0xff,0xd8,0xff]){"image/jpeg"}
                    else if bytes.len()>=12 && &bytes[..4]==b"RIFF" && &bytes[8..12]==b"WEBP"{"image/webp"}
                    else{return Err("invalid_response")};
                image.url=format!("data:{mime};base64,{encoded}");
            }
        }
        images
    };
    if images.iter().any(|image|image.url.starts_with("http://")){return Err("unsupported_input");}
    if images.is_empty(){Err("empty_response")}else{Ok(images)}
}

// Durable task identity only. Never persist prompts, URLs, credentials or provider JSON.
struct SubmissionLedger { marker: PathBuf, task: PathBuf, fingerprint: String, resume_fingerprint: String }
impl SubmissionLedger {
    fn read_bounded(path:&std::path::Path)->std::io::Result<Vec<u8>> {
        use std::io::Read;
        let file=std::fs::File::open(path)?;
        let mut bytes=Vec::new();file.take(257).read_to_end(&mut bytes)?;
        Ok(bytes)
    }
    fn sync_directory(&self)->Result<(),Error> {
        #[cfg(unix)]
        {std::fs::File::open(self.marker.parent().ok_or("provider_error")?).and_then(|f|f.sync_all()).map_err(|_|"provider_error")?;}
        Ok(())
    }
    fn new(root:&std::path::Path, client_id:&str, profile:&crate::canvas_media_profiles::Profile, request:&AiVideoGenerateRequest)->Result<Self,Error> {
        use sha2::{Digest,Sha256};
        if !crate::valid_provider_task_id(client_id) {return Err("unsupported_input");}
        let mut binding=json!({"profile":profile.id,"revision":profile.revision,"base":profile.base_url,"protocol":profile.video_protocol,"model":if request.model.trim().is_empty(){profile.video_model.as_str()}else{request.model.as_str()},"prompt":request.prompt,
            "aspect":request.aspect,"duration":request.duration,"quality":request.quality,"sound":request.sound,
            "references":request.references.iter().map(|r|json!({"role":r.role,"url":r.media_url})).collect::<Vec<_>>()});
        let fingerprint=format!("{:x}",Sha256::digest(binding.to_string().as_bytes()));
        binding.as_object_mut().ok_or("provider_error")?.remove("references");
        let resume_fingerprint=format!("{:x}",Sha256::digest(binding.to_string().as_bytes()));
        let hash=format!("{:x}",Sha256::digest(client_id.as_bytes()));
        std::fs::create_dir_all(root).map_err(|_|"provider_error")?;
        Ok(Self{marker:root.join(format!("{hash}.pending")),task:root.join(format!("{hash}.id")),fingerprint,resume_fingerprint})
    }
    fn recover(&self)->Result<Option<String>,Error> {
        for path in [&self.marker,&self.task] {
            match std::fs::symlink_metadata(path) {
                Ok(meta) if !meta.is_file() || meta.len()>256=>return Err("submission_unknown"),
                Ok(_)=>{}, Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{}, Err(_)=>return Err("provider_error"),
            }
        }
        match Self::read_bounded(&self.marker) {
            Ok(bytes) if bytes==format!("{}\n{}",self.fingerprint,self.resume_fingerprint).as_bytes()=>{},
            // References are not uploaded again for an already-created task; paths
            // may have disappeared since creation. Every other immutable field stays bound.
            Ok(bytes) if self.task.try_exists().map_err(|_|"provider_error")? && bytes.get(65..)==Some(self.resume_fingerprint.as_bytes())=>{},
            Ok(_)=>return Err("submission_binding_changed"),
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{
                if self.task.try_exists().map_err(|_|"provider_error")? {return Err("submission_unknown");}
            },
            Err(_)=>return Err("provider_error"),
        }
        match Self::read_bounded(&self.task) {
            Ok(bytes)=>{
                if bytes.len()>256 {return Err("submission_unknown");}
                let id=String::from_utf8(bytes).map_err(|_|"submission_unknown")?;
                if !crate::valid_provider_task_id(&id){return Err("submission_unknown");}
                Ok(Some(id))
            },
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{
                if self.marker.try_exists().map_err(|_|"provider_error")? {Err("submission_unknown")}else{Ok(None)}
            },
            Err(_)=>Err("provider_error"),
        }
    }
    fn begin(&self)->Result<(),Error> {
        let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&self.marker)
            .map_err(|e|if e.kind()==std::io::ErrorKind::AlreadyExists{"submission_unknown"}else{"provider_error"})?;
        file.write_all(format!("{}\n{}",self.fingerprint,self.resume_fingerprint).as_bytes()).map_err(|_|"provider_error")?;
        file.sync_all().map_err(|_|"provider_error")?;
        self.sync_directory()
    }
    fn record(&self,id:&str)->Result<(),Error> {
        if !crate::valid_provider_task_id(id){return Err("invalid_response");}
        let temp=self.task.with_extension(format!("{}.tmp",rand::random::<u128>()));
        let result=(||{
            let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|_|"provider_error")?;
            file.write_all(id.as_bytes()).map_err(|_|"provider_error")?;
            file.sync_all().map_err(|_|"provider_error")?;drop(file);
            std::fs::rename(&temp,&self.task).map_err(|_|"provider_error")?;
            self.sync_directory()
        })();
        if result.is_err(){let _=std::fs::remove_file(temp);}
        result
    }
}

pub(crate) async fn video(app: &tauri::AppHandle,request: &AiVideoGenerateRequest,config: &RuntimeProfile,cancelled: &(dyn Fn()->bool+Send+Sync)) -> AiVideoGenerateResponse {
    let mut diagnostic=VideoDiagnostic::new("prepare");
    match video_inner(app,request,config,cancelled,&mut diagnostic).await {
        Ok(url)=>AiVideoGenerateResponse{success:true,video_url:Some(url),thumbnail_url:None,error_kind:None,error_message:None,error_detail:None},
        Err(error)=>{
            let mut failure=crate::ai_video_failure(error);
            failure.error_detail=serde_json::to_string(&diagnostic).ok();failure
        },
    }
}
async fn video_inner(app: &tauri::AppHandle,request: &AiVideoGenerateRequest,config: &RuntimeProfile,cancelled: &(dyn Fn()->bool+Send+Sync),diagnostic:&mut VideoDiagnostic) -> Result<String,Error> {
    let model=if request.model.trim().is_empty(){config.profile.video_model.trim()}else{request.model.trim()};
    let prompt=request.prompt.trim();
    if !safe_model(model)||prompt.is_empty()||prompt.len()>crate::CANVAS_GENERATION_MAX_PROMPT_BYTES{return Err("unsupported_input");}
    let protocol=config.profile.video_protocol.as_str();
    if !matches!(protocol,"openai-video"|"12ai-task"|"bigmodel-video"){return Err("unsupported_input");}
    let base=&config.profile.base_url;let client=provider_client(base).await?;let key=crate::normalize_ai_api_key(&config.api_key);
    if key.is_empty(){return Err("no_api_key");}
    let client_id=request.client_task_id.as_deref().ok_or("stable_task_id_required")?;
    let ledger=SubmissionLedger::new(&app.path().app_data_dir().map_err(|_|"provider_error")?.join("canvas/provider-submissions"),client_id,&config.profile,request)?;
    let supplied=request.provider_task_id.as_deref().filter(|s|!s.is_empty());
    // An explicitly saved ID can repair the crash window between progress and disk sync.
    let recovered=match ledger.recover(){Ok(value)=>value,Err("submission_unknown") if supplied.is_some() && !ledger.task.try_exists().map_err(|_|"provider_error")?=>None,Err(error)=>return Err(error)};
    if supplied.zip(recovered.as_deref()).is_some_and(|(a,b)|a!=b){return Err("unsupported_input");}
    let resume=supplied.or(recovered.as_deref());
    let references=if resume.is_some(){Vec::new()}else{crate::ordered_canvas_image_references(&request.references).ok_or("unsupported_input")?};
    let mut parsed;
    let id=if let Some(id)=resume {
        if !crate::valid_provider_task_id(id){return Err("unsupported_input");}
        if recovered.is_none() {
            if !ledger.marker.try_exists().map_err(|_|"provider_error")? {ledger.begin()?;}
            ledger.record(id)?;
        }
        parsed=if protocol=="bigmodel-video"{json!({"id":id,"task_status":"PROCESSING"})}else{json!({"id":id,"status":"queued"})};id.to_owned()
    }else{
        let duration=request.duration.unwrap_or(if protocol=="openai-video"{8}else{5});
        let aspect=request.aspect.as_deref().unwrap_or("16:9");
        let builder=if protocol=="bigmodel-video" {
            let mut body=bigmodel_body(model,prompt,&references,request)?;
            if let Some(raw)=references.first() {
                let (bytes,mime,_)=reference_bytes(raw.clone()).await?;
                if bytes.len()>5*1024*1024 || !matches!(mime.as_str(),"image/png"|"image/jpeg") {return Err("bigmodel_reference_invalid");}
                body["image_url"]=json!(format!("data:{mime};base64,{}",STANDARD.encode(bytes)));
            }
            client.post(endpoint(base,"videos/generations",false)?).bearer_auth(&key).json(&body)
        }else if protocol=="openai-video" {
            if !matches!(duration,4|8|12)||!matches!(aspect,"16:9"|"9:16")||references.len()>1||request.references.iter().any(|r|r.role=="lastFrame")||request.quality.as_deref().is_some_and(|v|v!="720p")||request.sound.is_some(){return Err("unsupported_input");}
            let size=if aspect=="9:16"{"720x1280"}else{"1280x720"};
            // The compatibility contract uses multipart even for text-only input.
            // Never retry a create with an alternate encoding after a failed response.
            let fields=vec![("model",model.to_owned()),("prompt",prompt.to_owned()),("seconds",duration.to_string()),("size",size.into())];
            let (mime,body)=image_multipart(&fields,&references,"input_reference").await?;
            client.post(endpoint(base,"videos",false)?).bearer_auth(&key).header("Content-Type",mime).body(body)
        }else{
            let input=if options::spec(model).is_some_and(|v|v["kind"]=="video"){
                let refs=request.references.iter().map(|r|r.media_url.as_deref().map(|url|(r.role.as_str(),url)).ok_or("unsupported_input")).collect::<Result<Vec<_>,Error>>()?;
                options::video_options(model,prompt,request.aspect.as_deref(),request.quality.as_deref(),request.duration.map(|n|n as u64),request.sound,&refs)?
            }else{
                if !references.is_empty()||request.duration.is_some()||request.aspect.is_some()||request.quality.is_some()||request.sound.is_some(){return Err("unsupported_input");}
                json!({"prompt":prompt})
            };
            client.post(endpoint(base,"task/submit",false)?).bearer_auth(&key).json(&json!({"model":model,"input":input}))
        };
        if cancelled(){return Err("cancelled");}
        ledger.begin()?;
        diagnostic.begin("submit");
        crate::emit_canvas_video_progress(app,request.client_task_id.as_deref(),None,"submitting",None);
        parsed=match response_json_observed(builder,crate::CANVAS_GENERATION_MAX_POLL_BYTES,Some(diagnostic),protocol=="bigmodel-video",&[&key,prompt]).await {
            Ok(value)=>value,
            Err(error) if matches!(error,"unauthorized"|"invalid_request"|"unsupported_protocol"|"model_unavailable"|"moderation_blocked"|"rate_limited"|"insufficient_balance"|"account_rate_limited"|"provider_overloaded"|"permission_denied"|"account_restricted"|"usage_limit")=>{
                std::fs::remove_file(&ledger.marker).map_err(|_|"provider_error")?;return Err(error);
            },
            // A structured but unknown provider rejection is reported as unknown,
            // and keeps the pending ledger to forbid a blind duplicate POST.
            Err("provider_error") if diagnostic.vendor_code.is_some()=>return Err("provider_error"),
            Err(_)=>return Err("submission_unknown"),
        };
        let id=task_id(&parsed).map_err(|_|"submission_unknown")?.to_owned();
        ledger.record(&id)?;
        id
    };
    if protocol!="bigmodel-video" && parsed.get("status").is_none(){parsed=json!({"id":&id,"status":"queued"});}
    crate::emit_canvas_video_progress(app,request.client_task_id.as_deref(),Some(&id),"queued",Some(0));
    let deadline=tokio::time::Instant::now()+Duration::from_secs(600);
    loop {
        if cancelled(){return Err("cancelled");}
        let state=if protocol=="bigmodel-video"{
            if task_id(&parsed)?!=id {return Err("invalid_response");}
            if parsed.get("task_status").and_then(Value::as_str)==Some("FAIL") {
                return Err(bigmodel_error_kind(reqwest::StatusCode::OK,&parsed));
            }
            bigmodel_state(&parsed,&id)?
        }else{task_state(&parsed,&id)?};
        if state=="completed"{break;}
        crate::emit_canvas_video_progress(app,request.client_task_id.as_deref(),Some(&id),state,parsed.get("progress").and_then(Value::as_u64).map(|n|n.min(100)));
        if tokio::time::Instant::now()>=deadline{return Err("timeout");}
        tokio::time::sleep(Duration::from_secs(5)).await;
        let route=format!("{}/{}",if protocol=="openai-video"{"videos"}else if protocol=="bigmodel-video"{"async-result"}else{"task"},id);
        diagnostic.begin("poll");
        parsed=response_json_observed(client.get(endpoint(base,&route,false)?).bearer_auth(&key),crate::CANVAS_GENERATION_MAX_POLL_BYTES,Some(diagnostic),protocol=="bigmodel-video",&[&key,prompt]).await?;
    }
    let output_dir=app.path().app_data_dir().map_err(|_|"provider_error")?.join("canvas/generated-videos");
    crate::emit_canvas_video_progress(app,request.client_task_id.as_deref(),Some(&id),"downloading",Some(99));
    diagnostic.begin("download");
    let projected=if protocol=="bigmodel-video" {
        let items=parsed.get("video_result").and_then(Value::as_array).ok_or("invalid_response")?;
        let urls:Vec<Value>=items.iter().take(4).filter_map(|item|item.get("url").cloned()).collect();
        result_urls(&json!({"outputs":urls}))
    }else{result_urls(&parsed)};
    let url=match projected.into_iter().next() {
        Some(url)=>url,
        None if protocol=="openai-video"=>return download_video_content(&client,base,&id,&key,&output_dir,cancelled).await,
        None=>return Err("invalid_response"),
    };
    let path=tokio::task::spawn_blocking(move||crate::materialize_canvas_video_with_client(
        &crate::web_tools::SafeHttpClient::production(Duration::from_secs(30)),&url,&output_dir,crate::CANVAS_GENERATION_MAX_VIDEO_BYTES,
        std::time::Instant::now()+Duration::from_secs(crate::CANVAS_GENERATION_VIDEO_DOWNLOAD_SECONDS)))
        .await.map_err(|_|"provider_error")?.map_err(|_|"connection")?;
    if cancelled(){let _=std::fs::remove_file(&path);return Err("cancelled");}
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    #[test]
    fn business_codes_disambiguate_same_http_429_and_keep_unknown_unknown() {
        for (code,kind) in [("1113","insufficient_balance"),("1302","account_rate_limited"),("1305","provider_overloaded"),
            ("1220","permission_denied"),("1311","permission_denied"),("1315","permission_denied"),
            ("1313","account_restricted"),("1308","usage_limit"),("9999","provider_error")] {
            assert_eq!(bigmodel_error_kind(reqwest::StatusCode::TOO_MANY_REQUESTS,&json!({"error":{"code":code,"message":"do not persist this"}})),kind);
        }
        assert_eq!(bigmodel_error_kind(reqwest::StatusCode::TOO_MANY_REQUESTS,&json!({})),"rate_limited");
        assert_eq!(bigmodel_error_kind(reqwest::StatusCode::FORBIDDEN,&json!({"error":{"code":"not-known"}})),"provider_error");
        assert_eq!(bigmodel_error_kind(reqwest::StatusCode::TOO_MANY_REQUESTS,&json!({"error":{"code":1305}})),"provider_overloaded");
    }
    #[test]
    fn four_fields_only_with_untrusted_prose_credentials_and_headers_excluded() {
        let mut d=VideoDiagnostic::new("submit");d.http_status=Some(429);
        d.observe(&json!({"request_id":"req-synthetic-42","error":{"code":"1302","message":"synthetic private content","key":"TEST_SECRET"},"headers":{"authorization":"TEST_SECRET"}}),&["TEST_SECRET","synthetic private content"]);
        assert_eq!(serde_json::to_value(&d).unwrap(),json!({"stage":"submit","httpStatus":429,"vendorCode":"1302","requestId":"req-synthetic-42"}));
        d.observe(&json!({"request_id":"TEST_SECRET","error":{"code":"synthetic-private-prompt"}}),&["TEST_SECRET","synthetic-private-prompt"]);
        assert_eq!(d.vendor_code,None);
        // A rejected body identifier never replaces a previously checked header ID.
        assert_eq!(d.request_id.as_deref(),Some("req-synthetic-42"));
        for value in ["Bearer SECRET","secret.key.token","https://secret.invalid/","sk-secret","sk_secret","private\ntext",""] {
            assert!(safe_diagnostic_identifier(value,128,&[]).is_none());
        }
        assert!(safe_diagnostic_identifier(&"x".repeat(129),128,&[]).is_none());
    }
    #[test]
    fn stage_reset_cannot_attribute_an_earlier_http_status_to_a_network_failure() {
        let mut d=VideoDiagnostic::new("submit");d.http_status=Some(200);d.vendor_code=Some("1302".into());d.request_id=Some("req-old".into());
        d.begin("poll");assert_eq!(serde_json::to_value(d).unwrap(),json!({"stage":"poll","httpStatus":null,"vendorCode":null,"requestId":null}));
    }
    #[tokio::test]
    async fn actual_mock_http_collects_only_safe_diagnostics_and_never_retries_post() {
        use std::io::{Read,Write};
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let port=listener.local_addr().unwrap().port();
        let worker=std::thread::spawn(move||{
            let(mut socket,_)=listener.accept().unwrap();let mut bytes=[0u8;8192];let n=socket.read(&mut bytes).unwrap();
            assert!(std::str::from_utf8(&bytes[..n]).unwrap().starts_with("POST /videos/generations "));
            let body=r#"{"error":{"code":"1305","message":"private synthetic prompt and TEST_SECRET"},"request_id":"req-synthetic-42","key":"TEST_SECRET"}"#;
            write!(socket,"HTTP/1.1 429 Too Many Requests\r\nx-request-id: req-header-42\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",body.len(),body).unwrap();
            listener.set_nonblocking(true).unwrap();assert!(listener.accept().is_err());
        });
        let mut d=VideoDiagnostic::new("submit");
        let result=response_json_observed(client().unwrap().post(format!("http://127.0.0.1:{port}/videos/generations")).bearer_auth("TEST_SECRET").json(&json!({"prompt":"private synthetic prompt"})),8192,Some(&mut d),true,&["TEST_SECRET","private synthetic prompt"]).await;
        assert_eq!(result.unwrap_err(),"provider_overloaded");worker.join().unwrap();
        assert_eq!(serde_json::to_value(&d).unwrap(),json!({"stage":"submit","httpStatus":429,"vendorCode":"1305","requestId":"req-synthetic-42"}));
        let serialized=serde_json::to_string(&d).unwrap();assert!(!serialized.contains("TEST_SECRET")&&!serialized.contains("private synthetic")&&!serialized.contains("headers"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn explicit_local_models_route_uses_selected_prefix_and_no_redirect() {
        use std::io::{Read,Write};
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port=listener.local_addr().unwrap().port();
        let server=std::thread::spawn(move||{
            let(mut socket,_)=listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut bytes=Vec::new();let mut chunk=[0u8;512];
            while !bytes.windows(4).any(|w|w==b"\r\n\r\n") { let n=socket.read(&mut chunk).unwrap();if n==0{break;}bytes.extend_from_slice(&chunk[..n]);if bytes.len()>8192{panic!("oversized test request");} }
            let request=String::from_utf8(bytes).unwrap();assert!(request.starts_with("GET /custom/v1/models "));assert!(request.to_ascii_lowercase().contains("authorization: bearer synthetic-local-key"));
            let body=r#"{"data":[{"id":"local-test-image"}]}"#;
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        let models=list_models(&format!("http://127.0.0.1:{port}/custom/v1"),"synthetic-local-key",false).await.unwrap();
        assert_eq!(models,vec!["local-test-image"]);server.join().unwrap();
        assert!(endpoint("http://192.168.1.1:8317/v1","models",false).is_err());
        assert_eq!(endpoint("http://localhost:8317/openai/v1","videos",false).unwrap(),"http://127.0.0.1:8317/openai/v1/videos");
    }
    #[test]
    fn local_gemini_request_uses_native_route_and_header_without_key_in_url() {
        let base="http://127.0.0.1:8317/v1";
        let url=endpoint(base,"models/gemini-3.1-flash-image:generateContent",true).unwrap();
        assert_eq!(url,"http://127.0.0.1:8317/v1beta/models/gemini-3.1-flash-image:generateContent");
        let request=gemini_auth(client().unwrap().post(&url),base,"synthetic-local-key")
            .json(&json!({"contents":[{"parts":[{"text":"Synthetic image"}]}],"generationConfig":{"responseModalities":["IMAGE"],"imageConfig":{"aspectRatio":"16:9","imageSize":"2K"}}})).build().unwrap();
        assert_eq!(request.headers().get("x-goog-api-key").unwrap(),"synthetic-local-key");
        assert!(request.url().query().is_none());
        assert!(!request.url().as_str().contains("synthetic-local-key"));
        let spaced=gemini_auth(client().unwrap().get(endpoint(" http://127.0.0.1:8317/v1 ","models",true).unwrap())," http://127.0.0.1:8317/v1 ","synthetic-local-key").build().unwrap();
        assert!(spaced.url().query().is_none());
        assert_eq!(spaced.headers().get("x-goog-api-key").unwrap(),"synthetic-local-key");
        assert_eq!(endpoint("http://127.0.0.1:8317/v1beta","models",true).unwrap(),"http://127.0.0.1:8317/v1beta/models");
        assert!(endpoint("http://192.168.1.2:8317/v1","models",true).is_err());
    }
    #[tokio::test]
    async fn local_gemini_model_discovery_native_shape_and_auth() {
        use std::io::{Read,Write};
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port=listener.local_addr().unwrap().port();
        let server=std::thread::spawn(move||{
            let(mut socket,_)=listener.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut bytes=Vec::new();let mut chunk=[0u8;2048];
            while !bytes.windows(4).any(|w|w==b"\r\n\r\n") {let n=socket.read(&mut chunk).unwrap();if n==0{break;}bytes.extend_from_slice(&chunk[..n]);assert!(bytes.len()<8192);}
            let request=String::from_utf8(bytes).unwrap();
            assert!(request.starts_with("GET /v1beta/models?pageSize=1000 "));
            assert!(request.to_ascii_lowercase().contains("x-goog-api-key: synthetic-local-key"));
            assert!(!request.lines().next().unwrap().contains("synthetic-local-key"));
            let body=r#"{"models":[{"name":"models/gemini-3.1-flash-image"},{"name":"models/gemini-text"}]}"#;
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        let models=list_models(&format!("http://127.0.0.1:{port}/v1"),"synthetic-local-key",true).await.unwrap();
        assert_eq!(models,vec!["gemini-3.1-flash-image","gemini-text"]);server.join().unwrap();
    }
    #[test] fn endpoint_preserves_explicit_prefix_and_only_converts_known_gemini_version() {
        assert_eq!(endpoint("https://example.test/custom/v2","images/generations",false).unwrap(),"https://example.test/custom/v2/images/generations");
        assert_eq!(endpoint("https://example.test","videos",false).unwrap(),"https://example.test/v1/videos");
        assert_eq!(endpoint("https://example.test/custom/v1","models/g:generateContent",true).unwrap(),"https://example.test/custom/v1beta/models/g:generateContent");
        assert!(endpoint("https://user:secret@example.test/v1","videos",false).is_err());
    }
    #[test] fn twelve_image_model_switch_normalizes_both_protocol_directions() {
        for route in ["images/generations","images/edits"] {
            assert_eq!(endpoint("https://new.12ai.org/v1beta",route,false).unwrap(),format!("https://new.12ai.org/v1/{route}"));
            assert_eq!(endpoint("https://cdn.12ai.org/custom/v1beta",route,false).unwrap(),format!("https://cdn.12ai.org/custom/v1/{route}"));
        }
        assert_eq!(endpoint("https://new.12ai.org/v1","models/gemini-3.1-flash-image:generateContent",true).unwrap(),"https://new.12ai.org/v1beta/models/gemini-3.1-flash-image:generateContent");
        assert_eq!(endpoint("https://other.example/v1beta","images/generations",false).unwrap(),"https://other.example/v1beta/images/generations");
    }
    #[test] fn async_reply_must_match_task_and_explicit_terminal_status() {
        assert_eq!(task_state(&json!({"id":"a","status":"completed"}),"a").unwrap(),"completed");
        assert!(task_state(&json!({"id":"b","status":"completed"}),"a").is_err());
        assert!(task_state(&json!({"id":"a","outputs":["https://example.test/video.mp4"]}),"a").is_err());
        assert!(task_state(&json!({"id":"a","status":"partial_completed"}),"a").is_err());
        assert!(task_id(&json!({"id":"../escape"})).is_err());
        assert!(task_id(&json!({"id":".."})).is_err());
        assert!(task_id(&json!({"id":"."})).is_err());
    }
    #[test] fn result_projection_rejects_local_or_credentialed_urls() {
        assert_eq!(result_urls(&json!({"outputs":["file:///private","https://user:key@example.test/v","https://example.test/video.mp4"]})),vec!["https://example.test/video.mp4"]);
    }
}

#[cfg(test)]
mod list_models_tests {
    use super::*;
    use serde_json::json;

    fn parse_ids(parsed: &Value) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        if let Some(items) = parsed.get("data").and_then(Value::as_array) {
            for item in items {
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    if safe_model(id) { ids.push(id.to_owned()); }
                }
            }
        } else if let Some(items) = parsed.get("models").and_then(Value::as_array) {
            for item in items {
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    let id = name.strip_prefix("models/").unwrap_or(name);
                    if safe_model(id) { ids.push(id.to_owned()); }
                }
            }
        }
        ids.sort();
        ids.dedup();
        ids.truncate(500);
        ids
    }

    #[test]
    fn openai_style_model_list_is_projected_sorted_and_deduped() {
        let parsed = json!({"object":"list","data":[{"id":"b-model"},{"id":"a-model"},{"id":"a-model"},{"id":""}]});
        assert_eq!(parse_ids(&parsed), vec!["a-model".to_string(), "b-model".to_string()]);
    }

    #[test]
    fn gemini_style_names_strip_the_models_prefix() {
        let parsed = json!({"models":[{"name":"models/gemini-2.5-flash-image"},{"name":"models/gemini-2.0-flash"}]});
        assert_eq!(parse_ids(&parsed), vec!["gemini-2.0-flash".to_string(), "gemini-2.5-flash-image".to_string()]);
    }

    #[test]
    fn unknown_shapes_yield_an_empty_projection() {
        assert!(parse_ids(&json!({"something":"else"})).is_empty());
    }
}



#[cfg(test)]
mod easycli_auto_tests {
    use super::*;
    #[test] fn gemini_portrait_options_keep_the_native_generate_content_route() {
        let model = "gemini-3.1-flash-image";
        let base = easycli_base("http://127.0.0.1:8317/v1", "easycli-auto");
        let protocol = options::image_protocol(&base, model, "easycli-auto");
        assert_eq!(protocol, "gemini-image");
        assert_eq!(endpoint(&base, &options::gemini_model_route(model).unwrap(), true).unwrap(), "http://127.0.0.1:8317/v1beta/models/gemini-3.1-flash-image:generateContent");
        assert_eq!(options::native_image_options(model, protocol, Some("9:16"), Some("1K"), None).unwrap(), json!({"aspectRatio":"9:16","imageSize":"1K"}));
    }
    #[test] fn auto_routes_both_families_without_changing_model_or_connection() {
        for base in ["http://127.0.0.1:8317/v1","http://127.0.0.1:8317/v1beta/","https://proxy.test/prefix/v1beta"] {
            let base=easycli_base(base,"easycli-auto");
            assert_eq!(options::image_protocol(&base,"gpt-image-2.5-sunburst","easycli-auto"),"openai-image");
            assert_eq!(options::image_protocol(&base,"account/gemini-3.1-flash-image","easycli-auto"),"gemini-image");
            assert!(endpoint(&base,"images/generations",false).unwrap().ends_with("/v1/images/generations"));
            assert!(endpoint(&base,"models/gemini-3.1-flash-image:generateContent",true).unwrap().ends_with("/v1beta/models/gemini-3.1-flash-image:generateContent"));
        }
        assert_eq!(easycli_base("https://proxy.test/v1beta","gemini-image"),"https://proxy.test/v1beta");
        assert_eq!(options::image_protocol("http://localhost:8317/v1","gemini-3.1-flash-image","openai-image"),"openai-image");
        assert_eq!(options::image_protocol("https://proxy.test/v1","gpt-image-2.5-sunburst","gemini-image"),"gemini-image");
        // Unrecognized aliases reach the unsupported dispatch arm, never a fallback request.
        assert_eq!(options::image_protocol("http://localhost:8317/v1","custom-alias","easycli-auto"),"easycli-auto");
    }
}

#[cfg(test)]
mod generation_error_tests {
    use super::*;
    #[test]
    fn structured_errors_are_classified_without_disclosing_body() {
        let bad = reqwest::StatusCode::BAD_REQUEST;
        assert_eq!(response_error_kind(bad, r#"{"error":{"code":"moderation_blocked","message":"private synthetic prompt"}}"#), "moderation_blocked");
        assert_eq!(response_error_kind(bad, r#"{"error":{"code":"model_not_found"}}"#), "model_unavailable");
        assert_eq!(response_error_kind(bad, r#"{"error":{"code":"unsupported_endpoint"}}"#), "unsupported_protocol");
        assert_eq!(response_error_kind(bad, r#"{"error":{"message":"moderation_blocked"}}"#), "invalid_request");
        assert_eq!(response_error_kind(reqwest::StatusCode::UNAUTHORIZED, "not json"), "unauthorized");
        assert_eq!(response_error_kind(reqwest::StatusCode::TOO_MANY_REQUESTS, "not json"), "rate_limited");
        assert_eq!(response_error_kind(reqwest::StatusCode::NOT_FOUND, "not json"), "unsupported_protocol");
    }
    #[test]
    fn gemini_capacity_and_quota_errors_are_not_conflated() {
        let unavailable = reqwest::StatusCode::SERVICE_UNAVAILABLE;
        assert_eq!(response_error_kind(unavailable, "not json"), "provider_error");
        assert_eq!(response_error_kind(unavailable, r#"{"error":{"code":"auth_unavailable","type":"server_error","message":"private synthetic provider diagnostic"}}"#), "provider_error");
        assert_eq!(response_error_kind(unavailable, r#"{"error":{"code":503,"status":"UNAVAILABLE"}}"#), "provider_error");
        assert_eq!(response_error_kind(reqwest::StatusCode::TOO_MANY_REQUESTS, r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}"#), "rate_limited");
        assert_eq!(response_error_kind(unavailable, r#"{"error":{"status":"RESOURCE_EXHAUSTED"}}"#), "rate_limited");
        // Provider message text is not parsed as an error code or exposed.
        assert_eq!(response_error_kind(unavailable, r#"{"error":{"message":"RESOURCE_EXHAUSTED"}}"#), "provider_error");
    }
    #[test]
    fn successful_gemini_safety_responses_are_not_empty_result_errors() {
        assert!(response_safety_blocked(&json!({"promptFeedback":{"blockReason":"SAFETY"}})));
        assert!(response_safety_blocked(&json!({"candidates":[{"finishReason":"IMAGE_SAFETY"}]})));
        assert!(!response_safety_blocked(&json!({"candidates":[{"finishReason":"STOP"}]})));
    }
}

#[cfg(test)]
mod bigmodel_protocol_tests {
    use super::*;
    fn request()->AiVideoGenerateRequest {
        serde_json::from_value(json!({"client_task_id":"synthetic-task","model":"cogvideox-flash","prompt":"Synthetic scene"})).unwrap()
    }
    fn profile()->crate::canvas_media_profiles::Profile {
        serde_json::from_value(json!({"id":"bigmodel","name":"Synthetic","baseUrl":"https://open.bigmodel.cn/api/paas/v4","imageModel":"","videoModel":"cogvideox-flash","imageProtocol":"disabled","videoProtocol":"bigmodel-video","revision":1})).unwrap()
    }
    #[test] fn exact_flash_routes_and_minimal_body() {
        assert_eq!(endpoint("https://open.bigmodel.cn/api/paas/v4","videos/generations",false).unwrap(),"https://open.bigmodel.cn/api/paas/v4/videos/generations");
        assert_eq!(endpoint("https://open.bigmodel.cn/api/paas/v4","async-result/task-1",false).unwrap(),"https://open.bigmodel.cn/api/paas/v4/async-result/task-1");
        assert_eq!(bigmodel_body("cogvideox-flash","Synthetic scene",&[],&request()).unwrap(),json!({"model":"cogvideox-flash","prompt":"Synthetic scene"}));
        assert!(bigmodel_body("cogvideox","Synthetic scene",&[],&request()).is_err());
        assert!(bigmodel_body("cogvideox-flash",&"界".repeat(512),&[],&request()).is_ok());
        assert_eq!(bigmodel_body("cogvideox-flash",&"界".repeat(513),&[],&request()),Err("bigmodel_prompt_too_long"));
        let mut r=request();r.duration=Some(5);
        assert!(bigmodel_body("cogvideox-flash","Synthetic scene",&[],&r).is_err());
    }
    #[test] fn terminal_status_requires_matching_id_and_explicit_success() {
        assert_eq!(bigmodel_state(&json!({"id":"a","task_status":"PROCESSING"}),"a"),Ok("generating"));
        assert_eq!(bigmodel_state(&json!({"id":"a","task_status":"SUCCESS"}),"a"),Ok("completed"));
        for value in [json!({"id":"b","task_status":"SUCCESS"}),json!({"id":"a","task_status":"FAIL"}),json!({"id":"a","video_result":[{"url":"https://example.com/v"}]})] {
            assert!(bigmodel_state(&value,"a").is_err());
        }
    }
    #[test] fn durable_unknown_submission_never_restarts_and_receipt_recovers() {
        let dir=tempfile::tempdir().unwrap();let p=profile();let r=request();
        let ledger=SubmissionLedger::new(dir.path(),"task-1",&p,&r).unwrap();
        assert_eq!(ledger.recover().unwrap(),None);
        ledger.begin().unwrap();
        assert_eq!(ledger.recover(),Err("submission_unknown"));
        assert_eq!(ledger.begin(),Err("submission_unknown"));
        ledger.record("provider-task-1").unwrap();
        assert_eq!(ledger.recover().unwrap(),Some("provider-task-1".into()));
        let mut changed=request();changed.prompt="Changed".into();
        assert_eq!(SubmissionLedger::new(dir.path(),"task-1",&p,&changed).unwrap().recover(),Err("submission_binding_changed"));
        let stored=std::fs::read_to_string(&ledger.marker).unwrap();assert_eq!(stored.len(),129);assert!(!stored.contains("Synthetic"));
    }
    #[test] fn created_task_resumes_original_paths_but_pending_and_other_changes_reject() {
        let dir=tempfile::tempdir().unwrap();let p=profile();let mut created=request();
        created.references=serde_json::from_value(json!([{"kind":"image","role":"firstFrame","media_url":"data:image/png;base64,c3ludGhldGlj"}])).unwrap();
        let ledger=SubmissionLedger::new(dir.path(),"task-refs",&p,&created).unwrap();ledger.begin().unwrap();
        let mut resumed=request();resumed.provider_task_id=Some("provider-task".into());
        resumed.references=serde_json::from_value(json!([{"kind":"image","role":"firstFrame","media_url":"/removed/local/image.png"}])).unwrap();
        assert_eq!(SubmissionLedger::new(dir.path(),"task-refs",&p,&resumed).unwrap().recover(),Err("submission_binding_changed"));
        ledger.record("provider-task").unwrap();
        assert_eq!(SubmissionLedger::new(dir.path(),"task-refs",&p,&resumed).unwrap().recover(),Ok(Some("provider-task".into())));
        let mut other_profile=p.clone();other_profile.revision+=1;
        assert_eq!(SubmissionLedger::new(dir.path(),"task-refs",&other_profile,&resumed).unwrap().recover(),Err("submission_binding_changed"));
        for field in ["prompt","model","aspect","quality","duration","sound"] {
            let mut changed=serde_json::json!({"client_task_id":"synthetic-task","model":"cogvideox-flash","prompt":"Synthetic scene"});
            changed[field]=match field {"duration"=>json!(8),"sound"=>json!(true),_=>json!("changed")};
            let changed:AiVideoGenerateRequest=serde_json::from_value(changed).unwrap();
            assert_eq!(SubmissionLedger::new(dir.path(),"task-refs",&p,&changed).unwrap().recover(),Err("submission_binding_changed"),"{field}");
        }
    }
    #[test] fn orphan_oversize_and_traversal_receipts_fail_closed() {
        let dir=tempfile::tempdir().unwrap();let p=profile();let r=request();
        let ledger=SubmissionLedger::new(dir.path(),"task-1",&p,&r).unwrap();
        std::fs::write(&ledger.task,"orphan").unwrap();assert_eq!(ledger.recover(),Err("submission_unknown"));
        std::fs::remove_file(&ledger.task).unwrap();ledger.begin().unwrap();
        std::fs::write(&ledger.task,"../private").unwrap();assert_eq!(ledger.recover(),Err("submission_unknown"));
        std::fs::write(&ledger.task,vec![b'a';300]).unwrap();assert_eq!(ledger.recover(),Err("submission_unknown"));
    }
    #[test] fn provider_dns_policy_rejects_internal_and_transition_ranges() {
        for ip in ["127.0.0.1","10.1.2.3","169.254.169.254","100.64.1.1","192.168.1.1","::1","::ffff:127.0.0.1","fc00::1","2002:7f00:1::1","2001:db8::1"] {
            assert!(!public_provider_ip(ip.parse().unwrap()),"{ip}");
        }
        assert!(public_provider_ip("8.8.8.8".parse().unwrap()));
        assert!(public_provider_ip("2606:4700:4700::1111".parse().unwrap()));
    }
}

#[cfg(test)]
mod generic_video_transport_tests {
    use super::*;
    #[tokio::test]
    async fn text_only_video_uses_multipart_without_reference_or_credentials() {
        let fields=vec![("model","third-party-video".into()),("prompt","Synthetic prompt".into()),("seconds","8".into()),("size","1280x720".into())];
        let (mime,bytes)=image_multipart(&fields,&[],"input_reference").await.unwrap();
        assert!(mime.starts_with("multipart/form-data; boundary="));
        let body=String::from_utf8(bytes).unwrap();
        assert!(body.contains("name=\"model\"\r\n\r\nthird-party-video"));
        assert!(body.contains("name=\"seconds\"\r\n\r\n8"));
        assert!(!body.contains("input_reference"));assert!(!body.contains("Authorization"));
    }
}
