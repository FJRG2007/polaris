# Office in Polaris

Docs, Sheets, Slides and Diagrams, in the browser, edited by several people at
once and shared by link - the Google suite's shape, on somebody's own machine.

This file is the plan and the record of what was decided and why. It exists
because the research behind it is expensive to redo and because two of its
findings change what can be built at all.

## What GenOffice actually is, and what that means

`references/repos/genoffice` (Apache-2.0, cloned 2026-09-08) is the reference the
goal names. It has to be read before it can be used, and reading it changes the
plan:

- It is an **Electron desktop suite** - six apps around one engine layer, opening
  and saving files on a local disk. It is not a web application and has no
  server.
- It has **no real-time collaboration at all**, no share links and no multi-user
  anything. Every one of those is a goal here and none of them can be taken from
  it.
- Its spreadsheet is built on **Univer**, which is a web engine. Its word
  processor and presentation editor are its own.
- Roughly **615,000 lines of TypeScript**: docs 126k, sheets 164k, slides 100k,
  pdf 46k, markdown 15k, shell 18k, shared packages 146k.

So "integrate absolutely everything" cannot mean "port 615k lines of desktop
code", and it should not: a third of it is Electron main processes, preload
bridges, file dialogs, auto-updaters, file-association icons, packaging and
native OS calls, none of which have a meaning in a browser. What it does mean is
that **every capability GenOffice has, Polaris should end up with** - taking its
code where the code transfers, and its design where only the design does.

`ee/` is empty except for a licence notice, so the whole usable codebase is plain
Apache-2.0 and compatible.

### What transfers as code

Measured, not guessed - these are the parts with no `node:` or `electron`
imports, or whose only Node use is file I/O that a Polaris server route performs
anyway:

| From | Lines | What it is |
| --- | --- | --- |
| `apps/sheets/src/domain` | 5,800 | Pure: pivot engine, pivot grouping/filters/timeline, chart recommendation, flash fill, formula shift, range sort, workbook DSL. **Zero** Node or Electron imports. |
| `apps/sheets/src/gateway` | 13,100 | `.xlsx` read and write in TypeScript - conditional formats, charts, defined names, drawings, data validation, filters, hyperlinks, notes, page setup, pivots, tables, themes. Node only for `fs`/`crypto`, which is where a server route lives. |
| `packages/docx-engine` | - | `.docx` read/write. No Node imports at all. |
| `packages/pptx-render` | - | `.pptx` rendering. No Node imports. |
| `packages/pptx-engine` | - | `.pptx` model. Three Node imports to replace. |
| `packages/ai-provider` | - | Reference only: Polaris already has its own provider catalogue. |

Those first two rows are the reason this repo is worth having. **Univer's
open-source edition does not include charts, pivot tables, import/export or
printing** - they are Univer Pro, commercial. GenOffice wrote its own, under
Apache-2.0, and that is precisely the gap Polaris would otherwise have to pay for
or build from nothing.

### What does not transfer, and is not lost

- The Electron shells, preload bridges and packaging. A browser has no use for
  them; Polaris' own app shell replaces them.
- `native/xlsx-engine`, the Rust sidecar (`calamine` + `ironcalc`). It is the
  fast path for reading a large workbook, not the only one - the TypeScript
  gateway above does the same work. Kept in mind as a later optimisation, and it
  would run as a Polaris service, not in the browser.
- `packages/file-parse` and `font-metrics`: Node-bound, and Polaris has its own
  answers for both.
- PDF editing with system OCR, and the six-app desktop navigation.
- The renderers' own look. The goal says Polaris' design, so the 250k lines of
  editor UI are read as a specification - what a toolbar has to offer, what a
  right-click has to do - and rebuilt on `@polaris/ui`.

## The engines, and why each

Every licence below was checked rather than assumed, because one of them ended a
candidacy.

| App | Engine | Licence | Why |
| --- | --- | --- | --- |
| Sheets | **Univer** core + GenOffice's domain and gateway | Apache-2.0 both | The engine GenOffice itself chose, and the only serious web spreadsheet with a formula engine and canvas rendering. Its missing half is exactly what GenOffice supplies. |
| Docs | **TipTap/ProseMirror**, already in Polaris, plus `docx-engine` for import and export | MIT / Apache-2.0 | Polaris has one rich-text surface already ([[rich-text-editor]]); a second would be two editors to keep in step. Page-faithful pagination is a later chapter, not a reason to start again. |
| Slides | Polaris' own canvas over `pptx-engine`'s model | Apache-2.0 | No web presentation editor is both complete and permissively licensed. PPTist is MIT but Vue, and Polaris is React. |
| Diagrams | **Excalidraw** | MIT | Real MIT: forkable, embeddable in a commercial product, React, and it has its own collaboration protocol. |

**tldraw is refused.** Its SDK licence changed in September 2025: production use
now needs a paid commercial licence (reported around $6,000/year) or a free tier
that stamps a watermark on the canvas. It is the nicest canvas of the three and
it cannot ship here.

**draw.io** (Apache-2.0) stays on the table for a second diagram kind later -
UML, ERDs, architecture - where Excalidraw's hand-drawn feel is wrong. It embeds
as an iframe rather than as a component, which is why it is not first.

## Editing together

One mechanism for all four apps: **Yjs** (MIT), the CRDT the whole ecosystem
already agrees on. A document is a `Y.Doc`; every app binds its own model to it:

- Docs - `y-prosemirror`, which binds straight to the editor Polaris already has.
- Sheets - Univer's mutations applied into a shared type.
- Slides - the slide model in a `Y.Map` per slide.
- Diagrams - Excalidraw's elements, which it already models as a flat array.

The transport is Polaris', not a new server: the in-process bus and the
scope-filtered stream that Chat and Tasks already run on ([[tasks-realtime]]),
with the awareness channel (cursors, selections, who is here) alongside it.
Nothing here needs Hocuspocus or a second process.

CRDT rather than operational transform because it survives the thing this
deployment will actually meet: a laptop that closes, reopens on a train, and
reconnects.

## Sharing, and what a link may do

Polaris already has both halves of this and neither needs inventing:

- **By person, team or role** - `AccessGrant` ([[access-grants]]), which already
  reaches five kinds of subject and already knows how to be bounded by dates,
  hours and uses. Two more subject kinds and Office is in it.
- **By link** - the public-link primitives ([[public-link-primitives]]): one set
  of guards, one shell, one password form behind every public link in Polaris.
  View or edit is a capability on the link, not a second mechanism.

## Exporting

`.docx`, `.xlsx` and `.pptx` through the engines above, server-side, plus PDF for
all four. Diagrams export SVG and PNG, which Excalidraw does itself.

## Competitor comparison - the answer to "you tell me"

Asked whether this belongs in Diagrams or in a spreadsheet. Neither, quite, and
the distinction matters more than it looks:

**A comparison is structured data with a fixed shape, and a diagram is one view
of it.** Competitors are rows; criteria are columns; a cell is not a number but a
small record - a rating, the evidence for it, a source link, and when it was last
checked. Kept in a spreadsheet, every one of those becomes a convention somebody
has to remember, nothing can be validated, and the "last checked" column is
blank six months later when it matters most. Kept as a drawing, it cannot be
sorted, filtered, or asked "what changed since March".

So: **a Comparison is its own document kind**, stored structured, and then
*viewed* however the question needs -

- as a matrix, which is the table people expect;
- as a positioning quadrant in Diagrams, drawn **from** the data rather than
  beside it;
- exported to Sheets or `.xlsx` for anybody who wants to take it away.

That also gives the thing a spreadsheet can never give: every claim carries its
evidence and its date, so a battlecard can say how old it is. It is the same
decision Polaris already made for tasks - store the record, draw the board.

## Order of work

Each step is usable on its own; none of them is a scaffold waiting for the next.

1. **The foundation** - one `OfficeDocument` model for the four kinds, the app
   entry and routes, `AccessGrant` subjects, link sharing, the Drive
   relationship, and the Yjs transport over the existing bus.
2. **Docs** - the editor Polaris has, made collaborative and given `.docx` in and
   out.
3. **Sheets** - Univer, then GenOffice's pivots, charts and `.xlsx` gateway.
4. **Diagrams** - Excalidraw, collaborative, exporting.
5. **Comparison** - the document kind above, and the quadrant view.
6. **Slides** - the largest and the last, over `pptx-engine`.

Desktop and mobile applications are explicitly out of scope for now: the goal
says web first, and everything above is built so that a shell around it later
changes nothing underneath.
