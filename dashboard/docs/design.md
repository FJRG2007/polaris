# The design system

Polaris is looked at for hours at a time by somebody who is trying to find out
whether something is broken. Everything below follows from that: the surfaces are
quiet, the density is high, and colour is spent only where it carries meaning.

Everything here is a token. If a screen needs a colour, a radius, a shadow or a
duration that is not in this file, the answer is almost always one of the ones
that is.

## The four scales

### Depth

`background` -> `surface` -> `card` -> `elevated`. Four steps, each lighter than
the last in the dark theme, each separated by a hairline `border` rather than by
a shadow.

| Token      | What sits on it                                     |
| ---------- | --------------------------------------------------- |
| `background` | The page itself.                                  |
| `surface`  | The chrome: the top bar and the navigation rail.    |
| `card`     | Panels, cards, table containers.                    |
| `elevated` | Menus, selects, dialogs - anything that genuinely floats. |

`elevated` exists because a popover opened over a card has to sit above it, and
a popover painted in `card` over a card is a rectangle with a border in the
middle of the screen. It is the only tier that carries a shadow
(`shadow-popover`, or `shadow-modal` for a dialog), which is what makes a shadow
mean something when one appears.

### Text

Three steps, and they are not interchangeable:

| Token                    | For                                                  |
| ------------------------ | ---------------------------------------------------- |
| `text-foreground`        | The value. What the reader came for.                 |
| `text-muted-foreground`  | The label beside it, and body copy.                  |
| `text-foreground-subtle` | The hint under it, a group heading, a resting icon.  |

Two steps is what makes a dense screen unreadable: a table row has a value, a
label and a timestamp, and painting the last two the same grey means the eye has
to read all three to find one.

### Radius

4px (`rounded`/`rounded-sm`), 6px (`rounded-md`), 8px (`rounded-lg`), 12px
(`rounded-xl`). The whole scale moves together from `--radius`. Menu items and
small controls take the bottom of the scale, cards the middle, dialogs the top.
Nothing is a capsule except an avatar, a switch, and a scrollbar thumb.

### Motion

One easing curve (`--ease`) and two durations: `duration-fast` (120ms) for a
hover or a colour change, `duration` (180ms) for something that moves or
appears. Nothing has a duration of its own, nothing bounces, and nothing scales
under the cursor. `prefers-reduced-motion` switches all of it off in one rule in
`tokens.css`.

## Colour

The neutrals carry a faint cool cast and almost no saturation. A hue washed
across every surface is the difference between an interface that looks designed
and one that looks themed.

Violet (`primary`) is the accent, and it is spent in four places and no others:

- the active row in the navigation rail,
- the primary action in a form or a dialog,
- the focus ring,
- a selected item's check.

`success`, `warning` and `danger` mean state, never emphasis. A badge is
`warning` because something needs attention, not because it should stand out.

## Type

**IBM Plex Sans** for the interface, **IBM Plex Mono** for code, terminals,
hashes and identifiers. Self-hosted (`apps/web/src/fonts`, see the NOTICE there)
so a build needs no network and no visitor is announced to a font service.

The interface sets at 13px, not 16px. A control plane is a dense instrument and
16px body text turns a table of eight columns into a table of four:

| Size     | Used for                                              |
| -------- | ----------------------------------------------------- |
| 17px     | The page title. One per screen, and one size for it.  |
| 15px     | A dialog title.                                       |
| 14px     | A section heading inside a page (`h2`).               |
| 13px     | Everything: rows, fields, buttons, menus, body copy.  |
| 11px     | Group headings and badges, uppercase with tracking.   |

A page title is `text-[17px] font-semibold tracking-tight`, whether it comes
from `PageHeader` or from a screen that writes its own `h1`. It was `text-lg` on
fifty screens, `text-xl` on seventeen and `text-2xl` on thirteen, which is three
answers to one question and the fastest way to make a product look assembled
rather than designed. The public marketing and legal pages are not bound by this
- they are a different kind of page and set their titles large on purpose.

Numbers that are compared down a column - sizes, durations, counts, chart axes -
render with `font-variant-numeric: tabular-nums`, which `table` and the
`.tabular` class turn on.

A column heading is a label rather than a row of data, and `thead th` says so
once for every table: 11px, uppercase, tracked, subtle. It is a rule rather than
a class because the tables that most needed it were the ones whose `<thead>`
carried no class to add to, and its specificity is low enough that any utility
on the cell still wins - a right-aligned heading keeps its alignment.

## Controls

Heights come from one scale: 24px (`xs`), 28px (`sm`), 32px (`md`, the default),
36px (`lg`). A field is 32px and reads as a recess: `bg-field`, darker than the
card it sits on in both themes, with a hairline edge that firms up on hover. It
is its own token rather than an alpha of the page background, which is a recess
on the dark theme and invisible on the light one - there the page is 97% and the
card over it is white. A filled button carries a hairline top edge, which is
what stops a solid fill from reading as a rectangle pasted onto the page.

## Empty states

`EmptyState` from `@polaris/ui`: an optional icon, a short statement of what is
not there, a sentence about it, and - whenever one exists - the control that
fixes it. A screen that says "no servers yet" and offers no way to add one has
told somebody they are stuck.

`bare` drops the dashed frame, for an empty state inside a panel that already
draws its own edge.

A dashed border does not always mean empty: it also means "drop a file here".
Those stay as they are.

## The focus ring

There is one, it is defined once in `tokens.css`, and it applies to every
focusable element through a zero-specificity `:where()` rule. A component must
not restate it, and must not disable it. It is keyboard-only
(`:focus-visible`): a mouse press already told the user what it hit.

## Where it lives

```
packages/ui/src/styles/tokens.css   every token, and the rules that apply to everything
packages/ui/src/tailwind-preset.ts  the tokens as Tailwind scales
packages/ui/src/components/         the primitives built on them
packages/ui/src/shell/              the application chrome
apps/web/src/app/globals.css        the webfonts, the Overview grid, syntax highlighting
apps/web/src/fonts/                 the typeface, and its licence
```

## Adding to it

Reuse before adding. A new token is justified when a value is needed in more
than one place and means the same thing in both; a value used once belongs in
the component that uses it. A new colour is almost never justified - if a screen
wants a fifth status colour, the question is usually whether it has five states.
