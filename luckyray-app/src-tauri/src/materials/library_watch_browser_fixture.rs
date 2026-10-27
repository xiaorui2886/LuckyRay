//! Test-only stdio adapter for real Windows notification -> Catalog -> browser tests.
//! No product route and no access to the installed application's profile.
use super::*;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn emit(value: Value) { println!("WATCH_FIXTURE {}", value); }

#[test]
#[ignore = "driven by tests/materialWatchEvents.native-browser.cjs"]
fn library_watch_events_browser_fixture() {
    let base = MaterialCatalog::new_for_test();
    let root = base.app_data_dir().join("合成 自动导入");
    std::fs::create_dir_all(&root).unwrap();
    let library = base.create_library("事件联验合成库", &root, "managed").unwrap();
    base.select_library(&library.id).unwrap();
    let scoped = base.for_library(&library.id).unwrap();
    let root = scoped.library_watch_root().unwrap();
    for i in 0..50 { std::fs::write(root.join(format!("seed-{i:02}.txt")), format!("synthetic initial {i}")).unwrap(); }
    scoped.import_library_watch_root(&root).unwrap();
    emit(json!({"ready":true,"root":root,"libraryId":library.id}));
    let mut workers = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if value["command"] == "stop" { break; }
        let base=base.clone();let root=root.clone();let library_id=library.id.clone();
        workers.push(std::thread::spawn(move || {
            let sequence=value["sequence"].clone();
            let result: Result<Value,String> = (|| {
                if let Some(scenario)=value["scenario"].as_str() {
                    let paths:Vec<_> = match scenario {
                        "single" => vec![("single.txt".to_owned(),"one synthetic".to_owned())],
                        "batch" => (0..20).map(|i|(format!("batch-{i}.txt"),format!("batch synthetic {i}"))).collect(),
                        "duplicate" => vec![("copy-of-single.txt".into(),"one synthetic".into())],
                        "same-name" => { std::fs::create_dir_all(root.join("sub")).unwrap();vec![("sub/single.txt".into(),"distinct content same name".into())] },
                        "off" => vec![("off.txt".into(),"while disabled".into())],
                        "large" => {
                            let mut writer=std::fs::File::create(root.join("large.bin")).unwrap();
                            let chunk=vec![0x51u8;4*1024*1024];
                            writer.write_all(&chunk).unwrap();writer.flush().unwrap();
                            emit(json!({"stage":"copy-open-paused","scenario":scenario,"at":chrono::Utc::now().timestamp_millis()}));
                            std::thread::sleep(std::time::Duration::from_millis(2400));
                            for _ in 0..15 { writer.write_all(&chunk).unwrap();writer.flush().unwrap();std::thread::sleep(std::time::Duration::from_millis(100)); }
                            writer.sync_all().unwrap();drop(writer);
                            Vec::new()
                        }
                        _ => return Err("unknown-fixture-scenario".into()),
                    };
                    for (name,content) in &paths { std::fs::write(root.join(name),content).unwrap(); }
                    let finished=chrono::Utc::now().timestamp_millis();
                    emit(json!({"stage":"copy-complete","scenario":scenario,"at":finished}));
                    return Ok(json!({"finishedAt":finished}));
                }
                let raw=&value["request"];
                let request: LibraryRequest=serde_json::from_value(raw.clone()).map_err(|e|e.to_string())?;
                match &request.action {
                    LibraryAction::WatchLibraryRoot{expected_root,..}=>{
                        if request.library_id.as_deref()!=Some(&library_id){return Err("fixture-library-mismatch".into());}
                        let channel=raw["action"]["channel"].as_str().unwrap().to_owned();
                        let c=base.for_library(&library_id).map_err(|e|e.message)?;
                        start_library_root_watch(&c,std::path::Path::new(expected_root),move|event|{
                            emit(json!({"channel":channel,"event":event,"at":chrono::Utc::now().timestamp_millis()}));
                        }).map(Value::String)
                    }
                    LibraryAction::UnwatchLibraryRoot{token}=>{
                        stop_library_root_watch(&base,&library_id,token)?;Ok(Value::Null)
                    }
                    _=>execute_library_request(base,request),
                }
            })();
            emit(match result {Ok(result)=>json!({"sequence":sequence,"result":result}),Err(error)=>json!({"sequence":sequence,"error":error})});
        }));
    }
    for worker in workers { worker.join().unwrap(); }
}
