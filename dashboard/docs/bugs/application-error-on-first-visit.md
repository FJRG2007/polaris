# Opening Polaris at its address crashed the tab, and a reload fixed it

**Found:** October 2026. **Fixed in:**
`dashboard/apps/web/src/app/page.tsx` (new, was `src/app/(app)/page.tsx`),
`dashboard/apps/web/next.config.mjs`,
`dashboard/apps/web/src/app/(app)/chat/call-elsewhere.tsx`,
`dashboard/apps/web/src/app/(app)/chat/meeting-actions.ts`,
`dashboard/apps/web/src/app/api/chat/meetings/elsewhere/route.ts`,
`dashboard/apps/web/src/lib/chat/call-elsewhere-request.ts`,
`dashboard/apps/web/src/components/use-router-settled.ts`,
`dashboard/apps/web/src/components/time-zone-reporter.tsx`,
`dashboard/apps/web/src/components/i18n/i18n-provider.tsx`,
`dashboard/apps/web/src/components/incoming-calls.tsx`,
`dashboard/apps/web/src/app/(app)/apps/databases/stats-panel.tsx`,
`dashboard/apps/web/eslint.config.mjs`.
**Guarded by:** `dashboard/apps/web/test/navigation/redirect-inside-loading.test.ts`,
`dashboard/apps/web/test/components/use-router-settled.test.tsx`,
`dashboard/apps/web/test/chat/call-elsewhere-request.test.ts`,
and `react-hooks/rules-of-hooks` (run by `npm run lint`), which is what
`stats-panel.tsx`'s own fix relies on - it has no dedicated test.

## What was seen

Opening Polaris at its address - the one visit every signed-in person makes
before any other - showed "Application error: a client-side exception has
occurred" (Minified React error #310) and the tab was dead. Reloading the
same address worked.

## What it actually was

Two things met on that one visit only.

`/` was `src/app/(app)/page.tsx`, a page in the signed-in group whose entire
job was `redirect()` to the reader's home (the first app their role opens, or
their account page). That group draws every page inside its `loading.tsx`,
which is a Suspense boundary - so by the time the page decided to leave, the
frame had already gone out with a 200, and the redirect travelled inside the
stream instead of arriving as one. The browser carried it out while it was
still hydrating.

At that same moment, the frame's `CallElsewhere` card asked a server action
from a mount effect to find out whether this account was already in a call on
another device. A server action is a router action: the App Router waits on
it. A router action in flight while a streamed redirect is being carried out
makes the React that Next 15 ships commit a half-rendered router - fixed
upstream in React 19.3 (`facebook/react#36911`), but every Next 15.5.x up to
15.5.27 vendors the unfixed React. Hence #310 ("Rendered more hooks than
during the previous render") on a visit that only ever happens once per
browser, and a clean reload, because a reload lands on `/home` and never
passes through `/` at all.

## The fix

- `/` moves out of the `(app)` group entirely (`src/app/page.tsx`), so its
  redirect is a plain 307 sent before anything is drawn - nothing is ever
  streamed through a loading boundary for it.
- The other pages whose only job was forwarding - `/account/notes`,
  `/admin/reports`, `/apps/agents/keys`, `/apps/deploy/:projectId/firewall` -
  become `next.config.mjs` redirects for the same reason: a 307 outside any
  boundary instead of a page that renders only to leave.
- "Is this account already in a call elsewhere" is a `GET` route
  (`/api/chat/meetings/elsewhere`) instead of a server action. A route is a
  read, invisible to the router, and safe to poll - which matters separately,
  since both the `CallElsewhere` card and the ringing that has to stop once a
  call is answered elsewhere ask it, and polling it must not count as account
  activity.
- Anything that still reaches the router unprompted - the time-zone report,
  the signed-out language redraw - now waits for `useRouterSettled()` first:
  true once a streamed redirect, if any, has already moved the browser off
  the path the document was served for.

Separately, `BiggestPanel` and `FrequentPanel` in the database insights panel
called `useTranslations` after an early return, so the render that took that
branch ran one hook fewer than the one before it (`Rendered fewer hooks than
expected`) - the same class of crash, found independently, fixed by moving
the call above the return. `eslint.config.mjs` now runs
`react-hooks/rules-of-hooks` (`npm run lint`, which CI already runs
`--if-present`) so an early return before a hook fails lint before it ever
reaches a browser. The rule reads any `use...`-named function as a hook,
which is why `useLocalPath`/`useLocalPathAction` in `server-local-path.ts`
and `servers/actions.ts` are `adoptLocalPath`/`adoptLocalPathAction`, and a
plain callback parameter once named `use` is `work`.

## What stops it coming back

`redirect-inside-loading.test.ts` fails any `page.tsx` under a `loading.tsx`
boundary whose default export calls `redirect`/`permanentRedirect`
unconditionally, and separately asserts the dashboard root stays outside
every boundary. `use-router-settled.test.tsx` covers the settled/unsettled
transition itself. `call-elsewhere-request.test.ts` covers the route and the
client helper that replaced the server action. `react-hooks/rules-of-hooks`
now runs on every `npm run lint`, so a hook after an early return anywhere in
the app fails before merge rather than waiting for the one render path that
takes it.

## The general rule

A page whose only job is an unconditional redirect must never sit inside a
Suspense/loading boundary: the redirect becomes something the browser carries
out mid-stream instead of a response it gets before rendering starts, and
whatever else talks to the router at that moment decides whether the crash is
visible. Prefer a redirect that never enters React at all - a framework-level
rule (`next.config.mjs`) or a route outside every group - over a page whose
entire body is `redirect()`. And a hook called after a component's first
early-return branch is not a hook that always runs in the same order; a lint
rule that proves the order statically catches it on every commit, which a
test only catches on the one render path somebody thought to write.
