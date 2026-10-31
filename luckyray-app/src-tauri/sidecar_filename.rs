/// The build target, not the host running the build script, determines the
/// registered sidecar filename. Keep the existing convention for every other
/// target until its own platform port supplies and verifies its resources.
pub(crate) fn registered_sidecar_filename(name: &str, target: &str) -> String {
    let suffix = if target.ends_with("-apple-darwin") {
        ""
    } else {
        ".exe"
    };
    format!("{name}-{target}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::registered_sidecar_filename;

    #[test]
    fn names_apple_sidecars_without_windows_extension() {
        for target in ["aarch64-apple-darwin", "x86_64-apple-darwin"] {
            assert_eq!(
                registered_sidecar_filename("luckyray-cli", target),
                format!("luckyray-cli-{target}")
            );
        }
    }

    #[test]
    fn preserves_existing_windows_and_other_target_names() {
        for target in ["x86_64-pc-windows-msvc", "aarch64-unknown-linux-gnu"] {
            assert_eq!(
                registered_sidecar_filename("luckyray-cli", target),
                format!("luckyray-cli-{target}.exe")
            );
        }
    }
}
