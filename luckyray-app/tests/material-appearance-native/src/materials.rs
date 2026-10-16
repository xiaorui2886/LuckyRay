#[path = "../../../src-tauri/src/materials/adapters.rs"]
mod adapters;
#[path = "../../../src-tauri/src/materials/catalog.rs"]
mod catalog;
#[path = "../../../src-tauri/src/materials/csv_export.rs"]
mod csv_export;
#[path = "../../../src-tauri/src/materials/export.rs"]
mod export;
#[path = "../../../src-tauri/src/materials/models.rs"]
mod models;
#[path = "../../../src-tauri/src/materials/video_tools.rs"]
mod video_tools;
#[path = "../../../src-tauri/src/materials/appearance_descriptor.rs"]
mod appearance_descriptor;
#[path = "../../../src-tauri/src/materials/appearance.rs"]
mod appearance;
#[path = "../../../src-tauri/src/materials/libraries.rs"]
mod libraries;
#[path = "../../../src-tauri/src/materials/library_commands.rs"]
mod library_commands;
#[path = "../../../src-tauri/src/materials/library_package.rs"]
mod library_package;
#[path = "../../../src-tauri/src/materials/library_package_preferences.rs"]
mod library_package_preferences;
#[path = "../../../src-tauri/src/materials/library_archive.rs"]
mod library_archive;
#[path = "../../../src-tauri/src/materials/library_transfer.rs"]
mod library_transfer;
#[path = "../../../src-tauri/src/materials/library_transfer_io.rs"]
mod library_transfer_io;
#[path = "../../../src-tauri/src/materials/library_transfer_commit.rs"]
mod library_transfer_commit;
#[path = "../../../src-tauri/src/materials/library_merge.rs"]
mod library_merge;
#[path = "../../../src-tauri/src/materials/library_move.rs"]
mod library_move;
pub(crate) use library_transfer::{apply_transfer_schema_v25,migrate_transfer_schema_v26,verify_transfer_schema,library_transfer_manager};
pub(crate) use library_package::TransferSelection;
pub(crate) use library_commands::{execute_library_request,LibraryRequest,LibraryAction};
pub(crate) use libraries::{apply_library_schema, verify_library_schema, MaterialLibrary};
pub(crate) use libraries::{namespace_condition as library_namespace_condition, assert_member as assert_library_member, bind_smart_library};

pub(crate) use adapters::*;
pub(crate) use catalog::{
    asset_revision_by_id_in, ensure_change_schema, material_revision, publish_change_metadata, read_change, resolve_media_staging_root, MaterialCatalog,
};
pub(crate) use models::*;
pub(crate) use export::{export_manager, ExportPlanRequest, ExportPlanSummary, ExportTaskStatus};
pub(crate) use csv_export::{csv_export_manager, CsvExportPlanRequest, CsvExportPlanSummary, CsvExportTaskStatus};
