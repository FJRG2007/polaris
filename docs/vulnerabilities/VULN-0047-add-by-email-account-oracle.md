---
id: VULN-0047
title: Fields that add somebody by email confirm whether an address has an account
status: fixed
severity: low
cwe: CWE-204
stride: Information Disclosure
cvss: "3.1"
cvss_vector: CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N
location: dashboard/apps/web/src/lib/people-search.ts
component: people/lookup
reachability: AUTHENTICATED
exploitability: EASY
confidence: 100
discovered: 2026-11-23
last_seen: 2026-11-23
fixed: 2026-11-23
fix_commit: null
---

## Summary
Adding a player to a game server, sharing an app, inviting to an organization, adding to a team, naming a successor and granting a deploy project looked accounts up by exact email regardless of the account's own discovery settings, and answered differently for an existing account - the game server lookup also returned the account's name.

## Root cause / data flow
Six call sites ran their own `prisma.user.findFirst({ OR: [{ email }, { username }] })` instead of the people search (`findableBy`), which holds email lookups to the instance discovery policy and the account's own `findByEmail` setting.

## Evidence
Found by the privacy sweep recorded in `docs/privacy-exposure.md`. Regression tests are named under Remediation.

## Impact
Any member can test whether an email address has an account on the instance and, through the game server lookup, read its name.

## Remediation
`resolveNamedAccount` in `people-search.ts` is the one lookup: whole username or whole verified email, then `findableBy`; an unfindable account answers exactly like no account. Used by `game-identity.ts` (through the app host), `install-sharing.ts`, `invitation-service.ts`, `successor-service.ts` and `deploy-project-service.ts`; adding to a team looks only at the organization's roster, with one answer. Administrators are not held to it. Tests: `test/privacy/named-account-lookup.test.ts`, `test/apps/game-identity.test.ts`.

## History
- 2026-11-23: found and fixed in the privacy audit.
