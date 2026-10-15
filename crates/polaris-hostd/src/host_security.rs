//! Host-level security work for the Security scans app: the hardening audit and
//! the automatic security updates switch.
//!
//! Neither fits a deploy spec - both need the host's root mounted, which a spec
//! may never ask for - so each is one fixed `docker run` built here from a
//! closed set of actions. Nothing in the request reaches the command line but
//! the action's name, which picks one of the scripts below; there is no shell
//! between this process and `docker`, and the scripts take no arguments.
//!
//! The scripts are word for word the ones the dashboard runs over SSH on a
//! remote server (`apps/security-scans/src/model/specs.ts`); a dashboard test
//! reads this file and fails when the two drift.

use std::io::{self, Read};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Deserialize;

/// busybox and apk, pinned by digest (the multi-arch index of alpine 3.22).
pub const TOOLS_IMAGE: &str =
    "alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8";

/// One name for every host action, so two can never run at once on a host.
pub const HOST_CONTAINER: &str = "polaris-secscan-host";

/// Most of what an action prints that is kept; a report is a few hundred KB.
pub const MAX_OUTPUT: usize = 4 * 1024 * 1024;

pub const AUDIT_SCRIPT: &str = r#"apk add --no-cache --quiet lynis >/dev/null 2>&1 || { echo POLARIS_NO_TOOL; exit 20; }; nice -n 19 lynis audit system --rootdir /host --quick --no-colors --no-log --report-file /tmp/report.dat >/dev/null 2>&1; [ -s /tmp/report.dat ] || exit 21; echo POLARIS_REPORT; cat /tmp/report.dat"#;

pub const UPDATES_STATUS_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; if command -v apt-get >/dev/null 2>&1; then if grep -qs 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades && dpkg -s unattended-upgrades >/dev/null 2>&1; then echo POLARIS_UPDATES=on; else echo POLARIS_UPDATES=off; fi; elif command -v dnf >/dev/null 2>&1; then if systemctl is-enabled dnf-automatic.timer >/dev/null 2>&1; then echo POLARIS_UPDATES=on; else echo POLARIS_UPDATES=off; fi; else echo POLARIS_UPDATES=unsupported; fi"#;

pub const UPDATES_ON_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; nice -n 10 apt-get update -qq >/dev/null && nice -n 10 apt-get install -y -qq unattended-upgrades >/dev/null && printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades && echo POLARIS_UPDATES=on; elif command -v dnf >/dev/null 2>&1; then nice -n 10 dnf install -y -q dnf-automatic >/dev/null && sed -i -e 's/^upgrade_type *=.*/upgrade_type = security/' -e 's/^apply_updates *=.*/apply_updates = yes/' /etc/dnf/automatic.conf && systemctl enable --now dnf-automatic.timer >/dev/null 2>&1 && echo POLARIS_UPDATES=on; else echo POLARIS_UPDATES=unsupported; fi"#;

pub const UPDATES_OFF_SCRIPT: &str = r#". /etc/os-release 2>/dev/null; echo "POLARIS_DISTRO id=$ID"; if command -v apt-get >/dev/null 2>&1; then printf 'APT::Periodic::Update-Package-Lists "0";\nAPT::Periodic::Unattended-Upgrade "0";\n' > /etc/apt/apt.conf.d/20auto-upgrades && echo POLARIS_UPDATES=off; elif command -v dnf >/dev/null 2>&1; then systemctl disable --now dnf-automatic.timer >/dev/null 2>&1; echo POLARIS_UPDATES=off; else echo POLARIS_UPDATES=unsupported; fi"#;

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HostAction {
    Audit,
    UpdatesStatus,
    UpdatesOn,
    UpdatesOff,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct HostSecurityRequest {
    pub action: HostAction,
}

/// The arguments after `docker` for an action. The audit sees the host
/// read-only and changes nothing; only the updates switch needs the host's root
/// writable, its process tree (to reach systemd) and its network.
pub fn argv(action: HostAction) -> Vec<String> {
    let mut args: Vec<&str> = vec![
        "run",
        "--rm",
        "--name",
        HOST_CONTAINER,
        "--cpu-shares",
        "64",
    ];
    match action {
        HostAction::Audit => args.extend([
            "--memory",
            "512m",
            "-v",
            "/:/host:ro",
            TOOLS_IMAGE,
            "/bin/sh",
            "-c",
            AUDIT_SCRIPT,
        ]),
        _ => {
            let script = match action {
                HostAction::UpdatesStatus => UPDATES_STATUS_SCRIPT,
                HostAction::UpdatesOn => UPDATES_ON_SCRIPT,
                _ => UPDATES_OFF_SCRIPT,
            };
            args.extend([
                "--privileged",
                "--pid",
                "host",
                "--network",
                "host",
                "-v",
                "/:/host",
                TOOLS_IMAGE,
                "chroot",
                "/host",
                "/bin/sh",
                "-c",
                script,
            ]);
        }
    }
    args.into_iter().map(String::from).collect()
}

static RUNNING: Mutex<()> = Mutex::new(());

/// The outcome of one action: docker's exit code and what it printed, capped.
#[derive(Debug)]
pub struct HostRun {
    pub exit_code: i32,
    pub output: String,
}

/// Run an action to the end. `Ok(None)` when another one is still running.
pub fn run(action: HostAction) -> io::Result<Option<HostRun>> {
    let Ok(_guard) = RUNNING.try_lock() else {
        return Ok(None);
    };
    let mut child = Command::new("docker")
        .args(argv(action))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut output = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        stdout.take(MAX_OUTPUT as u64).read_to_end(&mut output)?;
    }
    let status = child.wait()?;
    Ok(Some(HostRun {
        exit_code: status.code().unwrap_or(-1),
        output: String::from_utf8_lossy(&output).into_owned(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_known_actions() {
        let ok: HostSecurityRequest = serde_json::from_str(r#"{"action":"updates-on"}"#).unwrap();
        assert_eq!(ok.action, HostAction::UpdatesOn);
        assert!(serde_json::from_str::<HostSecurityRequest>(r#"{"action":"shell"}"#).is_err());
        assert!(
            serde_json::from_str::<HostSecurityRequest>(r#"{"action":"audit","cmd":"x"}"#).is_err()
        );
    }

    #[test]
    fn audit_is_read_only_and_unprivileged() {
        let args = argv(HostAction::Audit);
        assert!(args.contains(&"/:/host:ro".to_string()));
        assert!(!args.contains(&"--privileged".to_string()));
        assert_eq!(args.last().map(String::as_str), Some(AUDIT_SCRIPT));
    }

    #[test]
    fn updates_switch_runs_the_matching_script_in_the_host_root() {
        for (action, script) in [
            (HostAction::UpdatesStatus, UPDATES_STATUS_SCRIPT),
            (HostAction::UpdatesOn, UPDATES_ON_SCRIPT),
            (HostAction::UpdatesOff, UPDATES_OFF_SCRIPT),
        ] {
            let args = argv(action);
            assert!(args.contains(&"--privileged".to_string()));
            let chroot = args.iter().position(|a| a == "chroot").unwrap();
            assert_eq!(args[chroot + 1], "/host");
            assert_eq!(args.last().map(String::as_str), Some(script));
        }
    }

    #[test]
    fn scripts_hold_no_control_characters() {
        for script in [
            AUDIT_SCRIPT,
            UPDATES_STATUS_SCRIPT,
            UPDATES_ON_SCRIPT,
            UPDATES_OFF_SCRIPT,
        ] {
            assert!(!script.bytes().any(|b| b < 0x20 || b == 0x7f));
        }
    }
}
