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
async fn response_json(request: reqwest::RequestBuilder, limit: usize) -> Result<Value,Error> {
    let response = request.send().await.map_err(|e| if e.is_timeout() {"timeout"} else {"connection"})?;
    let status = response.status();
    let text = crate::read_ai_response_body_bounded(response,if status.is_success(){limit}else{crate::AI_STREAM_MAX_ERROR_BODY_BYTES},"provider_error")
        .await.map_err(|_| "invalid_response")?;
    if !status.is_success() { return Err(crate::canvas_generation_http_error_kind(status)); }
    serde_json::from_str(&text).map_err(|_| "invalid_response")
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
    let client = client()?;
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
    let client=client()?;
    let base=&config.profile.base_url;
    let protocol=options::image_protocol(base,model,config.profile.image_protocol.as_str());
    if request.resolution.is_some() && !(matches!(protocol,"openai-image"|"12ai-task") && options::spec(model).is_some_and(|v|v["family"]=="gpt") && (protocol=="12ai-task"||options::twelve_host(base))) {return Err("unsupported_input");}
    let key=crate::normalize_ai_api_key(&config.api_key);
    if key.is_empty(){return Err("no_api_key");}
    let mut gemini=false;
    let pending = match protocol {
        "openai-image" => {
            let aspect=request.aspect.as_deref().unwrap_or("1:1");
            let mut size=match aspect {"3:2"=>if model.contains("dall-e-3"){"1792x1024"}else{"1536x1024"},"2:3"=>if model.contains("dall-e-3"){"1024x1792"}else{"1024x1536"},_=>crate::canvas_image_size(model,Some(aspect))}.to_owned();
            let mut quality=match request.quality.as_deref(){Some("low"|"标准")=>"low",Some("高清"|"超清"|"high"|"hd")=>"high",_=>"medium"}.to_owned();
            if options::twelve_host(base) && options::spec(model).is_some_and(|v|v["family"]=="gpt") {
                let selected=options::image_options_with_resolution(model,request.aspect.as_deref(),request.quality.as_deref(),request.resolution.as_deref(),false)?;
                size=selected["size"].as_str().ok_or("unsupported_input")?.to_owned();
                quality=selected["quality"].as_str().ok_or("unsupported_input")?.to_owned();
            }
            if references.is_empty() {
                let mut body=json!({"model":model,"prompt":prompt,"size":size,"n":request.count.unwrap_or(1).clamp(1,4)});
                if base.starts_with("http://") {body["response_format"]=json!("b64_json");}
                if model.starts_with("gpt-image") {body["quality"]=json!(quality);}
                if model.contains("dall-e-3") {body["n"]=json!(1);body["quality"]=json!(if quality=="high"{"hd"}else{"standard"});}
                client.post(endpoint(base,"images/generations",false)?).bearer_auth(&key).json(&body)
            } else {
                let mut fields=vec![("model",model.to_owned()),("prompt",prompt.to_owned()),("size",size),("n",request.count.unwrap_or(1).clamp(1,4).to_string())];
                if base.starts_with("http://") {fields.push(("response_format","b64_json".to_owned()));}
                if model.starts_with("gpt-image"){fields.push(("quality",quality.to_owned()));}
                let (mime,body)=image_multipart(&fields,&references,"image[]").await?;
                client.post(endpoint(base,"images/edits",false)?).bearer_auth(&key).header("Content-Type",mime).body(body)
            }
        },
        "gemini-image" => {
            if !model.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c,b'-'|b'_'|b'.')) { return Err("unsupported_input"); }
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
            }
            let body=json!({"contents":[{"parts":parts}],"generationConfig":{"responseModalities":["IMAGE"],"imageConfig":image_config}});
            gemini_auth(client.post(endpoint(base,&format!("models/{model}:generateContent"),true)?),base,&key).json(&body)
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
    } else {crate::extract_canvas_generated_images(&parsed)};
    if images.iter().any(|image|image.url.starts_with("http://")){return Err("unsupported_input");}
    if images.is_empty(){Err("empty_response")}else{Ok(images)}
}

pub(crate) async fn video(app: &tauri::AppHandle,request: &AiVideoGenerateRequest,config: &RuntimeProfile,cancelled: &(dyn Fn()->bool+Send+Sync)) -> AiVideoGenerateResponse {
    match video_inner(app,request,config,cancelled).await {
        Ok(url)=>AiVideoGenerateResponse{success:true,video_url:Some(url),thumbnail_url:None,error_kind:None,error_message:None,error_detail:None},
        Err(error)=>crate::ai_video_failure(error),
    }
}
async fn video_inner(app: &tauri::AppHandle,request: &AiVideoGenerateRequest,config: &RuntimeProfile,cancelled: &(dyn Fn()->bool+Send+Sync)) -> Result<String,Error> {
    let model=if request.model.trim().is_empty(){config.profile.video_model.trim()}else{request.model.trim()};
    let prompt=request.prompt.trim();
    if !safe_model(model)||prompt.is_empty()||prompt.len()>crate::CANVAS_GENERATION_MAX_PROMPT_BYTES{return Err("unsupported_input");}
    let protocol=config.profile.video_protocol.as_str();
    if !matches!(protocol,"openai-video"|"12ai-task"){return Err("unsupported_input");}
    let references=crate::ordered_canvas_image_references(&request.references).ok_or("unsupported_input")?;
    let client=client()?;let base=&config.profile.base_url;let key=crate::normalize_ai_api_key(&config.api_key);
    if key.is_empty(){return Err("no_api_key");}
    let resume=request.provider_task_id.as_deref().filter(|s| !s.is_empty());
    let mut parsed;
    let id=if let Some(id)=resume {
        if !crate::valid_provider_task_id(id){return Err("unsupported_input");}
        parsed=json!({"id":id,"status":"queued"});id.to_owned()
    }else{
        let duration=request.duration.unwrap_or(if protocol=="openai-video"{8}else{5});
        let aspect=request.aspect.as_deref().unwrap_or("16:9");
        let builder=if protocol=="openai-video" {
            if !matches!(duration,4|8|12)||!matches!(aspect,"16:9"|"9:16")||references.len()>1||request.references.iter().any(|r|r.role=="lastFrame")||request.quality.as_deref().is_some_and(|v|v!="720p")||request.sound.is_some(){return Err("unsupported_input");}
            let size=if aspect=="9:16"{"720x1280"}else{"1280x720"};
            if references.is_empty(){client.post(endpoint(base,"videos",false)?).bearer_auth(&key).json(&json!({"model":model,"prompt":prompt,"seconds":duration.to_string(),"size":size}))}
            else{
                let fields=vec![("model",model.to_owned()),("prompt",prompt.to_owned()),("seconds",duration.to_string()),("size",size.into())];
                let (mime,body)=image_multipart(&fields,&references,"input_reference").await?;
                client.post(endpoint(base,"videos",false)?).bearer_auth(&key).header("Content-Type",mime).body(body)
            }
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
        parsed=response_json(builder,crate::CANVAS_GENERATION_MAX_POLL_BYTES).await?;
        task_id(&parsed)?.to_owned()
    };
    if parsed.get("status").is_none(){parsed=json!({"id":&id,"status":"queued"});}
    crate::emit_canvas_video_progress(app,request.client_task_id.as_deref(),Some(&id),"queued",Some(0));
    let deadline=tokio::time::Instant::now()+Duration::from_secs(600);
    loop {
        if cancelled(){return Err("cancelled");}
        let state=task_state(&parsed,&id)?;
        if state=="completed"{break;}
        crate::emit_canvas_video_progress(app,request.client_task_id.as_deref(),Some(&id),state,parsed.get("progress").and_then(Value::as_u64).map(|n|n.min(100)));
        if tokio::time::Instant::now()>=deadline{return Err("timeout");}
        tokio::time::sleep(Duration::from_secs(5)).await;
        let route=format!("{}/{}",if protocol=="openai-video"{"videos"}else{"task"},id);
        parsed=response_json(client.get(endpoint(base,&route,false)?).bearer_auth(&key),crate::CANVAS_GENERATION_MAX_POLL_BYTES).await?;
    }
    let output_dir=app.path().app_data_dir().map_err(|_|"provider_error")?.join("canvas/generated-videos");
    crate::emit_canvas_video_progress(app,request.client_task_id.as_deref(),Some(&id),"downloading",Some(99));
    let url=match result_urls(&parsed).into_iter().next() {
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

