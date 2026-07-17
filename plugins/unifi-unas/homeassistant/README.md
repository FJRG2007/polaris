# UniFi UNAS for Home Assistant (Polaris)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Monitoring and fan control for UniFi UNAS with native Home Assistant integration.

Part of the [Polaris](https://github.com/FJRG2007/polaris) project. The device-side
monitor and fan controller are a single static Rust binary instead of interpreted
scripts, so the UNAS needs **no** `python3-pip`, `paho-mqtt` or `mosquitto-clients`
installed. Everything is exposed through MQTT auto-discovery as proper Home
Assistant devices and entities.

## Features

- **One-click setup** - the agent binary is deployed over SSH; nothing is installed on the UNAS
- **Full monitoring** - 40+ sensors for drives, system metrics, storage pools and network shares
- **Fan control** - four modes, including a target-temperature PI controller
- **Auto-recovery** - the agent is redeployed on upgrades or if missing after a firmware update
- **Native integration** - real HA devices and entities via MQTT discovery

## What's included

### Sensors

- **System** - CPU temperature and usage, memory usage, disk I/O throughput, fan speed (PWM and percent), uptime, OS version
- **Drives (HDD)** - temperature, SMART status, model, serial, firmware, RPM, power-on hours, bad sectors, size
- **Drives (NVMe)** - temperature, SMART status, percentage used (wear), available spare, media errors, unsafe shutdowns, size
- **Storage** - pool usage, size, available space, status, RAID level
- **Shares** - per-share usage, quota, storage pool, member count and details, snapshot and encryption status
- **Network** - SMB connection count (with client details) and NFS mount count (with share details)
- **Backup tasks** - status, progress, last run, next scheduled run, source/destination

### Binary sensors

- **Agent Installed** - whether the agent is deployed on the UNAS
- **Monitor** - whether the agent service is running
- **Fan Control** - whether fan control is active

### Controls

- **Fan Mode** (select) - UNAS Managed, Custom Curve, Target Temperature, or Set Speed
- **Target Temperature** (number) - desired drive temperature for Target Temperature mode
- **Temperature Metric** (select) - Max (hottest drive) or Average
- **Response Speed** (select) - Relaxed, Balanced, or Aggressive
- **Fan Speed** (number) - manual speed for Set Speed mode
- **Min/Max Temperature and Min/Max Fan Speed** (numbers) - curve limits

> Controls are context-sensitive: only the settings relevant to the selected fan mode are adjustable.

### Switches and buttons

- **Backup Schedule** (switch) - enable/disable each configured backup task
- **Reinstall Agent**, **Reboot**, **Shutdown**, **Run backup** (buttons)

## Supported devices

- UNAS Pro (7-bay)
- UNAS Pro 8
- UNAS Pro 4
- UNAS 4
- UNAS 2
- UNVR / UNVR Pro - unofficial (video recorders, not NAS units; no SMB/NFS/shares, and they report a UniFi Protect version instead of Drive)

## Requirements

1. **MQTT integration** installed in Home Assistant, with a broker running (the Mosquitto add-on is easiest). Authentication (username/password) is required.
2. **SSH access to the UNAS** as `root`. Enable it in UniFi Drive: Settings -> Control Plane -> Console -> check "SSH". Password or SSH key both work.

## Installation

Run the installer on the Home Assistant host (Terminal & SSH add-on, the HA
container, or a Core host):

```sh
curl -fsSL https://raw.githubusercontent.com/FJRG2007/polaris/main/plugins/unifi-unas/homeassistant/install.sh | sh
```

It downloads the latest release (which bundles the prebuilt agent binary) and
installs it into `<config>/custom_components/unifi_unas/`, then restart Home
Assistant.

Prefer to do it by hand? Download [`install.sh`](install.sh) and review it, or
download `unifi_unas.zip` from the [releases](https://github.com/FJRG2007/polaris/releases)
and extract it into your `/config` directory so the files land in
`/config/custom_components/unifi_unas/`. Restart Home Assistant afterwards.

## Setup

### Add the integration

[![Open your Home Assistant instance and start setting up a new integration.](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=unifi_unas)

Or: Settings -> Devices & Services -> Add Integration -> search "UniFi UNAS".

Fill in:

- **Host** - UNAS IP address (e.g. `192.168.1.25`)
- **Username** - `root`
- **Password** - your UNAS SSH password (leave blank if using an SSH key)
- **MQTT Host** - IP of your MQTT broker (your HA IP if using the Mosquitto add-on)
- **MQTT User** / **MQTT Password** - your broker credentials (required)
- **Device Model** - pick your UNAS/UNVR model (sets the correct drive-bay mapping)
- **Polling Interval** - how often to collect metrics, 5-60 seconds

On submit the integration will automatically:

- Deploy the agent binary and its systemd service to the UNAS over SSH
- Set up MQTT auto-discovery
- Create all devices and entities

> **Device model** cannot be changed after setup (it fixes the bay mapping). To change it, remove and re-add the integration.

### SSH key authentication (optional)

Instead of a password you can use key-based auth:

1. Generate a key pair if you do not have one:
   ```bash
   ssh-keygen -t ed25519
   ```
2. Copy the public key to the UNAS:
   ```bash
   ssh-copy-id root@YOUR_UNAS_IP
   ```
3. Place the private key where Home Assistant can read it:
   - HAOS/Supervised: `/config/.ssh/id_ed25519` or `/config/.ssh/id_rsa`
   - Core/Docker: `~/.ssh/id_ed25519` or `~/.ssh/id_rsa`
4. Leave the password field blank during setup - the key is detected automatically.

### MQTT over TLS

The on-device agent currently connects to the broker in **plaintext**, so use a
standard plaintext listener (typically port 1883). Encrypted broker connections
from the device are planned but not yet supported; leave "Use TLS" off.

## Fan control modes

- **UNAS Managed** - the device controls the fans (monitoring only).
- **Custom Curve** - fan speed scales linearly between your min/max temperature and min/max fan speed.
- **Target Temperature** - a PI controller holds the drives at a target temperature, ramping up when hot and easing off when stable. Choose Max or Average drive temperature and a Relaxed/Balanced/Aggressive response. It typically reaches steady state within 15-30 minutes of a change.
- **Set Speed** - lock the fans to a fixed 0-100%.

## Dashboard card

A ready-made Mushroom dashboard card is included in [`card.yaml`](card.yaml). It
requires the Mushroom and card-mod custom cards (both available in HACS). Create
a Section, edit it in YAML, and paste the file's contents. Adjust the drive
headings and entity IDs to match your bay count.

## Troubleshooting

**Agent not installing** - check Settings -> System -> Logs for `unifi_unas`. Verify the UNAS IP and root credentials, that SSH is enabled (port 22), and that you are using the `root` account.

**Sensors not appearing** - confirm the MQTT integration is installed and the broker is running, and that the MQTT credentials are correct. On the UNAS you can check the service:
```bash
ssh root@YOUR_UNAS_IP
systemctl status polaris-unas-agent
```

**Drives not appearing** - new or moved drives can take up to ~60 seconds to be detected.

**After a firmware update** - the agent redeploys automatically on startup if missing. You can also press the "Reinstall Agent" button on the device page.

**Removing the integration** - stops and removes the agent (binary, systemd unit, env file) and restores stock fan control. No packages were installed, so nothing is uninstalled.

## License

MIT - see [LICENSE](LICENSE).
