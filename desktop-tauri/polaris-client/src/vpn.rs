//! This computer's VPN (`desktop/src/main/vpn.ts`, the part that is not a
//! window). The tunnel and its private key belong to a system service
//! (`desktop/vpn-helper`), so the app can be closed, crash or update without
//! touching either. The first connect installs the service under the system's
//! own prompt; a later version of the app replaces it the same way.
//!
//! A refusal is a word the page turns into a sentence in the reader's language:
//! `denied` for a prompt turned down, the rest from the service.

use crate::vpn_helper::{
    ask_helper, elevated_install, HelperReply, JoinInput, VpnConnection, HELPER_PORT,
    HELPER_VERSION,
};
use regex::Regex;
use serde_json::Map;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

const INSTALL_WAIT: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(500);
const JOIN_WAIT: Duration = Duration::from_secs(60);

static HELD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{64}\s*$").expect("valid"));

/// The secret the service is installed with, made the first time. It has to be
/// a file: the service's `install` reads it from one. Only this user can read it.
pub async fn read_secret(file: &Path) -> io::Result<String> {
    let held = tokio::fs::read_to_string(file).await.unwrap_or_default();
    if HELD.is_match(&held) {
        return Ok(held.trim().to_owned());
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system's random source works");
    let made: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut handle = options.open(file).await?;
    tokio::io::AsyncWriteExt::write_all(&mut handle, made.as_bytes()).await?;
    Ok(made)
}

/// Puts the service in place under the system's prompt. `true` when it ran to
/// the end and said so.
pub trait Installer: Send + Sync {
    fn install(&self, secret_file: &Path) -> impl Future<Output = bool> + Send;
}

/// The real one: the bundled helper, run under each system's own prompt.
pub struct ElevatedInstaller {
    /// The helper the app ships.
    pub bundled: PathBuf,
    /// A folder of the app's own, for the copy root can read on Linux.
    pub own_folder: PathBuf,
    /// Node's name for the system (`vpn_helper::this_platform`).
    pub platform: &'static str,
}

impl ElevatedInstaller {
    /// The helper as root can read it. An AppImage is a mount only its own user
    /// can enter, so on Linux it goes through a copy in the app's own folder.
    async fn reachable(&self) -> io::Result<PathBuf> {
        if self.platform != "linux" {
            return Ok(self.bundled.clone());
        }
        tokio::fs::create_dir_all(&self.own_folder).await?;
        let copy = self.own_folder.join("polaris-vpn-helper");
        tokio::fs::copy(&self.bundled, &copy).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let only_owner = std::fs::Permissions::from_mode(0o700);
            tokio::fs::set_permissions(&self.own_folder, only_owner.clone()).await?;
            tokio::fs::set_permissions(&copy, only_owner).await?;
        }
        Ok(copy)
    }
}

impl Installer for ElevatedInstaller {
    async fn install(&self, secret_file: &Path) -> bool {
        let Ok(helper) = self.reachable().await else {
            return false;
        };
        let launch = elevated_install(
            self.platform,
            &helper.to_string_lossy(),
            &secret_file.to_string_lossy(),
        );
        let mut command = tokio::process::Command::new(&launch.file);
        command
            .args(&launch.args)
            .envs(launch.env.iter().map(|(key, value)| (key, value)))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command.status().await.is_ok_and(|status| status.success())
    }
}

fn is_current(reply: Option<&HelperReply>) -> bool {
    reply.is_some_and(|reply| reply.ok && reply.version.unwrap_or(0.0) >= HELPER_VERSION)
}

fn outcome_of(reply: Option<HelperReply>) -> Result<(), String> {
    match reply {
        Some(reply) if reply.ok => Ok(()),
        Some(reply) => Err(reply.code.unwrap_or_else(|| "failed".into())),
        None => Err("failed".into()),
    }
}

/// The VPN service as this app drives it.
pub struct Vpn<I> {
    secret_file: PathBuf,
    installer: I,
    port: u16,
    install_wait: Duration,
    poll: Duration,
}

impl<I: Installer> Vpn<I> {
    pub fn new(secret_file: PathBuf, installer: I) -> Self {
        Self {
            secret_file,
            installer,
            port: HELPER_PORT,
            install_wait: INSTALL_WAIT,
            poll: POLL,
        }
    }

    /// Another port and waits, for a stand-in service.
    pub fn with_port(mut self, port: u16, install_wait: Duration, poll: Duration) -> Self {
        self.port = port;
        self.install_wait = install_wait;
        self.poll = poll;
        self
    }

    async fn status_reply(&self, secret: &str) -> Option<HelperReply> {
        ask_helper("status", Map::new(), secret, self.port).await
    }

    /// A service that answers the orders of this app, installing it if there is none.
    async fn service(&self) -> Option<String> {
        let secret = read_secret(&self.secret_file).await.ok()?;
        if is_current(self.status_reply(&secret).await.as_ref()) {
            return Some(secret);
        }
        if !self.installer.install(&self.secret_file).await {
            return None;
        }
        let deadline = tokio::time::Instant::now() + self.install_wait;
        while tokio::time::Instant::now() < deadline {
            if is_current(self.status_reply(&secret).await.as_ref()) {
                return Some(secret);
            }
            tokio::time::sleep(self.poll).await;
        }
        None
    }

    /// The public half of the key the service holds; `None` without a service.
    pub async fn key(&self) -> Option<String> {
        let secret = self.service().await?;
        ask_helper("key", Map::new(), &secret, self.port)
            .await?
            .public_key
    }

    pub async fn up(&self, connection: &VpnConnection) -> Result<(), String> {
        let Some(secret) = self.service().await else {
            return Err("denied".into());
        };
        outcome_of(ask_helper("up", connection.fields(), &secret, self.port).await)
    }

    pub async fn down(&self) -> Result<(), String> {
        let secret = read_secret(&self.secret_file)
            .await
            .map_err(|_| "failed".to_owned())?;
        outcome_of(ask_helper("down", Map::new(), &secret, self.port).await)
    }

    /// The node the tunnel is on. Never installs anything: opening the screen
    /// raises no prompt.
    pub async fn status(&self) -> Option<String> {
        let secret = read_secret(&self.secret_file).await.ok()?;
        self.status_reply(&secret).await?.node_id
    }
}

/// Signs this computer into a private network, with a key that works once.
/// `client` is the Tailscale program (`vpn_helper::tailscale_path`).
pub async fn join_network(client: &Path, input: &JoinInput) -> Result<(), String> {
    let mut command = tokio::process::Command::new(client);
    command
        .args([
            "up".to_owned(),
            format!("--login-server={}", input.server),
            format!("--auth-key={}", input.key),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err("noClient".into()),
        Err(_) => return Err("failed".into()),
    };
    match tokio::time::timeout(JOIN_WAIT, child.wait_with_output()).await {
        Ok(Ok(output)) if output.status.success() => Ok(()),
        _ => Err("failed".into()),
    }
}
