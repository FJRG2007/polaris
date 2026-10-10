# Symbiote for NeoForge 1.21.4

Symbiote: A Bonding Experience, by Arnau Guardiola. This folder is a port of the
mod's Forge 1.20.1 release (1.1.3) to NeoForge 1.21.4, rebuilt from that
release's jars.

The mod runs on both sides: a server that loads it needs every player to have the
same jar in their own game. Polaris builds it into the dashboard image
(`docker/Dockerfile`, stage `minecraft-symbiote`) and serves the one file for
both: the server downloads it through its `MODS` list, and players download it
from the server's Mods tab or get it with the mod pack command
(`apps/game-servers/src/lib/minecraft/symbiote.ts`).

Build locally with JDK 21:

```sh
./gradlew build --no-daemon
```

The jar lands in `build/libs/`.
