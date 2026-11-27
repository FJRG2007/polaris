---
id: BUG-0067
title: No dashboard image was published for a day, so no install received an update
status: fixed-watching
area: updates
location: dashboard/apps/web/src/lib/polar/usage-report-shape.ts
related:
  - dashboard/apps/web/src/lib/polar/usage-report.ts
  - dashboard/apps/web/src/app/(app)/polar/settings/polar-usage-report.tsx
  - dashboard/apps/web/test/build/server-calls-client.test.ts
  - .github/workflows/dashboard-publish.yml
reported: 2026-11-27
fixed: 2026-11-27
fix_commit:
---

## What was seen

The "Publish dashboard image" workflow had no successful run after 826f960f92
(2026-11-26 21:51 UTC). Every push to main either failed or was cancelled by
the next one, so the Update button in Settings had nothing new to install.

## Cause

- **A client component reached the database client.** The Usage page of
  Polar's settings (`polar-usage-report.tsx`, "use client") imported the list
  of periods from `lib/polar/usage-report.ts`, the module that queries the
  database. Webpack bundled `@polaris/db` and the Prisma client for the
  browser and `next build` stopped with `Can't resolve 'fs'`. Type checking
  and the test suite pass on such an import, so nothing before the image build
  noticed.
- **The test suite on main was red** in the same window, which fails the run
  on its own: `voice-widget` missing from the firewall's own path list, a
  scroll pane in `polar-code-asks.tsx` without `overscroll-contain`, and two
  chat tests not updated for the game bridge (`shows`, `GameBridgeRow`).

## Fix

- The report's shape and the period list moved to `usage-report-shape.ts`,
  which imports nothing at run time; the client imports that, and
  `usage-report.ts` re-exports it so server callers are unchanged.
- `test/build/server-calls-client.test.ts` now also walks every "use client"
  file's run-time imports (type-only imports erased, "use server" files
  stopped at) and fails naming the chain when one reaches `@polaris/db`,
  `server-only` or a Node built-in. It fails on the old import.
- The red tests were fixed at their cause.

## Verified

`next build` with the image's settings, web `tsc`, and the affected test
files, locally. The image itself is built only in CI; no container was run on
the development machine.
