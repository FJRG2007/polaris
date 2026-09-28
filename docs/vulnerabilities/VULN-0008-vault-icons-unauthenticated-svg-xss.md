---
id: VULN-0008
title: Unauthenticated stored XSS through vault website icons served from the Polaris origin
status: fixed
severity: high
cwe: CWE-79
stride: Tampering
cvss: "8.2"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:H/I:L/A:N
location: dashboard/apps/web/src/lib/vault/icons.ts:121
component: vault
reachability: EXTERNAL
exploitability: EASY
confidence: 90
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
The public vault icon endpoint fetches https://<domain>/favicon.ico for any public domain and serves back anything typed image/*, SVG included, from the Polaris origin with no nosniff or CSP. A signed-in user who opens a crafted icon URL runs attacker script with their session.

## Root cause / data flow
tryFetch keeps any image/* response; icon() in lib/vault/api/misc.ts returns it with a public 24h cache and no protective headers, via api/bw/[...path] (/vault/icons/:path*).

## Evidence
White-box source trace; not exercised against a running instance.

Host favicon.ico on attacker.example as image/svg+xml containing <script>. Victim opens https://POLARIS/vault/icons/attacker.example/icon.png -> the script runs on the Polaris origin.

## Impact
Session-riding of any signed-in user, admins included, with no attacker account needed.

## Remediation
SVG icons are refused and responses carry nosniff and `default-src 'none'; sandbox`.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/vault/icons.ts, dashboard/apps/web/src/lib/vault/api/misc.ts; tests test/vault/icon-endpoint.test.ts, test/vault/icon-fetch.test.ts.
