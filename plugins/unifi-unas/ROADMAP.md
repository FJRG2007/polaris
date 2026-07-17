# UniFi UNAS plugin - coverage ledger

UniFi UNAS monitoring and fan control on the Polaris Rust-first architecture.
This file tracks every work unit and its status so nothing is silently dropped.
Update it as phases land.

## Architecture change vs upstream

Upstream deploys, onto the UNAS, a Python monitor (`unas_monitor.py`, needs
`python3-pip` + `paho-mqtt`) plus a Bash fan controller (`fan_control.sh`, needs
`mosquitto-clients`), coordinating through `/tmp` files. Polaris replaces both
with **one static Rust binary** that unifies monitoring and fan control, shares
state in memory (no temp files), and installs **zero** runtime dependencies on
the device. The MQTT topic contract is kept byte-for-byte identical so the Home
Assistant entities are unchanged.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | Monorepo structure, workspace, gitignore | done |
| 2 | `polaris-unas-core`: model, SMART parse, bays, topics, fan PI (20 tests) | done |
| 3 | `polaris-unas-agent`: system/drive/storage/net collectors, MQTT, fan loop | done (compiles, 25 tests, clippy/fmt clean; on-device runtime untested) |
| 4 | Cross-compile (aarch64-musl via `cross`/Docker) + systemd unit | tooling done (`cross-build.sh` + unit); binary built by the release workflow in CI (local Docker build intentionally not run) |
| 5 | Home Assistant glue: deploy binary instead of scripts; keep entities | done (Python compiles; entities reused, deploy swapped to single binary + env + unit) |
| 6 | HACS packaging (hacs.json, manifest, hassfest/hacs CI) | done |
| 7 | Release workflow: publish `homeassistant/` subtree to its own repo | done (needs one-time `PUBLISH_TOKEN` secret + target repo `polaris-unifi-unas`) |

## Feature parity checklist (upstream -> Polaris)

On-device agent:
- [x] System metrics: uptime, OS/drive/protect version, CPU usage/temp, memory, disk I/O, fan PWM/percent, machine-id
- [x] HDD SMART: model, serial, firmware, status, temp, rpm, power-on-hours, bad sectors, size
- [x] NVMe SMART: temp, wear %, spare, media errors, unsafe shutdowns, size
- [x] Storage pools via local Drive API with `df` fallback
- [x] Shares: usage, quota, pool, members, snapshot, encryption
- [x] SMB connections + NFS mounts
- [x] Bay remapping per device model (incl. UNVR unofficial)
- [x] Drive move/removal grace period
- [x] Fan modes: UNAS-managed, custom curve, target-temp (PI), set-speed
- [x] Live monitor interval + fan curve control over MQTT
- [ ] MQTT TLS transport (plaintext done; TLS is the one deferred parity item - phase 3b)
- [ ] Fan mode-transition integral save/restore window (warm-start done; 300s restore refinement pending)

Home Assistant glue (phase 5):
- [x] config_flow, entities (sensor/binary_sensor/button/number/select/switch) - reused, MQTT contract identical
- [x] Deploy single binary + env file + systemd unit over SSH (replaces script upload + apt/pip installs)
- [x] Backup task API (buttons/switches) - unchanged
- [x] Clean removal restores stock fan control (no packages to uninstall now)

Packaging / release (phases 6-7):
- [x] hacs.json (zip_release) + manifest + info.md + README + hacs/hassfest CI in the subtree
- [x] Monorepo CI (Rust fmt/clippy/test + Python compile)
- [x] Release workflow builds aarch64/x86_64 agents, bundles the HACS zip, publishes the subtree + release to the standalone repo

## Notes / deliberate differences

- Rounding: fan math uses round-half-away-from-zero vs the shell's round-half-to-even.
  Differs only on exact `.5` PWM boundaries (one step on a 0..255 output).
- Monitor and fan control are one process, so the `/tmp/unas_hdd_temp` and
  `/tmp/unas_monitor_interval` handoff files are gone; temperature samples are
  shared in memory.
