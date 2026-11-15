//! Polaris' tunnel daemon: userspace WireGuard that forwards TCP and UDP ports
//! between its two ends, with no TUN device and no privileges.

pub mod config;
pub mod engine;
pub mod fragment;
pub mod packet;
pub mod session;
pub mod status;

/// Set by `--silent`: nothing is logged.
pub static SILENT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
