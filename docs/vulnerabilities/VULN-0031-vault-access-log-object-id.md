---
id: VULN-0031
title: Vault item-use history readable across the instance via an object item id
status: fixed
severity: low
cwe: CWE-943
stride: Information Disclosure
cvss: "3.5"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N
location: dashboard/apps/web/src/lib/vault/access-log.ts
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
A filter object as the item id made mayReach return the use history of other users' items.

## Root cause / data flow
The item id was not checked to be a string.

## Evidence
White-box source trace; not exercised against a running instance.

Call the access-log action with itemId {not:""}.

## Impact
Disclosure of when and from where other users used their vault items.

## Remediation
Non-string item ids are refused.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/vault/access-log.ts.
