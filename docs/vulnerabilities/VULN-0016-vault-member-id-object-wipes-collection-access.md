---
id: VULN-0016
title: Object passed as vault member id deletes collection access on every vault
status: fixed
severity: high
cwe: CWE-943
stride: Tampering
cvss: "7.1"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:H
location: dashboard/apps/web/src/lib/vault/orgs.ts
component: vault
reachability: AUTHENTICATED
exploitability: EASY
confidence: 90
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
Any account with vault.use passes a Prisma filter object instead of a member id and deletes every collection grant on the instance.

## Root cause / data flow
memberId was never checked to be a string; writeScope ran vaultCollectionAccess.deleteMany({ where: { orgUserId: memberId } }) with no vault filter.

## Evidence
White-box source trace; not exercised against a running instance.

setMemberScopeAction(<own vault>, {not:"<uuid>"}, {accessAll:true, collections:[]}).

## Impact
Every shared vault member on the instance loses access to their collections.

## Remediation
UUID validation on member and collection ids; the delete is limited to members of that vault.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/app/(app)/vault/share-actions.ts, lib/vault/orgs.ts; tests test/vault/share-actions.test.ts, test/vault/orgs.test.ts.
