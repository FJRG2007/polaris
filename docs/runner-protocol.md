# Runner protocol

A runner is the small daemon on somebody's own computer that lets Polar Code
drive the coding tools installed there (Claude Code, Codex, opencode and the
rest) from any device. It dials out to Polaris over one WebSocket and never
listens on a port.

The source of truth is `dashboard/packages/core/src/runner-protocol.ts`: every
frame below is a Zod schema there, and both ends validate with it. This page is
the prose version.

## Pairing

1. The person opens **Your computers** (`/account/computers`) and presses
   **Pair a computer**. Polaris shows an 8-character code (grouped `ABCD-2345`
   for reading, also as a QR). It works once, for 10 minutes; pressing Pair
   again replaces it.
2. The runner posts it:

   ```http
   POST /api/computers/pair
   Content-Type: application/json

   { "code": "ABCD-2345", "name": "Work laptop" }
   ```

   `name` is 1 to 60 characters (the machine's hostname is a good default).
   Separators and case in `code` are ignored. The route is rate limited to 10
   attempts per address per 10 minutes.
3. The answer, exactly once:

   ```json
   { "runnerId": "<uuid>", "token": "plr_run_...", "socketPath": "/api/deploy/ws/runner", "protocol": 1 }
   ```

   Errors: `400 {"error":"invalid_request"}`, `400 {"error":"invalid_code"}`
   (wrong, spent, expired, or the account is at its 20-computer limit),
   `429 {"error":"rate_limited"}` with `Retry-After`.

The token is stored server-side only as a hash. Forgetting the computer on
the screen deletes it and closes the socket with `4005`.

## Connecting

Open a WebSocket to `wss://<polaris host><socketPath>` with
`Authorization: Bearer <token>`. The path sits under the prefix the edge
already forwards to the WebSocket sidecar, so no new route is needed.

Every frame is a JSON **text** frame carrying `v` (the protocol version it was
written for, currently `1`) and `type`. A binary frame closes the connection.
The runner must send `hello` within 10 seconds; the server answers `welcome`.

## Limits

| Limit | Value |
| --- | --- |
| Frame size, either way | 1 MiB |
| Prompt | 100,000 characters |
| Hook payload | 256 KiB serialised |
| Terminal chunk | 64 KiB before base64 |
| Heartbeat interval | 20 s |
| Silence before the server drops the socket | 60 s |
| `hello` deadline | 10 s |
| Rate | 200 frames/s, bursting to 400 |
| Unsent bytes held per runner before terminal input is refused | 4 MiB |
| Sessions per runner | 32 |

## Close codes

| Code | Meaning | Runner should |
| --- | --- | --- |
| 4001 | Credential missing, wrong or revoked | Stop; pair again |
| 4002 | Protocol mismatch, or no `hello` first | Update |
| 4003 | Replaced by a newer connection of the same runner | Not reconnect from this process |
| 4004 | Heartbeat timeout | Reconnect |
| 4005 | Removed from the account | Forget the credential |
| 4008 | Rate limited | Reconnect after a pause |
| 4009 | Frame too large | Fix the sender |

## Runner -> server

| `type` | Fields | Notes |
| --- | --- | --- |
| `hello` | `runnerVersion`, `protocol: {min, max}` | First frame. Refused unless the range includes the server's version. |
| `capabilities` | `os: {platform, release, arch}`, `hostname`, `shells[]`, `clis[] {id, version, path?, signedIn: yes/no/unknown}`, `maxSessions` | Shown on Your computers. `unknown` sign-in is never an error. |
| `heartbeat` | `sessions[]` | Every 20 s; answered `heartbeat.ack`. |
| `session.started` | `sessionId`, `workdir`, `branch?` | |
| `session.ended` | `sessionId`, `reason: exited/stopped/failed`, `exitCode?`, `detail?` | |
| `hook` | `sessionId`, `seq?`, `payload` | A vendor hook payload as the CLI handed it. Same handling as the HTTP hook route. |
| `event` | `sessionId`, `kind`, `detail` | For a CLI without hooks, in Polaris's normalised vocabulary. |
| `permission.request` | `requestId`, `sessionId`, `payload` | Waits on a person (up to about two minutes); answered with `permission.decision`. |
| `terminal.output` | `sessionId`, `seq`, `data` (base64) | Never stored; fanned out to viewers. |
| `error` | `code`, `message`, `sessionId?` | |

A frame about a session only counts for a session placed on that runner;
anything else is answered `error` `unknown_session`.

## Server -> runner

| `type` | Fields |
| --- | --- |
| `welcome` | `runnerId`, `protocol`, `limits` |
| `heartbeat.ack` | |
| `session.start` | `sessionId`, `cli`, `command`, `model`, `effort`, `permissionMode`, `repository` (`clone` with an https `url` and `fullName`, `path`, or `none`), `branch`, `baseRef`, `worktree`, `prompt`, `report: {url, token}`, `cols`, `rows` |
| `prompt` | `sessionId`, `text` |
| `interrupt` | `sessionId` |
| `session.stop` | `sessionId` |
| `session.settings` | `sessionId`, `permissionMode?`, `model?`, `effort?` |
| `permission.decision` | `requestId`, `sessionId`, `decision` (the JSON the CLI's hook prints) |
| `terminal.attach` / `terminal.detach` | `sessionId` (+ `cols`, `rows` on attach) |
| `terminal.input` | `sessionId`, `data` (base64) |
| `terminal.resize` | `sessionId`, `cols`, `rows` |
| `error` | `code`, `message` |

### Hooks

`session.start.report` carries the same per-session reporting token a container
session's hook script uses. The runner may post the CLI's hooks to
`report.url` over HTTPS (exactly as a container does), or relay them as `hook`
and `permission.request` frames. Both land in the same code
(`lib/agents/session-hook-ingest.ts`).

## How it runs inside Polaris

- `apps/web/ws-server.mjs` routes upgrades by path: `/api/deploy/ws` for
  terminals, `RUNNER_SOCKET_PATH` for runners, handed to one `RunnerRelay`
  (`packages/core/src/runner-relay.ts`) through `apps/web/runner-sidecar.mjs`.
- The relay checks the credential, then posts every frame except terminal
  output to `POST /api/computers/relay` (loopback, internal key; ops `auth`,
  `presence`, `frame`, `command`, `output`).
- A command from any node reaches the runner's node through
  `lib/computers/computer-commands.ts`: direct to the local sidecar
  (`POST /runner/send`), otherwise `pg_notify('polaris_runner', ...)`, with
  commands too large for a NOTIFY parked in `AgentRunnerCommand` (collected
  once, swept after 5 minutes).
- Terminals: an `agent` ticket for a computer session redeems to the runner and
  session. When the viewer's sidecar holds the runner, output goes straight
  from the relay to the viewer. Otherwise the viewer's node sends a `watch`
  command to the runner's node (renewed every 30 s, expired after 90 s
  without renewal); that node posts each chunk to its web app, which sends it
  over `pg_notify('polaris_runner_term', ...)` in pieces under the NOTIFY
  limit; the viewer's web app hands it to its sidecar on `POST /runner/output`.
  Each remote watch holds at most 256 KiB in flight and drops output past that,
  like a slow local viewer. Input and resize travel as ordinary commands, in
  order.
