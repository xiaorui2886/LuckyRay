//! The Linux target uses ELF sidecars without the Windows executable suffix.

pub(crate) fn is_linux_target(target: &str) -> bool {
    target.contains("-linux-") && !target.ends_with("-android")
}

pub(crate) fn sidecar_name(name: &str, target: &str) -> String {
    let suffix = if is_linux_target(target) { "" } else { ".exe" };
    format!("{name}-{target}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_sidecars_have_no_exe_extension() {
        assert_eq!(
            sidecar_name("luckyray-cli", "x86_64-unknown-linux-gnu"),
            "luckyray-cli-x86_64-unknown-linux-gnu"
        );
    }

    #[test]
    fn windows_sidecar_names_remain_unchanged() {
        for target in ["x86_64-pc-windows-msvc", "x86_64-pc-windows-gnu"] {
            assert_eq!(
                sidecar_name("luckyray-cli", target),
                format!("luckyray-cli-{target}.exe")
            );
        }
    }

    #[test]
    fn android_is_not_treated_as_desktop_linux() {
        assert!(!is_linux_target("aarch64-linux-android"));
    }
}
