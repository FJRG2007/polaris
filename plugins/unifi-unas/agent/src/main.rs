//! Polaris UniFi UNAS on-device agent.
//!
//! One static binary that unifies monitoring and fan control. It collects
//! system, drive, storage and network metrics, publishes them retained over
//! MQTT for Home Assistant, and drives the chassis fans according to the mode
//! and curve selected from Home Assistant. Replaces the upstream Python monitor
//! and Bash fan controller, removing all runtime dependencies from the device.

mod api;
mod broker;
mod collect;
mod config;
mod fanctl;
mod util;

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use rumqttc::{Client, Event, Packet, QoS};

use polaris_unas_core::model::ToMqttFields;
use polaris_unas_core::mqtt::Topics;

use crate::collect::Monitor;
use crate::config::Config;
use crate::fanctl::{apply_control, ControlState, FanLoop, TempsSnapshot};
use crate::util::log;

fn main() {
    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("config error: {e}");
            std::process::exit(1);
        }
    };
    let topics = Topics::from_root(cfg.mqtt_root.clone());
    log(format!(
        "polaris-unas-agent starting (model {}, interval {}s)",
        cfg.model.as_key(),
        cfg.interval
    ));

    let control = Arc::new(Mutex::new(ControlState {
        monitor_interval: cfg.interval,
        ..ControlState::default()
    }));
    let temps = Arc::new(Mutex::new(TempsSnapshot::default()));

    let (client, mut connection) = broker::connect(&cfg, &topics);

    // Thread A: drive the MQTT connection and apply control messages.
    {
        let client = client.clone();
        let topics = topics.clone();
        let control = control.clone();
        thread::spawn(move || {
            for event in connection.iter() {
                match event {
                    Ok(Event::Incoming(Packet::ConnAck(_))) => {
                        log("MQTT connected");
                        broker::publish(&client, topics.availability(), "online".to_string());
                        let _ = client.subscribe(topics.monitor_interval(), QoS::AtLeastOnce);
                        let _ = client.subscribe(topics.fan_mode(), QoS::AtLeastOnce);
                        let _ = client.subscribe(topics.fan_curve_wildcard(), QoS::AtLeastOnce);
                    }
                    Ok(Event::Incoming(Packet::Publish(p))) => {
                        if let Ok(payload) = std::str::from_utf8(&p.payload) {
                            let mut state = control.lock().unwrap();
                            apply_control(&mut state, &topics, &p.topic, payload);
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        log(format!("MQTT connection error: {e}"));
                        thread::sleep(Duration::from_secs(2));
                    }
                }
            }
        });
    }

    // Thread B: collect metrics and publish on the monitor interval.
    {
        let client = client.clone();
        let topics = topics.clone();
        let control = control.clone();
        let temps = temps.clone();
        let model = cfg.model;
        thread::spawn(move || {
            let mut monitor = Monitor::new(model);
            let mut generation = 0u64;
            loop {
                let drive_temps = collect_and_publish(&client, &topics, &mut monitor);
                generation += 1;
                {
                    let mut snap = temps.lock().unwrap();
                    snap.temps = drive_temps;
                    snap.generation = generation;
                }
                let interval = control.lock().unwrap().monitor_interval;
                thread::sleep(Duration::from_secs(interval));
            }
        });
    }

    // Main thread: fan control loop at 1 Hz.
    let mut fan = FanLoop::new();
    loop {
        let ctl = control.lock().unwrap().clone();
        let snap = temps.lock().unwrap().clone();
        fan.tick(&ctl, &snap, |pwm| {
            broker::publish(&client, topics.system("fan_speed"), pwm.to_string())
        });
        thread::sleep(Duration::from_secs(1));
    }
}

/// Collect everything once, publish it retained, and return the drive
/// temperatures (hottest first) for the fan loop.
fn collect_and_publish(client: &Client, topics: &Topics, monitor: &mut Monitor) -> Vec<i64> {
    let system = monitor.system_metrics();
    for (metric, value) in system.to_mqtt_fields() {
        broker::publish(client, topics.system(metric), value);
    }

    let (drives, mut temps) = monitor.drives();
    for d in &drives {
        for (metric, value) in d.to_mqtt_fields() {
            broker::publish(client, topics.hdd(&d.bay, metric), value);
        }
    }

    let nvmes = monitor.nvme_drives();
    for n in &nvmes {
        for (metric, value) in n.to_mqtt_fields() {
            broker::publish(client, topics.nvme(&n.slot, metric), value);
        }
    }

    let pools = monitor.pools();
    for p in &pools {
        for (metric, value) in p.to_mqtt_fields() {
            broker::publish(client, topics.pool(p.number, metric), value);
        }
    }

    // UNVR units have no SMB/NFS/shares.
    if !monitor.is_unvr() {
        let (smb_count, smb_clients) = monitor.smb();
        broker::publish(client, topics.smb("connections"), smb_count.to_string());
        broker::publish(
            client,
            topics.smb("clients"),
            serde_json::to_string(&smb_clients).unwrap_or_else(|_| "[]".into()),
        );

        let (nfs_count, nfs_clients) = monitor.nfs();
        broker::publish(client, topics.nfs("mounts"), nfs_count.to_string());
        broker::publish(
            client,
            topics.nfs("clients"),
            serde_json::to_string(&nfs_clients).unwrap_or_else(|_| "[]".into()),
        );

        for s in &monitor.shares() {
            for (metric, value) in s.to_mqtt_fields() {
                broker::publish(client, topics.share(&s.name, metric), value);
            }
        }
    }

    temps.sort_unstable_by(|a, b| b.cmp(a));
    let hdd = if temps.is_empty() {
        "no drives".to_string()
    } else {
        temps
            .iter()
            .map(|t| format!("{t}C"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    log(format!(
        "{} PWM ({}%) | CPU {}C | HDD {} | R {} MB/s W {} MB/s",
        system.fan_speed,
        system.fan_speed_percent,
        system.cpu_temp,
        hdd,
        system.disk_read,
        system.disk_write
    ));

    temps
}
