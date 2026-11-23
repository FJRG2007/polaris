---
id: VULN-0051
title: Security answers alone could set a new password, and could be guessed before any code was entered
status: fixed
severity: medium
cwe: CWE-640
stride: Elevation of Privilege
cvss: "5.4"
cvss_vector: CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:H/A:N
location: dashboard/apps/web/src/app/(app)/account/security/actions.ts
component: auth/security-questions
reachability: AUTHENTICATED
exploitability: MODERATE
confidence: 95
discovered: 2026-11-23
last_seen: 2026-11-23
fixed: 2026-11-23
fix_commit: null
---

## Summary
Anyone with an open session (a stolen laptop, for example) could set a new password by answering the security questions alone, then sign every other session out. On the sign-in step-up, someone holding only the password could read the questions and try answers before entering any of the codes the sign-in still owed.

## Root cause / data flow
`recoverPasswordSchema` accepted three answers or a TOTP code. `recoverPasswordAction` then called `verifySecurityAnswers` as the only check. The step-up page listed the questions, and `answerStepUpQuestionsAction` checked answers, whenever `questionLeft` was true, even with codes still owed.

## Evidence
Read during the privacy audit. Security questions are meant as an extra signal only, never the sole proof.

## Impact
Security questions have low entropy, so anyone who could guess them could take over an account from an open session. Separately, a stolen password let anyone read the questions on the sign-in step-up and test answers against them.

## Remediation
The answers now count only together with a code sent to the account's email or phone (`sendRecoveryCodeAction`, purpose `password-recovery`), or the authenticator path is used instead. The step-up shows and checks the questions only once every owed code is entered. The risk check asks the questions after its code, and asks nothing when no code can be sent. Tests: `packages/core/test/account-security.test.ts`, `test/auth/two-factor-step-up-actions.test.ts`, `test/auth/sign-in-risk.test.ts`.

## History
- 2026-11-23: found and fixed in the privacy audit.
