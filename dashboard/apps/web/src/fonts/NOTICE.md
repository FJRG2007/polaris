# Fonts

Polaris sets its interface in **IBM Plex Sans** and its code, terminals and
identifiers in **IBM Plex Mono**.

- Copyright: IBM Corp.
- License: SIL Open Font License, Version 1.1
- Source: <https://github.com/IBM/plex>

Only the four Sans weights (400/500/600/700) and three Mono weights
(400/500/600) the interface actually uses are checked in, as `woff2`. They are
self-hosted rather than fetched from a font service for two reasons: a build has
to work with no network, and a request per visitor to a third party is a record
of who uses this instance, held somewhere the operator does not control.

`app/layout.tsx` loads them through `next/font/local`, which fingerprints and
preloads them and exposes each as a CSS variable that `globals.css` folds into
`--font-sans` and `--font-mono`.

## Display name faces

A display name can be set in a face of its owner's choosing, which is what the
rest of the files here are. They are never used for the interface - only for
somebody's name, in Chat, on a profile card, in a member list.

All eight are under the SIL Open Font License, Version 1.1, and all eight were
taken from Google Fonts as the `latin` subset only:

| Choice | Face | Copyright |
| --- | --- | --- |
| Serif | Playfair Display | Claus Eggers Sorensen |
| Rounded | Fredoka | Milena Brandao, Hafontia |
| Handwritten | Playpen Sans | TypeTogether |
| Comic | Bangers | Vernon Adams |
| Script | Lobster | Impallari Type |
| Block | Bungee | David Jonathan Ross |
| Techno | Orbitron | Matt McInerney |
| Pixel | Press Start 2P | Cody "CodeMan38" Boisclair |

Three more choices need no file at all: **Default** and **Mono** are the two
interface faces above, and **Small caps** is a typographic variation of Default.

Unlike the interface faces these are declared but **not preloaded**, so a browser
only fetches one the first time a name on the page is actually set in it. A
deployment where nobody has chosen a face downloads none of them.
