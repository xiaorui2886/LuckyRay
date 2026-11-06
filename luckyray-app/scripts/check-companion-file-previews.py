#!/usr/bin/env python3
"""Compile actual preview + extracted unchanged-shape routes with synthetic catalog/IPC boundaries.
No app build, real authorization, Windows provider or network claim.
"""
from pathlib import Path
import json, os, subprocess, sys, tempfile, tomllib
root = Path(__file__).resolve().parents[1]
source = (root/'src-tauri/src/companion_gateway/content.rs').read_text()
preview = root/'src-tauri/src/companion_gateway/content/preview.rs'
# Exact production function slices (not reimplemented route logic).
def between(start,end):return source[source.index(start):source.index(end)]
parts=[between('fn decode(', 'fn asset_value('),between('fn json_route(', 'fn byte_range('),between('fn mime(', '/// Keep a Windows'),between('pub(crate) fn open_resource(', '/// Legacy requests')]
routes='\n'.join(parts).replace('include_str!(\n                "../../../protocol/companion-v1/content-v1/capabilities.json"\n            )','"{}"')
lock=tomllib.loads((root/'src-tauri/Cargo.lock').read_text())
versions={p['name']:p['version'] for p in lock['package'] if p['name'] in ['image','zip','sha2','serde_json','tempfile']}
manifest='''[package]
name="companion-file-preview-check"
version="0.0.0"
edition="2021"
[features]
default=["browser-host-runtime"]
browser-host-runtime=[]
[dependencies]
image={version="=%s",default-features=false,features=["bmp","gif","jpeg","png","webp"]}
zip={version="=%s",default-features=false,features=["deflate"]}
sha2="=%s"
serde_json="=%s"
tempfile="=%s"
[target.'cfg(windows)'.dependencies]
windows={version="=0.61.3",features=["Win32_Foundation","Win32_Graphics_Gdi","Win32_Storage_FileSystem","Win32_System_Com","Win32_UI_Shell"]}
''' % tuple(versions[n] for n in ['image','zip','sha2','serde_json','tempfile'])
stubs=r'''
#![allow(dead_code)]
use std::{collections::{HashMap,HashSet}, fs, io::{self,Read,Write,Seek,SeekFrom}, path::{Path,PathBuf}};
use serde_json::{json,Value};use sha2::{Sha256,Digest};
type ContentResult<T>=Result<T,(u16,&'static str)>;
#[derive(Clone)]struct MaterialAsset{id:String,name:String,kind:String,updated_at:String}
#[derive(Default)]struct MaterialFilter{query:Option<String>,kinds:Vec<String>,folder_id:Option<String>,tag_ids:Vec<String>,limit:Option<u32>}
#[derive(Default)]struct MaterialQueryScope;
struct Catalog{path:PathBuf,asset:MaterialAsset,text:Option<String>}
impl Catalog{
 fn companion_resource(&self,id:&str,_:bool)->Result<(MaterialAsset,fs::File),()>{if id!=self.asset.id{return Err(())}Ok((self.asset.clone(),fs::File::open(&self.path).map_err(|_|())?))}
 fn read_agent_text_preview(&self,id:&str,_:usize)->Result<Option<(String,bool)>,()>{if id!=self.asset.id{return Err(())}Ok(self.text.clone().map(|t|(t,false)))}
 fn list_folders(&self)->Result<Vec<Value>,()>{Ok(vec![])} fn list_tags(&self)->Result<Vec<Value>,()>{Ok(vec![])}
 fn list_assets_page_scoped(&self,_:&MaterialFilter,_:&MaterialQueryScope,_:u64)->Result<Vec<MaterialAsset>,()>{Ok(vec![])}
 fn get_assets(&self,ids:&[String])->Result<Vec<MaterialAsset>,()>{Ok(if ids.contains(&self.asset.id){vec![self.asset.clone()]}else{vec![]})}
 fn get_asset_tags(&self,_:&str)->Result<Vec<Value>,()>{Ok(vec![])}
}
struct Backend(PathBuf);impl Backend{fn app_data_dir(&self)->PathBuf{self.0.clone()}}
struct CompanionGateway{catalog:Catalog,backend:Backend}impl CompanionGateway{fn material_catalog(&self)->&Catalog{&self.catalog}}
struct HttpRequest{method:String,path:String}
fn asset_value_with_favorite(a:&MaterialAsset,_:&HashSet<String>)->Value{json!({"desktopAssetId":a.id})}
fn favorite_ids(_:&CompanionGateway)->ContentResult<HashSet<String>>{Ok(HashSet::new())}
fn random_hex(_:usize)->String{"synthetic".into()}
mod notes{use super::*;pub(super) fn read_route(_:&CompanionGateway,_:&HttpRequest)->ContentResult<Value>{Err((404,"NOT_FOUND"))}pub(super) fn mutate_route(g:&CompanionGateway,r:&HttpRequest)->ContentResult<Value>{read_route(g,r)}pub(super) fn resource(_:&CompanionGateway,_:&HttpRequest)->ContentResult<(fs::File,String,String)>{Err((404,"NOT_FOUND"))}}
mod materials{use super::*;pub(super) fn mutate_route(_:&CompanionGateway,_:&HttpRequest)->ContentResult<Value>{Err((405,"METHOD_NOT_ALLOWED"))}}
'''
tests=r'''
#[cfg(test)]mod route_tests{
 use super::*;
 fn request(path:&str)->HttpRequest{HttpRequest{method:"GET".into(),path:path.into()}}
 fn gateway(root:&Path,name:&str,kind:&str,bytes:&[u8])->CompanionGateway{let path=root.join(name);fs::write(&path,bytes).unwrap();CompanionGateway{catalog:Catalog{path,asset:MaterialAsset{id:"a1".into(),name:name.into(),kind:kind.into(),updated_at:"v1".into()},text:None},backend:Backend(root.to_owned())}}
 #[test]fn text_preview_routes_to_json_and_is_bounded(){let d=tempfile::tempdir().unwrap();let mut g=gateway(d.path(),"doc.txt","document",b"text");g.catalog.text=Some("你".repeat(601));let r=request("/v1/assets/a1/preview");assert!(resource(&g,&r).unwrap().is_none());let value=json_route(&g,&r).unwrap();assert_eq!(value["kind"],"text");assert_eq!(value["text"].as_str().unwrap().chars().count(),600);assert_eq!(value["truncated"],true);assert_eq!(value.as_object().unwrap().len(),3);}
 #[test]fn unavailable_text_and_bad_asset_are_truthful(){let d=tempfile::tempdir().unwrap();let g=gateway(d.path(),"doc.pdf","document",b"pdf");assert_eq!(json_route(&g,&request("/v1/assets/a1/preview")),Err((404,"PREVIEW_UNAVAILABLE")));assert_eq!(json_route(&g,&request("/v1/assets/../preview")),Err((404,"NOT_FOUND")));assert_eq!(json_route(&g,&request("/v1/assets/a1/preview?path=x")),Err((400,"INVALID_QUERY")));}
 #[test]fn png_resource_remains_real_png_and_cached(){let d=tempfile::tempdir().unwrap();let mut bytes=io::Cursor::new(vec![]);image::DynamicImage::new_rgb8(768,384).write_to(&mut bytes,image::ImageFormat::Png).unwrap();let g=gateway(d.path(),"image.png","image",&bytes.into_inner());let r=request("/v1/assets/a1/thumbnail");let (mut f,mime,version)=resource(&g,&r).unwrap().unwrap();assert_eq!(mime,"image/png");let mut data=vec![];f.read_to_end(&mut data).unwrap();assert_eq!(image::load_from_memory(&data).unwrap().width(),384);assert_eq!(resource(&g,&r).unwrap().unwrap().2,version);}
 #[test]fn office_thumbnail_route_reads_cover_not_original(){let d=tempfile::tempdir().unwrap();let mut image=io::Cursor::new(vec![]);image::DynamicImage::new_rgb8(600,900).write_to(&mut image,image::ImageFormat::Png).unwrap();let mut bytes=io::Cursor::new(vec![]);{let mut zip=zip::ZipWriter::new(&mut bytes);zip.start_file("docProps/thumbnail.png",zip::write::SimpleFileOptions::default()).unwrap();zip.write_all(&image.into_inner()).unwrap();zip.finish().unwrap();}let g=gateway(d.path(),"deck.pptx","document",&bytes.into_inner());let (mut file,mime,_)=resource(&g,&request("/v1/assets/a1/thumbnail")).unwrap().unwrap();assert_eq!(mime,"image/png");let mut result=vec![];file.read_to_end(&mut result).unwrap();let image=image::load_from_memory(&result).unwrap();assert_eq!((image.width(),image.height()),(256,384));}
 #[test]fn unknown_format_does_not_return_original_or_fake_icon(){let d=tempfile::tempdir().unwrap();let g=gateway(d.path(),"data.bin","other",b"private original");assert!(matches!(resource(&g,&request("/v1/assets/a1/thumbnail")),Err((404,"PREVIEW_UNAVAILABLE"))));let(_,mime,_)=resource(&g,&request("/v1/assets/a1/file")).unwrap().unwrap();assert_eq!(mime,"application/octet-stream");}
}
'''
with tempfile.TemporaryDirectory(prefix='lr-file-preview-check-') as temp:
 p=Path(temp);(p/'src').mkdir();(p/'Cargo.toml').write_text(manifest)
 # Reuse the project's locked dependency versions, including yanked versions
 # already present in its lockfile. Do not resolve a different test dependency set.
 (p/'Cargo.lock').write_bytes((root/'src-tauri/Cargo.lock').read_bytes())
 (p/'src/lib.rs').write_text(stubs+'\n#[path='+json.dumps(str(preview))+']\nmod preview;\n'+routes+tests)
 command = ['cargo','check','--tests','--target','x86_64-pc-windows-gnu'] if '--check-windows' in sys.argv else ['cargo','test']
 subprocess.run(command + ['--manifest-path',str(p/'Cargo.toml')],check=True)
