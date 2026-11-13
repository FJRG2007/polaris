//! The updater, wired and switched off.
//!
//! `tauri-plugin-updater` is registered so the release work (the update-first and
//! update-ready decisions in `polaris_client`, the signature, the installers) has
//! the real plugin to build on, but the beta is never offered an update: the
//! plugin's configuration in `tauri.conf.json` has no endpoint and no public key,
//! nothing here asks it to check, and no window is granted its commands. An
//! updater with no endpoint refuses to build (`Error::EmptyEndpoints`), and one
//! with no key could verify nothing it downloaded. The tests below hold all of it.
//!
//! When the beta is released (see the release section of
//! `docs/desktop-tauri-parity.md`), its endpoint names releases under
//! `polaris_client::releases::BETA_TAG_PREFIX`, never the Electron app's.

use tauri::plugin::TauriPlugin;
use tauri::Runtime;

pub fn plugin<R: Runtime>() -> TauriPlugin<R, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new().build()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    fn crate_file(path: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(path)
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_else(|_| panic!("{} is there", path.display()))
    }

    fn config() -> serde_json::Value {
        serde_json::from_str(&read(&crate_file("tauri.conf.json")))
            .expect("tauri.conf.json is JSON")
    }

    /// Every file under `folder` with one of these extensions.
    fn files(folder: &Path, extensions: &[&str]) -> Vec<PathBuf> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(folder).expect("the folder is there") {
            let path = entry.expect("an entry").path();
            if path.is_dir() {
                found.extend(files(&path, extensions));
            } else if path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extensions.contains(&extension))
            {
                found.push(path);
            }
        }
        found
    }

    #[test]
    fn the_updater_has_no_endpoint_and_no_key() {
        let section = config()["plugins"]["updater"].clone();
        let updater: tauri_plugin_updater::Config = serde_json::from_value(section.clone())
            .expect("the plugin reads its section, or the app would not start");
        assert!(updater.endpoints.is_empty());
        assert!(updater.pubkey.is_empty());
        assert!(!updater.dangerous_insecure_transport_protocol);
        assert!(!updater.dangerous_accept_invalid_certs);
        // Nothing beyond the two keys that switch it off.
        let keys: Vec<&String> = section.as_object().expect("an object").keys().collect();
        assert_eq!(keys, ["endpoints", "pubkey"]);
    }

    #[test]
    fn no_installer_and_no_update_artifacts_are_built() {
        let bundle = &config()["bundle"];
        assert_eq!(bundle["active"], serde_json::Value::Bool(false));
        assert!(bundle.get("createUpdaterArtifacts").is_none());
    }

    #[test]
    fn no_window_is_granted_the_updater() {
        for path in files(&crate_file("capabilities"), &["json", "toml"]) {
            assert!(!read(&path).contains("updater"), "{}", path.display());
        }
        // Nor the capabilities added at run time, nor a page of the app's own.
        for path in files(&crate_file("src"), &["rs"])
            .into_iter()
            .chain(files(&crate_file("../ui"), &["js", "html"]))
        {
            let text = read(&path);
            // This file's own tests name what they look for.
            let code = text.split("#[cfg(test)]").next().unwrap_or_default();
            // A permission is a quoted `updater:...` identifier.
            assert!(!code.contains("\"updater:"), "{}", path.display());
            assert!(!code.contains("plugin:updater"), "{}", path.display());
        }
    }

    #[test]
    fn nothing_in_the_shell_gives_the_updater_an_endpoint_or_asks_it_to_check() {
        for path in files(&crate_file("src"), &["rs"]) {
            let text = read(&path);
            // This file's own tests name what they look for.
            let code = text.split("#[cfg(test)]").next().unwrap_or_default();
            for call in [
                "UpdaterExt",
                "updater_builder",
                ".updater()",
                ".endpoints(",
                ".check()",
            ] {
                assert!(!code.contains(call), "{} calls {call}", path.display());
            }
        }
    }
}
