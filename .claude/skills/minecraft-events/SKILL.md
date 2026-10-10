---
name: minecraft-events
description: Rules for creating, changing or fixing a Minecraft event in Game servers (catalog, kinds, arenas, stages, stash, prizes, the random draw, the Events tab and its editor). Use whenever a change touches dashboard/apps/game-servers/src/lib/minecraft/events/, the event screens (event-editor.tsx, event-options-*.tsx, minecraft-events.tsx), their messages, or their tests - adding a new event kind, adding an option or mode to one, tuning a kind's balance, or fixing an event bug reported from a server.
---

# Minecraft events

The rules live in `dashboard/docs/minecraft-events.md`. This skill is the
procedure that makes sure they are applied. Do not restate them here or in
the code. If a rule changes, change it in the doc.

## Before writing code

1. Read `dashboard/docs/minecraft-events.md` in full, including "Lessons from
   real servers". Each lesson is a bug that reached players.
2. If the change is a fix, find the earlier commits on the same kind or
   mechanism with `git log --oneline -- dashboard/apps/game-servers/src/lib/minecraft/events`.
   Read their bodies, so the fix does not undo an earlier one.

## While writing it

- A new kind: follow "Adding or changing a kind" step by step. The predicates
  listed in step 1 raise no compiler error when one is missed.
- A new or reshaped option: it has a default, and a saved event of the old
  shape still parses (`z.preprocess`) and plays as it did. A run already in
  progress keeps whatever it drew.
- Anything said to players: English and Spanish, in the shared palette,
  within `COMMAND_BYTES_MAX`. Anything on screen goes through
  `messages/{en-US,es-ES}/minecraft.json`, never a literal.
- Every command: run through the version gates, with both gamerule names, and
  safe on Paper/EssentialsX. Assume the server is a real one, with builds,
  beds, an island, a crowd, an old version and a restart in the middle - and
  possibly modded, with blocks nothing here knows (the `minecraft-servers`
  skill).
- A map or anything players move over: follow "Building a map" in the doc.
  It is laid out by a pure function from the run's id and checked against
  rules before it is built. Nothing past the next step can be reached
  (`parkour-layout.reaches`), the order is enforced in the game as well, and
  the generator is measured over thousands of seeds before it ships. A layout
  change bumps its design version.

## Before calling it done

1. Walk the run in your head as a real server would play it: the countdown,
   arrival, "Go!", the play, the end, a call-off, and a Polaris restart at each
   of those. For each step, check every section of "Lessons from real
   servers".
2. From `dashboard/apps/web`, run
   `npx vitest run test/apps/minecraft-events`, then `npx tsc --noEmit` and
   `npx vitest run test/i18n`. Add a test for the behavior you changed: pure
   commands in `minecraft-events-commands.test.ts`, a run against the fake
   server in `minecraft-events-run.test.ts`, the editor in
   `minecraft-events-screen.test.tsx`.
3. Update `dashboard/docs/minecraft-events.md`: the kind notes, the world
   requirements table, and a new lesson when the fix taught one. Name the
   commit in the lesson.
4. Say plainly what has not been played on a real Minecraft server. Docker
   does not run on the development machine, so the tests and the fake server
   are all the evidence there is.
