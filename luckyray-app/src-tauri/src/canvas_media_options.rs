//! One public capability table shared with canvas option controls. No account data.
use serde_json::{json,Value};
use std::sync::OnceLock;
type Error=&'static str;
pub(super) fn spec(model:&str)->Option<&'static Value>{
 static TABLE:OnceLock<Value>=OnceLock::new();
 let table=TABLE.get_or_init(||serde_json::from_str(include_str!("../../src/core/canvas/twelveMediaSpecs.json")).expect("validated media capability table"));
 table.get(model).or_else(||table.as_object()?.values().find(|spec|spec.get("aliases").and_then(Value::as_array).is_some_and(|aliases|aliases.iter().any(|alias|alias.as_str()==Some(model)))))
}
pub(super) fn twelve_host(base:&str)->bool{
 reqwest::Url::parse(base).ok().and_then(|u|u.host_str().map(str::to_owned)).is_some_and(|h|matches!(h.as_str(),"new.12ai.org"|"cdn.12ai.org"))
}
// Mirror the frontend's provider-scoped routing. Keep the actual requested model
// ID intact; never probe a second provider or retry a charged request automatically.
pub(super) fn image_protocol<'a>(base:&str,model:&str,configured:&'a str)->&'a str {
 if !twelve_host(base)||!matches!(configured,"openai-image"|"gemini-image"){return configured;}
 match spec(model).filter(|s|s["kind"]=="image").and_then(|s|s["family"].as_str()){
  Some("gemini")=>"gemini-image",Some("gpt")=>"openai-image",_=>configured,
 }
}
fn choice<'a>(s:&'a Value,key:&str,value:Option<&str>)->Result<Option<String>,Error>{
 let values=s.get(key).and_then(Value::as_array).ok_or("unsupported_input")?;
 if values.is_empty(){return if value.is_none(){Ok(None)}else{Err("unsupported_input")};}
 let chosen=value.unwrap_or_else(||values[0].as_str().unwrap_or(""));
 if !values.iter().any(|v|v.as_str()==Some(chosen)){return Err("unsupported_input");}
 Ok(Some(chosen.to_owned()))
}
pub(super) fn image_options(model:&str,aspect:Option<&str>,quality:Option<&str>,task:bool)->Result<Value,Error>{
 image_options_with_resolution(model,aspect,quality,None,task)
}
pub(super) fn image_options_with_resolution(model:&str,aspect:Option<&str>,quality:Option<&str>,resolution:Option<&str>,task:bool)->Result<Value,Error>{
 let s=spec(model).filter(|v|v["kind"]=="image").ok_or("unsupported_input")?;
 let ratio=choice(s,if task&&s.get("taskAspects").is_some(){"taskAspects"}else{"aspects"},aspect)?.ok_or("unsupported_input")?;
 let quality=choice(s,"qualities",quality)?;
 if s["family"]=="gpt"{
  let size=if ratio=="auto" {
   if resolution.is_some(){return Err("unsupported_input");} "auto"
  } else if let Some(tier)=resolution {
   s["resolutionSizes"].get(tier).and_then(|v|v.get(&ratio)).and_then(Value::as_str).ok_or("unsupported_input")?
  } else {s["sizes"].get(&ratio).and_then(Value::as_str).ok_or("unsupported_input")?};
  return Ok(json!({"size":size,"quality":quality.ok_or("unsupported_input")?}));
 }
 if resolution.is_some(){return Err("unsupported_input");}
 let mut result=if task{json!({"aspect_ratio":ratio})}else{json!({"aspectRatio":ratio})};
 if let Some(q)=quality{result[if task{"image_size"}else{"imageSize"}]=json!(if task&&q=="512px"{"512".to_owned()}else{q});}
 Ok(result)
}
pub(super) fn video_options(model:&str,prompt:&str,aspect:Option<&str>,quality:Option<&str>,duration:Option<u64>,sound:Option<bool>,references:&[(&str,&str)])->Result<Value,Error>{
 let s=spec(model).filter(|v|v["kind"]=="video").ok_or("unsupported_input")?;
 let ratio=choice(s,"aspects",aspect)?.ok_or("unsupported_input")?;
 let quality=choice(s,"qualities",quality)?.ok_or("unsupported_input")?;
 let duration=duration.unwrap_or_else(||s["durations"][0].as_u64().unwrap_or(5));
 if duration<s["minDuration"].as_u64().unwrap_or(u64::MAX)||duration>s["maxDuration"].as_u64().unwrap_or(0)||prompt.chars().count()>5000{return Err("unsupported_input");}
 if model.starts_with("veo-")&&!matches!(duration,4|6|8){return Err("unsupported_input");}
 let mut regular=Vec::new();let mut first=Vec::new();let mut last=Vec::new();
 for (role,url) in references{
  // Preserve the existing task adapter's HTTPS-only reference boundary.
  if !url.starts_with("https://"){return Err("unsupported_input");}
  match *role{"reference"=>regular.push(*url),"firstFrame"=>first.push(*url),"lastFrame"=>last.push(*url),_=>return Err("unsupported_input")};
 }
 if regular.len()>s["maxReferences"].as_u64().unwrap_or(0)as usize||first.len()>1||last.len()>1||(!regular.is_empty()&&(!first.is_empty()||!last.is_empty())){return Err("unsupported_input");}
 let frames=s["frames"].as_str().ok_or("unsupported_input")?;
 match frames{
  "none" if !first.is_empty()||!last.is_empty()=>return Err("unsupported_input"),
  "required-pair" if first.len()!=last.len()=>return Err("unsupported_input"),
  "first-only" if !last.is_empty()=>return Err("unsupported_input"),
  "required-first" if first.len()!=1||!last.is_empty()=>return Err("unsupported_input"),
  "optional-pair"|"singular-pair" if !last.is_empty()&&first.is_empty()=>return Err("unsupported_input"),
  _=>{}
 }
 let mut input=json!({"prompt":prompt,"duration":duration,"aspect_ratio":ratio,"resolution":quality});
 if s["sound"]==true{input["audio"]=json!(sound.unwrap_or(true));}else if sound.is_some(){return Err("unsupported_input");}
 if !regular.is_empty(){input["image_references"]=json!(regular);}
 if frames=="singular-pair"{
  if let Some(url)=first.first(){input["first_frame"]=json!(url);}
  if let Some(url)=last.first(){input["last_frame"]=json!(url);}
 }else{
  if !first.is_empty(){input["start_frames"]=json!(first);}
  if !last.is_empty(){input["end_frames"]=json!(last);}
 }
 Ok(input)
}

#[cfg(test)]mod tests{
 use super::*;
 #[test]fn provider_model_routing_keeps_frontend_and_native_aligned(){
  for base in ["https://new.12ai.org/v1","https://cdn.12ai.org/v1"]{
   assert_eq!(image_protocol(base,"gemini-3.1-flash-image","openai-image"),"gemini-image");
   assert_eq!(image_protocol(base,"gemini-3.1-flash-image-preview","openai-image"),"gemini-image");
   assert_eq!(image_protocol(base,"gpt-image-2.5-flare","gemini-image"),"openai-image");
   assert_eq!(image_protocol(base,"gemini-3.1-flash-image","12ai-task"),"12ai-task");
   assert_eq!(image_protocol(base,"gemini-3.1-flash-image","disabled"),"disabled");
  }
  assert_eq!(image_protocol("https://other.example/v1","gemini-3.1-flash-image","openai-image"),"openai-image");
  assert_eq!(image_protocol("https://new.12ai.org.attacker.example/v1","gemini-3.1-flash-image","openai-image"),"openai-image");
  assert_eq!(image_protocol("https://new.12ai.org/v1","unknown-image","openai-image"),"openai-image");
  let alias=image_options("gemini-3.1-flash-image",Some("16:9"),Some("2K"),false).unwrap();
  assert_eq!(alias["aspectRatio"],"16:9");assert_eq!(alias["imageSize"],"2K");
 }
 #[test]fn gpt_resolution_and_quality_are_independent(){
  for task in [false,true] {
   let p=image_options_with_resolution("gpt-image-2.5-flare",Some("16:9"),Some("max"),Some("4K"),task).unwrap();
   assert_eq!(p["size"],"3840x2160");assert_eq!(p["quality"],"max");
   assert_eq!(image_options_with_resolution("gpt-image-2",Some("1:1"),Some("high"),Some("4K"),task).unwrap()["size"],"2880x2880");
   assert!(image_options_with_resolution("gpt-image-2",Some("1:1"),Some("high"),Some("8K"),task).is_err());
   assert!(image_options_with_resolution("gpt-image-2",Some("auto"),None,Some("4K"),task).is_err());
   assert_eq!(image_options_with_resolution("gpt-image-2",Some("auto"),None,None,task).unwrap()["size"],"auto");
   assert!(image_options_with_resolution("gemini-3.1-flash-image",Some("16:9"),Some("2K"),Some("4K"),task).is_err());
  }
 }
 #[test]fn gpt_ratio_and_quality_are_not_silently_coerced(){
  let p=image_options("gpt-image-2.5-flare",Some("21:9"),Some("max"),false).unwrap();assert_eq!(p["size"],"1904x816");assert_eq!(p["quality"],"max");
  assert!(image_options("gpt-image-2",Some("1:1"),Some("max"),false).is_err());
  assert!(image_options("gpt-image-2.5-flare",Some("100:1"),None,false).is_err());
 }
 #[test]fn gemini_512_and_native_task_ratios_stay_distinct(){
  assert_eq!(image_options("gemini-3.1-flash-image-preview",Some("4:5"),Some("512px"),true).unwrap()["image_size"],"512");
  assert!(image_options("gemini-3.1-flash-image-preview",Some("4:5"),Some("512px"),false).is_err());
  assert!(image_options("gemini-2.5-flash-image",None,Some("4K"),true).is_err());
 }
 #[test]fn all_declared_video_options_are_valid_without_changing_casing(){
  for model in ["seedance-2.0","seedance-2.0-fast","seedance-2.5","MiniMax-H3","veo-3.1-generate-preview","veo-3.1-fast-generate-preview","kling-3.0-turbo","grok-imagine-1.5","happy-horse-1.1","gemini-omni-1.1-flash","gemini-omni-flash-preview"]{
   let s=spec(model).unwrap();for a in s["aspects"].as_array().unwrap(){for q in s["qualities"].as_array().unwrap(){
    let refs=if model=="grok-imagine-1.5"{vec![("firstFrame","https://example.test/frame.png")]}else{vec![]};
    let result=video_options(model,"test",a.as_str(),q.as_str(),None,None,&refs).unwrap();assert_eq!(result["resolution"],*q);
   }}
  }
 }
 #[test]fn frame_contracts_fail_closed_and_omni_uses_singular_keys(){
  let first=[("firstFrame","https://example.test/first.png")];let pair=[first[0],("lastFrame","https://example.test/last.png")];
  assert!(video_options("veo-3.1-generate-preview","x",None,None,None,None,&first).is_err());
  assert!(video_options("grok-imagine-1.5","x",None,None,None,None,&[]).is_err());
  assert!(video_options("MiniMax-H3","x",None,None,None,None,&first).is_err());
  assert!(video_options("MiniMax-H3","x",None,None,None,Some(true),&[]).is_err());
  let v=video_options("gemini-omni-1.1-flash","x",None,Some("4k"),None,None,&pair).unwrap();assert!(v.get("first_frame").is_some());assert!(v.get("start_frames").is_none());assert!(v.get("audio").is_none());
 }
 #[test]fn only_exact_provider_hosts_receive_special_openai_options(){assert!(twelve_host("https://new.12ai.org/v1"));assert!(twelve_host("https://cdn.12ai.org"));assert!(!twelve_host("https://new.12ai.org.attacker.test"));}
}
