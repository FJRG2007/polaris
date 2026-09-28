---
id: VULN-0034
title: Messaging bridge starts with an empty token and compares it in non-constant time
status: fixed
severity: low
cwe: CWE-306
stride: Spoofing
cvss: "3.7"
cvss_vector: CVSS:3.1/AV:A/AC:H/PR:N/UI:N/S:U/C:L/I:L/A:N
location: dashboard/services/messaging-bridge/src/server.ts:36
component: messaging-bridge
reachability: INTERNAL
exploitability: HARD
confidence: 70
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
Run by hand without BRIDGE_TOKEN, the bridge accepted `Authorization: Bearer ` and let anyone on its network connect channels and send messages. Bridges Polaris installs always get a random token.

## Root cause / data flow
index.ts only warned; server.ts compared with !==.

## Evidence
White-box source trace; not exercised against a running instance.

curl -H 'Authorization: Bearer ' http://bridge:8787/channels against a bridge started with no token.

## Impact
Unauthenticated control of messaging channels on a misconfigured bridge.

## Remediation
The bridge exits without a token; the header is compared by SHA-256 digest with timingSafeEqual, and an empty token authorizes nobody.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/services/messaging-bridge/src/index.ts, src/server.ts.
