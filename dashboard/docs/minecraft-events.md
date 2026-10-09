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
  and given back after, with the health and hunger they came in with;
  `keepInventory` is on for any event a player can die in.
- **Everything it changes is written down before it is changed** (game rules,
  the time of day) on the run, so whatever ends the event - its end, a call-off,
  a Polaris restart - puts back exactly that.
- **Every text a player reads** is in English and Spanish (`messages.ts`), each
  player reading their own (`speech.ts`). Nothing is shown to a player still at
  Polaris login's prompt.

## Adding or changing a kind

The compiler finds most of a missing kind, because every per-kind table is a
`Record<EventKind, ...>`. What it cannot find is listed here; do every step in
the same change.

1. **`catalog.ts`**: add it to `EVENT_KINDS`, then fill every table the
   compiler asks for - `optionsSchemas`, `KIND_NAMES`, `KIND_INFO`,
   `DEFAULT_PRIZES`, `DEFAULT_MINUTES`, `DEFAULT_MIN_SCORE`, `WORLD_NEEDS`.
   Then look at each predicate below and decide whether the kind belongs in
   it, because no compiler error tells you: `needsOverworld`,
   `needsHostileMobs`, `summonsMobs`, `needsPvp`, `afkCounts`, `takesJoiners`,
   `playsOnStage`, `playsInArena`, `keepsDay`, `defaultMinPlayers`,
   `joinersNeeded`, `awardsPrizes`. A kind that is neither `playsOnStage` nor
   `playsInArena` and is held at a place on the ground also needs its own case
   in `heldWhere`'s switch (see "Where an event is held"), or the Events
   screen groups it as `anywhere` by default. Also add it to `KIND_SINCE` with
   the current `DEFAULTS_VERSION` and bump that version: a kind missing from
   `KIND_SINCE` reads as having always existed, so a server that saved its
   events before the kind shipped never gets it (see "Options" below).
2. **Options**: every field has a `.default()`, so an event saved before the
   field existed still parses. Renaming or reshaping a field needs a
   `z.preprocess` that reads the old shape (`legacyWorldBoss`,
   `legacySpleef`, `legacyParkour`). A changed default needs `migratePreset`,
   a bump of `DEFAULTS_VERSION`, or - when only the values on the old default
   should move, and anything already chosen must keep it - a `z.preprocess`
   of its own (`legacyParkour`'s jumps); never a silent change to saved
   events. A preset that stops parsing is repaired, not dropped
   (`repairPreset`). A run already under way keeps its own copy of its
   preset as it began (`asBegun` in `state.ts`): a migration that changes an
   option's default must not also reach into a race in progress. A kind
   added after a server already saved its events is a different case from a
   changed option: `readEventsConfig` gives that server one of each kind
   listed in `KIND_SINCE` at a later version than it last saved (`default-`
   prefixed, named in the player's language), joins it to the random draw
   only where the draw already held every event the server had, and never
   gives back more than `eventsConfigSchema`'s own limits allow
   (`EVENTS_AT_MOST` presets, `POOL_AT_MOST` in the pool) so the backfill
   itself cannot fail to save. Saving once writes the new `DEFAULTS_VERSION`
   down, so a backfilled kind the operator deletes afterwards stays deleted.
3. **Pure and service code are kept apart**: `kinds/<kind>.ts` builds the
   commands and does the maths with no I/O, so it can be asserted in
   `minecraft-events-commands.test.ts`. `kinds/<kind>-service.ts` (or
   `events-service.ts`) runs them, tested in `minecraft-events-run.test.ts`
   against the fake server.
4. **Words**: what players read goes in `messages.ts`, in English and Spanish
   (`RULES` included), using the shared `PALETTE`. What the panel shows goes
   in `messages/{en-US,es-ES}/minecraft.json` under `events.kinds.<kind>`
   (`label`, `summary`, `unit`) and `editor.*`. Every line has to fit
   `COMMAND_BYTES_MAX` (1014 bytes) in both languages.
5. **Editor**: put the kind's fields in `event-editor.tsx`, or group them with
   kinds held the same way: `event-options-sky.tsx` for one played on a stage
   or an arena, `event-options-anywhere.tsx` for one played on the ground or
   wherever players are, `event-options-arena.tsx` for the older team duel and
   build battle - each reusing `event-editor.tsx`'s shared `Field`,
   `PlaceField`, `options`, `numberOf` and `problemAt`. A kind large enough on
   its own still gets an `event-options-<kind>.tsx` of its own (`gathering`,
   `rare-catch`, `treasure-hunt`, `world-boss`, `xp-boost`). Add a screen test
   that saves the defaults and one changed value.
6. **Docs**: add the kind to the world-requirements table and a note under
   "Kind notes" whenever it does something a reader would not guess.

Before calling the kind done, play it through on a real server in your head,
step by step, against every section of "Lessons from real servers" below. Each
lesson is a bug that reached a player.

## Where an event is held

- **On the ground** (supply drop, treasure, a boss without its sky arena): only
  on the world's own walkable ground, clear of every bed, never on a build.
- **In the air** (spleef, parkour, build battle, team duel, king of the ring,
  the boss's sky arena): only the air it takes counts. The highest thing in its
  footprint - a roof, a tree, the sea - is read with the `motion_blocking`
  heightmap, and the arena floats above it and below the build limit; its whole
  volume is proved empty before a block goes in. A build below is never a reason
  to look elsewhere.
- **Where it looks**: round a player in the Overworld (one in the Nether or the
  End is never the anchor, and is brought in like anybody when they join).
  After a few tries it comes in closer. With nobody in the Overworld it fails
  saying so; with nowhere free it says what stopped each try.
- **The Events screen groups every kind by where it is played**
  (`catalog.heldWhere`, `HELD_WHERE`: `sky`, `world`, `anywhere`), both the new
  event's kind picker and the saved list: `sky` for anything `playsOnStage` or
  `playsInArena`, and a world boss with its own sky arena switched on; `world`
  for a kind held at a place found on the ground - supply drop, king of the
  ring played on the ground, treasure hunt, horde defense, meteor shower,
  villager defense, and an explorer set to race; `anywhere` - the default for
  everything else - for a kind that moves nobody and builds nothing: mining
  rush, mob hunt, blood moon, fishing, trivia, happy hour, gathering, rare
  catch, XP boost, bingo rush, boss fishing, and an explorer not racing.

## World requirements

Each kind declares the time of day and the weather it needs in
`catalog.WORLD_NEEDS`. A new kind must add its entry; the test in
`test/apps/minecraft-events-rules.test.ts` fails for one that does not.

| Need  | Why                                                                     | What is held                                                                             |
| ----- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Day   | Builds and arenas can be seen; nothing spawns on them; no phantoms      | `doDaylightCycle`/`advance_time` and `doInsomnia`/`spawn_phantoms` off, time set to 6000 |
| Night | The mobs it is about come out and do not burn (Horde defense, Mob hunt) | `doDaylightCycle`/`advance_time` off, time set to 18000                                  |
| Clear | No lightning on an arena, no thunderstorm mid-round (Build battle)      | `doWeatherCycle`/`advance_weather` off, `weather clear` for the event's length           |
| Rain  | A blood moon's own storm (rain, never thunder)                          | as above, `weather rain`                                                                 |

When the event ends the rules go back to what they were and the time of day is
set back to what it was when it started; the weather turns again from there.
Kinds that need neither (Mining rush, Fishing, Trivia, Happy hour, XP boost,
Rare catch, Bingo rush, Boss fishing) leave the world alone.

| Kind                                                           | Time  | Weather |
| -------------------------------------------------------------- | ----- | ------- |
| Build battle, Spleef, Parkour, King of the ring, Team duel     | day   | clear   |
| Capture the flag                                               | day   | clear   |
| Hot potato                                                     | day   | clear   |
| Hide and seek                                                  | day   | clear   |
| SkyWars                                                        | day   | clear   |
| TNT run, Dropper, Ice boat race, Nether maze                   | day   | clear   |
| Elytra race                                                    | day   | clear   |
| Acid rain                                                      | day   | -       |
| Treasure hunt, Supply drop, Explorer, Gathering                | day   | clear   |
| Horde defense, Villager defense, Mob hunt, Meteor shower       | night | clear   |
| Blood moon                                                     | night | rain    |
| World boss                                                     | -     | clear   |
| Mining rush, Fishing, Trivia, Happy hour, XP boost, Rare catch | -     | -       |
| Bingo rush, Boss fishing                                       | -     | -       |
| Acid rain                                                      | day   | -       |

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
  (`build-battle.PALETTES`: glass, wool, concrete, terracotta and quartz),
  said in the theme title and the chat; the brush breaks only that material.
- **Meteor shower** craters are infected by default (`infection`): sculk veins
  grow round each one and creep outwards (`meteor-infection.ts`). A vein goes
  only into air over the game's own ground (`#minecraft:sculk_replaceable`)
  with `setblock ... keep`, and only one the game answers it changed is kept.
  Bounded: six cells tried a tick over every meteor together, taken in turn,
  at most 40 a meteor, never further than 7 blocks out. Standing in one poisons
  and slows; breaking it cleanses the ground, and that cell is never touched
  again. At the end each cell is cleared only while it is still a vein. From
  1.19; older servers get plain craters.
- **World boss** health grows with every fighter:
  `effective = base x level.health x (1 + level.perFighter x (fighters - 1))`,
  with `level` Normal (1.25, 0.5), Hard (1.75, 0.65) or Epic (2.5, 0.8)
  (`boss.effectiveHealth`). Above the game's cap of 1024 the rest is carried as
  Resistance levels (`boss.splitHealth`). A fighter who arrives mid-fight raises
  it, keeping the share already lost (`boss.rescaled`).
- **Spleef** is three floors of snow stacked `LAYER_GAP` apart, each walled in
  its own color, a net under the lowest; a player is out only through the
  lowest. Each run is played one way, drawn among those switched on in the
  editor (`variants`, all three by default): shovels (break the snow), a
  vanishing floor (the snow underfoot turns red, then goes on the next look -
  Fall Guys' Hex-A-Gone), or snowballs (each one breaks the snow it hits).
- **TNT run** is spleef's arena with TNT for snow and no tool: `layers` floors
  (2-4) `LAYER_GAP` apart, one wall round all of them - a colored concrete rim
  at each floor's height, lit at the corners, clear glass between - so the only
  ledge anywhere is TNT, and a net under the lowest. A block a player stands on
  goes `tnt-run.FUSE_TICKS` (8, two fifths of a second) after they stepped on
  it: the events data pack lights a fuse (an invisible marker stand with a
  count) under each corner of every player's feet each tick, and sets the
  block to air when it runs out, only if it is still TNT. Nothing primes TNT
  here: blocks only ever go to air, nothing in the arena is fire or redstone,
  the weather is held clear, players come in empty-handed (from 1.17) and in
  adventure mode, and any TNT lit in or near the arena anyway (a flaming arrow
  from the ground) is taken out by the pack the tick it appears, and over RCON
  every tick as well. The pack goes on before anything is built; a server
  where it cannot is called off, never left with a floor that does not go.
  Scored as spleef: by the order players went out - and the pack notes the
  game tick each racer first goes under the lowest floor, so those out on
  one look go out in that order (`tnt-run.fallOrder`), and when the last
  ones standing all fell within one look, the one who fell alone and last
  is the winner rather than nobody.
- **Dropper** is a shaft 11 blocks across, walled all round, `levels` floors
  (5-20) each with one hole, a pool at the bottom, laid out from the run's id
  (`dropper.plan`). Everybody waits on a glass lid; at "Go!" all of them are
  put over the middle, the lid goes, and they fall. The events data pack
  catches a landing the tick it happens - anybody racing who is on the ground
  anywhere over the floors, the rim of a hole included, goes back to the top,
  once (`dropper.SENT_TAG`, see "Players" under the lessons) - and notes the
  lowest each racer has been and the tick they reach the water. The spot they
  are let fall from, a block over where the lid was, is never a landing
  either: with it inside the landing box a racer put there was sent back to it
  every tick, held in mid-air until the server kicked them for floating. Two
  who reach the water in one look are told their places by those ticks.
  Ranked by finish time, then by the deepest floor. It is played under Slow
  Falling: in a free fall a player is past three blocks a tick within seven
  seconds and can steer a tenth of a block between two floors, so holes that do
  not line up could not be reached in any shaft that fits under the build limit
  (twenty floors would need over five hundred blocks). Its water is built last
  and taken out first, and nothing built before a box that would not come out
  is taken out after it, so the walls never go from round the water.
- **Ice boat race** (`boat-race`) is one closed loop of packed ice, `WIDTH`
  (5) across, walled two blocks high on both sides, laid out from the run's id
  (`boat-race.track`), with gates (blue ice lines under an arch, the start
  chequered) to pass in order, `laps` times. At "Go!" every racer is put on
  the grid behind the start line and, from 1.19.4, in a boat (`ride`; an
  `oak_boat` entity from 1.21.2, a `boat` of type oak before); before 1.19.4
  they are handed a marked boat to put down, topped up whenever they have none
  and are in none. The events data pack counts a gate only straight after the
  one before and marks anybody seen at another (but the last one passed) once
  over the start line; the quick look sends whoever fell, cut a corner or (with
  `ride`) left their boat back to their last gate in a new one, one racer a
  look at a time so two never share a boat, and takes away the boats nobody
  is in. Ranked by finish time, then by gates passed. Its boats - summoned or
  put down - go with the track. A racer who leaves a race already on and
  joins it again comes back at the last gate they passed, with every pass
  they made (`boat-race.resumeSpot`, `racerScores`); their clock never
  stopped. Somebody past the four boats one quick look hands out is seated
  on the next without being told they left theirs.
- **Deadly nether maze** (`nether-maze`) is a roofed maze of netherrack, 7, 11
  or 15 rooms a side, carved from the run's id with hide and seek's carver
  (`nether-maze.plan`, `seek-maze.carve`). Racers wait in a room outside its
  wall behind a glass door that goes at "Go!"; the first into the lit room in
  the middle wins, then whoever got most rooms closer. Fire on netherrack,
  magma and one-block lava pits across doorways are watched by the events data
  pack every tick: touching one sends the racer back to the starting room's
  stand (nobody is hurt - Resistance V and Fire Resistance as on every stage).
  `mazeProblems` holds every plan to: walls at least two blocks thick, a solid
  roof over every column, no hazard at the goal or by the start, lava one block
  across, and every safe block reachable from the start stepping on safe blocks
  or jumping one lava block (tested over thousands of runs, and walked again
  over the built blocks). Xaero's fair-play code (`radar.ts`) turns minimap cave
  view and radar off for each racer as they come in and again when they come
  back on; the reset goes with them home. An X-ray resource pack still shows
  the corridors: Polaris's anti-xray hides ores, never air.
- **Acid rain** (`acid-rain`) is a walled square of mossy stone, 17, 23 or 29
  blocks a side, open to the sky but for an invisible barrier roof, with a few
  ruined cobblestone huts placed from the run's id. The rain is the event's
  own: particles over the arena, and the events data pack looks every half
  second at the blocks over each player's head - with nothing there but air
  and the barrier, their acid bar fills (`pe_acid`); full, they are out. The
  world's weather is never changed. Everybody gets marked cobblestone that
  goes only on the arena's floor and shelters (`can_place_on` / `CanPlaceOn`),
  16 at "Go!" and 8 more every 40 seconds. Each look of the main tick scatters
  a few invisible stands with `spreadplayers ... under` onto the highest block
  under the roof, and that block moves one step: cobblestone, mossy
  cobblestone, lime glass, air - never the floor or the walls. The last one in
  wins; at the end of the time, the driest. What players placed and what the
  rain left is taken out by sweep boxes over the inside, written down at "Go!".
  Needs 1.17, for `spreadplayers ... under`.
- **Elytra race** (`elytra-race`) is a loop of rings in the sky, 40 to 80
  blocks over the ground, taken from an ice boat race's track
  (`boat-race.laidOut`): rings over its points, each facing one of the four ways,
  chosen so that the straight line from every ring to the next crosses both
  squarely (`elytra-race.SQUARE`, at most 60 degrees off), climbs at most a
  quarter of its length, and passes no other frame or pillar. A track no rings
  fit is drawn again, then the plain one. Racers wait on a glass pad behind the
  start ring; at "Go!" its floor goes, and each wears a marked, unbreakable
  elytra and holds three marked rockets. A ring passed gives one more rocket, a
  yellow glass booster on each leg two; the quick look hands them out one at a
  time and puts back behind their last ring whoever fell under the course,
  landed, or flew a ring out of turn. Laps and checkpoints are counted by the
  events data pack, as in the boat race. The wings and rockets are taken back
  at the end, on leaving and on coming back. Needs 1.17, to put the elytra on.
- **King of the ring** (`king-of-the-hill` in code and saved settings; it was
  called King of the hill before it moved into the air) with fists only is a
  platform floating `hill.LIFT` over whatever is under it. Off the ring Poison
  wears a player down, only while they have more than three hearts; in it
  Regeneration mends them; Resistance IV makes a punch a fifth of one and
  keeps its knockback; a fall off the platform is slow, so nobody can die.
  Walked to (fists only off), it stays on the ground and none of what follows
  applies.
- **The ring** (`hill.ringAt`) is worked out from the run's id and the time
  since "Go!" alone, so a restart puts it back where it was:
    - The game is split into `rounds` (1-5, three by default). Each starts with
      the ring whole, in the middle, everybody on their own start spot
      `hill.START_MARGIN` inside its edge (`hill.startSpots`); from the second
      on, `RING_PAUSE_SECONDS` of nothing counted first. It neither shrinks
      nor moves for `GRACE_SECONDS` after "Go!" or after the pause.
    - It shrinks a block at a time (`shrinks`) to `hill.leastRadius`: enough
      ground for `ROOM_EACH` blocks a player, never under `LEAST_RADIUS` (2),
      never over its own radius. Two players fight over a ring of two, sixteen
      over one of four. It is at its smallest when the round's double points
      start.
    - It drifts a block every `MOVE_SECONDS` (`moves`) toward points drawn from
      the run's id, never past `MARGIN - 1` beyond its first edge, so it stays
      on the platform's own floor.
    - The last `SPRINT_SECONDS` of a round (at most a third of it) count double.
    - Time in it counts for everybody in it, and `hill.ALONE_TIMES` (three)
      times over for whoever is in it alone (`hill.scoreLines`, counted in the
      game in the same tick, the same four lines however many play).
    - The one alone at the top glows and wears a golden helmet marked as the
      event's kit (from 1.17, where their head was emptied on the way in), taken
      back from whoever falls behind and at the end with the rest.
    - The ring drawn on the floor is repainted as it moves: the floor's own
      block over its own ring block and back, inside the platform's box, never
      anything else (`hill.redrawLines`; `keptTheRules` in the run tests allows
      exactly that).
- **Villager defense** is a horde defense (`kinds/waves`, `hordeDefense`)
  played round a villager set down at the point: the same place search,
  wave timing, sizes by defenders, gear and counts of who held the point.
    - The villager is summoned with `NoAI` (it stands on its spot, is pushed
      by nothing and is still hit by whatever reaches it - a pen would be
      blocks built into the world to take down again), persistent, named from
      the run's id, glowing, and tagged `pe_villager` - never `pe_mob`, which
      counts the wave. It is written down on the run before it is summoned,
      and a restart in between looks for it before summoning another.
    - Only monsters that hunt villagers in vanilla come
      (`village-defense.VILLAGE_MOBS`): zombies, husks and zombie villagers,
      vindicators and pillagers; never a skeleton, a stray, a spider or a
      witch, which ignore villagers. Each still goes for a player it sees
      first, so from 1.21 the wave is turned on the villager: every monster
      no defender stands next to is touched by the villager with `/damage`
      (`generic`), and a mob keeps whoever last hurt it (any type but
      `#no_anger`) as the one it goes for. Striking it draws it off again.
      `generic` pushes nothing back only since it joined `#no_knockback` in
      1.21 (24w18a): on 1.19.4-1.20.6 every touch would knock the wave away
      from the villager, so there, and before 1.19.4 (no `/damage`), it is
      left to vanilla's aim and they go for the villager only when no player
      is in sight (`LURE_SINCE`).
    - Its health is the boss bar (red), with where the waves stand beside it;
      everybody is told once under half and once under a quarter.
    - Missing for two looks in a row (`LOST_AFTER`: a restarted server loads
      entities a moment after their chunks), it is dead: the event ends there,
      with no podium and no prizes, and the results say why. A look that
      cannot read its health shows the health read last, never a healed one.
      Otherwise the waves play out and the podium goes to the most kills.
    - Kills - here and in a horde defense - are counted by the events data
      pack where it goes on (`run.killsByPack`): an advancement on a kill of a
      monster tagged `pe_wfight`, so only what the event summoned to fight
      counts - never the night's own, nor a jockey's chicken or horse. The
      game's `killed` statistics, the fallback, count the night's own zombies
      killed near the point as well.
    - The end, a call-off or a restart kills exactly what carries the tag, and
      the zombie villager a zombie on Normal or Hard turns a villager into,
      where it stood.
- **Bingo rush** is one card of nine items (three by three) for everybody,
  drawn from the run's id (`bingo.drawCard`), so a restart finds the same
  card. It is drawn from pools by difficulty (`bingo.POOLS`, `MAKEUP`): an easy
  card is nine things found in the first minutes; a medium one four of those
  and five that take a cave or a farm; a hard one two easy, three medium and
  four hard, at least two of them only the Nether has. Every item carries the
  version that added it and the card skips what the server does not have (an
  unread version gets only what every version has); nine different items,
  never one a statistic cannot see come in (a bucket filled in the hand).
    - An item is marked the first time it is seen in a player's inventory
      (`clear <player> <item> 0`, as a gathering reads one) - once the game's
      own statistics say they came by one since the start: picked up (less
      what they dropped), crafted, smelted or traded for. Smelted and traded
      count as the game counts them, as crafted, taken from the furnace's or
      the villager's result slot by hand: what a hopper pulls out of a
      furnace has no statistic, and marks nothing. A stack carried in or
      taken out of their own chest marks nothing. It is all worked out in
      the game, every player in one batch a look, and kept on the scoreboard
      (`pe_bg*`), so a restart finds the marks; a mark is never taken back.
    - The card is shown to everybody at the start, each item named by the
      game in the reader's own language (`block.minecraft.*`,
      `item.minecraft.*`); each mark is told to its player with their card,
      their count and what is left are on their action bar, and the side
      panel shows everybody's count.
    - `goal`: the first full row, column or diagonal (`line`), or the whole
      card (`card`), ends it and wins, whatever the least to be ranked;
      nobody seen in creative or spectator can - looked for on every one of
      the rush's own looks, not only the run's fifteen-second sample, since
      crafting in creative raises the statistic a card is marked by. Two in the same look: the
      most marked, then the name. With time up, the most marked win (the
      least to be ranked applies), a tie to whoever got there first.
- **Boss fishing** is a legendary fish on everybody's line, its strength on
  the boss bar (blue): `catches` for each active player as it starts
  (`boss-fishing.hooked`), and as many more for each one who starts playing
  later, keeping what was already taken off it (`grown`, as a boss's
  `toppedUp`). A player AFK from the start is not one it is sized for.
    - A fish takes one off: the fishing contest's own `fish_caught`, which the
      game counts only for fish. A treasure takes `TREASURE_WORTH` (3): read
      the way a rare catch reads one (a fishing treasure picked up, less any
      dropped, within a few looks of reeling in), since no statistic has it.
      The count a catch is measured from is the most a player has had
      (`rare-catch.catchCommit`), so a treasure dropped and picked up again
      on a later look is never a new catch.
      Junk counts for nothing. Each player's catches are the side panel.
    - Catches by anybody AFK from the start or seen in creative or spectator
      take nothing off it, and keep them off the podium (`afkCounts`). What a
      player caught is kept on the run, so logging off loses none of it.
    - A catch made while AFK never counts, whoever made it: each reading,
      what an AFK player (still for the server's AFK minutes) caught since
      the last is written on the run (`fish.idle`) and taken off their catches
      on the fish's strength, the side panel and the podium (`pe_fbi`). Moving
      once counts what they catch from then, never what the farm caught
      before. Who is AFK is kept on the run too (`fish.afk`,
      `boss-fishing.stillAfk`): somebody just back on, or everybody after a
      Polaris restart, is not known to be either for a while, and stays as
      they were last seen until a look sees them move or stand still.
    - It is said to tire at three quarters, half and a quarter. Landed before
      the time is up, the most catches win, with a closing line and a display
      of firework sparks and sounds - particles, never rockets, which hurt
      whoever is near one when it bursts. Still fighting when time is up, it
      gets away: no podium and no prizes, and the results say how much
      strength it had left.
- **Treasure hunt** hides one treasure, a bastion's treasure room by default,
  under a column of light, with every player's action bar giving its distance
  and direction for the whole hunt.
- **Trivia** draws from `trivia-questions.json`: Minecraft only, over four
  hundred questions, each in English and Spanish, by category (blocks, mobs,
  crafting, world, redstone, enchanting, versions, advancements, mechanics).
  Every question names the Minecraft Wiki page its answer was checked on
  (Java Edition 1.21), and the names of things are the game's own in each
  language, so either is accepted, as is the plural or the `minecraft:` id.
  Nothing repeats inside a game, and the questions asked in the last games
  (`RECENT_KEPT`) come after all the others.
- **Parkour** is laid out from the run's id, so every run is a new course,
  30 jumps by default (10 to 60). It takes one of five shapes, drawn among
  those switched on (`shapes`; every one on a new event, rows and tower on
  one saved before the others existed): rows climbing back and forth, a tower
  climbed round its four sides (`parkour-layout.TOWER_SIDE`), a line of long
  rows (`LINE_ROW`), a snake winding across its way and on
  (`SNAKE_WIDTH`, `SNAKE_STEP`), or a spiral winding outward, each lap
  `SPIRAL_LAP` further out. The last three run mostly level. From any
  platform only the next one is within a jump (see "Building a map" below),
  every jump is one a player makes without a perfect run
  (`parkour-layout.jumpProblems`: within half a block of a sprint jump's
  reach, edge to edge, a corner's diagonal included; checked over thousands
  of courses of every shape), no platform is under the start, and a
  checkpoint counts only straight after the one before it. Courses built
  before that rule (design 4) keep their layout; a tower then could leave a
  corner jump three across, two aside and a block up.
  Past easy, some plain jumps are traps: slime pads that throw the player up
  again, and orange platforms that vanish for two seconds in every six
  (`parkour.blinkLines`). Never two in a row, never a checkpoint; a fall is only
  ever back to the last checkpoint.
- **Parkour** also has climbs - three up a ladder or a vine on a column, the
  climb hung after the column and taken down before it - and moving platforms
  that swap between two places a step apart every three seconds. Each course
  has one of four looks (classic, frost on slippery packed ice, jungle with
  vines, nether), drawn or chosen, with a light under every checkpoint. A
  course already standing when an update adds a new layout (`parkour.DESIGN`,
  written onto the stage when it is built) keeps the layout it was built
  with - no climb, moving platform or checkpoint light appears on a course
  that was placed without them, so a race running across the update is never
  changed under the players mid-run.
- **Arena kinds played through `ArenaGame`** (`kinds/arena-game.ts`): each
  kind's own part of the arena's steps - its box, fills, kit, start spots,
  "Go!", tick, quick lines and results - lives in `kinds/<kind>.ts` (pure)
  and `kinds/<kind>-service.ts`, looked up in `kinds/arena-games.ts`. The
  team duel, build battle and king of the ring keep their older branches in
  `arena-service.ts`.
- **Capture the flag** is two teams set up exactly as a duel's (kit,
  `downHearts` send-back and shield, kill credit, natural regeneration off),
  in an arena 21 by 47 with a base at each end: the floor in the team's
  color, the banner on a sea lantern. A player touching the other team's
  banner while it stands at home takes it - the quick look marks a touch in
  passing (`touchLines`), so running past it counts - and wears it on their
  head (marked as the kit, only onto an empty head, `item replace` from
  1.17 and `replaceitem` before), glowing and slowed. Carried into their own
  base while their own flag stands there it is a capture: a point for the
  carrier and one for the team. Brought low, sent back or gone, the carrier
  drops it and it is back on its stand. Where each flag is lives in the run
  (`game.flags`), and every tick puts the stands as that says, so a restart
  leaves them right. `captures` captures end it; otherwise the team with
  more when time is up. The podium is each player's captures, a tie broken by
  eliminations.
    - The quick look's marks (touched a flag, stood at home) are taken in one
      batch, copied and cleared (`TAKE_MARKS`), and wiped off anybody the
      tick sends back straight after the move (`unmarkLines`): a mark made
      where they stood before it is never read with them at home.
    - Only somebody alive takes or captures a flag: a player dead by it stays
      marked there while on the death screen.
    - A player with no `health` score is on and whole: the game makes the
      score only once that player's health first changes (`duel.healthOf`).
    - An elimination is the rival the game says last hurt the player brought
      low (`execute on attacker`, from 1.19.4), nobody when that was no rival;
      a death, whose player comes back as a new one, by the kill the game
      counted. Before 1.19.4, the rival who struck last. The team duel
      credits the same way.
- **Hot potato** is a striped platform walled in glass three high (11 by 11
  up to six players, 13 by 13 past), with a gallery behind its north wall a
  step up, roofed, that whoever is out watches from. Nobody is hurt:
  Resistance IV, Regeneration and Saturation on everybody, every tick. Each
  round's holder is drawn from the run's id and the round among who is left
  (`hot-potato.holderFor`) and wears a marked TNT on their head (only onto an
  empty one), glowing. Everybody else is under Weakness 101, so they cannot
  strike. A punch - the left button; the right one hurts nobody and passes
  nothing - is read off the events data pack (see "Hits" below): the holder
  struck a player and somebody was hurt by one, by the holder where the game
  says who hurt them (from 1.19.4), and the potato goes to the nearest of
  them. Where the pack cannot be put on, the hit is read off `damage_dealt`
  and `damage_taken` as before. Whoever was just handed it stays weak until
  the next tick, so it cannot bounce straight back. A hit is seen on the
  next tick, up to two seconds after it lands. When the fuse runs out the holder is
  out - particles and a sound where they stand, never a block or an entity -
  and goes to the gallery; three seconds later the next round starts. Somebody
  off the server two ticks running is out too. The round, the holder and the
  fuse's end are clock times in the run, so a restart picks the fuse up where
  it was. The last one left wins; everybody else is ranked by when they went
  out, the same moment the same place.
- **Hide and seek** is played in a closed house in the air: nine rooms, three
  by three, 39 by 39 inside under a solid roof, a doorway in every wall between
  two rooms, a loft along an outer wall of two corner rooms, places to climb
  up to and secret rooms behind bookcases (see "Building a map" for how it is
  laid out and checked, and "Secret doors" below for how they open). Each room has four lamps in its
  floor and no more, so corners stay dim but never dark enough for a monster.
  The seekers (`seekers`, never everybody) are drawn from the run's id and
  wait in a barrier cage in the middle room, blind and unable to walk, for
  `hideSeconds` (45 by default, up to 90: the house takes longer to cross than
  the old hall did); the hiders start round it. Then the cage's barrier comes
  down, only inside its own box, and that it did is written into the run, so a
  restart neither lets them out early nor builds it again. Two teams hide each
  side's names from the other
  (`nametagVisibility hideForOtherTeams`), friendly fire off; hiders are
  under Weakness 101, so only a seeker can strike. A hider hurt by a player
  (the events data pack, see "Hits" below) is found by the seeker the game
  says hurt them, from 1.19.4; before, by the nearest seeker within five
  blocks who struck. A drop off the gallery, four blocks up, hurts, and is
  never a find. Whoever is found joins the seekers. Nobody is hurt
  (Resistance IV, Regeneration, Saturation every tick). Scoring: a hider
  scores a point for every second hidden while on the server, from "Go!" to
  being found; a seeker scores 30 a find (`FIND_POINTS`: half a minute of
  hiding, so a seeker who finds most of a group early keeps up with a hider
  who lasts). It ends when every hider is found, or when time is up.
- **SkyWars** needs 1.17 (`catalog.stashesFirst`): its loot is fought over,
  so it must never sit beside what a player brought, and only from 1.17 is
  that put away first; an older server is refused before anything starts.
  Each player starts in an invisible cage (barrier, so nothing hides the
  island from them) on an island of their own in a ring round a bigger
  middle island (see "Building a map"); the cages come down at "Go!", only
  their barrier, only in their own boxes. The chests are filled once the
  islands stand (`ArenaGame.decorate`), each stack marked as the kit, in
  slots drawn from the run's id, `item replace block` from 1.17
  (`replaceitem` before): an island's first chest its bridging blocks, a
  sword and food, its second more blocks, two pieces of armor and maybe a
  bow and arrows, snowballs or a golden apple; the middle's four better -
  iron, pearls, golden apples. `loot: rich` puts iron and diamond where
  `normal` has wood and leather. Bridging blocks can be placed only against
  the islands' own blocks and other bridges (`can_place_on`), and nothing
  can be broken. PvP is on, keepInventory held, natural regeneration left
  on: food is in the chests. A player is out - never dead - when the duel's
  shield catches them at two hearts (`OUT_HEALTH`), when they die anyway,
  fall under the islands, cross the play area's edge, or are off the server
  two ticks running; their kit is taken and they watch from an invisible
  gallery over the middle. The quick look takes whoever crosses the play area's edge
  up to the gallery at once, and kills any arrow stuck in a block before it
  can be picked up as nobody's. Each hit is credited to whoever the game says
  hurt the player (`execute on attacker`, from 1.19.4) - nobody, for a fall
  or a fire - and before 1.19.4 to whoever struck nearest (within six
  blocks) or else drew a bow; whoever hit someone in the ten seconds before
  they went out has the elimination. The last one left
  wins; everybody else is ranked by when they went out, a tie broken by
  eliminations.
- **Hits** (`kinds/hits.ts`, `hits-service.ts`): who hit whom in an arena is
  read off the game, never guessed from statistics where it can be helped.
    - The events data pack carries two advancements with no display:
      `entity_hurt_player` (hurt by a player, not blocked by a shield) and
      `player_hurt_entity` (hurt a player). Their reward functions tag a
      player an arena took in (`pe_hit_hurt`, `pe_hit_struck`) and revoke
      the advancement, so the next hit fires it again. They fire on any
      damage that gets through, however small after Resistance, and never
      for a fall. A kind that reads them says so (`ArenaGame.hits`), the
      pack is put on before its arena is built, and the tags are cleared at
      "Go!": any arena's fight leaves them.
    - The tick takes the tags in one batch (`TAKE`: copied, then cleared),
      so a hit landing while it reads is kept for the next look.
    - Who hurt a player is asked of the game (`hits.attackerLine`, an
      `execute on attacker`, from 1.19.4): the last living thing that hurt
      them in the last five seconds, nothing after a fall. Before 1.19.4,
      the nearest of those who struck.
    - Where the pack cannot be put on, the damage statistics are read, a
      first score counted as a rise from 0 (`hits.rose`).
- **Secret doors** (`kinds/secret-doors.ts`): hide and seek's secret rooms
  (design 3) open and shut in the events data pack, never by redstone of
  their own.
    - A door is two bookshelves in a bookcase. A sticky piston under the
      floor, facing up, and one in the lintel, facing down, hold them in the
      doorway while powered; unpowered they pull them into the floor and the
      lintel and the doorway is open. Built, nothing powers them: every door
      starts open, and stays a way in where the pack is not on.
    - The power is a block of redstone the pack sets beside each piston and
      takes away (`door/open`, `door/shut`), only where that piston is - so
      nothing is ever set into a world the house has gone from. A button
      (oak, beside the doorway inside and out, a corner off its column) is
      only read: `powered=true` sets the door's timer to `OPEN_TICKS` (70),
      five seconds from a press with the wooden button's 30-tick pulse. A
      button's own pulse is too short to walk through, and a pulse extender
      built of redstone is one more thing a stray signal could power.
    - It shuts by itself once the time is up, on a tick when no entity's
      hitbox touches the doorway or the column of blocks round it (3 by 3, the
      doorway's height): a closing piston pushes a player along, and with
      blocks from above and below they would end up in one. Shut on somebody
      after all, it opens again at once. No piston is powered or unpowered
      again until `SETTLE_TICKS` (4) after the last change: a sticky piston
      cut off mid-push drops its block, which would leave a bookshelf in the
      doorway for good.
    - Each door is an invisible marker stand in the wall over it, and every
      offset is from there (`RISE`). The pack works only the doors within 12
      of a player an arena took in - players first, then doors near each by
      distance, which the game looks up by chunk - and each once a tick
      (`polaris_dlast` against `#now`, the game time). Its work is a handful of
      block tests per door near somebody, and nothing elsewhere.
    - At "Go!" the markers are summoned and each door worked once, so they
      shut as the game starts (`hide-and-seek.doorLines`). At the end the
      markers are killed and every power block in the box taken away, so every
      door opens before anybody is sent home (`doorsOff`); the arena's close
      kills the markers again (`doorsStill`) and the teardown takes the
      pistons before their power, so nothing moves while the house comes
      down. The scores (`polaris_door`, `polaris_dwait`, `polaris_dlast`) go
      with the game's own.
    - Pistons, redstone and bookshelves are not in either anti-xray's hidden
      set (it hides only ores), so every player sees the doors as they are.

## Building a map

Anything a player moves over - a parkour course, an arena, a platform - is
laid out by a pure function from the run's id, checked against rules in code,
and only then built. The rules a parkour course keeps
(`parkour-layout.layoutProblems` and `skipProblems`) are the model for any
new map:

- **Nothing can be skipped.** From any platform, only the next one is within a
  jump; nothing two or more ahead is (`skipProblems`). A jump's reach is
  `reachAcross(rise)`: blocks of air across, counted the long way on a
  diagonal - 4 on the level, 3 a block up, none two up, 5 a block down and up
  to 7 falling further. It errs long on purpose: a course that is a block
  wider than it had to be costs nothing, a platform in reach past the next
  one is a part of the course nobody has to play. Off a slime pad the bounce
  adds its height and a block; a moving platform counts at both of its places.
- **Every jump is one a player makes** without a perfect run: two blocks of
  air on the level or down (three on hard), two a block up (one on easy).
- **Nothing touches, nothing is in the way**: a block of air between any two
  pieces unless one is `HEAD_ROOM` over the other, and head room over every
  jump.
- **Laid out by searching, not by chance**: design 4 places a jump at a time,
  tries every gap, rise and step aside in an order drawn from the seed, keeps
  the first that breaks no rule, and when a jump has nowhere to go takes the
  one before it back and tries its next place (`walked`). A corner or a turn
  often needs the jump before it to have climbed, which only backtracking
  finds. Placing at random and rejecting the whole course does not converge
  on long courses: before backtracking, nearly every 60-jump course fell back
  to a plain staircase.
- **Measure a generator before shipping it**: over thousands of seeds per
  shape, difficulty and length, count how many courses break a rule (must be
  none), how many fall back to the plain layout, how tall they get, and how
  many traps survive. The tests in `minecraft-events-parkour-layout.test.ts`
  assert the first; the others decide whether it is any fun.
- **A found layout is kept, not searched again**: the backtracking search is
  not cheap, and every tick and every quick look would otherwise redo it.
  `walkedOnce` keeps the last `WALKS_KEPT` (16) courses by run id, shape,
  difficulty and jump count - enough for a race, its preview, and a few
  other runs asked about meanwhile.
- **A loop is laid out as an outline.** The boat race's track is the outline of
  a shape of squares grown from the run's id - no holes, no two squares
  meeting only at a corner - drawn at twice its size, so it never turns twice
  in a row and two parts of it are always apart. The rules it is checked
  against (`boat-race.trackProblems`), from the blocks: one closed loop, the
  ice of parts more than three steps apart never within three blocks, the same
  width across every straight, a wall beside every block of ice, every turn a
  right angle with a straight between, and gates on straights that cut the
  track into exactly one stretch per gate, each touching only the gate before
  it and the one after - so no gate can be reached but through the one before.
  Measured over 3,000 runs: none breaks a rule, none falls back to the plain
  track.
- **A fall is a move too.** A map a player falls through (the dropper) is
  checked the same way: every hole is reached from where the one above was
  passed by a cautious player - walking, never sprinting, setting off still
  only once their head is clear of the floor above, and stopping over the hole
    - with a quarter of a block to spare (`dropper.planProblems`), and no hole
      lines up with the next, so a straight drop always lands on a floor. The
      physics is the game's own, in blocks and ticks (Minecraft Wiki, "Entity" and
      "Slow Falling"; Minecraft Parkour Wiki, "Horizontal Movement Formulas"): move,
      then gravity (0.08, or 0.01 with Slow Falling) and drag (0.98 down, 0.91
      sideways); in the air a held direction adds 0.0196 a tick walking; a player is
      0.6 wide and 1.8 tall. A player simulated tick by tick with that physics,
      steering for each hole, makes every floor of thousands of shafts in the
      tests, and the heights are measured: twenty hard floors stay under 250
      blocks, so they fit over the sea under a 1.18 world's build limit.
- **Enforced in the game too**: a checkpoint is reached only from the one
  before it (`quickSelectors`), and a racer seen past their next checkpoint
  (an ender pearl, a push) is sent back to their own with "No shortcuts".
- **A layout change bumps `parkour.DESIGN`**, written onto the stage when it
  is built, so a course standing across an update keeps the layout it was
  built with. An arena kind writes its own (`ArenaGame.built`) into the run
  with the arena.
- **A field fought over is the same from both sides**: capture the flag's
  cover is drawn on one half and turned half a circle onto the other
  (`capture-the-flag.coverFor`), and `layoutProblems` proves it - every piece
  has its twin, no two pieces touch, nothing stands within a block of a side
  wall or on a base, and every floor block can be walked to from both bases
  (a flood fill: no sealed corner). Over 3,000 seeds: no rule broken, 10 to
  16 pieces a field.
- **Every hiding place can be walked to, and is a real one**: hide and
  seek's house is drawn from the run's id (`hide-and-seek.layoutFor`). The
  hiding places are the ones players use in the game, not only blocks to
  stand behind - an open hall with a few blocks gave hiders no chance:

    - **closets**: a cupboard against a wall with an oak door; step in, shut
      it, and a seeker has to open it to look;
    - **hatches**: a spruce trapdoor in the floor over a pit two deep with a
      ladder in it; drop in and close it over your head;
    - **bushes**: a hollow hedge of leaves with a way in on one side only;
    - **lofts**: a platform under the roof reached by a ladder (seekers look
      ahead, not up), with cover on it and under it, against the wall only, so
      the rows in front stay a way through;
    - **cover**: walls, hedges, crates and stacks of barrels to crouch behind;
    - **climbs** (design 3): a wardrobe against a wall with three barrels as
      steps up to its top (`steps`, standing four up), a crow's nest on a post
      with a ladder (`perch`, four up) and a beam six long under the roof,
      reached by a ladder up the wall, a post under its far end (`rafter`,
      five up). One to a room, so they spread over the house;
    - **secret rooms** (design 3): an alcove of bookshelves under a soffit
      against an outer wall, to the roof; one bookshelf column is a door into
      a room two by three behind it, lit by its own lamp. Only the middle of
      the outer wall of a room between two corners is long enough between a
      room's lamps, so two of those four places are drawn, and which end of
      the shelves the door is at.

    Doorways, lofts and every piece are drawn from the run's id; the whole house
    is mirrored into one of four ways. The climbs and secret rooms are drawn
    first, and only by design 3: a run built by design 2 still draws exactly
    its own house (`layoutFor(seed, 2)`). Each piece stays inside one room, keeps a
    block of air from every other and from the doorways, the ladders and the
    posts, the lamps and the cage with the ring the hiders start on, fits under
    what is over it, and a closet stands against a wall. Everything inside the
    house is set block by block in one grid (`blocksOf`) and built from that
    same grid as merged boxes, so what is checked is what is built.
    `layoutProblems` then walks the house from the hiders' start the way a
    player moves - level, a block up with room to jump it, down at most three,
    through doors, onto a shut hatch, up and down the loft ladders - and fails it
    if any place to stand on the floor, a loft, a climb (at any height) or in a
    secret room cannot be reached - up the perches' and rafters' ladders,
    through a secret door as it is built, open - and spreads
    the lamps' light the way the game does (a level less a block, through air,
    doors, hatches, ladders, fences, leaves and barrier) and fails it if anywhere
    a mob could stand, a pit's floor included, has block light 0 - with the
    secret doors open, and again shut, when a secret room has only its own
    lamp. A climb or a secret room is in one room, out of a loft's way,
    against a wall where it needs one, and a secret room never in the cage's.
    Over 1,000 seeds: no rule broken, never the empty fallback, on average 2
    secret rooms, 2 of each climb, 6 closets, 6 hatches, 4 bushes and 26
    pieces of cover.

- **No island is a jump from another**: SkyWars' islands are drawn from the
  run's id (`sky-wars.layoutFor`) - each a blob with a waving edge, grass over
  dirt over stone narrowing to a point and flecked with andesite and ore, an
  oak with leaves that never wither or a mossy boulder, flowers, a start and
  two chests; the middle wider, an oak at its heart and four chests. The ring
  is then laid out by searching: its radius starts at what the islands'
  widths need and grows a block at a time until `layoutProblems` holds - no
  block a player can stand on (tree tops included) is within
  `parkour-layout.reachAcross` of any block of another island, counted the
  long way on a diagonal; five blocks of air at the least between any two;
  every start and chest on its island's grass and walked to from the start;
  and no island so far that its own chests' 48 bridging blocks, with eight to
  spare, cannot reach the middle. Over 4,100 seeds from two to eight
  players: no rule broken; the ring 19 to 26 blocks across up to six
  players, 24 to 31 for eight.
- **What hangs comes down first**: a flower, a ladder or a banner whose
  support is taken away drops as an item nobody owns. `arena.teardown`
  takes a kind at a time over the whole box, in the order the arena lists
  its blocks, and a map lists what hangs first (`ARENA_BLOCKS`,
  `HALL_BLOCKS`). Built, the order is the other way: what holds a thing up
  goes in before it.
- **Nothing a player places is outside the box**: a block goes only against a
  block within reach (`sky-wars.REACH`, six with the block), so the box
  reaches `MARGIN` (twelve) past the play area on every side - room for that
  reach and for what a player covers in one quick look falling or running -
  and the quick look puts out anybody past the play area's edge before they
  could reach past the margin. Barrier walls and a barrier roof on the box are
  the backstop: nothing can be placed against them. Teardown takes every
  bridging block kind inside the box, with the islands.

## How the floating maps look

Everything below is part of the arena's own boxes: built into air with
`keep`, and taken out with the rest.

| Arena            | Look                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spleef           | each floor walled in its own color, a sea lantern on every corner post                                                                                                                                                          |
| TNT run          | TNT floors, a rim in its own color at each one, glass walls, corner lanterns                                                                                                                                                    |
| Dropper          | white walls banded by each floor's color, a ring of light round every hole                                                                                                                                                      |
| Ice boat race    | packed ice, white walls with a glass rail and lights, an arch over each gate                                                                                                                                                    |
| Nether maze      | netherrack walls and roof, glowstone over every other room, a nether-brick starting room and a quartz floor at the goal                                                                                                         |
| Acid rain        | mossy stone floor with a sea lantern in each corner, glass walls, an invisible roof, cobblestone huts                                                                                                                           |
| Elytra race      | orange concrete rings, a white start ring lit at its corners, yellow glass boosters, magenta pillars                                                                                                                            |
| Parkour          | the course's theme, a light under every checkpoint                                                                                                                                                                              |
| King of the ring | polished stone edge, sea lanterns at the corners, the circle drawn in yellow                                                                                                                                                    |
| Build battle     | a stone curb between plots and glowstone where the lines meet, at floor level                                                                                                                                                   |
| Team duel        | a stone rim round the floor and a post of light at each corner                                                                                                                                                                  |
| Hot potato       | a floor in orange and white stripes, glass walls on a stone rim, sea lanterns up the corners, a spruce gallery                                                                                                                  |
| Hide and seek    | a stone brick house under a dark oak roof, spruce walls between nine rooms, oak closets, spruce hatches, birch lofts on log posts, bookcases in spruce alcoves, barrel steps up oak wardrobes, birch crow's nests, spruce beams |
| SkyWars          | grass, dirt and flecked stone islands with oaks, boulders and flowers, invisible cages and gallery over the middle, barrier walls                                                                                               |
| Capture the flag | the duel's rim and posts, bases in red and blue, banners on sea lanterns, cover of stone brick, spruce and chiseled stone                                                                                                       |
| Boss sky arena   | glass, with a pillar of sea lantern at each corner                                                                                                                                                                              |

## In-server work (the Polaris mod)

Big servers do event work inside the game, in the tick, not over a console
trip per player. Where the Polaris NeoForge mod is on the server and says it
can, the events do the same; everywhere else they keep the plain-command path,
which stays fully supported and tested.

**Which servers get which path**

| Server                                                                              | Path                                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| NeoForge 1.21.4 with the Polaris mod (every one Polaris manages, after one restart) | In-server: `polaris stash`, `polaris batch`, hiding by line of sight                  |
| NeoForge 1.21.4 not yet restarted onto the new jar                                  | Plain commands until it restarts                                                      |
| NeoForge on another release, Forge, Fabric, Quilt                                   | Plain commands - no Polaris mod build                                                 |
| Paper, Purpur, Spigot, Folia                                                        | Plain commands - the Polaris plugins there (anti-cheat, login) have no event commands |
| Vanilla, Bedrock                                                                    | Plain commands                                                                        |

**The fallback rule.** Never decide from the loader. `in-server.capabilities`
asks `polaris caps` and uses a command only when the mod lists it (`stash`,
`batch`, `seek`); any other answer - an unknown command, an old jar, a Paper
plugin - is "no", remembered for a minute. A mod command answered as anything
but the mod's JSON forgets the answer and runs the plain lines instead.

**The mod is always there on NeoForge.** Every server whose software and
release has a Polaris mod build carries the jar whatever its switches:
switching the login or the anti-cheat off only quiets it (`POLARIS_LOGIN=off`,
`POLARIS_ANTIXRAY=off`), and the `game-polaris-component` job puts it on servers
that lack it, for their next start. A move to a release with no build takes it
off - a jar for the wrong release ends the boot.

**Stash** (`polaris stash save|restore <player> <key>`, `EventStash.java`). The
41 slots (never the ender chest, never the kit), experience, health, hunger and
effects, written to `world/polaris/stash/<key>.dat` before anything is taken,
and taken and given back in one tick each. The merge rule is the dashboard's:
each stack to its own slot, what the player holds there moved to a free slot,
and what fits nowhere dropped at their feet as theirs (only they can pick it
up, it never despawns). Idempotent per key (`in-server.stashKey`: run and
player). Wired in `stash-service.stashIn` and `giveBack`: a stash kept this way
lists its keys in `stash.mod` and has no database copy; a stash already kept
the plain way is finished the plain way, and the plain path (with its vitals
restore) runs wherever the mod does not answer. Crash-safe through a mark saved in the player file: a stash file with
no mark means the player file is from before the stash, so it is set aside as
`.orphan` instead of being given twice; never deleted.

**Batch** (`polaris batch run <key> [blocksPerTick]`, `EventBatch.java`). The
dashboard appends each command to `storage polaris:batch <key>` and starts it,
all in one trip (`in-server.build`), then polls `status` until it is done. The
commands run in order, as many each tick as fit under **8192 changed blocks**
(a fill or clone counts its volume, a place 4096, a setblock one) and **15 ms**
of the tick; a fill too big for one tick is cut into boxes that each fit (only
replace, keep and destroy - hollow and outline keep their meaning only whole).
Arenas (`arena-service.raise`) and the hill's platform go through it; they are
still built exactly where the plain path builds them, only the pace changes.
Stage structures and teardowns keep the paced console trips (`pace.ts`): they
check each fill's own count, which a batch does not answer. Measured on NeoForge 1.21.4 (a 50 x 10 x 100 = 50,000-block box): the
plain path spends 24-42 ms of one tick per 25,000-block fill; the batch spreads
it over 8 ticks with at most 10 ms of batch work in any one (5 ms over 16 ticks
at 4096), and the 100-tick P99 stays under 8 ms.

**Hide and seek** (`EventSeek.java`, a mixin on the entity tracker). A hider -
tag `pe_hider` or team `pe_hs_hide` - is not sent to a seeker - `pe_seeker` or
`pe_hs_seek` - farther than 2 blocks without a clear line from the seeker's eyes
(rays through blocks' visual shapes, so glass hides nothing). The client never
learns where the hider is, which defeats minimaps and ESP. At most 192 pairs are
checked a tick, every pair every 4 ticks while that fits; with no marked players
it does nothing. There is no NeoForge event that can withhold an entity, so it is
a mixin, and a defensive one: optional, a no-op where another mod replaced the
tracker (then `polaris caps` leaves `seek` out), and it switches itself off
rather than ever failing a tick.

## Lessons from real servers

Every rule below was learned from a bug, most of them seen on a live server.
The commit is named so the reasoning can be read in full (`git show <hash>`).
A new kind follows all of them. A change to an old kind must not undo one.

### Talking to the server

- **One RCON command at a time per server** (`rcon-turn.ts`, `inRconTurn`).
  When two loops ran at once, each read the other's answers, and ground
  checks started failing (`885298087`).
- **Batch reads.** `sayEach` runs many commands in one trip, and an answer
  whose end marker never arrived is asked again on its own, never trusted.
  One RCON packet cuts a long answer (a shulker of enchanted gear was misread
  as a different item), so a stack is read whole through command storage
  (`stack-storage.ts`) (`f2dfeabcb`, `a875f0080`).
- **An arena's teardown goes a few dozen fills to a trip, not one at a time
  and not all in one trip.** Every kind of block in every slice of a SkyWars
  arena's box is hundreds of fills; asked one by one over RCON they held the
  podium back for seconds after the winner was already known. They now go
  `FILLS_PER_TRIP` (25) to a `sayEach` trip, in order; a fill whose answer did
  not come back is asked again on its own. A trip that fails outright is not
  retried fill by fill - it may still be running in the container - so the
  arena is left loaded and tried again whole on a later tick
  (`7125df850`, `d4f209a69`).
- **Read answers the way a real server writes them.** That includes a team
  prefix, Bedrock's leading dot, several answers run together, and a crowd
  too big for one answer, which is read in pages (`replies.ts`). Scores read
  the naive way paid nobody's podium (`0896c370e`, `a6960fd77`).
- **An empty answer to a ground check means natural ground**, because that is
  what a real server gives (`8b21a38fb`).
- **Who rides what is asked of the vehicle itself** (`execute on passengers`,
  from 1.19.4 like `ride`), never read from its saved data. A player is
  never written into a boat's own `Passengers`, so every occupied race boat
  read as empty, was taken away, and its racer put back in a new one - on
  every look, a loop of teleports (`4bd9b0bd1`).
- **Never trust `give`'s "Gave".** A full inventory drops the prize on the
  floor. Count the item and read the level before and after, and record what
  was dropped (`3e2adca59`). A prize is handed over once, however the
  winner's name is written, and one the game refuses is kept for later
  (`729d900da`).
- **Keep the operator's chat clean.** `sendCommandFeedback` is held off while
  an event runs commands (`FEEDBACK_RULES`), and is turned off only after the
  news line has gone out (`3716e0438`, `e19b8113a`).
- **Something RCON cannot see in time runs inside the game.** A snowball
  hitting the spleef floor lasts 2-3 ticks, and the fastest RCON look is 8.
  So the check is a data pack of vanilla commands, enabled with `/datapack`
  (never a bare `/reload`, which on Paper is Bukkit's reload), armed and
  disarmed only while the switch still belongs to that arena (`e97e732cd`,
  `d301dcbc7`).
- **Take the pack in between events, never at a start.** `/datapack enable`
  reloads the server's data and pauses the game for a moment. Done as a game
  started, after every update that changed the pack, players felt it as a
  freeze just before a spleef with snowballs. The minute sweep brings the pack
  up to date while no event is on (`refreshPackIdle`), once per pack version;
  the check at a start then finds it current and reloads nothing
  (`ef2954920`).
- **A look under way is shared, never started twice.** The Events screen and
  the random draw's sweep can ask who is on at the same moment; `lookIfDue`
  now hands both the one look already running instead of firing a second RCON
  trip for the same server (`af7fbb20d`).

### Reading what happened in the game

- **A statistic's score does not exist until it first moves.** An objective
  on `damage_dealt`, `damage_taken`, `playerKillCount` or a `used:` count
  has no score for a player until that player's count changes after it was
  made, and a tick that compared each count with the last it read dropped
  every first rise: the first punch of each hot potato holder, the first
  find, the first hit and kill of every fighter. A count read for the first
  time of somebody on at the last look rises from 0 (`hits.rose`)
  (`a5bfc3c12`, `800b43f30`, `50c9aca43`).
- **Neither does a `health` score until that player's health changes.** A
  capture the flag player nobody had hurt yet read as not on, and could not
  take a flag; such a player is whole (`duel.healthOf`) (`800b43f30`).
- **The damage statistics are not hits.** They count tenths of a heart,
  rounded, so a quick second punch under Resistance IV counts nothing, and
  `damage_taken` rises for a fall as much as for a blow: a hider dropping off
  the gallery beside a seeker who had struck somebody else was "found", and
  a SkyWars player who jumped off a tree handed the nearest striker an
  elimination. A hit is the events data pack's advancement (see "Hits" in
  the kind notes), and who hurt whom is the game's own memory of it,
  `execute on attacker` (`a5bfc3c12`, `50c9aca43`).
- **A tag the game sets for anybody is cleared before a game reads it.** The
  pack tags a hit in any arena, and only hot potato and hide and seek take
  the tags: one left from an earlier fight was read on their first look as a
  pass or a find of their own. Both clear them at "Go!" (`9ef1d4813`).
- **Credit goes to whoever hurt that player, not whoever struck last.** "The
  rival who struck last" was anybody's strike at anybody: with more than one
  a side, eliminations went to the wrong rival (`800b43f30`).
- **A mark the quick look leaves is taken in the same batch it is cleared,
  and wiped off anybody the tick moves.** Capture the flag read its marks and
  cleared them in separate trips and sent its lines - the send-back teleport
  among them - at the end of the tick. A quick look in between marked a
  player brought low by the other team's flag where they stood before the
  move, and on the next tick they took that flag from their own base, two
  blocks from their own, and captured it at once (`800b43f30`).
- **A dead player is still somewhere.** `@a` selects players on the death
  screen where they fell, so a player dead by a flag was marked as touching
  it after their death was counted; only somebody alive takes or captures
  one (`800b43f30`).
- **`tp` leaves its target on the ground.** The dropper's landing box
  reached the spot it sends landed racers back to, so each was sent back
  every tick - the server ignores a player's moves until it has their answer
  to a teleport - and held in mid-air until vanilla kicked them for floating
  too long, on every run on a real server (`fac79a14a`).
- **What the pack notes to the tick orders what one look sees.** Two
  racers reaching the dropper's water in one look were told their places by
  join order, and the last two of a TNT run falling in one look left no
  winner; both go by the game tick the pack wrote (`fac79a14a`, `5779a007a`).
- **A rule a winner must keep is checked on the look that crowns them.**
  Creative was sampled every fifteen seconds and a bingo card every two:
  crafting in creative in between and switching back won the card
  (`2bdb2b344`).
- **A count measured from the last look can be wound back.** A treasure
  dropped on one look lowered the count a catch is measured from, and picked
  up again after a cast on a later one it was a new catch, over and over; the
  measure is now the most a player has had (`72b98f85c`).
- **A statistic for a kind of mob counts the world's own mobs too.** A horde
  or villager defense counted every zombie killed near the point at night,
  summoned or not; the pack counts kills of `pe_wfight` only (`88a8e34ee`,
  `4a6f9bae5`): not `pe_mob`, which a jockey's mount carries too.
- **Coming back is not starting over.** A boat racer who left and joined
  again lost every gate in the game while their clock kept running; they now
  come back at their last gate with their passes (`d50b36885`).
- **A look that cannot read a value keeps the last one, never a default.**
  The villager's health fell back to full on a look it could not be read,
  showing a dying villager healed (`8b7f0626d`).

### Versions, loaders and plugins

- **Gate every command on the server version** (`atLeast`), and give an
  unknown version the conservative path (`edec0f564`). The version gates that
  have already bitten:
    - 1.13: legacy chest checks (`96a9b55b2`).
    - 1.13-1.15: boss attributes, and parkour/spleef entry (`078ce566a`,
      `7c6f312ea`).
    - 1.16: a missing statistic counts as nothing, never as an error
      (`1454d348b`).
    - 1.17: `item replace`; before it, `replaceitem`, no stash, and the kit goes
      beside what players carry (`13d8449e1`).
    - 1.19.4: the heightmap. Before it, the ground marker lands a block or two
      off, so keep a margin from beds and never leave a marked chunk loaded
      (`40bcd010c`, `4f5b2ccc3`). And `execute on attacker`, who hurt a
      player; before it, the nearest striker is the guess (`a5bfc3c12`,
      `800b43f30`, `50c9aca43`).
    - 1.21: the data pack's `advancement` and `function` folders, singular;
      before, plural. The pack ships both (`a5bfc3c12`).
    - 1.20.5: item components. Before it, NBT `Count` (`b29835d20`).
    - 1.21.5: equipment, `drop_chances`, SNBT text names, and the new
      click-event spelling (`e3143f57b`, `e24b3e480`).
    - 26.1: still-clock time (`0c1b34106`).
- **Every gamerule is written with both names**: the old camelCase one and
  the 1.21.11 snake_case one (`advance_time`, `mob_griefing`,
  `keep_inventory`, `natural_health_regeneration`, `send_command_feedback`).
  A name the server does not know is skipped, and never stops the event.
- **Paper/Spigot with EssentialsX** replaces vanilla commands with its own.
  A Bukkit-family server is detected once (`BUKKIT_PROBE`), and on one every
  vanilla command an event runs goes out as `minecraft:<name>` (`1ee137538`).

### Players

- **Count only players who are really playing.** Leave out idle players (the
  AFK tracker in `activity.ts`), players in another dimension when the kind
  needs the Overworld, and players still at the Polaris login prompt
  (`polaris_pending`, which `prelogin.ts` takes out of every count). Nothing
  Polaris shows reaches a held player either (`f7b2a8a6b`, `6abe22708`).
- **A competition with prizes never starts on its own for one player**
  (`PRIZE_COMPETITION_FLOOR`), and it needs a minimum score to rank
  (`DEFAULT_MIN_SCORE`). A build battle needs three builders, because with
  two each vote can only go to the other build (`BUILD_BATTLE_FLOOR`)
  (`f7b2a8a6b`, `ec91d0ca2`).
- **Never open an event that cannot reach its own minimum**, even when the
  operator presses Run: an event players join needs at least
  `joinersNeeded` players on the server before its countdown starts, or it
  only gets called off once the countdown is over. The Run button is disabled
  for the same reason, so the screen and the server agree.
- **Nobody wins by standing still, in creative, or with a farm.** Players
  seen in creative or spectator, AFK players where `afkCounts`, and players
  caught by Anti X-Ray or the anti-cheat are left off the podium. Ore placed
  during a mining rush is taken off the count. A gathering of iron counts
  only smelted raw iron that was picked up, never ingots crafted from blocks
  (`f7b2a8a6b`, `a92042a1f`).
- **A fight is damage dealt, not damage taken.** Hunger and falls kept a
  survival island "in a fight" all evening. When an event ends, its own
  players are taken out of the fight count, or the next event is refused
  (`ec91d0ca2`, `fda3bddb8`).
- **Never re-teleport on what the player's game reports.** A pack check
  that sends a player somewhere (the dropper's landing check, every tick) must
  not run again on `OnGround` before the player's game has answered the
  teleport: until then the server keeps the old value, so the player was sent
  up every tick, hung in the air at the top, and was kicked by the server's
  own check - "Flying is not enabled on this server", logged as "kicked for
  floating too long" after 80 ticks with `allow-flight=false`. Tag who was
  sent and wait until the server sees them off the ground
  (`dropper.SENT_TAG`). Read with the server's own bytecode: the check counts
  a tick as floating when a move is less than 0.03125 down with no block
  round the player, so a steady Slow Falling (0.49 a tick) never trips it;
  only standing still in the air does.
- **A game has to be winnable from both sides.** Hide and seek in an open
  hall with a few blocks of cover was found in seconds: give hiders places
  that need searching (doors, hatches, lofts, hollow bushes), several rooms
  to break the line of sight, dim corners, and time to reach them
  (`hideSeconds` scales with the map). Nametags are hidden from the other
  side and no effect shows particles, so a hider is found by looking.
- **Each player reads their own language** (`speech.ts`): the account's
  language when the player is linked, otherwise the server's. Lines nobody in
  particular reads (the boss bar, the boss's name) are in the server's
  language (`7c53b0edf`, `cc5923ba4`).

### The world

- **Nothing built is broken.** Mob griefing is held off while mobs are
  summoned, so blood moon creepers hurt players without breaking blocks.
  Rain, never thunder: lightning burns houses and turns villagers into
  witches. Summoned mobs never break doors, pick up loot, or call in
  reinforcements (`78567015a`, `59deddc10`, `aff2236fc`).
- **Hold what the kind needs of the world** (`WORLD_NEEDS`): time and weather
  are held for the whole event, never only set at the start. A night lasts
  about 8 minutes, an event lasts 10, and a bed skips it (`f7b2a8a6b`,
  `ec91d0ca2`).
- **Write down every change before making it** (`run.gamerules`, the time of
  day), so the end, a call-off, or a restart puts back exactly that. Restore
  the time of day, not a sunrise (`f7b2a8a6b`, `6aa49c493`).
- **Summoned mobs get their weapon by hand.** A summon with data skips the
  game's own equipping, and nothing they hold may drop (`aa3924bf5`).
- **Refuse what cannot work.** Hostile kinds refuse Peaceful, and PvP kinds
  refuse a server with PvP off, each saying how to fix it (`f7b2a8a6b`).
- **Chunks**: force-load only what the event needs, and never unload a chunk
  somebody else holds (`chunks.sparing`). Kill the boss for good when the
  event ends (`0ad0a60f0`).

### Where it is held

- **Ground kinds** stand only on the world's own dry ground, clear of beds by
  `HOME_CLEARANCE` (48 blocks, with margin for marker drift). Kinds that
  change nothing (drop, treasure, hill circle) may come in closer after a few
  tries, halving the distance each time, so a small island still works.
  Meteors, hordes and bosses never do (`3dda1f25f`, `aa3924bf5`).
- **Air kinds** need only the air they take, above the `motion_blocking`
  heightmap, with the whole volume proved empty. A build or the sea below is
  never a reason to refuse (`ec91d0ca2`).
- **Only players in the Overworld anchor the search.** A bed in the Nether
  does not count (`7c6f312ea`).
- **A spot is checked block by block before it is used.** Rings sampled every
  few blocks missed a one-block trunk, and the beam stood at roof height next
  to a building (`191b70b9c`, `403020440`).
- **When no place is found, say where it looked and what blocked each try**
  (`place-search.ts`).

### Players' things

- **Stash, then move, player by player**, and look again once each player is
  in. Stashing everybody first let the first player put their armor back on
  (`f2dfeabcb`).
- **The stash lives in the database, not in barrels**: whole stacks, with XP.
  What is still owed is written as it goes, so a restart never gives a stack
  twice. A stack too big for one command is built in storage. A stack that
  cannot be carried keeps that player out of the event, and says why
  (`199eb82b2`, `f2dfeabcb`).
- **Compare stacks with their keys in canonical order.** A worn piece reads
  back slightly differently, so match the item and count rather than every
  byte. A removed component (`!minecraft:x`) is written back without `={}`
  (`199eb82b2`, `f2dfeabcb`).
- **Give things back only once the player is home and standing on
  something**: slow falling and Resistance first, their game mode last. A
  player who fell from a build battle died (`3dda1f25f`, `199eb82b2`).
- **`keepInventory` is held for every event players can die in**, and put
  back only once everybody is home.
- **Experience given back is checked as the game can say it back.** The game
  keeps the points into a level as a float fraction of it and answers
  `xp query ... points` rounded down, so some values read back a point under
  what was set: 235 points at level 49 read 234. A spleef gave a player's 49
  levels back (`Set 49 experience levels`, `Set 235 experience points` in the
  server log) and the panel still said "experience not given back" - where
  "Give back now" would have added them a second time. Within a point is
  given (`stash.sameExperience`), and a retry finds it so and adds nothing.
  An add is believed only when the experience moved. A player seen gone
  before their experience could be asked for keeps it owed on the run, given
  when they are next on, instead of being marked failed for the operator
  (`46f60e0a0`).

### The flow of a run

- **The clock runs on its own one-second timer**, and starts only when the
  kind is playable: place found, boss standing, first question asked,
  everybody arrived. A kind that never becomes playable gives up after its
  own length (`54c9bca2d`, `e19b8113a`, `20720e524`).
- **Bring everybody in, then wait for all of them** (`arrival.ts`, 20 s at
  most, naming anybody it did not wait for). Then a 3-2-1 countdown,
  everybody on their own spot, and "Go!". Until "Go!" nobody is hurt,
  nothing is counted, and no kit is handed out (`5d90ce175`, `f553de0da`).
- **A player carries the arena's tag from before they are moved until they
  are back**, so a restart in the middle never moves anybody twice
  (`4906d72c8`).
- **A call-off interrupted by a restart stays a call-off**, and players are
  told (`ecf551fd2`). Too few joined means called off, not failed
  (`364b4bea9`).
- **Nothing is impossible to finish and nothing kills.** Natural regeneration
  is off in a duel, where fed players healed faster than they could be hurt
  (`d7e0e175d`). The hill's poison stops at three hearts (`ec91d0ca2`). Kit
  that belongs in a hand goes into that hand: the duel shield into the
  offhand, from 1.17 (`d7e0e175d`).
- **Kit that can wear out is given unbreakable** (`arena.LASTS`,
  `minecraft:unbreakable` from 1.20.5, `Unbreakable:1b` before): the hill's
  golden crown wore out under the very punches it is there to draw. The
  duel's and capture the flag's sword and shield, build battle's tool and
  spleef's shovel are unbreakable the same way; SkyWars' loot keeps the
  game's own durability, since wearing it out is part of that game
  (`af7fbb20d`).
- **A layout drawn from the run's id is checked against its rules and drawn
  again until it passes**: platforms never touch, every jump has head room,
  slime pads only where the bounce lands. Its version (`parkour.DESIGN`) is
  kept on the run, so a course built before an update stays as it was
  (`c19b87280`, `9615bcd75`).
- **A version kept on the run only helps if the old shape can still be
  redrawn from it.** Hide and seek never stored which way its hall was
  mirrored - only `layoutFor(run.id)` said, recomputed each time a spot was
  asked for. That held while the draw never changed; the day the hall became
  a house the same id drew a different layout under the new code, so a hall
  built by the old design sent hiders and seekers into the wrong corner of an
  arena nobody had rebuilt. Its design (`hide-and-seek.DESIGN`) is kept the
  same way, but for a hall that old the mirror it was actually built with can
  no longer be redrawn - so it is read back from the world instead: the
  barrier over the old cage's middle sits under exactly one of the four
  mirrors, and a test command says which (`hide-and-seek.mirrorTests`,
  `73e33a69f`). So a later design adds to the draw only after a branch on
  the run's design: design 3's climbs and secret rooms are drawn only for
  design 3, and a design-2 run draws, checks and plays its own house bit for
  bit (a fingerprint test holds it).
- **A choice drawn per run stays the same after a restart**: it is seeded by
  the run's id (`trivia-bank.seeded`), never `Math.random()`, and a change to
  what can be drawn keeps the draw of a run saved before it
  (`spleef.variantFor`).
- **A late joiner's spot is a function of how many are already in, not of one
  alone.** The ice boat race's grid spot is worked out from the run's id and
  an index; admitting one late racer at a time asked for a one-racer grid
  every time, which is always its first spot - every late racer landed on the
  same one. Admission now asks for a grid sized to everybody already in plus
  whoever is joining, and gives the new ones the spots after the ones already
  taken (`stage-service.admit`) (`9010c3bf8`, `655ea112c`).

### Caches and clocks

- **A cached look is fresh only for an age from zero to its time**
  (`lib/fresh.ts`). `Date.now() - at < ttl` alone takes a look stamped in the
  future - after the clock is set back - as fresh for as long as the clock is
  behind: the language cache then spoke to a Spanish-linked player in the
  server's language, and a trivia test failed one run in three under load
  (`f9f59295c`).

### Building a map

- **Parts of a parkour course could be skipped**: platforms close enough to
  reach one past the next, a climb's top level with the next row, a corner
  cut. The layout now proves nothing past the next platform is within a jump
  (`skipProblems`), and checkpoints count only in order (see "Building a
  map" above).
- **Raising the saved jump count moved a race already running.** The same
  migration that reads an old twenty-jump event as the new thirty read a
  run's own copy of its preset the same way, so a race already under way had
  platforms added past a course its players were already climbing. A run's
  preset is read with `asBegun` (`state.ts`) instead, which only fills in
  the fields a run from before shapes was missing and leaves its length as
  it was (`30036f9f8`).

### The Events screen

- **A version is only said where it stops this server.** The screen marks an
  event "Incompatible", with why, only when the server's version is known and
  too old for it or for an option chosen in it (`catalog.incompatibility`), and
  the Run button is disabled for the same reason. Nowhere else does an event's
  text name a version: an operator on a server that plays it has no use for
  "needs 1.16". A version-dependent detail is worded so it is true on every
  version, and the start still refuses whatever the game turns out not to have.
- **A line about what was just done goes away after a few seconds.** A failed
  read is tried again on the next beat. Live reads have a time limit
  (`f7b2a8a6b`).
- **Run turns on the moment enough players are on, without a reload.** The
  screen used to show only what the random draw's sweep had last counted -
  once a minute at best, and never while the draw was off - so Run stayed
  disabled as "too few players" after one had already joined. It now reads
  every 5 s while some saved event is held back for want of players (every
  30 s otherwise, or while one is running), and again the moment the tab
  comes back into view (`af7fbb20d`).
- **Every refusal and waiting reason is written in the reader's language**,
  and the draw's state (next draw, why it waits, the last drawn event) is on
  screen (`04155e870`, `ec91d0ca2`).
- **A score kept as a sentinel is shown as what it means, never as the
  number.** A race's finish (`catalog.finishedIn`) is kept above any
  progress so it always ranks first; shown back raw it read as a count of
  seconds in the thousands instead of the time it took (`1715ffef0`).
- **Done on a new event saves it as it opens.** The same guard that holds
  Done disabled until a saved event is changed also held it disabled for
  one just added, where nothing has to change first - its defaults are a
  choice too (`EventEditor`'s `isNew`) (`1715ffef0`).

### Pitfalls

One entry per bug: what a player saw, why, and the rule that keeps it gone.

- **Building an arena freezes the server for a moment.** A 50,000-block arena
  as plain fills is two 25,000-block commands, each run whole in one tick
  (24-42 ms measured, far more on a busy server). Where the Polaris mod can, the
  build goes through `polaris batch`, capped at 8192 blocks and 15 ms a tick
  (`in-server.build`). Never assume the mod: ask `polaris caps`.
- **A command run from inside another is only queued.** In 1.20.3+, a command a
  mod runs from inside a running command waits behind it, so the mod's batch
  starts at the end of the tick rather than inside `polaris batch run` - counting
  its blocks or time there counted nothing.

- **Players arrive and leave an arena one by one, seconds apart.** Each
  entrant's stash and teleport went in its own RCON trip, so a SkyWars of
  three took three seconds to bring in and eleven to send home (seen in a
  live server's log). Stash everybody first, then send every entry line in one
  `sayAll`; send every teleport home in one `sayEach` trip and hand items back
  afterwards (`arena-service.closeArena`, `stage-service.returnAll`).
- **A boat race's boats spawn sideways to the track.** A turn sent after a
  boat is summoned is dropped by the client controlling it, so the boat keeps
  its spawn yaw of 0. Put `Rotation` in the summon itself
  (`boat-race.boatLines`); never turn a boat with a `tp` afterwards.
- **SkyWars islands cannot be broken.** `arena.enter` puts every entrant in
  adventure mode, whatever the kind, and SkyWars never changed it. A kind
  whose blocks must break switches its entrants to survival at Go, and the
  quick look kills every unmarked, unthrown item in the box
  (`arena.killBrokenDrops`) so nothing unmarked reaches an inventory; anyone
  put out goes back to adventure. Never hold `doTileDrops` / `block_drops`
  off for it: that rule is server-wide, and whatever anybody outside the
  event broke meanwhile would be lost for good. Survival is only given with a
  marker to tell the kit apart. Not yet seen on a live server: whether a
  sweep every 400 ms always beats a dropped block's half-second pickup delay.
- **Capture the flag calls a player "out" nobody touched.** Health is read
  from a `health` objective, which has no score for a player until their
  health changes, and no score reads as whole. A player who walked in hurt
  got a true low score at their first scratch or heart back, and the next
  look took them out. Everybody inside is healed whole at Go
  (`arena.HEAL_INSIDE`), before anything is counted. Likely, not proven: the
  log shows no deaths and no healing at entry, and the first send-back two
  seconds after the low-health shield first matched.
- **Bingo reads 0/9 while players hold card items.** By design only what a
  player picks up, crafts or smelts after the start counts (the game's own
  statistics), so a stack carried in or taken out of a chest marks nothing -
  and nobody was told. The one live run was called off after a minute, with
  the game's own per-cell sums at 0 for both players on every look: nothing
  on the card had come in, so detection itself did not fail. The start now
  says what counts (`bingo-messages.countsFromNow`). Whether those players
  expected carried items to count is an inference.
- **Hide and seek is won by a minimap radar.** Each entrant is sent Xaero's
  Minimap fair-play code at Go, again when they come back on the server, and
  the reset code at the end (`hs.RADAR_OFF`, `hs.RADAR_RESET`). Its limit:
  only Xaero's maps read it - any other minimap still shows players. An
  entrant off the server at the end is owed the reset (`state.owedLines`,
  `ArenaGame.owedLines`): sent when they are next seen and nothing of theirs
  is held, one per player and reason, dropped after `PENDING_KEPT_MS`, at most
  `OWED_LINES_MAX` on a server. Not yet tried with a live client.
- **Dropper racers kicked with "Flying is not enabled" partway down.** Vanilla
  allows 80 ticks airborne before it calls it flying, and Slow Falling does not
  lengthen that. Racers fall with a lighter `gravity` attribute for the run
  (Slow Falling's 0.01), which raises the limit without changing the fall, and
  get their own back when they finish or leave (#419).
- **A player's own item lost at the end of an event.** The prize was given
  before their things were back: it filled the empty slot their item was owed,
  and their item was dropped at their feet. Prizes and the world boss's trophy
  wait until the player is released, after the give-back (#420).
- **A player left an event with less health or food than they came with.**
  The stash kept items and experience only, and vanilla refuses `data modify`
  on a player. Health, food level, saturation and exhaustion are read on the
  way in and put back with the give-back - after a death in the event too, and
  on the next join for somebody who logged off (`stash.foodStep`). Health:
  Instant Health to full, then `damage <player> <n> minecraft:generic_kill`
  for the exact rest - it passes armor, Protection and Resistance, and
  absorption is taken off with it. Food: Saturation adds `n` food and `2n`
  saturation at once, Hunger drains 0.005 x (amplifier + 1) exhaustion a tick.
  Precision: health to 0.01, food level exact, saturation from what it was to
  under a point over (Hunger takes it a whole point at a time), exhaustion
  within about 0.1 - except that nothing lowers exhaustion, so when no drain
  was needed it stays where the event left it, under one saturation point.
  Draining takes game time - up to about 10 s per player - so it runs in the
  background once their things are back (`restoreVitals`, one at a time per
  player): a stage tick or an arena end never waits on it. Somebody who logs
  off mid-drain keeps what it reached. Restored once and never by a retry from
  the panel. A peaceful world refills food on its own; not exact there.
- **Every step of an event waited for the next tick.** Measured on a live
  server, the game answers 200 commands in 15 ms; the time went on the trip
  into the container (about 60 ms from the host, more through hostd) and on
  the event loop's tick of 2 s, one step a tick: the join closed, then a tick
  later the start, a tick later the enrolment, the place, the site, the build,
  everybody brought in, the first look - 18 s from the join closing to the
  countdown for a two-player duel, 19 s for a dropper that also built its
  shaft one box a trip. The rules (`kinds/pace.ts`):
    - A step with nothing to wait for runs straight after the one before, in
      the same tick (`pace.STEPS_AT_ONCE`): the start follows the join window
      on its second, the first step follows the start, enrolled -> placed ->
      site held -> built -> brought in -> the first look at whether they are
      in. What really waits - the place searched, chunks slow to load, somebody
      not in yet, the 3-2-1 countdown, a fall settling, a stash's settle - still
      waits as before. Chunks just held get `LOAD_PAUSE_MS` (250 ms) in the
      tick before they are counted, and the ticks they always had after that.
    - What several players each need goes in shared trips
      (`pace.coalescing`): everybody's stash, give-back and health and hunger
      restore run side by side, their plain reads of one player through
      `sayEach`, their lines in one `sayAll`. A step costs about the same trips
      for 1 player or 30 (12 players' stash: 84 trips -> 4; give-back with the
      health restore: 60 -> 5). Only reads that answer the same through
      `sayEach` are shared (`PLAIN_READ`): nothing split by language, no paged
      read of `@a`, no `forceload`. A trip is kept to 12 KB of commands;
      answers past the 16 KiB a trip hands back are asked again together.
    - Block work is paced so no trip holds the server's main thread long: a
      build places at most one full `fill` (32,768 blocks) a trip to start
      with, two at most; a teardown scans eight fills' worth, 25 at most
      (`pace.buildPacer`, `pace.teardownPacer`). A trip that took more than
      `SLOW_TRIP_MS` longer than the quickest halves the next - a modded server
      with a slow tick gets smaller trips without reporting its tick - and a
      quick one doubles it again. A stage's boxes come down several to a trip
      only once every chunk under them answers loaded (`pace.allLoaded`), so a
      box that would not come out can never be passed by the ones after it.
    - Arenas are built where they always were, near the players, and every
      command is one each supported server accepts: nothing needs the Polaris
      mod or a data pack.
      Faster still needs code inside the server, and a restart to load it: a
      Polaris mod command, or a data-pack function walking a storage list with a
      macro (1.20.2+), would run a whole batch - every stash, every entry, every
      give-back, an inventory swap in memory - in one server tick and one trip.
      Not done: it would not reach a server without the mod or the pack.
- **King of the ring scored nobody once it got busy.** Only a player alone in
  the ring scored (`matches 1`), so with many in it nobody was ever ranked.
  Everybody in it scores now, and the one alone in it three times as much
  (`hill.ALONE_TIMES`), still in four lines however many play.
- **King of the ring started players outside the ring, and it closed as the
  round began.** Everybody started a block outside the edge, and the ring
  took its first step the moment "Go!" or a round's pause ended - on a short
  round, seconds later. Players now start `hill.START_MARGIN` inside the
  whole ring (`hill.startSpots`); knocked off, they come back at the edge as
  before. Nothing shrinks or moves for `hill.GRACE_SECONDS` after "Go!" and
  after each pause, and the ring is still at its smallest by the sprint.
