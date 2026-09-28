---
id: VULN-0020
title: Bind volumes of different accounts collide on the shared volume root (same project slug or typed path)
status: fixed
severity: medium
cwe: CWE-639
stride: Information Disclosure
cvss: "6.5"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N
location: dashboard/apps/web/src/lib/deploy-volume-service.ts
component: deploy
reachability: AUTHENTICATED
exploitability: MEDIUM
confidence: 80
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
Project slugs are unique per owner only and typed bind paths are free, so one account names the same server folder another account already uses and mounts that account's data.

## Root cause / data flow
The default source polaris/deploy/<projectSlug>/<appSlug>/<name> and typed sources had no cross-account ownership check.

## Evidence
White-box source trace; not exercised against a running instance.

The victim has project shop, app web, volume data. The attacker creates project shop with app web and a bind volume data, deploys, and reads the mount.

## Impact
Read and write of another account's service data on the same host.

## Remediation
bindSourceClaimed() refuses a source at, inside, or above another account's bind source on create and update (a generated default steps aside to a folder of its own); at deploy, a pre-existing row that collides with an earlier row of another account is refused.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/deploy-volume-service.ts, lib/deploy-service.ts; test test/deploy/bind-source.test.ts.
- 2026-09-28: the clash check is limited to volumes on the same host (DeployTarget.hostId, null for the local one), since a bind source is a folder on that host's volume root and two accounts on different servers never share it.
