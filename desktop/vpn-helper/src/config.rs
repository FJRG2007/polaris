//! What the service keeps: the app's secret and this computer's private key, in a
//! folder only the system can read. The key is made here and never leaves.

use defguard_wireguard_rs::key::Key;
use serde::{Deserialize, Serialize};
use std::{fs, io, path::PathBuf};

#[derive(Serialize, Deserialize)]
pub struct Config {
    pub secret: String,
    pub private_key: String,
}

/// Where the service and its files live. Fixed, because the app's own folder moves
/// with every update and a service has to keep starting.
pub fn home() -> PathBuf {
    #[cfg(windows)]
    {
        let data = std::env::var_os("ProgramData").unwrap_or_else(|| r"C:\ProgramData".into());
        PathBuf::from(data).join("Polaris").join("VPN")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/usr/local/lib/polaris-vpn")
    }
}

fn file() -> PathBuf {
    home().join("config.json")
}

pub fn load() -> io::Result<Config> {
    serde_json::from_slice(&fs::read(file())?).map_err(io::Error::other)
}

/// Keeps the key across a reinstall: a new key would be a new device on the list.
pub fn store_secret(secret: &str) -> io::Result<()> {
    let private_key = load().map_or_else(|_| Key::generate().to_string(), |old| old.private_key);
    let config = Config {
        secret: secret.to_owned(),
        private_key,
    };
    fs::write(
        file(),
        serde_json::to_vec(&config).map_err(io::Error::other)?,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(file(), fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}
