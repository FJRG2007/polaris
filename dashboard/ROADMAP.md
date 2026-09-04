# Polaris Dashboard - coverage ledger

The web control-plane pillar. This file tracks every work unit and its status so
nothing is silently dropped. Update it as phases land.

## Architecture

A single dashboard image with two runtime editions (limited / full). The web app
(Next.js App Router) talks to shared packages behind stable contracts so the
work parallelizes cleanly. Host access in the full edition is brokered by the
privileged `crates/polaris-hostd` daemon over a unix socket with a bearer token.
See [`README.md`](README.md) and the plan for the full rationale.

## Phases

| #   | Phase                                                                           | Status                                                                                                               |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 0   | Workspace scaffolding, tsconfig/prettier presets, gitignore, package skeletons  | done                                                                                                                 |
| 1a  | `@polaris/config` - edition + capability flags, Zod env schema                  | done (3 tests)                                                                                                       |
| 1b  | `@polaris/db` - Prisma schema (all models), client, PG + SQLite portable        | done (schema validates, client generates, init migration laid down)                                                  |
| 1c  | `@polaris/ui` - shell, theme tokens, app switcher, primitives                   | done (dark token system, Radix primitives, capability context)                                                       |
| 1d  | `@polaris/core` - Zod schemas, CIDR, tokens, permissions, path sanitize         | done (10 tests); tokens split to `@polaris/core/tokens` for client safety                                            |
| -   | Interface-freeze gate: StorageDriver, Prisma schema, hostd API v1               | done - all three frozen                                                                                              |
| 2a  | `@polaris/auth` - better-auth + Prisma adapter, roles, invites                  | done: email/password, roles, first-user admin bootstrap (invites model exists; invite UI pending)                    |
| 2b  | `@polaris/hostd-client` + `crates/polaris-hostd`                                | done: Rust daemon (12 tests) + TS client (health probe + mounts)                                                     |
| 2c  | `@polaris/storage` - interface, registry, credential crypto, in-process drivers | done: interface + crypto + registry + local driver (5 tests); SFTP/WebDAV/S3/SMB/NFS/vendor drivers pending          |
| 3   | `apps/web` skeleton - App Router, auth, app switcher, Drive shell, capabilities | done (`next build` green)                                                                                            |
| 4a  | Drive browser - list/nav/mkdir/move/rename/delete/search                        | done for local driver (search UI pending)                                                                            |
| 4b  | hostd-routed SMB/NFS + mount lifecycle + limited-edition degradation            | partial: registry routing + local-on-mount path; mount activation lifecycle (HostdClient.createMount wiring) pending |
| 4c  | Chunked/resumable upload + range/streaming download                             | streaming upload + range download done; chunked/tus resumable UI + UploadSession wiring pending                      |
| 5a  | Sharing - public links, password, download/expiry limits, invite users, logs    | models + schemas done; endpoints + UI pending                                                                        |
| 5b  | File requests - token URL, anon+login upload, size/format/CIDR/expiry           | models + schemas + constraint checks done; endpoints + UI pending                                                    |
| 5c  | Admin - user management, roles, invites                                         | roles/permissions engine done; admin UI pending                                                                      |
| 6a  | Docker - Dockerfile + compose (web + postgres + Caddy + hostd)                  | done (files written + syntax-validated; runtime `docker compose up` not yet exercised)                               |
| 6b  | One-command install (install.sh / install.ps1) + auto-update                    | done (scripts written + syntax-validated; not yet run end-to-end)                                                    |
| 6c  | Landing (Astro) + demo (seeded Next)                                            | pending                                                                                                              |
| 7   | GitHub Actions (CI, release, deploy, agent maintenance)                         | done (dashboard-ci, dashboard-release, dashboard-agent-maintenance)                                                  |

## Feature parity checklist

Drive (storage):

- [ ] Storage-provider abstraction (streaming `StorageDriver` interface)
- [ ] Drivers: local, SFTP, WebDAV, S3-compatible, SMB, NFS, Synology, QNAP, TrueNAS, UniFi UNAS
- [ ] Credential encryption at rest (envelope AES-256-GCM, key rotation)
- [ ] File browser: list, navigate, mkdir, move, rename, delete, search
- [ ] Chunked/resumable upload; range/streaming download
- [ ] hostd routing for kernel mounts (SMB/NFS) in the full edition

Drive explorer (interaction):

- [x] Non-reflowing selection: the action bar is a reserved fixed-height row, so
      selecting items never shifts the file list
- [x] Drag to move onto a folder row or a breadcrumb segment, carrying the whole
      selection when the dragged item belongs to it, with a count in place of the
      single-row ghost the browser would otherwise draw
- [x] Empty a folder (delete its contents, keep the folder) as a distinct action
      from delete, behind an explicit in-app confirm
- [x] Zip a selection to the NAS, optionally AES-256 encrypted with a password on
      the archive itself (archiver + archiver-zip-encrypted), and optionally mint a
      share link for the produced zip
- [x] Extract a zip/rar in place into a chosen folder, with an optional password;
      server-side zip-slip confinement + decompression-bomb caps (entry count +
      aggregate bytes), reading the archive via a private temp file
- [x] Preview/analyze a zip/rar (list entries + sizes) without extracting; rar is
      read-only (node-unrar-js WASM), zip via node-stream-zip
- [ ] Live end-to-end run against a real NAS/SFTP backend (built + typechecked;
      archive read/write paths not exercised on this dev machine)

Sharing:

- [ ] Public share links (hashed token)
- [ ] Link password (argon2), download limit, expiration
- [ ] Invite specific users
- [ ] Access log + audit

File requests (upload-in):

- [ ] Token URL; upload with or without login
- [ ] Per-request max size, destination, allowed formats, allowed CIDRs, expiry
- [ ] Anonymous-upload hardening (streamed size limit, sniffed MIME, rate limit)

Snippets & text drop points:

- [x] Snippets: server-side encrypted text (env vars, code, notes) under
      `POLARIS_MASTER_KEY`, searchable and highlighted because Polaris holds the
      key; one that must not be server-readable is sealed in the sender's browser
      instead, and served as ciphertext Polaris cannot open
- [x] Share a snippet by link: the same token/password/expiry/view-cap/address
      rules as a Drive share, enforced through the shared `lib/link-guards`
- [x] Text drop points: a URL that asks somebody for text - the mirror of a
      snippet link, and the text counterpart of a file drop point. An anonymous
      submission becomes a snippet owned by whoever opened the drop point

Vault:

- [x] Bitwarden-compatible surface at `/vault` (`/api`, `/identity`,
      `/notifications`, `/icons`, `/events`), dispatched from one route table -
      see [`docs/vault.md`](docs/vault.md) for what it does and does not cover
- [x] Client-side crypto only: the master password never reaches the server, the
      browser derives the key and wraps the vault's own key, and the server
      stores ciphertext it cannot open
- [x] Vault items (logins, notes, cards, identities, SSH keys), folders,
      organizations (set up in Polaris, used from any client), Sends, and TOTP
      code generation
- [x] One unlocked-vault session shared across every `/vault` screen with a
      per-account idle timeout, folder create/rename/delete (including from the
      item form), and vaults/collections/member confirmation from
      `/vault/vaults` - see [`docs/vault.md`](docs/vault.md)
- [x] More than one vault per account: extra vaults of somebody's own beside the
      organization ones, shared whole or by collection with a per-member scope,
      and items moved between them from the item itself
- [x] Import and export in the browser: Bitwarden JSON, KeePass 2 XML, and CSV
- [x] Sign-in reuses the Polaris account's own second factor rather than a
      second, vault-only one
- [ ] Emergency access, push/live sync, member management from a client, and the
      breached-password report - named as not implemented yet in
      [`docs/vault.md`](docs/vault.md)

Containers app (Docker):

- [x] Secure per-install SSH access provisioning (`install.sh --ssh`, REMOTE hosts only now): unique key, forced-command `docker system dial-stdio`, `restrict` + `from=`, pinned known_hosts
- [x] Modular `@polaris/docker` connector: transports (socket / SSH / TCP) behind a `DockerRpc` seam, driver, registry (4 tests)
- [x] Containers app: host overview (CPU/mem/counts), container table with live stats, start/stop/restart; DockerConnection model
- [x] Local host with NO flags: auto-registered, reached through hostd's allowlisted `POST /v1/docker` proxy (ping/info/list/stats/start/stop/restart only) - the web container never mounts the socket. Gated on `system.manage` + full edition
- [x] Global Hosts appear as Docker-over-SSH targets (derived from the Servers app), alongside the local host and legacy socket/TCP connections
- [x] Usage sampling runs behind the request instead of in front of it: the
      server keeps the last stats sample per host (keyed by id and by name,
      single-flight per host), the listing and the container page answer from
      it straight away with its age, and a fresh pass starts once that has aged
      out. Gated on the same ownership check a driver open would prove, since a
      cache read resolves no driver to prove it for free
- [ ] Live end-to-end run against a real Docker host (built + unit-tested; hostd proxy + local host + host-over-SSH not yet exercised on this Docker-off dev machine)
- [ ] TLS-cert/pasted-key credential paths for one-off TCP hosts (encryption wired; UI present)
- [ ] Container logs, images, compose stacks

Servers (global hosts):

- [x] `@polaris/ssh` shared primitive: one authenticated ssh2 client + mandatory host-key pinning, used by BOTH the Docker connector and the SFTP driver (dedup; fixed SFTP blind-TOFU + dropped passphrase)
- [x] `Host` model (owner-scoped, encrypted creds, pinned host key) + Servers app: add/list/delete with password or private-key(+passphrase) auth and trust-on-add (test-connect validates creds and captures the host key to pin)
- [x] A Host registered once derives a Docker-over-SSH target in Containers AND an SFTP source in Drive
- [ ] Live SSH run against a real host (built + typechecked; not exercised on this machine)
- [ ] OpenSSH user-certificate auth (deferred: ssh2 exposes no typed cert field; password + key ship now)
- [ ] Edit a host; per-host SFTP root; VMs/deploys

Kubernetes:

- [ ] Reviewed: only stubs today - hostd `/v1/k8s` returns not-implemented, capability detection via `KUBECONFIG`/service-account exists, and the app is unlocked-pending. No k8s client, kubeconfig parsing, or model yet. Path: a `Cluster` entity (kubeconfig, encrypted) + a read-only client (list nodes/pods/deployments) mirroring the Docker connector, then lifecycle.

Platform:

- [ ] User management, roles/permissions, invites
- [x] Edition/capability boundary + graceful degradation (fixed: the capability refresh loop now actually runs from `instrumentation.register()`, so the edition flips to full when hostd answers - it was never started before)
- [x] Full edition is the installer default (opt out with `install.sh --limited`): hostd runs by default so in-band updates and the local Docker host work with no flags. hostd + updater container images now build and publish (were missing entirely)
- [x] Auto-update via hostd: `POST /v1/update` runs a one-shot `polaris-updater` container that re-runs `install.sh` (git pull -> reconcile .env -> pull images -> migrate -> redeploy -> verify)
- [x] Consumption (`/admin/consumption`): where the machine went, split into
      Polaris itself (totals only, since the part-by-part table already lives on
      the footprint card), marketplace installs, deployed services/databases (a
      kept release and a service's quick/named/ngrok tunnel fold into that
      service's row), and everything else on the box. Attributed by compose
      project rather than container name, since names are operator-chosen and
      change on redeploy; an install placed on another server reads "Not on this
      machine" instead of disappearing. Figures reuse the shared
      container-stats-cache sampler (no fresh `stats` call per container); disk is
      left out for the whole machine, since measuring it means asking every
      container to walk its own volumes. Admin-only, and reads every owner's
      records on purpose - an operator screen that stopped at the reader's own
      shelf would not answer where the machine went
- [ ] Digest/signature-verified image provenance for updates (still trusts the `latest` tag, as before - pre-existing accepted risk)
- [ ] CI / release / deploy / agent-maintenance workflows
- [ ] Marketing landing + demo

Tasks (work management):

- [x] Hierarchy: Space > Folder > List > Task > nested subtasks, with a stable
      per-space reference ("ENG-42") allocated inside the insert transaction
- [x] Folders nest as deep as the work does (a client, its projects, their
      lists), rearranged by dragging in the sidebar and renamed in place (F2,
      double click, or the right-click menu)
- [x] Deleting a list or folder asks for its name back only when there is work to
      lose; an empty one is confirmed plainly, with archived tasks and subtasks
      counting as work even though the sidebar counts leave them out
- [x] Access granted on one folder: a client or a contractor is invited to a
      branch and sees that branch only, with the space beside it pruned out of
      the sidebar and every cross-space screen
- [x] Space-level vocabulary: custom statuses (four kinds), tags, custom fields
      (15 types), members with guest/member/admin roles
- [x] Tasks: multiple assignees, priorities, start/due dates (all-day or timed),
      time estimates, points, milestones, watchers, archive, duplicate
- [x] Five views over one load: List (grouped, nested), Board (drag and drop),
      Table (custom-field columns), Calendar, Gantt
- [x] Board columns are a space's statuses, edited from the board: renamed and
      removed from a header menu (a delete asks which column the work moves to
      first), reordered by dragging a header or, off the board, with move
      controls beside edit and remove in the space's statuses tab. A status
      name shared by two statuses is one column, and renaming, deleting or
      reordering it acts on all of them together, the way the drag already did
- [x] Saved views: filters, grouping, sorting, shared or private
- [x] The list reads the way a list of work should: priority on the row (it is
      the default sort, and a list ordered by something it never showed was one
      nobody could check), group headings that stay put while their group
      scrolls, and no status column when the list is already grouped by status
- [x] Keyboard: j/k or the arrows move a cursor through List and Table, Enter
      opens, x adds to the selection, Escape puts it away. The cursor is a
      separate idea from the selection, so looking at a row is not acting on it
- [x] Filter engine shared by views and automations (relative dates, custom
      fields, any/all matching), pure and unit-tested in `@polaris/core`
- [x] Comments (one level of replies, resolve, assign), checklists (promote a
      step to a task), dependencies with cycle refusal
- [x] Time tracking: one running timer per person, manual entries, billable
      flag, weekly timesheet, time by person
- [x] Recurring tasks (schedule- or completion-based), reminders via cron
- [x] Automations: 10 triggers, 12 actions, view-shaped conditions, one hop
- [x] Sprints with burndown, goals with targets (a `tasks` target counts itself)
- [x] Docs/wiki as a Markdown tree; public intake forms that file tasks
- [x] Reporting: status/priority mix, 30-day completion, workload, tracked time
- [x] Sharing one task: send it to people (in Polaris, or by email), the private
      link, and a read-only public link that is off until somebody turns it on
- [x] Live: a task created, assigned, moved, commented on or deleted appears on
      every other screen showing that space without a reload, scoped server-side
      so a signal only ever reaches somebody who could already read the work
- [x] Organizations and teams: work owned by a group rather than a person, with
      a roster, teams inside it, and a team granted a whole space or one folder
      of it; an administrator can turn organizations off, restrict who may start
      one, and cap organizations per account, members and teams
- [x] Connected trackers: Linear and Jira linked to a space with the person's
      own credential, polled rather than pushed, mirroring title, description
      and status in - statuses mapped by the provider's own category first and
      its name as a fallback - and pushing a task's status back out when the
      connection is told to. Not the assignees or the comments, deliberately:
      guessing which Polaris account matches which tracker account misassigns
      work, and a conversation copied in both directions duplicates itself
- [x] Handing a task to an agent from its panel: a session opens on a branch of
      its own, seeded with the task's own title and description, and the agent
      reads and moves the task itself as it works - see Agents below
- [ ] Live poll against a real Linear or Jira account (built + unit-tested; not
      called from this machine)
- [ ] Attachments on a task (Drive file picker)
- [ ] Whiteboards, mind maps, clips, AI, email-in, proofing, map and workload
      views, portfolios - out of scope for this pillar

Agents (coding sessions):

- [x] A catalogue of the CLI agents Polaris can be helpful about (Claude Code,
      Codex, OpenCode, Gemini CLI, GitHub Copilot CLI, Cursor CLI, Amp, Goose,
      Aider, Droid, OpenClaw), detected on a machine by probing for their
      binary; a tool Polaris was never told about still runs, as a custom entry
- [x] A session runs the vendor's own binary as a real process - in a tmux
      session in a container on the box or on an enrolled server, in a git
      worktree of its own - so it authenticates the way it already does on that
      machine and nothing is re-entered into or held by Polaris
- [x] Signing in an agent runs against the person's own persistent home rather
      than a throwaway container that gets destroyed after: the same account a
      session runs as, so the login itself is the result and not just a token
      pasted back (still offered, for a place that home does not reach). It
      installs into that home's npm prefix, so the tool is already there for the
      first session, and keeps a shell open after the login exits instead of
      closing the one window somebody was there to read
- [x] A tool's own first-run wizard - Claude Code's colour-scheme and
      login-method screens on a machine it has never run on - answered before a
      session ever reaches it: the catalogue names the file and the key its
      onboarding writes, and only into a home Polaris owns. A colour scheme is
      filled in only where the tool has not answered that question itself yet,
      so a person who picks one keeps it - but the wizard's own answers
      (onboarding completed, the workspace-trust dialog) are asserted instead,
      because the only thing that can have answered those already is an agent
      hitting the highlighted option on a screen nobody was there to read, not
      a person's own choice. The same answers run ahead of a sign-in container
      too, since it prepares the same persistent home. The workspace-trust
      dialog is about the checkout rather than the tool - it defaults to "No,
      exit" and is recorded per project folder - so it nests under the
      session's own worktree path instead of sitting beside the flat answers,
      is skipped where there is no worktree yet, and merges in without taking
      another worktree's own answer away
- [x] What a session is doing is read from its own lifecycle hooks where the
      tool supports them (written into the worktree rather than the machine's
      home directory), and from its terminal output otherwise; steering it is a
      bracketed paste and a newline into that terminal
- [x] A starting session shows a progress bar and step list read off that same
      terminal output rather than a bare spinner, so a slow clone reads
      differently from a machine that has given up; it stops once the agent has
      the terminal
- [x] A session may open with no repository - an agent on a machine of one's
      own with nothing checked out, which is what a person does on their own
      laptop. It authorizes through the account that started it rather than a
      repository's owner, and its working directory lives inside the persistent
      home so files survive between sessions, unlike a checkout
- [x] A machine everybody shares, off unless an administrator turns it on under
      `/admin/agents`: one shared home rather than one per account, so anybody
      opening it is signed in with what the last person signed in there, and
      finds what the last person left. The toggle and the session form both
      warn that a personal Claude or ChatGPT subscription is licensed to one
      person and several people through it is what gets it suspended - use an
      API key or a team plan there instead
- [x] A third answer on the picker besides an account or "whichever of mine
      resolves": sign the agent in with nothing and let the machine's own login
      answer. It is what a machine somebody signed in themselves needs, since
      every tool reads its credential environment variable before it ever looks
      at its own home, and a stored token from months ago would otherwise beat
      a login that already works
- [x] Sessions list sorted by what needs a person, a session page with the
      transcript, the activity and the prompt box, and a terminal that attaches
      to the agent's own tmux rather than opening a shell beside it (fixed: an
      exec inherits the container's environment, which carries no TERM on the
      Node image, so tmux refused and closed the socket; the attach now
      supplies one only when none is already set, and falls back to a shell
      with a readable sentence instead of a closed socket)
- [x] Polaris answers MCP at `/api/mcp`: stateless JSON-RPC 2.0 with tools for
      Tasks and for sessions, authorized by an API key or by a session's own
      reporting token, so an agent Polaris started has the tools from its first
      turn with nothing configured
- [x] Enigma - the operator's policy skills, operating contract, slash commands
      and post-edit guardrails - installed into every session by default,
      resolved as one setting down instance/account/repository/session tiers
      where null means inherit and only a fully resolved value is ever used; a
      workspace session has no repository to resolve through, so it sees only
      the account's own tier and the instance's
- [ ] Live end-to-end run against a real container or enrolled server (built +
      unit-tested; this dev machine has no Docker, so the container and SSH
      runtime paths are exercised only through their pure parts)

Notes (personal writing):

- [x] An app of its own at `/notes`, beside Tasks rather than under the account:
      somewhere you sit and work, not a setting you change and leave. The old
      `/account/notes` path redirects and still resolves as a pasted reference
- [x] Notes nest as deep as five levels - any note can hold others, so there is
      no separate folder to create. The sidebar is a tree with collapse
      remembered per browser, and searching flattens it so a match two levels
      down is never hidden by a folded parent
- [x] Moving one refuses what would cut it off: into itself, into its own
      subtree, or deeper than the tree goes. Deleting one frees what is under it
      instead of taking it along, and says how much before it does
- [x] Archive with a screen behind it, so putting something away is not a delete
      with extra steps
- [x] The same Markdown, mentions and Polaris references as everywhere else, and
      the same privacy as before: only the author reads them, an instance
      administrator included
- [x] Notebooks: a shelf a group writes on, beside the private one everybody
      has. Reached the way a Tasks space is - a membership, a team grant, or the
      organization that owns it - and a note with no notebook is still readable
      by its author alone, an instance administrator included
- [x] Folders, nested, on either shelf. A folder is where things are filed and a
      parent note is what they are part of; keeping both is what lets a vault
      arrive with the arrangement its author gave it. Deleting one lifts what was
      inside it, the way a Tasks folder does
- [x] Import a vault of Markdown - loose files, a folder, or a zip. Directories
      become folders, frontmatter is kept beside the body rather than shown as
      text, and `[[wikilinks]]` are rewritten into Polaris references once
      everything is in
- [x] Export the other way: a note, a folder or a whole notebook, as a zip of
      Markdown arranged the way a vault is on disk. The frontmatter goes back
      where it was and the references become [[wikilinks]] again, so what comes
      out re-imports as the same shape - and opens in Obsidian, or in a text
      editor, or in nothing at all
- [x] Published by link, for somebody who has no account here. The same guards
      every public link in Polaris carries - a password, an expiry, a cap on
      opens, and the address allowlists - so it behaves like a shared file rather
      than like a second idea of what sharing means. Read-only, and an archived
      note stops being served whatever the link says
- [x] A code block says which language it is, and is coloured while it is being
      written rather than only once it is read back. The grammar arrives as its
      own chunk when a block asks for it, and the colour is decorations over the
      text rather than markup replacing it
- [x] Cut, copy and paste on the right press, beside the formatting. Paste is
      read the way a paste is read - Markdown becomes the document it describes -
      and says when the browser will not hand the page the clipboard
- [ ] The other formats worth reading in
- [ ] A note handed to one person outside the notebook it is on

Chat (talking to the people here):

- [x] Spaces with channels in them, and direct messages that belong to no space.
      A space can belong to an organization, and then `internal` means that
      roster rather than the whole instance
- [x] Channels: public or private, named, with a topic, archived rather than
      deleted where the history matters. Names are normalized as you type
      (`Release Planning` -> `release-planning`) with the stored form shown
- [x] Direct messages between two people are keyed by the pair, so two tabs
      cannot open two conversations with the same person; three or more is a
      group, where asking twice does make two
- [x] Threads one level deep, reactions, editing your own, and deleting with a
      tombstone so replies under a removed message still make sense
- [x] Unread counts from a read mark rather than a stored counter, own messages
      excluded, and a mark that never moves backwards between two open tabs.
      Catching up on one device is announced live to every other screen open on
      the same account, so a count taken down on mobile does not sit stale on
      Polaris until the next reload
- [x] Live: messages, membership changes, typing and read marks over one
      connection per device, filtered server-side to the conversations the
      reader is in. Frames carry ids, never message text - the tab pulls
      through the same access check that drew the screen
- [x] Message information: the ticks under your own message in a one-to-one
      conversation open onto when it was sent, delivered and read, each moment
      answered for by a separate stamp rather than read back out of the ticks.
      Only offered where the ticks already are, and only what the other
      person's privacy setting allows
- [x] Reached by being in it. No administrator override, no instance-wide read
- [x] Calls: audio and video started from a conversation through the media
      server the stack runs, browsers never exchanging media directly. Mute,
      camera, and a roster of who is in the room. Capped at 8
- [x] The microphone is one choice remembered per browser, not per feature - the
      one picked for a call is also the one a voice message records with, so
      picking the good headset for a call and being recorded through a laptop
      lid for a voice message is not a thing that happens
- [x] Somebody with no Polaris account can be brought into a call, on a
      per-meeting link an account holder opens. They wait in a lobby until
      somebody inside lets them in, the link dies with the call, and the cookie
      they get is a seat in one room rather than anything resembling a session
- [x] Calls are carried by the media server the stack starts, and by nothing
      else. Between devices on this network it needs no setup at all; from
      outside it needs two ports forwarded, which Domains lists and checks -
      and until the server answers, Chat says so instead of offering a call
      that would connect to silence
- [x] Files on a message: staged in the composer, dropped onto the conversation,
      pasted from the clipboard, or picked - a pasted screenshot gets the same
      preview and limits as a picked file rather than being eaten silently.
      Images shown inline, everything else a download, and the download
      authorized by the conversation before a byte is read. An administrator
      picks where they go under Uploads, defaulting to wherever profile photos
      already go rather than asking the same question twice
- [x] A deleted conversation's files go with it: the folder they were written
      under is removed with the channel or space, and the last file leaving a
      message empties its folder too, so storage does not grow bytes nothing
      can reach any more. What an older build already left behind is cleared by
      a Tidy up on the chat card under Uploads, deliberately narrow to folders
      no conversation or message answers for
- [x] Keeping a message: private to whoever kept it, with a Saved screen that
      links back to the room it came from. Starring is a bookmark, not a signal -
      reactions are the public version
- [x] Emoji, GIFs and stickers in one picker with tabs, searched through a
      service an administrator connects. A GIF or sticker found by search can be
      kept to a personal library for reuse the same way an emoji is favorited,
      independent of the picture ever being sent
- [x] Somebody whose chat has been switched off cannot be messaged: they are not
      offered in a picker, and a direct message or channel add naming them is
      refused. They have no screen a message could arrive on
- [ ] Screen sharing, recording, scheduled meetings, presence dots, unfurled
      links, and search across conversations

Code (pull requests and issues):

- [x] `/apps/code`: pull requests and issues across every GitHub account the
      reader has linked, filtered by the questions people arrive with - waiting
      on my review, assigned to me, opened by me, I was mentioned
- [x] One of them opened: description, the conversation with reviews and
      comments merged into one thread, and the three verbs somebody would
      otherwise leave Polaris for - comment, close or reopen, and merge
- [x] Merging asks which of the three ways rather than just "are you sure": the
      mistake people make is the method, not the intent
- [x] Read live rather than mirrored. A copy of somebody else's tracker is a
      sync problem with no winning end state; the remote is the truth and
      Polaris is the window, the same choice Drive makes about files
- [x] Every call is made as the person asking, with a token from an account they
      linked. No instance-credential fallback anywhere - that is how one
      operator's token ends up listing their private repositories to everybody
- [ ] Linking a GitHub issue to a Polaris task, review comments on a diff, and
      opening a pull request from here

Telemetry (what breaks):

- [x] `/apps/telemetry`, beside Analytics and the firewall because it answers the
      third question about the same things: who came, who was turned away, and
      what fell over
- [x] Speaks the ingest protocol Sentry's clients speak, so an application points
      the SDK it already has at a Polaris address and reports here instead - no
      agent to install, no format to learn, and nothing to change again if it
      ever moves somewhere else. Both the envelope endpoint current clients use
      and the store endpoint older ones do
- [x] Every deployed project gets an address without anybody configuring one:
      `SENTRY_DSN` is in the environment of every service it deploys, underneath
      whatever the operator set themselves
- [x] Polaris reports its own crashes into a project of its own, in process
      rather than over HTTP - posting to itself would fail exactly when what is
      being reported is that requests are failing
- [x] A thousand copies of one crash is one row. The grouping is pure and tested:
      the client's own fingerprint if it sent one, then the exception and the
      application's own frames by file and function and never by line, then the
      message with the ids taken out of it
- [x] Resolving records the release it was resolved in, so the same fault in a
      later build reopens itself rather than waiting to be noticed
- [x] Events age out per project and the daily counts do not, so a chart of a
      fault over months survives the stack traces being pruned
- [x] The key in a DSN names a project and proves nothing - it ships inside the
      browser bundle of every application that reports from one - so a project
      says who may report into it: from which addresses, with which clients, and
      optionally carrying a key of its own that a Sentry client with settable
      transport headers can send. A new project accepts this network and nothing
      else, which is where an application deployed by Polaris reports from
- [x] What gets turned away is counted on the project and shown with the address
      it came from and a button to admit it, so a project refusing everything
      says so rather than looking healthy
- [x] The number in a DSN is drawn at random rather than counted up: a sequence
      would say how many projects an instance has and make the next one guessable
- [ ] Alerting - a message when a fault is new, or when one comes back
- [ ] Source maps, and performance traces

## Notes / deliberate decisions

- Polaris is a control plane, not a file mirror: the browser lists remote trees
  live via the driver. `Node` rows exist only for objects Polaris must track
  (shared or requested items), avoiding an unwinnable sync problem.
- Prisma schema stays SQLite-portable (no Postgres-only types/enums/arrays; JSON
  stored as stringified `String`; byte sizes as `BigInt`).
- Tasks statuses are space-level, not per-list: a board people drag work across
  has to mean the same thing in every list, and per-list overrides are how a
  workspace ends up with nine spellings of "Done". A task therefore moves
  between lists in its space and never between spaces, which is also what keeps
  its reference stable.
- The Tasks filter/group/sort engine is pure and lives in `@polaris/core`, so a
  saved view, an optimistic re-render after a drag, and an automation's
  conditions all evaluate through the same code rather than three that drift.
- An automation's own writes never raise another event. One hop, always: two
  rules pointing at each other would otherwise run until the request timed out.
- A Tasks folder is an arrangement, not an owner. Deleting one lifts its
  subfolders and lists to its own parent rather than taking them with it; the
  database cascade behind it is the backstop for a row deleted out from under
  the application, not the path a person takes.
- Tasks access is granted at two levels and they only ever add up. A space role
  covers everything in the space; a folder grant covers one branch and inherits
  downwards, with the strongest grant on the chain winning. A grant never
  reduces a space role, and never reaches the space's own settings, sprints,
  goals or wiki - those belong to the whole space. Cross-space screens read a
  resolved scope (spaces held outright, plus the exact lists granted elsewhere)
  rather than asking per row, so an aggregate cannot leak the client next door.
- The Tasks live channel carries the fact that a space changed and never what
  changed in it. The browser answers by re-rendering the route it is on, which
  re-runs the same server components and the same access checks that drew it, so
  being told "something moved" can never turn into being shown a row you may not
  read - and every view follows along without one of them needing its own
  payload format. The bus behind it is in-process: every writer is in the same
  server, so a broker would be a dependency to keep working forever for nothing.
- A task panel's free-text fields (name, description, blocked note, points, and
  a space's own text/number custom fields) hold each keystroke and write once
  typing stops, through one `useAutosave` hook per panel: a single serialized
  write chain so a save can never land after a later one, and every way of
  leaving - the X, Escape, clicking outside, switching to another task in the
  same panel - awaits a flush of whatever is held first. A write the server
  refuses goes back into the held state instead of being dropped, so the panel
  stays open with the text and the error rather than closing over lost work.
- An organization is not a second kind of account. Nobody signs in as one - no
  password, no session, no permission set - so the authentication surface never
  learns about it. It owns spaces and holds a roster, and that is all.
- Nobody is put on a roster. Somebody who runs the people in an organization
  invites an account and it waits there until that person accepts or turns it
  down - the same shape GitHub has always had, and for the reason that outlasts
  the comparison: a roster is published to everybody on it, so appearing on one
  you never agreed to join is both a surprise and a disclosure. An unanswered
  invitation stands for a week, counts against the size the instance allows, and
  leaves nothing behind when it is refused.
- Being on an organization's roster reaches no work, exactly as being in a
  GitHub organization hands you no repositories. Access comes from a team grant,
  a direct space membership, or administering the organization that owns the
  space. A team grant resolves to the same guest/member/admin vocabulary a
  personal membership uses, so nothing downstream has to know whether somebody
  arrived as a person or as part of a team - and where both apply, the stronger
  wins. On an organization's space, `internal` means that roster rather than
  everybody on the instance.
- A privacy setting names an audience from one shared vocabulary - everyone,
  everyone except, friends, friends except, only, or nobody - never a switch
  or a dropdown of its own, so "who sees this" is answered the same way for a
  photo, an address or a last-seen time. The set of people an audience names
  is a list, saved and reused across settings rather than picked over on each
  one.
- An address and a phone number arrive shut, the only two settings that do:
  neither is a detail of somebody's presence, both are what spam, password
  resets and impersonation start from, and nothing in Polaris needs either to
  name, mention or write to somebody. Every roster, share dialog and member
  list reads an address through one `contactLines` function rather than the
  column directly, so a screen that has never heard of the setting cannot
  leak past it. Read receipts stay the one reciprocal setting: hiding that
  you read a message also hides whether yours was read, because a one-way
  version is not a privacy setting, it is a mirror.
- MCP's stateless `/api/mcp` accepts two credentials and treats them
  differently: an API key acts with whatever scopes and admin standing its
  owner holds, but a session's own reporting token - handed to the agent
  Polaris started before it ran, so nothing has to be configured by hand -
  resolves to a fixed, non-admin scope covering only tasks and reading agents.
  An agent that can start more agents is one bad turn from starting them in a
  loop with nobody watching; that reach is only ever an API key somebody chose
  to hand over.
- Enigma resolves down four tiers - session, repository, account, instance -
  nearest wins for every field except its escape-hatch `config` map, which
  merges far-to-near instead: an instance-wide key an operator set is a
  different setting from a per-session one, not a competing answer to it, so
  setting anything at all on a session must never silently drop the
  instance-wide policy underneath it. A resolved value is never the one
  stored - only null ("inherit") and explicit choices are, so raising the
  instance default keeps reaching every tier that never overrode it. A
  workspace session (no `repoId`) has no repository tier to resolve through,
  so it resolves down session, account, instance and skips the middle one.
- Accepted dependency risk: two moderate advisories remain against `postcss@8.4.31`
  bundled inside Next.js's private build toolchain (an XSS-in-CSS-stringify path
  that our app never exercises - build-time only, no untrusted CSS). The direct
  postcss is pinned to a patched version via an npm override; npm cannot rewrite
  Next's internal copy, and the only "fix" npm offers is an absurd next@9
  downgrade. Re-evaluate when Next bumps its bundled postcss.
