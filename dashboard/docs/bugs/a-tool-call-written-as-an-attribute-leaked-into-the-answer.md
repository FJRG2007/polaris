# A tool call written as an attribute leaked into the answer

**Found:** November 2026. **Fixed in:**
`dashboard/apps/web/src/lib/polar/pseudo-tools.ts`.
**Guarded by:** `dashboard/apps/web/test/polar/pseudo-tools.test.ts`.

## What was seen

A small stand-in model, used because the model chosen for a Code turn was not
available, answered with nothing but the text
`<polar_tools={"category": "home", "intent": ""}`. The screen showed "Polar
stopped without an answer." for a moment, then replaced it with that raw
markup, which stayed as the answer.

## What it actually was

A model that cannot call tools properly sometimes writes the call as text.
`withoutPseudoToolCalls` strips those calls from what an answer shows, copies,
shares and reads aloud, and `answeredNothing` uses the same function to decide
whether the turn said anything. Its pattern only knew the tag shape
(`<polar_x>` with optional JSON after it). This call had an `=` and no `>`, so it
did not match.

While the text was still arriving, `<polar_tools` matched the pattern for a tag
cut off at the end, so it was held back and the turn read as empty - that was the
notice that flashed. As soon as the `=` arrived, nothing matched any more, and
the raw text was shown as the answer.

## The fix

- The call pattern also takes the tag left open before `=`, a space or the JSON,
  and an optional `>` or `/>` after it. It is still limited to Polar's own
  `polar_*` names, so an answer about HTML, XML or JSX keeps every tag it means.
- A call whose JSON is still arriving at the end of the text is held back while
  the answer streams, so it never flashes on screen.

A turn made only of such a call now ends on the "unanswered" notice with its
Retry button. Nothing asks the model again on its own: a retry costs the person
a request, so it is theirs to make.

## What stops it coming back

`pseudo-tools.test.ts` asserts the exact text the model wrote, its variants
(spaces, `/>`, a closing `>`, a half-written call), that `answeredNothing`
reports such a turn as empty, and that `<polarity=...>` and other tags are left
alone. A model that finds another shape will need it added there.
