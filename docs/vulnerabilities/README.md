# Vulnerability ledger

This folder is the project's own security memory. Each `VULN-*.md` is one
confirmed finding from a white-box audit; read them before hunting so a known bug
is referenced rather than re-filed, and a fixed one that comes back is flagged as
a regression. Entries are sorted open/regressed first, then by severity.

| ID | Title | Severity | Status | Location | CWE | Discovered |
|----|-------|----------|--------|----------|-----|------------|
| VULN-0003 | Game server player lookup exposes any user's session IP addresses | Medium | Accepted risk | dashboard/apps/game-servers/src/screens/installed/minecraft-actions.ts | CWE-359 | 2026-09-28 |
| VULN-0006 | Sign-in approval gate bypassed through better-auth HTTP endpoints (2FA enable, revoke-other-sessions) | High | Fixed | dashboard/packages/auth/src/auth.ts:869 | CWE-863 | 2026-09-28 |
| VULN-0007 | Organization members with people.manage or roles.manage can grant themselves admin | High | Fixed | dashboard/apps/web/src/app/(app)/account/organizations/actions.ts | CWE-269 | 2026-09-28 |
| VULN-0008 | Unauthenticated stored XSS through vault website icons served from the Polaris origin | High | Fixed | dashboard/apps/web/src/lib/vault/icons.ts:121 | CWE-79 | 2026-09-28 |
| VULN-0009 | Reflected XSS through /api/attachments/fetch serving remote HTML inline | High | Fixed | dashboard/apps/web/src/app/api/attachments/fetch/route.ts:43 | CWE-79 | 2026-09-28 |
| VULN-0010 | Uploaded SVG/HTML served inline from the app origin (Drive download, share links, task attachments) | High | Fixed | dashboard/apps/web/src/app/api/drive/download/route.ts:66 | CWE-79 | 2026-09-28 |
| VULN-0011 | Stored XSS through javascript: hyperlinks in the .docx reading view | High | Fixed | dashboard/apps/web/src/app/(app)/drive/viewer/doc-view.tsx:75 | CWE-79 | 2026-09-28 |
| VULN-0012 | Drive upload and create/mkdir/rename write outside the folder that was authorized | High | Fixed | dashboard/apps/web/src/app/api/drive/upload/route.ts:45 | CWE-22 | 2026-09-28 |
| VULN-0013 | Drive zip, search and recent ignore folder deny rules below the checked folder | High | Fixed | dashboard/apps/web/src/lib/drive-archive.ts | CWE-863 | 2026-09-28 |
| VULN-0014 | Any deploy member mounts other accounts' agent homes and database archives as a server folder | High | Fixed | dashboard/apps/web/src/lib/deploy-volume-service.ts:145 | CWE-22 | 2026-09-28 |
| VULN-0015 | Environment-limited deploy access reaches other environments through the Elsewhere board | High | Fixed | dashboard/apps/web/src/app/(app)/apps/deploy/external-actions.ts | CWE-863 | 2026-09-28 |
| VULN-0016 | Object passed as vault member id deletes collection access on every vault | High | Fixed | dashboard/apps/web/src/lib/vault/orgs.ts | CWE-943 | 2026-09-28 |
| VULN-0017 | Any comment on the instance can be deleted or resolved by id | High | Fixed | dashboard/apps/web/src/lib/comments/comments.ts | CWE-639 | 2026-09-28 |
| VULN-0018 | Task automations, forms, sprints, checklists, dependencies and time entries changed across spaces by id | High | Fixed | dashboard/apps/web/src/app/(app)/tasks/actions.ts | CWE-639 | 2026-09-28 |
| VULN-0019 | Former members keep reading space channels through search and the live stream | High | Fixed | dashboard/apps/web/src/lib/chat/access.ts | CWE-285 | 2026-09-28 |
| VULN-0020 | Bind volumes of different accounts collide on the shared volume root (same project slug or typed path) | Medium | Fixed | dashboard/apps/web/src/lib/deploy-volume-service.ts | CWE-639 | 2026-09-28 |
| VULN-0021 | Office link pass works forever and survives revoking the link | Medium | Fixed | dashboard/apps/web/src/lib/office/links.ts:295 | CWE-613 | 2026-09-28 |
| VULN-0022 | SSRF through notification webhook destinations | Medium | Fixed | dashboard/apps/web/src/lib/notifications/webhook-sender.ts:127 | CWE-918 | 2026-09-28 |
| VULN-0023 | API streams and badges skip the session guard (approval, idle lock, address pin, required 2FA) | Medium | Fixed | dashboard/apps/web/src/app/api/office/[id]/content/route.ts:49 | CWE-285 | 2026-09-28 |
| VULN-0024 | Open redirect in the post-sign-in redirect parameter | Medium | Fixed | dashboard/apps/web/src/app/oauth/login/post-login-target.ts:31 | CWE-601 | 2026-09-28 |
| VULN-0025 | Task space or folder admin can make themselves owner | Medium | Fixed | dashboard/apps/web/src/app/(app)/tasks/actions.ts | CWE-269 | 2026-09-28 |
| VULN-0026 | Chat space admin can remove the space owner | Medium | Fixed | dashboard/apps/web/src/lib/chat/chat-service.ts | CWE-285 | 2026-09-28 |
| VULN-0027 | Delegated vault manager can lock the owner out of their personal vault | Medium | Fixed | dashboard/apps/web/src/lib/vault/orgs.ts | CWE-285 | 2026-09-28 |
| VULN-0028 | Read access disables or rotates another project's analytics tracker | Medium | Fixed | dashboard/apps/web/src/app/(app)/apps/analytics/actions.ts | CWE-285 | 2026-09-28 |
| VULN-0029 | Object as server group id deletes other owners' memberships and firewall rules | Medium | Fixed | dashboard/apps/web/src/app/(app)/apps/servers/actions.ts | CWE-943 | 2026-09-28 |
| VULN-0002 | UniFi UNAS Home Assistant add-on does not verify the NAS SSH host key | Medium | Fixed | plugins/unifi-unas/homeassistant/custom_components/unifi_unas/ssh_manager.py:121 | CWE-295 | 2026-09-28 |
| VULN-0004 | Private GitHub repositories can be built through the instance GitHub App by any deploy member | Medium | Fixed | dashboard/apps/web/src/lib/github-access.ts | CWE-863 | 2026-09-28 |
| VULN-0001 | SSRF via DNS rebinding (TOCTOU) in safe-fetch link unfurl | Medium | Fixed | dashboard/apps/web/src/lib/safe-fetch.ts:118 | CWE-918 | 2026-08-16 |
| VULN-0030 | Vault login saved for an IP address offered and filled on other IP addresses | Low | Fixed | dashboard/packages/core/src/vault-uris.ts:125 | CWE-697 | 2026-09-28 |
| VULN-0031 | Vault item-use history readable across the instance via an object item id | Low | Fixed | dashboard/apps/web/src/lib/vault/access-log.ts | CWE-943 | 2026-09-28 |
| VULN-0032 | Server metrics answered from cache before the ownership check | Low | Fixed | dashboard/apps/web/src/lib/server-metrics-service.ts | CWE-285 | 2026-09-28 |
| VULN-0033 | Drive lock-password rate limit bypassed by respelling the lock id | Low | Fixed | dashboard/apps/web/src/app/(app)/drive/access-actions.ts | CWE-307 | 2026-09-28 |
| VULN-0034 | Messaging bridge starts with an empty token and compares it in non-constant time | Low | Fixed | dashboard/services/messaging-bridge/src/server.ts:36 | CWE-306 | 2026-09-28 |
| VULN-0035 | Inbox ingest key compared in non-constant time | Low | Fixed | dashboard/apps/web/src/app/api/inbox/ingest/route.ts | CWE-208 | 2026-09-28 |
| VULN-0005 | Drive lock unlock cookie never expires and survives a password change | Low | Fixed | dashboard/apps/web/src/lib/access-lock-service.ts:125 | CWE-613 | 2026-09-28 |
| VULN-0036 | A player's kept inventory returned to a caller with no access to the server | Low | Fixed | dashboard/apps/game-servers/src/screens/installed/minecraft-actions.ts | CWE-863 | 2026-10-06 |
