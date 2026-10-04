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
   `joinersNeeded`, `awardsPrizes`.
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
   option's default must not also reach into a race in progress.
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
5. **Editor**: put the kind's fields in `event-editor.tsx`, or in an
   `event-options-<kind>.tsx` of its own once they grow. Add a screen test that
   saves the defaults and one changed value.
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
Rare catch, Bingo rush) leave the world alone.

| Kind                                                           | Time  | Weather |
| -------------------------------------------------------------- | ----- | ------- |
| Build battle, Spleef, Parkour, King of the ring, Team duel     | day   | clear   |
| Treasure hunt, Supply drop, Explorer, Gathering                | day   | clear   |
| Horde defense, Villager defense, Mob hunt, Meteor shower       | night | clear   |
| Blood moon                                                     | night | rain    |
| World boss                                                     | -     | clear   |
| Mining rush, Fishing, Trivia, Happy hour, XP boost, Rare catch | -     | -       |
| Bingo rush                                                     | -     | -       |

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
      the ring whole, in the middle, everybody back on their spot; from the
      second on, `RING_PAUSE_SECONDS` of nothing counted first.
    - It shrinks a block at a time (`shrinks`) to `hill.leastRadius`: enough
      ground for `ROOM_EACH` blocks a player, never under `LEAST_RADIUS` (2),
      never over its own radius. Two players fight over a ring of two, sixteen
      over one of four. It is at its smallest when the round's double points
      start.
    - It drifts a block every `MOVE_SECONDS` (`moves`) toward points drawn from
      the run's id, never past `MARGIN - 1` beyond its first edge, so it stays
      on the platform's own floor.
    - The last `SPRINT_SECONDS` of a round (at most a third of it) count double.
    - Only time alone in it counts (`hill.scoreLines`, counted in the game in
      the same tick): two in it and neither scores.
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
      first, so from 1.19.4 the wave is turned on the villager: every monster
      no defender stands next to is touched by the villager with `/damage`
      (`generic`, which pushes nothing back), and goes for whoever hit it.
      Striking it draws it off again. Before 1.19.4 there is no such command
      and they go for the villager only when no player is in sight.
    - Its health is the boss bar (red), with where the waves stand beside it;
      everybody is told once under half and once under a quarter.
    - Missing for two looks in a row (`LOST_AFTER`: a restarted server loads
      entities a moment after their chunks), it is dead: the event ends there,
      with no podium and no prizes, and the results say why. Otherwise the
      waves play out and the podium goes to the most kills.
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
      what they dropped), crafted, smelted or traded for. A stack carried in
      or taken out of their own chest marks nothing. It is all worked out in
      the game, every player in one batch a look, and kept on the scoreboard
      (`pe_bg*`), so a restart finds the marks; a mark is never taken back.
    - The card is shown to everybody at the start, each item named by the
      game in the reader's own language (`block.minecraft.*`,
      `item.minecraft.*`); each mark is told to its player with their card,
      their count and what is left are on their action bar, and the side
      panel shows everybody's count.
    - `goal`: the first full row, column or diagonal (`line`), or the whole
      card (`card`), ends it and wins, whatever the least to be ranked;
      nobody seen in creative or spectator can. Two in the same look: the
      most marked, then the name. With time up, the most marked win (the
      least to be ranked applies), a tie to whoever got there first.
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
  30 jumps by default (10 to 60). It takes one of two shapes, drawn among
  those switched on (`shapes`, both by default): rows climbing back and forth,
  or a tower climbed round its four sides (`parkour-layout.TOWER_SIDE`). From
  any platform only the next one is within a jump (see "Building a map"
  below), and a checkpoint counts only straight after the one before it.
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
- **Enforced in the game too**: a checkpoint is reached only from the one
  before it (`quickSelectors`), and a racer seen past their next checkpoint
  (an ender pearl, a push) is sent back to their own with "No shortcuts".
- **A layout change bumps `parkour.DESIGN`**, written onto the stage when it
  is built, so a course standing across an update keeps the layout it was
  built with.

## How the floating maps look

Everything below is part of the arena's own boxes: built into air with
`keep`, and taken out with the rest.

| Arena            | Look                                                                          |
| ---------------- | ----------------------------------------------------------------------------- |
| Spleef           | each floor walled in its own color, a sea lantern on every corner post        |
| Parkour          | the course's theme, a light under every checkpoint                            |
| King of the ring | polished stone edge, sea lanterns at the corners, the circle drawn in yellow  |
| Build battle     | a stone curb between plots and glowstone where the lines meet, at floor level |
| Team duel        | a stone rim round the floor and a post of light at each corner                |
| Boss sky arena   | glass, with a pillar of sea lantern at each corner                            |

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
- **Read answers the way a real server writes them.** That includes a team
  prefix, Bedrock's leading dot, several answers run together, and a crowd
  too big for one answer, which is read in pages (`replies.ts`). Scores read
  the naive way paid nobody's podium (`0896c370e`, `a6960fd77`).
- **An empty answer to a ground check means natural ground**, because that is
  what a real server gives (`8b21a38fb`).
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
      (`40bcd010c`, `4f5b2ccc3`).
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
- **A layout drawn from the run's id is checked against its rules and drawn
  again until it passes**: platforms never touch, every jump has head room,
  slime pads only where the bounce lands. Its version (`parkour.DESIGN`) is
  kept on the run, so a course built before an update stays as it was
  (`c19b87280`, `9615bcd75`).
- **A choice drawn per run stays the same after a restart**: it is seeded by
  the run's id (`trivia-bank.seeded`), never `Math.random()`, and a change to
  what can be drawn keeps the draw of a run saved before it
  (`spleef.variantFor`).

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

- **A line about what was just done goes away after a few seconds.** A failed
  read is tried again on the next beat. Live reads have a time limit
  (`f7b2a8a6b`).
- **Every refusal and waiting reason is written in the reader's language**,
  and the draw's state (next draw, why it waits, the last drawn event) is on
  screen (`04155e870`, `ec91d0ca2`).
