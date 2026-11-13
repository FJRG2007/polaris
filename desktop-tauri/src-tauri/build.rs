fn main() {
    // Listing the app's commands makes each one a permission (`allow-<name>`), so
    // a capability grants them one by one: each of the app's own pages and a
    // Polaris window get only theirs (capabilities/local.json, api-key.json, and
    // the remote one added at run time for the configured origin, whose list is
    // `ipc::POLARIS_COMMANDS`).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "connect_state",
            "connect_submit",
            "connect_check",
            "connect_switch",
            "connect_rename",
            "connect_edit",
            "connect_remove",
            "connect_close",
            "copy_hosts",
            "import_hosts",
            "save_hosts_file",
            "import_hosts_file",
            "hosts_qr",
            "api_key_form",
            "submit_api_key",
            "cancel_api_key",
            "open_api_keys",
            "open_servers",
            "open_window",
            "show_notice",
            "set_app_badge",
            "set_call_hotkeys",
            "push_choose_folder",
            "push_start",
            "push_cancel",
            "upload_folder",
            "install_tool",
            "running_game",
            "set_custom_games",
            "running_programs",
        ]),
    ))
    .expect("the Tauri build step runs");
}
