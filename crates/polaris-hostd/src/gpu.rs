//! What the NVIDIA cards on this host are doing, for the dashboard's metrics.
//!
//! The daemon runs in a container with neither `nvidia-smi` nor the driver's
//! libraries, so the reading is taken on the host itself: one short-lived
//! container sees the host's root and process tree and runs the script there.
//! Nothing from the request reaches the command line - the endpoint takes no
//! input at all - and there is no shell between this process and `docker`.
//!
//! Whether there is a card is asked once and remembered: a host without the
//! NVIDIA driver has no `/dev/nvidiactl`, and is never asked again, so a machine
//! with no GPU pays nothing for this feature.
//!
//! The script is word for word the one the dashboard runs over SSH on a remote
//! server (`apps/web/src/lib/gpu/nvidia.ts`), which also parses what it prints;
//! a dashboard test reads this file and fails when the two drift.

use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::host_security::{wait_all, TOOLS_IMAGE};

pub const GPU_SCRIPT: &str = r#"if command -v nvidia-smi >/dev/null 2>&1; then
t=; command -v timeout >/dev/null 2>&1 && t="timeout 10"
$t nvidia-smi --query-gpu=index,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,name --format=csv,noheader,nounits </dev/null 2>/dev/null | head -n 16 | while IFS= read -r line; do printf 'gpu=%s\n' "$line"; done
$t nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits </dev/null 2>/dev/null | head -n 256 | while IFS=', ' read -r uuid pid mem; do cid=$(grep -o -E '[0-9a-f]{64}' "/proc/$pid/cgroup" 2>/dev/null | head -n 1); printf 'gpuproc=%s,%s,%s,%s\n' "$uuid" "$pid" "$mem" "$cid"; done
fi
"#;

/// The node the NVIDIA driver creates on a host it is loaded on.
pub const NVIDIA_CONTROL_DEVICE: &str = "/dev/nvidiactl";

/// The one name every reading runs under, so two never overlap.
pub const GPU_CONTAINER: &str = "polaris-gpu-probe";

/// Most of what a reading prints that is kept; a busy card is a few KB.
pub const MAX_OUTPUT: usize = 256 * 1024;

/// Longest a reading may take before it is stopped.
pub const DEADLINE: Duration = Duration::from_secs(20);

/// Whether the NVIDIA driver's control node exists at `control_device`.
pub fn has_nvidia_at(control_device: &Path) -> bool {
    control_device.exists()
}

/// Asked once per daemon: a driver is not loaded on a running host.
pub fn has_nvidia() -> bool {
    static PRESENT: OnceLock<bool> = OnceLock::new();
    *PRESENT.get_or_init(|| has_nvidia_at(Path::new(NVIDIA_CONTROL_DEVICE)))
}

/// The arguments after `docker`. Privileged for the card's device nodes, the
/// host's process tree so a process's cgroup names its container, no network,
/// and the host's root read-only.
pub fn argv() -> Vec<String> {
    [
        "run",
        "--rm",
        "--name",
        GPU_CONTAINER,
        "--cpu-shares",
        "64",
        "--memory",
        "128m",
        "--privileged",
        "--pid",
        "host",
        "--network",
        "none",
        "-v",
        "/:/host:ro",
        TOOLS_IMAGE,
        "chroot",
        "/host",
        "/bin/sh",
        "-c",
        GPU_SCRIPT,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Why there is no reading.
#[derive(Debug, PartialEq, Eq)]
pub enum GpuError {
    /// Another reading is still running.
    Busy,
    TimedOut,
}

static RUNNING: Mutex<()> = Mutex::new(());

/// Take one reading on a host that has a card.
pub fn read() -> io::Result<Result<String, GpuError>> {
    let Ok(_guard) = RUNNING.try_lock() else {
        return Ok(Err(GpuError::Busy));
    };
    let deadline = Instant::now() + DEADLINE;
    let mut child = Command::new("docker")
        .args(argv())
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
        let _ = Command::new("docker")
            .args(["rm", "-f", GPU_CONTAINER])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        return Ok(Err(GpuError::TimedOut));
    }
    let output = reader.and_then(|r| r.join().ok()).unwrap_or_default();
    Ok(Ok(String::from_utf8_lossy(&output).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_host_without_the_driver_has_no_card() {
        let dir = std::env::temp_dir().join(format!("polaris-gpu-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let device = dir.join("nvidiactl");
        assert!(!has_nvidia_at(&device));
        std::fs::write(&device, b"").unwrap();
        assert!(has_nvidia_at(&device));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_reading_is_fixed_read_only_and_offline() {
        let args = argv();
        assert_eq!(args[0], "run");
        assert!(args.windows(2).any(|w| w == ["-v", "/:/host:ro"]));
        assert!(args.windows(2).any(|w| w == ["--network", "none"]));
        assert!(args.windows(2).any(|w| w == ["--pid", "host"]));
        assert!(args.windows(2).any(|w| w == ["--name", GPU_CONTAINER]));
        assert_eq!(args.last().map(String::as_str), Some(GPU_SCRIPT));
        // The script is the only shell, and it takes no arguments.
        assert_eq!(
            &args[args.len() - 5..args.len() - 1],
            ["chroot", "/host", "/bin/sh", "-c"]
        );
    }

    #[test]
    fn the_script_prints_nothing_without_nvidia_smi_and_bounds_its_output() {
        assert!(GPU_SCRIPT.starts_with("if command -v nvidia-smi >/dev/null 2>&1; then"));
        assert!(GPU_SCRIPT.contains("head -n 16"));
        assert!(GPU_SCRIPT.contains("head -n 256"));
        // A wedged driver hangs nvidia-smi; each call is cut off on its own.
        assert_eq!(GPU_SCRIPT.matches("$t nvidia-smi").count(), 2);
        assert!(GPU_SCRIPT.contains("t=\"timeout 10\""));
        assert!(GPU_SCRIPT.trim_end().ends_with("fi"));
    }
}
