# Polar Code sent a message into nothing

**Found:** November 2026. **Fixed in:**
`dashboard/packages/core/src/agent-clis.ts` (`CLAUDE_WIZARD_ANSWER`),
`dashboard/apps/web/src/lib/agents/session-image.ts`,
`dashboard/apps/web/src/lib/polar/code-agent.ts` and
`dashboard/apps/web/src/components/polar/polar-code.tsx`.
**Guarded by:** `test/agents/session-commands.test.ts`,
`test/agents/session-image.test.ts` and `test/polar/code-agent.test.ts`
(under `dashboard/apps/web`).

## What was seen

The user switched Polar to Code, typed "Hola" and pressed send. For about a
minute nothing happened on the screen except a greyed-out composer. A session
called "Hola" appeared in the list, and opening it showed "Nothing yet. The
agent is getting its machine ready." It then turned to "Stopped" with one step
and no answer. Almost every earlier session on the same Polaris had ended the
same way.

## What it actually was

There were four problems, and each one was enough to spoil the experience on
its own.

1. **Claude quit on the first message.** The agent's home has permissions
   bypassed (`defaultMode: bypassPermissions`). Claude Code therefore opens on a
   warning screen whose highlighted option is "No, exit". Polaris types the
   first prompt and presses Enter as soon as the launcher says the terminal is
   the agent's, so the Enter chose "No, exit". The agent closed before it read
   anything, and its own `SessionEnd` hook was the only event the session ever
   recorded. This was reproduced on the live box with the home's own settings:
   the warning appears, "Hola" plus Enter exits with status 1. With
   `bypassPermissionsModeAccepted: true` in `.claude.json` it opens on the
   prompt instead.
2. **The default agent had no login.** New tasks started on the first agent not
   known to be missing. That was Claude Code's "this machine's own login" row,
   whose readiness is `unknown` because Polaris cannot see inside the home. That
   home had never been signed in to Claude, so even past the warning the agent
   only said "Not logged in".
3. **The image pull stood in front of the start.** The session image is
   refreshed once a day per process, and the refresh was the start itself
   (`compose up` with pull policy `always`). The first session after the
   dashboard restarted therefore waited 59 seconds for a Node image to
   download.
4. **Nothing on screen said it had been sent.** The composer kept the text and
   greyed out until the server answered, and the session opened empty because
   the first prompt is stored only once it reaches the agent.

## The fix

- `CLAUDE_WIZARD_ANSWER` also asserts `bypassPermissionsModeAccepted`, in both of
  Claude's config files. Polaris asserts it the same way it already asserts
  onboarding and folder trust.
- `preferredAgent` picks the default by what Polaris can vouch for, in this
  order:
  1. an agent with an account linked;
  2. one that signs in with the model picked beside it (OpenCode);
  3. any other agent not known to be missing;
  4. the machine's own login, last.
- `upWithFreshImage` always starts on the image already on the machine (a
  missing one is still pulled) and runs a refresh that is due as a plain pull
  behind the start, at most one at a time.
- Sending in Code clears the composer at once and shows the message with
  "Starting the session". Once the session opens, the message stays at the top
  of its thread until the session has it. A failed start puts the text back in
  the composer.

## What stops it coming back

- `session-commands.test.ts` fails if the first-run answer stops writing
  `bypassPermissionsModeAccepted` into either of Claude's config files.
- `session-image.test.ts` fails if a start waits for the refresh or starts with
  anything but the cached image.
- `code-agent.test.ts` fails if the machine's own login is preferred over an
  agent Polaris can vouch for.
