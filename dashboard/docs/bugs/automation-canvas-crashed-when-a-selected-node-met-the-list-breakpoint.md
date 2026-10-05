# The automation editor crashed when a selected node met the list breakpoint

**Found:** October 2026. **Fixed in:**
`dashboard/packages/ui/src/automation/canvas.tsx`.
**Guarded by:**
`dashboard/packages/ui/test/automation-canvas-selection.test.tsx`.

## What was seen

With a node selected and its card open, the window crossing the width at
which the diagram becomes a list and back - a resize, a rotated tablet, or a
full-page screenshot - took the editor down with React's "Maximum update
depth exceeded." Places' automations and Mail's filters share this canvas,
so both went down the same way.

## What it actually was

Selection was read from React Flow's `onSelectionChange`, which does not only
report what the reader clicked - it also reports the diagram's own state,
and that state is empty for a moment every time the diagram is redrawn from
scratch, which is what happens coming back from the narrow list. That empty
report landed one render behind the nodes already handed to the diagram, so
it read as the reader deselecting, which fed back into the nodes, which
re-fired `onSelectionChange`, which fed back again - the two sides chased
each other, one render apart, for as long as React would let them.

## The fix

`selectedBy()` reads selection from `onNodesChange` instead: React Flow only
emits a `select` change there for what the reader actually did (a click, a
keyboard select, closing the card), never as a side effect of redrawing the
diagram. A `select: true` change is the node picked; a `select: false`
change for the node already selected is it being let go; anything else
leaves the current selection untouched. `onSelectionChange` is no longer
wired to the canvas.

## What stops it coming back

`automation-canvas-selection.test.tsx` drives a real width change past
`matchMedia` and asserts the selected node's card survives the diagram
being torn down and redrawn, and that closing the card still clears the
selection.

## The general rule

A library callback that reports state, not just the user's action, is not
safe to pipe straight into a state setter that feeds back into that same
library - a redraw's own transient state will eventually get read as input.
Prefer the change-list callback that fires only for what actually happened.
