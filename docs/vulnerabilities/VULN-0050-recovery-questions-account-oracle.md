---
id: VULN-0050
title: Public recovery form revealed whether an address has an account, and its security questions
status: fixed
severity: medium
cwe: CWE-204
stride: Information Disclosure
cvss: "5.3"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N
location: dashboard/apps/web/src/lib/account-recovery-service.ts
component: auth/account-recovery
reachability: UNAUTHENTICATED
exploitability: EASY
confidence: 100
discovered: 2026-11-23
last_seen: 2026-11-23
fixed: 2026-11-23
fix_commit: null
---

## Summary
`/oauth/recover` looked up a typed email or username and returned that account's security questions. An address with questions answered with three questions, any other with none, so the form told anyone whether the address had an account. It also handed out the questions themselves, which are the owner's own words.

## Root cause / data flow
`lookupRecoveryAction` -> `accountRecoveryQuestions(identifier)` -> `listSecurityQuestions(account.id)`, returned to the unauthenticated page.

## Evidence
Read during the privacy audit. The page's copy also said "There are no security questions on this account".

## Impact
An unauthenticated caller could check addresses against the instance (throttled to 10 per address and 30 per network every 15 minutes) and read the questions of any account that set them.

## Remediation
The lookup is gone. The form always shows the same three answer boxes, and the answers are checked in any order by `verifySecurityAnswersAnyOrder`. The check costs the same whether or not the address belongs to an account. Test: `test/account/account-recovery.test.ts`.

## History
- 2026-11-23: found and fixed in the privacy audit.
