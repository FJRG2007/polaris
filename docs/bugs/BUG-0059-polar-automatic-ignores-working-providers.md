---
id: BUG-0059
title: Polar's Automatic answers on free models, or not at all, while the person's own providers work
status: fixed-watching
area: polar
location: dashboard/apps/web/src/lib/polar/models.ts
related:
  - dashboard/apps/web/src/lib/polar/automatic.ts
  - dashboard/apps/web/src/lib/polar/cooldown-store.ts
  - dashboard/apps/web/src/lib/polar/copilot-models.ts
  - dashboard/apps/web/src/lib/polar/unanswered.ts
  - dashboard/apps/web/src/app/api/polar/chat/route.ts
  - dashboard/apps/game-servers/src/lib/mcp-item-tools.ts
reported: 2026-11-25
fixed: 2026-11-25
fix_commit:
---

## What was seen

With several providers connected and working, Automatic kept handing turns to
free models, picked Copilot models the login cannot call, and some turns ended
on their tool steps with nothing written under them. Asked to give a Minecraft
player "another one like the one he holds", the assistant guessed the item
instead of reading the inventory, and could not give an item with its data.

## Cause

- Copilot's catalogue listed models the login's own `/models` does not serve,
  so Automatic picked them and every turn on them failed.
- Cooldowns lived in one process only: a restart or another worker forgot
  which providers had just refused, and a refused provider's free models sat
  ahead of the paid ones that worked.
- A model that ended with tool calls and no text left the answer empty.
- `games_player_give` took no item data and did not say to read the
  inventory first.

## Fix

- Copilot's models are read per login from its `/models` (kept 30 minutes,
  5 after a failure) and only those are offered.
- Candidates rank healthy, then failing, then out of credit; the ladder tries
  more paid models from the same provider before free ones. Cooldowns are
  mirrored to a `Setting` row per person and read back on resolve. The answer
  names the providers it passed over.
- An empty ending gets one more step with no tools and a nudge to answer; the
  model is kept off tool turns for a while, like one that writes its calls as
  text.
- `games_player_give` and `games_player_take` take optional data written the
  way the server's version reads it (components from 1.20.5, an NBT compound
  before), validated before it is sent or queued, and both tell the model to
  read `games_player_inventory` when the person refers to a held stack.

## If it happens again

Note which model answered (the line under the answer names it and any stand-in),
which providers the person has connected, and whether the turn offered tools.
