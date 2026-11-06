//! Explicit portable-template execution. Legacy recipes do not enter this path.
use serde_json::Value;
use std::collections::{BTreeSet,HashSet};
const INVALID:&str="comfyui-workflow-template-invalid";
pub(super) fn is_template(value:&Value)->bool {value.get("format").and_then(Value::as_str)==Some("luckyray.comfy-execution")}
fn node_id(id:&str)->bool {!id.is_empty()&&id.len()<=12&&id.bytes().all(|b|b.is_ascii_digit())}
fn name(s:&str)->bool {!s.is_empty()&&s.len()<=160&&!s.chars().any(char::is_control)&&!matches!(s,"__proto__"|"prototype"|"constructor")}
pub(super) fn validate(value:&Value)->Result<String,&'static str> {
    if !is_template(value)||value["version"]!=1||serde_json::to_vec(value).map_err(|_|INVALID)?.len()>1024*1024{return Err(INVALID);}
    let graph=value["graph"].as_object().ok_or(INVALID)?;
    if graph.is_empty()||graph.len()>512{return Err(INVALID);}
    for (id,node) in graph {
        if !node_id(id)||!node["class_type"].as_str().is_some_and(name){return Err(INVALID);}
        let inputs=node["inputs"].as_object().ok_or(INVALID)?;
        for (key,v) in inputs {
            if !name(key){return Err(INVALID);}
            if let Some(link)=v.as_array(){
                if link.len()!=2||!link[0].as_str().is_some_and(|id|graph.contains_key(id))||!link[1].as_u64().is_some_and(|p|p<=255){return Err(INVALID);}
            }else if let Some(s)=v.as_str(){
                if s.len()>80000||s.contains('\0'){return Err(INVALID);}
                let k=key.to_ascii_lowercase();
                if !s.is_empty() && (key=="filename_prefix" || ["model_name","ckpt_name","vae_name","clip_name","lora_name","unet_name"].contains(&key.as_str())) && !super::safe_relative(s,false) {return Err(INVALID);}
                if !s.is_empty()&&(k.contains("api_key")||k.contains("password")||k.contains("secret")||k=="token"||k=="authorization"||s.starts_with("file:")||s.starts_with("\\\\")||s.as_bytes().get(1)==Some(&b':')){return Err(INVALID);}
            }else if !v.is_boolean()&&!v.is_number(){return Err(INVALID);}
        }
    }
    let output=value["output"]["nodeId"].as_str().filter(|s|node_id(s)).ok_or(INVALID)?;
    let node=graph.get(output).ok_or(INVALID)?;
    let kind=value["output"]["kind"].as_str().ok_or(INVALID)?;
    match kind {
        "image" if node["class_type"]=="SaveImage"=>{},
        "video" if node["class_type"]=="VHS_VideoCombine"&&node["inputs"]["save_output"]==true&&node["inputs"]["format"].as_str().is_some_and(|s|s.ends_with("-mp4"))=>{},
        _=>return Err(INVALID),
    }
    // Require exactly the selected dependency branch; don't execute other saved outputs.
    fn visit(id:&str,graph:&serde_json::Map<String,Value>,active:&mut HashSet<String>,done:&mut HashSet<String>)->Result<(),&'static str>{
        if done.contains(id){return Ok(());}if !active.insert(id.to_owned()){return Err(INVALID);}
        for v in graph[id]["inputs"].as_object().ok_or(INVALID)?.values(){if let Some(link)=v.as_array(){visit(link[0].as_str().ok_or(INVALID)?,graph,active,done)?;}}
        active.remove(id);done.insert(id.to_owned());Ok(())
    }
    let mut done=HashSet::new();visit(output,graph,&mut HashSet::new(),&mut done)?;
    if done.len()!=graph.len(){return Err(INVALID);}
    let images=value["images"].as_array().ok_or(INVALID)?;if images.len()>9{return Err(INVALID);}
    let mut seen=HashSet::new();
    for image in images {let id=image.as_str().ok_or(INVALID)?;if !seen.insert(id)||graph.get(id).is_none_or(|n|n["class_type"]!="LoadImage") {return Err(INVALID);}}
    if graph.values().filter(|n|n["class_type"]=="LoadImage").count()!=images.len(){return Err(INVALID);}
    Ok(if kind=="image"{format!("image:{output}")}else{output.to_owned()})
}
pub(super) fn dependencies(value:&Value,info:&Value)->super::Preflight {
    let graph=value["graph"].as_object().expect("validated template");
    let mut missing=BTreeSet::new();let mut invalid=BTreeSet::new();
    for (id,node) in graph {
        let class=node["class_type"].as_str().unwrap();let Some(def)=info.get(class) else{missing.insert(class.to_owned());continue;};
        let inputs=node["inputs"].as_object().unwrap();
        let required=def.pointer("/input/required").and_then(Value::as_object);
        if let Some(required)=required {for key in required.keys(){if !inputs.contains_key(key){invalid.insert(format!("{class}.{key}"));}}}
        for (key,v) in inputs {
            let spec=def.pointer("/input/required").and_then(|s|s.get(key)).or_else(||def.pointer("/input/optional").and_then(|s|s.get(key)));
            let Some(spec)=spec else {
                if class=="VHS_VideoCombine"&&node["inputs"]["format"].as_str().is_some_and(|format|super::supports_vhs_widget(def,format,key,v)){continue;}
                invalid.insert(format!("{class}.{key}"));continue;
            };
            let ty=spec.get(0).and_then(Value::as_str);
            if let Some(link)=v.as_array(){
                let source=&graph[link[0].as_str().unwrap()];let source_type=info.get(source["class_type"].as_str().unwrap()).and_then(|d|d.get("output")).and_then(|o|o.get(link[1].as_u64().unwrap() as usize)).and_then(Value::as_str);
                if ty.is_none()||source_type.is_none()||!(ty==source_type||ty==Some("*")||source_type==Some("*")){invalid.insert(format!("{id}.{key}"));}continue;
            }
            if class=="LoadImage"&&key=="image"{continue;}
            let choices=spec.get(0).and_then(Value::as_array).or_else(||spec.pointer("/1/options").and_then(Value::as_array));
            let valid=if let Some(choices)=choices {choices.contains(v)}else{match ty {
                Some("STRING")=>v.is_string(),Some("BOOLEAN")=>v.is_boolean(),
                Some("INT"|"FLOAT")=>v.as_f64().is_some_and(|n|n.is_finite()&&(ty!=Some("INT")||n.fract()==0.0)&&spec.pointer("/1/min").and_then(Value::as_f64).is_none_or(|min|n>=min)&&spec.pointer("/1/max").and_then(Value::as_f64).is_none_or(|max|n<=max)),
                _=>false,
            }};
            if !valid{invalid.insert(format!("{class}.{key}"));}
        }
    }
    super::Preflight{ready:missing.is_empty()&&invalid.is_empty(),missing_classes:missing.into_iter().collect(),missing_models:vec![],invalid_inputs:invalid.into_iter().collect(),installed_unet_models:vec![],installed_lora_models:vec![]}
}

#[cfg(test)]
mod tests {
    use super::*;
    fn execution()->Value {serde_json::json!({"format":"luckyray.comfy-execution","version":1,"graph":{"1":{"class_type":"ImageSource","inputs":{"seed":7}},"231":{"class_type":"SaveImage","inputs":{"images":["1",0],"filename_prefix":"synthetic"}}},"images":[],"output":{"nodeId":"231","kind":"image"}})}
    #[test] fn selected_output_and_safe_paths(){
        let mut v=execution();assert_eq!(validate(&v),Ok("image:231".to_owned()));
        v["graph"]["231"]["inputs"]["filename_prefix"]=Value::String("../../outside".into());assert!(validate(&v).is_err());
    }
    #[test] fn unrelated_output_and_cycles_rejected(){
        let mut v=execution();v["graph"]["7"]=v["graph"]["231"].clone();assert!(validate(&v).is_err());
        let mut v=execution();v["graph"]["1"]["inputs"]["seed"]=serde_json::json!(["231",0]);assert!(validate(&v).is_err());
    }
    #[test] fn generic_node_231_is_not_seedvr_and_installed_types_checked(){
        let v=execution();let info=serde_json::json!({"ImageSource":{"input":{"required":{"seed":["INT",{"min":0,"max":100}]}},"output":["IMAGE"]},"SaveImage":{"input":{"required":{"images":["IMAGE"],"filename_prefix":["STRING"]}}}});
        assert!(dependencies(&v,&info).ready);let mut bad=v.clone();bad["graph"]["1"]["inputs"]["seed"]=101.into();assert!(!dependencies(&bad,&info).ready);
    }
    #[test] fn selected_output_contract_participates_in_ledger_digest(){
        let a=execution();let mut b=a.clone();b["output"]["nodeId"]="1".into();
        assert_ne!(super::super::submission_digest(&a,&[]).unwrap(),super::super::submission_digest(&b,&[]).unwrap());
    }
}
