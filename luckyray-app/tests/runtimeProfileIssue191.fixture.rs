#[path = "../src-tauri/src/runtime_profile.rs"]
mod runtime_profile;

use runtime_profile::{RuntimeProfile, ISSUE191_FIXTURE_IDENTIFIER};
use std::path::Path;

fn main() {
    let profile = RuntimeProfile::resolve(ISSUE191_FIXTURE_IDENTIFIER, Some("issue191-ux"), true)
        .expect("explicit debug-only fixture identity");
    assert_eq!(profile, RuntimeProfile::Issue191Fixture);
    assert!(profile.validate_app_data_root(ISSUE191_FIXTURE_IDENTIFIER,
        Path::new("C:/synthetic/com.luckyray.desktop.issue191-ux")).is_ok());
    for id in ["com.luckyray.desktop", "com.luckyray.desktop.dev",
        "com.luckyray.desktop.issue189-epoch386-e2e", "com.luckyray.desktop.issue189-epoch387-retest"] {
        assert!(profile.validate_app_data_root(ISSUE191_FIXTURE_IDENTIFIER,
            &Path::new("C:/synthetic").join(id)).is_err());
        assert!(profile.validate_app_data_root(id,
            Path::new("C:/synthetic/com.luckyray.desktop.issue191-ux")).is_err());
    }
    for marker in [None, Some("development"), Some("production"), Some("issue189-fixture")] {
        assert!(RuntimeProfile::resolve(ISSUE191_FIXTURE_IDENTIFIER, marker, true).is_err());
    }
    assert!(RuntimeProfile::resolve(ISSUE191_FIXTURE_IDENTIFIER, Some("issue191-ux"), false).is_err());
    println!("ISSUE191-RUNTIME-PROFILE-ISOLATION-OK (production module; no data writes)");
}
