# Right-to-left: what is left

Built on `feat/i18n-rtl`: direction in the locale registry, `<html dir>`,
Radix `DirectionProvider`, the codemod and its output, the guard, docs.

Remaining refinements, none blocking:

1. Drawers built on the centred dialog (`right-0 left-auto translate-x-0 ...`,
   e.g. deploy `database-panel`, `service-detail`, `volume-detail`, Polar
   settings sidebar, `shell/mobile-nav`) stay physical: the codemod keeps any
   class list that translates on x whole. Mirroring them needs the base dialog
   to centre with logical insets first, then `start-0 end-auto` and
   `slide-in-from-*` swapped under `rtl:`.
2. The same whole-list rule also keeps padding physical in centred pills such as
   `seasonal-frame.tsx` (`left-1/2 -translate-x-1/2 ... pl-4 pr-1.5`). Narrow the
   rule to keep only inset/rounded/border tokens in such lists, rerun
   `node scripts/rtl-logical.mjs`, and regenerate `scripts/rtl-physical.json`.
3. No headless visual pass in an RTL locale has been done. Once an RTL locale
   is added to `LOCALES`, walk the shell, a table, a dialog, a menu and Settings
   headless with `dir="rtl"`.
4. The desktop renderer (`desktop/src/renderer`) is plain HTML that loads the
   dashboard in a window; it has its own CSS and was not touched.
