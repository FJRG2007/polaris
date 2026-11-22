# App boundaries: when something is an app

Read this before proposing a new app, and before merging, splitting or removing
one. The default answer is **no new app**: most features belong inside an app
that already exists. Every new app costs a permission, a place in the switcher
and the rail, settings, an access guard on every route, client support (desktop,
extension, mobile, TV) and one more thing for the operator to understand.

## A new app needs all four

1. **Its own primary object.** Something people create, open, list and search
   that no existing app already stores. If the result is a note, a file, a task,
   a message or an event, it lives in Notes, Drive, Tasks, Chat or Calendar.
2. **Its own daily screen.** People open it on purpose, as a destination, with
   work to do there - not only to change settings or read something another app
   produced.
3. **Its own access decision.** An administrator would plausibly grant or deny
   it to a person independently of every existing app, and a capability inside
   an existing app's permission cannot express that.
4. **Real weight.** More than a settings page and one panel: its own lists,
   detail views, states and lifecycle (retention, storage, quotas, background
   work).

Fail any one and it is not an app. Optional extras that make the case stronger,
never on their own: some installations would not want it at all (a marketplace
app), or it runs its own service (a container, a daemon).

## Where it goes instead

| What it really is | Where it lives |
| --- | --- |
| Settings only | The owning app's settings, or Admin when it is the operator's decision |
| A capability that produces another app's object | That app (a meeting recording is a note; a scan is a file) |
| Something Polar does, answers or summarizes | A Polar tool, skill or context source |
| A view across several apps | A cross-cutting table, search or the overview |
| A link to an outside service | A connector or integration in the app that uses it |
| One button or panel inside another app's flow | That app's screen |
| "Who may use it" without its own screen | A permission or capability in roles |

## Merge two apps when

- They store the same primary object, or one stores nothing of its own.
- People switch between them to finish one task.
- Their settings or permissions duplicate each other.
- One of them is mostly empty and would make a section of the other.

## Split an app when

- It holds two primary objects with different people or permissions.
- Its sections no longer relate: a person uses one and never the other.
- A part of it is optional for many installations and carries its own service.

## Remove an app when

- It no longer has a primary object of its own, or another app now does its job.
- Removal moves every record into the app that takes over, on existing
  installations too (a once-per-server migration, never only for new ones), and
  fixes every link to it instead of redirecting old addresses.

## Before writing a proposal

Answer the four requirements in one line each, name the existing app it would
otherwise belong to, and say why that app cannot hold it. If the answer to any
of the four is "not really", place the feature in the table above instead.

When it is an app: it gets a permission read by its gate (roles and Users >
Capabilities, never an audience card of its own), a top-level address (`/name`,
never `/apps/name`), its sections in `APP_SECTIONS`, and the same access check
in its layout and every server action and API route.

Worked example: the meeting notetaker. Its output is a note (Notes), questions
and summaries are Polar's, recording is a "may record meetings" capability,
retention and consent are Admin. It has no primary object or daily screen of
its own, so it is not an app.
