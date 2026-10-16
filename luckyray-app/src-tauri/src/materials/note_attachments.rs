//! Rebuildable note use index. Paths and file identity, never content hashes, bind assets.
use super::*;

pub(super) fn ensure_note_attachment_schema(conn: &Connection) -> MaterialResult<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS material_note_identity(asset_id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL, file_identity TEXT NOT NULL, ordinary INTEGER NOT NULL CHECK(ordinary IN (0,1)),file_version TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS material_note_path ON material_note_identity(canonical_path);
        CREATE TABLE IF NOT EXISTS material_note_vault(asset_id TEXT NOT NULL,vault_id TEXT NOT NULL,PRIMARY KEY(asset_id,vault_id));
        CREATE TABLE IF NOT EXISTS material_note_ref(asset_id TEXT NOT NULL,vault_id TEXT NOT NULL,note_path TEXT NOT NULL,target TEXT NOT NULL,PRIMARY KEY(asset_id,vault_id,note_path,target));
        CREATE INDEX IF NOT EXISTS material_note_document ON material_note_ref(vault_id,note_path);
        CREATE TRIGGER IF NOT EXISTS material_note_folder_promote AFTER UPDATE OF folder_id ON asset WHEN NEW.folder_id IS NOT NULL BEGIN
            UPDATE material_note_identity SET ordinary=1 WHERE asset_id=NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS material_note_cleanup AFTER DELETE ON asset BEGIN
            DELETE FROM material_note_identity WHERE asset_id=OLD.id;
            DELETE FROM material_note_vault WHERE asset_id=OLD.id;
            DELETE FROM material_note_ref WHERE asset_id=OLD.id;
        END;")
        .map_err(|e| MaterialError::database("Create attachment index",e))?;
    let has_version:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('material_note_identity') WHERE name='file_version')",[],|r|r.get(0)).map_err(|e|MaterialError::database("Read attachment schema",e))?;
    if !has_version {
        conn.execute(
            "ALTER TABLE material_note_identity ADD COLUMN file_version TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|e| MaterialError::database("Upgrade attachment version index", e))?;
    }
    conn.execute_batch("        CREATE TRIGGER IF NOT EXISTS material_note_identity_version_insert AFTER INSERT ON material_note_identity BEGIN
            UPDATE material_change_state SET version=version+1,reason='note-attachment-index',affected_ids_json='[]',folders_changed=0,occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS material_note_identity_version_update AFTER UPDATE ON material_note_identity BEGIN
            UPDATE material_change_state SET version=version+1,reason='note-attachment-index',affected_ids_json='[]',folders_changed=0,occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS material_note_identity_version_delete AFTER DELETE ON material_note_identity BEGIN
            UPDATE material_change_state SET version=version+1,reason='note-attachment-index',affected_ids_json='[]',folders_changed=0,occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS material_note_vault_version_insert AFTER INSERT ON material_note_vault BEGIN
            UPDATE material_change_state SET version=version+1,reason='note-attachment-index',affected_ids_json='[]',folders_changed=0,occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS material_note_vault_version_update AFTER UPDATE ON material_note_vault BEGIN
            UPDATE material_change_state SET version=version+1,reason='note-attachment-index',affected_ids_json='[]',folders_changed=0,occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS material_note_vault_version_delete AFTER DELETE ON material_note_vault BEGIN
            UPDATE material_change_state SET version=version+1,reason='note-attachment-index',affected_ids_json='[]',folders_changed=0,occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS material_note_ref_version_insert AFTER INSERT ON material_note_ref BEGIN
            UPDATE material_change_state SET version=version+1,reason='note-attachment-index',affected_ids_json='[]',folders_changed=0,occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS material_note_ref_version_update AFTER UPDATE ON material_note_ref BEGIN
            UPDATE material_change_state SET version=version+1,reason='note-attachment-index',affected_ids_json='[]',folders_changed=0,occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
        END;
        CREATE TRIGGER IF NOT EXISTS material_note_ref_version_delete AFTER DELETE ON material_note_ref BEGIN
            UPDATE material_change_state SET version=version+1,reason='note-attachment-index',affected_ids_json='[]',folders_changed=0,occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton=1;
        END;
").map_err(|e|MaterialError::database("Register attachment version triggers",e))?;
    Ok(())
}
fn has_schema(conn: &Connection) -> MaterialResult<bool> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_note_identity')",[],|row|row.get(0)).map_err(|e|MaterialError::database("Read attachment index",e))
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
pub(super) fn scope_condition(
    conn: &Connection,
    scope: &MaterialQueryScope,
    id: &str,
) -> MaterialResult<String> {
    if !matches!(
        scope.scope.as_str(),
        "" | "ordinary" | "all" | "note-attachments"
    ) {
        return Err(MaterialError::new(
            "material-scope-invalid",
            "Unknown material query scope",
        ));
    }
    if !has_schema(conn)? {
        return Ok(if scope.scope == "note-attachments" {
            "0"
        } else {
            "1"
        }
        .into());
    }
    if scope.scope == "all" {
        return super::super::libraries::namespace_condition(conn,"asset",id);
    }
    if scope.scope != "note-attachments" {
        return Ok(format!("({}) AND NOT EXISTS(SELECT 1 FROM material_note_identity ni WHERE ni.asset_id={id} AND ni.ordinary=0)",super::super::libraries::namespace_condition(conn,"asset",id)?));
    }
    let vault = scope
        .vault_id
        .as_deref()
        .map(|v| format!(" AND nr.vault_id={}", quote(v)))
        .unwrap_or_default();
    let table = if scope.include_unreferenced {
        "material_note_vault"
    } else {
        "material_note_ref"
    };
    Ok(format!(
        "EXISTS(SELECT 1 FROM {table} nr WHERE nr.asset_id={id}{vault})"
    ))
}
fn validate_document(vault: &str, note: &str) -> MaterialResult<()> {
    if vault.is_empty()
        || vault.len() > 256
        || note.is_empty()
        || note.len() > 8192
        || note.starts_with('/')
        || note.contains('\\')
        || note
            .split('/')
            .any(|p| p == ".." || p == "." || p.is_empty())
        || note.contains(':')
        || vault.chars().chain(note.chars()).any(char::is_control)
    {
        return Err(MaterialError::new(
            "note-reference-invalid",
            "Invalid note reference identity",
        ));
    }
    Ok(())
}
fn file_binding(path: &Path) -> MaterialResult<(PathBuf, String, std::fs::File)> {
    let canonical = canonical_regular_file(path)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(3);
    }
    let file = options
        .open(&canonical)
        .map_err(|e| MaterialError::io("attachment-unavailable", "Read attachment identity", e))?;
    let identity = file_identity(&file)?;
    Ok((canonical, identity, file))
}
pub(super) fn file_identity(file: &std::fs::File) -> MaterialResult<String> {
    #[cfg(windows)]
    let identity = {
        use std::os::windows::io::AsRawHandle;
        #[repr(C)]
        struct Info {
            attrs: u32,
            creation: [u32; 2],
            access: [u32; 2],
            write: [u32; 2],
            volume: u32,
            size_hi: u32,
            size_lo: u32,
            links: u32,
            index_hi: u32,
            index_lo: u32,
        }
        #[allow(clashing_extern_declarations)]
        #[link(name = "kernel32")]
        extern "system" {
            fn GetFileInformationByHandle(file: *mut std::ffi::c_void, info: *mut Info) -> i32;
        }
        let mut info = std::mem::MaybeUninit::<Info>::uninit();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(MaterialError::new(
                "attachment-identity-unavailable",
                "Cannot verify file identity",
            ));
        }
        let info = unsafe { info.assume_init() };
        format!("{}:{}:{}", info.volume, info.index_hi, info.index_lo)
    };
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        let m = file
            .metadata()
            .map_err(|e| MaterialError::io("attachment-unavailable", "Read identity", e))?;
        format!("{}:{}", m.dev(), m.ino())
    };
    #[cfg(not(any(windows, unix)))]
    return Err(MaterialError::new(
        "attachment-identity-unavailable",
        "Unsupported filesystem identity",
    ));
    Ok(identity)
}
fn file_version(file: &std::fs::File) -> MaterialResult<(String, u64)> {
    let metadata = file
        .metadata()
        .map_err(|e| MaterialError::io("attachment-unavailable", "Read attachment version", e))?;
    let modified = metadata
        .modified()
        .map_err(|e| {
            MaterialError::io(
                "attachment-unavailable",
                "Read attachment modification time",
                e,
            )
        })?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| {
            MaterialError::new(
                "attachment-version-unavailable",
                "Invalid attachment timestamp",
            )
        })?
        .as_nanos();
    Ok((format!("{}:{modified}", metadata.len()), metadata.len()))
}
fn verified_version_hash(
    path: &Path,
    file: &std::fs::File,
    version: &str,
) -> MaterialResult<String> {
    let hash = sha256_file(path)?;
    if file_version(file)?.0 != version {
        return Err(MaterialError::new(
            "attachment-version-changed",
            "附件在读取时已变化，请重试",
        ));
    }
    Ok(hash)
}
fn lookup_key(path: &Path) -> String {
    let key = canonical_path_key(path);
    #[cfg(windows)]
    {
        if let Some(rest) = key.strip_prefix("//?/unc/") {
            return format!("//{rest}");
        }
        if let Some(rest) = key.strip_prefix("//?/") {
            return rest.into();
        }
    }
    key
}
pub(super) fn actual_path(asset: &MaterialAsset) -> MaterialResult<&str> {
    match asset.storage_mode.as_str() {
        "linked" => Ok(&asset.original_path),
        "managed" | "source" => asset
            .library_path
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                MaterialError::new(
                    "attachment-source-unavailable",
                    "Managed/source path is missing",
                )
            }),
        _ => Err(MaterialError::new(
            "attachment-source-invalid",
            "Unknown material ownership",
        )),
    }
}
pub(super) fn protect_note_attachment(
    conn: &Connection,
    id: &str,
    physical: bool,
) -> MaterialResult<bool> {
    if !has_schema(conn)? {
        return Ok(false);
    }
    let referenced: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM material_note_ref WHERE asset_id=?1)",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| MaterialError::database("Check note references", e))?;
    if physical && referenced {
        return Err(MaterialError::new(
            "material-in-use-by-notes",
            "This file is referenced by registered notes",
        ));
    }
    if !physical && referenced {
        conn.execute(
            "UPDATE material_note_identity SET ordinary=0 WHERE asset_id=?1",
            [id],
        )
        .map_err(|e| MaterialError::database("Remove ordinary material use", e))?;
        conn.execute("UPDATE asset SET folder_id=NULL WHERE id=?1", [id])
            .map_err(|e| MaterialError::database("Remove ordinary folder", e))?;
        return Ok(true);
    }
    Ok(false)
}
/// Equality includes all known vaults, note paths and literal targets. A newly
/// saved reference aborts the coordinator before its physical/catalog mutation.
pub(super) fn assert_reference_snapshot(
    conn: &Connection,
    id: &str,
    expected: &[NoteAttachmentReference],
) -> MaterialResult<()> {
    let mut stmt=conn.prepare("SELECT nr.vault_id,nr.note_path,nr.target,ni.canonical_path FROM material_note_ref nr JOIN material_note_identity ni ON ni.asset_id=nr.asset_id WHERE nr.asset_id=?1").map_err(|e|MaterialError::database("Check coordinated references",e))?;
    let actual = stmt
        .query_map([id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| MaterialError::database("Check coordinated references", e))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|e| MaterialError::database("Check coordinated references", e))?;
    let expected: HashSet<_> = expected
        .iter()
        .map(|r| {
            (
                r.vault_id.clone(),
                r.note_path.clone(),
                r.target.clone(),
                r.absolute_path.clone(),
            )
        })
        .collect();
    if actual != expected {
        return Err(MaterialError::new(
            "note-references-changed",
            "笔记引用已变化，请重新预览操作",
        ));
    }
    Ok(())
}
pub(super) fn refresh_attachment_binding(
    conn: &Connection,
    id: &str,
    path: &Path,
) -> MaterialResult<()> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM material_note_identity WHERE asset_id=?1)",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| MaterialError::database("Read attachment binding", e))?;
    if !exists {
        return Ok(());
    }
    let (canonical, identity, handle) = file_binding(path)?;
    let version = file_version(&handle)?.0;
    conn.execute(
        "UPDATE material_note_identity SET canonical_path=?2,file_identity=?3,file_version=?4 WHERE asset_id=?1",
        rusqlite::params![id, canonical.to_string_lossy(), identity,version],
    )
    .map_err(|e| MaterialError::database("Update attachment binding", e))?;
    Ok(())
}
impl MaterialCatalog {
    pub(crate) fn register_note_attachment(
        &self,
        path: &Path,
        vault_id: &str,
        existing_material_id: Option<&str>,
    ) -> MaterialResult<MaterialAsset> {
        validate_document(vault_id, "registration.md")?;
        let (canonical, identity, _handle) = file_binding(path)?;
        let (version, size) = file_version(&_handle)?;
        let path_text = canonical.to_string_lossy().into_owned();
        let key = lookup_key(&canonical);
        let conn = self.open_write()?;
        ensure_note_attachment_schema(&conn)?;
        begin_transaction(&conn)?;
        // Most calls refresh an already registered path. Use the derived path
        // index before the one-time ordinary-material discovery fallback.
        let indexed_id = conn
            .query_row(
                "SELECT asset_id FROM material_note_identity WHERE canonical_path=?1 LIMIT 1",
                [&path_text],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| MaterialError::database("Find registered attachment", e))?;
        let indexed_lookup = indexed_id.is_some();
        let candidates = if let Some(id) = existing_material_id {
            vec![read_asset_unrestricted(&conn, id)?]
        } else if let Some(id) = indexed_id {
            vec![read_asset_unrestricted(&conn, &id)?]
        } else {
            let mut stmt = conn
                .prepare("SELECT id FROM asset LIMIT 100001")
                .map_err(|e| MaterialError::database("Find existing attachment", e))?;
            let ids = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| MaterialError::database("Find attachment", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| MaterialError::database("Read attachments", e))?;
            if ids.len() > 100000 {
                return Err(MaterialError::new(
                    "material-capacity",
                    "Too many assets to verify exact identity",
                ));
            }
            ids.iter()
                .map(|id| read_asset_unrestricted(&conn, id))
                .collect::<MaterialResult<Vec<_>>>()?
        };
        let mut found = None;
        for asset in candidates {
            let matches = actual_path(&asset).ok().is_some_and(|p| {
                lookup_key(Path::new(p)) == key
                    || canonical_regular_file(Path::new(p))
                        .ok()
                        .is_some_and(|p| lookup_key(&p) == key)
            });
            if matches {
                found = Some(asset);
                break;
            }
            if existing_material_id.is_some() {
                return Err(MaterialError::new(
                    "attachment-material-mismatch",
                    "Material does not own this exact source path",
                ));
            }
        }
        if found.is_none() && indexed_lookup && existing_material_id.is_none() {
            return Err(MaterialError::new(
                "attachment-index-stale",
                "附件路径索引与素材位置不一致，请重新检查",
            ));
        }
        let asset = if let Some(asset) = found {
            let unchanged: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM material_note_identity ni JOIN material_note_vault nv ON nv.asset_id=ni.asset_id WHERE ni.asset_id=?1 AND ni.canonical_path=?2 AND ni.file_identity=?3 AND nv.vault_id=?4 AND ni.file_version=?5)",rusqlite::params![asset.id,path_text,identity,vault_id,version],|r|r.get(0)).map_err(|e|MaterialError::database("Check attachment registration",e))?;
            if unchanged {
                commit_transaction(&conn)?;
                return Ok(asset);
            }
            let hash = verified_version_hash(&canonical, &_handle, &version)?;
            conn.execute(
                "UPDATE asset SET content_hash=?2,size_bytes=?3,updated_at=?4 WHERE id=?1",
                rusqlite::params![
                    asset.id,
                    hash,
                    i64::try_from(size).unwrap_or(i64::MAX),
                    now()
                ],
            )
            .map_err(|e| MaterialError::database("Refresh attachment metadata", e))?;
            read_asset_unrestricted(&conn, &asset.id)?
        } else {
            let id = unique_id("asset");
            let name = canonical.file_name().unwrap().to_string_lossy();
            let kind = kind_from_name(&name);
            let content_hash = verified_version_hash(&canonical, &_handle, &version)?;
            if super::super::libraries::has_libraries(&conn)? {
                conn.execute("INSERT INTO material_library_write_intent(kind,object_id,library_id) VALUES('asset',?1,NULL)",[&id]).map_err(|e|MaterialError::database("登记附件独立投影失败",e))?;
            }
            conn.execute("INSERT INTO asset(id,name,original_path,library_path,storage_mode,kind,mime_type,size_bytes,thumbnail_url,description,rating,dominant_color,folder_id,imported_at,updated_at,content_hash) VALUES(?1,?2,?3,NULL,'linked',?4,'',?5,?6,'',NULL,NULL,NULL,?7,?7,?8)",rusqlite::params![id,name,path_text,kind,size as i64,if kind=="image" {path_text.as_str()} else {""},now(),content_hash]).map_err(|e|MaterialError::database("Register note attachment",e))?;
            conn.execute(
                "INSERT INTO material_note_identity(asset_id,canonical_path,file_identity,ordinary,file_version) VALUES(?1,?2,?3,0,?4)",
                rusqlite::params![id, path_text, identity,version],
            )
            .map_err(|e| MaterialError::database("Bind attachment", e))?;
            read_asset_unrestricted(&conn, &id)?
        };
        // Same-path content updates retain entity identity; no hash-based merge across paths.
        conn.execute("INSERT INTO material_note_identity(asset_id,canonical_path,file_identity,ordinary,file_version) VALUES(?1,?2,?3,1,?4) ON CONFLICT(asset_id) DO UPDATE SET canonical_path=excluded.canonical_path,file_identity=excluded.file_identity,file_version=excluded.file_version",rusqlite::params![asset.id,path_text,identity,version]).map_err(|e|MaterialError::database("Bind note attachment",e))?;
        conn.execute(
            "INSERT OR IGNORE INTO material_note_vault VALUES(?1,?2)",
            rusqlite::params![asset.id, vault_id],
        )
        .map_err(|e| MaterialError::database("Register attachment vault", e))?;
        publish_change_metadata(
            &conn,
            "note-attachment-register",
            vec![asset.id.clone()],
            false,
        )?;
        commit_transaction(&conn)?;
        Ok(asset)
    }
    pub(crate) fn replace_note_attachment_refs(
        &self,
        vault_id: &str,
        note_path: &str,
        refs: &[NoteAttachmentRefInput],
    ) -> MaterialResult<()> {
        validate_document(vault_id, note_path)?;
        if refs.len() > 4096
            || refs
                .iter()
                .any(|r| r.target.len() > 32768 || r.target.is_empty())
        {
            return Err(MaterialError::new(
                "note-reference-capacity",
                "Invalid or excessive attachment references",
            ));
        }
        let conn = self.open_write()?;
        ensure_note_attachment_schema(&conn)?;
        begin_transaction(&conn)?;
        for r in refs {
            let registered:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM material_note_vault v JOIN asset a ON a.id=v.asset_id WHERE v.asset_id=?1 AND v.vault_id=?2)",rusqlite::params![r.asset_id,vault_id],|row|row.get(0)).map_err(|e|MaterialError::database("Validate note attachment",e))?;
            if !registered {
                return Err(MaterialError::new(
                    "note-attachment-unregistered",
                    "Register the exact attachment before indexing a reference",
                ));
            }
        }
        let existing = {
            let mut stmt=conn.prepare("SELECT asset_id,target FROM material_note_ref WHERE vault_id=?1 AND note_path=?2").map_err(|e|MaterialError::database("Read prior note refs",e))?;
            let rows = stmt
                .query_map(rusqlite::params![vault_id, note_path], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| MaterialError::database("Read prior note refs", e))?
                .collect::<Result<HashSet<_>, _>>()
                .map_err(|e| MaterialError::database("Read prior note refs", e))?;
            rows
        };
        let next: HashSet<_> = refs
            .iter()
            .map(|r| (r.asset_id.clone(), r.target.clone()))
            .collect();
        if existing == next {
            return commit_transaction(&conn);
        }
        conn.execute(
            "DELETE FROM material_note_ref WHERE vault_id=?1 AND note_path=?2",
            rusqlite::params![vault_id, note_path],
        )
        .map_err(|e| MaterialError::database("Replace note refs", e))?;
        for r in refs {
            conn.execute(
                "INSERT OR IGNORE INTO material_note_ref VALUES(?1,?2,?3,?4)",
                rusqlite::params![r.asset_id, vault_id, note_path, r.target],
            )
            .map_err(|e| MaterialError::database("Index note refs", e))?;
        }
        publish_change_metadata(
            &conn,
            "note-references",
            existing
                .into_iter()
                .map(|(id, _)| id)
                .chain(refs.iter().map(|r| r.asset_id.clone()))
                .collect(),
            false,
        )?;
        commit_transaction(&conn)
    }
    /// Existing target bindings remain available when the file is missing. The
    /// caller combines these with the freshly parsed Markdown targets, removing
    /// a binding only when its target really disappeared from the document.
    pub(crate) fn note_attachment_refs(
        &self,
        vault_id: &str,
        note_path: &str,
    ) -> MaterialResult<Vec<NoteAttachmentRefInput>> {
        validate_document(vault_id, note_path)?;
        let conn = self.open_read()?;
        if !has_schema(&conn)? {
            return Ok(vec![]);
        }
        let mut stmt=conn.prepare("SELECT asset_id,target FROM material_note_ref WHERE vault_id=?1 AND note_path=?2 ORDER BY target,asset_id").map_err(|e|MaterialError::database("Read note bindings",e))?;
        let rows = stmt
            .query_map(rusqlite::params![vault_id, note_path], |r| {
                Ok(NoteAttachmentRefInput {
                    asset_id: r.get(0)?,
                    target: r.get(1)?,
                })
            })
            .map_err(|e| MaterialError::database("Read note bindings", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| MaterialError::database("Read note bindings", e))?;
        Ok(rows)
    }
    /// Explicit user-selected/published paths also authorize unsaved drafts.
    /// This records no fictitious note reference and grants no parent directory.
    /// Read-only, nonrecursive evidence discovery. No filename/hash guesses and
    /// no authority beyond the parent directories of this Vault's registrations.
    pub(crate) fn discover_note_attachment_moves(
        &self,
        vault_id: &str,
    ) -> MaterialResult<Vec<NoteAttachmentMoveCandidate>> {
        validate_document(vault_id, "registration.md")?;
        let conn = self.open_read()?;
        if !has_schema(&conn)? {
            return Ok(vec![]);
        }
        let mut stmt=conn.prepare("SELECT ni.asset_id,ni.canonical_path,ni.file_identity FROM material_note_identity ni JOIN material_note_vault nv ON nv.asset_id=ni.asset_id WHERE nv.vault_id=?1 LIMIT 10001").map_err(|e|MaterialError::database("Read registered attachment locations",e))?;
        let bindings = stmt
            .query_map([vault_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| MaterialError::database("Read registered attachment locations", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| MaterialError::database("Read registered attachment locations", e))?;
        if bindings.len() > 10000 {
            return Err(MaterialError::new(
                "attachment-scan-capacity",
                "已登记附件数量超过本次检查范围",
            ));
        }
        let missing = bindings
            .iter()
            .filter(|(_, path, _)| {
                std::fs::symlink_metadata(path)
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            })
            .collect::<Vec<_>>();
        if missing.is_empty() {
            return Ok(vec![]);
        }
        let identities = missing
            .iter()
            .map(|(_, _, identity)| identity.as_str())
            .collect::<HashSet<_>>();
        let mut parents = HashMap::new();
        for (_, path, _) in &bindings {
            let Some(parent) = Path::new(path).parent() else {
                continue;
            };
            if reject_reparse_components(parent).is_err() {
                continue;
            }
            let Ok(metadata) = std::fs::symlink_metadata(parent) else {
                continue;
            };
            if !metadata.is_dir() || metadata_is_reparse(&metadata) {
                continue;
            }
            let canonical = parent.canonicalize().map_err(|e| {
                MaterialError::io("attachment-scan-unavailable", "无法校验附件父目录", e)
            })?;
            parents.insert(lookup_key(&canonical), canonical);
        }
        if parents.len() > 256 {
            return Err(MaterialError::new(
                "attachment-scan-capacity",
                "已登记附件分布目录过多，请缩小检查范围",
            ));
        }
        let mut matches: HashMap<String, HashMap<String, String>> = HashMap::new();
        let mut visited = 0usize;
        for parent in parents.values() {
            // Hold the actual registered parent chain while enumerating; do not
            // follow a directory replacement into an unrelated location.
            let scan_leaf = parent.join(".attachment-identity-scan");
            let _guards = hold_material_parent_directories(&scan_leaf, &scan_leaf)?;
            let entries = std::fs::read_dir(parent).map_err(|e| {
                MaterialError::io("attachment-scan-unavailable", "无法检查已登记附件目录", e)
            })?;
            for entry in entries {
                visited += 1;
                if visited > 32768 {
                    return Err(MaterialError::new(
                        "attachment-scan-capacity",
                        "附件父目录检查已达到本次上限",
                    ));
                }
                let entry = entry.map_err(|e| {
                    MaterialError::io("attachment-scan-unavailable", "无法读取目录项", e)
                })?;
                let metadata = match std::fs::symlink_metadata(entry.path()) {
                    Ok(metadata) => metadata,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => {
                        return Err(MaterialError::io(
                            "attachment-scan-unavailable",
                            "无法校验目录项",
                            e,
                        ))
                    }
                };
                if !metadata.is_file() || metadata_is_reparse(&metadata) {
                    continue;
                }
                let (path, identity, _guard) = file_binding(&entry.path())?;
                if identities.contains(identity.as_str()) {
                    matches
                        .entry(identity)
                        .or_default()
                        .insert(lookup_key(&path), path.to_string_lossy().into_owned());
                }
            }
        }
        let mut result = Vec::new();
        for (id, old, identity) in missing {
            let Some(paths) = matches.get(identity).filter(|paths| paths.len() == 1) else {
                continue;
            };
            let path = paths.values().next().unwrap();
            if !std::fs::symlink_metadata(old)
                .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            {
                continue;
            }
            if !file_binding(Path::new(path)).is_ok_and(|(_, current, _)| &current == identity) {
                continue;
            }
            result.push(NoteAttachmentMoveCandidate {
                asset_id: id.clone(),
                previous_path: old.clone(),
                new_path: path.clone(),
            });
        }
        result.sort_by(|a, b| a.asset_id.cmp(&b.asset_id));
        Ok(result)
    }

    /// Call only with a complete disk note inventory. The version fence prevents
    /// a concurrent new reference from being pruned using an older inventory.
    pub(crate) fn prune_note_attachment_refs(
        &self,
        vault_id: &str,
        existing_note_paths: &[String],
        expected_catalog_version: i64,
    ) -> MaterialResult<usize> {
        validate_document(vault_id, "registration.md")?;
        if existing_note_paths.len() > 100000 {
            return Err(MaterialError::new(
                "note-reference-capacity",
                "笔记清单超过本次检查上限",
            ));
        }
        for note in existing_note_paths {
            validate_document(vault_id, note)?;
        }
        let existing = existing_note_paths
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let conn = self.open_write()?;
        ensure_note_attachment_schema(&conn)?;
        begin_transaction(&conn)?;
        if read_change(&conn)?.version != expected_catalog_version {
            return Err(MaterialError::new(
                "note-reference-index-changed",
                "笔记附件索引已变化，请重新检查现存笔记",
            ));
        }
        let mut stmt = conn
            .prepare("SELECT DISTINCT note_path,asset_id FROM material_note_ref WHERE vault_id=?1")
            .map_err(|e| MaterialError::database("Read indexed note paths", e))?;
        let rows = stmt
            .query_map([vault_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| MaterialError::database("Read indexed note paths", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| MaterialError::database("Read indexed note paths", e))?;
        let removed = rows
            .into_iter()
            .filter(|(note, _)| !existing.contains(note.as_str()))
            .collect::<Vec<_>>();
        if removed.is_empty() {
            commit_transaction(&conn)?;
            return Ok(0);
        }
        let notes = removed.iter().map(|(note, _)| note).collect::<HashSet<_>>();
        for note in &notes {
            conn.execute(
                "DELETE FROM material_note_ref WHERE vault_id=?1 AND note_path=?2",
                rusqlite::params![vault_id, note],
            )
            .map_err(|e| MaterialError::database("Prune removed note references", e))?;
        }
        publish_change_metadata(
            &conn,
            "note-reference-prune",
            removed.iter().map(|(_, asset)| asset.clone()).collect(),
            false,
        )?;
        commit_transaction(&conn)?;
        Ok(notes.len())
    }

    pub(crate) fn for_vault_attachment_ids(&self, vault_id: &str, ids: &[String]) -> MaterialResult<Self> {
        validate_document(vault_id, "registration.md")?;
        let conn=self.open_read()?;
        let registered:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM material_note_vault WHERE vault_id=?1)",[vault_id],|r|r.get(0)).map_err(|e|MaterialError::database("读取附件知识库失败",e))?;
        if !registered {return Err(MaterialError::new("vault-attachment-context-mismatch","知识库附件投影未登记"));}
        for id in ids {
            let allowed:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM material_note_vault WHERE asset_id=?1 AND vault_id=?2)",rusqlite::params![id,vault_id],|r|r.get(0)).map_err(|e|MaterialError::database("读取附件授权失败",e))?;
            if !allowed {return Err(MaterialError::new("vault-attachment-context-mismatch","附件不属于所选知识库"));}
        }
        Ok(self.for_attachment_projection())
    }
    pub(crate) fn approved_vault_attachment_paths(
        &self,
        vault_id: &str,
    ) -> MaterialResult<Vec<String>> {
        validate_document(vault_id, "registration.md")?;
        let conn = self.open_read()?;
        if !has_schema(&conn)? {
            return Ok(vec![]);
        }
        let mut stmt=conn.prepare("SELECT DISTINCT ni.canonical_path FROM material_note_identity ni JOIN material_note_vault nv ON nv.asset_id=ni.asset_id WHERE nv.vault_id=?1").map_err(|e|MaterialError::database("Read selected attachment paths",e))?;
        let paths = stmt
            .query_map([vault_id], |r| r.get::<_, String>(0))
            .map_err(|e| MaterialError::database("Read selected attachment paths", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| MaterialError::database("Read selected attachment paths", e))?;
        Ok(paths
            .into_iter()
            .filter(|path| {
                file_binding(Path::new(path))
                    .ok()
                    .is_some_and(|(canonical, _, _)| {
                        lookup_key(&canonical) == lookup_key(Path::new(path))
                    })
            })
            .collect())
    }

    /// Project a registered, ordinary material's identity onto an already resolved
    /// attachment. Filesystem canonicalization, not display-path spelling, decides
    /// ownership (including native filesystem redirection). This is a read only
    /// lookup: stale registrations and multiple owners never choose an asset.
    pub(crate) fn material_id_for_vault_attachment(
        &self,
        vault_id: &str,
        path: &Path,
    ) -> MaterialResult<Option<String>> {
        validate_document(vault_id, "registration.md")?;
        let conn = self.open_read()?;
        if !has_schema(&conn)? {
            return Ok(None);
        }
        let mut stmt = conn.prepare(
            "SELECT ni.asset_id, ni.canonical_path FROM material_note_identity ni
             JOIN material_note_vault nv ON nv.asset_id=ni.asset_id
             JOIN asset a ON a.id=ni.asset_id
             WHERE nv.vault_id=?1 AND ni.ordinary=1",
        ).map_err(|e| MaterialError::database("Read attachment material identities", e))?;
        let rows = stmt.query_map([vault_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }).map_err(|e| MaterialError::database("Read attachment material identities", e))?
          .collect::<Result<Vec<_>, _>>()
          .map_err(|e| MaterialError::database("Read attachment material identities", e))?;
        // Do not inspect an unregistered location. Knowledge has already resolved
        // this path, but material identity still requires this Vault's binding.
        let key = lookup_key(path);
        let candidates = rows.into_iter().filter(|(_, registered)| {
            lookup_key(Path::new(registered)) == key
        }).collect::<Vec<_>>();
        if candidates.is_empty() {
            return Ok(None);
        }
        let Ok((canonical, identity, _handle)) = file_binding(path) else {
            return Ok(None);
        };
        if lookup_key(&canonical) != key {
            return Ok(None);
        }
        let mut found = None;
        for (id, _) in candidates {
            let asset = match read_asset_unrestricted(&conn, &id) {
                Ok(asset) => asset,
                Err(error) if error.code == "not-found" => continue,
                Err(error) => return Err(error),
            };
            let matches = actual_path(&asset).ok().is_some_and(|current| {
                file_binding(Path::new(current)).ok().is_some_and(|(current, current_identity, _)| {
                    lookup_key(&current) == key && current_identity == identity
                })
            });
            if matches {
                if found.is_some() {
                    return Ok(None);
                }
                found = Some(id);
            }
        }
        Ok(found)
    }

    pub(crate) fn approved_note_attachment_paths(
        &self,
        vault_id: &str,
        note_path: &str,
    ) -> MaterialResult<Vec<String>> {
        validate_document(vault_id, note_path)?;
        let conn = self.open_read()?;
        if !has_schema(&conn)? {
            return Ok(vec![]);
        }
        let mut stmt=conn.prepare("SELECT DISTINCT ni.canonical_path,ni.file_identity FROM material_note_identity ni JOIN material_note_ref nr ON nr.asset_id=ni.asset_id WHERE nr.vault_id=?1 AND nr.note_path=?2").map_err(|e|MaterialError::database("Read approved paths",e))?;
        let rows = stmt
            .query_map(rusqlite::params![vault_id, note_path], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| MaterialError::database("Read approved paths", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| MaterialError::database("Read approved paths", e))?;
        // The approved location survives editor atomic-save replacement. Validate the
        // exact canonical location and reject reparse components on every read;
        // identity is evidence for rename recovery, not immutable content authority.
        Ok(rows
            .into_iter()
            .filter_map(|(path, _)| {
                file_binding(Path::new(&path))
                    .ok()
                    .filter(|(canonical, _, _)| {
                        lookup_key(canonical) == lookup_key(Path::new(&path))
                    })
                    .map(|_| path)
            })
            .collect())
    }
    pub(crate) fn attachment_details(&self, id: &str) -> MaterialResult<NoteAttachmentDetails> {
        let conn = self.open_read()?;
        read_asset_unrestricted(&conn, id)?;
        let mut result = NoteAttachmentDetails {
            asset_id: id.into(),
            ordinary: true,
            absolute_path: None,
            reference_count: 0,
            references: vec![],
        };
        if !has_schema(&conn)? {
            return Ok(result);
        }
        if let Some((path, ordinary)) = conn
            .query_row(
                "SELECT canonical_path,ordinary FROM material_note_identity WHERE asset_id=?1",
                [id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)),
            )
            .optional()
            .map_err(|e| MaterialError::database("Read attachment use", e))?
        {
            result.absolute_path = Some(path);
            result.ordinary = ordinary;
        }
        let mut stmt=conn.prepare("SELECT nr.vault_id,nr.note_path,nr.target,ni.canonical_path FROM material_note_ref nr JOIN material_note_identity ni ON ni.asset_id=nr.asset_id WHERE nr.asset_id=?1 ORDER BY nr.vault_id,nr.note_path,nr.target").map_err(|e|MaterialError::database("Read note references",e))?;
        result.references = stmt
            .query_map([id], |r| {
                Ok(NoteAttachmentReference {
                    vault_id: r.get(0)?,
                    note_path: r.get(1)?,
                    target: r.get(2)?,
                    absolute_path: r.get(3)?,
                })
            })
            .map_err(|e| MaterialError::database("Read note references", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| MaterialError::database("Read note references", e))?;
        result.reference_count = result
            .references
            .iter()
            .map(|r| (&r.vault_id, &r.note_path))
            .collect::<HashSet<_>>()
            .len();
        Ok(result)
    }
    pub(crate) fn promote_note_attachment(
        &self,
        id: &str,
        folder_id: Option<&str>,
    ) -> MaterialResult<MaterialAsset> {
        let conn = self.open_write()?;
        ensure_note_attachment_schema(&conn)?;
        begin_transaction(&conn)?;
        read_asset_unrestricted(&conn, id)?;
        if let Some(folder) = folder_id {
            let valid: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM folder WHERE id=?1)",
                    [folder],
                    |r| r.get(0),
                )
                .map_err(|e| MaterialError::database("Validate folder", e))?;
            if !valid {
                return Err(MaterialError::new(
                    "folder-not-found",
                    "Folder does not exist",
                ));
            }
        }
        conn.execute(
            "UPDATE material_note_identity SET ordinary=1 WHERE asset_id=?1",
            [id],
        )
        .map_err(|e| MaterialError::database("Promote attachment", e))?;
        if let Some(folder) = folder_id {
            conn.execute(
                "UPDATE asset SET folder_id=?2 WHERE id=?1",
                rusqlite::params![id, folder],
            )
            .map_err(|e| MaterialError::database("Assign promoted attachment", e))?;
        }
        publish_change_metadata(
            &conn,
            "note-attachment-promote",
            vec![id.into()],
            folder_id.is_some(),
        )?;
        let asset = read_asset_unrestricted(&conn, id)?;
        commit_transaction(&conn)?;
        Ok(asset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope(vault: &str, unreferenced: bool) -> MaterialQueryScope {
        MaterialQueryScope {
            scope: "note-attachments".into(),
            vault_id: Some(vault.into()),
            include_unreferenced: unreferenced,
        }
    }
    fn source(catalog: &MaterialCatalog, name: &str) -> PathBuf {
        let path = catalog.app_data_dir().join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"same bytes").unwrap();
        path
    }
    #[test]
    fn resolved_material_identity_uses_native_canonical_path_and_vault_binding_without_writes() {
        let catalog = MaterialCatalog::new_for_test();
        let path = source(&catalog, "known.png");
        let material = catalog.import_paths(&[path.clone()], &MaterialImportOptions {
            storage_mode: "linked".into(), ..Default::default()
        }).unwrap().value.assets[0].clone();
        catalog.register_note_attachment(&path, "v", Some(&material.id)).unwrap();
        let canonical = path.canonicalize().unwrap();
        // An OS-resolved spelling has to be checked through the filesystem. A
        // syntactic path index cannot establish that these spellings are equal.
        let directory = path.parent().unwrap().join("alternate-spelling");
        std::fs::create_dir_all(&directory).unwrap();
        let logical_path = directory.join("..").join(path.file_name().unwrap());
        assert_ne!(lookup_key(&logical_path), lookup_key(&canonical));
        assert_eq!(canonical_regular_file(&logical_path).unwrap(), canonical);
        let conn = catalog.open_write().unwrap();
        conn.execute("UPDATE asset SET original_path=?2 WHERE id=?1", rusqlite::params![material.id, logical_path.to_string_lossy()]).unwrap();
        let before = read_change(&conn).unwrap().version;
        assert_eq!(catalog.material_id_for_vault_attachment("v", &canonical).unwrap(), Some(material.id.clone()));
        assert_eq!(catalog.material_id_for_vault_attachment("other-vault", &canonical).unwrap(), None);
        let unrelated = source(&catalog, "same-bytes.png");
        assert_eq!(catalog.material_id_for_vault_attachment("v", &unrelated.canonicalize().unwrap()).unwrap(), None);
        // Atomic replacement at this exact location is permitted; a stored inode
        // is not immutable content authority for note attachments.
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
        assert_eq!(catalog.material_id_for_vault_attachment("v", &canonical).unwrap(), Some(material.id));
        assert_eq!(read_change(&conn).unwrap().version, before);
    }

    #[test]
    fn resolved_material_identity_keeps_note_only_files_and_stale_or_ambiguous_owners_local() {
        let catalog = MaterialCatalog::new_for_test();
        let path = source(&catalog, "vault-only.png");
        let first = catalog.register_note_attachment(&path, "v", None).unwrap();
        let canonical = path.canonicalize().unwrap();
        assert_eq!(catalog.material_id_for_vault_attachment("v", &canonical).unwrap(), None);
        catalog.promote_note_attachment(&first.id, None).unwrap();
        assert_eq!(catalog.material_id_for_vault_attachment("v", &canonical).unwrap(), Some(first.id.clone()));
        let other = source(&catalog, "other.png");
        let second = catalog.register_note_attachment(&other, "v", None).unwrap();
        let conn = catalog.open_write().unwrap();
        conn.execute("UPDATE asset SET original_path=?2 WHERE id=?1", rusqlite::params![first.id, other.to_string_lossy()]).unwrap();
        assert_eq!(catalog.material_id_for_vault_attachment("v", &canonical).unwrap(), None, "a stale registry cannot claim an asset whose current file changed");
        conn.execute("UPDATE asset SET original_path=?2 WHERE id IN (?1,?3)", rusqlite::params![first.id, path.to_string_lossy(), second.id]).unwrap();
        conn.execute("UPDATE material_note_identity SET canonical_path=?2,ordinary=1 WHERE asset_id=?1", rusqlite::params![second.id, canonical.to_string_lossy()]).unwrap();
        assert_eq!(catalog.material_id_for_vault_attachment("v", &canonical).unwrap(), None, "two current registered owners are ambiguous");
        std::fs::remove_file(&path).unwrap();
        assert_eq!(catalog.material_id_for_vault_attachment("v", &canonical).unwrap(), None);
    }

    #[cfg(windows)]
    #[test]
    fn resolved_material_identity_follows_native_roaming_redirection() {
        let roaming = PathBuf::from(std::env::var_os("APPDATA").expect("Windows roaming data path"));
        let fixture = roaming.join(format!("luckyray-identity-{}", unique_id("fixture")));
        std::fs::create_dir(&fixture).unwrap();
        let logical = fixture.join("image.png");
        std::fs::write(&logical, b"isolated material identity fixture").unwrap();
        let canonical = logical.canonicalize().unwrap();
        let catalog = MaterialCatalog::new_for_test();
        let material = catalog.import_paths(&[logical.clone()], &MaterialImportOptions {
            storage_mode: "linked".into(), ..Default::default()
        }).unwrap().value.assets[0].clone();
        catalog.register_note_attachment(&logical, "v", Some(&material.id)).unwrap();
        catalog.open_write().unwrap().execute(
            "UPDATE asset SET original_path=?2 WHERE id=?1",
            rusqlite::params![material.id, logical.to_string_lossy()],
        ).unwrap();
        eprintln!("Native roaming path redirected: {}", lookup_key(&logical) != lookup_key(&canonical));
        let resolved = catalog.material_id_for_vault_attachment("v", &canonical).unwrap();
        // Remove only this test's named file and now-empty directory.
        std::fs::remove_file(&logical).unwrap();
        std::fs::remove_dir(&fixture).unwrap();
        assert_eq!(resolved, Some(material.id));
    }

    #[test]
    fn resolved_material_identity_checks_owned_copy_and_rejects_same_file_at_another_path() {
        let catalog = MaterialCatalog::new_for_test();
        let path = source(&catalog, "original.png");
        let material = catalog.import_paths(&[path.clone()], &MaterialImportOptions {
            storage_mode: "managed".into(), ..Default::default()
        }).unwrap().value.assets[0].clone();
        let owned = Path::new(material.library_path.as_ref().unwrap());
        catalog.register_note_attachment(owned, "v", Some(&material.id)).unwrap();
        assert_eq!(catalog.material_id_for_vault_attachment("v", &owned.canonicalize().unwrap()).unwrap(), Some(material.id.clone()));
        assert_eq!(catalog.material_id_for_vault_attachment("v", &path.canonicalize().unwrap()).unwrap(), None);
        let alias = catalog.app_data_dir().join("hard-link.png");
        std::fs::hard_link(owned, &alias).unwrap();
        assert_eq!(file_binding(owned).unwrap().1, file_binding(&alias).unwrap().1);
        assert_eq!(catalog.material_id_for_vault_attachment("v", &alias.canonicalize().unwrap()).unwrap(), None, "file identity does not authorize a different location");
    }

    #[test]
    fn exact_paths_usage_promotion_and_reference_protection() {
        let catalog = MaterialCatalog::new_for_test();
        let first = source(&catalog, "first.png");
        let second = source(&catalog, "second.png");
        let a = catalog
            .register_note_attachment(&first, "vault-a", None)
            .unwrap();
        let b = catalog
            .register_note_attachment(&second, "vault-a", None)
            .unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(
            catalog
                .register_note_attachment(&first, "vault-b", None)
                .unwrap()
                .id,
            a.id
        );
        assert!(catalog
            .list_assets(&MaterialFilter::default())
            .unwrap()
            .is_empty());
        assert_eq!(
            catalog
                .approved_vault_attachment_paths("vault-a")
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            catalog
                .approved_vault_attachment_paths("vault-b")
                .unwrap()
                .len(),
            1
        );
        assert!(catalog
            .approved_vault_attachment_paths("vault-c")
            .unwrap()
            .is_empty());
        assert_eq!(
            catalog
                .list_assets_scoped(&MaterialFilter::default(), &scope("vault-a", true))
                .unwrap()
                .len(),
            2
        );
        assert!(catalog
            .list_assets_scoped(&MaterialFilter::default(), &scope("vault-a", false))
            .unwrap()
            .is_empty());
        let r = NoteAttachmentRefInput {
            asset_id: a.id.clone(),
            target: "../first.png".into(),
        };
        catalog
            .replace_note_attachment_refs("vault-a", "notes/a.md", &[r.clone(), r.clone()])
            .unwrap();
        catalog
            .replace_note_attachment_refs("vault-b", "b.md", &[r.clone()])
            .unwrap();
        assert_eq!(
            catalog.attachment_details(&a.id).unwrap().reference_count,
            2
        );
        assert_eq!(
            catalog
                .approved_note_attachment_paths("vault-a", "notes/a.md")
                .unwrap(),
            vec![first.canonicalize().unwrap().to_string_lossy().into_owned()]
        );
        assert!(catalog
            .approved_note_attachment_paths("vault-c", "notes/a.md")
            .unwrap()
            .is_empty());
        assert_eq!(
            catalog.for_attachment_projection().delete_asset(&a.id, true).unwrap_err().code,
            "material-in-use-by-notes"
        );
        let promoted = catalog.promote_note_attachment(&a.id, None).unwrap();
        assert_eq!(promoted.original_path, a.original_path);
        assert_eq!(promoted.storage_mode, "linked");
        assert_eq!(
            catalog
                .list_assets(&MaterialFilter::default())
                .unwrap()
                .len(),
            1
        );
        catalog.delete_asset(&a.id, false).unwrap();
        assert!(!catalog.attachment_details(&a.id).unwrap().ordinary);
        assert!(first.exists());
        let invalid = NoteAttachmentRefInput {
            asset_id: "unknown".into(),
            target: "missing".into(),
        };
        assert!(catalog
            .replace_note_attachment_refs("vault-a", "notes/a.md", &[invalid])
            .is_err());
        assert_eq!(
            catalog.attachment_details(&a.id).unwrap().reference_count,
            2
        );
        catalog
            .replace_note_attachment_refs("vault-a", "notes/a.md", &[])
            .unwrap();
        assert_eq!(
            catalog.attachment_details(&a.id).unwrap().reference_count,
            1
        );
        assert!(catalog
            .list_assets_scoped(&MaterialFilter::default(), &scope("vault-a", false))
            .unwrap()
            .is_empty());
        assert_eq!(
            catalog
                .list_assets_scoped(&MaterialFilter::default(), &scope("vault-a", true))
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn ordinary_source_ownership_and_scoped_search_and_tags() {
        let catalog = MaterialCatalog::new_for_test();
        let first = source(&catalog, "ordinary.png");
        let imported = catalog
            .import_paths(
                &[first.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let original = imported.value.assets[0].clone();
        let registered = catalog
            .register_note_attachment(&first, "v", Some(&original.id))
            .unwrap();
        assert_eq!(registered.storage_mode, "source");
        assert_eq!(registered.library_path, original.library_path);
        assert!(catalog.attachment_details(&original.id).unwrap().ordinary);
        let hidden = catalog
            .register_note_attachment(&source(&catalog, "hidden.png"), "v", None)
            .unwrap();
        let conn = catalog.open_write().unwrap();
        conn.execute_batch("CREATE VIRTUAL TABLE asset_search USING fts5(id UNINDEXED,name,description,original_path);").unwrap();
        for id in [&original.id, &hidden.id] {
            conn.execute("INSERT INTO asset_search VALUES(?1,'needle','','')", [id])
                .unwrap();
        }
        assert_eq!(
            catalog.search_assets("needle", 1).unwrap()[0].asset.id,
            original.id
        );
        assert_eq!(
            catalog
                .search_assets_scoped("needle", 10, &scope("v", true))
                .unwrap()
                .len(),
            2
        );
        let tag = catalog.create_tag("test", None).unwrap().value;
        catalog
            .set_asset_tags(&original.id, vec![tag.id.clone()])
            .unwrap();
        catalog
            .for_attachment_projection().set_asset_tags(&hidden.id, vec![tag.id.clone()])
            .unwrap();
        assert_eq!(catalog.list_tags().unwrap()[0].asset_count, 1);
        assert_eq!(
            catalog.list_tags_scoped(&scope("v", true)).unwrap()[0].asset_count,
            2
        );
        assert!(catalog
            .register_note_attachment(&first, "v", Some(&hidden.id))
            .is_err());
    }
    #[cfg(windows)]
    #[test]
    fn coordinated_source_move_across_available_test_volumes_preserves_bytes() {
        let catalog = MaterialCatalog::new_for_test();
        let source = source(&catalog, "cross-volume.png");
        let asset = catalog
            .import_paths(
                &[source.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets[0]
            .clone();
        let target_root = PathBuf::from("D:/codex/luckyray/qa")
            .join(format!("material-move-{}", unique_id("fixture")));
        std::fs::create_dir_all(&target_root).unwrap();
        let destination = target_root.join("copied.png");
        let expected = catalog.note_file_revision_for_asset(&asset).unwrap();
        let before_identity = file_identity(&std::fs::File::open(&source).unwrap()).unwrap();
        let moved = catalog
            .move_asset_file_for_note_coordinator(
                &asset.id,
                &destination,
                &expected,
                &[],
                asset.content_hash.as_deref().unwrap(),
            )
            .unwrap()
            .value
            .unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(&destination).unwrap(), b"same bytes");
        assert_eq!(moved.storage_mode, "source");
        assert_eq!(moved.id, asset.id);
        let after_identity = file_identity(&std::fs::File::open(&destination).unwrap()).unwrap();
        assert_ne!(
            before_identity.split(':').next(),
            after_identity.split(':').next(),
            "fixture must actually cross volumes"
        );
    }
    #[test]
    fn coordinator_revision_binds_path_even_when_time_and_hash_are_unchanged() {
        let catalog = MaterialCatalog::new_for_test();
        let first = source(&catalog, "revision-first.png");
        let second = source(&catalog, "revision-second.png");
        let asset = catalog.register_note_attachment(&first, "v", None).unwrap();
        let old = catalog.note_file_revision_for_asset(&asset).unwrap();
        assert!(catalog.revision_for_asset(&asset).is_err());
        let legacy = catalog.for_attachment_projection().revision_for_asset(&asset).unwrap();
        let conn = catalog.open_write().unwrap();
        conn.execute(
            "UPDATE asset SET original_path=?2 WHERE id=?1",
            rusqlite::params![asset.id, second.to_string_lossy()],
        )
        .unwrap();
        let changed = read_asset_unrestricted(&conn, &asset.id).unwrap();
        assert_eq!(catalog.for_attachment_projection().revision_for_asset(&changed).unwrap(), legacy);
        assert_ne!(catalog.note_file_revision_for_asset(&changed).unwrap(), old);
        assert_eq!(
            assert_asset_revision(&conn, &changed, Some(&old))
                .unwrap_err()
                .code,
            "material-revision-conflict"
        );
    }
    #[test]
    fn discovery_uses_unique_identity_only_in_registered_parent_directories() {
        let catalog = MaterialCatalog::new_for_test();
        let old = source(&catalog, "discover-old.png");
        let asset = catalog.register_note_attachment(&old, "v", None).unwrap();
        let renamed = old.with_file_name("discover-new.png");
        std::fs::rename(&old, &renamed).unwrap();
        source(&catalog, "same-hash-different-file.png");
        let found = catalog.discover_note_attachment_moves("v").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].asset_id, asset.id);
        assert_eq!(
            Path::new(&found[0].new_path).canonicalize().unwrap(),
            renamed.canonicalize().unwrap()
        );
        assert_eq!(
            catalog
                .attachment_details(&asset.id)
                .unwrap()
                .absolute_path
                .as_deref(),
            Some(found[0].previous_path.as_str())
        );
        let alias = old.with_file_name("hardlink-alias.png");
        std::fs::hard_link(&renamed, &alias).unwrap();
        assert!(
            catalog
                .discover_note_attachment_moves("v")
                .unwrap()
                .is_empty(),
            "two identity matches must remain ambiguous"
        );
        std::fs::remove_file(&alias).unwrap();
        let outside = catalog.app_data_dir().join("unregistered-subdirectory");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::rename(&renamed, outside.join("moved.png")).unwrap();
        assert!(
            catalog
                .discover_note_attachment_moves("v")
                .unwrap()
                .is_empty(),
            "never recurse into an unregistered directory"
        );
        assert!(catalog
            .discover_note_attachment_moves("unrelated-vault")
            .unwrap()
            .is_empty());
    }
    #[test]
    fn prune_only_confirmed_missing_notes_and_fence_concurrent_index_updates() {
        let catalog = MaterialCatalog::new_for_test();
        let file = source(&catalog, "prune.png");
        let asset = catalog.register_note_attachment(&file, "a", None).unwrap();
        catalog
            .register_note_attachment(&file, "b", Some(&asset.id))
            .unwrap();
        let reference = NoteAttachmentRefInput {
            asset_id: asset.id.clone(),
            target: "prune.png".into(),
        };
        for note in ["keep.md", "gone.md"] {
            catalog
                .replace_note_attachment_refs("a", note, &[reference.clone()])
                .unwrap();
        }
        let old_version = catalog.read_change().unwrap().version;
        catalog
            .replace_note_attachment_refs("b", "other.md", &[reference])
            .unwrap();
        assert_eq!(
            catalog
                .prune_note_attachment_refs("a", &["keep.md".into()], old_version)
                .unwrap_err()
                .code,
            "note-reference-index-changed"
        );
        assert_eq!(
            catalog
                .attachment_details(&asset.id)
                .unwrap()
                .reference_count,
            3
        );
        let version = catalog.read_change().unwrap().version;
        assert_eq!(
            catalog
                .prune_note_attachment_refs("a", &["keep.md".into()], version)
                .unwrap(),
            1
        );
        assert_eq!(
            catalog
                .attachment_details(&asset.id)
                .unwrap()
                .reference_count,
            2
        );
        assert!(file.exists());
        let version = catalog.read_change().unwrap().version;
        assert_eq!(
            catalog
                .prune_note_attachment_refs("a", &["keep.md".into()], version)
                .unwrap(),
            0
        );
        assert_eq!(catalog.read_change().unwrap().version, version);
        assert_eq!(
            catalog
                .list_assets_scoped(&MaterialFilter::default(), &scope("a", true))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            catalog.for_attachment_projection().delete_asset(&asset.id, true).unwrap_err().code,
            "material-in-use-by-notes"
        );
    }

    #[test]
    fn scoped_query_composes_with_tags_kind_and_limit_without_wildcard_leaks() {
        let catalog = MaterialCatalog::new_for_test();
        let first = source(&catalog, "ordinary-query.png");
        catalog
            .import_paths(
                &[first],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let hidden = catalog
            .register_note_attachment(&source(&catalog, "Beta.png"), "v", None)
            .unwrap();
        let conn = catalog.open_write().unwrap();
        conn.execute(
            "UPDATE asset SET description='100% 中文' WHERE id=?1",
            [&hidden.id],
        )
        .unwrap();
        let tag = catalog.create_tag("query-tag", None).unwrap().value;
        catalog
            .for_attachment_projection().set_asset_tags(&hidden.id, vec![tag.id.clone()])
            .unwrap();
        let filter = MaterialFilter {
            query: Some("100%".into()),
            tag_ids: vec![tag.id],
            kinds: vec!["image".into()],
            limit: Some(1),
            ..Default::default()
        };
        assert!(catalog.list_assets(&filter).unwrap().is_empty());
        assert_eq!(
            catalog
                .list_assets_scoped(&filter, &scope("v", true))
                .unwrap()[0]
                .id,
            hidden.id
        );
        for query in ["BETA", "中文"] {
            assert_eq!(
                catalog
                    .list_assets_scoped(
                        &MaterialFilter {
                            query: Some(query.into()),
                            limit: Some(1),
                            ..Default::default()
                        },
                        &scope("v", true)
                    )
                    .unwrap()[0]
                    .id,
                hidden.id
            );
        }
        assert!(catalog
            .list_assets_scoped(
                &MaterialFilter {
                    query: Some("100_".into()),
                    ..Default::default()
                },
                &scope("v", true)
            )
            .unwrap()
            .is_empty());
    }

    #[test]
    fn managed_uses_owned_copy_and_reindex_is_idempotent() {
        let catalog = MaterialCatalog::new_for_test();
        let path = source(&catalog, "original.png");
        let material = catalog
            .import_paths(
                &[path.clone()],
                &MaterialImportOptions {
                    storage_mode: "managed".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets[0]
            .clone();
        assert!(catalog
            .register_note_attachment(&path, "v", Some(&material.id))
            .is_err());
        let owned = Path::new(material.library_path.as_ref().unwrap());
        catalog
            .register_note_attachment(owned, "v", Some(&material.id))
            .unwrap();
        let refs = vec![NoteAttachmentRefInput {
            asset_id: material.id.clone(),
            target: "../library/original.png".into(),
        }];
        catalog
            .replace_note_attachment_refs("v", "n.md", &refs)
            .unwrap();
        let before = read_change(&catalog.open_write().unwrap()).unwrap().version;
        catalog
            .register_note_attachment(owned, "v", Some(&material.id))
            .unwrap();
        catalog
            .replace_note_attachment_refs("v", "n.md", &refs)
            .unwrap();
        assert_eq!(
            read_change(&catalog.open_write().unwrap()).unwrap().version,
            before
        );
        assert_eq!(
            catalog
                .attachment_details(&material.id)
                .unwrap()
                .reference_count,
            1
        );
    }
    #[test]
    fn referenced_source_mutations_require_note_coordinator() {
        let catalog = MaterialCatalog::new_for_test();
        let path = source(&catalog, "owned.png");
        let original = catalog
            .import_paths(
                &[path.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets[0]
            .clone();
        catalog
            .register_note_attachment(&path, "v", Some(&original.id))
            .unwrap();
        catalog
            .replace_note_attachment_refs(
                "v",
                "n.md",
                &[NoteAttachmentRefInput {
                    asset_id: original.id.clone(),
                    target: "owned.png".into(),
                }],
            )
            .unwrap();
        assert_eq!(
            catalog
                .rename_asset_file(&original.id, "renamed.png")
                .unwrap_err()
                .code,
            "material-in-use-by-notes"
        );
        assert_eq!(
            catalog
                .relocate_asset(&original.id, &path, &MaterialRelocateOptions::default())
                .unwrap_err()
                .code,
            "material-in-use-by-notes"
        );
        assert!(path.exists());
        assert!(!path.with_file_name("renamed.png").exists());
        assert_eq!(
            catalog
                .attachment_details(&original.id)
                .unwrap()
                .reference_count,
            1
        );
    }
    #[test]
    fn linked_coordinator_relocates_same_content_without_owning_file() {
        let catalog = MaterialCatalog::new_for_test();
        let path = source(&catalog, "linked.png");
        let asset = catalog.register_note_attachment(&path, "v", None).unwrap();
        catalog
            .replace_note_attachment_refs(
                "v",
                "n.md",
                &[NoteAttachmentRefInput {
                    asset_id: asset.id.clone(),
                    target: "linked.png".into(),
                }],
            )
            .unwrap();
        let snapshot = catalog.attachment_details(&asset.id).unwrap().references;
        let recovered = source(&catalog, "linked-recovered.png");
        let changed = catalog
            .relocate_asset_for_note_coordinator(
                &asset.id,
                &recovered,
                &MaterialRelocateOptions::default(),
                None,
                &snapshot,
            )
            .unwrap()
            .value
            .unwrap();
        assert_eq!(changed.id, asset.id);
        assert_eq!(changed.storage_mode, "linked");
        assert!(changed.library_path.is_none());
        assert!(!catalog.attachment_details(&asset.id).unwrap().ordinary);
        assert!(path.exists());
        assert!(recovered.exists());
        assert_eq!(
            catalog.for_attachment_projection().delete_asset(&asset.id, true).unwrap_err().code,
            "material-in-use-by-notes"
        );
    }
    #[test]
    fn coordinator_preserves_asset_and_rechecks_all_vault_references() {
        let catalog = MaterialCatalog::new_for_test();
        let path = source(&catalog, "coordinated.png");
        let original = catalog
            .import_paths(
                &[path.clone()],
                &MaterialImportOptions {
                    storage_mode: "source".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets[0]
            .clone();
        for vault in ["a", "b"] {
            catalog
                .register_note_attachment(&path, vault, Some(&original.id))
                .unwrap();
            catalog
                .replace_note_attachment_refs(
                    vault,
                    "n.md",
                    &[NoteAttachmentRefInput {
                        asset_id: original.id.clone(),
                        target: "coordinated.png".into(),
                    }],
                )
                .unwrap();
        }
        let snapshot = catalog.attachment_details(&original.id).unwrap().references;
        assert_eq!(
            catalog
                .rename_asset_file_for_note_coordinator(
                    &original.id,
                    "renamed.png",
                    None,
                    &snapshot[..1]
                )
                .unwrap_err()
                .code,
            "note-references-changed"
        );
        assert!(path.exists());
        let renamed = catalog
            .rename_asset_file_for_note_coordinator(&original.id, "renamed.png", None, &snapshot)
            .unwrap()
            .value
            .unwrap();
        assert_eq!(renamed.id, original.id);
        assert_eq!(renamed.storage_mode, "source");
        assert!(!path.exists());
        let details = catalog.attachment_details(&original.id).unwrap();
        assert!(details.ordinary);
        assert_eq!(details.reference_count, 2);
        let renamed_path = PathBuf::from(renamed.library_path.as_ref().unwrap());
        assert_eq!(
            details.absolute_path.as_deref(),
            Some(renamed_path.to_string_lossy().as_ref())
        );
        let recovered = source(&catalog, "recovered.png");
        assert_eq!(
            catalog
                .relocate_asset_for_note_coordinator(
                    &original.id,
                    &recovered,
                    &MaterialRelocateOptions::default(),
                    None,
                    &snapshot
                )
                .unwrap_err()
                .code,
            "note-references-changed"
        );
        let relocated = catalog
            .relocate_asset_for_note_coordinator(
                &original.id,
                &recovered,
                &MaterialRelocateOptions::default(),
                None,
                &details.references,
            )
            .unwrap()
            .value
            .unwrap();
        assert_eq!(relocated.id, original.id);
        assert_eq!(relocated.storage_mode, "source");
        assert!(renamed_path.exists());
        assert!(recovered.exists());
        assert_eq!(
            catalog
                .attachment_details(&original.id)
                .unwrap()
                .reference_count,
            2
        );
        assert_eq!(
            catalog.approved_vault_attachment_paths("a").unwrap(),
            vec![recovered
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned()]
        );
    }
    #[test]
    fn atomic_save_retains_exact_path_authority_and_missing_reference() {
        let catalog = MaterialCatalog::new_for_test();
        let path = source(&catalog, "changed.png");
        let a = catalog.register_note_attachment(&path, "v", None).unwrap();
        catalog
            .replace_note_attachment_refs(
                "v",
                "n.md",
                &[NoteAttachmentRefInput {
                    asset_id: a.id,
                    target: "changed.png".into(),
                }],
            )
            .unwrap();
        std::fs::rename(&path, path.with_extension("old")).unwrap();
        std::fs::write(&path, b"same bytes").unwrap();
        assert_eq!(
            catalog
                .approved_note_attachment_paths("v", "n.md")
                .unwrap()
                .len(),
            1
        );
        std::fs::remove_file(&path).unwrap();
        assert!(catalog
            .approved_note_attachment_paths("v", "n.md")
            .unwrap()
            .is_empty());
        assert_eq!(catalog.note_attachment_refs("v", "n.md").unwrap().len(), 1);
    }
}
