---
id: BUG-0074
title: A Chat reply that asks the person a question is sent back by Enigma, and a second, odd answer follows
status: fixed-watching
area: polar
location: dashboard/apps/web/src/lib/agents/acp/pipe-commands.ts
related:
  - dashboard/apps/web/test/agents/acp/pipe-commands.test.ts
  - packages/core/src/enigma.ts
reported: 2026-11-28
fixed: 2026-11-28
fix_commit:
---

## What was seen

Polar session 6879e6dd, Chat view, Claude: a casual conversation about a house
layout and which speakers to buy. The agent rightly asked which sound system the
person would buy, since that is their money. The turn did not end there: the
person then saw a second reply, "No sigo con el plano todavía, y no es una pausa
por costumbre...", answering something they never said.

## Cause

Enigma is installed into every session home, and its Claude Code `Stop` hook
(`enigma __verify-hook`) judges each turn end as if it closed a piece of coding
work. It read the question as "ending the turn by asking whether to continue",
denied the stop, and Claude was made to keep going - answering the hook instead
of the person. Its self-audit runs inside the same hook.

The home is the account's, kept across sessions, and a Chat and a Code session
of one account can run at once, so switching `verify` off there
(`enigma config verify off -g`) would also switch it off for Code sessions. The
hook reads `<cwd>/.enigma.json` too, but that is the checkout, which a file
dropped there could get committed from.

## Fix

The Chat view's launch script (`ACP_LAUNCH_SCRIPT`) exports `ENIGMA_GATE=1`
before it starts the agent. Enigma's verify hook returns before reading anything
when that variable is "1" (`isGateAgentRun()` in `packages/enigma-cli/src/util.ts`
and `verify.ts`, checked in the v1.73.0 source the sessions pin, and in the 1.72.2
and 1.80.0 binaries); in those versions nothing else reads it. Being an
environment value of that one process, it reaches the adapter, Claude and the
hooks Claude runs, and nothing the terminal starts: the terminal's launch,
runner, interface, relaunch and boot scripts never set it, so a session in the
terminal - and every Code session - keeps the check. The launch script is
rewritten on every Chat launch, so existing installs and sessions get it with
the update, with no setting.

## Verification

`test/agents/acp/pipe-commands.test.ts`: the launch script's prefix, run under
`sh` with no `ENIGMA_GATE` in the environment, hands a child process
`ENIGMA_GATE=1`; no terminal or boot script mentions it. Web typecheck. A real
session container was not run (no Docker on the development machine), so the
hook's behaviour inside one is read from Enigma's source, not observed.
