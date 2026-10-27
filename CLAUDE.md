# Polaris

Repo-wide constraints that change how a feature has to be built here. Style and
general engineering rules live elsewhere; this file is only the things that are
specific to this project and that are expensive to rediscover.

## The user never touches a terminal

Polaris is installed with one script and run from its interface. After that
install, **the command line is not a requirement for anything** - not updating,
not enabling a feature, not repairing one. The person running it does not open
`.env`, does not edit a file in the checkout, and does not read a container's
logs. Assume they cannot.

So:

- **No screen may ask for a command, a file edit, or a log.** Not "set X in
  `.env`", not "re-run the installer", not "check the such-and-such container".
  If Polaris can do the thing, it does it; if it cannot, the screen says what is
  wrong in terms of what the reader can see, and offers the button that fixes it.
- **A feature is not shipped until it works with no setup.** Anything that needs
  a value only a script can write is switched off everywhere and cannot be
  switched on.
- The exception is what genuinely is not Polaris's to do - a rule in the
  operator's own router, a DNS record at their registrar. Those are named
  precisely, with the values to type, and checked from here so the screen can say
  when they start working.

## Who configures what

**Setting up how Polaris talks to an outside service is the administrator's job,
never a user's.** A provider app (client id and secret), an API key, a redirect
address, a developer-dashboard step - all of it lives in the admin screens
(Integrations), and nothing on a personal screen (account, connections,
profile) asks a user for it, offers it, or explains it. A user only connects
or disconnects their own account through what the administrator set up.

- When the administrator's setup is missing or refused, a user is told the
  administrators know; only an administrator is shown the provider's reason.
- A provider limit (Spotify's five accounts in development mode, say) is
  explained on the admin screen with what the administrator can do about it,
  never answered by handing users a way to bring their own credentials.

## One way to build a rule

**Every "when this happens, do that" screen is the same screen.** Places
automations are the reference, and Mail filters follow them; CRM workflows and
any rule builder added later (chat, drive, deploy, tasks) use the same
pieces - the list of rules with their on/off switch and last run, the editor
that reads as a sentence (when -> if -> then), the condition and action rows,
the test/preview and the run history - from shared components, never a
lookalike drawn again inside one app. Someone who has written one rule in
Polaris has learnt to write all of them.

## How a deployment actually gets your change

**An installed Polaris is only ever updated from the Update button in Settings.**
The operator does not re-run `install.sh`, and does not run `update.sh` by hand.
Assume they never will.

That button reaches the updater script only in the **full** edition: the
dashboard asks hostd for `/v1/update`, hostd runs `POLARIS_HOSTD_UPDATE_CMD` (a
throwaway `polaris-updater` container that runs `sh scripts/update.sh`), and that
script is what calls `reconcile_env` to add new keys to `.env`. In the **limited**
edition there is no hostd, the command is empty, `/v1/update` answers 501, and
**`.env` is never reconciled at all**. The command also has the host repo path
baked in at install time, so an install predating that has an empty one.

It follows that:

- **A feature must work with the environment an existing install already has.**
  Anything that only works once a new variable appears in `.env` is a feature that
  is switched off on every deployment in the world, and the operator has no way to
  switch it on that you have told them about.
- **Every new setting needs a working default in code**, not only in
  `.env.example`. `.env.example` is documentation and a seed for fresh installs;
  it is not a delivery mechanism.
- **A secret two containers share must not travel through `.env`.** Put it on a
  volume both mount and have the dashboard write it at startup, so it exists on
  first boot and repairs itself on every boot after.
- If a screen has to explain that something is missing, it names the update or the
  command that fixes it. It never tells the operator to go and configure
  something Polaris was supposed to set up for them.

## The browser extension ships only as a release

**An extension change is not delivered until a new `extension-v*` release
exists**, because installed copies update from releases and nothing else. So
every PR that changes what `dashboard/apps/extension` ships bumps `version` in its
`package.json` (and the lockfile entry); the `Extension version check` workflow
(`extension-version-check.yml`, job `bumped`) fails a PR that does not. Once the
bump reaches main, `extension-auto-release.yml` tags it and starts the release by
itself. **Never ask the operator before a release** - the merged version is the
decision.

## The edge

Traefik ranks routers by **the length of the rule** unless a priority says
otherwise, and the dashboard's own host rule is long enough to outrank every path
router in the deployment. **Give every router an explicit `priority`.** The
ordering in use: 110 guarded call path, 100 path prefixes with no host of their
own (`/api/deploy/ws`, `/livekit`), 50 the dashboard's public hostnames and an
installed app's own custom-domain routes, 10 the compose-label catch-all.

One malformed file in Traefik's dynamic directory freezes the whole edge on its
last good configuration, silently. Generated route files are rendered by a pure
function so they can be asserted in a test.

**Every write into that directory goes through `writeDynamicFile`**
(`apps/web/src/lib/traefik-dynamic.ts`), never a direct `fs.writeFile`: a plain
write truncates before it writes, so a failed or interrupted one leaves the file
empty, and an empty `polaris-apps.yml` is every deployed domain answering
Traefik's own `404 page not found` while the containers behind them are up.
`writeDynamicFile` writes to a unique temp name in the same directory and renames
it over the target, which Traefik's file provider never observes and a failed
write never truncates. The health probe (`lib/domain-health-probe.ts`) also treats
that edge 404 - and the vacant page - as down rather than up, and republishes the
app routes itself the first time it finds an address unrouted, since that is the
one outage here Polaris can end without a terminal.

**An installed app can own edge routes too**, through
`apps/web/src/lib/app-edge.ts`: one dynamic file of its own,
`polaris-app-<id>.yml`, written and cleared with `writeAppEdge`/`clearAppEdge` -
both going through `writeDynamicFile` like every other edge file, never a direct
write. The app renders its own routes as a pure function (asserted in its own
test, e.g. Status pages' `renderStatusEdge`) and calls only `writeAppEdge` on
every change and `clearAppEdge` on uninstall; emptied to `http: {}` rather than
deleted, since an absent file is a case `writeDynamicFile`'s rename does not need
to handle. `edgeHostnameTaken` is how an app checks a hostname before accepting
it: taken by the dashboard's own public names or by a deployed domain.

## The browser bundle never carries this machine's paths

Webpack compiles a bare `import.meta.url` to the module's absolute `file://`
path on whichever machine ran the build. pdf.js reads it (in a Node-only canvas
factory), so without the fix below every client that loaded it downloaded the
builder's disk layout - account name included.

- **The client webpack compilation answers `import.meta.url` with a
  workspace-relative path instead**, via a plugin
  (`PortableImportMetaUrl`, `apps/web/scripts/portable-import-meta.mjs`) wired
  into the `webpack` hook in `apps/web/next.config.mjs` for `!isServer` only -
  the server compilation keeps the real path, which `createRequire` needs.
- **The web app's `postbuild` script re-checks this regardless**
  (`apps/web/scripts/check-client-paths.mjs`, asserted by
  `apps/web/test/build/client-paths.test.ts`): it scans every text asset under
  `.next/static` for the workspace root and the home directory, in every
  spelling a bundler writes a path, and fails the build if either one is
  still there. A new dependency that reads `import.meta.url`, `__filename`, or
  bakes a source path into an error string is caught here even if nothing
  above knew to handle it - never silence or narrow this check to make a build
  pass.

## Agent session environment

The host daemon refuses to start a container if any environment value contains
a control character (`crates/polaris-hostd/src/deploy.rs`), and the error names
the variable, not the value - `env value for POLARIS_HOOK_SCRIPT contains a
control character` is what a reader saw on screen before this was fixed, for a
value they never typed.

- **A value that is a file's contents has a newline by definition**, so it
  cannot go into the boot environment as-is. The hook script, the hook
  settings and the MCP config are each base64-encoded with `asFile()`
  (`apps/web/src/lib/agents/session-runtime.ts`) and decoded back to a file by
  the boot script (`session-commands.ts`) - never written to the environment
  raw.
- `bootEnv()` runs every value through `guardEnv()` before it reaches the
  daemon, so a control character in anything else (a branch, a repository
  name, a typed command) fails here, in a sentence that says which variable,
  instead of surfacing the daemon's.
- **Only a thrown `SessionRefusal` is shown on the session.** Anything else -
  a daemon rejection, a closed socket, an SSH failure - is logged
  server-side and replaced with a generic sentence (`readableFailure()` in
  `session-service.ts`), because those messages name internals and paths
  nobody asked to publish.
- An agent's `credentials` list (`packages/core/src/agent-clis.ts`) can be
  empty, and empty means "not sourced", not "broken" - it must never block a
  session or be reported as an error. A machine that already has the tool
  signed in needs none of them.

## Every word on screen goes through i18n

Polaris is read in US English and Spanish of Spain, switched live per account.
`dashboard/docs/i18n.md` is the how; these are the rules that hold for every
change:

- **No new user-visible text is a literal.** A label, heading, button, hint,
  placeholder, `aria-label`, toast, dialog, empty/error state, an action's
  reply, a notification or email, a line sent into a game, and the browser
  extension's words: all come from the catalogs, in both `en-US` and `es-ES`,
  in the same change. A file that is added or touched is added to
  `apps/web/scripts/i18n-migrated.json`, which holds it at zero findings.
- **A translation takes the room of the English.** Buttons, tabs, menus,
  headers and badges are sized by their words, and a Spanish label a few
  characters longer wraps or stretches what fit in English. Write the shorter
  natural wording; when none fits, give the layout the room (truncate with the
  full text in `title`) instead of letting it break.
  `test/i18n/lengths.test.ts` fails on a label over the budget.
- Text that reaches someone with no request around it - a notification, a job,
  a game - is translated in that person's language (`getUserLocale`), not the
  sender's.

## Full-height screens leave room for the shell's own notices

The shell can show a notice above the page - a disk warning, a denied-access
line - through `PageNotices` (`apps/web/src/components/page-notices.tsx`),
which measures what it rendered and publishes it as `--page-notice-height` on
the document root. `--notice-height` (`packages/ui/src/styles/tokens.css`) is
that plus `--connection-banner-height`, the offline strip above the whole
shell, and is `0px` when nothing is up. A screen that fills the window has to subtract that variable or a
notice pushes its bottom off a window that does not scroll.

- **`PAGE_FILL` and `PAGE_BLEED`** (`packages/ui/src/shell/app-shell.tsx`)
  already do - built on those and nothing else needed.
- **A screen that computes its own `calc(100dvh-...)` instead** does not get
  it for free: the calendar's month/year/day grids, the vault item list, the
  deploy canvas, the log viewer, and the inbox and its contacts list all keep
  their own formula and each needed `-var(--notice-height)` added to it by
  hand when this variable was introduced. A new screen built the same way
  needs the same edit, or it only overflows the day a notice happens to be on
  screen - `test/mail/page-height.test.ts` only holds `PAGE_BLEED`'s own
  string, not a screen's private formula.

## The shell scrolls its content, never the window

`AppShell` (`packages/ui/src/shell/app-shell.tsx`) is exactly the viewport
(`h-dvh overflow-hidden`); the window never scrolls. The one box that does is
`ShellMain` (`packages/ui/src/shell/shell-main.tsx`), the content area under
the header, marked with `data-shell-scroll`. It also keeps a screen's scroll
position per address across back/forward (the browser's own restore only
targets the window) and sends a scrolling key to itself when nothing has
focus (the browser only sends those to the window too).

- **Nothing may measure or scroll `window`** - no `window.scrollY`,
  `window.pageYOffset`, `useWindowVirtualizer`, `h-below-header`, or a
  `top-[calc(var(--header-height)...]` sticky offset. Ask
  `shellScroller(element)` (`@polaris/ui`) for the ancestor to measure or
  scroll against instead - it returns the closest `[data-shell-scroll]`, or
  `null` outside the shell. `test/ui/shell-scrolls-its-content.test.tsx` greps
  every app's `src` (the extension excluded - it renders outside the shell)
  for these and fails on the first hit.
- **A list virtualized against the shell** uses `useVirtualizer` with
  `getScrollElement: () => shellScroller(element)`, never
  `useWindowVirtualizer` (see `components/paged-list/virtual-table-body.tsx`).
- **A screen that owns every scrollbar in it** (`PAGE_BLEED`) stops the
  content area from scrolling too, via `[data-shell-scroll]:has(.page-bleed)`
  in `tokens.css`, kept inside `@media screen` - not `html:has(...)` alone,
  since the window was never the scroller to stop, and not applied when
  printing, which wants the content area's real height instead.

## A menu's own height still respects the screen

`DropdownMenuContent`/`DropdownMenuSubContent`
(`packages/ui/src/components/dropdown-menu.tsx`) already caps itself at
`var(--radix-dropdown-menu-content-available-height)`, the room Radix measured
beside its trigger. A caller that sets its own `max-h-72`/`max-h-80`/... on
the menu replaces that cap instead of narrowing it - Tailwind's class merge
keeps only the last `max-h-*` - so a menu opened low on the screen (Polar's
model list from its composer, say) ran past the bottom edge with no way to
scroll to its last options.

- **A caller that wants a shorter menu takes the smaller of its height and
  the measured one**, never a bare `max-h-*`:
  `max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))]`.
- `test/ui/menu-height-cap.test.ts` scans every `DropdownMenuContent`,
  `DropdownMenuSubContent` and `ContextMenuContent` under `apps/` and
  `packages/` for a `max-h-*` class that does not mention
  `available-height`, and fails on the first one it finds - a new menu with
  its own cap needs the `min(...)` form from the start.

## Minecraft events

Before adding or changing a Game servers event
(`apps/game-servers/src/lib/minecraft/events/`), read
`dashboard/docs/minecraft-events.md`. The `minecraft-events` skill
(`.claude/skills/minecraft-events/`) is the procedure. Its "Lessons from real
servers" section lists the bugs that already reached players: RCON reads
cutting each other, version gates, both gamerule names, the stash order,
fall deaths at an arena's end, restarts in the middle of a run. A new kind
that skips them brings those bugs back.

## Minecraft servers

Anything that runs inside or acts on a player's Minecraft server - the
anti-cheat engine, the Polaris mod and plugin, sounds, login, scores - follows
the `minecraft-servers` skill (`.claude/skills/minecraft-servers/`). Servers
here are vanilla, plugin and modded, with mods that conflict and blocks nothing
in our tables knows: an unknown id is skipped, never fatal, and a guess about
modded content never sets back, kicks or freezes a player.

## Calls

- **A closed room is not a lost server.** The call lets its own room go on
  purpose (resting while alone, after 45 s), and the media server logs that as
  `CLIENT_REQUEST_LEAVE`. Map the client's `DisconnectReason` through
  `roomClosed()` (`chat/call-diagnosis.ts`); only a real loss may say "lost the
  call server". A notice that blames the server for something this page did is
  the bug, however the timing looks next to an update.
- **Anything a long-lived tab calls on a timer is a route, never a server
  action** - an update renames every action under an open tab. The seat
  heartbeat (`chat/call-seat.ts`) is the model, and a 410 from it re-seats the
  tab instead of giving up.

## One address for this server

A server can hold two addresses on the same LAN at once - cable and Wi-Fi is
the ordinary case, and the production one does. Both are valid, one is worse,
and anything that offers every address will wander onto the worse one: a call
whose media server offered both flapped its path every two seconds, and each
switch reset the picture to its lowest quality.

- **Whatever hands out "this server's address"** - the media server's
  candidates, mDNS, a DNS bind, a link, a device callback, a port forward -
  offers only the address of the default-route interface (the lowest-metric
  default route), and follows it when it changes (`lan-address-follow`).
- Test the two-interfaces-on-one-subnet case. A degraded call is checked for
  "switched pair" in the media server's log before anything else.

## This machine

Docker is not available on the development machine and must never be started
there. Verify against a production build (`npm run build`), the test suite, and -
where a container's behaviour is what is in question - say plainly that it has not
been exercised rather than implying it has.
