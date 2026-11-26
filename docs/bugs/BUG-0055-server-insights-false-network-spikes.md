---
id: BUG-0055
title: Server insights report hundreds of MB/s of traffic that never happened
status: fixed-watching
area: servers
location: dashboard/apps/web/src/lib/metrics-traffic.ts
related:
  - dashboard/apps/web/src/lib/server-probe.ts
  - dashboard/apps/web/src/lib/metrics-collector-service.ts
  - dashboard/apps/web/src/lib/server-insights/insights.ts
  - dashboard/apps/web/test/servers/metrics-traffic.test.ts
reported: 2026-11-26
fixed: 2026-11-26
fix_commit:
---

## What was seen

Server insights listed "Network - Unusually high" several times a week for a
registered server (ionos), marked Severe: 213 MB/s against a usual 60.9 KB/s,
181.9 MB/s, 216.2 MB/s, each for one hour, at night or around an update. An
hour at 213 MB/s is about 770 GB, more than the server's link can carry, and
nothing on it moved that much. The same figures feed the alert, the server's
network chart and the billed egress.

## Cause

The SSH probe (`server-probe.ts`) added up every interface in `/proc/net/dev`
except `lo`, container `veth*` pairs and Docker bridges included. A veth leaves
with its container, so that total fell on every deploy, update or container
restart.

`advanceTraffic` (then in `metrics-collector-service.ts`) reads a counter that
falls as one that started again and adds what it holds now. For a container
that is right. For the machine total it meant every byte the remaining
interfaces had moved since boot was added in one tick, and the hourly rollup
turned that into hundreds of MB/s.

A secondary effect: bytes crossing a veth, its bridge and the uplink were
counted two or three times, and tunnel interfaces (WireGuard, tun) once more.

## Fix

- The probe counts only interfaces that carry the machine's own traffic. It
  skips `lo`, `veth`, `docker`, `br-`, `virbr`, `cni`, `flannel`, `cali`,
  `vxlan`, `kube-`, `tunl`, `weave`, `podman`, `lxc`, `wg`, `tailscale`,
  `tun`, `tap` and `zt`, and prints each counted one as `netif=<name>\t<rx>\t<tx>`.
- The collector follows each interface on its own (`if:<name>` in
  `machineTraffic`). An interface that disappears takes nothing with it, a new
  one starts counting from its next reading, and one whose own counter falls
  (ppp reconnect, reboot) counts what it holds since.
- A single machine total, from an older probe reading, counts nothing on a
  fall instead of everything since boot.
- The traffic arithmetic moved to `lib/metrics-traffic.ts`, a pure module.
- The probe script is sent on every probe, so every registered server uses the
  new count once the dashboard is updated, with nothing to set up. The first
  tick after the update counts nothing new, so the switch itself draws no spike.

## Verification

- `test/servers/metrics-traffic.test.ts`: interface keys, an interface
  disappearing, a new one, one restarting, a falling machine total, and the
  switch from total to interfaces. Also parsing of `netif` lines.
- The probe's awk was run against a sample `/proc/net/dev` holding lo, eth0,
  docker0, a veth, wg0 and enp3s0: only eth0 and enp3s0 were counted.
- Not run against a live server. The hours already recorded with the false
  figures stay in the history; the insights list drops them once they are
  older than its 7-day window.

## If it happens again

Collect the server's `/proc/net/dev` at two moments around the spike and the
hourly rollup row (`MetricRollup`, `subjectType = host`) for that hour. A new
virtual interface naming scheme would need adding to the probe's skip list.
