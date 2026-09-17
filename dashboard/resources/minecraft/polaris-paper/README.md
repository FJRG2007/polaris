# Polaris login for Paper, Purpur and Spigot

The same login as the NeoForge mod (`../polaris-neoforge`), as a plugin. It asks
every player for a password before they can do anything. The passwords are kept
by the Polaris that manages the server: the plugin asks Polaris on every join,
and a server that cannot reach Polaris lets nobody in.

Players use:

- `/register <password> <password>` on their first join
- `/login <password>` on every join after
- `/changepassword <old> <new>` once logged in

A password with spaces or symbols goes in double quotes.

Until they log in, a player's screen is dark with what to type in the middle of
it and a bar across the top counting down the 60 seconds they have. They cannot
move, chat, use other commands or be hurt. Before any of that, Polaris is asked
whether the name is on the server's player list. The lines Spigot and Paper
write for these three commands are kept out of the server log.

## Configuration

The same four variables as the mod, written by Polaris when the server's
join-password card switches it on. The plugin does nothing unless
`POLARIS_LOGIN` is `on`. With `online-mode=true` it asks for nothing.

## Building

The dashboard image builds it (`docker/Dockerfile`, stage `minecraft-plugins`)
and serves the jar at `/api/minecraft/mod/polaris-paper.jar`; servers download
it through `MODS`, which the image copies into the plugins folder. There is no
Gradle wrapper; with Gradle 9 and JDK 21 installed:

```sh
gradle build
```

It is compiled against the Spigot API of the oldest release it is offered on
(`gradle.properties`), and uses the shared sources in `../polaris-common`. The
image builds it with `-Pmod_version=<version>+<source fingerprint>`, so a server
that checked in with another version is shown as needing a restart.
