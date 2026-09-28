---
id: VULN-0013
title: Drive zip, search and recent ignore folder deny rules below the checked folder
status: fixed
severity: high
cwe: CWE-863
stride: Information Disclosure
cvss: "6.5"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N
location: dashboard/apps/web/src/lib/drive-archive.ts
component: drive
reachability: AUTHENTICATED
exploitability: EASY
confidence: 85
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A Drive member with a deny rule on a subfolder downloads its contents in a zip of a parent folder, and sees its file names, paths and sizes in search and recent.

## Root cause / data flow
Only the starting folder was authorized; walk() in drive-archive.ts and the search and recent listings then traversed every folder beneath it.

## Evidence
White-box source trace; not exercised against a running instance.

Member denied on legal: GET /api/drive/download-zip?c=<org conn>&p= -> the zip contains legal/*.

## Impact
Reads of every file an administrator explicitly denied to that member.

## Remediation
drivePathFilter() in lib/drive-authz.ts is passed to zipSourcesFor, search and recent; denied folders are skipped.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/drive-authz.ts, lib/drive-archive.ts, the download-zip, search and recent routes; test test/drive/zip-path-filter.test.ts.
