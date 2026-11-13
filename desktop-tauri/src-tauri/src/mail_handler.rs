//! Offering the beta for `mailto:` links on Windows
//! (`desktop/src/main/mail-handler.ts`).
//!
//! Windows lists an app in Settings > Default apps only when it is a registered
//! application: a `Capabilities` key naming the link types it handles, a
//! `RegisteredApplications` entry pointing at it, and a ProgID with the command
//! to run. Everything is under HKCU, so no elevation is needed.
//!
//! The beta never takes the Electron app's place: it writes under its own names
//! (`Polaris Beta`, `Polaris.Beta.Url.mailto`), only once somebody switches it
//! on from the tray, and switching it off - or any start with it off - deletes
//! every key it wrote. Which app opens a link stays the person's to pick, which
//! Windows enforces anyway.

use crate::os_prefs::{read_settings, update_settings};
use tauri::AppHandle;

const PROG_ID: &str = "Polaris.Beta.Url.mailto";
const APP_KEY: &str = r"Software\Polaris Beta";
const CAPABILITIES: &str = r"Software\Polaris Beta\Capabilities";
const REGISTERED: &str = r"Software\RegisteredApplications";
const REGISTERED_NAME: &str = "Polaris Beta";

/// One value written under HKCU: the key, the value's name (`None` for the
/// key's default) and its text.
#[derive(Debug, PartialEq, Eq)]
pub struct RegValue {
    pub key: String,
    pub name: Option<&'static str>,
    pub value: String,
}

/// The values that register `exe` as a mailto handler. Pure, for the tests.
pub fn mail_handler_values(exe: &str) -> Vec<RegValue> {
    let prog_id = format!(r"Software\Classes\{PROG_ID}");
    let value = |key: &str, name, value: &str| RegValue {
        key: key.to_owned(),
        name,
        value: value.to_owned(),
    };
    vec![
        value(&prog_id, None, "Polaris Beta mail link"),
        value(&prog_id, Some("URL Protocol"), ""),
        value(
            &format!(r"{prog_id}\DefaultIcon"),
            None,
            &format!("\"{exe}\",0"),
        ),
        value(
            &format!(r"{prog_id}\shell\open\command"),
            None,
            &format!("\"{exe}\" \"%1\""),
        ),
        value(CAPABILITIES, Some("ApplicationName"), "Polaris Beta"),
        value(
            CAPABILITIES,
            Some("ApplicationDescription"),
            "Mail, chat and everything else on your Polaris.",
        ),
        value(
            &format!(r"{CAPABILITIES}\URLAssociations"),
            Some("mailto"),
            PROG_ID,
        ),
        value(REGISTERED, Some(REGISTERED_NAME), CAPABILITIES),
    ]
}

/// The keys deleted whole to take it all back off, and the one value deleted
/// from the shared `RegisteredApplications` key.
pub fn mail_handler_removals() -> (Vec<String>, (&'static str, &'static str)) {
    (
        vec![APP_KEY.to_owned(), format!(r"Software\Classes\{PROG_ID}")],
        (REGISTERED, REGISTERED_NAME),
    )
}

#[cfg(windows)]
fn register(exe: &str) -> std::io::Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    let user = winreg::RegKey::predef(HKEY_CURRENT_USER);
    for one in mail_handler_values(exe) {
        let (key, _) = user.create_subkey(&one.key)?;
        key.set_value(one.name.unwrap_or(""), &one.value)?;
    }
    Ok(())
}

#[cfg(windows)]
fn unregister() -> std::io::Result<()> {
    use std::io::ErrorKind::NotFound;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    let user = winreg::RegKey::predef(HKEY_CURRENT_USER);
    let gone = |result: std::io::Result<()>| match result {
        Err(error) if error.kind() != NotFound => Err(error),
        _ => Ok(()),
    };
    let (keys, (registered, name)) = mail_handler_removals();
    if let Ok(list) = user.open_subkey_with_flags(registered, KEY_SET_VALUE) {
        gone(list.delete_value(name))?;
    }
    for key in keys {
        gone(user.delete_subkey_all(key))?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn register(_exe: &str) -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(windows))]
fn unregister() -> std::io::Result<()> {
    Ok(())
}

/// Write or delete the keys to match `on`. A failure is logged, never thrown:
/// it must not stop the app from opening.
fn apply(on: bool) -> bool {
    let result = if on {
        std::env::current_exe().and_then(|exe| register(&exe.to_string_lossy()))
    } else {
        unregister()
    };
    if let Err(error) = &result {
        eprintln!("polaris: the mail link registration could not be changed: {error}");
    }
    result.is_ok()
}

/// Match the saved setting, on every start: written again when on, because the
/// executable can move; deleted when off.
pub fn restore(app: &AppHandle) {
    if cfg!(windows) {
        apply(read_settings(app).mail_handler);
    }
}

/// Switch it from the tray.
pub fn set(app: &AppHandle, on: bool) -> Result<(), String> {
    if !apply(on) {
        return Err("Windows did not take the change to mail links.".to_owned());
    }
    update_settings(app, |settings| settings.mail_handler = on)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Users\someone\polaris-beta\polaris-desktop-beta.exe";

    fn written(key: &str, name: Option<&str>) -> Option<String> {
        mail_handler_values(EXE)
            .into_iter()
            .find(|one| one.key == key && one.name == name)
            .map(|one| one.value)
    }

    #[test]
    fn registers_the_application_default_apps_lists_under_the_betas_own_names() {
        assert_eq!(
            written(r"Software\RegisteredApplications", Some("Polaris Beta")).as_deref(),
            Some(r"Software\Polaris Beta\Capabilities")
        );
        assert_eq!(
            written(
                r"Software\Polaris Beta\Capabilities",
                Some("ApplicationName")
            )
            .as_deref(),
            Some("Polaris Beta")
        );
        assert_eq!(
            written(
                r"Software\Polaris Beta\Capabilities\URLAssociations",
                Some("mailto")
            )
            .as_deref(),
            Some("Polaris.Beta.Url.mailto")
        );
    }

    #[test]
    fn runs_this_executable_with_the_link_as_its_argument() {
        assert_eq!(
            written(
                r"Software\Classes\Polaris.Beta.Url.mailto\shell\open\command",
                None
            ),
            Some(format!("\"{EXE}\" \"%1\""))
        );
    }

    #[test]
    fn never_touches_what_the_electron_app_registered() {
        for one in mail_handler_values(EXE) {
            assert!(!one.key.contains(r"Software\Polaris\"), "{}", one.key);
            assert!(!one.key.ends_with(r"\Polaris.Url.mailto"), "{}", one.key);
            assert_ne!(one.name, Some("Polaris"));
        }
        let (keys, (_, name)) = mail_handler_removals();
        assert_eq!(name, "Polaris Beta");
        assert!(keys.iter().all(|key| key.contains("Beta")));
    }

    #[test]
    fn takes_back_off_every_key_it_wrote() {
        let (keys, (registered, _)) = mail_handler_removals();
        for one in mail_handler_values(EXE) {
            assert!(
                one.key == registered || keys.iter().any(|key| one.key.starts_with(key.as_str())),
                "{} is left behind",
                one.key
            );
        }
    }
}
