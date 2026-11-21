# BUG-0009 - The world optimizer removed chests, beds and signs, and left the world unsaveable

- **Area:** Game servers (Minecraft world optimizer)
- **Status:** Fixed, watching
- **Reported:** 2026-11-21
- **Location:** dashboard/apps/game-servers/src/lib/minecraft/world-trim-script.ts

## What was seen

On a live Forge 1.20.1 modpack server, the world optimizer ran on its own at
05:05 on a stopped server, with no backup. It removed 20,678 of 24,773 overworld
chunks (147 MB to 38 MB). 443 of the removed chunks held block entities - 199
chests, 12 beds, 65 signs, barrels, furnaces. When the server came back, every
save failed with `java.nio.file.AccessDeniedException` (about 75,000 log lines):
the rewritten `region`, `entities` and `poi` files were owned by `root:root`
0644 and the server runs as uid 1000.

## Cause

- The script decided on `InhabitedTime` alone ("nobody builds without standing
  there"). Every one of the 443 chunks had an `InhabitedTime` of 0. Mods,
  pregenerators, Distant Horizons, chunk loaders and imported worlds all leave
  chunks with content and no inhabited time.
- The script runs as root in a throwaway container (hostd `deploy_world_trim`,
  or `docker run` over SSH) and moved its rebuilt files into place without
  restoring the original owner or mode.
- An automatic run had no backup: the backup was the container's own `tar`,
  which needs the server up, so the sweep skipped it on stopped servers.
- Companion files (`entities/`, `poi/`) were rebuilt with only the region's
  surviving slots, which also dropped entries for chunks absent from the region.

## What was changed

- Automatic runs are off for every server (`AUTOMATIC_TRIM_DISABLED`, commit
  18372625d0). The automatic switch is gone from the screen.
- A chunk now goes only if it has no block entity, no entity (in the chunk or
  in `entities/`), no point of interest in `poi/`, no mod attachment
  (`ForgeCaps`, NeoForge or Fabric attachments), and inhabited time not above
  the threshold. Anything it cannot read is kept. Companions only lose the slots
  their chunk file lost.
- Two refusals stop a run before anything is written:
  - a player's overworld logout chunk with `InhabitedTime` 0 means the world
    does not count inhabited time;
  - removing more than half of a dimension's finished chunks (chunks with a
    `Status` short of full never became playable and are not counted). A played
    world loses about a third; more means the chunks came from something other
    than people walking about, which is where inhabited time stops being
    evidence. The incident world (83%) would be refused.
- The script backs up first, every time: the level and its `_nether`/`_the_end`
  folders go into `backups/` under the normal backup name, the copy is read back
  in full and must hold `level.dat` and every file about to change at its current
  size. No verified copy, no rewrite. The button has no option to skip it; the
  result offers "Restore the backup".
- Every rewritten file gets the owner and mode of the file it replaces before
  the move (a new file takes its folder's owner).
- `game-world-owners`, a once-per-server sweep, hands `.mca` files under
  `region/`, `entities/` and `poi/` back to the owner of `level.dat`: through
  the server's exec when it is running, through the optimizer's own route with
  an ownership-only script when it is stopped.
- The World screen tells the operator about any past run that removed chunks
  and was not started from the button since this fix, lists the backups from
  before it with a Restore button, and goes away on "Everything is still there".

## Verified

- `apps/web/test/apps/game-world-trim-script.test.ts` runs the real script with
  Python against region, entities, poi, level.dat and player files built in the
  test (zlib/gzip NBT): block entities, entities, POI, mod attachments, unknown
  formats and unreadable chunks are kept; companion slots are never trimmed on
  their own; both refusals change nothing and take no backup; the backup is
  listed and holds the world; dry runs change nothing; chown/chmod are called
  with the original's uid/gid/mode; the ownership repair changes only `.mca`
  files under the three folders.
- Typecheck and the game-world-trim, cron and i18n suites.

## Not verified

- No run inside a real server container (no Docker on the development
  machine): the backup and chown as root, and the exec-path repair on a running
  server, are exercised only by the tests above.

## If it happens again

Collect the server's `worldTrimRun` and `worldOwnersRepaired` install config,
`ls -ln` of the level's `region/`, `entities/` and `poi/`, and the report line
the script printed (it is the last JSON line of the run's output).
