---
id: BUG-0037
title: Screens show translation keys instead of their words, although the build is meant to stop that
status: fixed-watching
area: i18n / every screen
location: dashboard/apps/web/test/i18n/client-namespaces.test.ts
related:
  - dashboard/apps/web/src/components/polar/polar-code.tsx
  - dashboard/apps/web/src/components/polar/code-agent-switch.tsx
  - dashboard/apps/web/src/components/i18n/i18n-provider.tsx
  - dashboard/apps/web/src/components/i18n/message-rescue.ts
  - dashboard/apps/web/src/components/i18n/namespace-actions.ts
  - dashboard/apps/web/src/lib/i18n/fallback.ts
  - dashboard/apps/web/src/lib/i18n/translate.ts
  - dashboard/apps/web/src/app/api/i18n/rescue/route.ts
  - dashboard/apps/web/test/i18n/keys-are-translated.test.ts
  - dashboard/apps/web/test/i18n/missing-keys.test.ts
  - dashboard/apps/web/test/i18n/catalogs.test.ts
reported: 2026-11-25
fixed: 2026-11-25
fix_commit: "fix(i18n): a provider covers only what it wraps, and production never draws a key"
---

## What was seen

Owner, 2026-11-25: "in theory the build breaks if i18n texts are missing, but
from what I see it does not, and that is why texts arrive without their
words". Polar Code's **Switch agent** dialog read `agents.session.switch.title`,
`agents.session.switch.intro`, `agents.session.switch.pick`,
`agents.session.switch.cancel` and `agents.session.switch.confirm`. Its
"No model" line was in words. The owner has complained about raw keys at least
five times before this one.

## Cause of this screen (confirmed in code)

The keys exist in `messages/en-US/agents.json` and `messages/es-ES/agents.json`.
The namespace never reached the dialog: `CodeAgentSwitch` calls
`useTranslations("agents")`, and it is drawn by Polar Code (`polar-code.tsx`),
which runs in the shell's Polar dock and on `/polar`. The shell
(`app-chrome.tsx`) hands down `nav, chat, shortcuts, tours, polar` and `/polar`'s
page adds nothing, so `agents` is absent and every key is drawn as itself. "No
model" comes from `CodeModelPicker`, which reads `polar`, so it worked.
`CodeAccountSwitch`, `CodeBootLine` (`polar-code-boot.tsx`) and
`RepoMemorySection`, drawn from the same file, had the same fault.

## Why the guards did not catch it

| Guard | What it checks | Why it passed |
|---|---|---|
| `test/i18n/missing-keys.test.ts` + `catalogs.test.ts` | every literal key is in en-US, and every complete locale has exactly en-US's keys | the keys exist, so nothing was missing from a catalog |
| `test/i18n/keys-are-translated.test.ts` | option tables whose fields are keys reach JSX through `t` | the dialog calls `t`; the namespace is what was missing |
| `test/i18n/client-namespaces.test.ts` | every namespace a client file uses is handed down on every route that renders it | **false negative.** A provider that is not a route file was counted for *everything its file imports*. `polar-code.tsx` contains `<ClientMessages namespaces={["agents"]}>` around its session tools (pull request, share, continue on phone), so every file it imports - including `code-agent-switch.tsx`, drawn outside that element - looked provided. |

The rule "the build breaks if texts are missing" was never true of `next build`:
nothing in the build reads the catalogs. It is the vitest suite that enforces it.
That suite does run where it matters - `dashboard-ci.yml`'s `web-tests` job (all
of `apps/web/test`, eight shards) runs on every pull request, and
`dashboard-publish.yml` calls `dashboard-ci.yml` on every push to main and its
`tag` job only publishes when that call succeeds. The wiring was fine; the
check itself was wrong.

## Earlier occurrences

| Date | What was drawn as a key | Shape | Fix |
|---|---|---|---|
| 2026-10-16 | several client screens | namespace not handed to the route | `ae70c56c6a` (#667): namespaces handed down, first namespace check |
| 2026-10-23 | `tasks.trackers.connect`, `tasks.trackers.emptyTitle` on the connections hub | key missing from its catalog | `4d0c15f0ce` (#911); led to `missing-keys.test.ts` |
| 2026-10-30 | `callSettings.noise.off.label` (call noise levels) | an option table's key drawn without `t` | `60e635838c` (#1005): `keys-are-translated.test.ts` |
| 2026-11-05 | `automations.templates.internetBack.action` on Watch > Connectivity, `agentRollouts.rollout.heading` | namespace not handed to the route; the check counted an embedded `ClientMessages` for all of `(app)` | `75403a5383`: non-route providers counted only for what their file draws |
| 2026-11-10 | labels named after a dotted kind | key split on a dot inside its name | `f0677ff138`: `lookupMessage` tries joined segments |
| 2026-11-25 | Polar Code's Switch agent dialog (this entry) | namespace not handed to the route; the check counted a `ClientMessages` for everything its file imports | this fix |

The 2026-11-05 fix narrowed a provider from "the whole route" to "the whole
file". This one narrows it to what the provider element actually wraps.

## Fix

1. **The screen.** `polar-code.tsx` wraps `CodeAgentSwitch`, `CodeAccountSwitch`,
   `CodeBootLine` and `RepoMemorySection` in `ClientMessages
   namespaces={["agents"]}`, the way it already did its session tools. Once the
   page holds the namespace (`useHasMessages`) nothing is fetched.
2. **The guard** (`client-namespaces.test.ts`). Each file is parsed with the
   TypeScript parser. An import is followed past a provider of a namespace only
   when every place the file uses it sits inside that provider's element,
   including a local constant or function that is itself only used inside one
   (the shell builds its frame in a constant and puts it inside `<Messages>`),
   and a dynamic import is judged by the name its `.then` binds. A file that
   imports only hooks is followed into those hooks' bodies, not the whole
   module. A finding prints the import chain that brings the file onto the
   route. A probe test pins the shape that fooled it. Running it over the whole
   app found these 4 files (`code-agent-switch.tsx`, `code-account-switch.tsx`,
   `polar-code-boot.tsx`, `repo-memory-section.tsx`, all through
   `polar-code.tsx`), and no others.
3. **The safety net.** In development and the tests a missing message is still
   drawn as its key and logged, and a `useTranslations` for a namespace nobody
   handed down logs once, by name. A production build never draws a key:
   - in the browser (`i18n-provider.tsx`, `message-rescue.ts`) a miss draws
     nothing; the misses of one tick go to `/api/i18n/rescue` in one request,
     which logs each key once on the server and answers with the namespaces in
     the reader's language over en-US, and the screen draws again with them;
   - on the server (`lib/i18n/translate.ts`) a key the reader's locale lacks is
     read in en-US, and a key en-US lacks too is blank and logged once.

## Verified

- `client-namespaces.test.ts` fails on main's sources with the 4 findings above
  and passes with the fix; the probe test fails on the old rule.
- The `test/i18n`, `test/components`, `test/design` and `test/build` folders
  pass (see the fix commit for counts).
- Not exercised: the production rescue on a running deployment (no container
  is run on the development machine). It is exercised only through its unit
  behaviour.

## If it happens again

- Note the screen, the exact key shown and the URL. In the server's log look for
  `[i18n] No message for "<key>"` - `(browser)` means a screen lacked its
  namespace or key, `(server)` a server translation did.
- If `client-namespaces.test.ts` passed for that screen, the provider is being
  reached by a way the parser does not follow (a provider passed as a prop, a
  component handed through context or a registry). Extend that test with the
  new shape as a probe, then fix the screen; do not add a parallel check.
