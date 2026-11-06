#!/usr/bin/env python3
"""Actual local preview function + shared renderer, synthetic catalog boundary.
No full Tauri/Windows runtime claim. Use --check-windows for compile-only validation.
"""
from pathlib import Path
import json, subprocess, sys, tempfile, tomllib
root=Path(__file__).resolve().parents[1]
source=(root/'src-tauri/src/material_file_preview.rs').read_text()
shape=source[source.index('#[derive(Serialize)]'):source.index('#[tauri::command]')]
body=source[source.index('fn read_preview('):]
lock=tomllib.loads((root/'src-tauri/Cargo.lock').read_text())
versions={p['name']:p['version'] for p in lock['package'] if p['name'] in ['image','zip','serde','base64','tempfile']}
manifest='''[package]
name="local-material-preview-check"
version="0.0.0"
edition="2021"
[features]
default=["browser-host-runtime"]
browser-host-runtime=[]
[dependencies]
image={version="=%s",default-features=false,features=["bmp","gif","jpeg","png","webp"]}
zip={version="=%s",default-features=false,features=["deflate"]}
serde={version="=%s",features=["derive"]}
base64="=%s"
tempfile="=%s"
[target.'cfg(windows)'.dependencies]
windows={version="=0.61.3",features=["Win32_Foundation","Win32_Graphics_Gdi","Win32_Storage_FileSystem","Win32_System_Com","Win32_UI_Shell"]}
''' % tuple(versions[n] for n in ['image','zip','serde','base64','tempfile'])
stubs=r'''
#![allow(dead_code)]
use serde::Serialize;
struct Error { message:String }
struct Asset { name:String,kind:String }
struct MaterialCatalog { path:std::path::PathBuf,name:String,kind:String,text:Option<String>,requested:std::cell::Cell<usize> }
impl MaterialCatalog {
 fn read_agent_text_preview(&self,id:&str,max:usize)->Result<Option<(String,bool)>,Error>{
  if id!="authorized" {return Err(Error{message:"not-found".into()})}self.requested.set(max);
  Ok(self.text.as_ref().map(|text|{let n=text.len().min(max);(text[..n].to_owned(),n<text.len())}))
 }
 fn companion_resource(&self,id:&str,_:bool)->Result<(Asset,std::fs::File),Error>{
  if id!="authorized" {return Err(Error{message:"not-found".into()})}
  Ok((Asset{name:self.name.clone(),kind:self.kind.clone()},std::fs::File::open(&self.path).map_err(|e|Error{message:e.to_string()})?))
 }
}
'''
tests=r'''
#[cfg(test)]mod tests {
 use super::*;use std::io::Write;
 fn catalog(path:&std::path::Path,name:&str,kind:&str,text:Option<String>)->MaterialCatalog { MaterialCatalog{path:path.to_owned(),name:name.into(),kind:kind.into(),text,requested:std::cell::Cell::new(0)} }
 #[test]fn short_detail_is_full_text_not_card_excerpt(){let c=catalog(std::path::Path::new("unused"),"note.txt","document",Some("a".repeat(2000)));let p=read_preview(&c,"authorized",true).unwrap().unwrap();assert_eq!(p.kind,"text");assert_eq!(p.text.unwrap().len(),2000);assert!(!p.truncated);assert_eq!(c.requested.get(),65536);}
 #[test]fn card_is_small_and_detail_truncation_is_explicit(){let c=catalog(std::path::Path::new("unused"),"note.txt","document",Some("a".repeat(70000)));let p=read_preview(&c,"authorized",false).unwrap().unwrap();assert_eq!(p.text.unwrap().len(),600);assert!(p.truncated);assert_eq!(c.requested.get(),4096);let p=read_preview(&c,"authorized",true).unwrap().unwrap();assert_eq!(p.text.unwrap().len(),65536);assert!(p.truncated);}
 #[test]fn not_authorized_asset_does_not_read(){let c=catalog(std::path::Path::new("unused"),"note.txt","document",Some("secret".into()));assert!(read_preview(&c,"other",true).is_err());assert_eq!(c.requested.get(),0);}
 #[test]fn unsupported_original_is_not_returned_as_preview(){let mut f=tempfile::NamedTempFile::new().unwrap();f.write_all(b"private original").unwrap();let c=catalog(f.path(),"data.bin","other",None);assert!(read_preview(&c,"authorized",false).unwrap().is_none());}
 #[test]fn old_image_video_paths_remain_outside_new_renderer(){let f=tempfile::NamedTempFile::new().unwrap();for kind in ["image","video"]{let c=catalog(f.path(),"media.png",kind,None);assert!(read_preview(&c,"authorized",false).unwrap().is_none());}}
 #[test]fn office_cover_is_data_png_not_original_file_url(){let mut f=tempfile::NamedTempFile::new().unwrap();let mut image=std::io::Cursor::new(vec![]);image::DynamicImage::new_rgb8(20,30).write_to(&mut image,image::ImageFormat::Png).unwrap();{let mut zip=zip::ZipWriter::new(f.as_file_mut());zip.start_file("docProps/thumbnail.png",zip::write::SimpleFileOptions::default()).unwrap();zip.write_all(&image.into_inner()).unwrap();zip.finish().unwrap();}let c=catalog(f.path(),"test.pptx","document",None);let p=read_preview(&c,"authorized",false).unwrap().unwrap();assert_eq!(p.kind,"image");assert!(p.preview_uri.unwrap().starts_with("data:image/png;base64,"));assert!(p.text.is_none());}
}
'''
with tempfile.TemporaryDirectory(prefix='lr-local-preview-check-') as t:
 p=Path(t);(p/'src').mkdir();(p/'Cargo.toml').write_text(manifest)
 # Test the same locked versions as the application, rather than re-resolving
 # dependencies (which rejects a yanked version already locked by the project).
 (p/'Cargo.lock').write_bytes((root/'src-tauri/Cargo.lock').read_bytes())
 (p/'src/lib.rs').write_text(stubs+'\n#[path='+json.dumps(str(root/'src-tauri/src/companion_gateway/content/preview.rs'))+']\nmod preview;\n'+shape+body+tests)
 command=['cargo','check','--tests','--target','x86_64-pc-windows-gnu'] if '--check-windows' in sys.argv else ['cargo','test']
 subprocess.run(command+['--manifest-path',str(p/'Cargo.toml')],check=True)
