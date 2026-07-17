//! Small platform helpers: reading sysfs/procfs and running commands.

use std::fs;
use std::process::Command;

/// Read a file and trim surrounding whitespace. Returns `None` on any error.
pub fn read_trim(path: &str) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

/// Read the first whitespace-delimited token of a file (e.g. `/proc/uptime`).
pub fn read_first_token(path: &str) -> Option<String> {
    read_trim(path).and_then(|s| s.split_whitespace().next().map(str::to_owned))
}

/// Run a command, wrapped in the system `timeout` so a hung tool cannot stall
/// the monitor loop. Returns stdout (empty string on failure or non-UTF-8).
pub fn run(bin: &str, args: &[&str], timeout_secs: u32) -> String {
    let output = Command::new("timeout")
        .arg(timeout_secs.to_string())
        .arg(bin)
        .args(args)
        .output();
    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
        Err(_) => String::new(),
    }
}

/// Log a line to stdout; systemd/journald adds its own timestamps.
pub fn log(msg: impl AsRef<str>) {
    println!("{}", msg.as_ref());
}
