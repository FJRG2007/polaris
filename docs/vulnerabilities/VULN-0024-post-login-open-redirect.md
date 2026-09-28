---
id: VULN-0024
title: Open redirect in the post-sign-in redirect parameter
status: fixed
severity: medium
cwe: CWE-601
stride: Spoofing
cvss: "4.7"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:N/I:L/A:N
location: dashboard/apps/web/src/app/oauth/login/post-login-target.ts:31
component: auth
reachability: EXTERNAL
exploitability: EASY
confidence: 95
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A crafted sign-in link sent the user to an attacker site right after they authenticated on the real Polaris.

## Root cause / data flow
The check startsWith("/") && !startsWith("//") accepted /\evil.example, which browsers treat as //evil.example.

## Evidence
White-box source trace; not exercised against a running instance.

/oauth/login?redirect=/%5Cevil.example -> 307 to evil.example; also after 2FA and through /api/connections/<p>/signin.

## Impact
Credential phishing from a trusted Polaris link.

## Remediation
lib/safe-redirect.ts resolves against a placeholder origin and keeps only same-origin paths; login, 2FA and connection sign-in use it.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/safe-redirect.ts, post-login-target.ts, two-factor-view.tsx, lib/connections/link-flow.ts; test test/access/post-login-target.test.ts.
- 2026-09-28: safeRedirect also refuses a resolved path that starts with two slashes, since dot segments such as `/.//host` normalize to `//host`.
