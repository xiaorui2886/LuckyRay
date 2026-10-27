#!/usr/bin/env python3
"""Extract unmodified native canvas contract seams; no Tauri/GUI substitution claims."""
from pathlib import Path
import hashlib,json,sys
root=Path(__file__).resolve().parents[2]
source=(root/'src-tauri/src/dsh_host.rs').read_bytes().decode('utf-8')
out=Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/luckyray-native-canvas-contracts')
(out/'src').mkdir(parents=True,exist_ok=True)
constants='\n'.join(line for line in source.splitlines() if line.startswith('const MAX_CANVAS_AGENT_'))
seam=source[source.index('fn canvas_agent_id('):source.index('#[derive(Deserialize)]',source.index('fn decode_canvas_agent_snapshot('))]
runner=r'''
fn main() {
 use std::io::BufRead;
 for line in std::io::stdin().lock().lines() {
  let q:serde_json::Value=serde_json::from_str(&line.unwrap()).unwrap();
  let v=&q["value"];
  let result=match q["mode"].as_str().unwrap() {
   "creation" => canvas_creation_valid(v,q["kind"].as_str().unwrap()),
   "schema" => canvas_creation_schema_match(v,&q["schema"]),
   "context" => canvas_agent_context_valid(v,"canvas-1",true),
   "request" => encode_canvas_agent_request(v).is_ok(),
   "snapshot" => decode_canvas_agent_snapshot(&URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap()),"canvas-1").is_ok(),
   _=>panic!("unknown harness mode"),
  };
  println!("{}",result);
 }
}
'''
(out/'src/main.rs').write_text('use base64::{Engine as _,engine::general_purpose::URL_SAFE_NO_PAD};\n'+constants+'\n'+seam+runner,encoding='utf-8',newline='')
(out/'Cargo.toml').write_text('[package]\nname="luckyray-native-canvas-contracts"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nserde_json="1"\nbase64="0.22"\n')
report={'source':str(root/'src-tauri/src/dsh_host.rs'),'sha256':hashlib.sha256(source.encode()).hexdigest(),'extractedSha256':hashlib.sha256(seam.encode()).hexdigest(),'crate':str(out),'method':'Exact contiguous production functions, no rewritten native validators; base64/serde_json actual crates. Does not compile full Tauri or GUI.'}
(out/'source-proof.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
