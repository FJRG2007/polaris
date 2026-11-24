use std::path::PathBuf;

use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};

use super::*;

/// A scratch subkey under HKCU that tests create/destroy to avoid touching
/// the real `Software\Microsoft\Windows\CurrentVersion\Run` hive.
struct ScratchSubkey {
    path: String,
}

impl ScratchSubkey {
    fn new(name: &str) -> Self {
        let suffix = format!(
            "{}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            name,
        );
        let path = format!(r"Software\Polaris Terminal\LoginItemTests\{suffix}");
        RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(&path)
            .expect("create scratch subkey");
        Self { path }
    }

    fn child(&self, name: &str) -> String {
        format!(r"{}\{name}", self.path)
    }

    fn read(&self, value_name: &str) -> Option<String> {
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(&self.path, KEY_READ)
            .ok()?;
        key.get_value::<String, _>(value_name).ok()
    }
}

impl Drop for ScratchSubkey {
    fn drop(&mut self) {
        let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.path);
    }
}

#[test]
fn register_writes_quoted_path_with_autostart_flag() {
    let scratch = ScratchSubkey::new("register_writes_quoted_path_with_autostart_flag");
    let exe = PathBuf::from(r"C:\Program Files\Polaris Terminal\polaris-terminal.exe");
    register_run_value_in(HKEY_CURRENT_USER, &scratch.path, "Polaris Terminal", &exe).unwrap();
    assert_eq!(
        scratch.read("Polaris Terminal").as_deref(),
        Some(r#""C:\Program Files\Polaris Terminal\polaris-terminal.exe" --autostart"#)
    );
}

#[test]
fn register_overwrites_previous_path() {
    let scratch = ScratchSubkey::new("register_overwrites_previous_path");
    register_run_value_in(
        HKEY_CURRENT_USER,
        &scratch.path,
        "Polaris Terminal",
        &PathBuf::from(r"C:\old\polaris-terminal.exe"),
    )
    .unwrap();
    register_run_value_in(
        HKEY_CURRENT_USER,
        &scratch.path,
        "Polaris Terminal",
        &PathBuf::from(r"C:\new\polaris-terminal.exe"),
    )
    .unwrap();
    assert_eq!(
        scratch.read("Polaris Terminal").as_deref(),
        Some(r#""C:\new\polaris-terminal.exe" --autostart"#)
    );
}

#[test]
fn unregister_is_idempotent() {
    let scratch = ScratchSubkey::new("unregister_is_idempotent");
    // Never registered: unregister should be Ok.
    unregister_run_value_in(HKEY_CURRENT_USER, &scratch.path, "Polaris Terminal").unwrap();
    // Register, then unregister twice.
    register_run_value_in(
        HKEY_CURRENT_USER,
        &scratch.path,
        "Polaris Terminal",
        &PathBuf::from(r"C:\polaris-terminal.exe"),
    )
    .unwrap();
    unregister_run_value_in(HKEY_CURRENT_USER, &scratch.path, "Polaris Terminal").unwrap();
    unregister_run_value_in(HKEY_CURRENT_USER, &scratch.path, "Polaris Terminal").unwrap();
    assert!(scratch.read("Polaris Terminal").is_none());
}

#[test]
fn unregister_leaves_other_values_alone() {
    let scratch = ScratchSubkey::new("unregister_leaves_other_values_alone");
    register_run_value_in(
        HKEY_CURRENT_USER,
        &scratch.path,
        "Polaris Terminal",
        &PathBuf::from(r"C:\polaris-terminal.exe"),
    )
    .unwrap();
    register_run_value_in(
        HKEY_CURRENT_USER,
        &scratch.path,
        "PolarisTerminalPreview",
        &PathBuf::from(r"C:\polaris-terminal-preview.exe"),
    )
    .unwrap();

    unregister_run_value_in(HKEY_CURRENT_USER, &scratch.path, "Polaris Terminal").unwrap();

    assert!(scratch.read("Polaris Terminal").is_none());
    assert_eq!(
        scratch.read("PolarisTerminalPreview").as_deref(),
        Some(r#""C:\polaris-terminal-preview.exe" --autostart"#)
    );
}

#[test]
fn unregister_missing_subkey_is_ok() {
    unregister_run_value_in(
        HKEY_CURRENT_USER,
        r"Software\Polaris Terminal\LoginItemTests\does-not-exist",
        "Polaris Terminal",
    )
    .unwrap();
}

#[test]
fn run_value_is_enabled_needs_the_value() {
    let scratch = ScratchSubkey::new("run_value_is_enabled_needs_the_value");
    let (run, approved) = (scratch.child("Run"), scratch.child("Approved"));
    assert!(!run_value_is_enabled_in(
        HKEY_CURRENT_USER,
        &run,
        &approved,
        "Polaris Terminal"
    ));

    register_run_value_in(
        HKEY_CURRENT_USER,
        &run,
        "Polaris Terminal",
        &PathBuf::from(r"C:\polaris-terminal.exe"),
    )
    .unwrap();
    assert!(run_value_is_enabled_in(
        HKEY_CURRENT_USER,
        &run,
        &approved,
        "Polaris Terminal"
    ));
}

#[test]
fn run_value_is_enabled_honors_task_manager() {
    let scratch = ScratchSubkey::new("run_value_is_enabled_honors_task_manager");
    let (run, approved) = (scratch.child("Run"), scratch.child("Approved"));
    register_run_value_in(
        HKEY_CURRENT_USER,
        &run,
        "Polaris Terminal",
        &PathBuf::from(r"C:\polaris-terminal.exe"),
    )
    .unwrap();
    let (approved_key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(&approved)
        .unwrap();
    let set_flags = |first_byte: u8| {
        let mut bytes = vec![0u8; 12];
        bytes[0] = first_byte;
        approved_key
            .set_raw_value(
                "Polaris Terminal",
                &winreg::RegValue {
                    bytes,
                    vtype: winreg::enums::RegType::REG_BINARY,
                },
            )
            .unwrap();
    };

    // The values Task Manager writes for an enabled and a disabled entry.
    set_flags(0x02);
    assert!(run_value_is_enabled_in(
        HKEY_CURRENT_USER,
        &run,
        &approved,
        "Polaris Terminal"
    ));
    set_flags(0x03);
    assert!(!run_value_is_enabled_in(
        HKEY_CURRENT_USER,
        &run,
        &approved,
        "Polaris Terminal"
    ));
}

#[test]
fn task_name_is_per_user() {
    assert_eq!(
        task_name("PolarisTerminal", "S-1-5-21-1-2-3-1001"),
        "PolarisTerminal Startup Task-S-1-5-21-1-2-3-1001"
    );
}

#[test]
fn task_xml_launches_exe_with_autostart_flag() {
    let xml = task_xml(
        "S-1-5-21-1-2-3-1001",
        &PathBuf::from(r"C:\Program Files\Polaris Terminal & Co\polaris-terminal.exe"),
    );
    assert!(xml.contains(
        r"<Command>C:\Program Files\Polaris Terminal &amp; Co\polaris-terminal.exe</Command>"
    ));
    assert!(xml.contains("<Arguments>--autostart</Arguments>"));
    assert!(xml.contains("<UserId>S-1-5-21-1-2-3-1001</UserId>"));
    assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
}

#[test]
fn current_user_sid_is_a_user_sid() {
    let sid = current_user_sid().unwrap();
    assert!(sid.starts_with("S-1-5-"), "{sid}");
}

/// Runs against the real Task Scheduler, under an app name no install uses.
#[test]
fn register_and_unregister_task_round_trip() {
    let app_name = format!("PtermLoginItemTest{}", std::process::id());
    let task_name = task_name(&app_name, &current_user_sid().unwrap());
    let exists = || run_schtasks(&["/Query".as_ref(), "/TN".as_ref(), task_name.as_ref()]).is_ok();
    let exe = PathBuf::from(r"C:\Program Files\Polaris Terminal & Co\polaris-terminal.exe");

    register_task(&app_name, &exe).unwrap();
    // Registering again replaces the task rather than failing.
    let registered = register_task(&app_name, &exe).map(|()| exists());
    unregister_task(&app_name).unwrap();

    assert!(registered.unwrap());
    assert!(!exists());
    // Removing a task that is already gone is not an error.
    unregister_task(&app_name).unwrap();
}
