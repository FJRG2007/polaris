---
id: VULN-0011
title: Stored XSS through javascript: hyperlinks in the .docx reading view
status: fixed
severity: high
cwe: CWE-79
stride: Tampering
cvss: "7.6"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:L/A:N
location: dashboard/apps/web/src/app/(app)/drive/viewer/doc-view.tsx:75
component: drive viewer
reachability: EXTERNAL
exploitability: EASY
confidence: 95
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
Word documents are converted with mammoth and injected with dangerouslySetInnerHTML. mammoth copies a hyperlink target verbatim, so a javascript: link in a mailed or shared .docx runs on the Polaris origin when the victim clicks it.

## Root cause / data flow
mammoth 1.12.0 performs no sanitization (document-to-html.js:377); DocView set the HTML directly and is used by the mail, chat, share and file-request viewers.

## Evidence
White-box source trace; not exercised against a running instance.

Add a hyperlink relationship with Target="javascript:alert(document.domain)" to a .docx and mail it; the victim opens the attachment and clicks the link.

## Impact
Script execution as the recipient, reachable from outside the instance through inbound mail.

## Remediation
sanitizeDocHtml() (DOMPurify with its default URI rules) runs on mammoth's output before rendering.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/app/(app)/drive/viewer/doc-html.ts, doc-view.tsx; test test/drive/viewer/doc-html.test.ts.
