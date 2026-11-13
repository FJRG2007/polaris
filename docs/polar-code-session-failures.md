# Polar Code session failures

A ledger of every way a Polar Code session has failed to answer, what caused it,
what fixed it, and what stops it coming back. Add an entry for each new failure
mode, with the evidence that proved the cause - never a guess written as one.

Status values: **fixed** (cause proven, fix shipped, regression test in place),
**open** (cause not proven yet), **watch** (fixed, but the evidence that would
show a recurrence is listed).

| # | Symptom on screen | Cause | Status | Fix |
|---|---|---|---|---|
| PC-1 | Session ends a few seconds after starting, 0 tokens, no reply | Not proven; consistent with PC-3 | watch | 433464ebce stores the `SessionEnd` reason |
| PC-2 | "Starting" for hours, then "Polaris could not send the first prompt: its agent never opened a terminal to type into" and "The machine running this session stopped reporting" | Not proven on the old build; boot works on 8bc8928dc6 | watch | - |
| PC-3 | "API Error: 400 This API key is not scoped to a workspace..." although a Claude subscription was picked | A stored Anthropic API key was handed to the agent beside the picked subscription | fixed | 3f7c9fa8fc |
| PC-4 | Screen shows "Starting" well after the agent has answered | Not proven | open | - |
| PC-5 | A second "No repository" session refused: "You already have a workspace session open, and it is the same directory this one would use" | A guard written for a token that no longer lives in the workspace | fixed | this change |
| PC-6 | Second session on one enrolled server cannot start (any repository) | Every server session used the same tmux server, session name and `/tmp` flags | watch | this change |

## PC-1 - session ends at start with no reply

- **Seen:** 2026-11-10 on the reference server. The last eight sessions (Claude
  Code, place `local`, both "machine login" and a picked subscription) ended
  6-199 s after start with a `session.end` hook event and `tokensOut` 0.
- **Why it was not diagnosed:** the hook's `reason` was not stored, so every end
  looked the same. 433464ebce keeps it in the event detail and shows it.
- **Likely link:** the sessions with a picked subscription match PC-3 exactly
  (Claude Code exits its turn on the 400). Machine-login sessions get no stored
  credential at all, so for those the home's own login is what answered.
- **If it recurs:** read the `session.end` event detail (the reason) and the
  `turn.failed` event before it.

## PC-2 - stuck on "Starting", then "never opened a terminal"

- **Seen:** session `a7f28dd9`, 2026-11-12 21:44 UTC, on a build from before
  8bc8928dc6. `lastAliveAt` stayed null, zero `AgentSessionEvent` rows, and the
  sweep failed it at 03:46 with "The machine running this session stopped
  reporting". Its container was gone by the time anyone looked, and the daemon
  logs nothing per request, so the cause was not recoverable.
- **Code path:** `deliverFirstPrompt` -> `waitForAgent` (session-runtime.ts)
  throws "its agent never opened a terminal to type into" when neither the runner
  nor the agent reports ready; the cron sweep writes the "stopped reporting"
  sentence.
- **After updating to 8bc8928dc6:** session `ece844d2` (2026-11-13) booted
  normally: container created 11:27:24, tmux session 11:27:35, runner ready and
  prompt delivered by 11:28:01 - 37 s end to end. It then hit PC-3.
- **If it recurs:** capture the boot live with the watcher below; the container
  is removed on failure, so evidence has to be taken while it runs.

## PC-3 - subscription picked, API key used

- **Seen:** session `ece844d2`, 2026-11-13 11:28:02 UTC: `turn.failed` with
  "API Error: 400 This API key is not scoped to a workspace, so this request must
  include the anthropic-workspace-id header".
- **Evidence:** the session's `accountId` pointed at the owner's stored
  `agent-signin-claude-code-oauth-token` ("Personal"). The same owner also holds
  an `anthropic` model key with no workspace in its config.
- **Cause:** `sessionCredentials` (lib/agents/agent-readiness.ts) returned the
  picked account *merged over* `credentialsForAgent`, which carried every
  credential in the tool's catalogue entry - so the container got both
  `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`. Claude Code reads
  `ANTHROPIC_API_KEY` before `CLAUDE_CODE_OAUTH_TOKEN`, so the key answered,
  and a key not scoped to a workspace is refused on every request. The same
  merge applied with nothing picked.
- **Fix (3f7c9fa8fc):** a picked sign-in account is handed alone. With nothing
  picked, a tool's credentials are treated as alternatives: when a subscription
  credential resolves, the non-subscription ones stay behind.
- **Regression tests:** `test/agents/api-key-options.test.ts` ("is the picked
  account alone for a subscription", "the plan over a key otherwise") and
  `test/agents/session-credentials.test.ts`.
- **Rule this encodes:** a tool's `credentials` list in
  `packages/core/src/agent-clis.ts` is a list of *alternatives* in order of
  preference, never a set to hand over together. Any new code that builds a
  session's environment goes through `sessionCredentials`.

## PC-4 - "Starting" shown after the agent answered

- **Seen:** session `ece844d2`. The server had the whole exchange recorded by
  11:28:03 (`session.start`, `prompt`, `turn.failed`, state `idle`), but the
  person saw "Starting" for a long time before the error appeared.
- **What the code does:** the open thread re-reads `/api/polar/code/thread`
  every 3 s while the session is live and the tab is visible
  (`THREAD_MS`, components/polar/polar-code.tsx); the history list every 10 s.
  A failed read sets `failed` and keeps the last answer on screen.
- **Not proven yet:** whether reads failed, the tab was hidden, or the label
  comes from a stale cached overview (`polar.code.overview.v2`).
- **Next time:** open the browser's network panel on the thread, or check the
  web container's log for `/api/polar/code/thread` errors in the same minute.

## PC-5 - a second workspace session refused

- **Seen:** 2026-11-13 on the reference server: starting a second "No
  repository" session while one was open was refused with "You already have a
  workspace session open...". People run several agents on one project at once,
  so this blocked the main way Polar Code is used.
- **Cause:** `workspaceRefusal` (lib/agents/session-capacity.ts) refused any
  second live session in the same workspace directory. Its reason - the
  session's reporting token written into `.claude` / `.mcp.json` in that
  directory - stopped being true when the hook script, hook settings and MCP
  config moved to the per-session state directory (`stateDirFor`,
  session-runtime.ts; `--settings` / `--mcp-config` in the launch script). On a
  container session that directory is the session's own mount; on a server it
  is `~/.polaris/sessions/<id>/polaris`. Nothing per-session is in the workspace.
- **Fix:** an own workspace (own home, own server) is never refused; the
  account and deployment ceilings still apply and queue past them. Only the
  shared machine while somebody else works in it is refused.
- **Regression tests:** `test/agents/session-capacity.test.ts`
  ("lets one person open a second and a third session...").

## PC-6 - two sessions on one enrolled server

- **Found by reading the code**, not seen on a server: a server session runs
  straight on the machine over SSH, and every one used tmux's default socket
  with session name `polaris-agent` and the fixed `/tmp/polaris-agent-started`
  flag. The second boot's `tmux new-session -s polaris-agent` fails on
  "duplicate session" under `set -eu`, and the steering commands of both
  sessions would address the same terminal.
- **Fix:** `hostSessionScope` (session-commands.ts) prepends, to the boot and to
  every command run for that session, a `TMUX_TMPDIR` and `TMPDIR` of
  `~/.polaris/sessions/<id>/tmp`; the ready flag and the setup's temporary files
  read `TMPDIR`. Only exported where the directory exists, so a session booted
  before the update keeps its default socket.
- **Unverified:** not exercised on a real server from here (no SSH target, no
  Docker on the development machine). If it recurs: `ls
  ~/.polaris/sessions/*/tmp` on the server and `TMUX_TMPDIR=<that> tmux ls`.

## How to diagnose a failing session

All read-only, on the server, never on the development machine (no Docker there).

1. The session row: `select row_to_json(s) from "AgentSession" s where id::text like '<prefix>%'`
   - `state`, `detail`, `accountId`, `useMachineLogin`, `lastEventAt`, `lastAliveAt`.
2. Its events in order: `select "createdAt", kind, detail from "AgentSessionEvent" where "sessionId" = '<id>' order by "createdAt"`.
3. Which credential it was given: look up `accountId` in `"UserModelKey"`
   (`provider`, `name`, `config`) - never print the secret.
4. While it runs: the container `polaris-session-<id>`; `tmux ls` and
   `tmux capture-pane -p -t polaris-agent` inside it show what the agent printed.
5. A boot that dies before anyone looks: run a watcher on the server that, for
   every new `polaris-session-*` container, follows `docker logs` to a file and
   snapshots `tmux capture-pane` and `ls /tmp` every few seconds. The container is
   removed on failure; the snapshots are the only record.

## Keeping these from coming back

- Every new failure gets an entry here with its evidence before it is called fixed.
- A fix lands with a test that fails on the old behaviour.
- Error text shown on a session must name what to do (the credential, the
  workspace, the login) - not only the vendor's message.
