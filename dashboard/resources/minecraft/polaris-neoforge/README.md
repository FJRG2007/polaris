# Polaris login for NeoForge

A server-side mod that asks every player for a password before they can do
anything. The passwords are kept by the Polaris that manages the server, not by
the mod: it asks Polaris on every join, and a server that cannot reach Polaris
lets nobody in.

Players use:

- `/register <password> <password>` on their first join
- `/login <password>` on every join after
- `/changepassword <old> <new>` once logged in

A password can have letters, digits and symbols; one with spaces goes in double
quotes.

Until they log in, a player's screen is dark with what to type in the middle of
it and a bar across the top counting down the seconds they have left (red for the
last ten), and they cannot move, chat, use other commands or be hurt. Before any of
that, Polaris is asked whether the name is on the server's player list (and from
that network, when the list binds names to networks); a name that is not is
turned away before it can register.

Nothing else of Polaris's reaches them while they wait: no challenge, event,
broadcast, chat-relay line or panel update is shown to them, and they are left
out of `{server.online}` and `{server.players}` until they are let in. The
server's own boss bars and side panel are taken off their screen too, whether
they were already up or go up while they wait, and come back exactly as they
were the moment they log in - a bar handed to everybody while they waited is
not handed out again, so it would otherwise never reach them. Other players'
chat still reaches them.

A player who logs in under a name linked to a Polaris account is welcomed by
that account's first or display name, in that account's language ("Logged in.
Welcome back, Javier!"); nobody else, and nobody registering for the first
time, gets more than the mod's own "Logged in. Welcome back!" or "Password set.
Welcome!".

## Anti-xray

The mod also sends every ore no player could see as the rock around it, so an
X-Ray client shows nothing buried: an ore (anything tagged `c:ores`, modded ones
included) whose six faces all touch blocks that render solid. Every block update
goes through the same test, so asking the server about a guessed position gets
rock back, and ore is sent for real the moment a block beside it stops covering
it. Polaris's X-Ray honeypots are left visible, and digging at buried ore is
reported to Polaris as `XRayProbe`. It runs unless `POLARIS_ANTIXRAY` is `off`,
whether or not the login is on; honeypots and reports need the login's address,
id and token. If this NeoForge build or another mod leaves out any of the code it
hooks into, the anti-xray stays off and the server starts as usual.

## Anti-cheat

The image nests Polaris's anti-cheat engine inside this jar as a mod of its own
(`polarisac`, from `../polaris-anticheat`, GPL-3.0; NeoForge loads it from
`META-INF/jarjar`). It simulates every player's movement and checks what they
send, and reports to Polaris through the same address, id and token. It runs
unless `POLARIS_ANTICHEAT` is `off`. See `../polaris-anticheat/README.md`.

## Chat moderation

Wherever Polaris has written its address, id and token (for the login or for the
anti-cheat), the mod holds the chat to the rules on the server's Moderation tab:
it asks Polaris for them every 30 seconds and cancels a `ServerChatEvent` that
breaks one (another server's address, flooding, the same line again, links,
shouting, a blocked word), and does the same for the text of `/msg`, `/tell`,
`/w`, `/me`, `/say` and `/teammsg`. Operators are left alone. Each stopped line
is reported to Polaris, which keeps it for the tab, answers with the warning
the player is shown in their own language, and times the player out after
repeats. The engine is shared with the anti-cheat plugin
(`../polaris-common/src/chat`).

Messages the server or other mods send to players are not filtered: there is no
event for them, and a filter on the outgoing packet would have to judge command
output, death messages and every mod's feedback too.

## Custom sounds

Wherever Polaris has written its address, id and token, the mod hands the
server's own sounds (uploaded on its Sounds tab) to its players without a
restart. It asks `GET /api/minecraft/sounds/<id>` when the server starts and
again on `polaris sounds refresh`, which the dashboard runs after every change,
and pushes the resource pack Polaris built to everybody on and everybody who
joins. The pack goes under an id of its own, derived from the server's, so it
stacks on the server's own resource pack instead of replacing it, and a newer
one replaces the last.

A player whose game has loaded it carries the `polaris_sounds` tag; the
dashboard plays the server's sounds on event moments to those players and the
game's own sounds to everybody else. The mod also plays the arrival sound
(the server's, or a player's own) to everybody with the pack, and the welcome
sound to a player on their first visit (`polaris_seen`) once their pack has
loaded. A player who turns down a pack the server requires is disconnected.

`polaris sounds status` answers one line of JSON: the pack's checksum and each
online player's state (`loaded`, `pending`, `declined`, `failed`).
`POLARIS_SOUNDS=off` switches it all off.

## Event commands

Always registered, idle until the dashboard runs one. Console and operators only
(permission level 4); each answers one line of JSON.

- `polaris caps` (or `polaris capabilities`): the mod's version and what this
  server can do (`stash`, `batch`, `seek`). The dashboard uses a command only when
  it is listed here, and keeps its plain-command path otherwise.
- `polaris stash save|restore <player> <key>`: a player's 41 slots (never the
  ender chest or the event kit), experience, health, hunger and effects, to
  `world/polaris/stash/<key>.dat` and back, each in one tick. Idempotent per key;
  crash-safe through a mark saved in the player file (`EventStash`).
- `polaris batch run <key> [blocksPerTick]`, `status <key>`, `cancel <key>`: runs
  the commands appended to `storage polaris:batch <key>` over as many ticks as
  it takes, under a block cap (8192 by default) and a 15 ms slice of each tick.
  The commands run at permission level 2, the level that can write that storage.
- Hide and seek: while players carry `pe_hider` and `pe_seeker` (or sit in the
  `pe_hs_hide` and `pe_hs_seek` teams), a hider is not
  sent to a seeker farther than 2 blocks without a line of sight (`EventSeek`).
- In the air: a player carrying `pe_in` or `pe_arena` (inside an event) is
  never kicked for floating, so a dropper's slow fall, a racer put back mid-air
  or an arena's slow-falling drop is not a disconnect. Everybody else keeps the
  game's own rule, so `allow-flight` stays off (`FloatingKickMixin`).

## Configuration

Polaris writes these when the server's join-password card switches the mod on.
The login does nothing unless `POLARIS_LOGIN` is `on`.

| Variable               | Meaning                           |
| ---------------------- | --------------------------------- |
| `POLARIS_LOGIN`        | `on` to ask for passwords         |
| `POLARIS_URL`          | The Polaris the server asks       |
| `POLARIS_SERVER_ID`    | This server's id in Polaris       |
| `POLARIS_SERVER_TOKEN` | What the server proves it is with |
| `POLARIS_ANTIXRAY`     | `off` to stop hiding buried ore   |
| `POLARIS_ANTICHEAT`    | `off` to stop the anti-cheat      |
| `POLARIS_SOUNDS`       | `off` to stop the custom sounds   |

With `online-mode=true` the mod asks for nothing: Mojang already checks who
players are.

## Building

The dashboard image builds it (`docker/Dockerfile`, stage `minecraft-mods`) and
serves the jar at `/api/minecraft/mod/polaris-neoforge-1.21.4.jar`. There is no
Gradle wrapper; with Gradle 9 and JDK 21 installed:

```sh
gradle build
```

That is the login mod alone. With the anti-cheat nested, build its NeoForge jar
first (`gradle :neoforge:shadowJar` in `../polaris-anticheat`) and pass it:

```sh
gradle build -Panticheat_jar=../polaris-anticheat/neoforge/build/libs/polaris-anticheat-neoforge-1.21.4.jar
```

The HTTP client and the environment reader live in `../polaris-common`, shared
with the Paper plugin (`../polaris-paper`). The jar lands in `build/libs/`. The
image builds it with
`-Pmod_version=<version>+<source fingerprint>`, so a server that checked in with
another version is shown as needing a restart. It is built for Minecraft 1.21.4 only, and the
dashboard offers it only there (`MOD_BUILDS` in
`apps/web/src/lib/apps/minecraft/polaris-login.ts`).
