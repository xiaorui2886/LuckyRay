//! EXT-PAGE-R1: admission tests for the `page` contribution kind.
//! Mirrors production validation: page is accepted like the other API1 kinds,
//! unknown kinds and duplicate contribution ids stay rejected.
#[path = "../../../src-tauri/src/extension_packages_store.rs"]
mod store;

fn main() {}

#[cfg(test)]
mod tests {
    use super::store::{self, manage, Package, Request};
    use serde_json::json;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lr-ext-page-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn package(id: &str, kinds: &[&str]) -> Package {
        let contributions: Vec<_> = kinds
            .iter()
            .enumerate()
            .map(|(index, kind)| json!({"id": format!("c{index}"), "label": format!("c{index}"), "kind": kind}))
            .collect();
        serde_json::from_value(json!({
            "manifest": {"schemaVersion":1,"apiVersion":1,"id":id,"name":id,"version":"1.0.0","type":"script",
                "entry":"main.js","minHostVersion":"1.9.2","requiredModules":[],"optionalModules":[]},
            "resource": {"code":"LuckyRay.register(()=>({title:'x'}));","requiredPermissions":[],
                "optionalPermissions":[],"dataVersion":1,"contributions":contributions}
        }))
        .unwrap()
    }

    fn install(root: &PathBuf, package: Package) -> Result<self::store::State, String> {
        let state = manage(root, "1.9.2", Request::List).unwrap();
        manage(root, "1.9.2", Request::Install { package, expected_revision: state.revision })
    }

    #[test]
    fn page_contribution_installs_and_lists_with_other_kinds() {
        let root = root();
        let state = install(&root, package("test.page", &["command", "page", "page", "settings"])).unwrap();
        let installed = state.packages.first().unwrap();
        let resource = self::store::script(&installed.package).unwrap();
        let kinds: Vec<String> = resource.contributions.iter().map(|c| c.kind.clone()).collect();
        assert_eq!(kinds, vec!["command", "page", "page", "settings"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_contribution_kind_is_rejected() {
        let root = root();
        let error = install(&root, package("test.widget", &["page", "widget"])).unwrap_err();
        assert_eq!(error, "extension-invalid-contribution");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn duplicate_contribution_ids_are_rejected_even_for_pages() {
        let root = root();
        let package = package("test.dup", &["page"]);
        let mut resource = self::store::script(&package).unwrap();
        resource.contributions.push(resource.contributions[0].clone());
        let package = Package { resource: serde_json::to_value(&resource).unwrap(), ..package };
        let error = install(&root, package).unwrap_err();
        assert_eq!(error, "extension-invalid-contribution");
        std::fs::remove_dir_all(root).unwrap();
    }
}
