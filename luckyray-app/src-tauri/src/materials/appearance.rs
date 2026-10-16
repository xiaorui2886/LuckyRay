//! UI-only derived cache. Catalog membership and its physical-file resolver remain authoritative.
//! Prepared features are transient; the UI checks its generation before committing a token.
use super::{appearance_descriptor::{self as pixels, Descriptor, Distance}, MaterialCatalog, MaterialError, MaterialResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs::{File, OpenOptions}, io::{Read, Write}, path::PathBuf,
    sync::{Mutex, OnceLock}, time::{Duration, Instant, UNIX_EPOCH}};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    algorithm: String, library_id: String, asset_id: String, fingerprint: String, descriptor: Descriptor,
}
struct Prepared { db: PathBuf, entry: Entry, created: Instant }
static PREPARED: OnceLock<Mutex<HashMap<String, Prepared>>> = OnceLock::new();
fn prepared() -> &'static Mutex<HashMap<String, Prepared>> { PREPARED.get_or_init(|| Mutex::new(HashMap::new())) }
fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Prepared>> { prepared().lock().unwrap_or_else(std::sync::PoisonError::into_inner) }
fn error(code: &str, message: impl Into<String>) -> MaterialError { MaterialError::new(code, message) }
fn digest(value: impl Serialize) -> String { format!("{:x}", Sha256::digest(serde_json::to_vec(&value).expect("serializable cache identity"))) }
fn id_valid(id: &str) -> bool { !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control) }
fn scope(c: &MaterialCatalog) -> MaterialResult<String> {
    let id = c.library_id.as_ref().ok_or_else(|| error("appearance-library-required", "外观检索需要明确的素材库"))?;
    c.for_library(id)?; Ok(id.clone())
}
fn source(c: &MaterialCatalog, id: &str) -> MaterialResult<(File, String)> {
    if !id_valid(id) { return Err(error("appearance-id-invalid", "素材身份无效")); }
    scope(c)?;
    let a = c.get_ordinary_export_asset(id)?;
    if a.kind != "image" { return Err(error("appearance-format-unsupported", "外观检索仅支持普通图片素材")); }
    let path = c.resolve_export_file(&a)?;
    // Uses the same read-only/ownership gate as Catalog export, never a displayed thumbnail URL.
    let file = crate::companion_gateway::content::open_resource(&path)
        .map_err(|_| error("appearance-source-unavailable", "图片原文件不可用"))?;
    let meta = file.metadata().map_err(|_| error("appearance-source-unavailable", "无法读取图片属性"))?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > pixels::MAX_BYTES as u64 {
        return Err(error("appearance-source-limit", "图片为空、非普通文件或超过12MiB"));
    }
    let identity = super::catalog::export_file_identity(&file)?;
    let modified = meta.modified().map_err(|_| error("appearance-source-unavailable", "无法复核图片更新时间"))?
        .duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos().to_string();
    // This is an invalidation hint, not byte equality proof. No private paths are stored in the cache.
    let fingerprint = digest((identity, meta.len(), modified, path, a.content_hash));
    Ok((file, fingerprint))
}
fn cache_path(c: &MaterialCatalog, library: &str, id: &str) -> PathBuf {
    c.app_data_dir().join("cache").join("material-appearance-v1")
        .join(format!("{}.json", digest((library,id,pixels::ALGORITHM))))
}
fn reparse(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path).map(|m| {
        #[cfg(windows)] { use std::os::windows::fs::MetadataExt; m.file_attributes() & 0x400 != 0 }
        #[cfg(not(windows))] { m.file_type().is_symlink() }
    }).unwrap_or(false)
}
fn cached(c: &MaterialCatalog, library: &str, id: &str, fingerprint: &str) -> Option<Entry> {
    let path = cache_path(c,library,id);
    if reparse(&path) || reparse(path.parent()?) || reparse(path.parent()?.parent()?) { return None; }
    let mut bytes = Vec::new(); File::open(path).ok()?.take(16_385).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 16_384 { return None; }
    let e: Entry = serde_json::from_slice(&bytes).ok()?;
    (e.algorithm == pixels::ALGORITHM && e.library_id == library && e.asset_id == id
        && e.fingerprint == fingerprint && e.descriptor.valid()).then_some(e)
}
fn write_cache(c: &MaterialCatalog, e: &Entry) -> MaterialResult<()> {
    let path = cache_path(c,&e.library_id,&e.asset_id);
    let app_root = super::catalog::canonical_trusted_root(c.app_data_dir())?;
    for dir in [app_root.join("cache"), app_root.join("cache").join("material-appearance-v1")] {
        if !dir.exists() { std::fs::create_dir(&dir).map_err(|_| error("appearance-cache-unavailable", "无法创建派生缓存目录"))?; }
        if reparse(&dir) || !super::catalog::canonical_trusted_root(&dir)?.starts_with(&app_root) {
            return Err(error("appearance-cache-unavailable", "派生缓存目录不可信"));
        }
    }
    if reparse(&path) { return Err(error("appearance-cache-unavailable", "派生缓存文件不可信")); }
    let temp = path.with_extension(format!("{}.partial", super::catalog::unique_id("appearance")));
    let result = (|| {
        let bytes = serde_json::to_vec(e).map_err(|_| error("appearance-cache-invalid", "派生特征无法序列化"))?;
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)
            .map_err(|_| error("appearance-cache-unavailable", "无法写入派生缓存"))?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| error("appearance-cache-unavailable", "派生缓存保存失败"))?;
        if source(c,&e.asset_id)?.1 != e.fingerprint { return Err(error("appearance-source-changed", "图片已变化，请重新建立该项索引")); }
        std::fs::rename(&temp,&path).map_err(|_| error("appearance-cache-unavailable", "派生缓存提交失败"))?;
        Ok(())
    })();
    if temp.exists() { let _ = std::fs::remove_file(&temp); }
    result
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreparedResult { library_id: String, asset_id: String, algorithm: String, cached: bool, token: Option<String> }
pub(super) fn prepare(c: &MaterialCatalog, id: &str) -> MaterialResult<PreparedResult> {
    let library = scope(c)?;
    let (mut file, before) = source(c,id)?;
    if cached(c,&library,id,&before).is_some() {
        return Ok(PreparedResult { library_id: library, asset_id: id.into(), algorithm: pixels::ALGORITHM.into(), cached:true, token:None });
    }
    let mut bytes = Vec::new(); (&mut file).take(pixels::MAX_BYTES as u64 + 1).read_to_end(&mut bytes)
        .map_err(|_| error("appearance-source-unavailable", "图片读取失败"))?;
    let descriptor = pixels::describe(&bytes).map_err(|e| error("appearance-decode-failed", e))?;
    if source(c,id)?.1 != before { return Err(error("appearance-source-changed", "计算特征时图片发生变化，该项未提交")); }
    let mut state = lock(); state.retain(|_,p| p.created.elapsed() < Duration::from_secs(60));
    if state.len() >= 128 { return Err(error("appearance-busy", "暂存特征已满，请稍后重试")); }
    let token = super::catalog::unique_id("appearance");
    state.insert(token.clone(),Prepared { db:c.db_path().into(), created:Instant::now(),
        entry:Entry { algorithm:pixels::ALGORITHM.into(), library_id:library.clone(), asset_id:id.into(), fingerprint:before, descriptor } });
    Ok(PreparedResult { library_id:library, asset_id:id.into(), algorithm:pixels::ALGORITHM.into(), cached:false, token:Some(token) })
}
pub(super) fn commit(c: &MaterialCatalog, token: &str) -> MaterialResult<()> {
    if !id_valid(token) { return Err(error("appearance-token-invalid", "暂存身份无效")); }
    let library = scope(c)?;
    let mut state = lock();
    let p = state.get(token).ok_or_else(|| error("appearance-token-expired", "暂存特征已过期，请重新计算"))?;
    if p.db != c.db_path() || p.entry.library_id != library { return Err(error("appearance-library-denied", "暂存特征属于其他素材库")); }
    let p = state.remove(token).unwrap();
    if p.created.elapsed() >= Duration::from_secs(60) { return Err(error("appearance-token-expired", "暂存特征已过期，请重新计算")); }
    write_cache(c,&p.entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::materials::{MaterialBytesInput,MaterialImportOptions};
    fn fixture()->(tempfile::TempDir,MaterialCatalog) {
        let root=tempfile::tempdir().unwrap();let base=MaterialCatalog::new_for_test_at(root.path());
        let id=base.library_state().unwrap().0;let c=base.for_library(&id).unwrap();(root,c)
    }
    fn image(c:&MaterialCatalog,name:&str)->String {
        let input=MaterialBytesInput {name:name.into(),original_path:format!("browser:{name}"),mime_type:"image/png".into(),
            bytes:include_bytes!("../../../tests/fixtures/material-appearance/oriented-expected.png").to_vec(),description:None};
        c.import_bytes(vec![input],&MaterialImportOptions::default()).unwrap().value.assets.remove(0).id
    }
    fn index(c:&MaterialCatalog,id:&str) { let p=prepare(c,id).unwrap();if let Some(token)=p.token {commit(c,&token).unwrap();} }
    #[test]
    fn appearance_cache_restart_corruption_and_source_invalidation() {
        let (_root,c)=fixture();let id=image(&c,"图.png");
        let original=c.resolve_export_file(&c.get_ordinary_export_asset(&id).unwrap()).unwrap();
        let before=std::fs::read(&original).unwrap();index(&c,&id);assert!(prepare(&c,&id).unwrap().cached);
        let restart=MaterialCatalog::new(c.db_path(),c.app_data_dir()).for_library(&scope(&c).unwrap()).unwrap();
        assert!(prepare(&restart,&id).unwrap().cached);
        let path=cache_path(&c,&scope(&c).unwrap(),&id);
        let text=std::fs::read_to_string(&path).unwrap();assert!(!text.contains(&c.app_data_dir().to_string_lossy().to_string()));
        std::fs::write(&path,b"{corrupt-cache").unwrap();assert!(!prepare(&c,&id).unwrap().cached);index(&c,&id);
        let mut changed=before.clone();changed.push(0);std::fs::write(&original,&changed).unwrap();
        let result=query(&c,vec![id.clone()],QueryInput::Bytes{bytes:before.clone()},1.0).unwrap();
        assert_eq!(result.unindexed,1);assert!(result.hits.is_empty());
        let p=prepare(&c,&id).unwrap();changed.push(0);std::fs::write(&original,&changed).unwrap();
        assert_eq!(commit(&c,&p.token.unwrap()).unwrap_err().code,"appearance-source-changed");
    }
    #[test]
    fn appearance_library_scope_deletion_and_token_fences() {
        let (_root,a)=fixture();let id=image(&a,"A.png");
        let second=a.app_data_dir().join("B");std::fs::create_dir(&second).unwrap();
        let b_id=a.create_library("B",&second,"managed").unwrap().id;let b=a.for_library(&b_id).unwrap();
        let token=prepare(&a,&id).unwrap().token.unwrap();
        assert_eq!(commit(&b,&token).unwrap_err().code,"appearance-library-denied");
        assert!(prepare(&b,&id).is_err());commit(&a,&token).unwrap();
        let foreign=query(&b,vec![id.clone()],QueryInput::Bytes{bytes:include_bytes!("../../../tests/fixtures/material-appearance/oriented-expected.png").to_vec()},1.0).unwrap();
        assert!(foreign.hits.is_empty());assert_eq!(foreign.failures.len(),1);
        a.delete_asset(&id,false).unwrap();
        let deleted=query(&a,vec![id],QueryInput::Bytes{bytes:include_bytes!("../../../tests/fixtures/material-appearance/oriented-expected.png").to_vec()},1.0).unwrap();
        assert!(deleted.hits.is_empty());assert_eq!(deleted.failures.len(),1);
    }
    #[test]
    fn appearance_query_is_read_only_and_single_anchor_is_excluded() {
        let (_root,c)=fixture();let id=image(&c,"source.png");
        let original=c.resolve_export_file(&c.get_ordinary_export_asset(&id).unwrap()).unwrap();let bytes=std::fs::read(&original).unwrap();
        let result=query(&c,vec![id.clone()],QueryInput::Bytes{bytes:bytes.clone()},1.0).unwrap();
        assert_eq!(result.unindexed,1);assert!(!cache_path(&c,&scope(&c).unwrap(),&id).exists());
        index(&c,&id);let result=query(&c,vec![id.clone()],QueryInput::Asset{id:id.clone()},1.0).unwrap();
        assert_eq!(result.excluded_anchor,1);assert_eq!(result.indexed,0);assert!(result.hits.is_empty());
        let result=query(&c,vec![id.clone()],QueryInput::Bytes{bytes:bytes.clone()},1.0).unwrap();
        assert_eq!(result.hits.len(),1);assert_eq!(result.hits[0].distance.total,0.0);
        assert_eq!(std::fs::read(&original).unwrap(),bytes);
        assert!(query(&c,vec![id;97],QueryInput::Bytes{bytes},f64::NAN).is_err());
    }
}
pub(super) fn discard(c: &MaterialCatalog, token: &str) -> MaterialResult<()> {
    if !id_valid(token) { return Err(error("appearance-token-invalid", "暂存身份无效")); }
    let library = c.library_scope_key()?;
    let mut state = lock();
    if let Some(p) = state.get(token) {
        if p.db != c.db_path() || p.entry.library_id != library { return Err(error("appearance-library-denied", "暂存特征属于其他素材库")); }
        state.remove(token);
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(tag="kind",rename_all="camelCase",deny_unknown_fields)]
pub(crate) enum QueryInput { Asset { id: String }, Bytes { bytes: Vec<u8> } }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct Hit { asset_id: String, distance: Distance }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct Failure { asset_id: String, message: String }
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct QueryResult {
    library_id: String, algorithm: String, requested: usize, indexed: usize, unindexed: usize,
    excluded_anchor: usize, failures: Vec<Failure>, hits: Vec<Hit>,
}
pub(super) fn query(c:&MaterialCatalog, ids:Vec<String>, input:QueryInput, maximum_distance:f64) -> MaterialResult<QueryResult> {
    let library = scope(c)?;
    if ids.is_empty() || ids.len() > pixels::MAX_CANDIDATES || ids.iter().any(|id| !id_valid(id))
        || ids.iter().collect::<HashSet<_>>().len() != ids.len() || !maximum_distance.is_finite() || !(0.0..=1.0).contains(&maximum_distance) {
        return Err(error("appearance-input-invalid", "候选须为1–96项不重复素材，外观距离须在0–1之间"));
    }
    let (needle, anchor, anchor_fingerprint) = match input {
        QueryInput::Bytes { bytes } => (pixels::describe(&bytes).map_err(|e| error("appearance-query-invalid",e))?,None,None),
        QueryInput::Asset { id } => {
            let (mut f, before) = source(c,&id)?;
            let mut bytes=Vec::new(); (&mut f).take(pixels::MAX_BYTES as u64+1).read_to_end(&mut bytes).map_err(|_| error("appearance-source-unavailable","查询图片读取失败"))?;
            let d=pixels::describe(&bytes).map_err(|e| error("appearance-query-invalid",e))?;
            if source(c,&id)?.1 != before { return Err(error("appearance-source-changed","查询图片已变化")); }
            (d,Some(id),Some(before))
        }
    };
    let mut result=QueryResult {library_id:library,algorithm:pixels::ALGORITHM.into(),requested:ids.len(),indexed:0,unindexed:0,excluded_anchor:0,failures:vec![],hits:vec![]};
    let mut revisions=HashMap::new();
    for id in ids {
        if anchor.as_ref()==Some(&id) { result.excluded_anchor+=1; continue; }
        match source(c,&id) {
            Ok((_,fingerprint)) => if let Some(e)=cached(c,&result.library_id,&id,&fingerprint) {
                result.indexed+=1; let distance=pixels::distance(&needle,&e.descriptor);
                if distance.total <= maximum_distance { revisions.insert(id.clone(),fingerprint); result.hits.push(Hit {asset_id:id,distance}); }
            } else { result.unindexed+=1; },
            Err(e) => result.failures.push(Failure {asset_id:id,message:e.message}),
        }
    }
    result.hits.sort_by(|a,b| a.distance.total.total_cmp(&b.distance.total).then(a.asset_id.cmp(&b.asset_id)));
    result.hits.truncate(24);
    result.hits.retain(|hit| {
        let unchanged=source(c,&hit.asset_id).is_ok_and(|(_,fingerprint)| revisions.get(&hit.asset_id)==Some(&fingerprint));
        if !unchanged { result.indexed-=1; result.failures.push(Failure {asset_id:hit.asset_id.clone(),message:"展示前素材归属或原文件已变化".into()}); }
        unchanged
    });
    scope(c)?;
    if let (Some(id),Some(revision))=(anchor,anchor_fingerprint) {
        if source(c,&id)?.1 != revision { return Err(error("appearance-source-changed","查询图片已变化")); }
    }
    Ok(result)
}
