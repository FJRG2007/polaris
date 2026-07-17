//! MQTT transport setup and a thin publish helper over rumqttc.
//!
//! TCP-only for now (see ROADMAP phase 3b for TLS). All state is published
//! retained so Home Assistant entities recover immediately after a restart.

use std::time::Duration;

use rumqttc::{Client, Connection, LastWill, MqttOptions, QoS};

use crate::config::Config;
use polaris_unas_core::mqtt::Topics;

const REQUEST_QUEUE: usize = 256;

/// Build the MQTT client and its connection driver, with an offline last-will
/// so Home Assistant marks the device unavailable if the agent dies.
pub fn connect(cfg: &Config, topics: &Topics) -> (Client, Connection) {
    let client_id = format!("polaris-agent-{}", cfg.mqtt_root.replace('/', "-"));
    let mut opts = MqttOptions::new(client_id, cfg.mqtt_host.clone(), cfg.mqtt_port);
    opts.set_keep_alive(Duration::from_secs(60));
    if !cfg.mqtt_user.is_empty() {
        opts.set_credentials(cfg.mqtt_user.clone(), cfg.mqtt_pass.clone());
    }
    opts.set_last_will(LastWill::new(
        topics.availability(),
        "offline",
        QoS::AtLeastOnce,
        true,
    ));
    Client::new(opts, REQUEST_QUEUE)
}

/// Publish a retained value, dropping it if the outbound queue is momentarily
/// full. Retained state is republished every cycle, so a dropped message
/// self-heals rather than blocking the collector loops during an outage.
pub fn publish(client: &Client, topic: String, payload: String) {
    let _ = client.try_publish(topic, QoS::AtLeastOnce, true, payload.into_bytes());
}
