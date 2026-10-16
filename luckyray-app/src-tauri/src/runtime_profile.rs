use std::path::Path;

pub(crate) const PRODUCTION_IDENTIFIER: &str = "com.luckyray.desktop";
pub(crate) const DEVELOPMENT_IDENTIFIER: &str = "com.luckyray.desktop.dev";
#[cfg(feature = "issue189-isolated-fixture")]
pub(crate) const ISSUE189_FIXTURE_IDENTIFIER: &str = "com.luckyray.desktop.issue189-fixture";
#[cfg(feature = "issue189-frozen-old-fixture")]
pub(crate) const ISSUE189_OLD_IDENTIFIER: &str = "com.luckyray.desktop.issue189-epoch386-e2e";
#[cfg(feature = "issue189-frozen-old-fixture")]
pub(crate) const ISSUE189_RETEST_IDENTIFIER: &str = "com.luckyray.desktop.issue189-epoch387-retest";
#[cfg(feature = "issue191-isolated-fixture")]
pub(crate) const ISSUE191_FIXTURE_IDENTIFIER: &str = "com.luckyray.desktop.issue191-ux";
pub(crate) const PROFILE_ENV: &str = "LUCKYRAY_APP_PROFILE";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeProfile {
    Production,
    Development,
    #[cfg(feature = "issue189-isolated-fixture")]
    Issue189Fixture,
    #[cfg(feature = "issue189-frozen-old-fixture")]
    Issue189OldFixture,
    #[cfg(feature = "issue189-frozen-old-fixture")]
    Issue189Retest,
    #[cfg(feature = "issue191-isolated-fixture")]
    Issue191Fixture,
}

impl RuntimeProfile {
    pub(crate) fn resolve(
        identifier: &str,
        marker: Option<&str>,
        debug_build: bool,
    ) -> Result<Self, String> {
        let marker = marker.map(str::trim).filter(|value| !value.is_empty());
        if debug_build {
            return match (identifier, marker) {
                (DEVELOPMENT_IDENTIFIER, Some("development")) => Ok(Self::Development),
                #[cfg(feature = "issue189-isolated-fixture")]
                (ISSUE189_FIXTURE_IDENTIFIER, Some("issue189-fixture")) => Ok(Self::Issue189Fixture),
                #[cfg(feature = "issue189-frozen-old-fixture")]
                (ISSUE189_OLD_IDENTIFIER, Some("issue189-epoch386-e2e")) => Ok(Self::Issue189OldFixture),
                #[cfg(feature = "issue189-frozen-old-fixture")]
                (ISSUE189_RETEST_IDENTIFIER, Some("issue189-epoch387-retest")) => Ok(Self::Issue189Retest),
                #[cfg(feature = "issue191-isolated-fixture")]
                (ISSUE191_FIXTURE_IDENTIFIER, Some("issue191-ux")) => Ok(Self::Issue191Fixture),
                _ => Err("luckyray-development-runtime-profile-invalid".to_string()),
            };
        }

        match (identifier, marker) {
            (PRODUCTION_IDENTIFIER, None | Some("production")) => Ok(Self::Production),
            _ => Err("luckyray-production-runtime-profile-invalid".to_string()),
        }
    }

    pub(crate) fn resolve_current(identifier: &str) -> Result<Self, String> {
        let marker = std::env::var(PROFILE_ENV).ok();
        Self::resolve(identifier, marker.as_deref(), cfg!(debug_assertions))
    }

    pub(crate) fn validate_app_data_root(
        self,
        identifier: &str,
        app_data_root: &Path,
    ) -> Result<(), String> {
        let expected_identifier = match self {
            Self::Production => PRODUCTION_IDENTIFIER,
            Self::Development => DEVELOPMENT_IDENTIFIER,
            #[cfg(feature = "issue189-isolated-fixture")]
            Self::Issue189Fixture => ISSUE189_FIXTURE_IDENTIFIER,
            #[cfg(feature = "issue189-frozen-old-fixture")]
            Self::Issue189OldFixture => ISSUE189_OLD_IDENTIFIER,
            #[cfg(feature = "issue189-frozen-old-fixture")]
            Self::Issue189Retest => ISSUE189_RETEST_IDENTIFIER,
            #[cfg(feature = "issue191-isolated-fixture")]
            Self::Issue191Fixture => ISSUE191_FIXTURE_IDENTIFIER,
        };
        let final_component = app_data_root.file_name().and_then(|value| value.to_str());
        if identifier != expected_identifier || final_component != Some(expected_identifier) {
            return Err("luckyray-runtime-data-root-profile-mismatch".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_runtime_requires_the_exact_isolated_development_pair() {
        assert_eq!(
            RuntimeProfile::resolve(DEVELOPMENT_IDENTIFIER, Some("development"), true),
            Ok(RuntimeProfile::Development)
        );
        for (identifier, marker) in [
            (PRODUCTION_IDENTIFIER, None),
            (PRODUCTION_IDENTIFIER, Some("development")),
            (DEVELOPMENT_IDENTIFIER, None),
            (DEVELOPMENT_IDENTIFIER, Some("production")),
        ] {
            assert!(RuntimeProfile::resolve(identifier, marker, true).is_err());
        }
    }

    #[cfg(feature = "issue189-isolated-fixture")]
    #[test]
    fn issue189_fixture_has_a_third_exact_identity_and_data_root() {
        let root = tempfile::tempdir().unwrap();
        let fixture = root.path().join(ISSUE189_FIXTURE_IDENTIFIER);
        let production = root.path().join(PRODUCTION_IDENTIFIER);
        assert_eq!(RuntimeProfile::resolve(ISSUE189_FIXTURE_IDENTIFIER,
            Some("issue189-fixture"), true), Ok(RuntimeProfile::Issue189Fixture));
        assert!(RuntimeProfile::Issue189Fixture
            .validate_app_data_root(ISSUE189_FIXTURE_IDENTIFIER, &fixture).is_ok());
        assert!(RuntimeProfile::Issue189Fixture
            .validate_app_data_root(ISSUE189_FIXTURE_IDENTIFIER, &production).is_err());
        assert!(RuntimeProfile::resolve(ISSUE189_FIXTURE_IDENTIFIER,
            Some("development"), true).is_err());
        assert!(RuntimeProfile::resolve(ISSUE189_FIXTURE_IDENTIFIER,
            Some("issue189-fixture"), false).is_err());
    }

    #[cfg(feature = "issue189-frozen-old-fixture")]
    #[test]
    fn issue189_old_engine_fixture_has_a_distinct_exact_identity() {
        let root = tempfile::tempdir().unwrap();
        let fixture = root.path().join(ISSUE189_OLD_IDENTIFIER);
        assert_eq!(RuntimeProfile::resolve(ISSUE189_OLD_IDENTIFIER,
            Some("issue189-epoch386-e2e"), true), Ok(RuntimeProfile::Issue189OldFixture));
        assert!(RuntimeProfile::Issue189OldFixture
            .validate_app_data_root(ISSUE189_OLD_IDENTIFIER, &fixture).is_ok());
        assert!(RuntimeProfile::Issue189OldFixture
            .validate_app_data_root(ISSUE189_FIXTURE_IDENTIFIER, &fixture).is_err());
    }

    #[cfg(feature = "issue189-frozen-old-fixture")]
    #[test]
    fn issue189_retest_cannot_open_prior_test_or_development_data() {
        let root = tempfile::tempdir().unwrap();
        let retest = root.path().join(ISSUE189_RETEST_IDENTIFIER);
        let prior = root.path().join(ISSUE189_OLD_IDENTIFIER);
        assert_eq!(RuntimeProfile::resolve(ISSUE189_RETEST_IDENTIFIER,
            Some("issue189-epoch387-retest"), true), Ok(RuntimeProfile::Issue189Retest));
        assert!(RuntimeProfile::Issue189Retest
            .validate_app_data_root(ISSUE189_RETEST_IDENTIFIER, &retest).is_ok());
        assert!(RuntimeProfile::Issue189Retest
            .validate_app_data_root(ISSUE189_RETEST_IDENTIFIER, &prior).is_err());
        assert!(RuntimeProfile::resolve(ISSUE189_RETEST_IDENTIFIER,
            Some("issue189-epoch386-e2e"), true).is_err());
        assert!(RuntimeProfile::resolve(ISSUE189_RETEST_IDENTIFIER,
            Some("issue189-epoch387-retest"), false).is_err());
    }

    #[cfg(feature = "issue191-isolated-fixture")]
    #[test]
    fn issue191_ui_fixture_has_no_access_to_regular_or_historical_data() {
        let root = tempfile::tempdir().unwrap();
        let fixture = root.path().join(ISSUE191_FIXTURE_IDENTIFIER);
        assert_eq!(RuntimeProfile::resolve(ISSUE191_FIXTURE_IDENTIFIER,
            Some("issue191-ux"), true), Ok(RuntimeProfile::Issue191Fixture));
        assert!(RuntimeProfile::Issue191Fixture
            .validate_app_data_root(ISSUE191_FIXTURE_IDENTIFIER, &fixture).is_ok());
        for id in [PRODUCTION_IDENTIFIER, DEVELOPMENT_IDENTIFIER,
            "com.luckyray.desktop.issue189-epoch386-e2e",
            "com.luckyray.desktop.issue189-epoch387-retest"] {
            assert!(RuntimeProfile::Issue191Fixture
                .validate_app_data_root(ISSUE191_FIXTURE_IDENTIFIER, &root.path().join(id)).is_err());
        }
        assert!(RuntimeProfile::resolve(ISSUE191_FIXTURE_IDENTIFIER, Some("development"), true).is_err());
        assert!(RuntimeProfile::resolve(ISSUE191_FIXTURE_IDENTIFIER, Some("issue191-ux"), false).is_err());
    }

    #[test]
    fn release_runtime_preserves_only_the_production_identity() {
        assert_eq!(
            RuntimeProfile::resolve(PRODUCTION_IDENTIFIER, None, false),
            Ok(RuntimeProfile::Production)
        );
        assert_eq!(
            RuntimeProfile::resolve(PRODUCTION_IDENTIFIER, Some("production"), false),
            Ok(RuntimeProfile::Production)
        );
        assert!(
            RuntimeProfile::resolve(DEVELOPMENT_IDENTIFIER, Some("development"), false).is_err()
        );
        assert!(RuntimeProfile::resolve("com.example.unknown", None, false).is_err());
        assert!(RuntimeProfile::resolve(PRODUCTION_IDENTIFIER, Some("unknown"), false).is_err());
    }

    #[test]
    fn each_profile_accepts_only_its_identifier_derived_data_root() {
        let root = tempfile::tempdir().expect("temp profile fixture");
        let production_root = root.path().join(PRODUCTION_IDENTIFIER);
        let development_root = root.path().join(DEVELOPMENT_IDENTIFIER);
        assert_ne!(production_root, development_root);

        assert!(RuntimeProfile::Production
            .validate_app_data_root(PRODUCTION_IDENTIFIER, &production_root)
            .is_ok());
        assert!(RuntimeProfile::Development
            .validate_app_data_root(DEVELOPMENT_IDENTIFIER, &development_root)
            .is_ok());
        assert!(RuntimeProfile::Development
            .validate_app_data_root(DEVELOPMENT_IDENTIFIER, &production_root)
            .is_err());
        assert!(RuntimeProfile::Production
            .validate_app_data_root(PRODUCTION_IDENTIFIER, &development_root)
            .is_err());
    }

    #[test]
    fn production_and_development_initialize_independent_schema_state() {
        let root = tempfile::tempdir().expect("temp profile fixture");
        let production_root = root.path().join(PRODUCTION_IDENTIFIER);
        let development_root = root.path().join(DEVELOPMENT_IDENTIFIER);
        let production = crate::backend::BackendServices::initialize(&production_root)
            .expect("production fixture initializes");
        let development = crate::backend::BackendServices::initialize(&development_root)
            .expect("development fixture initializes");

        assert_eq!(
            production.status().schema_version,
            development.status().schema_version
        );
        assert_ne!(production.db_path(), development.db_path());

        production
            .open_write()
            .expect("production fixture opens")
            .execute_batch(
                "CREATE TABLE profile_isolation_probe (value TEXT NOT NULL);\
                 INSERT INTO profile_isolation_probe (value) VALUES ('production');",
            )
            .expect("production fixture writes isolated marker");
        let development_probe_count: i64 = development
            .open_read()
            .expect("development fixture opens")
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'profile_isolation_probe'",
                [],
                |row| row.get(0),
            )
            .expect("development fixture inspects only its schema");
        assert_eq!(development_probe_count, 0);
    }
}
