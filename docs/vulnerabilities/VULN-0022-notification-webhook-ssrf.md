---
id: VULN-0022
title: SSRF through notification webhook destinations
status: fixed
severity: medium
cwe: CWE-918
stride: Information Disclosure
cvss: "6.4"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N
location: dashboard/apps/web/src/lib/notifications/webhook-sender.ts:127
component: notifications
reachability: AUTHENTICATED
exploitability: EASY
confidence: 85
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
Any signed-in account posted JSON to internal addresses and mapped internal HTTPS services through the webhook test result.

## Root cause / data flow
The destination schema only required https://; sendWebhook used the global fetch, which follows redirects and bypasses lib/safe-fetch.ts.

## Evidence
White-box source trace; not exercised against a running instance.

Add the destination https://10.0.0.5:8443/x and press Test; or a public URL that 307-redirects to an internal http service.

## Impact
Internal port scanning and blind POST requests into the internal network.

## Remediation
sendWebhook validates with safeUrl() and sends through follow() from safe-fetch; every refusal returns the same message.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/notifications/webhook-sender.ts; tests test/notifications/webhook-sender.test.ts, test/notifications/webhook-private.test.ts.
