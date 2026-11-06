// Production domain sources; no app process, Tauri, network or transport stubs.
#[path = "../../../src-tauri/src/materials/adapters.rs"]
mod adapters;
#[path = "../../../src-tauri/src/materials/catalog.rs"]
mod catalog;
#[path = "../../../src-tauri/src/materials/consumer.rs"]
pub(crate) mod consumer;
#[path = "../../../src-tauri/src/materials/csv_export.rs"]
mod csv_export;
#[path = "../../../src-tauri/src/materials/export.rs"]
mod export;
#[path = "../../../src-tauri/src/materials/libraries.rs"]
mod libraries;
#[path = "../../../src-tauri/src/materials/models.rs"]
mod models;
pub(crate) use adapters::*;
pub(crate) use catalog::{ensure_change_schema, MaterialCatalog};
pub(crate) use libraries::apply_library_schema;
pub(crate) use models::*;
