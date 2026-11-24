use super::is_rook_bundle;

#[test]
fn is_rook_bundle_recognises_rook_channels() {
    assert!(is_rook_bundle("dev.rook.Rook"));
    assert!(is_rook_bundle("dev.rook.RookDev"));
    assert!(is_rook_bundle("dev.rook.RookPreview"));
    assert!(is_rook_bundle("dev.rook.RookOss"));
}

#[test]
fn is_rook_bundle_rejects_other_apps() {
    assert!(!is_rook_bundle("com.microsoft.VSCode"));
    assert!(!is_rook_bundle("com.apple.TextEdit"));
    assert!(!is_rook_bundle("dev.zed.Zed"));
    assert!(!is_rook_bundle("invalid"));
    assert!(!is_rook_bundle(""));
}
