# U13 - what is left

Done on `feat/ao-codex-accounts`: per-account Codex homes (`lib/agents/account-homes.ts`,
wired in `refreshCredentials`), the explicit switch (`switchSessionAccount` in
`account-rotation.ts`, `switchSessionAccountAction` / `sessionAccountsAction`, Polar Code
routes `/api/polar/code/account(s)`, `components/polar/code-account-switch.tsx`), i18n en-US + es-ES, tests.

Remaining:

1. **Codex usage-limit detection.** Codex runs no Stop hook on a turn whose model request
   failed (AO `adapters/agent/codex/turn_failures.go`), so `handleTurnFailure` never hears a
   Codex limit and automatic rotation does not fire for Codex yet (the classifier and the
   rotation itself already handle Codex text, see `test/agents/account-switch.test.ts`).
   Port AO's `LastTurnFailure`: on the next hook or history sync, read the rollout tail
   (`decodeCodexLine` path in `transcript-decoders.ts`), find the newest turn boundary, and
   when it is an `event_msg` `task_complete` carrying `error`, call `handleTurnFailure` with
   `{ message: <error text> }` and a sequence derived from the record so it runs once.
2. **Not exercised in a container.** The account-home script (`accountHomeCommand`) is
   asserted as text only; Docker is not available on this machine. Check on a real session:
   symlinks to `~/.codex` entries, `CODEX_HOME` in `credentials.env`, resume across a switch.
3. **An agent mid-turn in its interactive interface** keeps its current account until the
   turn ends or it exits; the switch then resumes on the new one. A forced quit-and-resume
   of a running interactive agent is not done.
