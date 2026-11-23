---
id: VULN-0049
title: Organization vault managers read every roster member's email
status: fixed
severity: low
cwe: CWE-359
stride: Information Disclosure
cvss: "3.5"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N
location: dashboard/apps/web/src/lib/vault/orgs.ts
component: vault/organizations
reachability: AUTHENTICATED
exploitability: EASY
confidence: 100
discovered: 2026-11-23
last_seen: 2026-11-23
fixed: 2026-11-23
fix_commit: null
---

## Summary
The vault members screen, its add picker and the Bitwarden-compatible members API returned the email address of every organization member to anybody holding `vault.manage`, regardless of the member's own privacy setting.

## Root cause / data flow
`vaultMembersAction` read `owner.email` and `members.user.email` and sent them as the picker's values and labels; `listMembers` returned each member row's stored address.

## Evidence
Found by the per-file sweep of address reads recorded in `docs/privacy-exposure.md`. Regression tests are named under Remediation.

## Impact
A vault manager who is not an administrator learns addresses the members keep hidden.

## Remediation
`listMembers(orgId, viewer)` and the add picker print `contactLines`; the picker sends an account id and `inviteeAddress` finds the address on the server after checking the roster. Test: `test/vault/vaults-view.test.tsx`.

## History
- 2026-11-23: found and fixed in the privacy audit.
