//! Thin adapters to existing domain authorities. No plugin-supplied disk paths.
use crate::{
    extension_broker::{Rpc, Session},
    knowledge::{KnowledgeCreateInput, KnowledgeDocumentRef, KnowledgeInsertInput},
};
use serde_json::{json, Value};
use std::{
    io::{Cursor, Read},
    path::Path,
};
fn string<'a>(p: &'a Value, key: &str) -> Result<&'a str, String> {
    p.get(key)
        .and_then(Value::as_str)
        .ok_or("plugin-parameters".into())
}
fn bounded(p: &Value, key: &str, max: usize) -> Result<String, String> {
    let value = string(p, key)?;
    if value.len() > max {
        return Err("plugin-parameter-limit".into());
    }
    Ok(value.to_string())
}
pub fn dispatch(root: &Path, s: &mut Session, call: &Rpc) -> Result<Value, String> {
    let backend = crate::backend_services()?;
    let p = &call.params;
    match call.method.as_str() {
        "materials.library.list" | "materials.library.read" => {
            s.require_current(root, env!("CARGO_PKG_VERSION"))?;
            crate::materials::consumer_broker::read(
                backend.material_catalog(),
                s.scope.material_library_id.as_deref().ok_or("plugin-object-denied")?,
                &s.scope.material_ids, call.method.as_str(), p,
            ).map_err(|error| error.code)
        }
        "materials.list" => s
            .scope
            .material_ids
            .iter()
            .map(|id| material_metadata(backend, id))
            .collect::<Result<Vec<_>, _>>()
            .map(|v| json!(v)),
        "materials.read" => material_metadata(backend, string(p, "id")?),
        "materials.tags" => {
            let id = string(p, "id")?;
            let tags: Vec<String> =
                serde_json::from_value(p.get("tags").cloned().ok_or("plugin-parameters")?)
                    .map_err(|_| "plugin-parameters")?;
            if tags.len() > 12 || tags.iter().any(|x| x.len() > 80) {
                return Err("plugin-parameter-limit".into());
            }
            s.require_current(root, env!("CARGO_PKG_VERSION"))?;
            let result = backend
                .agent_materials()
                .add_tag_names(id, string(p, "revision")?, &tags)
                .map_err(|e| e.code.to_string())?;
            serde_json::to_value(result).map_err(|_| "plugin-serialization".into())
        }
        "materials.image.open" => {
            if s.images.len() >= 4 {
                return Err("plugin-image-limit".into());
            }
            let catalog = backend.material_catalog();
            let id = string(p, "id")?;
            let (asset, mut file) = catalog
                .companion_resource(id, false)
                .map_err(|_| "plugin-image-unavailable")?;
            if asset.kind != "image"
                || file
                    .metadata()
                    .map_err(|_| "plugin-image-unavailable")?
                    .len()
                    > 8 * 1024 * 1024
            {
                return Err("plugin-image-limit".into());
            }
            let revision = catalog
                .revision_for_asset(&asset)
                .map_err(|_| "plugin-image-unavailable")?;
            if revision != string(p, "revision")? {
                return Err("plugin-revision-conflict".into());
            }
            let mut bytes = Vec::new();
            file.by_ref()
                .take(8 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "plugin-image-unavailable")?;
            if bytes.len() > 8 * 1024 * 1024 {
                return Err("plugin-image-limit".into());
            }
            let mut reader = image::ImageReader::new(Cursor::new(bytes))
                .with_guessed_format()
                .map_err(|_| "plugin-image-format")?;
            let mut limits = image::Limits::default();
            limits.max_image_width = Some(4096);
            limits.max_image_height = Some(4096);
            limits.max_alloc = Some(64 * 1024 * 1024);
            reader.limits(limits);
            let image = reader
                .decode()
                .map_err(|_| "plugin-image-decode")?
                .thumbnail(128, 128)
                .to_rgba8();
            if catalog
                .revision_for_asset(&asset)
                .map_err(|_| "plugin-image-unavailable")?
                != revision
            {
                return Err("plugin-revision-conflict".into());
            }
            s.require_current(root, env!("CARGO_PKG_VERSION"))?;
            let token = rand::random::<[u8; 16]>()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let width = image.width();
            let height = image.height();
            s.images.insert(
                token.clone(),
                json!({"width":width,"height":height,"rgba":image.into_raw()}),
            );
            Ok(json!({"handle":token,"width":width,"height":height,"format":"rgba8"}))
        }
        "materials.image.read" => s
            .images
            .get(string(p, "handle")?)
            .cloned()
            .ok_or("plugin-handle-denied".into()),
        "materials.image.release" => {
            if s.images.remove(string(p, "handle")?).is_none() {
                return Err("plugin-handle-denied".into());
            }
            Ok(Value::Null)
        }
        "knowledge.read" | "knowledge.selection" | "knowledge.create" | "knowledge.insert" => {
            let scope = s.scope.knowledge.as_ref().ok_or("plugin-object-denied")?;
            let service = backend.knowledge();
            let doc = if let Some(path) = p.get("path").and_then(Value::as_str) {
                Some(KnowledgeDocumentRef {
                    vault_id: scope.vault_id.clone(),
                    relative_path: path.to_string(),
                })
            } else {
                None
            };
            match call.method.as_str() {
                "knowledge.read" => {
                    let doc = doc.ok_or("plugin-parameters")?;
                    let value = service
                        .with_plugin_source(scope.source_epoch, Some(&doc), || {
                            service.read_document(&doc)
                        })
                        .map_err(crate::knowledge_error)?;
                    if value.content.len() > 131072 {
                        return Err("plugin-document-limit".into());
                    }
                    serde_json::to_value(value).map_err(|_| "plugin-serialization".into())
                }
                "knowledge.selection" => {
                    let context = service
                        .with_plugin_source(scope.source_epoch, None, || {
                            service.get_current_context()
                        })
                        .map_err(crate::knowledge_error)?
                        .ok_or("plugin-selection-unavailable")?;
                    if context.document_ref.vault_id != scope.vault_id
                        || !scope
                            .documents
                            .contains(&context.document_ref.relative_path)
                    {
                        return Err("plugin-object-denied".into());
                    }
                    let snapshot = service
                        .with_plugin_source(scope.source_epoch, Some(&context.document_ref), || {
                            service.read_document(&context.document_ref)
                        })
                        .map_err(crate::knowledge_error)?;
                    if snapshot.revision != context.expected_revision {
                        return Err("plugin-revision-conflict".into());
                    }
                    Ok(
                        json!({"documentRef":context.document_ref,"revision":snapshot.revision,"selection":context.selection,"cursorOffset":context.cursor_offset}),
                    )
                }
                "knowledge.create" => {
                    let input = KnowledgeCreateInput {
                        title: bounded(p, "title", 200)?,
                        content: bounded(p, "content", 32768)?,
                        parent_relative_path: scope.parent_relative_path.clone(),
                    };
                    s.require_current(root, env!("CARGO_PKG_VERSION"))?;
                    let value = service
                        .with_plugin_source(scope.source_epoch, None, || {
                            service.create_document(&input)
                        })
                        .map_err(crate::knowledge_error)?;
                    serde_json::to_value(value).map_err(|_| "plugin-serialization".into())
                }
                _ => {
                    let doc = doc.ok_or("plugin-parameters")?;
                    let input = KnowledgeInsertInput {
                        document_ref: doc.clone(),
                        offset: p
                            .get("offset")
                            .and_then(Value::as_u64)
                            .filter(|v| *v <= 1000000)
                            .ok_or("plugin-parameters")? as usize,
                        text: bounded(p, "text", 16384)?,
                        expected_revision: Some(bounded(p, "revision", 200)?),
                    };
                    s.require_current(root, env!("CARGO_PKG_VERSION"))?;
                    let value = service
                        .with_plugin_source(scope.source_epoch, Some(&doc), || {
                            service.insert_document(&input)
                        })
                        .map_err(crate::knowledge_error)?;
                    serde_json::to_value(value).map_err(|_| "plugin-serialization".into())
                }
            }
        }
        "canvas.read" | "canvas.export" => {
            let doc = crate::canvas_agent::load_document(root, string(p, "id")?)
                .map_err(|e| e.code.to_string())?;
            let graph = canvas_view(&doc)?;
            if call.method == "canvas.read" {
                return Ok(graph);
            }
            if doc.content_digest != string(p, "digest")? {
                return Err("plugin-revision-conflict".into());
            }
            if s.receipts.iter().any(|r| r["method"] == "canvas.export") {
                return Err("plugin-export-already-written".into());
            }
            let path = s
                .scope
                .export_path
                .as_ref()
                .ok_or("plugin-export-destination-required")?;
            let svg = graph_svg(&graph);
            s.require_current(root, env!("CARGO_PKG_VERSION"))?;
            std::fs::write(path, svg.as_bytes()).map_err(|_| "plugin-export-write-failed")?;
            Ok(
                json!({"format":"svg","bytes":svg.len(),"nodes":graph["nodes"].as_array().map(Vec::len),"edges":graph["edges"].as_array().map(Vec::len)}),
            )
        }
        _ => Err("plugin-method-unavailable".into()),
    }
}
fn material_metadata(backend: &crate::backend::BackendServices, id: &str) -> Result<Value, String> {
    let asset = backend
        .agent_materials()
        .inspect(id)
        .map_err(|e| e.code.to_string())?;
    let mut value = serde_json::to_value(asset).map_err(|_| "plugin-serialization")?;
    // Only metadata: never original/library path or thumbnail URL.
    let catalog = backend.material_catalog();
    let objects = catalog
        .get_assets(&[id.to_string()])
        .map_err(|_| "plugin-material-unavailable")?;
    if let Some(object) = objects.first() {
        value["storageMode"] = json!(object.storage_mode);
    }
    Ok(value)
}
fn canvas_view(doc: &crate::canvas_agent::CanvasDocument) -> Result<Value, String> {
    let nodes = doc.nodes.as_array().ok_or("plugin-canvas-format")?;
    let edges = doc.edges.as_array().ok_or("plugin-canvas-format")?;
    if nodes.len() > 500 || edges.len() > 2000 {
        return Err("plugin-canvas-limit".into());
    }
    if nodes.iter().any(|n| {
        n["id"].as_str().is_none_or(|id| id.len() > 160)
            || n["type"].as_str().is_some_and(|kind| kind.len() > 80)
    }) || edges
        .iter()
        .any(|e| e["id"].as_str().is_none_or(|id| id.len() > 160))
    {
        return Err("plugin-canvas-format".into());
    }
    let number = |v: Option<f64>| v.unwrap_or(0.0).clamp(-100000.0, 100000.0);
    let nodes:Vec<Value>=nodes.iter().map(|n|json!({"id":n["id"],"type":n["type"].as_str().unwrap_or("node"),"title":n.pointer("/data/title").or_else(||n.pointer("/data/label")).and_then(Value::as_str).unwrap_or("Node").chars().take(160).collect::<String>(),"x":number(n.pointer("/position/x").and_then(Value::as_f64)),"y":number(n.pointer("/position/y").and_then(Value::as_f64))})).collect();
    let ids: Vec<&str> = nodes.iter().filter_map(|n| n["id"].as_str()).collect();
    let edges: Vec<Value> = edges
        .iter()
        .filter(|e| {
            e["source"].as_str().is_some_and(|s| ids.contains(&s))
                && e["target"].as_str().is_some_and(|s| ids.contains(&s))
        })
        .map(|e| json!({"id":e["id"],"source":e["source"],"target":e["target"]}))
        .collect();
    Ok(
        json!({"id":doc.canvas_id,"name":doc.name,"revision":doc.revision,"digest":doc.content_digest,"nodes":nodes,"edges":edges,"snapshot":"saved","attachments":"excluded"}),
    )
}
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\"', "&quot;")
        .replace('\'', "&apos;")
}
fn graph_svg(graph: &Value) -> String {
    let nodes = graph["nodes"].as_array().unwrap();
    let xs: Vec<f64> = nodes
        .iter()
        .map(|n| n["x"].as_f64().unwrap_or(0.))
        .collect();
    let ys: Vec<f64> = nodes
        .iter()
        .map(|n| n["y"].as_f64().unwrap_or(0.))
        .collect();
    let minx = xs.iter().copied().reduce(f64::min).unwrap_or(0.) - 30.;
    let miny = ys.iter().copied().reduce(f64::min).unwrap_or(0.) - 80.;
    let width = xs.iter().copied().reduce(f64::max).unwrap_or(0.) - minx + 190.;
    let height = ys.iter().copied().reduce(f64::max).unwrap_or(0.) - miny + 78.;
    let mut out=format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{minx} {miny} {width} {height}\"><defs><marker id=\"arrow\" viewBox=\"0 0 10 10\" refX=\"10\" refY=\"5\" markerWidth=\"8\" markerHeight=\"8\" orient=\"auto-start-reverse\"><path d=\"M 0 0 L 10 5 L 0 10 z\" fill=\"#586477\"/></marker></defs><title>");
    out += &xml(graph["name"].as_str().unwrap_or("Canvas"));
    out += "</title>";
    let pos = |id: &Value| {
        nodes
            .iter()
            .find(|n| n["id"] == *id)
            .map(|n| {
                (
                    n["x"].as_f64().unwrap_or(0.) + 80.,
                    n["y"].as_f64().unwrap_or(0.) + 24.,
                )
            })
            .unwrap_or((0., 0.))
    };
    for edge in graph["edges"].as_array().unwrap() {
        let (cx1, cy1) = pos(&edge["source"]);
        let (cx2, cy2) = pos(&edge["target"]);
        let dx = cx2 - cx1;
        let dy = cy2 - cy1;
        if dx.abs() < 0.01 && dy.abs() < 0.01 {
            out+=&format!("<path d=\"M {} {} C {} {}, {} {}, {} {}\" fill=\"none\" stroke=\"#586477\" marker-end=\"url(#arrow)\"/>",cx1+50.,cy1-24.,cx1+90.,cy1-75.,cx1-90.,cy1-75.,cx1-50.,cy1-24.);
            continue;
        }
        let fraction = (80. / dx.abs()).min(24. / dy.abs()).min(0.49);
        let (x1, y1) = (cx1 + dx * fraction, cy1 + dy * fraction);
        let (x2, y2) = (cx2 - dx * fraction, cy2 - dy * fraction);
        out+=&format!("<line x1=\"{x1}\" y1=\"{y1}\" x2=\"{x2}\" y2=\"{y2}\" stroke=\"#586477\" marker-end=\"url(#arrow)\"/>");
    }
    for node in nodes {
        let x = node["x"].as_f64().unwrap_or(0.);
        let y = node["y"].as_f64().unwrap_or(0.);
        out+=&format!("<g><rect x=\"{x}\" y=\"{y}\" width=\"160\" height=\"48\" rx=\"6\" fill=\"#f0f3f8\" stroke=\"#586477\"/><text x=\"{}\" y=\"{}\" font-size=\"12\" fill=\"#172033\">{}</text></g>",x+8.,y+28.,xml(node["title"].as_str().unwrap_or("Node")));
    }
    out += "</svg>";
    out
}
