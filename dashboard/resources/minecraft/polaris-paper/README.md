# Polaris login for Paper, Purpur and Spigot

The same login as the NeoForge mod (`../polaris-neoforge`), as a plugin. It asks
every player for a password before they can do anything. The passwords are kept
by the Polaris that manages the server: the plugin asks Polaris on every join,
and a server that cannot reach Polaris lets nobody in.

Players use:

- `/register <password> <password>` on their first join
- `/login <password>` on every join after
- `/changepassword <old> <new>` once logged in

A password can have letters, digits and symbols; one with spaces goes in double
quotes.

Until they log in, a player's screen is dark with what to type in the middle of
it and a bar across the top counting down the 60 seconds they have. They cannot
move, chat, use other commands or be hurt. Before any of that, Polaris is asked
whether the name is on the server's player list. The lines Spigot and Paper
write for these three commands are kept out of the server log.

Nothing else of Polaris's reaches them while they wait: no challenge, event,
broadcast, chat-relay line or panel update is shown to them, and they are left
out of `{server.online}` and `{server.players}` until they are let in. The
server's own boss bars and side panel are taken off their screen too, whether
they were already up or go up while they wait, and come back exactly as they
were the moment they log in. Unlike the NeoForge mod, other players' chat does
not reach them either, since Paper hands a plugin the recipient list to filter
rather than a signed chain a client would disconnect over a gap in.

A player who logs in under a name linked to a Polaris account is welcomed by
that account's first or display name, in that account's language ("Logged in.
Welcome back, Javier!"); nobody else, and nobody registering for the first
time, gets more than the plugin's own "Logged in. Welcome back!" or "Password
set. Welcome!".

## Custom sounds

Wherever Polaris has written its address, id and token, the plugin hands the
server's own sounds (uploaded on its Sounds tab) to its players without a
restart. It asks `GET /api/minecraft/sounds/<id>` when the server starts and
again on `polaris sounds refresh`, which the dashboard runs after every change,
and pushes the resource pack Polaris built to everybody on and everybody who
joins. The pack goes under an id of its own, derived from the server's, so it
stacks on the server's own resource pack instead of replacing it, and a newer
one replaces the last.

A player whose game has loaded it carries the `polaris_sounds` tag; the
dashboard plays the server's sounds on event moments to those players and the
game's own sounds to everybody else. The plugin also plays the arrival sound
(the server's, or a player's own) to everybody with the pack, and the welcome
sound to a player on their first visit (`polaris_seen`) once their pack has
loaded. A player who turns down a pack the server requires is disconnected.
Where the server requires its own resource pack (`require-resource-pack`), the
game disconnects a player who turns down any pack, so the sound pack is handed
out as required there too.

`polaris sounds status` answers one line of JSON: the pack's checksum and each
online player's state (`loaded`, `pending`, `declined`, `failed`).
`POLARIS_SOUNDS=off` switches it all off.

`polaris` is a console command (and so RCON); a player who runs it is refused.

## Configuration

The same four variables as the mod, written by Polaris when the server's
join-password card switches it on. The plugin does nothing unless
`POLARIS_LOGIN` is `on`. With `online-mode=true` it asks for nothing.

The custom sounds need only the address, id and token, so Polaris installs the
plugin for them alone too, with `POLARIS_SOUNDS=on` to keep it on the server's
list while the login is off.

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
