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
Welcome back, Aurora!"); nobody else, and nobody registering for the first
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

On Paper 1.21.7 and later (and the forks built on it), a joining player gets it
while their game is still connecting, next to the server's own pack, so the
resource reload happens behind the joining screen rather than on a second one
after they spawn. On Spigot and older Paper, or for a player who joined before
Polaris answered, it goes out on arrival as before. A pack that has not changed
is never sent again. A change does reach everybody already on, and reloads
their game once.

A player whose game has loaded it carries the `polaris_sounds` tag; the
dashboard plays the server's sounds on event moments to those players and the
game's own sounds to everybody else. The plugin also plays the arrival sound
(the server's, or a player's own) to everybody with the pack, and the welcome
sound to a player on their first visit (`polaris_seen`) once their pack has
loaded. A player who turns down a pack the server requires is disconnected.
Where the server requires its own resource pack (`require-resource-pack`), the
game disconnects a player who turns down any pack, so the sound pack is handed
out as required there too.

The owner can also put a sound on everyday moments, each played to the player
it happened to, the players within 48 blocks, or everybody (always only players
with the pack): a death (`PlayerDeathEvent`) and the kill behind it, a player
leaving, an advancement that shows a toast (`PlayerAdvancementDoneEvent`), the
Ender Dragon starting to die (`EnderDragonChangePhaseEvent`), the Wither's
death, and night falling and day breaking in the main world, read from its
clock once a second since the game has no event for it.

`polaris sounds status` answers one line of JSON: the pack's checksum and each
online player's state (`loaded`, `pending`, `declined`, `failed`).
`POLARIS_SOUNDS=off` switches it all off.

`polaris caps` answers `respawn`, and `polaris respawn set <key> <player>
<dimension> <x> <y> <z> <yaw>`, `list <key>` and `clear <key>` choose where a
player in an arena event comes back after a death: given to the respawn itself
(`PlayerRespawnEvent`, highest priority), never to their spawn point, so their
bed or anchor is untouched. Used only while they carry `pe_arena`; forgotten as
they leave the server or the event clears it (`EventRespawn`).

`polaris` is a console command (and so RCON); a player who runs it is refused.

## Seasonal decorations

Around Halloween some grass in the ground shows as a pumpkin or a jack
o'lantern and cobwebs hang under natural trees, gone from a player's game
before they can reach one (a web slows whoever is in it, and the server holds
air there); in winter snow falls round
players under the open sky and a thin layer lies on some grass. The dashboard
decides the season from Polaris's own dates and the server's time zone, and
says so with `polaris season set <halloween|winter> <seconds> [<spawns%> <golems%>]`
(repeated while it lasts) or `polaris season clear`; `polaris season status`
answers what is up. A season nobody repeats ends on its own when its seconds run
out.

### Seasonal mobs

Listed as the `season-mobs` capability; a jar without it is told the season
alone.

- Halloween: a zombie or skeleton spawning at night in the overworld usually
  wears a carved pumpkin or a jack o'lantern. It never drops it, and it comes
  off at sunrise so the mob still burns. With `<spawns%>` over 100 (the
  dashboard's default is 150), a natural night spawn of a monster may bring
  another of its kind to the same spot - never within 24 blocks of a player or
  where 24 monsters are already about.
- Halloween and winter: snow golems turn up 14-30 blocks from a player, two
  near each player at 100% of `<golems%>` (0 brings none). In winter it is
  somewhere cold enough to snow, some still wearing their pumpkin; through
  Halloween anywhere not hot enough to melt them (biome temperature under 1.0)
  and out of the rain, every one with its pumpkin on. They leave no snow trail
  and leave when no player is within 96 blocks.

Every mob this adds or dresses carries a tag (`polaris_season_head`,
`polaris_season_golem`). The season ending or changing takes the pumpkins off
and sends the golems away, and a chunk loaded out of season does the same, so
nothing is left behind.

Every block is sent to one player's game only and never set in the world, so
nothing is saved and a reloaded chunk shows the world as it is. Only natural
ground and leaves are used, never within reach of a build, and the dashboard
clears them while an event runs. Each chunk is decided from the world seed, so the
decorations stay put. A server's own switch is on its Settings tab.

### Halloween extras

Listed as the `season-halloween` capability, told with
`polaris season halloween key=value ...` (sent after the season line, while the
season is Halloween): witches on a natural night spawn, bat swarms at dusk,
treats from pumpkin-headed kills, a rare headless horseman, trap pumpkins,
one blood night, a trick-or-treat villager, phantoms, and small graveyards.
Each is its own key, so a jar skips a key it does not know instead of
refusing the whole line; a jar without the capability is told the season
alone. Every mob this adds carries `polaris_halloween`: it never comes back
from disk, and the season ending takes it away. Graveyards are the one part
written to the world (on wild grass, far from a build); they are written down
in the main world's folder with the moment the dashboard says the season
ends and come down only once it has passed, not on a restart or while an
event pauses the season - a chest somebody filled with their own things is
left standing. A server's own switches are on its Settings tab, next to the
rest of the season.

### Christmas and New Year's Eve

Listed as the `season-winter` capability and the same as the NeoForge mod's
(see its README for `polaris season winter key=value ...`): pumpkin snow
golems, reindeer, grumpy snowmen, more snow and tree lights on players'
screens, presents, Santa, elves, and the Christmas Eve and New Year's Eve
midnights. What must survive a restart - presents to take down, items an elf
holds, midnights already celebrated - is kept in the plugin's `winter.yml`.

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
