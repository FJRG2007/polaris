# UniFi UNAS for Home Assistant (Polaris)

[![hacs](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)

Monitoring and fan control for UniFi UNAS with native Home Assistant integration.

Part of the [Polaris](https://github.com/FJRG2007/polaris) project. The
device-side monitor and fan controller are a single static Rust binary instead
of interpreted scripts, so the UNAS needs **no** `python3-pip`, `paho-mqtt` or
`mosquitto-clients` installed.

## Features

- One-click setup: the agent binary is deployed over SSH, no packages installed on the UNAS
- 40+ sensors: drives, system metrics, storage pools, shares, SMB/NFS
- Fan control: UNAS-managed, custom curve, target temperature (PI controller), fixed speed
- Auto-recovery: the agent is redeployed on upgrades or if missing after firmware updates
- Native MQTT discovery devices and entities

## What's included

- **Sensors** - CPU temp/usage, memory, disk I/O, fan PWM/percent, uptime, OS version; per-drive SMART (HDD and NVMe); storage pool usage and RAID; per-share usage/quota/members; SMB and NFS clients; backup task status
- **Binary sensors** - Agent installed, Monitor, Fan Control
- **Controls** - Fan mode (select), target temperature, temperature metric, response speed, fan speed, min/max temp and fan (numbers)
- **Switches** - Backup schedule per task
- **Buttons** - Reinstall Agent, Reboot, Shutdown, Trigger backup

## Requirements

1. **MQTT integration** installed in Home Assistant, with a broker (the Mosquitto add-on is easiest). Authentication is required.
2. **SSH access to the UNAS** (root). Enable in UniFi Drive: Settings -> Control Plane -> Console -> SSH. Password or key auth both work.

## Installation (HACS)

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=FJRG2007&repository=polaris-unifi-unas&category=integration)

1. Click the button above (or HACS -> three-dot menu -> Custom repositories -> add this repository as an `Integration`).
2. Install "UniFi UNAS (Polaris)" and restart Home Assistant.
3. Settings -> Devices & Services -> Add Integration -> "UniFi UNAS".

The integration downloads the release ZIP (which bundles the prebuilt agent
binary), then on setup deploys it to the UNAS over SSH and starts the
`polaris-unas-agent` systemd service.

## Setup

[![Open your Home Assistant instance and start setting up a new integration.](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=unifi_unas)

Enter:

- **Host** - UNAS IP
- **Username** - `root`
- **Password** - UNAS SSH password (leave blank to use an SSH key)
- **MQTT Host / User / Password** - your broker
- **Device Model** - your UNAS/UNVR model
- **Polling Interval** - 5-60 s

## Fan control modes

- **UNAS Managed** - leave fans to the device (monitoring only)
- **Custom Curve** - linear speed between min/max temperature
- **Target Temperature** - PI controller holds the drives at a target temp, with Relaxed/Balanced/Aggressive response
- **Set Speed** - fixed 0-100%

## Removal

Removing the integration stops and removes the agent (binary, systemd unit, env
file) and restores stock fan control. No packages were installed, so nothing is
uninstalled.

## Architecture and development

Developed in the [Polaris monorepo](https://github.com/FJRG2007/polaris) under
`plugins/unifi-unas/`. The device agent (`agent/`) and shared domain logic
(`core/`) are Rust; this Home Assistant integration is the Python glue. See the
plugin ROADMAP for the parity checklist.

## License

MIT - see [LICENSE](LICENSE).
