---
id: VULN-0010
title: Uploaded SVG/HTML served inline from the app origin (Drive download, share links, task attachments)
status: fixed
severity: high
cwe: CWE-79
stride: Tampering
cvss: "7.6"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:L/A:N
location: dashboard/apps/web/src/app/api/drive/download/route.ts:66
component: drive
reachability: EXTERNAL
exploitability: EASY
confidence: 90
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
Files uploaded by one party were served inline with their stored type and no nosniff or CSP sandbox from the Polaris origin. An anonymous uploader on a share link, a task member, or a Drive writer plants an SVG or HTML file whose script runs as whoever opens it.

## Root cause / data flow
drive/download and s/[token]/download with disposition=inline sent the type guessed from the extension; tasks/attachments/[attachmentId] trusted the uploader's Content-Type and served any image/* inline.

## Evidence
White-box source trace; not exercised against a running instance.

PUT /api/s/TOKEN/upload?name=x.svg with an SVG <script>; the victim opens /api/s/TOKEN/download?p=x.svg&disposition=inline. The same through /drive/open for a shared Drive file and through task attachments.

## Impact
Stored XSS against the file owner or any reader, admins included, reachable anonymously through share links with upload enabled.

## Remediation
untrustedFileHeaders() in lib/mime.ts adds nosniff and `CSP: sandbox` (PDF only nosniff) and is applied on all three routes.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/mime.ts and the three routes; tests test/drive/download-inline-script.test.ts, test/tasks/attachment-inline-script.test.ts.
