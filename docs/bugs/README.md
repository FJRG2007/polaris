# Bug ledger

Bugs that people reported from using Polaris, kept so a report that comes back
is matched to what was already found and changed instead of being diagnosed from
scratch. Each `BUG-*.md` says what was seen, the cause that was confirmed, what
was changed, what was and was not verified, and what to collect if it happens
again. A bug that returns after its fix is marked `regressed`, not filed again.

Security findings are not kept here; they live in
[`docs/vulnerabilities`](../vulnerabilities/README.md).

| ID | Title | Area | Status | Location | Reported |
|----|-------|------|--------|----------|----------|
| BUG-0001 | A shared screen goes out at low quality on a line that can carry the source | Calls | Fixed, watching | dashboard/apps/web/src/app/(app)/chat/call-quality.ts | 2026-11-21 |
| BUG-0002 | A conversation scrolls up into older messages on its own | Chat | Fixed, watching | dashboard/apps/web/src/app/(app)/chat/channel-view.tsx | 2026-11-21 |
| BUG-0003 | Polar's messages are named "somebody who has left", and its delete preview has no face or AI tag | Chat | Fixed, watching | dashboard/apps/web/src/lib/chat/author-name.ts | 2026-11-21 |
| BUG-0004 | Polar answers a mention with its tool call written out as text | Polar | Fixed, watching | dashboard/apps/web/src/lib/polar/mention-answer.ts | 2026-11-21 |
| BUG-0005 | Polaris desktop seems not to open on its first start, and again after a host is added | Desktop | Fixed, watching | desktop/src/main/window-front.ts | 2026-11-21 |
| BUG-0006 | Opening a link to another site in Polaris desktop ends the call | Calls | Fixed, watching | dashboard/apps/web/src/app/(app)/chat/use-sfu-call.ts | 2026-11-21 |
| BUG-0007 | Polar's side panel opens on the old chat, then on an empty one when opened again | Polar | Regressed, see BUG-0016 | dashboard/apps/web/src/components/polar/polar-panel.tsx | 2026-11-21 |
| BUG-0008 | Items from a modpack's mods are missing from the Minecraft item picker | Game servers | Fixed, watching | dashboard/apps/game-servers/src/lib/minecraft/mod-items-service.ts | 2026-11-21 |
| BUG-0009 | The world optimizer removed chests, beds and signs, and left the world unsaveable | Game servers | Fixed, watching | dashboard/apps/game-servers/src/lib/minecraft/world-trim-script.ts | 2026-11-21 |
| BUG-0010 | The side panel says it needs Minecraft 1.16 on a 1.20.1 server | Game servers | Fixed, watching | dashboard/apps/game-servers/src/lib/minecraft/server-release.ts | 2026-11-21 |
| BUG-0011 | A phone in a call, or recording a voice message, sounds cut into pieces | Calls | Fixed, watching | dashboard/apps/web/src/app/(app)/chat/mic-filter.ts | 2026-11-22 |
| BUG-0012 | The conversation with yourself shows initials instead of your picture | Chat | Fixed, watching | dashboard/apps/web/src/app/(app)/chat/conversation-face.ts | 2026-11-22 |
| BUG-0013 | Unlock with passkey fails in the desktop app and never starts on its own | Vault | Fixed, watching | dashboard/apps/web/src/lib/vault/passkey-client.ts | 2026-11-22 |
| BUG-0014 | Signing in on the web jumps to the desktop app halfway through | Auth | Fixed, watching | dashboard/apps/web/src/components/open-in-app.tsx | 2026-11-22 |
| BUG-0015 | Moving to some screens, links or notices in Polaris ends the call | Calls | Fixed, watching | dashboard/apps/web/src/lib/keep-call.ts | 2026-11-22 |
| BUG-0016 | Polar's side panel still opens an old chat instead of a new one | Polar | Fixed, watching | dashboard/apps/web/src/lib/polar/open-chat.ts | 2026-11-22 |
| BUG-0017 | Active sessions on the same computer are not grouped under it | Sessions | Fixed, watching | dashboard/apps/web/src/lib/device-sessions/device-groups.ts | 2026-11-22 |
| BUG-0018 | The conversation list shows an older chat above one with a newer message | Chat | Fixed, watching | dashboard/apps/web/src/lib/chat/conversation-list.ts | 2026-11-22 |
| BUG-0019 | A conversation you are reading, or have just answered, stays unread for a while | Chat | Fixed, watching | dashboard/apps/web/src/lib/chat/read-marks.ts | 2026-11-22 |
| BUG-0020 | A link in a received email does nothing when clicked in Polaris desktop | Desktop | Open | dashboard/apps/web/src/app/(app)/mail/message-body.tsx | 2026-11-23 |
| BUG-0021 | A Gmail mailbox asks to be connected again when its authorization still works | Mail | Fixed, watching | dashboard/apps/web/src/lib/mailbox/credentials.ts | 2026-11-23 |
| BUG-0022 | The browser extension's automatic updates leave it versions behind, with nothing on screen | Extension | Fixed, watching | dashboard/apps/extension/scripts/install.ps1 | 2026-11-23 |
