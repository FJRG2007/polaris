# Polaris login for NeoForge

A server-side mod that asks every player for a password before they can do
anything. The passwords are kept by the Polaris that manages the server, not by
the mod: it asks Polaris on every join, and a server that cannot reach Polaris
lets nobody in.

Players use:

- `/register <password> <password>` on their first join
- `/login <password>` on every join after
- `/changepassword <old> <new>` once logged in

A password with spaces or symbols goes in double quotes.

Until they log in, a player's screen is dark with what to type in the middle of
it and a bar across the top counting down the seconds they have left (red for the
last ten), and they cannot move, chat, use other commands or be hurt. Before any of
that, Polaris is asked whether the name is on the server's player list (and from
that network, when the list binds names to networks); a name that is not is
turned away before it can register.

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

With `online-mode=true` the mod asks for nothing: Mojang already checks who
players are.

## Building

The dashboard image builds it (`docker/Dockerfile`, stage `minecraft-mods`) and
serves the jar at `/api/minecraft/mod/polaris-neoforge-1.21.4.jar`. There is no
Gradle wrapper; with Gradle 9 and JDK 21 installed:

```sh
gradle build
```

The HTTP client and the environment reader live in `../polaris-common`, shared
with the Paper plugin (`../polaris-paper`). The jar lands in `build/libs/`. The
image builds it with
`-Pmod_version=<version>+<source fingerprint>`, so a server that checked in with
another version is shown as needing a restart. It is built for Minecraft 1.21.4 only, and the
dashboard offers it only there (`MOD_BUILDS` in
`apps/web/src/lib/apps/minecraft/polaris-login.ts`).
