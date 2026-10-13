# Guided tours

A tour is a short walk over a screen's own elements, drawn with
[driver.js](https://driverjs.com): a dimmed page, one element lit at a time, a
popover with a title and a sentence. Six exist today - the shell overview and
one each for Chat, Drive, Deploy, Game servers and Settings - opened from the
account menu's "Guided tours" entry, from search, from `?tour=<id>` on the
screen's own address, or offered once to a new account.

Four pieces:

| Piece                            | Where                                     |
| --------------------------------- | ------------------------------------------ |
| Which tours exist, and their steps | `apps/web/src/lib/tours/registry.ts`     |
| Whether a step's target can be pointed at right now | `apps/web/src/lib/tours/target.ts` |
| Draws a tour with driver.js, loaded on demand | `apps/web/src/lib/tours/runtime.ts` |
| The list, the `?tour=` starter and the first-run offer | `apps/web/src/components/tours/guided-tours.tsx` |

## Adding a step

A step names a `data-tour` attribute rather than a class, because classes move
with every restyle and a tour that silently points at nothing is worse than no
tour:

1. Add `data-tour="<area>.<thing>"` to the element in its screen.
2. Add a `{ key, target, side }` entry to the tour's `steps` in `registry.ts`.
3. Add its words under `<tour id>.steps.<key>.title` and `.body` in both
   `apps/web/messages/en-US/tours.json` and `es-ES/tours.json`.

A step whose target is hidden by a permission, tucked away on a narrow screen,
or disabled for this reader is dropped rather than drawn pointing at nothing
(`isUsable` in `target.ts`); a tour left with no usable step at all shows the
`empty` message instead of starting. `test/tours/registry.test.ts` checks that
every step's `target` is well-formed and that `href` names a real screen.

## Adding a tour

A new entry in `TOURS` (`registry.ts`), with an `href` naming the screen it
belongs to (or `null` for one that runs from anywhere, like the overview) -
that `href` is also the access check: a tour is only offered when the reader's
own navigation reaches its screen (`availableTours`). Its name and summary go
under `<id>.name` and `<id>.summary` in the `tours` catalog, read by the list
dialog and by search.

## The first-run offer

The shell overview is offered once per account, after a short delay so it does
not fight the first paint. The account's own mark (`tour.overview` in the
per-account marks table, `tour-actions.ts`) is what makes it once-ever across
every device; a browser-local flag only avoids asking the server again on
every load. Both the offer and the mark fail silently - a tour is not worth an
error on screen.

## Loading

`driver.js` and its CSS, and `tour-theme.css` (the popover restyled to match
the rest of Polaris), are imported inside `runtime.ts`, which `guided-tours.tsx`
only `import()`s the first time a tour actually starts. Nothing about a tour
reaches the first page load.
