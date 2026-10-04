# A session's "last active" read the markup, not the time

**Found:** October 2026. **Fixed in:**
`dashboard/apps/web/src/components/sessions-table.tsx`.
**Guarded by:** `dashboard/apps/web/test/i18n/tagged-messages.test.ts`,
`dashboard/apps/web/test/account/sessions-table.test.tsx`.

## What was seen

The compact row of the Sessions screen read "Last active `<time></time>`",
word for word, instead of "Last active 3 minutes ago". It looked like a
missing translation - the kind of gap `npm run i18n:scan` finds - but the
catalog had the message, in both locales, correctly.

## What it actually was

`sessionsTable.lastActiveAt` is `"Last active <time></time>"`, a message with
a tag in it, formatted through `t.rich`. `t.rich` requires every tag's value
to be a function of the tag's inner content (`(chunks) => <time>{chunks}</time>`);
the call site handed it a React element instead
(`time: <RelativeTime key="time" iso={session.lastSeenAt} />`). `intl-messageformat`
throws on that shape, and the translator's failure path answers with the raw
source message - markup included - rather than crashing the row. Nothing at
build time catches it: the element type-checks wherever a tag's value is
typed as `ReactNode`, and the failure only shows up by reading the rendered
screen.

## The fix

`timeTag(iso)` returns a function that builds the `<time>` element from the
`chunks` `t.rich` hands it, and every call site that used to hand over the
element directly now hands over `timeTag(session.lastSeenAt)` instead. The
full-table and extension/client rows, which read the time outside of
`t.rich` entirely, were already a plain `<LastActive iso={...} />` and did not
have the bug - only the compact row's `t.rich` call did.

## What stops it coming back

`test/i18n/tagged-messages.test.ts` (backed by `test/i18n/tagged-calls.ts`,
a small TypeScript-AST scan) walks every `.ts`/`.tsx` file in every app and
flags two shapes: a tag given a value instead of a function, and a tagged
message formatted with plain `t()`. It resolves each call's namespace from
how its translator was bound, so it catches a mistake like this one with no
per-message test needed. `sessions-table.test.tsx` separately renders the
compact row and asserts the visible text names a relative time, not a tag.

## The general rule

A tagged ICU message's failure mode is not a thrown error or a blank screen -
it is the literal source message, markup and all, rendered where the
translation should have been. That shape is invisible to the type checker
(an element and a function are both valid `ReactNode`-shaped props to pass
around) and easy to miss by reading the code, so it has to be caught by
scanning real call sites against the real catalogs, which is what
`tagged-messages.test.ts` does for every tagged message in the project, not
only this one.
