# Cross-cutting concerns, and the shape they should have

Polaris grew app by app, and each app solved the same handful of problems on its
own. This is the list of them, what exists today, and what each one should
become.

The pattern is easy to see in the schema. Every model that answers a question
about *any* object answers it about exactly one kind:

| Concern              | What exists                 | Reaches                        |
| -------------------- | --------------------------- | ------------------------------ |
| History of a change  | `Activity`                  | **Anything** - done, see below |
| Discussion           | `Comment`                   | **Anything** - done, see below |
| Following something  | `TaskWatcher`               | Tasks                          |
| Labelling            | `TaskTag`, `TaskTagLink`    | Tasks                          |
| A saved way of looking | `TaskView`                | Tasks                          |
| Starting from a shape | `TaskTemplate`, `ServerTemplate`, `DropPointTemplate` | Tasks, Servers, Drop points |
| Marking a favourite  | `VaultFavorite`             | Vault                          |

Meanwhile `Notification`, `NotificationDestination` and `NotificationDelivery`
are already generic: any app can raise an alert, choose an audience, and have it
delivered to the bell, a webhook or a phone. That is the shape the rest should
have.

None of this is a defect in the apps. Each one was right to solve its own
problem when it was the only app with it. It is a defect now, because there are
seven apps and the eighth will write `DeployActivity` unless there is something
better to reach for.

## What each one costs today

- **A deploy that failed has no history.** Who redeployed it, what changed
  between the working release and this one, and when somebody edited an
  environment variable are questions the Deploy app cannot answer, and Tasks can.
- **There is nowhere to say anything.** A server, a runner job, a vault item and
  a document are all things two people need to discuss, and the only object in
  Polaris with a comment box is a task.
- **Following something is per-app or absent.** `TaskWatcher` decides who hears
  about a task. Nothing decides who hears about a server, so the answer is
  everybody with the permission, or nobody.
- **Every table is somebody's first table.** Drive, Servers, Runners, Firewall
  and Analytics each grew their own filtering, sorting and column choices, none
  of which can be saved, shared, or carried to the next screen. Tasks can save
  all three, and only for itself.

## The shape to move to

Four generic subjects, each owning one table addressed by `(subjectType,
subjectId)` the way `Notification` already is, and each with one module in
`lib/` and one component in `@polaris/ui`:

1. **Activity - done.** `lib/activity/activity.ts` over one `Activity` table
   addressed by `(subjectType, subjectId)`, with `SUBJECTS` naming the kinds.
   Tasks moved onto it with its screens unchanged, and Deploy is its second
   reader: a service now records who deployed, restarted, stopped or duplicated
   it, which variable changed, and what the port was set to. `components/
   activity-feed.tsx` draws it; each app hands in its own wording, because
   "moved it from Doing to Done" and "changed the PORT variable" are the same
   row and different sentences.

   Two things to know before adding a subject. Nothing cascades - whatever
   deletes a subject calls `forget` for it, which is why deleting a task now
   gathers its subtasks first. And a service event is written to the audit log
   as well: that log answers "who did this, from where, on which session" for
   administrators and the firewall, this one answers "what happened to this
   service" for whoever owns it, and `recordServiceEvent` writes both so neither
   is forgotten.
2. **Comments - done.** `lib/comments/comments.ts` over one `Comment` table
   addressed the same way, sharing `SUBJECTS` with the history because a thing
   worth discussing is a thing worth a history. Tasks kept every behaviour it had
   - replies, resolving, handing a comment to somebody, mentions, the rules that
   run on a comment - by composing the module: who hears about a comment belongs
   to the app that owns the subject, not to the table.

   A service is the second reader, under Notes on its panel, drawn by
   `components/discussion.tsx` - a plainer thread than the one Tasks draws,
   because a service is a thing people leave notes on rather than negotiate over.

   Two things to keep in mind. `forget` again: deleting a task or a service drops
   its thread, and neither cascades. And a comment id says nothing about which
   subject it belongs to, so every entry point re-checks that the reader owns the
   subject before touching a comment - without that, a generic table lets anybody
   with the permission post onto somebody else's service by guessing an id.
3. **Following.** Who hears about an object, and how it is decided: explicit,
   because you were mentioned, or because you touched it. One switch on every
   object's header, one list under Account.
4. **Saved views.** Which rows, grouped how, sorted how, which columns - private
   or shared, per screen. `TaskView` is this, minus the binding to a list.

Doing this to Tasks means moving four tables it owns, not writing four new ones;
its screens keep working because the module they call keeps its shape.

## Ordering

Activity first, because it is the one the other three read. Then comments, which
is the one people notice. Both are done. Following is next - it is only useful
once there is something to be told about, and now there is. Saved views are
independent of all three and can go at any point.

## What was looked at, and deliberately not taken

The survey behind this was of Huly (`hcengineering/platform`), which solves the
same problem generically. What is worth taking is the *shape* above, not the
implementation: Huly reaches it through a transaction log and a model of classes
and mixins that every object in the product is defined in, and Polaris is a
Prisma schema with named tables. The generic tables are the part that transfers.

Also looked at and left alone, with reasons:

- **A live document with several cursors in it.** Polaris has a rich text editor
  and one writer at a time, which is the honest state of it; multi-writer editing
  is a service, not a feature.
- **Presence** (who else is looking at this). Cheap to want, and it needs a
  connection held open per viewer per screen. Worth revisiting when something
  else already needs that connection.
- **Business verticals** - recruiting, CRM, inventory, training, controlled
  documents. Polaris is a control plane for infrastructure. These are a different
  product wearing the same chrome.
