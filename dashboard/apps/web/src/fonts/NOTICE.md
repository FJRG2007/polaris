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
