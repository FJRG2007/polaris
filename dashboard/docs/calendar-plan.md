# Polaris Calendar - plan, feature matrix and ledger

Polaris Calendar is an installable app (`dashboard/apps/calendar`, catalog id
`calendar`, route `/calendar`, permission `calendar.use`) built the way Places and
Game servers are: an app bundle that reaches the dashboard only through
`@polaris/app-host`, listed in the marketplace, switched on and off by the operator.
Uninstalling keeps every row; installing again finds them.

This file is the ledger. A successor resumes from the **Work-unit ledger** at the
bottom - never from memory.

## Sources read

- Nextcloud Calendar 6.7.0-dev.1, cloned at `references/repos/nextcloud-calendar`
  (src/views, src/components, src/store, src/models, src/utils, lib/, appinfo,
  CHANGELOG). 155 features inventoried; numbers below (`NC-n`) refer to that list.
- Google Calendar help center: shortcuts (answer/37034), sharing (37082),
  appointment schedules (10729749), working hours (7638168), focus time
  (11190973), time insights (10738043), time zones (37064), views (6110849),
  settings (6084644), print (41067), import (37118), export (37111), embed
  (41207), holidays (13748345), birthdays (13748346), search (37176), attachments
  (6192039), inviting (37161), notifications (37242).
- Proton Calendar support: subscribe-to-external-calendar, share-calendar-via-link,
  share-calendar-with-proton-users, calendar/features, public-holiday-calendars,
  calendar-zoom, calendar-meet, calendar-availability,
  calendar-appointment-scheduling, business/faq.
- Thunderbird calendar (SUMO: creating-new-calendars, exporting-and-sharing,
  email invitations with CalDAV), SOGo (sharing options, installation guide),
  Radicale (radicale.org/master.html), Cal.com (min-notice, round-robin,
  disable-canceling-rescheduling, event-types API).
- Protocols: Google Calendar sync guide (syncToken, 410 Gone) and resource
  versions (etag, If-Match, 412); Microsoft Graph `calendarView/delta`;
  RFC 6578 sync-collection; Apple ctag draft; RFC 6764 `.well-known/caldav`;
  RFC 5545 iCalendar; RFC 6047 iMIP; RFC 5546 iTIP.

**Proton Calendar has no public API and no CalDAV** (its own page: CalDAV "would
mean adapting to an outside protocol that does not share Proton's encryption
model"; the business FAQ: it does not work with third-party apps). The only way to
bring it into Polaris is its share link (ICS subscription, read-only, Proton
refreshes it every few hours). The UI says so in those words.

## Architecture

| Layer | Where | What |
| --- | --- | --- |
| Pure engine | `packages/core/src/calendar/*` | iCalendar parse/serialize (ical.js), recurrence expansion with RRULE/RDATE/EXDATE/RECURRENCE-ID, time-zone math on `Intl` (no tz database shipped), alarms, free/busy, booking slots, recurrence editing (this / this and following / all), iTIP messages. Every function takes "now" as an argument. |
| Data | `packages/db/prisma/schema.prisma` (`Calendar*` models) | iCalendar text is the source of truth per object; indexed columns (`startsAt`, `endsAt`, `summary`) are derived on write for range queries and search. |
| App server | `apps/calendar/src/lib/*` | calendars, objects, sharing, trash, import/export, public links, reminders job, invitations, booking pages, sync engine (Google, CalDAV, Microsoft Graph, ICS). |
| App screens | `apps/calendar/src/routes/calendar/**` | the calendar, its settings, booking and public pages. |
| Dashboard | `apps/web` | catalog + nav entry, catch-all page/route, public surface, permission, notification events, connection flow `scope=calendar`, host services. |

Decisions:

- **ical.js 2.2.1 (MPL-2.0)** parses and serializes iCalendar and iterates
  recurrence rules. It is what Nextcloud Calendar and Thunderbird use; an own
  RRULE engine would be the riskiest code in the app. MPL-2.0 is file-level and
  compatible with Polaris's Apache-2.0 when used unmodified as a dependency.
- **No tz database dependency.** Expansion runs in the event's local wall time
  (RFC 5545 requires it) and each wall time is turned into an instant with `Intl`
  for its TZID. A VTIMEZONE block in a file is kept verbatim for round trips; a
  TZID `Intl` does not know is resolved through the Windows-name map and, failing
  that, through the file's own VTIMEZONE via ical.js.
- **FullCalendar 6 (MIT parts only: core, daygrid, timegrid, list, multimonth,
  interaction)** draws day/week/month/year/list with drag, resize and select, the
  same engine Nextcloud uses. It runs in UTC mode and is handed wall times of the
  reader's display zone, so named zones need no luxon/moment plugin. The premium
  resource-timeline is not used.
- **Two-way sync, local write-through.** A change to an event on an external
  calendar is written to the provider first with `If-Match: <etag>`. A 412 means
  it changed there: the provider's copy wins, and the local edit is kept aside on
  the object (`conflictIcs`) with a banner offering to re-apply it. A failure that
  is not a refusal (network) queues the change (`pendingPush`) and the sync job
  retries it. Nothing blocks a render: screens read the local store; the job
  (`calendar-sync`, leased) pulls every source due.
- **Tasks stay in Tasks.** The Calendar shows Tasks-app tasks with a due date as a
  read-only overlay layer and creates tasks in Tasks; VTODOs that arrive from an
  outside CalDAV calendar are shown and edited as calendar objects. No second task
  store.
- **Invitations.** Polaris attendees get the event in their own calendar ("needs
  action") and a bell entry; outside attendees get an iMIP email (REQUEST/CANCEL
  with the `.ics` attached) carrying an RSVP link, because Polaris receives no
  mail. On Google/Outlook/CalDAV calendars the provider schedules
  (`sendUpdates=all`, server-side scheduling) and Polaris does not send twice.

## Feature matrix

Legend: NC Nextcloud, G Google, P Proton, TB Thunderbird, S SOGo, C Cal.com.
Phase 1 = this build. Status is tracked in the ledger, not here.

### Views and navigation

| Feature | Has it | Polaris plan | Phase |
| --- | --- | --- | --- |
| Day, week, month (+N more), year, list/agenda views (NC-1..5) | NC G P TB S | FullCalendar views; agenda = list over the coming 30 days (G "Schedule") | 1 |
| Custom N-day view (G "4 days") | G | view option 2-7 days | 1 |
| Remembered last view, deep links `/calendar/<view>/<date>`, `/calendar/e/<id>` (NC-6,7) | NC G | URL is the state | 1 |
| Drag to move, resize from either edge, select to create (NC-8..10) | NC G TB | FullCalendar interaction, optimistic with rollback | 1 |
| Click a day / week number to open it (NC-11) | NC G | nav links | 1 |
| Participation styling, faded past events, struck-through cancelled (NC-12,13) | NC G | event classes | 1 |
| Screen-reader labels on events (NC-14) | NC | aria-label per event | 1 |
| Locale date formats, first day of week (NC-15) | NC G | locale + setting | 1 |
| Live refresh on remote change (NC-16) | NC G | refetch on focus + after each sync tick, SSE later | 1 |
| Date picker, previous/next, today, new event (NC-17..19) | all | header | 1 |
| Filter/search events (NC-20; G advanced search) | NC G TB | search box over loaded range + server search across all time (title, location, description, attendees) | 1 |
| Calendar list, reorder, show/hide, colour (NC-21,23) | all | sidebar | 1 |
| Shared-with-you / delegated sections and badges (NC-22,24) | NC G | sidebar groups | 1 |
| Muted-notifications indicator (NC-25) | NC | icon | 1 |
| Undo while deleting/unsharing a calendar (NC-26) | NC | toast with Undo | 1 |
| Loading placeholders (NC-27) | NC | skeleton rows only where waiting | 1 |
| Unscheduled tasks panel, drag onto grid (NC-28,130) | NC | Tasks without due date, drop sets due | 1 |
| Meeting proposals list (NC-29,120-122) | NC | proposals with public voting page | 1 |
| Appointment schedules list (NC-30) | NC G P C | sidebar section | 1 |
| Secondary time zone column (G) | G | second axis label in day/week | 1 |
| World clock (G) | G | settings list, shown in sidebar | 1 |
| Hide declined, dim past, show weekends, week numbers (G, NC-144) | NC G | settings | 1 |
| Keyboard shortcuts incl. `?` overview (NC table, G list) | NC G | union of both lists, see below | 1 |
| Print (G: range, orientation; NC print css) | NC G TB | print view with range + orientation | 1 |

### Calendars, sharing, publishing, subscriptions

| Feature | Has it | Polaris plan | Phase |
| --- | --- | --- | --- |
| New calendar, with or without tasks (NC-31,32) | all | component set per calendar | 1 |
| Edit name (not blank), colour, description, time zone (NC-33) | all | dialog | 1 |
| Per-calendar default reminders, timed and all-day (NC-34; G) | NC G | stored on calendar | 1 |
| Mute a calendar's alarms (NC-35) | NC | flag | 1 |
| "Never show me as busy" (NC-36) | NC | calendar transparency, excluded from free/busy | 1 |
| Supported components shown (NC-37) | NC | badge | 1 |
| Export calendar .ics (NC-38; G, P) | all | `/api/calendar/export/<id>` | 1 |
| Delete / unshare from me (NC-39) | NC G | to trash / remove share | 1 |
| Default calendar for invitations (NC-40) | NC | setting | 1 |
| Share with users, teams; read or write (NC-41..43; G 5 levels; P view/edit; S levels) | NC G P S | levels: free/busy, read, write, manage (G's model, a superset of NC and P) | 1 |
| Federated sharing (NC-44) | NC | Polaris has no instance-to-instance federation; the equivalent is the public link subscribed from the other side. Not built. | n/a |
| Copy internal link (NC-45) | NC | copy `/calendar?c=<id>` | 1 |
| Public link on/off, copy, webcal link, email it, embed code (NC-46..49; G, P limited/full) | NC G P | token link, `limited` (busy only) or `full` view, `.ics` feed, iframe | 1 |
| Public page and embed page (NC-50..52,149) | NC G | `/cal/p/<token>`, `/cal/embed/<token>` | 1 |
| Subscribe by URL (http/https/webcal) (NC-54; G, P, TB) | all | ICS source, refresh interval, SSRF-guarded fetch | 1 |
| Holiday calendars by region (NC-55; G, P) | NC G P | catalogue of public ICS feeds per country | 1 |
| Admin-suggested public calendars, disable link subscriptions (NC-56,57) | NC | instance setting | 1 |
| Birthday calendar (NC-143; G) | NC G | Polaris profiles carry no birthday and Polaris has no contacts app, so there is nothing to derive one from; a linked Google account's own birthdays calendar syncs like any other | n/a (no source) |
| Serve Polaris calendars over CalDAV to phones/desktop (NC core, Radicale) | NC S | CalDAV server with per-user app passwords | 2 |

### Event editor

| Feature | Has it | Polaris plan | Phase |
| --- | --- | --- | --- |
| Quick popover + full editor, view mode (NC-58,59; G) | NC G | popover (skippable in settings) and full dialog | 1 |
| Title, start/end, all-day, local time hint (NC-61,62) | all | | 1 |
| Separate start/end time zones (NC-63) | NC G | | 1 |
| Duration presets (NC-64) | NC | | 1 |
| Calendar picker (NC-65) | all | writable calendars only | 1 |
| Location, description with clickable links (NC-66,67) | all | | 1 |
| Status confirmed/tentative/cancelled (NC-68) | NC TB | | 1 |
| Show as free/busy (NC-69; G) | NC G | TRANSP | 1 |
| Visibility public/confidential/private (NC-70; G) | NC G | CLASS; sharees below "read" see busy only | 1 |
| Categories (NC-71) | NC TB | 15 defaults + custom | 1 |
| Event colour (NC-72; G) | NC G | COLOR property | 1 |
| Attachments (NC-73; G Drive) | NC G | link attachments + upload into Polaris Drive | 1 |
| Conference link (NC-74 Talk; G Meet; P Meet/Zoom) | NC G P | "Add a Polaris meeting" creates a Chat meeting link | 1 |
| Save/delete this / this and following / all (NC-75,76) | NC G | engine `editRecurring` | 1 |
| Duplicate, export one event, copy link (NC-77..79; G duplicate) | NC G | | 1 |
| Confirm before discarding changes (NC-80) | NC | dialog | 1 |
| Allow forwarding / guest permissions (NC-82; G modify/invite/see guests) | NC G | X-properties honoured by Google mapping | 1 |
| Attendee warning that changes will not reach organizer (NC-84) | NC | banner | 1 |
| Event types: out of office (auto-decline), focus time, working location (G) | G | OOO and focus as event kinds; auto-decline for Polaris invitations | 1 |
| Rich text description (G) | G | plain text with links (NC parity); rich text | 2 - iCalendar DESCRIPTION is plain text; X-ALT-DESC HTML round-trips but an editor for it is not NC parity |

### Recurrence editor (NC-85..96)

Daily/weekly/monthly/yearly, interval, weekdays, by month day or "on the
[1st..5th, second-to-last, last] [weekday/day/weekday/weekend day]", months,
until date or count, human summary, unsupported-rule warning (rule kept intact and
read-only), exceptions cannot get a rule, all-day locked inside a series. All
phase 1.

### Reminders (NC-97..103; G up to 5; P)

Presets for timed and all-day events, relative (before/after start or end) and
absolute triggers, notification and email types (audio shown when present), per
calendar and global defaults, shown in view mode. Delivered by the
`calendar-reminders` job through Polaris notifications (bell, browser, the
account's own routes) and email (notification email channel). Phase 1.

### Attendees, invitations, free/busy, resources (NC-104..119; G; P; S)

| Feature | Polaris plan | Phase |
| --- | --- | --- |
| Attendee search over Polaris users, teams, typed emails (NC-104,107) | host directory search | 1 |
| Roles chair/required/optional/non-participant, RSVP toggle (NC-105,106) | ROLE, RSVP | 1 |
| Organizer choice (NC-108) | from the calendar owner's addresses | 1 |
| Response counts, copy/email all attendees (NC-109,110) | | 1 |
| Status avatars (NC-111) | | 1 |
| Accept/decline/tentative for one occurrence or series (NC-112) | Polaris users in-app; outside people via RSVP link | 1 |
| iMIP email REQUEST/CANCEL with .ics (RFC 6047) | notification email channel | 1 |
| Find a time: free/busy grid, suggestions (NC-113; G) | free/busy over Polaris calendars (respecting TRANSP and share level) | 1 |
| Resources and rooms with capacity/features, room availability (NC-114..118; G rooms; S) | resource calendars managed by administrators, invited as CUTYPE=ROOM/RESOURCE | 1 |
| Availability from a person's card (NC-119) | profile card shows free/busy now | 1 |
| Incoming iMIP in the Mail app (TB, G) | Mail shows an invitation card with RSVP | 2 - belongs to the Mail app's message renderer, not the Calendar bundle |

### Time zones (NC-123..126; G secondary tz)

Automatic or chosen display zone, warning when detected zone is UTC or unknown,
event zones, secondary zone, zone on booking pages and emails. Phase 1.

### Tasks (NC-127..130)

Tasks with due dates shown in the grid (Tasks-app tasks + VTODO from outside
calendars), clicking opens the task in Tasks, unscheduled tasks panel with drag to
schedule. Deck cards (NC-129) map to Tasks-app tasks. Phase 1.

### Import/export, trash, booking, settings

| Feature | Has it | Polaris plan | Phase |
| --- | --- | --- | --- |
| Import .ics (jCal/xCal too) into a calendar or a new one, partial-failure report (NC-131; G, P, TB) | all | iCalendar and jCal; xCal | 1 (xCal 2 - no parser in ical.js; rare in practice) |
| Export calendar/event/public (NC-132) | all | | 1 |
| Account data export (NC-133) | NC | zip of every calendar + booking pages | 1 |
| Trash: deleted calendars and events, restore, delete, empty, retention (NC-134) | NC | 30-day retention, `calendar-trash` purge in the reminders job | 1 |
| Booking pages: name, description, location, private/public, booking calendar, conflict calendars, duration, slot increment, buffers, weekly availability, date overrides, minimum notice, max per day, horizon, meeting room per booking (NC-135,136; G, C) | NC G P C | | 1 |
| Public booking page, email confirmation, result page, per-user overview, rate limit, stale cleanup (NC-137..142) | NC G C | | 1 |
| Booking form questions, reschedule/cancel links (G, C) | G C | | 1 |
| Round robin / collective booking (C) | C | Cal.com-only team scheduling | 2 - needs team availability pooling; not in NC, G personal or P |
| Payments on booking (G Stripe) | G | | 2 - needs a payment provider Polaris does not have |
| User settings: weekends, week numbers, month event limit, density (slot duration), simple editor, tasks, show declined, attachments folder, delegation, legend, shortcuts (NC-143..148) | NC G | | 1 |
| Dashboard widget of upcoming events (NC-152) | NC | Overview widget | 1 |
| Link previews of calendar links (NC-153) | NC | Chat link preview of `/calendar/e/<id>` | 1 |
| Notifications (NC-154) | all | see Reminders / Invitations | 1 |
| Working hours and location (G) | G C | per-weekday hours, used by free/busy and booking | 1 |
| Time insights (G Workspace) | G | | 2 - an analytics screen, not calendaring; nothing in NC or P |
| Speedy meetings (G) | G | setting that shortens defaults | 1 |
| End-to-end encryption (P) | P | | not planned - Polaris calendars are server-side so they can sync, remind and be booked; same model as NC and G |

### External accounts

| Source | Protocol | Plan | Phase |
| --- | --- | --- | --- |
| Google (several accounts per person) | Calendar API v3: calendarList, events with `syncToken` (410 -> full resync), `If-Match` etag writes (412 conflict), `sendUpdates` | reuse `google` UserConnection; `scope=calendar` consent asking `calendar` (read/write); no per-user cap for calendar links | 1 |
| Microsoft 365 / Outlook | Graph `calendars`, `calendarView/delta` per calendar, `@removed`, `If-Match` | reuse `microsoft` UserConnection; `scope=calendar` asks `Calendars.ReadWrite offline_access` | 1 |
| iCloud, Fastmail, Nextcloud, Yahoo, any CalDAV | RFC 6764 discovery (`.well-known/caldav`, SRV), PROPFIND principal/home-set, `sync-collection` (RFC 6578) with ctag/etag fallback, `calendar-multiget`, PUT/DELETE with `If-Match` | URL + username + app password (envelope-encrypted) | 1 |
| Proton, any ICS link | HTTP GET with ETag/Last-Modified | read-only subscription | 1 |

### Keyboard shortcuts (union of NC and G)

`k`/`p` previous, `j`/`n` next, `t` today, `g` go to date, `1`/`d` day, `2`/`w`
week, `3`/`m` month, `4`/`y` year, `5`/`l`/`a` list, `6`/`x` custom days, `c`
create, `e` open selected, `Backspace`/`Delete` delete selected, `z` undo, `/`
search, `r` refresh, `s` settings, `+` add calendar, `?` overview, `Esc` close,
`Ctrl/Cmd+Enter` and `Ctrl/Cmd+S` save, `Ctrl/Cmd+Delete` delete, `Ctrl/Cmd+D`
duplicate.

## Work-unit ledger

Status: `pending`, `done (<verification>)`, `blocked(<reason>)`,
`deferred(<reason>)`. Update one line at a time.

Verification shorthand used below: **T** = `vitest --maxWorkers=2 test/calendar`
green (39 files, 377 tests at the last run); **C** = `tsc --noEmit -p .` in
`apps/calendar` clean (its program includes `apps/web/src`, the app and
`apps/web/test/calendar`); **B** = the app bundler exits 0 and
`test/app-bundles` + `test/build` are green; **W** = exercised in a real
browser (Chrome via puppeteer, against `next build` + `next start` on SQLite,
the calendar bundle loaded from the bundles dir) at 1366px and 390px, in en-US
and es-ES.

### Foundation
- [x] U01 Plan, matrix and ledger - done
- [x] U02 Worktree install - done
- [x] U03 Dependencies - done (ical.js 2.2.1 MPL-2.0, @fullcalendar/* 6.1.21 MIT; lock regenerated with npm@10; `npm@10 ci --dry-run` clean after rebase)
- [x] U04 Prisma models + migration `20261208000000_calendar` - done (renamed from 20261207 after rebase: main took that stamp for place automations; rerunnable test green)
- [x] U05 `calendar.use` - done
- [x] U06 Notification events - done

### Engine
- [x] U07-U16 Engine - done (T; 18 RFC 5545 examples; malformed dates in the input schema answer an issue instead of throwing; VTIMEZONE written for every TZID an object uses, checked against Intl through ical.js for six zones)

### App package and dashboard wiring
- [x] U17 Package scaffold - done (B)
- [x] U18 Web wiring - done (catalog, nav, /calendar, /api/calendar, public /cal, Dockerfile, tailwind, cron routes; W: /calendar loads the bundle and draws)
- [x] U19 Host services - done (C, T; `react-dom` added to the browser modules apps may share - FullCalendar's React adapter needs it)
- [x] U20 Calendar service - done (T: access, actions)
- [x] U21 Object service - done (T: objects; W: create from the header, survives reload, opens; DTSTAMP stamped on local writes)
- [x] U22 Sharing - done (T: sharing; dialog wired through `screens/slots.ts`)
- [x] U23 Public link - done (T; W: /cal/p/<token> draws, feed.ics answers text/calendar, unknown token 404; reminders never leave in a feed)
- [x] U24 Trash - done (T: trash; W: page draws)
- [x] U25 Import/export - done (T: transfer)
- [x] U26 Settings - done (W: settings and /calendar/admin draw)
- [x] U27 Search - done (T: search). Not exercised in the browser: SQLite has no `mode: insensitive`.

### Sync
- [x] U28 Connection flow `scope=calendar` - done
- [x] U29-U32, U34 Sync clients - done (T against fake Google/CalDAV/Graph/ICS servers; recurrence lines read from the VEVENT only, not the VTIMEZONE beside it)
- [x] U33 Sync engine - done (T: sync-engine, sources). Not verified against real Google, iCloud or Microsoft accounts (none available).

### Delivery
- [x] U35 Reminders - done (T)
- [x] U36 Invitations - done (T; mail providers carry iMIP, T in test/mail). Not verified with a real mail provider or client.
- [x] U37 Free/busy + find a time - done (T: features/freebusy)
- [x] U38 Resources and rooms - done (T: features/rooms)
- [x] U39 Booking pages - done (T: features/booking; W: /cal/book/<slug> lists slots, busy time excluded)
- [x] U40 Meeting proposals - done (T: features/proposals)
- [x] U41 Tasks integration - done (overlay, unscheduled panel, schedule through the Tasks service; T)
- [x] U42 Birthdays calendar - n/a (no birthday or contacts data in Polaris)
- [x] U43 Overview card + calendar links in Chat - done (T: test/overview, test/rich-text)

### Screens
- [x] U44 Main screen - done (W; instant first paint, cached reads)
- [x] U45 Drag/resize/select - done (T: screens). Drag and resize not driven in the browser.
- [x] U46 Popover + editor - done (T, W)
- [x] U47 Recurrence editor + scope dialog - done (T: screens)
- [x] U48 Reminders editor - done
- [x] U49 Attendees + find a time + room picker - done (slots wired)
- [x] U50 Calendar dialogs - done
- [x] U51 Accounts screen - done (W; an address validation that threw took the page down - fixed, regression test in server/schemas)
- [x] U52 Settings screen - done (W)
- [x] U53 Trash screen - done (W)
- [x] U54 Booking editor + public booking - done (W)
- [x] U55 Public calendar + embed - done (W for /cal/p)
- [x] U56 Print view - done (W: draws)
- [x] U57 Keyboard shortcuts - done (T: screens)
- [x] U58 390px layout - done (W: no sideways scroll on any calendar screen)
- [x] U59 i18n en-US + es-ES - done (test/i18n green incl. lengths; W in es-ES; US spelling in en-US)
- [x] U65 Attachments - link attachments done; uploading a file into Drive from the editor deferred(phase 2: Drive offers apps no write service)
- [x] U66 Conference link - done (Polaris meeting link from the editor)

### Verification
- [x] U60 vitest - done (T, plus test/build, test/updates, test/i18n, test/cron, test/overview, test/app-bundles, test/mail, test/connections)
- [x] U61 tsc - done (C)
- [x] U62 bundler + contract tests - done (B)
- [x] U63 Browser pass - done (W)
- [ ] U64 CalDAV server for phones and desktop clients - deferred(phase 2, the one item the brief allowed: a WebDAV/CalDAV server with per-user app passwords is a project of its own)
