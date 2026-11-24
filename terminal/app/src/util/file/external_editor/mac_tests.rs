use super::is_pterm_bundle;

#[test]
fn is_pterm_bundle_recognises_pterm_channels() {
    assert!(is_pterm_bundle("dev.polaris.PolarisTerminal"));
    assert!(is_pterm_bundle("dev.polaris.PolarisTerminalDev"));
    assert!(is_pterm_bundle("dev.polaris.PolarisTerminalPreview"));
    assert!(is_pterm_bundle("dev.polaris.PolarisTerminal"));
}

#[test]
fn is_pterm_bundle_rejects_other_apps() {
    assert!(!is_pterm_bundle("com.microsoft.VSCode"));
    assert!(!is_pterm_bundle("com.apple.TextEdit"));
    assert!(!is_pterm_bundle("dev.zed.Zed"));
    assert!(!is_pterm_bundle("invalid"));
    assert!(!is_pterm_bundle(""));
}
