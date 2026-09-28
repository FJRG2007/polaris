---
id: VULN-0027
title: Delegated vault manager can lock the owner out of their personal vault
status: fixed
severity: medium
cwe: CWE-285
stride: Denial of Service
cvss: "5.4"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:H
location: dashboard/apps/web/src/lib/vault/orgs.ts
component: vault
reachability: AUTHENTICATED
exploitability: EASY
confidence: 75
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A manager the owner added deleted, re-keyed, narrowed or demoted the owner's member row, which holds the owner's only wrapped key.

## Root cause / data flow
removeMember, confirmMember, setMemberScope and inviteMember did not protect the owner's row.

## Evidence
White-box source trace; not exercised against a running instance.

As a manager, removeMember(<vault>, <owner member id>).

## Impact
Permanent loss of the owner's access to their vault.

## Remediation
The owner's row is excluded from all four; re-inviting the owner is refused.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/vault/orgs.ts; test test/vault/orgs.test.ts.
