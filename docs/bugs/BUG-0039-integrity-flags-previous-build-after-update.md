---
id: BUG-0039
title: After an update, Polaris desktop says the page's code was changed
status: open
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
fixed:
fix_commit:
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

## Fix (agreed with the reporter, in progress)

- Each page is checked against the signed manifest of the build it was loaded
  with, not the newest one.
- A page from an older build reloads, or offers to reload without losing unsaved
  work, instead of the tamper warning.
- The warning stays for a file that does not match the published manifest of its
  own build, including a modified file presented under an old build's id.
- Applies wherever the check runs: desktop, extension, the page itself and the
  service worker's cached copies.

## If it happens again

Note the time and the file named in the warning, and whether Polaris had just
been updated. On the server: the running build's id
(`/app/apps/web/.next/BUILD_ID` in the web container) and whether that file
exists in `.next/static`; then the manifest for that build on the `integrity`
branch. A file that exists in the running build with a different hash is a real
alarm, not this bug.
