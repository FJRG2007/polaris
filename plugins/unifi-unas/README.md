# UniFi UNAS plugin

Monitoring and fan control for UniFi UNAS devices.

The device-side monitor and fan controller are a single static Rust binary
instead of a Python script plus a Bash script, so the UNAS needs no `python3-pip`,
`paho-mqtt` or `mosquitto-clients` installed. The MQTT contract is unchanged, so
the Home Assistant entities behave exactly as upstream.

## Install

This plugin lives inside the Polaris monorepo, so it is installed manually
(HACS installs one integration per repository from the repo root, which a
monorepo subdirectory is not).

1. Download `unifi_unas.zip` from the [latest release](https://github.com/FJRG2007/polaris/releases).
2. Extract it into your Home Assistant `/config` directory so the files land in `/config/custom_components/unifi_unas/`.
3. Restart Home Assistant.
4. Settings -> Devices & Services -> Add Integration -> "UniFi UNAS".

Full setup fields, SSH key auth and troubleshooting are in the
[integration README](homeassistant/README.md).

## Layout

| Path | What |
|------|------|
| `core/` | `polaris-unas-core` - domain model, SMART parsing, bay mapping, MQTT topics, fan PI controller. Pure library, reused by the agent and the future Polaris dashboard. |
| `agent/` | `polaris-unas-agent` - the on-device binary. Collects metrics and drives the fans, publishing to MQTT. |
| `homeassistant/` | HACS-installable integration (Python glue). Deploys the agent binary over SSH; entities reuse the identical MQTT contract. |

Status and full parity checklist live in [ROADMAP.md](ROADMAP.md).

## Building the agent

Device-side build (aarch64 static musl, needs Docker + `cargo install cross`):

```sh
plugins/unifi-unas/agent/build/cross-build.sh
# -> target/aarch64-unknown-linux-musl/release/polaris-unas-agent
```

The binary is configured entirely through environment variables (written by the
Home Assistant integration into `/etc/polaris-unas-agent.env`):

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `POLARIS_MQTT_HOST` | yes | - | Broker address |
| `POLARIS_MQTT_ROOT` | yes | - | Topic root, e.g. `unas/abcd1234` |
| `POLARIS_MQTT_PORT` | no | `1883` | |
| `POLARIS_MQTT_USER` / `POLARIS_MQTT_PASS` | no | - | Broker credentials |
| `POLARIS_DEVICE_MODEL` | no | `UNAS_PRO` | One of the supported model keys |
| `POLARIS_MONITOR_INTERVAL` | no | `30` | Seconds, clamped 5-60 |

Install on the device with the provided systemd unit
(`agent/build/polaris-unas-agent.service`).

## Development

```sh
cargo test -p polaris-unas-core -p polaris-unas-agent
cargo clippy --all-targets
```
