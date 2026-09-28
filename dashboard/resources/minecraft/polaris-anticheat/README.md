# Polaris anti-cheat

The anti-cheat Polaris installs on the Minecraft servers it runs: a plugin for
Paper, Purpur, Pufferfish, Leaf, Folia and Spigot, game versions 1.8 to the latest.
It simulates every player's movement and checks combat and packets against what the
game allows, on the network thread and compensating for each player's latency, and
hands its alerts to the Polaris running the server (`bridge/PolarisReporter`).

It is built into the dashboard image (`docker/Dockerfile`, stage
`minecraft-anticheat`) and switched on from a server's Anti-cheat tab
(`apps/game-servers/src/lib/minecraft/polaris-anticheat.ts`).

## Modules

- `api`, `internal`, `internal-shims`, `bukkit-internal` - the public API, storage
  and event plumbing. MIT licence (`api/LICENSE`).
- `common` - the checks, the movement simulation and the world replica.
- `bukkit` - the plugin for Bukkit-family servers.

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
