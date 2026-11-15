# Runner phase 1 (server side) - remaining steps

Done on `feat/runner-relay`: protocol + relay core (`packages/core/src/runner-protocol.ts`,
`runner-relay.ts`, 19 tests), Prisma `AgentRunner` / `AgentRunnerCommand` /
`AgentSession.runnerId` (migration `20271120000000_agent_runners`), pairing + credential
(`apps/web/src/lib/computers/computer-service.ts`, `POST /api/computers/pair`), cross-node
command fan-out (`computer-commands.ts`, NOTIFY `polaris_runner` + parked commands),
inbound frames (`computer-inbound.ts`, `POST /api/computers/relay`, internal key), shared
hook ingest (`lib/agents/session-hook-ingest.ts`, used by the events/permission routes),
place `computer` in core + start schema (`runnerId`), runtime dispatch in
`session-runtime.ts` (start/prompt/interrupt/stop/mode/model/effort), ownership + offline
check in `components/agents/sessions/actions.ts`. Web tsc was clean before the last edit.

Remaining, in order:

1. Sidecar (`apps/web/ws-server.mjs`): switch both servers to `noServer` and route
   upgrades by path; `RUNNER_SOCKET_PATH` (`/api/deploy/ws/runner`, already under the
   priority-100 `polaris-ws` router, so no new Traefik router) -> `new RunnerRelay({...})`
   from `@polaris/core/runner-relay`, token from `Authorization: Bearer`, `maxPayload =
   RUNNER_LIMITS.frameBytes`; `authenticate`/`presence`/`deliver` POST loopback to
   `/api/computers/relay` (ops `auth`, `presence`, `frame`; frame timeout >= 135 s for
   permission prompts); `setInterval(() => relay.sweep(), 5000)`; in `handleInternal`
   answer `POST /runner/send` (internal key, body `{runnerId, command}`; `command.type ===
   "close"` -> `relay.close`) with `{held}`. Agent terminal tickets for a computer session:
   `relay.watchTerminal` + `terminal.attach/input/resize/detach` frames (same node only;
   cross-node terminal output is not relayed yet - say so in the doc).
2. Polar Code start path: `lib/polar/agents/shared.ts` must run the same computer
   ownership/offline check as `actions.ts` and pass `runnerId`; composer
   (`components/polar/polar-code.tsx`, `place: "local"` hardcoded near line 1005) needs a
   "This computer" picker (async picker, no native select) fed by `listComputers`.
   Also check `lib/mcp/tools/sessions.ts` place resolution and fork (`session-fork.ts`).
3. UI `/account/computers` ("Your computers"): pair dialog (code via `openPairing`,
   `formatUserCode`, QR with `qrcode.react` encoding the code; poll `pairingWaiting`),
   list (online, last seen, OS, CLIs), rename (`renameComputer`), revoke with dialog
   (`revokeComputer`); nav entry in `lib/apps.ts` + `messages/*/nav.json`; i18n en-US/es-ES.
4. Tests (apps/web/test/computers/): `createRunnerCommands` fan-out with fake deps
   (local, inline NOTIFY, parked, wrong node ignored, invalid command dropped),
   `startFrame`, inbound session scoping (mock prisma), pairing claim single-use.
5. `docs/runner-protocol.md`: transcribe `runner-protocol.ts` (frames both ways, limits,
   close codes, pairing `POST /api/computers/pair` -> `{runnerId, token, socketPath,
   protocol}`, hooks via HTTPS report URL or `hook` frames, permission.request/decision).
6. Verify: web tsc, `npx vitest run test/i18n test/computers --maxWorkers=2`,
   core tests, migrations-rerunnable test.
