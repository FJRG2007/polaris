# A disabled Google API told people to reconnect, forever

**Found:** October 2026. **Fixed in:**
`dashboard/packages/core/src/provider-api-errors.ts`,
`dashboard/apps/calendar/src/lib/google-api-state.ts`,
`dashboard/apps/calendar/src/lib/sync/errors.ts`,
`dashboard/apps/calendar/src/lib/sync/google.ts`,
`dashboard/apps/calendar/src/lib/sync/graph.ts`,
`dashboard/apps/calendar/src/lib/sync/http.ts`,
`dashboard/apps/calendar/src/lib/sync-engine.ts`,
`dashboard/apps/calendar/src/lib/sources.ts`,
`dashboard/apps/calendar/src/lib/wire.ts`,
`dashboard/apps/calendar/src/actions/sources.ts`,
`dashboard/apps/calendar/src/screens/accounts/accounts-view.tsx`,
`dashboard/apps/web/src/lib/connections/google-api-health.ts`,
`dashboard/apps/web/src/lib/calendar-host.ts`,
`dashboard/apps/web/src/app/(app)/admin/integrations/actions.ts`,
`dashboard/apps/web/src/app/(app)/admin/integrations/integrations-view.tsx`.
**Guarded by:** `dashboard/apps/web/test/calendar/sync/provider-errors.test.ts`,
`dashboard/apps/web/test/calendar/server/sync-engine.test.ts`,
`dashboard/apps/web/test/calendar/screens/accounts-setup.test.tsx`,
`dashboard/apps/web/test/connections/google-api-health.test.ts`,
`dashboard/apps/web/test/connections/google-calendar-consent.test.ts`.

## What was seen

A Google account linked for calendars would sync for a while and then just
stop. The account's status read "Needs reconnecting", exactly like a revoked
grant. Reconnecting it changed nothing: the next sync pass failed the same
way, and it kept asking to reconnect again.

## What it actually was

Google answers `403` for several unrelated reasons, and the sync clients read
only the HTTP status, never the JSON body that says which one. `errorFor`
(`lib/sync/http.ts`) mapped every `401`/`403` straight onto `SyncAuthError`,
"the credentials were refused" - the one case reconnecting actually fixes.

The real cause here was the opposite of a credentials problem: the Google
Calendar API was switched off in the Cloud project the operator's OAuth client
belongs to (Google's `accessNotConfigured` / `SERVICE_DISABLED`). Nobody's
grant was wrong, there was nothing to reconnect, and no number of reconnects
turns an API back on in somebody else's Cloud console - only the person who
runs that project can do that, and the account screen gave them no way to
learn it needed doing.

## The fix

The error body is read now, not just the status (`readGoogleApiError`,
`readGraphApiError` in `packages/core/src/provider-api-errors.ts`), and sorted
into what someone can actually act on: `setup` (the API is off in the
project - keeps the project number and the provider's own activation link
exactly as the answer gave them), `consent` (the grant is missing a scope -
reconnecting fixes this one), `rate` (slow down, not an auth problem), and
`auth` (the credentials themselves were refused).

A source failing with `setup` gets its own status and is never offered a
reconnect button (`SourceRow`/`SetupNote` in `accounts-view.tsx`): an
administrator sees the project and a direct link to turn the API on, everyone
else is told to ask one. The sync engine remembers the API's state across
every account that shares the same project (`google-api-state.ts`, one
`Setting` row) and retries with a growing gap on its own
(`nextSetupRetry`) - and the moment any call succeeds again, every source
still waiting is made due at once (`recordGoogleCalendarApiOn`) instead of
each sitting out its own backoff. The same state backs a **Google APIs**
panel on `/admin/integrations` (`google-api-health.ts`), so whoever can fix
this sees it on the screen where they already manage the Google client,
without needing a calendar to notice first.

## What stops it coming back

`provider-errors.test.ts` drives fixture Google and Graph error bodies
(`test/calendar/sync/fixtures/provider-errors.json`) for every kind, including
that a `403` with no reason still falls back to the status rather than being
guessed into one of the four. `sync-engine.test.ts` covers the retry and
auto-recovery of sources parked in `setup`. `accounts-setup.test.tsx` covers
that `setup` never offers reconnect and that a non-admin and an admin read
different copy for it. `google-api-health.test.ts` and
`google-calendar-consent.test.ts` cover the admin panel and that a missing
scope reads as `consent`, not `setup` or plain `auth`.

## The general rule

An HTTP status is not the error. A provider that reuses one status code for
several causes has to be read by its body before the failure is sorted into
"reconnect", because sorting by status alone can offer the one fix that is
guaranteed never to work and never say what would.
