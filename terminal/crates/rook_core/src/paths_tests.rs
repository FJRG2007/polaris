use dirs::home_dir;

use super::*;

#[test]
fn test_data_dir_path() {
    let home_dir = home_dir().expect("Should be able to compute home directory");
    // ChannelState, by default, is configured for Channel::Oss.
    cfg_if::cfg_if! {
        if #[cfg(target_os = "macos")] {
            assert_eq!(data_dir(), home_dir.join(".rook-oss"));
        } else if #[cfg(any(target_os = "linux", target_os = "freebsd"))] {
            assert_eq!(data_dir(), home_dir.join(".local/share/rook-oss"));
        } else if #[cfg(windows)] {
            assert_eq!(data_dir(), home_dir.join("AppData\\Roaming\\rook\\RookOss\\data"));
        } else {
            unimplemented!("Need to update tests for current platform!");
        }
    }
}

#[test]
fn test_config_local_dir_path() {
    let home_dir = home_dir().expect("Should be able to compute home directory");
    // ChannelState, by default, is configured for Channel::Oss.
    cfg_if::cfg_if! {
        if #[cfg(target_os = "macos")] {
            assert_eq!(config_local_dir(), home_dir.join(".rook-oss"));
        } else if #[cfg(any(target_os = "linux", target_os = "freebsd"))] {
            assert_eq!(config_local_dir(), home_dir.join(".config/rook-oss"));
        } else if #[cfg(windows)] {
            assert_eq!(config_local_dir(), home_dir.join("AppData\\Local\\rook\\RookOss\\config"));
        } else {
            unimplemented!("Need to update tests for current platform!");
        }
    }
}

#[cfg(target_os = "macos")]
#[test]
fn test_macos_config_dir_name_scopes_to_data_profile() {
    assert_eq!(macos_config_dir_name_for(Channel::Stable, None), ".rook");
    assert_eq!(
        macos_config_dir_name_for(Channel::Local, None),
        ".rook-local"
    );

    // Each development profile must get its own directory so shared config
    // (notably settings.toml) cannot leak between profiles.
    assert_eq!(
        macos_config_dir_name_for(Channel::Local, Some("myprofile")),
        ".rook-local-myprofile"
    );
    assert_eq!(
        macos_config_dir_name_for(Channel::Stable, Some("myprofile")),
        ".rook-myprofile"
    );
}

#[test]
fn test_gui_app_id_maps_oss_tui_to_oss_gui() {
    let gui_app_id = gui_app_id_for_channel(Channel::Oss, AppId::new("dev", "rook", "RookTui"));

    assert_eq!(gui_app_id.to_string(), "dev.rook.RookOss");
}

#[test]
fn test_gui_config_and_mcp_paths_resolve_explicit_sources() {
    let home_dir = home_dir().expect("Should be able to compute home directory");
    let gui_config_dir = gui_config_local_dir().expect("GUI config path should resolve");

    cfg_if::cfg_if! {
        if #[cfg(target_os = "macos")] {
            assert_eq!(gui_config_dir, home_dir.join(".rook-oss"));
        } else if #[cfg(any(target_os = "linux", target_os = "freebsd"))] {
            assert_eq!(gui_config_dir, home_dir.join(".config/rook-oss"));
        } else if #[cfg(windows)] {
            assert_eq!(
                gui_config_dir,
                home_dir.join("AppData\\Local\\rook\\RookOss\\config")
            );
        } else {
            unimplemented!("Need to update tests for current platform!");
        }
    }

    assert_eq!(gui_mcp_config_file_path(), rook_home_mcp_config_file_path());
}
#[test]
fn test_rook_home_config_dir_path() {
    let home_dir = home_dir().expect("Should be able to compute home directory");
    let expected_dir_name = match ChannelState::data_profile() {
        Some(data_profile) => format!(".rook-oss-{data_profile}"),
        None => ".rook-oss".to_string(),
    };

    assert_eq!(
        rook_home_config_dir(),
        Some(home_dir.join(expected_dir_name))
    );
}

#[test]
fn test_rook_home_skills_and_mcp_paths() {
    let Some(config_dir) = rook_home_config_dir() else {
        panic!("Should be able to compute Rook home config directory");
    };

    assert_eq!(rook_home_skills_dir(), Some(config_dir.join("skills")));
    assert_eq!(
        rook_home_mcp_config_file_path(),
        Some(config_dir.join(".mcp.json"))
    );
}

#[test]
fn test_tui_mcp_config_path_is_separate_from_gui() {
    let tui_mcp_path = tui_mcp_config_file_path();

    assert_eq!(tui_mcp_path, tui_config_local_dir().join(".mcp.json"));
    assert_ne!(
        Some(tui_mcp_path),
        rook_home_mcp_config_file_path(),
        "GUI and TUI MCP configuration must remain isolated"
    );
}
#[test]
fn test_cache_dir_path() {
    let home_dir = home_dir().expect("Should be able to compute home directory");
    // ChannelState, by default, is configured for Channel::Oss.
    cfg_if::cfg_if! {
        if #[cfg(target_os = "macos")] {
            assert_eq!(cache_dir(), home_dir.join("Library/Application Support/dev.rook.RookOss"));
        } else if #[cfg(any(target_os = "linux", target_os = "freebsd"))] {
            assert_eq!(cache_dir(), home_dir.join(".cache/rook-oss"));
        } else if #[cfg(windows)] {
            assert_eq!(cache_dir(), home_dir.join("AppData\\Local\\rook\\RookOss\\cache"));
        } else {
            unimplemented!("Need to update tests for current platform!");
        }
    }
}

#[test]
fn test_state_dir_path() {
    let home_dir = home_dir().expect("Should be able to compute home directory");
    cfg_if::cfg_if! {
        // ChannelState, by default, is configured for Channel::Oss.
        if #[cfg(target_os = "macos")] {
            assert_eq!(state_dir(), home_dir.join("Library/Application Support/dev.rook.RookOss"));
        } else if #[cfg(any(target_os = "linux", target_os = "freebsd"))] {
            assert_eq!(state_dir(), home_dir.join(".local/state/rook-oss"));
        } else if #[cfg(windows)] {
            assert_eq!(state_dir(), home_dir.join("AppData\\Local\\rook\\RookOss\\data"));
        } else {
            unimplemented!("Need to update tests for current platform!");
        }
    }
}

#[test]
fn test_tui_state_dir_is_tui_subdir_of_gui_state_base() {
    let tui_dir = tui_state_dir();
    assert_eq!(tui_dir.file_name(), Some(std::ffi::OsStr::new("tui")));

    // The TUI state dir must be a direct `tui` child of the same base
    // directory that holds the GUI's SQLite database (the secure state dir
    // when available, otherwise the plain state dir), so the two front-ends
    // keep sibling — never shared — databases.
    let gui_state_base = secure_state_dir().unwrap_or_else(state_dir);
    assert_eq!(tui_dir.parent(), Some(gui_state_base.as_path()));
}

#[test]
fn test_project_path_for_rook_app_id() {
    let project_dirs = project_dirs_for_app_id(AppId::new("dev", "rook", "Rook"), None)
        .expect("should be able to compute project dirs");
    cfg_if::cfg_if! {
        if #[cfg(target_os = "macos")] {
            assert_eq!(project_dirs.project_path(), "dev.rook.Rook");
        } else if #[cfg(any(target_os = "linux", target_os = "freebsd"))] {
            assert_eq!(project_dirs.project_path(), "rook-terminal");
        } else if #[cfg(windows)] {
            assert_eq!(project_dirs.project_path(), "rook\\Rook");
        } else {
            unimplemented!("Need to update tests for current platform!");
        }
    }
}

#[test]
fn test_project_path_for_rook_dev_app_id() {
    let project_dirs = project_dirs_for_app_id(AppId::new("dev", "rook", "RookDev"), None)
        .expect("should be able to compute project dirs");
    cfg_if::cfg_if! {
        if #[cfg(target_os = "macos")] {
            assert_eq!(project_dirs.project_path(), "dev.rook.RookDev");
        } else if #[cfg(any(target_os = "linux", target_os = "freebsd"))] {
            assert_eq!(project_dirs.project_path(), "rook-terminal-dev");
        } else if #[cfg(windows)] {
            assert_eq!(project_dirs.project_path(), "rook\\RookDev");
        } else {
            unimplemented!("Need to update tests for current platform!");
        }
    }
}

#[test]
fn test_project_path_for_oss_app_id() {
    let project_dirs = project_dirs_for_app_id(AppId::new("dev", "rook", "RookOss"), None)
        .expect("should be able to compute project dirs");
    cfg_if::cfg_if! {
        if #[cfg(target_os = "macos")] {
            assert_eq!(project_dirs.project_path(), "dev.rook.RookOss");
        } else if #[cfg(any(target_os = "linux", target_os = "freebsd"))] {
            assert_eq!(project_dirs.project_path(), "rook-oss");
        } else if #[cfg(windows)] {
            assert_eq!(project_dirs.project_path(), "rook\\RookOss");
        } else {
            unimplemented!("Need to update tests for current platform!");
        }
    }
}
