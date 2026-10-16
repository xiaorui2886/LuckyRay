//! Local film-viewer annotations. No changes to Mobile/HTTP or source files.
//! Additive, lazy material-domain schema; opening older catalogs preserves all rows.
use super::*;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VideoMark {
    pub id: String,
    pub start: f64,
    pub end: Option<f64>,
    pub note: String,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoMarks {
    source_revision: String,
    marks: Vec<VideoMark>,
}
fn schema(c: &Connection) -> MaterialResult<()> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS material_video_mark(
        library_id TEXT NOT NULL, asset_id TEXT NOT NULL, source_revision TEXT NOT NULL,
        id TEXT NOT NULL, start REAL NOT NULL, end REAL, note TEXT NOT NULL,
        PRIMARY KEY(library_id,asset_id,source_revision,id));
        CREATE TABLE IF NOT EXISTS material_video_frame(
        library_id TEXT NOT NULL, video_id TEXT NOT NULL, source_revision TEXT NOT NULL,
        seconds REAL NOT NULL, asset_id TEXT NOT NULL,
        PRIMARY KEY(library_id,video_id,source_revision,seconds,asset_id));
        CREATE TRIGGER IF NOT EXISTS material_video_mark_asset_delete AFTER DELETE ON asset BEGIN
        DELETE FROM material_video_mark WHERE asset_id=OLD.id; END;
        CREATE TRIGGER IF NOT EXISTS material_video_frame_asset_delete AFTER DELETE ON asset BEGIN
        DELETE FROM material_video_frame WHERE asset_id=OLD.id OR video_id=OLD.id; END;")
        .map_err(|e| MaterialError::database("初始化视频标记失败", e))
}
fn revision(c: &MaterialCatalog, a: &MaterialAsset) -> MaterialResult<String> {
    // Human title/note edits must not invalidate timestamps. A changed source must.
    let path=c.resolve_export_file(a)?;
    let file=crate::companion_gateway::content::open_resource(path).map_err(|e| MaterialError::io("video-source-unavailable","无法读取原视频",e))?;
    let meta=file.metadata().map_err(|e| MaterialError::io("video-source-unavailable","无法读取原视频属性",e))?;
    let modified=meta.modified().map_err(|e| MaterialError::io("video-source-unavailable","无法读取原视频时间",e))?.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos().to_string();
    let identity = serde_json::json!([a.id,a.content_hash,a.size_bytes,meta.len(),modified]);
    Ok(format!("{:x}", Sha256::digest(identity.to_string().as_bytes())))
}
fn valid_time(t: f64) -> bool { t.is_finite() && (0.0..=31_536_000.0).contains(&t) }
impl MaterialCatalog {
    pub(crate) fn native_video_identity(&self, id: &str) -> MaterialResult<(std::path::PathBuf,String)> {
        let asset = self.video_source(id, None)?;
        Ok((self.resolve_export_file(&asset)?,revision(self,&asset)?))
    }
    /// Native media accepts a catalog identity, never a path supplied by web content.
    pub(crate) fn native_video_source(&self, id: &str, expected: &str) -> MaterialResult<std::path::PathBuf> {
        let asset = self.video_source(id, Some(expected))?;
        self.resolve_export_file(&asset)
    }
    fn video_source(&self, id: &str, expected: Option<&str>) -> MaterialResult<MaterialAsset> {
        if self.attachment_projection { return Err(MaterialError::new("video-scope-invalid", "附件不支持影视工具")); }
        let a = self.get_assets(&[id.to_owned()])?.into_iter().next()
            .ok_or_else(|| MaterialError::new("video-source-missing", "原视频已不在此素材库"))?;
        if a.kind != "video" && !a.mime_type.starts_with("video/") {
            return Err(MaterialError::new("video-source-invalid", "此素材不是视频"));
        }
        if expected.is_some() && expected != Some(revision(self,&a)?.as_str()) {
            return Err(MaterialError::new("video-source-changed", "原视频已变化，请重新打开后操作"));
        }
        Ok(a)
    }
    pub(crate) fn video_marks(&self, id: &str) -> MaterialResult<VideoMarks> {
        let a = self.video_source(id, None)?;
        let source_revision = revision(self,&a)?;
        let c = self.open_write()?; schema(&c)?;
        let mut s = c.prepare("SELECT id,start,end,note FROM material_video_mark WHERE library_id=?1 AND asset_id=?2 AND source_revision=?3 ORDER BY start,id")
            .map_err(|e| MaterialError::database("读取视频标记失败", e))?;
        let marks = s.query_map(params![self.library_id.as_deref().unwrap_or(""),id,source_revision], |r| Ok(VideoMark { id:r.get(0)?,start:r.get(1)?,end:r.get(2)?,note:r.get(3)? }))
            .map_err(|e| MaterialError::database("读取视频标记失败", e))?
            .collect::<Result<Vec<_>,_>>().map_err(|e| MaterialError::database("读取视频标记失败", e))?;
        Ok(VideoMarks { source_revision, marks })
    }
    pub(crate) fn save_video_mark(&self, id: &str, source: &str, mark: &VideoMark) -> MaterialResult<()> {
        self.video_source(id, Some(source))?;
        if mark.id.is_empty() || mark.id.len()>80 || !mark.id.bytes().all(|c| c.is_ascii_alphanumeric() || c==b'-')
            || !valid_time(mark.start) || mark.end.is_some_and(|e| !valid_time(e) || e <= mark.start) || mark.note.len()>8192 {
            return Err(MaterialError::new("video-mark-invalid", "标记时间或备注无效"));
        }
        let c = self.open_write()?; schema(&c)?;
        let count:i64=c.query_row("SELECT COUNT(*) FROM material_video_mark WHERE library_id=?1 AND asset_id=?2 AND source_revision=?3 AND id<>?4",params![self.library_id.as_deref().unwrap_or(""),id,source,mark.id],|r|r.get(0)).map_err(|e|MaterialError::database("检查视频标记数量失败",e))?;
        if count>=512 {return Err(MaterialError::new("video-mark-limit","单个视频最多保存 512 个标记"));}
        c.execute("INSERT INTO material_video_mark(library_id,asset_id,source_revision,id,start,end,note) VALUES(?1,?2,?3,?4,?5,?6,?7)
            ON CONFLICT(library_id,asset_id,source_revision,id) DO UPDATE SET start=excluded.start,end=excluded.end,note=excluded.note",
            params![self.library_id.as_deref().unwrap_or(""),id,source,mark.id,mark.start,mark.end,mark.note])
            .map_err(|e| MaterialError::database("保存视频标记失败", e))?;
        Ok(())
    }
    pub(crate) fn delete_video_mark(&self, id: &str, source: &str, mark_id: &str) -> MaterialResult<()> {
        self.video_source(id, Some(source))?;
        let c = self.open_write()?; schema(&c)?;
        c.execute("DELETE FROM material_video_mark WHERE library_id=?1 AND asset_id=?2 AND source_revision=?3 AND id=?4", params![self.library_id.as_deref().unwrap_or(""),id,source,mark_id])
            .map_err(|e| MaterialError::database("删除视频标记失败", e))?;
        Ok(())
    }
    pub(crate) fn import_video_frame(&self, id: &str, source: &str, time: f64, bytes: Vec<u8>) -> MaterialResult<MaterialImportResult> {
        let a = self.video_source(id, Some(source))?;
        if !valid_time(time) || bytes.len()>32*1024*1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(MaterialError::new("video-frame-invalid", "截帧不是有效 PNG 或超出 32 MB 限制"));
        }
        let dimensions=image::ImageReader::with_format(std::io::Cursor::new(&bytes),image::ImageFormat::Png).into_dimensions().map_err(|_|MaterialError::new("video-frame-invalid","截帧 PNG 无法识别"))?;
        if dimensions.0 as u64 * dimensions.1 as u64 > 33_177_600 || dimensions.0==0 || dimensions.1==0 {return Err(MaterialError::new("video-frame-invalid","截帧尺寸超过支持范围"));}
        let hash=format!("{:x}",Sha256::digest(&bytes));
        let origin = format!("video-frame://{}/{id}?seconds={time:.6}&source={source}", self.library_id.as_deref().unwrap_or("legacy"));
        // Existing atomic hash dedup also covers a lost reply. Never overwrite duplicate metadata.
        let mut result=self.import_consumer_bytes_with_source(vec![MaterialBytesInput {
            name: format!("{}-{time:.3}s.png", std::path::Path::new(&a.name).file_stem().unwrap_or_default().to_string_lossy()),
            original_path: origin.clone(), mime_type:"image/png".into(),
            description:Some(format!("视频截帧 · {} · {time:.3} 秒\n{origin}", a.name)), bytes,
        }], &MaterialImportOptions { storage_mode:"managed".into(), folder_id:a.folder_id, ..Default::default() }, None)?.value;
        if result.failed_count>0 {return Ok(result);}
        let c=self.open_write()?;schema(&c)?;
        let frame_id:String=c.query_row("SELECT id FROM asset WHERE content_hash=?1 AND id IN(SELECT asset_id FROM temp.material_visible_asset) LIMIT 1",[hash],|r|r.get(0)).map_err(|e|MaterialError::database("确认截帧入库失败",e))?;
        c.execute("INSERT OR IGNORE INTO material_video_frame(library_id,video_id,source_revision,seconds,asset_id) VALUES(?1,?2,?3,?4,?5)",params![self.library_id.as_deref().unwrap_or(""),id,source,time,frame_id]).map_err(|e|MaterialError::database("保存截帧来源失败",e))?;
        if result.assets.is_empty() {result.assets=self.get_assets(&[frame_id])?;}
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (MaterialCatalog, MaterialAsset) {
        let c = MaterialCatalog::new_for_test();
        let video = c.import_bytes(vec![MaterialBytesInput { name:"sample.webm".into(),original_path:"synthetic:film".into(),mime_type:"video/webm".into(),description:Some("原备注".into()),bytes:b"synthetic-video-no-decoder-claim".to_vec() }], &MaterialImportOptions::default()).unwrap().value.assets.remove(0);
        (c,video)
    }
    #[test]
    fn native_video_resolves_only_current_catalog_video_revision() {
        let (c, a) = fixture();
        let (path, revision) = c.native_video_identity(&a.id).unwrap();
        assert_eq!(c.native_video_source(&a.id, &revision).unwrap(), path);
        assert!(c.native_video_source(&a.id, "stale").is_err());
        assert!(c.native_video_identity("unknown-video").is_err());
        let root = c.app_data_dir().join("native-other-library");
        std::fs::create_dir_all(&root).unwrap();
        let other = c.create_library("Native other", &root, "managed").unwrap();
        assert!(c.for_library(&other.id).unwrap().native_video_identity(&a.id).is_err());
        assert_eq!(c.get_assets(&[a.id.clone()]).unwrap()[0], a);
        std::fs::write(&path, b"changed synthetic video").unwrap();
        assert!(c.native_video_source(&a.id, &revision).is_err());
    }
    #[test]
    fn video_marks_additive_reopen_idempotent_and_delete() {
        let (c,a) = fixture(); let initial=c.video_marks(&a.id).unwrap();
        assert!(initial.marks.is_empty());
        let m=VideoMark{id:"mark-1".into(),start:2.25,end:None,note:"画面标记".into()};
        c.save_video_mark(&a.id,&initial.source_revision,&m).unwrap();
        c.save_video_mark(&a.id,&initial.source_revision,&m).unwrap();
        let reopened=MaterialCatalog::new(c.db_path(),c.app_data_dir());
        assert_eq!(reopened.video_marks(&a.id).unwrap().marks.len(),1);
        let range=VideoMark{id:"range-1".into(),start:10.0,end:Some(20.0),note:"片段".into()};
        c.save_video_mark(&a.id,&initial.source_revision,&range).unwrap();
        assert_eq!(c.video_marks(&a.id).unwrap().marks[1].end,Some(20.0));
        assert_eq!(c.get_assets(&[a.id.clone()]).unwrap()[0],a);
        c.delete_video_mark(&a.id,&initial.source_revision,&m.id).unwrap();
        c.delete_video_mark(&a.id,&initial.source_revision,&m.id).unwrap();
        assert_eq!(c.video_marks(&a.id).unwrap().marks.len(),1);
    }
    #[test]
    fn video_marks_reject_source_change_invalid_time_and_wrong_library() {
        let (c,a)=fixture(); let source=c.video_marks(&a.id).unwrap().source_revision;
        let m=VideoMark{id:"mark".into(),start:1.0,end:None,note:"".into()};
        assert!(c.save_video_mark(&a.id,"wrong",&m).is_err());
        for start in [-1.0,f64::NAN,f64::INFINITY] { assert!(c.save_video_mark(&a.id,&source,&VideoMark{start,..m.clone()}).is_err()); }
        assert!(c.save_video_mark(&a.id,&source,&VideoMark{end:Some(0.5),..m.clone()}).is_err());
        let root=c.app_data_dir().join("another-library");
        std::fs::create_dir_all(&root).unwrap();
        let other=c.create_library("Other",&root,"managed").unwrap();
        assert!(c.for_library(&other.id).unwrap().video_marks(&a.id).is_err());
        let conn=c.open_write().unwrap(); conn.execute("UPDATE asset SET content_hash='changed' WHERE id=?1",[&a.id]).unwrap();
        assert!(c.save_video_mark(&a.id,&source,&m).is_err());
    }
    #[test]
    fn video_frame_uses_atomic_import_dedup_and_preserves_video() {
        let (c,a)=fixture(); let source=c.video_marks(&a.id).unwrap().source_revision;
        let png=include_bytes!("../../../tests/fixtures/material-appearance/oriented-expected.png").to_vec();
        let first=c.import_video_frame(&a.id,&source,3.25,png.clone()).unwrap();
        assert_eq!(first.assets.len(),1); assert!(first.assets[0].original_path.contains("seconds=3.250000"));
        let again=c.import_video_frame(&a.id,&source,3.25,png).unwrap();
        assert_eq!(again.skipped_duplicate_count,1);
        assert_eq!(c.get_assets(&[a.id.clone()]).unwrap()[0],a);
        assert!(c.import_video_frame(&a.id,&source,1.0,b"not-png".to_vec()).is_err());
        assert!(c.import_video_frame(&a.id,"stale",1.0,vec![]).is_err());
    }
}
