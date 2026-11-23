# Privacy exposure inventory

The rule: no user may obtain another person's private information in any way -
their IP address, phone number, email, or anything they keep hidden. Hidden is
the default and stays the default. This page lists every surface where one user
can learn about another, and its verdict. Re-run the sweeps at the end before
adding a surface that shows one person to another.

## Lessons taken from other messengers

- WhatsApp added "Protect IP address in calls" because 1:1 calls went peer to
  peer (WhatsApp help center, "How to protect IP address in calls").
- Signal and Telegram leaked readers' addresses through link previews until
  previews were generated on the sender's side or through a proxy (Mysk research,
  "Link previews: how a simple feature can have privacy and security risks", 2020).
- Discord serves every embedded image through its media proxy for the same reason
  (Discord developer docs, "Embed" `proxy_url`).
- Telegram's "People nearby" and contact import were account and location
  oracles (public research on Telegram contact discovery, 2021-2024).

## Surfaces

| Surface | What could leak | Verdict | Where |
|---|---|---|---|
| Chat link previews | Reader IP to the linked site | Safe: card picture fetched by Polaris | `app/api/chat/links/[previewId]/image/route.ts` |
| Pictures written in chat, tasks, notes | Reader IP to any site | Fixed (VULN-0045): fetched through `/api/media/remote-image` | `components/rich-text/rich-text.tsx` |
| Polar (assistant) answers | Exfiltration through an image address | Safe: shown as a link, never fetched | `components/polar/elements/message.tsx` |
| Game links in chat | Reader IP | Safe: only `/logos/*` marks are drawn | `lib/chat/game-links.ts` |
| Mail | Reader IP to tracking pixels | Safe: remote content is a per-user privacy setting | `app/(app)/mail/settings/privacy` |
| Calls and meetings | Peer IP through ICE candidates | Safe: LiveKit SFU, every client connects only to the media server; no peer-to-peer path | `lib/chat/call-server.ts` |
| Call participant metadata | Email, IP | Safe: the token carries the seat id and display name only | `lib/chat/call-server.ts` |
| People search, mentions, pickers | Account existence, directory | Safe: `findPeople`/`findableBy` under the discovery policy and each account's own settings | `lib/people-search.ts` |
| Add-by-email fields (game player, app share, org invite, team add, successor, deploy grant) | Account existence, name | Fixed (VULN-0047): `resolveNamedAccount`, one answer for unfindable and missing | `lib/people-search.ts` |
| Shared-link, snippet and drop-point visitor logs | Signed-in visitor IP, user agent, email | Fixed (VULN-0046): `visitOrigin` - a signed-in visitor is their profile, never their address or browser; anonymous visitors keep IP | `lib/visitor-privacy.ts` |
| Game server player list, refusals, access editor | Player IP to managers | Fixed (VULN-0003): hidden by default, per-server opaque references; a typed address reads as its own reference | `apps/game-servers/src/lib/minecraft/address-refs.ts` |
| Game server player lookup | Linked account's sign-in IPs | Fixed: empty unless an administrator shares addresses | `screens/installed/minecraft-actions.ts` |
| Game server MCP tools | Same as the list | Fixed: same `forViewer`, references resolved server-side | `apps/game-servers/src/lib/mcp-player-tools.ts` |
| Account sessions, devices, passkeys | Own IP and user agent | Safe: the account's own rows only | `lib/session-directory.ts`, `lib/session-device.ts` |
| Firewall, admin security, user admin | IP, email | Safe: administrator-only screens | `app/(app)/admin`, `apps/firewall` |
| Audit log | IP, email in metadata | Safe: administrator-only; game server audit keeps the real address there | `lib/audit-service.ts` |
| Office opens, task views, chat attachment opens | Who opened | Safe: no IP or user agent stored | Prisma `OfficeDocumentOpen`, `TaskView`, `ChatAttachmentOpen` |
| Webhooks | Caller IP | Owner's own integration log | `lib/automations/webhook-service.ts` |

## Per-file verdicts (`email: true`, 69 files)

| Group | Files | Verdict |
|---|---|---|
| Own account or server-side only | calendar event-titles, occurrences, upcoming; places automation-runtime; drive activity-actions; api/extension/session; api/v1/me; account-recovery-service; admin-credentials-service; automations/runner; avatar-service; cli/sign-in; crm-host; email-verification-service; extension/sessions; instance-security; mailbox/delegate; mcp/acting-user; mcp/tools; notifications/dispatch; second-factor-enrollment; two-factor-delivery; vault account-identity, api/sends, auth, identity, sync; view-as-service; packages/auth account, saml-sso, security | Safe: the account's own address, or read to send mail / sign in, never shown to another person |
| Roster rule already applied | access/grants, access/subject-owner, deploy-project-service, friends-service, notes/shelf-service, orgs/invitation-service, orgs/org-service, successor-service | Safe: every address passes `contactLines` |
| Administrator-only | admin/users identity-card, user-admin-service, firewall actions (others' addresses only to admins), address-accounts, compliance/evidence-readings, connections/store (runner pools, `system.manage`), group-members, packages/auth groups, polar answer-feedback-service and usage, safety-queue, vpn/service and wireguard-service (own devices unless admin), org-directory | Safe |
| Server-side matching only | calendar presence-busy, calendar-host (`accountsByEmail` never shown), mailbox/face-owner, tasks/share-service, crm activities and duplicates (CRM contacts, not accounts), invite-service (admin invitations) | Safe: the address picks an account and is not returned |
| Calendar attendees | calendar event-detail, invitations, meetings `emailInvites` (host only) | Accepted: an attendee address is one the organizer typed or was allowed to see (the picker honours `allowedBy`); iCalendar carries attendees as addresses (RFC 5545 `ATTENDEE`) |
| Visitor logs | link-visitor | Fixed: the select no longer reads the address at all |
| Vault members and add picker | vault/orgs `listMembers`, vault/share-actions | Fixed: members and candidates go through `contactLines`; the picker sends an account id and the server finds the address |
| Mention and account search | rich-text/mention-service | Fixed: a colleague matched only by part of an address they hide is left out (`hiddenAddressMatches` in `people-search.ts`) |
| Notification defaults | packages/core schemas/notifications | Not a read: `email: true` is the mail channel default |

Not yet swept by hand: the 13 `lastSeenAt: true` selects (presence, read receipts,
chat, computers, outage tracker, mailbox contacts, file requests).

## Sweeps

```sh
grep -rln "ipAddress: true\|userAgent: true\|ip: true" dashboard/apps/*/src --include=*.ts
grep -rlnE "\{ ?email: ?[a-zA-Z.]+ ?\}" dashboard/apps/*/src --include=*.ts
grep -rln "email: true\|phone: true\|lastSeenAt: true" dashboard/apps/*/src --include=*.ts
grep -rlnE "<img[^>]*src=\{[a-zA-Z]" dashboard/apps/web/src --include=*.tsx
```
