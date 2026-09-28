---
id: VULN-0002
title: UniFi UNAS Home Assistant add-on does not verify the NAS SSH host key
status: fixed
severity: medium
cwe: CWE-295
stride: Spoofing
cvss: "5.9"
cvss_vector: CVSS:3.1/AV:A/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:N
location: plugins/unifi-unas/homeassistant/custom_components/unifi_unas/ssh_manager.py:121
component: plugins/unifi-unas
reachability: INTERNAL
exploitability: HARD
confidence: 85
discovered: 2026-09-28
last_seen: 2026-09-29
fixed: 2026-09-29
fix_commit: null
---

## Summary
An attacker able to intercept LAN traffic impersonates the NAS and receives its SSH password (usually root) and the MQTT password.

## Root cause / data flow
asyncssh.connect(..., known_hosts=None) disables host key checking entirely.

## Evidence
White-box source trace; not exercised against a running instance.

ARP-spoof the NAS address on the LAN; the add-on connects and authenticates to the attacker's SSH server.

## Impact
Root credentials of the NAS disclosed to a LAN attacker.

## Remediation
Trust on first use: open_ssh_connection() in ssh_manager.py is the only SSH entry point; the first successful connection stores the NAS host key in the config entry and every later connection accepts only that key, refused during the handshake before any login is sent. Existing installs pin on their next connection with no reconfiguration. A changed key raises a repair issue, and Reconfigure has a one-time "Trust the new SSH host key" checkbox for a reinstalled NAS.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: left open pending a product decision; see Remediation.
- 2026-09-29: fixed in plugins/unifi-unas/homeassistant/custom_components/unifi_unas (ssh_manager.py, config_flow.py, __init__.py, const.py, strings.json, translations/en.json); verified against a local asyncssh 2.21.1 server, not inside Home Assistant.
