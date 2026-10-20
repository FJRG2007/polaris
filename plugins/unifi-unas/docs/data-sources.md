# Where every value comes from

The agent runs on the NAS as root, so most values are read from the device
itself through interfaces documented outside UniFi. UniFi publishes no API for
UniFi Drive (there is nothing for it on developer.ui.com), so every Drive
endpoint below is one observed in use by an existing integration, never
guessed. The local Drive service listens on `127.0.0.1:16080`; through UniFi OS
the same paths are served under `/proxy/drive` (for example
`/proxy/drive/api/v2/storage` is `/api/v2/storage` on the device).

## Sourced and published

| Console item | Topic | Source |
|---|---|---|
| Online / offline | `availability` (MQTT last will) | The agent itself |
| Uptime | `system/uptime` | `/proc/uptime` |
| UniFi OS version | `system/os_version` | `/usr/lib/version` |
| Drive version | `system/drive_version` | `dpkg-query -W unifi-drive` |
| CPU temperature | `system/cpu_temp` | `/sys/class/thermal/thermal_zone0/temp` |
| Disk throughput (live read/write) | `system/disk_read`, `system/disk_write` | `/proc/diskstats` |
| Network: interface, IP, link speed, state | `network/{interface,ip,speed,state}` | `/proc/net/route` (default route), `ip -4 -o addr`, `/sys/class/net/<if>/{speed,operstate}` |
| Network throughput | `network/{rx_rate,tx_rate}` | `/proc/net/dev` deltas |
| Fan mode Quiet / Balanced / Cooling | `system/fan_profile`, set via `control/fan/profile` | `GET`/`PUT /api/v2/systems/fan-control`, body `{"profile": "quiet" \| "default" \| "cooling"}` - as used by the community integration [memphi2/ha-unifi-drive](https://github.com/memphi2/ha-unifi-drive) (`api_fan.py`, `const.py`, commit `03a89c4`) |
| Usage used / total per pool, RAID level, protection | `pool/<n>/*` | `GET /api/v2/storage` (`pools[].capacity`, `usage`, `status`, `raidGroups[0].currentLevel`, `currentProtection`), with a `df` fallback |
| Shared drives: size, quota, members, snapshots, encryption | `share/<name>/*` | `GET /api/v2/drives`, `GET /api/v2/drives/<id>`, `GET /api/v1/users` |
| Per bay: drive present / No Drive Detected | `hdd/<bay>/present` | Bay list per model (`core/src/bays.rs`) against the drives found |
| Per bay: status, temperature, power-on hours, model, serial, bad sectors | `hdd/<bay>/*` | `smartctl -a -j`, bay from `udevadm` ATA link |
| All Disks row: count, max / min temperature, average power-on hours, drives not Optimal | `system/disk_*`, `system/disks_not_optimal` | Computed in `core/src/storage.rs` from the bays above |
| Data scrubbing state, mismatches, progress; Run Now | `scrub/<md>/{action,mismatches,progress,running}`, `control/scrub/run` | Linux md sysfs `sync_action`, `mismatch_cnt`, `sync_completed`; Run Now writes `check` to `sync_action` ([kernel md documentation](https://docs.kernel.org/admin-guide/md.html)) |
| Time Machine on / off and which shares | `smb/time_machine`, `smb/time_machine_shares` | `testparm -s`, the `fruit:time machine` share option ([Samba vfs_fruit](https://www.samba.org/samba/docs/current/man-html/vfs_fruit.8.html)) |
| SMB address | `smb_address` attribute on Time Machine | `smb://` + the uplink IP |
| Sign-ins over SMB (who, from which IP, which share) | `smb/clients`; HA event `smb_session_started` | `smbstatus -b`, `smbstatus -S` |
| Backup tasks: status, last / next run, duration, source, destination, failed, overdue; run now; schedule on/off | coordinator, over SSH | `GET /api/v1/remote-backup/tasks`, `POST /api/v1/remote-backup/run-task/<id>`, `PATCH /api/v1/remote-backup/tasks/<id>` - inherited from the integration this plugin replaced; `failed` is `lastTaskRun.errorCodes` non-empty, `overdue` is `nextBackup` more than an hour in the past while the schedule is on and nothing runs |
| Throughput and temperature history (1H / 1D / 1W / 1M) | - | Home Assistant long-term statistics of the measurement sensors above, not the console's own history |

## Not available, and why

| Console item | Why it is not exposed |
|---|---|
| Target RAID level (e.g. "none -> RAID 5") | `/api/v2/storage` is only known to carry `currentLevel` and `currentProtection`; no source shows the field for a pending migration. Publishing a guessed key would be inventing it. |
| Storage pool breakdown (personal drives, system data, Microsoft 365 backup, available) | No source documents the endpoint or fields behind this chart. Shared drives and pool totals are covered above. |
| Personal drives with their setup state | `/api/v2/drives` lists them, but only the `shared` type value is known; the personal type and setup-state fields are not documented anywhere found. |
| Recent sign-ins through the UniFi app or web console (OS, app vs SMB) | No endpoint found that lists UniFi OS sign-ins; only SMB sessions are readable on the device. |
| Turning Time Machine on or off | No write endpoint is documented; editing Samba's config directly would be overwritten by UniFi Drive. Read-only. |
| Storage Shield setup state, schedule and its own graph | Drive release notes describe scrubbing for RAID 5/6 but no endpoint is documented. The md check above is the kernel's own scrub; whether Storage Shield drives exactly this check has not been verified on hardware. |
| Creating backup tasks (type, remote / local / USB / Microsoft 365 targets) | Only list, run and schedule-toggle endpoints are sourced. |
| CPU temperature "state" label | The thresholds the console uses for its label are not documented; the raw temperature is exposed instead. |

## Sourced but not implemented yet

| Item | Source |
|---|---|
| Snapshot inventory and settings | `/api/v1/systems/snapshot`, `/api/v1/snapshots/{personal,shared}/<id>` in [memphi2/ha-unifi-drive](https://github.com/memphi2/ha-unifi-drive) (`snapshot_paths.py`), marked experimental there. The per-share "snapshots enabled" flag is already published. |

## Not exercised on hardware

Every reader above is unit-tested against sample output, but the agent has not
been run on a UNAS since these were added. Unverified until it is: that
`fan-control` accepts the PUT with the admin identity headers on port 16080,
that Balanced is `default` on every firmware, that `testparm` ships on the
device, and which md arrays a UNAS Pro exposes.
