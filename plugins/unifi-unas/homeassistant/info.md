# UniFi UNAS (Polaris)

Monitor and control a Ubiquiti UniFi UNAS from Home Assistant: drive SMART data,
system metrics, storage pools, shares and temperature-based fan control.

The device side runs a single static Rust binary (`polaris-unas-agent`), so the
UNAS needs no Python or MQTT packages installed - the integration pushes the
binary over SSH and starts it as a systemd service.

## Quick start

1. Install the MQTT integration and a broker (Mosquitto add-on) first.
2. Install this integration manually from the repository releases (see the README).
3. Add the integration in Settings and enter the UNAS IP and SSH credentials.
4. Sensors and controls appear automatically over MQTT discovery.

## Requirements

- UniFi UNAS with SSH enabled (root)
- An MQTT broker reachable from both Home Assistant and the UNAS

## Links

[Documentation](https://github.com/FJRG2007/polaris/tree/main/plugins/unifi-unas) - [Issues](https://github.com/FJRG2007/polaris/issues)
