---
id: BUG-0039
title: After an update, Polaris desktop says the page's code was changed
status: fixed-watching
area: integrity
location: dashboard/packages/core/src/integrity-guard.ts
related:
  - desktop/src/main/integrity.ts
  - dashboard/apps/extension/src/entrypoints/background.ts
  - dashboard/apps/web/public/sw.js
  - .github/workflows/dashboard-publish.yml
  - docs/bugs/BUG-0024-integrity-flags-dynamic-route-chunks.md
  - docs/bugs/BUG-0038-public-domain-shown-not-secure.md
reported: 2026-11-25
fixed: 2026-11-25
fix_commit: "fix(integrity): a page left open across an update is checked against its own build"
---

## What was seen

Polaris desktop showed: "This page's code was changed. The code this Polaris
server sent does not match what Polaris published for its version. Do not type
a password or a key here. Files that differ:
/_next/static/chunks/97829.c8f84c970a9526ca.js".

A false positive: nothing had been changed. It is the second false alarm of the
integrity check after [BUG-0024](BUG-0024-integrity-flags-dynamic-route-chunks.md)
(dynamic routes, reported through the extension), and it blocks password fields
the same way.

## Cause (confirmed on the server and by the reporter)

The dashboard had been updated and restarted minutes before (2026-11-25 16:36
UTC). The flagged file does not exist in the new build (the server answers 404
for it): it belongs to the previous build, which the desktop window still had
open or cached. The check compared that page's files against the manifest of
the server's newest build, where the file is unknown, and reported it as
changed.

## Fix

- The root layout names the build that served the document
  (`<meta name="polaris-build">`, `apps/web/src/app/layout.tsx`). The page half
  of the check (`watchPageCode` in `packages/core/src/integrity-guard.ts`, shared
  by the desktop preload and the extension's page script) sends that build with
  every batch of files; a page without the tag (served before this change) is
  held to the build its first check was judged against, so a chunk loaded after
  an update is no longer judged against the new build.
- The shared checker (`createIntegrityChecker` in `packages/core/src/integrity.ts`)
  judges the page against the signed manifest of its own build when it differs
  from the server's current stamp. All files matching means a new verdict,
  `outdated`: a quiet notice offers Reload / Not now, nothing is blocked and
  nothing reloads by itself (the guard cannot see a half-filled form; the page's
  own update prompt reloads when nothing would be lost).
- The red warning stays for a file that differs from its own build's manifest,
  or that the build never had under a prefix it owns, including changed code
  presented under an older build's stamp.
- A build stamp GitHub has no manifest for is judged against the server's
  current build, exactly as a page that names none, so a made-up stamp never
  buys a quieter verdict. When the page's own manifest cannot be fetched, the
  answer is "cannot verify". When the server answers no stamp (offline, the
  service worker's kept copy), the page is verified against its own build.
- The service worker needed no change: it keeps `/_next/static/` files by their
  content-hashed name and serves kept pages only when the server cannot answer,
  so what it serves is the old build's own code, which is now judged against the
  old build's manifest.
- Shipped as extension 0.1.319 and desktop 0.1.112.

## Verified

- `dashboard/packages/core/test/integrity-checker.test.ts`: the reported case
  (a chunk only the previous build has) is `outdated` against its own build and
  still `changed` without it; a changed file in the current build and under an
  older build's stamp, and a file the older build never had, are `changed`; an
  unknown stamp is judged against the server's build; an unreachable own
  manifest is "cannot verify"; an offline page is verified against its own build.
- `dashboard/packages/core/test/integrity-guard.test.ts` (jsdom): the build from
  the tag is sent; `outdated` shows the reload notice with no warning and no
  locked password field; `changed` shows the warning; without the tag the first
  verdict's build is kept for later chunks.

## Not verified

- The released desktop app and extension on the owner's instance across a real
  update (no GUI or container runs on the development machine).

## If it happens again

Note the time and the file named in the warning, and whether Polaris had just
been updated. On the server: the running build's id
(`/app/apps/web/.next/BUILD_ID` in the web container) and whether that file
exists in `.next/static`; then the manifest for that build on the `integrity`
branch. A file that exists in the running build with a different hash is a real
alarm, not this bug.
