# Game servers - roadmap

## Polaris anti-cheat on every Minecraft server

Goal: the anti-cheat is on and works the same on any Java server Polaris runs,
whatever its software or release, with nothing for the owner to do. Where it
runs, it also takes over the game's flight check (`ALLOW_FLIGHT`, see
`polaris-anticheat.ts`), so nobody is kicked for "flying" by lag or a mod.

| Software | Releases | State |
|---|---|---|
| Paper, Purpur, Pufferfish, Leaf, Folia, Spigot | 1.17 to latest (plugin, Java 17) | Done |
| Paper and family | 1.8 to 1.16 (Java 8/11 images) | Planned: the plugin is built for Java 17 |
| NeoForge | 1.21.4 (inside the Polaris mod) | Done |
| NeoForge | Other releases | Planned |
| Forge | 1.20.1 (the engine's own mod) | Built; opt-in per server until it has run on a real modded server, then on by default |
| Forge | 1.19.2, 1.18.2, 1.16.5 next; 1.12.2 and older if the engine can run there | Planned |
| Fabric, Quilt | All | Planned |
| Hybrids that load plugins on a mod loader (Mohist, Arclight) | All | Planned: the plugin is kept off them today because it does not know modded movement |
| Bedrock | All | Not planned: no comparable packet access |

Each new build reuses the same engine (`resources/minecraft/polaris-anticheat`),
reads the server's modded blocks from its registries the way the NeoForge build
does, and is switched on by default for new and existing servers by the same
sweep (`game-anticheat-default`).
