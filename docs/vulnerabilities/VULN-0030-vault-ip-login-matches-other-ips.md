---
id: VULN-0030
title: Vault login saved for an IP address offered and filled on other IP addresses
status: fixed
severity: low
cwe: CWE-697
stride: Information Disclosure
cvss: "4.2"
cvss_vector: CVSS:3.1/AV:A/AC:H/PR:N/UI:R/S:U/C:H/I:N/A:N
location: dashboard/packages/core/src/vault-uris.ts:125
component: vault/extension
reachability: EXTERNAL
exploitability: HARD
confidence: 90
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A login saved for http://10.0.1.1 matched any host ending in .1.1, so the extension filled the router's credentials into another device's page.

## Root cause / data flow
baseDomain kept the last two labels without recognising IP addresses.

## Evidence
White-box source trace; not exercised against a running instance.

uriMatches("http://10.0.1.1", null, "http://10.9.1.1/") returned true.

## Impact
Credentials typed into an attacker-controlled LAN host when the user fills.

## Remediation
baseDomain returns IPv4 and IPv6 addresses whole.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/packages/core/src/vault-uris.ts; test dashboard/packages/core/test/vault-uris.test.ts.
