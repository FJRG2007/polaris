//! Domain logic for the UniFi UNAS integration, free of any I/O side effects.
//!
//! This crate is deliberately platform-agnostic: it parses SMART data, maps
//! physical bays, lays out MQTT topics and runs the fan control algorithm, but
//! it never touches the filesystem, a network socket or a shell. The on-device
//! agent and the future Polaris dashboard both build their I/O on top of it,
//! which keeps the behaviour identical across every consumer.

pub mod bays;
pub mod fan;
pub mod model;
pub mod mqtt;
pub mod smart;

pub use model::{HddDrive, NvmeDrive, Pool, Share, SystemMetrics};

/// A single retained MQTT publication: a topic and its string payload.
///
/// The whole integration speaks in retained string values so Home Assistant
/// entities can pick up the last known state immediately on restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Publication {
    pub topic: String,
    pub payload: String,
}

impl Publication {
    pub fn new(topic: impl Into<String>, payload: impl Into<String>) -> Self {
        Self {
            topic: topic.into(),
            payload: payload.into(),
        }
    }
}
