---
id: BUG-0024
title: Pages with a dynamic route are told their code was changed, and password fields are blocked
status: fixed-watching
area: integrity
location: dashboard/packages/core/src/integrity-paths.ts
related:
  - dashboard/packages/core/src/integrity.ts
  - dashboard/packages/core/src/integrity-guard.ts
  - dashboard/packages/core/test/integrity.test.ts
  - dashboard/apps/extension/src/entrypoints/background.ts
  - desktop/src/main/integrity.ts
reported: 2026-11-23
fixed: 2026-11-23
fix_commit: "fix(integrity): a dynamic route's code no longer reads as changed (e3c1f78a05)"
---

## What was seen

Every page that loads code from a dynamic route (`[[...path]]`, `[listId]`)
was reported, in the extension and the desktop app, as running code that had
been changed, and had its password fields blocked. Nothing had been changed.

## Cause (confirmed in code)

A false positive in the path comparison. The signed manifest names each file
as it sits on disk (`.../[[...path]]/page-<hash>.js`), while the browser
reports a dynamic route's chunk percent-encoded
(`.../%5B%5B...path%5D%5D/page-<hash>.js`). `checkedPath()` kept the path
exactly as served, so the lookup missed and the file counted as unknown code.

## Fix

- `checkedPath()` decodes the path one segment at a time, so it meets the
  manifest's name; an encoded slash stays encoded (it never becomes a new
  segment) and a segment that is not valid percent-encoding stays as served.
- `servedPath()` encodes the route brackets again when the file is fetched a
  second time for its digest, the way the browser asked for it.
- Shipped as extension 0.1.289 and desktop 0.1.62.

## Verified

- `dashboard/packages/core/test/integrity.test.ts`: an encoded dynamic-route
  chunk is checked under the manifest's name and judged verified, an encoded
  slash and invalid percent-encoding stay as served, and the re-fetch address
  is encoded again.

## Not verified

- A page with a dynamic route in the released extension and desktop app on the
  owner's instance after the release.

## If it happens again

The flagged file's URL as the browser loaded it (Network panel) and its name
in the signed manifest: a mismatch in encoding or casing between the two is
this class of bug, not changed code.
