---
id: VULN-0037
title: Any member connects a "Local folder" at the server's root and reads or writes everything the web process can
status: fixed
severity: critical
cwe: CWE-862
stride: Elevation of Privilege
cvss: "9.9"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H
location: dashboard/apps/web/src/app/(app)/drive/actions.ts
component: drive
reachability: AUTHENTICATED
exploitability: EASY
confidence: 95
discovered: 2026-11-12
last_seen: 2026-11-12
fixed: 2026-11-12
fix_commit: null
---

## Summary
`connections.manage`, which the default `member` role holds, was enough to create a Drive connection of kind `local` with any `root`, `/` included. The connection then belonged to the member, and Drive authorized it on ownership alone, so the member could read and write everything the web process can: other people's drives, Polaris's own data folder, and the secrets kept on that disk.

## Root cause / data flow
`createConnectionAction` (and `updateConnectionAction`, which can repoint a connection) checked only `connections.manage`. `createConnectionSchema` accepts `{ kind: "local", root: string }`. `requireDriveDriver` -> `getDriver` / `getDriverForConnection` -> `buildDriver` -> `createDriver` built a `LocalDriver` on that root, and `/api/drive/download` and `/api/attachments/fetch` streamed the files back.

## Evidence
White-box source trace (reported by an AI scan, confirmed by reading the code), and a regression test that builds the driver for a member-owned `local` row: before the fix the registry was asked for a driver on `/`; after it, the open is refused. Not exercised against a running instance.

## Impact
Full read and write of the server's filesystem as the web process for any signed-in member, which includes material that leads to taking over the instance.

## Remediation
- A `local` connection opens only while its owner is an administrator or holds `system.manage` (`holdsServerFolders`, `lib/drive-root.ts`). This is checked in `buildDriver`, the one place every connection opens - the owner's Drive, a share link, a background job - so a connection a member made before the fix is refused too.
- Create and update refuse a `local` config from anyone who does not manage servers, with a sentence that says why.
- "Local folder" is not offered in the connection picker to anyone who cannot use it.

## History
- 2026-11-12: reported by an AI security scan; confirmed and fixed the same day; test `test/storage/local-folder-needs-server-admin.test.ts`.
