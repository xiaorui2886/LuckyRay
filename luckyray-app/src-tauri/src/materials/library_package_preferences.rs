//! Portable presentation fields only. Local file/monitor authority is never restored.
use super::library_package::{fail, LibraryPackage};
use super::MaterialResult;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub(super) const PREF_KEYS: &[&str] = &[
    "luckyray-materials-view-v1",
    "luckyray-materials-sort-v1",
    "luckyray-materials-zoom-v1",
    "luckyray-materials-filter-v1",
    "luckyray-materials-workview-v1",
];
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct Filter {
    kinds: Vec<String>,
    tag_ids: Vec<String>,
    recent_only: bool,
    storage_mode: String,
    folder_id: Option<String>,
    color: Option<String>,
    date_from: String,
    date_to: String,
    rating_min: Option<i64>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct View {
    view_mode: String,
    zoom: f64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkView {
    active: String,
    saved: HashMap<String, View>,
}
fn valid_mode(value: &str) -> bool {
    matches!(value, "masonry" | "grid" | "list")
}
fn valid_preset(value: &str) -> bool {
    matches!(value, "general" | "design" | "video")
}
fn filter_valid(f: &Filter) -> bool {
    let list = |values: &[String]| {
        values.len() <= 32
            && values
                .iter()
                .all(|v| !v.is_empty() && v.len() <= 256 && !v.chars().any(char::is_control))
    };
    let date = |v: &str| v.is_empty() || chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d").is_ok();
    let color = f
        .color
        .as_ref()
        .is_none_or(|v| v.len() <= 64 && !v.chars().any(char::is_control));
    list(&f.kinds)
        && list(&f.tag_ids)
        && matches!(
            f.storage_mode.as_str(),
            "all" | "managed" | "linked" | "source" | ""
        )
        && date(&f.date_from)
        && date(&f.date_to)
        && color
        && f.rating_min.is_none_or(|r| (0..=5).contains(&r))
}
fn sanitize_filter(
    raw: &str,
    folders: &HashSet<&String>,
    tags: &HashSet<&String>,
) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let mut allowed = serde_json::Map::new();
    for key in [
        "kinds",
        "tagIds",
        "recentOnly",
        "storageMode",
        "folderId",
        "color",
        "dateFrom",
        "dateTo",
        "ratingMin",
    ] {
        if let Some(v) = value.get(key) {
            allowed.insert(key.into(), v.clone());
        }
    }
    let mut f: Filter = serde_json::from_value(Value::Object(allowed)).ok()?;
    if !filter_valid(&f) {
        return None;
    }
    f.tag_ids.retain(|id| tags.contains(id));
    if f.folder_id.as_ref().is_some_and(|id| !folders.contains(id)) {
        f.folder_id = None;
    }
    serde_json::to_string(&f).ok()
}
fn sanitize_work(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let active = value.get("active")?.as_str()?;
    if !valid_preset(active) {
        return None;
    }
    let mut saved = serde_json::Map::new();
    if let Some(object) = value.get("saved").and_then(Value::as_object) {
        for (preset, view) in object {
            if !valid_preset(preset) {
                continue;
            }
            let mode = view.get("viewMode")?.as_str()?;
            let zoom = view.get("zoom")?.as_f64()?;
            if valid_mode(mode) && (60.0..=300.0).contains(&zoom) {
                saved.insert(preset.clone(), json!({"viewMode":mode,"zoom":zoom}));
            }
        }
    }
    serde_json::to_string(&json!({"active":active,"saved":saved})).ok()
}
pub(super) fn portable_preferences(
    value: &Value,
    folders: &HashSet<&String>,
    tags: &HashSet<&String>,
) -> Value {
    let mut result = serde_json::Map::new();
    for key in PREF_KEYS {
        let Some(raw) = value.get(*key).and_then(Value::as_str) else {
            continue;
        };
        let normalized = match *key {
            "luckyray-materials-view-v1" if valid_mode(raw) => Some(raw.into()),
            "luckyray-materials-sort-v1" if matches!(raw, "recent" | "newest" | "random") => {
                Some(raw.into())
            }
            "luckyray-materials-zoom-v1" => raw
                .parse::<f64>()
                .ok()
                .filter(|v| (60.0..=300.0).contains(v))
                .map(|v| v.to_string()),
            "luckyray-materials-filter-v1" => sanitize_filter(raw, folders, tags),
            "luckyray-materials-workview-v1" => sanitize_work(raw),
            _ => None,
        };
        if let Some(v) = normalized {
            result.insert((*key).into(), Value::String(v));
        }
    }
    Value::Object(result)
}
pub(super) fn validate_preferences(p: &LibraryPackage) -> MaterialResult<()> {
    let object = p
        .preferences
        .as_object()
        .ok_or_else(|| fail("库偏好不是可移植对象"))?;
    let folders: HashSet<_> = p.folders.iter().map(|f| &f.id).collect();
    let tags: HashSet<_> = p.tags.iter().map(|t| &t.id).collect();
    for (key, value) in object {
        if !PREF_KEYS.contains(&key.as_str()) {
            return Err(fail("库偏好含非可移植字段"));
        }
        let raw = value.as_str().ok_or_else(|| fail("库偏好字段类型无效"))?;
        let valid = match key.as_str() {
            "luckyray-materials-view-v1" => valid_mode(raw),
            "luckyray-materials-sort-v1" => matches!(raw, "recent" | "newest" | "random"),
            "luckyray-materials-zoom-v1" => raw
                .parse::<f64>()
                .is_ok_and(|n| (60.0..=300.0).contains(&n)),
            "luckyray-materials-filter-v1" => serde_json::from_str::<Filter>(raw).is_ok_and(|f| {
                filter_valid(&f)
                    && f.tag_ids.iter().all(|id| tags.contains(id))
                    && f.folder_id.as_ref().is_none_or(|id| folders.contains(id))
            }),
            "luckyray-materials-workview-v1" => {
                serde_json::from_str::<WorkView>(raw).is_ok_and(|w| {
                    valid_preset(&w.active)
                        && w.saved.iter().all(|(k, v)| {
                            valid_preset(k)
                                && valid_mode(&v.view_mode)
                                && (60.0..=300.0).contains(&v.zoom)
                        })
                })
            }
            _ => false,
        };
        if !valid {
            return Err(fail("库偏好字段/组织引用无效"));
        }
    }
    Ok(())
}
