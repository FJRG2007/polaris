# Minecraft events

How an event in Game servers is built, and the rules every kind follows. The
code is in `apps/game-servers/src/lib/minecraft/events/`: `catalog.ts` (what an
event is), `plan.ts` (when one starts, who counts), `commands.ts` (what the
server is told), `events-service.ts` (running one) and `kinds/` (each kind's
own play).

## Rules every event keeps

- **Nothing built is broken, and no item is lost.** Arenas, stages and anything
  an event places go only into air, and only what the event placed is removed.
  A player's own things are stashed in the database before they enter an arena
  and given back after; `keepInventory` is on for any event a player can die in.
- **Everything it changes is written down before it is changed** (game rules,
  the time of day) on the run, so whatever ends the event - its end, a call-off,
  a Polaris restart - puts back exactly that.
- **Every text a player reads** is in English and Spanish (`messages.ts`), each
  player reading their own (`speech.ts`). Nothing is shown to a player still at
  Polaris login's prompt.

## Where an event is held

- **On the ground** (supply drop, treasure, a boss without its sky arena): only
  on the world's own walkable ground, clear of every bed, never on a build.
- **In the air** (spleef, parkour, build battle, team duel, king of the hill,
  the boss's sky arena): only the air it takes counts. The highest thing in its
  footprint - a roof, a tree, the sea - is read with the `motion_blocking`
  heightmap, and the arena floats above it and below the build limit; its whole
  volume is proved empty before a block goes in. A build below is never a reason
  to look elsewhere.
- **Where it looks**: round a player in the Overworld (one in the Nether or the
  End is never the anchor, and is brought in like anybody when they join).
  After a few tries it comes in closer. With nobody in the Overworld it fails
  saying so; with nowhere free it says what stopped each try.

## World requirements

Each kind declares the time of day and the weather it needs in
`catalog.WORLD_NEEDS`. A new kind must add its entry; the test in
`test/apps/minecraft-events-rules.test.ts` fails for one that does not.

| Need | Why | What is held |
|---|---|---|
| Day | Builds and arenas can be seen; nothing spawns on them; no phantoms | `doDaylightCycle`/`advance_time` and `doInsomnia`/`spawn_phantoms` off, time set to 6000 |
| Night | The mobs it is about come out and do not burn (Horde defense, Mob hunt) | `doDaylightCycle`/`advance_time` off, time set to 18000 |
| Clear | No lightning on an arena, no thunderstorm mid-round (Build battle) | `doWeatherCycle`/`advance_weather` off, `weather clear` for the event's length |
| Rain | A blood moon's own storm (rain, never thunder) | as above, `weather rain` |

When the event ends the rules go back to what they were and the time of day is
set back to what it was when it started; the weather turns again from there.
Kinds that need neither (Mining rush, Fishing, Trivia, Happy hour, XP boost,
Rare catch) leave the world alone.

| Kind | Time | Weather |
|---|---|---|
| Build battle, Spleef, Parkour, King of the hill, Team duel | day | clear |
| Treasure hunt, Supply drop, Explorer, Gathering | day | clear |
| Horde defense, Mob hunt, Meteor shower | night | clear |
| Blood moon | night | rain |
| World boss | - | clear |
| Mining rush, Fishing, Trivia, Happy hour, XP boost, Rare catch | - | - |

## The random draw

`plan.decideRandom` decides, once a minute (`sweepEvents`):

1. Off, or an empty pool: nothing.
2. Not armed yet: armed one gap (`minGap`-`maxGap` minutes) from now.
3. Not due yet: waits.
4. Due, but outside its hours (default: any time of day), another event on, or
   somebody in a fight (damage dealt in the last 90 s, or in the End): waits and
   says which on the Events screen.
5. Due, but no event in the pool has the active players it needs: waits, saying
   how many. Once they come it settles for one more look (`SETTLE_MS`), so an
   event never lands on somebody who has only just joined.
6. Otherwise one is drawn by weight, never the same kind twice in a row when
   there is another; the next is a gap after it ends.

"Run a random event" on the screen draws one now among those whose conditions
hold, ignoring the hours, the gap and fights, and lists why the others were
left out.

## Kind notes

- **Build battle** needs three builders at the least, whatever the event's own
  minimum (`catalog.BUILD_BATTLE_FLOOR`): with two, each vote can only go to the
  other build. Each round is built in one material drawn for it
  (`build-battle.PALETTES`: glass, wool, concrete, terracotta, quartz and glass),
  said in the theme title and the chat; the brush breaks only that material.
- **World boss** health grows with every fighter:
  `effective = base x level.health x (1 + level.perFighter x (fighters - 1))`,
  with `level` Normal (1.25, 0.5), Hard (1.75, 0.65) or Epic (2.5, 0.8)
  (`boss.effectiveHealth`). Above the game's cap of 1024 the rest is carried as
  Resistance levels (`boss.splitHealth`). A fighter who arrives mid-fight raises
  it, keeping the share already lost (`boss.rescaled`).
