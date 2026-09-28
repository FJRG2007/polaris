---
id: VULN-0004
title: Private GitHub repositories can be built through the instance GitHub App by any deploy member
status: fixed
severity: medium
cwe: CWE-863
stride: Information Disclosure
cvss: "5.3"
cvss_vector: CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:H/I:N/A:N
location: dashboard/apps/web/src/lib/github-access.ts
component: deploy
reachability: AUTHENTICATED
exploitability: MEDIUM
confidence: 70
discovered: 2026-09-28
last_seen: 2026-09-29
fixed: 2026-09-29
fix_commit: null
---

## Summary
A deploy.manage member points a service at a private repo the instance's GitHub App is installed on and reads its source through the build.

## Root cause / data flow
createApplicationAction -> githubCloneIdentity falls back to the App installation token without checking the caller's own access to the repo.

## Evidence
White-box source trace; not exercised against a running instance.

Create a service with the URL of a private repo covered by the App; open the build output or the container files.

## Impact
Source code disclosure of private repositories to any deploy member.

## Remediation
githubRepoChoiceRefusal() in lib/github-access.ts runs when a repo URL is set (createApplicationAction, moveHomeAction). Admins, the project owner cloning with their own account, the account the App is installed on, callers whose own linked GitHub account can read the repo, public repos and credential-less clones are allowed; anyone else is refused when the clone would borrow the App or another user's account. Existing services, builds, redeploys, auto-deploys and webhooks are unchanged. The same check also closes a second path: a collaborator cloning the project owner's private repos with the owner's own linked account.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: left open pending a product decision; see Remediation.
- 2026-09-29: fixed in lib/github-access.ts, app/(app)/apps/deploy/actions.ts, external-actions.ts; test test/deploy/repo-choice.test.ts.
