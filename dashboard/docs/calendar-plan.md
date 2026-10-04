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

| Layer       | Where                                                   | What                                                                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure engine | `packages/core/src/calendar/*`                          | iCalendar parse/serialize (ical.js), recurrence expansion with RRULE/RDATE/EXDATE/RECURRENCE-ID, time-zone math on `Intl` (no tz database shipped), alarms, free/busy, booking slots, recurrence editing (this / this and following / all), iTIP messages. Every function takes "now" as an argument. |
| Data        | `packages/db/prisma/schema.prisma` (`Calendar*` models) | iCalendar text is the source of truth per object; indexed columns (`startsAt`, `endsAt`, `summary`) are derived on write for range queries and search.                                                                                                                                                |
| App server  | `apps/calendar/src/lib/*`                               | calendars, objects, sharing, trash, import/export, public links, reminders job, invitations, booking pages, sync engine (Google, CalDAV, Microsoft Graph, ICS), the Time area's clock engine (`lib/clock/*`: alarms, timers, focus cycles, stopwatch, world clock).                                   |
| App screens | `apps/calendar/src/routes/calendar/**`                  | the calendar, its settings, booking and public pages.                                                                                                                                                                                                                                                 |
| Dashboard   | `apps/web`                                              | catalog + nav entry, catch-all page/route, public surface, permission, notification events, connection flow `scope=calendar`, host services.                                                                                                                                                          |

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
  outside CalDAV calendar, or from a linked Google account's own task lists, are
  shown and edited as calendar objects. No second task store.
- **Invitations.** Polaris attendees get the event in their own calendar ("needs
  action") and a bell entry; outside attendees get an iMIP email (REQUEST/CANCEL
  with the `.ics` attached) carrying an RSVP link, because Polaris receives no
  mail. On Google/Outlook/CalDAV calendars the provider schedules
  (`sendUpdates=all`, server-side scheduling) and Polaris does not send twice.
- **The Time area's alarms, timers and stopwatch are server state, not client
  state.** A running timer stores when it ends and an alarm its next ring,
  never a countdown, so every device reads the same value and a ring survives
  a reload. The scheduler's quick tick (`app/api/cron/calendar-clock`) rings
  what is due as a `calendar.clock` notification with every tab closed; a ring
  is claimed by a conditional write, so a racing pass never rings it twice. The
  quick tick itself is generic to any installed app
  (`lib/app-extensions/types.ts`'s `headerSlot`, `lib/cron/scheduler.ts`), not
  Calendar-specific - Calendar is its first user.

## Feature matrix

Legend: NC Nextcloud, G Google, P Proton, TB Thunderbird, S SOGo, C Cal.com.
Phase 1 = this build. Status is tracked in the ledger, not here.

### Views and navigation

| Feature                                                                                 | Has it      | Polaris plan                                                                                                                                           | Phase |
| --------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| Day, week, month (+N more), year, list/agenda views (NC-1..5)                           | NC G P TB S | FullCalendar views; agenda = list over the coming 30 days (G "Schedule")                                                                               | 1     |
| Custom N-day view (G "4 days")                                                          | G           | view option 2-7 days                                                                                                                                   | 1     |
| Remembered last view, deep links `/calendar/<view>/<date>`, `/calendar/e/<id>` (NC-6,7) | NC G        | URL is the state                                                                                                                                       | 1     |
| Drag to move, resize from either edge, select to create (NC-8..10)                      | NC G TB     | FullCalendar interaction, optimistic with rollback                                                                                                     | 1     |
| Click a day / week number to open it (NC-11)                                            | NC G        | nav links                                                                                                                                              | 1     |
| Participation styling, faded past events, struck-through cancelled (NC-12,13)           | NC G        | event classes                                                                                                                                          | 1     |
| Screen-reader labels on events (NC-14)                                                  | NC          | aria-label per event                                                                                                                                   | 1     |
| Locale date formats, first day of week (NC-15)                                          | NC G        | locale + setting                                                                                                                                       | 1     |
| Live refresh on remote change (NC-16)                                                   | NC G        | refetch on focus + after each sync tick, SSE later                                                                                                     | 1     |
| Date picker, previous/next, today, new event (NC-17..19)                                | all         | header                                                                                                                                                 | 1     |
| Filter/search events (NC-20; G advanced search)                                         | NC G TB     | search box over loaded range + server search across all time (title, location, description, attendees)                                                 | 1     |
| Calendar list, reorder, show/hide, colour (NC-21,23)                                    | all         | sidebar                                                                                                                                                | 1     |
| Shared-with-you / delegated sections and badges (NC-22,24)                              | NC G        | sidebar groups                                                                                                                                         | 1     |
| Muted-notifications indicator (NC-25)                                                   | NC          | icon                                                                                                                                                   | 1     |
| Undo while deleting/unsharing a calendar (NC-26)                                        | NC          | toast with Undo                                                                                                                                        | 1     |
| Loading placeholders (NC-27)                                                            | NC          | skeleton rows only where waiting                                                                                                                       | 1     |
| Unscheduled tasks panel, drag onto grid (NC-28,130)                                     | NC          | Tasks without due date, drop sets due                                                                                                                  | 1     |
| Meeting proposals list (NC-29,120-122)                                                  | NC          | proposals with public voting page                                                                                                                      | 1     |
| Appointment schedules list (NC-30)                                                      | NC G P C    | sidebar section                                                                                                                                        | 1     |
| Secondary time zone column (G)                                                          | G           | second axis label in day/week                                                                                                                          | 1     |
| World clock (G)                                                                         | G           | Time area (below): alarms, timers, focus cycles, a stopwatch and a world clock with a meeting planner; reached from the header, the sidebar and search | 1     |
| Hide declined, dim past, show weekends, week numbers (G, NC-144)                        | NC G        | settings                                                                                                                                               | 1     |
| Keyboard shortcuts incl. `?` overview (NC table, G list)                                | NC G        | union of both lists, see below                                                                                                                         | 1     |
| Print (G: range, orientation; NC print css)                                             | NC G TB     | print view with range + orientation                                                                                                                    | 1     |

### Calendars, sharing, publishing, subscriptions

| Feature                                                                                    | Has it   | Polaris plan                                                                                                                                                                              | Phase           |
| ------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| New calendar, with or without tasks (NC-31,32)                                             | all      | component set per calendar                                                                                                                                                                | 1               |
| Edit name (not blank), colour, description, time zone (NC-33)                              | all      | dialog                                                                                                                                                                                    | 1               |
| Per-calendar default reminders, timed and all-day (NC-34; G)                               | NC G     | stored on calendar                                                                                                                                                                        | 1               |
| Mute a calendar's alarms (NC-35)                                                           | NC       | flag                                                                                                                                                                                      | 1               |
| "Never show me as busy" (NC-36)                                                            | NC       | calendar transparency, excluded from free/busy                                                                                                                                            | 1               |
| Supported components shown (NC-37)                                                         | NC       | badge                                                                                                                                                                                     | 1               |
| Export calendar .ics (NC-38; G, P)                                                         | all      | `/api/calendar/export/<id>`                                                                                                                                                               | 1               |
| Delete / unshare from me (NC-39)                                                           | NC G     | to trash / remove share                                                                                                                                                                   | 1               |
| Default calendar for invitations (NC-40)                                                   | NC       | setting                                                                                                                                                                                   | 1               |
| Share with users, teams; read or write (NC-41..43; G 5 levels; P view/edit; S levels)      | NC G P S | levels: free/busy, read, write, manage (G's model, a superset of NC and P)                                                                                                                | 1               |
| Federated sharing (NC-44)                                                                  | NC       | Polaris has no instance-to-instance federation; the equivalent is the public link subscribed from the other side. Not built.                                                              | n/a             |
| Copy internal link (NC-45)                                                                 | NC       | copy `/calendar?c=<id>`                                                                                                                                                                   | 1               |
| Public link on/off, copy, webcal link, email it, embed code (NC-46..49; G, P limited/full) | NC G P   | token link, `limited` (busy only) or `full` view, `.ics` feed, iframe                                                                                                                     | 1               |
| Public page and embed page (NC-50..52,149)                                                 | NC G     | `/cal/p/<token>`, `/cal/embed/<token>`                                                                                                                                                    | 1               |
| Subscribe by URL (http/https/webcal) (NC-54; G, P, TB)                                     | all      | ICS source, refresh interval, SSRF-guarded fetch; an ICS feed's address can be replaced in place without losing the subscription, prompted automatically once it falls into `auth` status | 1               |
| Holiday calendars by region (NC-55; G, P)                                                  | NC G P   | catalogue of public ICS feeds per country                                                                                                                                                 | 1               |
| Admin-suggested public calendars, disable link subscriptions (NC-56,57)                    | NC       | instance setting                                                                                                                                                                          | 1               |
| Birthday calendar (NC-143; G)                                                              | NC G     | Polaris profiles carry no birthday and Polaris has no contacts app, so there is nothing to derive one from; a linked Google account's own birthdays calendar syncs like any other         | n/a (no source) |
| Serve Polaris calendars over CalDAV to phones/desktop (NC core, Radicale)                  | NC S     | CalDAV server with per-user app passwords                                                                                                                                                 | 2               |

### Event editor

| Feature                                                                     | Has it | Polaris plan                                                       | Phase                                                                                                      |
| --------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Quick popover + full editor, view mode (NC-58,59; G)                        | NC G   | popover (skippable in settings) and full dialog                    | 1                                                                                                          |
| Title, start/end, all-day, local time hint (NC-61,62)                       | all    |                                                                    | 1                                                                                                          |
| Separate start/end time zones (NC-63)                                       | NC G   |                                                                    | 1                                                                                                          |
| Duration presets (NC-64)                                                    | NC     |                                                                    | 1                                                                                                          |
| Calendar picker (NC-65)                                                     | all    | writable calendars only                                            | 1                                                                                                          |
| Location, description with clickable links (NC-66,67)                       | all    |                                                                    | 1                                                                                                          |
| Status confirmed/tentative/cancelled (NC-68)                                | NC TB  |                                                                    | 1                                                                                                          |
| Show as free/busy (NC-69; G)                                                | NC G   | TRANSP                                                             | 1                                                                                                          |
| Visibility public/confidential/private (NC-70; G)                           | NC G   | CLASS; sharees below "read" see busy only                          | 1                                                                                                          |
| Categories (NC-71)                                                          | NC TB  | 12 everyday defaults of our own + custom                           | 1                                                                                                          |
| Event colour (NC-72; G)                                                     | NC G   | COLOR property                                                     | 1                                                                                                          |
| Attachments (NC-73; G Drive)                                                | NC G   | link attachments + upload into Polaris Drive                       | 1                                                                                                          |
| Conference link (NC-74 Talk; G Meet; P Meet/Zoom)                           | NC G P | "Add a Polaris meeting" creates a Chat meeting link                | 1                                                                                                          |
| Save/delete this / this and following / all (NC-75,76)                      | NC G   | engine `editRecurring`                                             | 1                                                                                                          |
| Duplicate, export one event, copy link (NC-77..79; G duplicate)             | NC G   |                                                                    | 1                                                                                                          |
| Confirm before discarding changes (NC-80)                                   | NC     | dialog                                                             | 1                                                                                                          |
| Allow forwarding / guest permissions (NC-82; G modify/invite/see guests)    | NC G   | X-properties honoured by Google mapping                            | 1                                                                                                          |
| Attendee warning that changes will not reach organizer (NC-84)              | NC     | banner                                                             | 1                                                                                                          |
| Event types: out of office (auto-decline), focus time, working location (G) | G      | OOO and focus as event kinds; auto-decline for Polaris invitations | 1                                                                                                          |
| Rich text description (G)                                                   | G      | plain text with links (NC parity); rich text                       | 2 - iCalendar DESCRIPTION is plain text; X-ALT-DESC HTML round-trips but an editor for it is not NC parity |

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

| Feature                                                                                 | Polaris plan                                                                  | Phase                                                                   |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Attendee search over Polaris users, teams, typed emails (NC-104,107)                    | host directory search                                                         | 1                                                                       |
| Roles chair/required/optional/non-participant, RSVP toggle (NC-105,106)                 | ROLE, RSVP                                                                    | 1                                                                       |
| Organizer choice (NC-108)                                                               | from the calendar owner's addresses                                           | 1                                                                       |
| Response counts, copy/email all attendees (NC-109,110)                                  |                                                                               | 1                                                                       |
| Status avatars (NC-111)                                                                 |                                                                               | 1                                                                       |
| Accept/decline/tentative for one occurrence or series (NC-112)                          | Polaris users in-app; outside people via RSVP link                            | 1                                                                       |
| iMIP email REQUEST/CANCEL with .ics (RFC 6047)                                          | notification email channel                                                    | 1                                                                       |
| Find a time: free/busy grid, suggestions (NC-113; G)                                    | free/busy over Polaris calendars (respecting TRANSP and share level)          | 1                                                                       |
| Resources and rooms with capacity/features, room availability (NC-114..118; G rooms; S) | resource calendars managed by administrators, invited as CUTYPE=ROOM/RESOURCE | 1                                                                       |
| Availability from a person's card (NC-119)                                              | profile card shows free/busy now                                              | 1                                                                       |
| Incoming iMIP in the Mail app (TB, G)                                                   | Mail shows an invitation card with RSVP                                       | 2 - belongs to the Mail app's message renderer, not the Calendar bundle |

### Time zones (NC-123..126; G secondary tz)

Automatic or chosen display zone, warning when detected zone is UTC or unknown,
event zones, secondary zone, zone on booking pages and emails. Phase 1.

### Time: alarms, timers, focus cycles, stopwatch, world clock

A Time area (`/calendar/time`, `lib/clock/*`), reached from the calendar's
header, its sidebar and the dashboard search, in four tabs:

- **Alarms** - time, repeat days, label, sound, snooze length, on/off, the next
  ring and "skip next ring"; read in the owner's zone, clock changes settled
  the RFC 5545 way.
- **Timers** - several at once, named, presets and recently used lengths, one
  more minute, pause and resume; focus cycles with configurable focus, short
  and long breaks and rounds, each phase starting the next by itself or
  waiting.
- **Stopwatch** - laps with the fastest and slowest marked, copy and CSV
  export, keyboard shortcuts.
- **World clock** - any IANA zone found by city, country (in the reader's
  language), zone name, abbreviation or offset; day and hours apart, and the
  next clock change. A meeting planner lines an hour up across the cities with
  working hours shaded, and opens a new event at that time; the event editor
  compares the event's time across the world clock's cities.

Everything is kept on the server, rung by the scheduler's quick tick and
claimed by a conditional write so it never rings twice (see the Decisions
bullet above). A pill beside the bell (`screens/clock/time-indicator.tsx`,
drawn through the generic app-host header slot) shows the running timer or
stopwatch from any screen, and the dashboard search starts one directly from a
typed command ("timer 10m", "alarm 7:30", "stopwatch", English and Spanish,
`parseClockCommand` in `@polaris/core`). Not part of the NC/G/P/TB/S/C matrix
above - a utility the Calendar app carries rather than a calendaring feature -
so it is tracked here and in the ledger instead of the table. Phase 1.

### Tasks (NC-127..130)

Tasks with due dates shown in the grid (Tasks-app tasks + VTODO from outside
calendars, including a linked Google account's own task lists - each one more
calendar of the account, editable here and written back through the Tasks API),
clicking a Tasks-app task opens it in Tasks, unscheduled tasks panel with drag to
schedule. Deck cards (NC-129) map to Tasks-app tasks. Phase 1.

### Import/export, trash, booking, settings

| Feature                                                                                                                                                                                                                                                     | Has it   | Polaris plan                                                  | Phase                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Import .ics (jCal/xCal too) into a calendar or a new one, partial-failure report (NC-131; G, P, TB)                                                                                                                                                         | all      | iCalendar and jCal; xCal                                      | 1 (xCal 2 - no parser in ical.js; rare in practice)                                                            |
| Export calendar/event/public (NC-132)                                                                                                                                                                                                                       | all      |                                                               | 1                                                                                                              |
| Account data export (NC-133)                                                                                                                                                                                                                                | NC       | zip of every calendar + booking pages                         | 1                                                                                                              |
| Trash: deleted calendars and events, restore, delete, empty, retention (NC-134)                                                                                                                                                                             | NC       | 30-day retention, `calendar-trash` purge in the reminders job | 1                                                                                                              |
| Booking pages: name, description, location, private/public, booking calendar, conflict calendars, duration, slot increment, buffers, weekly availability, date overrides, minimum notice, max per day, horizon, meeting room per booking (NC-135,136; G, C) | NC G P C |                                                               | 1                                                                                                              |
| Public booking page, email confirmation, result page, per-user overview, rate limit, stale cleanup (NC-137..142)                                                                                                                                            | NC G C   |                                                               | 1                                                                                                              |
| Booking form questions, reschedule/cancel links (G, C)                                                                                                                                                                                                      | G C      |                                                               | 1                                                                                                              |
| Round robin / collective booking (C)                                                                                                                                                                                                                        | C        | Cal.com-only team scheduling                                  | 2 - needs team availability pooling; not in NC, G personal or P                                                |
| Payments on booking (G Stripe)                                                                                                                                                                                                                              | G        |                                                               | 2 - needs a payment provider Polaris does not have                                                             |
| User settings: weekends, week numbers, month event limit, density (slot duration), simple editor, tasks, show declined, attachments folder, delegation, legend, shortcuts (NC-143..148)                                                                     | NC G     |                                                               | 1                                                                                                              |
| Dashboard widget of upcoming events (NC-152)                                                                                                                                                                                                                | NC       | Overview widget                                               | 1                                                                                                              |
| Link previews of calendar links (NC-153)                                                                                                                                                                                                                    | NC       | Chat link preview of `/calendar/e/<id>`                       | 1                                                                                                              |
| Notifications (NC-154)                                                                                                                                                                                                                                      | all      | see Reminders / Invitations                                   | 1                                                                                                              |
| Working hours and location (G)                                                                                                                                                                                                                              | G C      | per-weekday hours, used by free/busy and booking              | 1                                                                                                              |
| Time insights (G Workspace)                                                                                                                                                                                                                                 | G        |                                                               | 2 - an analytics screen, not calendaring; nothing in NC or P                                                   |
| Speedy meetings (G)                                                                                                                                                                                                                                         | G        | setting that shortens defaults                                | 1                                                                                                              |
| End-to-end encryption (P)                                                                                                                                                                                                                                   | P        |                                                               | not planned - Polaris calendars are server-side so they can sync, remind and be booked; same model as NC and G |

### External accounts

| Source                                         | Protocol                                                                                                                                                                           | Plan                                                                                                                       | Phase |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----- |
| Google (several accounts per person)           | Calendar API v3: calendarList, events with `syncToken` (410 -> full resync), `If-Match` etag writes (412 conflict), `sendUpdates`; Tasks API v1: each task list as a calendar, `updatedMin` since the newest `updated` seen, deletions included | reuse `google` UserConnection; `scope=calendar` consent asking `calendar` and `tasks` (read/write); no per-user cap for calendar links; an account linked before the tasks scope existed keeps syncing calendars and is offered the grant | 1     |
| Microsoft 365 / Outlook                        | Graph `calendars`, `calendarView/delta` per calendar, `@removed`, `If-Match`                                                                                                       | reuse `microsoft` UserConnection; `scope=calendar` asks `Calendars.ReadWrite offline_access`                               | 1     |
| iCloud, Fastmail, Nextcloud, Yahoo, any CalDAV | RFC 6764 discovery (`.well-known/caldav`, SRV), PROPFIND principal/home-set, `sync-collection` (RFC 6578) with ctag/etag fallback, `calendar-multiget`, PUT/DELETE with `If-Match` | URL + username + app password (envelope-encrypted)                                                                         | 1     |
| Proton, any ICS link                           | HTTP GET with ETag/Last-Modified                                                                                                                                                   | read-only subscription                                                                                                     | 1     |

### Keyboard shortcuts (union of NC and G)

`k`/`p` previous, `j`/`n` next, `t` today, `g` go to date, `1`/`d` day, `2`/`w`
week, `3`/`m` month, `4`/`y` year, `5`/`l`/`a` list, `6`/`x` custom days, `c`
create, `e` open selected, `Backspace`/`Delete` delete selected, `z` undo, `/`
search, `r` refresh, `s` settings, `+` add calendar, `?` overview, `Esc` close,
`Ctrl/Cmd+Enter` and `Ctrl/Cmd+S` save, `Ctrl/Cmd+Delete` delete, `Ctrl/Cmd+D`
duplicate. On the grid: arrow keys move focus between day cells, `Enter`
creates on the focused day, the menu key or `Shift+F10` opens its context menu,
`Ctrl/Cmd+C` copies the focused event and `Ctrl/Cmd+V` pastes at the focused
cell.

## Work-unit ledger

Status: `pending`, `done (<verification>)`, `blocked(<reason>)`,
`deferred(<reason>)`. Update one line at a time.

Verification shorthand used below: **T** = `vitest --maxWorkers=2 test/calendar`
green (56 files, 680 tests at the last run); **C** = `tsc --noEmit -p .` in
`apps/calendar` clean (its program includes `apps/web/src`, the app and
`apps/web/test/calendar`); **B** = the app bundler exits 0 and
`test/app-bundles` + `test/build` are green; **W** = exercised in a real
browser (Chrome via puppeteer, against `next build` + `next start` on SQLite,
the calendar bundle loaded from the bundles dir) at 1366px and 390px, in en-US
and es-ES.

### Foundation

- [x] U01 Plan, matrix and ledger - done
- [x] U02 Worktree install - done
- [x] U03 Dependencies - done (ical.js 2.2.1 MPL-2.0, @fullcalendar/\* 6.1.21 MIT; lock regenerated with npm@10; `npm@10 ci --dry-run` clean after rebase)
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
- [x] U33 Sync engine - done (T: sync-engine, sources). Not verified against real Google, iCloud or Microsoft accounts (none available). A provider's refusal is read from its body, not only its status, into `auth`/`consent`/`setup`/`rate` (`packages/core/src/provider-api-errors.ts`), so a Google API switched off in the Cloud project or a grant missing a scope is told apart from a credentials failure and is never offered a reconnect that cannot fix it - see `docs/bugs/google-api-disabled-looked-like-a-broken-login.md`.

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
- [x] U67 Linking is findable - done (T: screens/accounts-entry; W): Accounts is the first section of Calendar settings; the sidebar's "Add a calendar" lists Google, Microsoft, CalDAV, subscribe by URL, holidays, import and create; a first-use tip until linked or closed (`dismissedHints`); a provider whose OAuth client is not set up says so - administrators are linked to `/admin/integrations?configure=<provider>`, which opens that setup, everybody else is told to ask one; a linked Google account whose Calendar API is switched off in that client's Cloud project reads the same way - an administrator gets the project and a direct activation link, on the account and on a **Google APIs** panel on `/admin/integrations`, everybody else is told to ask one, and reconnecting is never offered since it cannot fix it
- [x] U68 Grid context menu - done (T: screens/grid-menu, server/objects; W): right-click, long press, the menu key or Shift+F10 on a time, a day, the all-day row or an event; new event / all-day / task due here / paste / go to day; open, edit, duplicate, copy (Ctrl/Cmd+C), move to calendar, color, respond, download, delete; a range selected first is the range it creates over; arrows step between day cells, Enter creates on the focused day, Ctrl/Cmd+V pastes there

### Time area

- [x] U69 Clock schema + migration (`ClockAlarm`, `ClockTimer`, `ClockStopwatch`, `20261215000000_calendar_time`) - done (C)
- [x] U70 Clock engine + service (`lib/clock/model.ts`, `lib/clock/service.ts`, city/zone data in `lib/clock/cities.ts` and `engine/zone-countries.ts`) - done (T: test/calendar/clock, 57 tests)
- [x] U71 Scheduler job + routes (`app/api/cron/calendar-clock`, `routes/api/calendar/time`, `routes/api/calendar/time/quick`) - done (T)
- [x] U72 Screens: alarms, timers + focus cycles, stopwatch, world clock + meeting planner, `/calendar/time` (`screens/clock/*`) - done (C). Not driven in a real browser.
- [x] U73 Header pill + event-editor zone compare (`screens/clock/time-indicator.tsx`, `screens/extension-slot.tsx`, `screens/event-editor.tsx`) - done (C)
- [x] U74 App-host header slot + sub-minute scheduler tick for an installed app's jobs (`lib/app-extensions/{registry,types}.ts`, `lib/cron/scheduler.ts`, `components/app-host/client.tsx`) - done (T: test/build/app-host-contract, 318 tests). Generic to any app, not Calendar-specific - Calendar is its first user.
- [x] U75 Clock commands from search: "timer 10m", "alarm 7:30", "stopwatch" (`parseClockCommand` in `@polaris/core`, `command-palette.tsx`, `search-rows.tsx`) - done (T: packages/core/test/clock-commands.test.ts, 7 tests; en-US + es-ES)
- [x] U76 i18n `time.json` en-US + es-ES; monthly repeat's day/weekday/weekend option labels fixed (`rule.json`, both locales) - done (T: test/i18n, 2052 tests incl. lengths)

### Quick-create switch and time orientation (Google parity)

- [x] U77 Quick-create switch - the grid's new-item card offers Event, Task and Booking page (Google's own three) through a `SegmentedControl` - Task drops out once the account turns out to have no task lists at all, and the choice falls back to Event; a task is made through the same creation `new-task-dialog.tsx` already used for "New task due here" (`useTaskCreation`, `TaskListField`, shared by both), and a booking page carries the card's title and the picked time as its day and hours (`screens/booking/model.ts`'s `seedOf`/`seededDraft`) into `/calendar/booking/new` - done (T: screens/quick-create, screens/booking-seed)
- [x] U78 Time orientation (Google's own drawing) - today is a filled circle wherever a day is named (grid header, month grid, `MiniMonth`), a live red line crosses today at the current minute with the time on the axis and scrolls into view on open and on "Today" (`time.nowScrollTime`), days and hours already gone are dimmed, weekends are tinted (`time.weekendDays`), the time grid's corner names the display zone (`time.zoneOffsetLabel`), and "Today" disables itself with a reason once today is already the visible range (`time.showsToday`) - done (T: screens/orientation, screens/grid-paint, screens/calendar-screen)
- [x] U79 Event colour states (Google's own fills) - an event the reader takes part in is filled with its colour, one not yet answered or answered "maybe" is outlined over a tint, a declined or cancelled one is outlined over stripes, and a past one is the same, faded toward the theme's card colour (`grid-events.ts`'s `paintFor`); the ink is picked against every fill and stripe it sits on for 4.5:1 contrast or better (`ui-color.ts`'s `inkFor`, `contrast`, the same WCAG 2.x formula `packages/ui/test/token-contrast.test.ts` checks the design tokens with) - done (T: screens/grid-paint)

### Event affordances, equal month rows and Google Tasks

- [x] U80 Clickable links and addresses in events (Google parity) - a location that is a web link or a video meeting link, a bare `www.` address, and an email address (description, location, organizer, the read-only guest list, a booking's address) are linkified (http/https/mailto only, `rel="noopener noreferrer"`); right-click, a long press or the menu key opens a context menu (`screens/contact-links.tsx`) with Join/Open link or Send email and a copy of the address, confirmed by a toast or shown beside the link on a public page; Send email opens `/mail/compose` for whoever has Mail (`actions/mail.ts`'s `mailComposeAction`) and falls back to `mailto:` everywhere else, public pages included - done (T: screens/contact-links, screens/linkify)
- [x] U81 Equal month row heights (Google parity) - the month grid lays a day's events over its cell instead of letting FullCalendar's table hand spare height out by what each row holds (`screens/month-rows.ts`); with the "Events per day in a month" setting the limit is capped by what an equal share of the height holds, re-read on resize, the rest sitting behind "+N more"; with "All" every week grows to its busiest day and the grid scrolls; the month draws only its own weeks (`fixedWeekCount` off, five most months, as Google does) while the range read stays six weeks; the public calendar's month does the same - done (T: screens/month-rows)
- [x] U82 "New event here" (and "New all-day event", "Open") keeps the panel it opens - the grid's context menu now leaves focus where the panel it opened has put it and hands it back to the grid only when nothing took it, instead of handing focus back to the right-clicked cell and reading the panel's own focus as the reader moving on - done (T: screens/grid-menu-panel)
- [x] U83 A linked Google account's tasks on the calendar - each Google task list is one more calendar of the account (`tasks:<list>` remote id, `lib/sync/google-tasks.ts`), its tasks drawn all day on their due day and edited (tick off, rename, move, delete) back through the Tasks API, behind the "show tasks" setting, the way a CalDAV server's own VTODOs are; a list is read whole once, then only what changed since the newest `updated` seen (`updatedMin`, deletions included), every answer checked against a schema; linking for calendars now also asks the tasks scope, and an account linked before that keeps syncing its calendars with its Linked-calendars row saying tasks are not shown and a button that grants them; a Cloud project with the Tasks API off is recorded apart from the Calendar API the same way (`google-api-state.ts`'s `recordGoogleTasksApi`/`readGoogleTasksApi`) - the account's row, the Google APIs panel and a setup step there, calendars still syncing over it - done (T: sync/google-tasks, server/sync-engine)
- [ ] U64 CalDAV server for phones and desktop clients - deferred(phase 2, the one item the brief allowed: a WebDAV/CalDAV server with per-user app passwords is a project of its own)
