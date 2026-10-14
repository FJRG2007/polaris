# Polaris CRM - what it covers

Polaris CRM is an installable app (`dashboard/apps/crm`, package
`@polaris-app/crm`, catalog id `crm`, route `/crm`, permission `crm.use`) built
the way Calendar, Places and Game servers are: a bundle that reaches the
dashboard only through `@polaris/app-host`, listed in the marketplace,
switched on and off by the operator. Uninstalling keeps every record;
installing again finds them.

This file is a reference for whoever next touches the CRM, so the feature set
does not have to be rediscovered by reading fifty files. It documents what is
there today; it is not a plan with deferred work, because none was found while
writing it.

A CRM is either one person's own or one organization's shared instance (its
"shelf", `lib/access.ts`'s `Shelf`); an organization's shelf is governed by its
own roles. Three kinds of record: `companies`, `people`, `opportunities`
(`model/objects.ts`'s `CRM_OBJECTS`).

## Fields

Eighteen built-in field kinds (`model/objects.ts`'s `FieldKind`): `text`,
`fullName`, `email`, `phone`, `url`, `links`, `address`, `domain`, `number`,
`currency`, `date`, `dateTime`, `select`, `multiSelect`, `rating`, `boolean`,
`member`, `relation`. A person may add a field of twelve of those kinds
(`CUSTOM_KINDS`); companies, people and opportunities carry a few built-in ones
each (name, domain, employees, stage, close reason, and so on) plus
`createdAt`/`updatedAt`/`createdBy`/`updatedBy`, the last two a `member` field
that is read-only and hidden by default.

A field somebody adds claims a free slot column of the record's table
(`SLOT_FAMILIES`: ten text, five number, five date, five boolean slots per
object), so filtering, sorting, grouping and totals run in the database exactly
as for a built-in field (`lib/fields.ts`). Deleting a field, or one of a
select's choices, empties what records held there and drops it from every
saved view's filter, sort and columns in the same transaction.

What a person may write into a field is normalized the same way on both sides
(`model/values.ts`'s `normalizeInput`): trimmed, an address lowercased, a web
address reduced to its host, a rating bounded 1-5, an amount rounded, a
multi-select or links list read as JSON.

## Roles: who reaches what

An organization's role is held to a per-object `ObjectRule`
(`model/roles.ts`): `rows` ("all" or "own" - only records the holder owns or
made), `hidden` fields never sent to that role, and `readOnly` fields it sees
but may not change. The primary (name) field can never be hidden or read-only.
A personal shelf and an org owner or a role holding every permission are never
bound by any rule (`OPEN_RULES`).

Row scope is enforced in the query, never by filtering after the fact
(`lib/access.ts`'s `recordWhere`/`ownClause`). A hidden field is stripped on
every read; a read-only one blocks every write, `requireChangeable`. The board
(kanban) view follows the same rule on its grouping field: with that field
locked, a card neither drags nor offers the move menu, and no column offers a
new card (`screens/board.tsx`, `screens/list-screen.tsx`) - a board lock is the
general field rule, not a mechanism of its own.

Edited from `screens/roles-screen.tsx`: per role, per object, per field, a
change/read-only/hidden toggle and the row scope. Server side:
`actions/roles.ts`, `lib/roles.ts`.

## Records

Every write records who did it (`updatedById`/`createdById`, a `member`
field) and is logged to the record's own timeline (`model/timeline.ts`'s
`EVENT_KINDS`: created, updated, trashed, restored, imported) by
`lib/timeline.ts`, called from `lib/records.ts` after the write lands - a
failed log never undoes or blocks the change it describes.

Deleting is soft (`lib/records.ts`'s `trashRecords`/`restoreRecords`): a
destroyed record (`destroyRecords`, only from the trash) clears every relation
pointing at it, with its own audit trail, and removes its links, favorites and
events. Up to 500 records at once (`MAX_BULK`) can be edited together.

A record's page shows the other objects that point at it - a company's people
and deals, a person's deals - derived automatically from the `relation` field
definitions (`model/related.ts`), with no separate configuration.

### Duplicates and merging

Looked up by a per-object set of fields (`model/duplicates.ts`'s
`DUPLICATE_FIELDS`: name+domain for companies, name+email for people, name for
opportunities), case- and space-folded. `lib/duplicates.ts`'s `findDuplicates`
runs on every create, update and import row, respecting the role's row scope
and hidden fields, and the editor's `screens/use-duplicate-warning.ts` shows
what it found.

Merging (`lib/merge.ts`'s `mergeRecords`, up to `MAX_MERGE` = 5 records at
once) fills the kept record's empty fields from the others in the order given,
repoints everything that pointed at the merged records (people and
opportunities at a company, opportunities at a contact), requires edit rights
and an unlocked field on the pointing side before it repoints anything, dedupes
and repoints linked notes/tasks/files, and sends the merged-away records to the
trash rather than deleting them outright. `screens/merge-dialog.tsx` is where
somebody picks which record to keep.

## Views, filters, totals, import, export

A view (`model/views.ts`) is table or kanban, shared per shelf (up to
`MAX_VIEWS` = 50), and stores its columns (width, hidden, total), up to
`MAX_SORTS` = 3 sorts, a filter, a group and - for a board - the field its
columns come from. `readConfig` repairs a stored view against today's fields
rather than trusting it blindly, since what is stored can outlive the field it
names.

Filters (`model/filters.ts`) are rules on fields, nested one level into groups,
joined "all of" or "any of"; `lib/filters.ts` compiles them to a Prisma
`where`. Column totals (`lib/totals.ts`) run in the database over the same
rows the table lists, never in memory.

CSV import (`model/import.ts`, `lib/import.ts`): capped at `MAX_IMPORT_ROWS` =
10,000 rows, `MAX_IMPORT_COLUMNS` = 64 columns, `MAX_IMPORT_BYTES` = 5 MB;
columns auto-map onto fields by name, overridable in `screens/import-dialog.tsx`;
the preview runs the exact `normalizeInput` checks the server will, so what is
shown is what will be refused; an optional duplicate skip catches a match
already on the shelf or within the same batch; every row lands inside one
transaction, each new record logged as an "imported" event.

CSV export (`lib/export.ts`'s `exportRecords`) streams the view's own filter,
search, sort and columns in batches, capped at `MAX_EXPORT` = 10,000 rows with
a `truncated` flag; a column hidden from the reader's role is silently dropped
rather than refused, since a view can be shared with a role that lacks it.

## Audit log

A shelf-wide log (`lib/audit.ts`'s `listAudit`), but only for objects where the
reader's role is not row-scoped to "own" - an "own" role reads a record's
history on the record itself instead (`lib/timeline.ts`'s `listTimeline`).
Queried by object, event kind, actor and date range, paged 50 at a time
(`AUDIT_PAGE`). Exported as CSV, one row per changed field, capped at
`AUDIT_EXPORT_LIMIT` = 5,000 rows with a `truncated` flag. A field hidden from
a role never appears in what it reads back. Screen: `screens/audit-screen.tsx`.

## Workflows

A workflow fires on a trigger (`model/workflows.ts`'s `TRIGGER_KINDS`):
`created`, `updated`, `fieldChanged` (to anything, or to a named value),
`deleted`, `manual` (a button on the record page), `schedule` (a cron
expression in a time zone), or `webhook` (a call to the workflow's own secret
address). It then runs up to `MAX_WORKFLOW_ACTIONS` = 10 actions per workflow
(`MAX_TOTAL_ACTIONS` = 30 counting the ones inside a branch or loop):

- Leaf actions: `updateRecord`, `createRecord`, `createTask` (in a Polaris
  Tasks list, linked back to the record), `notify` (an in-app notification),
  `sendEmail` (from the workflow owner's own mailbox), `sendChat` (post to a
  chat channel as the owner), `httpRequest` (POST the record as JSON to an
  outside address).
- Control flow: `filter` (end the run, cleanly, unless the record matches),
  `ifElse` (one list of actions or the other), `forEach` (run the actions over
  up to `MAX_FOUND` = 50 matching records), `delay` (wait up to
  `MAX_DELAY_MINUTES` - thirty days - then go on; the run persists as
  "waiting" and resumes from a scheduled job).

Every value an action writes can hold a `{{field}}` template read off the
record the workflow is about, or `{{body.a.b}}` off an inbound webhook's JSON
body (`renderTemplate`). A workflow always runs as whoever last saved it, with
that person's current role rights re-checked on every run
(`lib/workflows.ts`'s `runnerOf`) - it never does on its own what its author
could not do by hand. Its own writes never set off another workflow
(`withinWorkflow`, an `AsyncLocalStorage` guard), so two workflows that point at
each other cannot loop.

Every run is kept in a log (`CrmWorkflowRun`: running, waiting, done, stopped,
failed, cancelled, with its cause and error) up to the latest `MAX_RUNS` = 100
(always keeping the waiting ones), shown from `screens/workflows-dialog.tsx`.
Every save is snapshotted (`CrmWorkflowVersion`, up to `MAX_VERSIONS` = 20,
skipped when nothing changed) and listed the same way. `screens/workflow-diagram.tsx`
draws a workflow read-only as its steps: the trigger, then each action in
order, a branch's two lists side by side, a loop's actions inside it.

The inbound webhook (`routes/api/crm/hooks/[secret]/route.ts`) keeps only the
SHA-256 of its secret, shown once at creation; it is rate-limited per caller
address and per workflow, and a body over `MAX_HOOK_BODY` (64 KiB) or an
unknown secret is refused. A `schedule` trigger is read by a one-minute cron
job (`lib/crm-extension.ts`'s `crm-workflow-schedules`, leased so two passes
cannot claim the same due run twice).

## Sales pipeline: stage, forecast, stage flow

An opportunity moves through six fixed stages
(`model/objects.ts`'s `OPPORTUNITY_STAGES`: new, screening, meeting, proposal,
customer, lost - "customer" is won); a `closeReason` field, hidden by default,
records why one closed either way.

The forecast (`model/forecast.ts`, `lib/forecast.ts`) is per period (month or
quarter, up to twelve periods ahead) and per currency: the amount already won,
the amount still open, and an expected figure - won plus each open deal's
amount weighted by its stage's odds of closing. The odds are editable by anyone
who may edit opportunities and stored once per shelf.

Stage flow (`model/stage-flow.ts`) is read back out of the audit timeline's own
stage-change events, never tracked separately: for each stage, how many deals
ever reached it, how many of those went on to win, how many sit there now, and
the average days spent there; plus an overall win rate and a count of won and
lost reasons. `screens/forecast-screen.tsx` and `screens/stage-flow-panel.tsx`
draw the two together.

## Dashboards

Named, per-shelf dashboards (`CrmDashboard`, up to `MAX_DASHBOARDS` = 50), each
up to `MAX_WIDGETS` = 24 widgets. A widget (`model/dashboards.ts`) is a
`number`, `bar`, `line` or `donut` chart over a measure (count, sum, average,
min, max of a number/currency/rating field), optionally split by a categorical
field or by date at a chosen granularity, optionally scoped to a saved view's
filter. Every figure is computed by the database (`aggregate`/`groupBy`),
reading at most `CATEGORY_CAP` = 1,000 distinct values for a categorical split
or `DATE_CAP` = 20,000 for a date one, flagging `capped` past that; a
categorical split then shows only the top `MAX_GROUPS` = 10 values on the
chart, folding the rest into "Other", and a date split gives up (`null`)
rather than draw past `MAX_BUCKETS` = 400 points on one line. Drawn as plain
SVG/HTML (`screens/widget-charts.tsx`) from a fixed, colour-blind-checked
palette, with every value also written as text rather than left to colour
alone.

## Cross-app surfaces

- **Mail and meetings on a record.** Not CRM data: `apps/web/src/lib/crm-host.ts`'s
  `crmMailWith`/`crmEventsWith` ask the Mail and Calendar apps for the reader's
  _own_ threads and events with the addresses on the record (a company's
  people's emails, an opportunity's contact and company) - never another
  teammate's mailbox. Answered as `null`, and so not drawn, when the reader
  lacks the app's permission or the role hides the email field. Shown on the
  record page by `screens/record-activities.tsx`.
- **Notes, tasks and files.** `model/links.ts`/`lib/links.ts` keep only the id
  of a Polaris Notes note, Tasks task or Drive file tied to a record; each app
  is re-asked for it on every read, so a deleted or no-longer-reachable one
  simply disappears rather than erroring.
- **Favorites and the app rail.** `CrmFavorite` pins a record or a view per
  shelf, per person, up to `MAX_FAVORITES` = 50 (`lib/favorites.ts`); what is
  pinned is re-resolved through the normal shelf and role checks on every read,
  so a trashed record or a now-hidden object quietly drops off. This is the
  first user of two generic `AppExtension` hooks
  (`apps/web/src/lib/app-extensions/types.ts`): `favorites`, for an app's own
  rail section, and `searchRecords`, for its records to appear in the
  dashboard's own search - CRM wires both in `apps/crm/src/lib/crm-extension.ts`,
  and any future app can offer the same two hooks rather than inventing its own
  pin table, which is exactly the duplication `docs/cross-cutting.md` tracks.

## Where it lives

```
model/            pure, client-safe: field/record/view/filter/role/workflow shapes,
                  normalization and CSV encoding - shared by the browser and the server
lib/              server-only: access control, queries, the server half of every
                  feature above
actions/          the server actions screens call
screens/          the CRM's own React surface, under /crm
routes/           the inbound workflow webhook
```

Tests live under `apps/web/test/crm/model`, `apps/web/test/crm/server` and
`apps/web/test/crm/screens`, mirroring that split.
