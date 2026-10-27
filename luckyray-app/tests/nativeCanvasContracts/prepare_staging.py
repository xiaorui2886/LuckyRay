#!/usr/bin/env python3
"""Compile actual staging function; local filesystem safety shims are NOT security proof."""
from pathlib import Path
import hashlib,json,re,sys
root=Path(__file__).resolve().parents[2]
source=(root/'src-tauri/src/dsh_host.rs').read_bytes().decode('utf-8')
seam=source[source.index('fn materialize_surface_modules('):source.index('fn prepare_dsh_state_roots(')]
tracked=source[source.index('    fn tracked_surface_assets()'):source.index('    fn canvas_timeout_test_frame(')]
# Preserve the actual tracked array while substituting only the fixture root.
tracked=tracked.replace('env!("CARGO_MANIFEST_DIR")',json.dumps(str(root/'src-tauri')))
out=Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/luckyray-native-canvas-staging');(out/'src').mkdir(parents=True,exist_ok=True)
shims=r'''
use std::path::{Path,PathBuf};
use std::io::Write;
use sha2::{Digest,Sha256};
// Explicit harness shims: no Windows reparse-point/StableFileLease coverage.
fn safe_directory(p:&Path)->bool {std::fs::symlink_metadata(p).map(|m|m.is_dir()&&!m.file_type().is_symlink()).unwrap_or(false)}
fn safe_regular_file(p:&Path)->bool {std::fs::symlink_metadata(p).map(|m|m.is_file()&&!m.file_type().is_symlink()).unwrap_or(false)}
'''
runner=r'''
fn main() {
 let root=PathBuf::from(std::env::args().nth(1).expect("temporary output root required"));
 assert!(!root.exists(),"use fresh temporary output directory");
 let assets=tracked_surface_assets();
 let (paths,digests)=materialize_surface_modules(&root,&assets).expect("stage all actual modules");
 assert_eq!(paths.len(),15);assert_eq!(digests.len(),15);
 let source_indexes=[10,0,9,11,1,2,4,5,6,7,8,12,13,14,15];
 for (i,p) in paths.iter().enumerate(){assert_eq!(std::fs::read(p).unwrap(),std::fs::read(&assets[source_indexes[i]]).unwrap());assert_eq!(digests[i],format!("{:x}",Sha256::digest(std::fs::read(p).unwrap())));}
 let again=materialize_surface_modules(&root,&assets).unwrap();assert_eq!(paths,again.0);assert_eq!(digests,again.1);
 std::fs::write(&paths[14],b"corrupt").unwrap();let repaired=materialize_surface_modules(&root,&assets).unwrap();assert_eq!(repaired.1,digests);assert_eq!(std::fs::read(&paths[14]).unwrap(),std::fs::read(&assets[15]).unwrap());
 // Reject oversize/empty module data, without claiming admission or Windows sealing coverage.
 let invalid=root.join("oversized.mjs");std::fs::write(&invalid,vec![b'x';256*1024+1]).unwrap();let mut bad=assets.clone();bad[15]=invalid.clone();assert!(materialize_surface_modules(&root,&bad).is_err());
 std::fs::write(&invalid,b"").unwrap();assert!(materialize_surface_modules(&root,&bad).is_err());
 println!("{}",serde_json::json!({"passed":true,"stagedModules":15,"byteEquality":true,"sha256Equality":true,"idempotentRestaging":true,"corruptionRepair":true,"oversizeRejected":true,"emptyRejected":true,"filesystemSafety":"test shims only; Windows sealing/reparse protection not tested","paths":paths}));
}
'''
(out/'src/main.rs').write_text(shims+seam+tracked+runner,encoding='utf-8',newline='')
(out/'Cargo.toml').write_text('[package]\nname="luckyray-native-canvas-staging"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nsha2="0.10"\nserde_json="1"\n')
proof={'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),'exactStagingFunctionSha256':hashlib.sha256(seam.encode()).hexdigest(),'scope':'Actual materialize_surface_modules function and tracked asset array, local filesystem safety shims; not native security, Tauri, or GUI validation.'}
(out/'source-proof.json').write_text(json.dumps(proof,indent=2));print(json.dumps(proof))
