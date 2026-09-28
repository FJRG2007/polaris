---
id: VULN-0018
title: Task automations, forms, sprints, checklists, dependencies and time entries changed across spaces by id
status: fixed
severity: high
cwe: CWE-639
stride: Tampering
cvss: "7.1"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:H/A:N
location: dashboard/apps/web/src/app/(app)/tasks/actions.ts
component: tasks
reachability: AUTHENTICATED
exploitability: EASY
confidence: 90
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A user with tasks.manage and a space of their own changes or deletes child rows of other spaces and tasks, including repointing a victim's public form at their own list to read its submissions.

## Root cause / data flow
The actions authorized the caller's space or task, then the services under lib/tasks/ wrote by the child id alone; createContextAction also returned another space's people, tags and statuses.

## Evidence
White-box source trace; not exercised against a running instance.

Call the update-form action with the victim's form id and the attacker's list id while authorized on the attacker's own space.

## Impact
Tampering with, and reading of, task spaces the caller is not a member of.

## Remediation
Every write is scoped to the authorized space or task; a form's list must be in its own space; the context action requires the folder to belong to the named space.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/app/(app)/tasks/actions.ts, lib/tasks/*-service.ts; test test/tasks/child-rows-stay-in-scope.test.ts.
