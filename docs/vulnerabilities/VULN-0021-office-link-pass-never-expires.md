---
id: VULN-0021
title: Office link pass works forever and survives revoking the link
status: fixed
severity: medium
cwe: CWE-613
stride: Elevation of Privilege
cvss: "6.5"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:H/A:N
location: dashboard/apps/web/src/lib/office/links.ts:295
component: office
reachability: EXTERNAL
exploitability: EASY
confidence: 90
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
Anyone who once opened an editor share link kept writing to the document indefinitely, even after the owner revoked the link.

## Root cause / data flow
The pass was an HMAC over document id and role only: no link id, no expiry, and the server never re-checked the link.

## Evidence
White-box source trace; not exercised against a running instance.

Copy the polaris_officedocpass_<docId> cookie; the owner revokes the link; POST /api/office/<docId>/content still writes.

## Impact
Revoking document sharing had no effect.

## Remediation
The pass is role.linkId.exp.sig; expiry is enforced server-side and linkPassStanding() re-checks the link row on each request.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/office/links.ts, lib/office/reader.ts, app/od/actions.ts; test test/office/link-pass.test.ts.
- 2026-09-28: the pass is also signed over the link's password hash, so changing the password ends every pass issued under the old one.
