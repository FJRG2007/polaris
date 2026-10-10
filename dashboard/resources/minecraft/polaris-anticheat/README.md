# Polaris anti-cheat

The anti-cheat Polaris installs on the Minecraft servers it runs: a plugin for
Paper, Purpur, Pufferfish, Leaf, Folia and Spigot, game versions 1.8 to the latest,
and a mod for NeoForge 1.21.4.
It simulates every player's movement and checks combat and packets against what the
game allows, on the network thread and compensating for each player's latency, and
hands its alerts to the Polaris running the server (`bridge/PolarisReporter`).

It is built into the dashboard image (`docker/Dockerfile`, stage
`minecraft-anticheat`) and switched on from a server's Anti-cheat tab
(`apps/game-servers/src/lib/minecraft/polaris-anticheat.ts`). The NeoForge build is
not served on its own: it is nested inside the Polaris mod (`../polaris-neoforge`,
NeoForge's jar-in-jar), so a server that has that mod has the engine too. It runs
unless `POLARIS_ANTICHEAT` is `off`, and reports to Polaris while it is `on`.

## NeoForge

The `neoforge` module runs the same checks as the plugin, unchanged: the movement
simulation (flight, speed, ground spoof, phase, no-fall, elytra and vehicles) and
the packet checks. PacketEvents has no NeoForge platform, so
`platform/neoforge/packetevents` is its Fabric platform carried over (GPL-3.0, as
the files say); the one mixin it needs is optional, and if it does not apply the
engine logs that it is watching nobody and the server starts as usual.

A modded server's own blocks, items and entities are read from its registries when
it starts (`registry/NeoForgeRegistryBridge`):

- A modded block state that collides, slows and pushes exactly like a vanilla one
  (the same vanilla class with nothing movement-related overridden, or the same
  shape, friction, speed and jump factors and fluid) is simulated as that vanilla
  state.
- Any other - one with its own movement hooks (`entityInside`, `stepOn`, bouncing,
  climbing, custom friction), a shape that needs the world to compute, or nothing
  vanilla like it - is unmodelled: a player touching one is not predicted on that
  tick, rather than guessed at and flagged. Its count per mod and why is logged.
- Breaking a modded block, or with a modded tool, is not checked for speed.
- Modded entities are tracked as plain non-living entities, so reach is not
  checked against them.

If the server's vanilla content does not match what the engine expects, it stays
off on that server and says so. The engine's own anti-xray is off on NeoForge:
the Polaris mod has its own.

## Chat moderation

The bukkit module also holds the server's chat to the rules on its Moderation
tab in Polaris, cancelling `AsyncPlayerChatEvent` and the chat commands for a
line that breaks one. The engine is Polaris's own, shared with the NeoForge mod
and compiled in from `../polaris-common/src/chat` (the image copies it beside
this directory).

## Modules

- `api`, `internal`, `internal-shims`, `bukkit-internal` - the public API, storage
  and event plumbing. MIT licence (`api/LICENSE`).
- `common` - the checks, the movement simulation and the world replica.
- `bukkit` - the plugin for Bukkit-family servers.
- `neoforge` - the mod for NeoForge 1.21.4.

It depends on nothing outside this directory but open libraries from their own
repositories (PacketEvents, Adventure, Cloud and the like). Nothing it runs sends
anything to a third party: no update checks, no usage statistics, no log uploads -
a log is saved in the plugin's folder instead.

## Licence and origin

Everything outside the MIT modules is under the GNU General Public License v3.0
(`LICENSE`), because it is derived from an existing GPL-3.0 anti-cheat: its engine
was taken at upstream commit `8eb5f2809591c891deb4958bb2927844871e0600` (API at
`v1.6.0.12`) and modified by Polaris on 2026-09-28 and after - renamed, made to
build without that project's repositories, stripped of its outside services, and
extended with the Polaris bridge. The copyright and licence notices of its authors
are kept in the files that carry them, as the licences require. The rest of Polaris
keeps its own licence: this directory is built into its own jar and never linked
into the dashboard.
