# Hardware requirements

What a machine needs to run Polaris, and how much more to leave for what you
run on it.

The figures for Polaris itself were measured on a running deployment (16 cores,
32 GB of RAM, Ubuntu Server) on 2026-11-28. Polaris was idle at the time, with a
few people signed in. The minimum and recommended sizes are derived from those
figures: no install has been tested on a machine below the minimum.

## Polaris on its own

| Part                                  | Memory in use | Image  |
| ------------------------------------- | ------------- | ------ |
| Dashboard (web, API, background jobs) | 1.3-2.6 GB    | 425 MB |
| Database (PostgreSQL)                 | ~360 MB       | 110 MB |
| Calls (LiveKit)                       | ~70 MB        | 39 MB  |
| Reverse proxy (Traefik)               | ~50 MB        | 52 MB  |
| Edge guard (firewall)                 | ~45 MB        | 61 MB  |
| Host daemon                           | ~17 MB        | 80 MB  |
| Local network name (mDNS)             | ~13 MB        | 61 MB  |
| **Total**                             | **~2-3.2 GB** | **~0.8 GB** |

- The dashboard is most of it, and most of its figure is room the JavaScript
  engine keeps rather than memory it needs: it settles at 1.3-1.6 GB within
  twenty minutes of starting and was seen at up to 2.8 GB over ten hours. It
  sizes that room from the machine's memory, so it uses less on a smaller one.
- The database and the dashboard's files grow with use. On the measured
  deployment they held 1.4 GB and 1.3 GB after several months.

## What you run on it

Everything below comes on top of Polaris's own figure.

| What                         | Memory                                                    |
| ---------------------------- | --------------------------------------------------------- |
| Polar Code / agent session   | Up to 4 GB and 2 cores each by default (adjustable in Settings), up to 12 at once |
| Minecraft or other game server | 2-16 GB each, planned from its mods and players (the Memory card on its Settings) |
| Deployed apps and marketplace apps | Whatever each one uses; most small web apps need tens of MB |
| Builds of deployed apps      | Several GB of disk for build cache, and a burst of CPU and memory while one builds |

## Example: a home server with game servers

Add up what runs at the same time, not what is installed. A Java game server
uses its heap plus some of its own: measured, a Paper server with 1.5 GB of heap
held 1.8 GB, and a modded one with 4 GB held 3.6 GB once its world was loaded.
Count about 1.2 times the heap to be safe.

| Running at once                                      | Memory   |
| ---------------------------------------------------- | -------- |
| Polaris                                              | ~3 GB    |
| Four Minecraft servers with 1.5, 2.5, 4 and 8 GB of heap | ~19 GB |
| A dozen small deployed and marketplace apps          | ~0.5 GB  |
| One agent session                                    | up to 4 GB |
| **Total**                                            | **~27 GB** |

That fits 32 GB, with little left for the system's file cache. Servers that
sleep until someone joins only count while they are awake; a second agent
session, or every server awake at once with a build running, is where a 32 GB
machine runs out.

## Sizes

| Machine     | Memory | CPU     | Disk        | Good for |
| ----------- | ------ | ------- | ----------- | -------- |
| Minimum     | 4 GB   | 2 cores | 20 GB free  | Polaris and its apps for a household or a small team, a few light deployments |
| Recommended | 8 GB   | 4 cores | 50 GB free  | The above plus regular deployments and builds, calls, one agent session at a time |
| Comfortable | 16-32 GB | 8+ cores | 100 GB+ free, SSD | Several agent sessions or game servers at once, many deployed apps |

- An SSD matters more than the core count: the database and image pulls are
  disk-bound.
- Leave at least a quarter of the memory free for the system's file cache;
  Docker images, builds and the database all lean on it.
- Disk is what fills up first over time: images, build cache and volumes of
  deployed apps. Polaris's storage screen shows what each one takes and what
  is safe to remove.

## Operating system

Linux, with Ubuntu Server as the tested target, and Docker Engine with the
Compose v2 plugin. See the
[README](../README.md#requirements) for why Windows is not recommended as the
host.
