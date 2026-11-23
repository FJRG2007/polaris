---
id: VULN-0048
title: Mention and account search matched colleagues by part of a hidden address
status: fixed
severity: low
cwe: CWE-203
stride: Information Disclosure
cvss: "3.1"
cvss_vector: CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N
location: dashboard/apps/web/src/lib/rich-text/mention-service.ts
component: people/search
reachability: AUTHENTICATED
exploitability: EASY
confidence: 100
discovered: 2026-11-23
last_seen: 2026-11-23
fixed: 2026-11-23
fix_commit: null
---

## Summary
The mention picker and the account picker matched people the searcher works with by any part of their email address, even when the account hides its address from that searcher.

## Root cause / data flow
`searchPeople` and `accountsInReach` in `mention-service.ts` put `{ email: contains }` into the colleague query; only the printed line was filtered by `allowedBy`, not the match itself.

## Evidence
Found by the per-file sweep of address reads recorded in `docs/privacy-exposure.md`. Regression tests are named under Remediation.

## Impact
A member can recover a colleague's hidden address character by character by watching whether the colleague stays in the results.

## Remediation
`hiddenAddressMatches` in `people-search.ts` drops an account found only through an address it does not show this viewer (name, handle or the viewer's nickname still match). Both mention paths use it. Test: `test/privacy/address-match-oracle.test.ts`.

## History
- 2026-11-23: found and fixed in the privacy audit.
