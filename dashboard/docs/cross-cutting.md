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
| Following something  | `Follow`                    | **Anything** - done, see below |
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

## What each one cost

Three of these are fixed; the fourth is what is left.

- **A deploy that failed had no history.** Who redeployed it, what changed
  between the working release and this one, and when somebody edited an
  environment variable were questions the Deploy app could not answer and Tasks
  could. *Fixed.*
- **There was nowhere to say anything.** A server, a runner job, a vault item and
  a document are all things two people need to discuss, and the only object in
  Polaris with a comment box was a task. *Fixed for services; the other subjects
  are a line in `SUBJECTS` and a panel each.*
- **Following something was per-app or absent.** Nothing decided who heard about
  a service, so a failed deploy told its owner and stopped there. *Fixed.*
- **Every table is somebody's first table.** Drive, Servers, Runners, Firewall
  and Analytics each grew their own filtering, sorting and column choices, none
  of which can be saved, shared, or carried to the next screen. Tasks can save
  all three, and only for itself. *Still true.*

## The shape to move to

Four generic subjects, each owning one table addressed by `(subjectType,
subjectId)` the way `Notification` already is, each with one module under
`apps/web/src/lib/` and one component under `apps/web/src/components/`. The
components live in the app rather than in `@polaris/ui` because they need the
avatar, the relative clock and the rich-text surface, which are the app's:

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
3. **Following - done.** `lib/follow/follow.ts` over one `Follow` table keyed by
   `(subjectType, subjectId, userId)`, carrying WHY somebody is following -
   explicit, because they commented, because they were assigned - which a screen
   can say instead of leaving them wondering why they are being told.

   `follow` is idempotent, because it is called from paths that mean "make sure
   this person hears about it" as much as from a switch, and it never rewrites
   the first reason: having commented is still true after pressing Follow.

   Tasks moved over with its watchers intact. A service is the second reader:
   the bell on its panel, and `notifyDeployFinished` now tells its followers as
   well as its owner and whoever pressed deploy - which is the point, since the
   person who spent the afternoon on it is usually neither of those two.

   The rule engine paid for this: watchers used to arrive with the task row
   through a relation and are now one query for the batch, beside the dependency
   lookup that was already there.
4. **Saved views.** Which rows, grouped how, sorted how, which columns - private
   or shared, per screen. `TaskView` is this, minus the binding to a list.

Doing this to Tasks means moving four tables it owns, not writing four new ones;
its screens keep working because the module they call keeps its shape.

## Ordering

Activity, then comments, then following - each read the one before it, and all
three are done. Saved views are independent of the other three and are what is
left.

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
