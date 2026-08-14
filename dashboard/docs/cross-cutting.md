# Cross-cutting concerns, and the shape they should have

Polaris grew app by app, and each app solved the same handful of problems on its
own. This is the list of them, what exists today, and what each one should
become.

The pattern is easy to see in the schema. Every model that answers a question
about *any* object answers it about exactly one kind:

| Concern              | What exists                 | Reaches                        |
| -------------------- | --------------------------- | ------------------------------ |
| History of a change  | `TaskActivity`              | Tasks                          |
| Discussion           | `TaskComment`               | Tasks                          |
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

1. **Activity.** An append-only record of what happened to an object, written
   where the change is made rather than derived, with the attribute, its old
   value and its new one already resolved to names. `TaskActivity` is this, minus
   the subject type. This is the foundation: comments, following and the inbox
   all read it.
2. **Comments.** A thread on any object, on the same rich-text surface the rest
   of Polaris uses, with mentions that resolve through the existing `polaris:`
   address scheme. A mention is what makes a comment reach somebody, so it raises
   a notification through the machinery that already exists.
3. **Following.** Who hears about an object, and how it is decided: explicit,
   because you were mentioned, or because you touched it. One switch on every
   object's header, one list under Account.
4. **Saved views.** Which rows, grouped how, sorted how, which columns - private
   or shared, per screen. `TaskView` is this, minus the binding to a list.

Doing this to Tasks means moving four tables it owns, not writing four new ones;
its screens keep working because the module they call keeps its shape.

## Ordering

Activity first: it is the one the other three read. Then comments, which is the
one people notice. Then following, which is only useful once there is something
to be told about. Saved views are independent of all three and can go at any
point.

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
