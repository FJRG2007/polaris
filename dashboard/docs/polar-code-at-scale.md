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
- Kept as settings rows `polar.code.spare.u.<userId>`, one per account, taken
  with a conditional delete so two tabs cannot both take it.

## The workspace beside the thread (`components/polar/polar-code-workspace.tsx`)

- Files: the checkout's tracked and new files, read as a stream from the
  container (`lib/agents/session-files.ts`).
- Changes: the Agents app's diff and pull request view.
- Terminal: the agent's own terminal. For a session on a pool server it is
  reached over that server's engine.
- The UI follows Dyad and OpenHands: a file tree, a code view and an xterm
  terminal next to the chat.

## Not yet

- A live preview of an app the agent runs. It needs a route per session and
  port at the edge (Daytona's `{port}-{id}.domain` with a signed token) on every
  pool server.
- Spares sit in the settings table (`enigma:` marker in `session-spares.ts`). At
  tens of thousands of concurrent Code users they belong in a table of their
  own, indexed on `(hostId, expiresAt)`.
- Pool servers must reach this Polaris's public address. A session's hooks
  report there.
