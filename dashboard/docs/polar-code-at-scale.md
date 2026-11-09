# Polar Code at scale

How a Code session finds a machine, starts fast, and shows its work. Settings
live under Polaris apps > Polar > Settings (`/admin/apps/polar/settings`).

## Where a session runs (`lib/agents/session-placement.ts`)

- The pool is this box (on unless switched off) plus any enrolled server with a
  container engine, each with the number of sessions it may hold. Stored as
  `polar.code.pool`; the box's number is the existing `agents.sessions.total`.
- The deployment-wide ceiling the queue enforces is the pool's sum, so adding a
  server raises it with no other change.
- Placement follows E2B's orchestrator (`placement_best_of_K.go`): filter the
  machines with room, sample three, take the least full by share. Sampling keeps
  it constant-time however many servers there are.
- A session prefers the machine its account's home is on (where the installed
  tools are), while that one has room.
- A server that refuses the start is left out and the session is placed again
  elsewhere. A server that is offline, switched off or has lost its engine is
  skipped until it is back.
- Never moved off the box: the shared machine and sessions on the box's own
  login, because both live in the box's home.
- A container session on a pool server stores the server as `hostId`, with
  `place` still `local`. `lib/agents/session-ports.ts` turns that into the
  engine: the host daemon for the box, SSH for a server. Every container call
  (start, steer, probe, save work, release, terminal) goes through it.
- Leftovers on pool servers are found from the session rows, not by listing
  every server (`reapPoolLeftovers`).
- Each pool server is asked, over its SSH, to fetch `/api/health` at the
  address sessions report to (`lib/agents/pool-reach.ts`): at once when it is
  added on the settings screen, then by the cron every 10 minutes, a few
  servers a run. The screen shows the answer beside the server. One that could
  not reach Polaris is left out of placement until a later check finds that it
  can, or for an hour at most: its sessions would never report back.

## Starting before the message is sent (`lib/agents/session-spares.ts`)

Measured on a home server: creating the container 0.36 s, installing tmux
2.7 s, starting Claude Code 0.6 s.

- While someone has Code open, Polaris starts one container for them on the
  machine their session would go to, running `SPARE_BOOT`. It installs tmux and
  then waits for `/session/claim.env`.
- Sending the message creates the session under the spare's id, so the
  container already has the session's name. The session's environment is
  written to the claim file and the boot continues from there. Measured: 0.18 s
  from the claim to the agent's terminal being opened.
- With no spare, or one that cannot be claimed, the session starts the ordinary
  way under the same name.
- The pattern follows Coder prebuilds (a count, an expiry, a reconcile loop) and
  OpenHands deferred init (a spare knows nothing until one call gives it the
  session). Unlike them, a spare is per person: a running container cannot be
  given a mount, and every session mounts its account's home.
- Cost: a waiting spare used 2.8 MB of memory and no CPU. At most `perServer`
  per machine; one expires `minutes` after Code is closed.
- Kept in the `AgentSpare` table, one row per account, taken with a
  conditional delete so two tabs cannot both take it. Counted per server with a
  grouped read over `(hostId, expiresAt)`, swept by `expiresAt` in batches of
  200, and looked up by id for the leftover sweep - nothing reads every spare.
  Reservations from before the table (settings rows `polar.code.spare.u.*`)
  are taken down with their containers by the sweep.

## The workspace beside the thread (`components/polar/polar-code-workspace.tsx`)

- Files: the checkout's tracked and new files, read as a stream from the
  container (`lib/agents/session-files.ts`).
- Changes: the Agents app's diff and pull request view.
- Preview: the web servers the session runs, in a frame, with reload, open in
  a new tab and copy link. See below.
- Terminal: the agent's own terminal. For a session on a pool server it is
  reached over that server's engine.

## The live preview (`lib/agents/session-preview.ts`)

- Served by Polaris under a path, so it needs no wildcard name, certificate
  or open port: `/api/agents/preview/<session>/<signature>/<port>/...`. The
  path-based model of code-server (`/proxy/<port>/`) and Coder's path apps,
  with the capability in the address the way Daytona's preview links carry
  one. The signature is the session id signed with the app secret, so the
  address is stable for the session and only Polaris mints it; it opens a
  running container session and nothing else.
- The page is the agent's and answers on Polaris's origin, so it is never
  given that origin: every response carries `Content-Security-Policy: sandbox`
  without `allow-same-origin` (an opaque origin with no access to Polaris's
  cookies or storage), cookies and `Authorization` are stripped on the way in,
  and `Set-Cookie` on the way out.
- On this box each container session joins a private network of its own
  (`sessionNetwork`, a service-scoped `polaris-net-s...`), which the host daemon
  attaches Polaris's containers to; the live ones are kept in the reconcile's
  wanted list so an update re-attaches them. A box with no address range left
  starts the session without one, and only its preview is missing. On a pool
  server the container is dialled at its address there through the pooled SSH
  connection.
- Which ports: the listening sockets in `/proc/net/tcp*`, read every 5 s while
  the pane is open. One bound to the container's loopback is named with what
  to do about it.
- Root or path: the root is asked first and the full path when the root
  answers 404, so a plain server and one started under the path (Vite
  `--base`, Next.js `basePath`) both work. Claude Code is told the path and to
  bind to 0.0.0.0 (`PREVIEW_PROMPT`); every agent gets `POLARIS_PREVIEW_BASE`.
- Next.js keeps the slash after the port (`skipTrailingSlashRedirect`, with
  Next's own slash removal as the first redirect for every other path), or a
  page's relative addresses would resolve one level up.
- Not carried: WebSockets, so hot reload does not reach the frame. The pane
  says so and reloads on request.
- The UI follows Dyad and OpenHands: a file tree, a code view and an xterm
  terminal next to the chat.

## Not yet

- WebSockets through the preview (a dev server's hot reload).
- The reach check runs from the pool server itself, not from inside a session
  container; a container whose network differs from its host's would not be
  caught by it.
