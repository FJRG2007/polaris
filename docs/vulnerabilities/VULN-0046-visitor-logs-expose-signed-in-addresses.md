---
id: VULN-0046
title: Link and drop-point visitor logs show a signed-in visitor's address, browser and email
status: fixed
severity: medium
cwe: CWE-359
stride: Information Disclosure
cvss: "4.3"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:U/C:L/I:N/A:N
location: dashboard/apps/web/src/lib/visitor-privacy.ts
component: drive/visitor-logs
reachability: AUTHENTICATED
exploitability: EASY
confidence: 100
discovered: 2026-11-23
last_seen: 2026-11-23
fixed: 2026-11-23
fix_commit: null
---

## Summary
The owner of a shared link, a snippet or a drop point saw each visitor's IP address and user agent, including visitors signed in to Polaris, and a visitor with no name or handle was named by their email address. Any member could send a colleague a link and learn where they connect from.

## Root cause / data flow
`getShareLogsAction`, `getSnippetLogsAction` and the drop point page returned the stored `ip` and `userAgent` for every row; `toLinkVisitor` fell back to `user.email`.

## Evidence
Found by the privacy sweep recorded in `docs/privacy-exposure.md`. Regression tests are named under Remediation.

## Impact
Any member learns another member's IP address, browser and, for accounts with no name or handle, their email.

## Remediation
One rule, `visitOrigin` in `dashboard/apps/web/src/lib/visitor-privacy.ts`, used by every visitor log: a signed-in visitor is shown as their profile only; an anonymous visitor keeps the address the visit carried. `toLinkVisitor` never falls back to the email. Tests: `test/privacy/visitor-origin.test.ts`, `test/drive/share-log-identities.test.tsx`.

## History
- 2026-11-23: found and fixed in the privacy audit.
