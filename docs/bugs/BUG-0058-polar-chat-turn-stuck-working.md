---
id: BUG-0058
title: A Polar Code chat stays on "working" after the agent's own turn, and Stop does not end it
status: fixed-watching
area: polar
location: dashboard/apps/web/src/lib/agents/acp/session-driver.ts
related:
  - dashboard/apps/web/src/lib/agents/acp/session-drivers.ts
  - dashboard/apps/web/src/lib/agents/acp/elicitation.ts
  - dashboard/apps/web/src/lib/agents/acp/pipe-commands.ts
  - dashboard/apps/web/src/lib/agents/codex/session-driver.ts
  - dashboard/apps/web/src/lib/agents/session-permissions.ts
  - dashboard/apps/web/src/lib/agents/session-prompt-queue.ts
  - dashboard/apps/web/src/components/polar/elements/queue.tsx
reported: 2026-11-26
fixed: 2026-11-26
fix_commit:
---

## What was seen

In a Polar Code session's Chat view, after the agent kept working on its own
(a background task finishing, a scheduled wake-up), the session stayed on
"working" with no end. Messages typed meanwhile waited in the list and were
never sent, Stop changed nothing on screen, and a message typed while an
approval was open landed in the agent's prompt instead of answering it.
AskUserQuestion never reached the Chat view.

## Cause

- The ACP driver only ended a turn when its own `session/prompt` resolved, so
  activity with no prompt open never ended and the queue never drained. Codex's
  `turn/completed` did not drain it either.
- Stop sent `session/cancel` and waited for the prompt to resolve; an agent that
  ignored it kept the session working forever.
- A closed agent connection mid-turn left the turn open.
- The client did not advertise form elicitation, so the adapter's
  AskUserQuestion had nowhere to go.

## Fix

- Activity with no prompt opens a cycle that ends after a quiet spell (5 s with
  no open step, 120 s with one, paused while a request waits); the turn end is
  recorded and the waiting list is sent (`afterTurnEnd`), also on Codex.
- Stop leaves "working" at once and shows "Stopping...", then escalates every
  3 s: INT and TERM to the agent's processes (`acpSignalCommand`), then closes
  the connection.
- An agent that exits mid-turn fails it with a sentence; the next message starts
  it again.
- A message at an open approval denies it with the message as the reason; queued
  rows keep their files and model and carry Send now, Edit and Remove buttons.
- AskUserQuestion arrives as `elicitation/create` and opens the question card,
  option previews included.

## Verified

Unit tests against a fake ACP pipe (`test/agents/acp/turn-lifecycle.test.ts`,
`elicitation.test.ts`, `pipe-commands.test.ts`), the Codex driver, the queue
and permission rules, and the queue row and Stop button components. Not run
against a real agent in a container (no Docker on the development machine).

## If it happens again

Note which view (Chat or Terminal), the agent, whether a background task was
running, and whether Stop showed "Stopping..." and for how long.
