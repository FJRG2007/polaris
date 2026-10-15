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
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

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

/// Longest a host action may run before it is stopped, so a stuck package
/// manager or audit never holds the lock until the daemon restarts.
pub const ACTION_DEADLINE: Duration = Duration::from_secs(30 * 60);

/// Longest an image export may run before it is stopped.
pub const EXPORT_DEADLINE: Duration = Duration::from_secs(60 * 60);

const POLL: Duration = Duration::from_millis(250);

/// Wait for every child to exit by `deadline`. Past it, every one still
/// running is killed and the answer is `None`.
fn wait_all(children: &mut [&mut Child], deadline: Instant) -> io::Result<Option<Vec<ExitStatus>>> {
    let mut statuses: Vec<Option<ExitStatus>> = vec![None; children.len()];
    loop {
        for (child, status) in children.iter_mut().zip(statuses.iter_mut()) {
            if status.is_none() {
                *status = child.try_wait()?;
            }
        }
        if statuses.iter().all(Option::is_some) {
            return Ok(Some(statuses.into_iter().flatten().collect()));
        }
        if Instant::now() >= deadline {
            for child in children.iter_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Ok(None);
        }
        thread::sleep(POLL);
    }
}

/// The outcome of one action: docker's exit code and what it printed, capped.
#[derive(Debug)]
pub struct HostRun {
    pub exit_code: i32,
    pub output: String,
}

/// Why an action gave no outcome.
#[derive(Debug, PartialEq, Eq)]
pub enum RunError {
    Busy,
    TimedOut,
}

/// Run an action to the end. `Err(Busy)` when another one is still running,
/// `Err(TimedOut)` when it outlived `ACTION_DEADLINE` and was stopped.
pub fn run(action: HostAction) -> io::Result<Result<HostRun, RunError>> {
    let Ok(_guard) = RUNNING.try_lock() else {
        return Ok(Err(RunError::Busy));
    };
    let deadline = Instant::now() + ACTION_DEADLINE;
    let mut child = Command::new("docker")
        .args(argv(action))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let reader = child.stdout.take().map(|stdout| {
        thread::spawn(move || {
            let mut output = Vec::new();
            let _ = stdout.take(MAX_OUTPUT as u64).read_to_end(&mut output);
            output
        })
    });
    let finished = wait_all(&mut [&mut child], deadline)?;
    if finished.is_none() {
        // Killing the client leaves the container running; it goes by name.
        let _ = docker_output(&rm_host_container_argv());
    }
    let output = reader.and_then(|r| r.join().ok()).unwrap_or_default();
    let Some(statuses) = finished else {
        return Ok(Err(RunError::TimedOut));
    };
    Ok(Ok(HostRun {
        exit_code: statuses[0].code().unwrap_or(-1),
        output: String::from_utf8_lossy(&output).into_owned(),
    }))
}

fn rm_host_container_argv() -> Vec<String> {
    ["rm", "-f", HOST_CONTAINER]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/* ------------------------------------------------------------------------ */
/* Image export, for scanning an image built on this host                    */
/* ------------------------------------------------------------------------ */

/// Prefix of the short-lived volume an image is exported into. Nothing else
/// may be named: the endpoint never creates or removes any other volume.
pub const EXPORT_VOLUME_PREFIX: &str = "polaris-secscan-image-";

/// Room kept free beyond the archive itself.
pub const EXPORT_HEADROOM: u64 = 1024 * 1024 * 1024;

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExportAction {
    Export,
    Remove,
    List,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct ImageExportRequest {
    pub action: ExportAction,
    /// Required for export and remove; ignored by list.
    #[serde(default)]
    pub volume: String,
    #[serde(default)]
    pub image: Option<String>,
}

/// `polaris-secscan-image-` and 8 to 32 lowercase hex characters.
pub fn valid_export_volume(name: &str) -> bool {
    name.strip_prefix(EXPORT_VOLUME_PREFIX).is_some_and(|rest| {
        (8..=32).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// An image reference as the deploy spec accepts one, that can never read as
/// a flag.
pub fn valid_export_image(image: &str) -> bool {
    crate::deploy::valid_image(image) && !image.starts_with('-')
}

/// The free bytes `df -Pk` reports on its one filesystem line.
pub fn parse_df_free(output: &str) -> Option<u64> {
    let line = output.lines().nth(1)?;
    let kib: u64 = line.split_whitespace().nth(3)?.parse().ok()?;
    kib.checked_mul(1024)
}

/// Whether an archive of `size` bytes fits in `free` with the headroom kept.
pub fn has_room(size: u64, free: u64) -> bool {
    size.checked_add(EXPORT_HEADROOM)
        .is_some_and(|need| need <= free)
}

pub fn inspect_size_argv(image: &str) -> Vec<String> {
    ["image", "inspect", "--format", "{{.Size}}", image]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Mounts the export volume in a throwaway container; `tail` runs inside it.
pub fn volume_run_argv(volume: &str, interactive: bool, tail: &[&str]) -> Vec<String> {
    let mount = format!("{volume}:/in");
    let mut args = vec!["run", "--rm"];
    if interactive {
        args.push("-i");
    }
    args.extend(["--network", "none", "-v", &mount, TOOLS_IMAGE]);
    args.extend(tail);
    args.into_iter().map(String::from).collect()
}

pub const FREE_TAIL: &[&str] = &["df", "-Pk", "/in"];
pub const WRITE_TAIL: &[&str] = &["/bin/sh", "-c", "cat > /in/image.tar"];

/// Why an export did not happen.
#[derive(Debug, PartialEq, Eq)]
pub enum ExportError {
    Busy,
    NoImage,
    NoRoom,
    TimedOut,
    Failed,
}

fn docker_output(args: &[String]) -> io::Result<(bool, String)> {
    let out = Command::new("docker")
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    ))
}

/// Save `image` into `volume` as `/in/image.tar`, after checking it fits.
/// Shares the host action lock, so it never overlaps another host scan.
pub fn export_image(image: &str, volume: &str) -> Result<u64, ExportError> {
    let Ok(_guard) = RUNNING.try_lock() else {
        return Err(ExportError::Busy);
    };
    let deadline = Instant::now() + EXPORT_DEADLINE;
    let (ok, size) = docker_output(&inspect_size_argv(image)).map_err(|_| ExportError::Failed)?;
    let size: u64 = match size.trim().parse() {
        Ok(size) if ok => size,
        _ => return Err(ExportError::NoImage),
    };
    let (ok, df) = docker_output(&volume_run_argv(volume, false, FREE_TAIL))
        .map_err(|_| ExportError::Failed)?;
    match parse_df_free(&df) {
        Some(free) if ok && has_room(size, free) => {}
        Some(_) if ok => return Err(ExportError::NoRoom),
        _ => return Err(ExportError::Failed),
    }
    let mut save = Command::new("docker")
        .args(["save", image])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ExportError::Failed)?;
    let stdout = save.stdout.take().ok_or(ExportError::Failed)?;
    let mut write = match Command::new("docker")
        .args(volume_run_argv(volume, true, WRITE_TAIL))
        .stdin(Stdio::from(stdout))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(write) => write,
        Err(_) => {
            let _ = save.kill();
            let _ = save.wait();
            return Err(ExportError::Failed);
        }
    };
    match wait_all(&mut [&mut save, &mut write], deadline) {
        Ok(Some(statuses)) if statuses.iter().all(ExitStatus::success) => Ok(size),
        Ok(None) => Err(ExportError::TimedOut),
        _ => Err(ExportError::Failed),
    }
}

/// Remove an export volume and the archive in it.
pub fn list_exports_argv() -> Vec<String> {
    let filter = format!("name={EXPORT_VOLUME_PREFIX}");
    ["volume", "ls", "-q", "--filter", &filter]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Keep only names an export could have: the filter is a substring match.
pub fn export_names(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|name| valid_export_volume(name))
        .map(String::from)
        .collect()
}

/// The export volumes on this host, for the dashboard to sweep leftovers.
pub fn list_exports() -> Option<Vec<String>> {
    match docker_output(&list_exports_argv()) {
        Ok((true, out)) => Some(export_names(&out)),
        _ => None,
    }
}

pub fn remove_export(volume: &str) -> bool {
    let args: Vec<String> = ["volume", "rm", "-f", volume]
        .iter()
        .map(|s| s.to_string())
        .collect();
    docker_output(&args).map(|(ok, _)| ok).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn stops_children_past_the_deadline() {
        let mut quick = Command::new("true").spawn().unwrap();
        let done = wait_all(&mut [&mut quick], Instant::now() + Duration::from_secs(5)).unwrap();
        assert!(done.is_some_and(|s| s[0].success()));
        let mut stuck = Command::new("sleep").arg("30").spawn().unwrap();
        let started = Instant::now();
        let done = wait_all(
            &mut [&mut stuck],
            Instant::now() + Duration::from_millis(300),
        )
        .unwrap();
        assert!(done.is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(stuck.try_wait().unwrap().is_some());
    }

    #[test]
    fn lists_only_export_volumes() {
        let out =
            "polaris-secscan-image-0123abcd\nx-polaris-secscan-image-0123abcd\npolaris-abc_data\n";
        assert_eq!(export_names(out), vec!["polaris-secscan-image-0123abcd"]);
        assert_eq!(
            list_exports_argv().last().map(String::as_str),
            Some("name=polaris-secscan-image-")
        );
        let list: ImageExportRequest = serde_json::from_str(r#"{"action":"list"}"#).unwrap();
        assert_eq!(list.action, ExportAction::List);
    }

    #[test]
    fn export_volume_names_are_confined() {
        assert!(valid_export_volume("polaris-secscan-image-0123abcd"));
        assert!(!valid_export_volume("polaris-secscan-image-0123ABCD"));
        assert!(!valid_export_volume("polaris-secscan-image-123"));
        assert!(!valid_export_volume("polaris-abc_data"));
        assert!(!valid_export_volume("polaris-secscan-image-0123abcd/../x"));
    }

    #[test]
    fn export_images_cannot_be_flags_or_shell() {
        assert!(valid_export_image("polaris-0123abcd:build-7"));
        assert!(valid_export_image("ghcr.io/acme/app@sha256:abc"));
        assert!(!valid_export_image("-o=/etc/passwd"));
        assert!(!valid_export_image("x; rm -rf /"));
        assert!(!valid_export_image(""));
    }

    #[test]
    fn reads_free_space_and_keeps_headroom() {
        let df = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 50 2097152 50% /in\n";
        assert_eq!(parse_df_free(df), Some(2 * 1024 * 1024 * 1024));
        assert_eq!(parse_df_free("garbage"), None);
        assert!(has_room(1024, 2 * 1024 * 1024 * 1024));
        assert!(!has_room(1024 * 1024 * 1024 + 1, 2 * 1024 * 1024 * 1024));
        assert!(!has_room(u64::MAX, u64::MAX));
    }

    #[test]
    fn export_containers_have_no_network_and_only_the_volume() {
        let args = volume_run_argv("polaris-secscan-image-0123abcd", true, WRITE_TAIL);
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"none".to_string()));
        assert!(args.contains(&"polaris-secscan-image-0123abcd:/in".to_string()));
        assert!(!args.iter().any(|a| a.contains("docker.sock")));
        assert_eq!(
            inspect_size_argv("img:1").last().map(String::as_str),
            Some("img:1")
        );
    }

    #[test]
    fn export_requests_are_closed() {
        let ok: ImageExportRequest = serde_json::from_str(
            r#"{"action":"export","volume":"polaris-secscan-image-0123abcd","image":"x:1"}"#,
        )
        .unwrap();
        assert_eq!(ok.action, ExportAction::Export);
        assert!(serde_json::from_str::<ImageExportRequest>(
            r#"{"action":"export","volume":"v","image":"x","cmd":"y"}"#
        )
        .is_err());
    }

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
