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
| BUG-0001 | A shared screen goes out at low quality on a line that can carry the source | Calls | Regressed, see BUG-0036 | dashboard/apps/web/src/app/(app)/chat/call-quality.ts | 2026-11-21 |
| BUG-0002 | A conversation scrolls up into older messages on its own | Chat | Fixed, watching | dashboard/apps/web/src/app/(app)/chat/channel-view.tsx | 2026-11-21 |
| BUG-0003 | Polar's messages are named "somebody who has left", and its delete preview has no face or AI tag | Chat | Fixed, watching | dashboard/apps/web/src/lib/chat/author-name.ts | 2026-11-21 |
| BUG-0004 | Polar answers a mention with its tool call written out as text | Polar | Fixed, watching | dashboard/apps/web/src/lib/polar/mention-answer.ts | 2026-11-21 |
| BUG-0005 | Polaris desktop seems not to open on its first start, and again after a host is added | Desktop | Fixed, watching | clients/desktop/src/main/window-front.ts | 2026-11-21 |
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
| BUG-0023 | Polaris desktop does not seem to open with the computer, or opens minutes later | Desktop | Fixed, watching | clients/desktop/src/main/login-item.ts | 2026-11-23 |
| BUG-0024 | Pages with a dynamic route are told their code was changed, and password fields are blocked | Integrity | Fixed, watching | dashboard/packages/core/src/integrity-paths.ts | 2026-11-23 |
| BUG-0025 | In Polaris desktop the top right of the window shows different or missing buttons compared with the web | Desktop | Fixed, watching | dashboard/packages/ui/src/shell/window-controls.ts | 2026-11-23 |
| BUG-0026 | Sharing a screen larger than 4K freezes the sharer, and the others cannot watch it | Calls | Fixed, watching | dashboard/apps/web/src/app/(app)/chat/call-quality.ts | 2026-11-23 |
| BUG-0027 | A call is lost when Polaris desktop or the phone app updates, instead of carrying on | Calls | Fixed, watching | dashboard/apps/web/src/app/(app)/chat/call-resume.ts | 2026-11-23 |
| BUG-0028 | A message with a link is not shown as sent until its preview has loaded | Chat | Fixed, watching | dashboard/apps/web/src/app/(app)/chat/outbox.ts | 2026-11-23 |
| BUG-0029 | Typing @ in a group DM shows only Polar, @here and @everyone at first | Chat | Fixed, watching | dashboard/apps/web/src/components/rich-text/suggestion.tsx | 2026-11-23 |
| BUG-0030 | The @ picker is a small desktop popover on an iPhone | Chat | Fixed, watching | dashboard/apps/web/src/components/rich-text/suggestion.tsx | 2026-11-23 |
| BUG-0031 | The desktop voice widget shows initials instead of people's profile pictures | Desktop | Fixed, watching | clients/desktop/src/main/voice-widget.ts | 2026-11-23 |
| BUG-0032 | In Polaris desktop, pressing "View full profile" in a direct message froze the window for a while | Chat | Open, not reproduced | dashboard/apps/web/src/app/(app)/chat/profile-details.tsx | 2026-11-23 |
| BUG-0033 | With Polaris unreachable, only the chat opens | Dashboard | Partly fixed | dashboard/apps/web/public/sw.js | 2026-11-23 |
| BUG-0034 | In Polaris desktop the Christmas Polaris logo does not load | Desktop | Fixed, watching | clients/desktop/src/main/app-icon.ts | 2026-11-24 |
| BUG-0035 | A note written offline is never saved | Dashboard | Partly fixed | dashboard/apps/web/src/app/(app)/notes/notes-view.tsx | 2026-11-23 |
| BUG-0036 | A watched screen share arrives at 540p instead of full quality | Calls | Fixed, watching | dashboard/apps/web/src/app/(app)/chat/call-quality.ts | 2026-11-24 |
| BUG-0037 | Screens show translation keys instead of their words | Dashboard | Fixed, watching | dashboard/apps/web/test/i18n/client-namespaces.test.ts | 2026-11-25 |
| BUG-0038 | Every page of the public domain is shown as "Not secure" although its certificate is valid | Dashboard | Fixed, watching | dashboard/apps/web/src/lib/local-address.ts | 2026-11-25 |
| BUG-0039 | After an update, Polaris desktop says the page's code was changed | Integrity | Fixed, watching | dashboard/packages/core/src/integrity-guard.ts | 2026-11-25 |
| BUG-0040 | After Alt+Space the launcher opens but typing does not go into its search | Desktop | Fixed, watching | dashboard/apps/web/src/components/command-palette.tsx | 2026-11-23 |
| BUG-0041 | The launcher's first open after hours unused is jerky, and its dimmed backdrop behaves oddly | Desktop | Fixed, watching | clients/desktop/src/main/launcher.ts | 2026-11-25 |
| BUG-0042 | A Windows copy on 0.1.52 never updates itself and says to download the new version by hand | Desktop | Fixed, watching | clients/desktop/src/main/updates.ts | 2026-11-25 |
| BUG-0044 | The launcher does not find installed games such as Grand Theft Auto V, by name or by "gta" | Desktop | Fixed, watching | clients/desktop/src/main/launcher-programs.ts | 2026-11-25 |
| BUG-0045 | Typing an address into the launcher or the search panel does not offer to open it | Desktop | Fixed, watching | dashboard/packages/core/src/typed-url.ts | 2026-11-25 |
| BUG-0046 | An installed game disappears from the launcher while its store updates it | Desktop | Fixed, watching | clients/desktop/src/main/launcher-stores.ts | 2026-11-26 |
| BUG-0047 | The live preview's "Open in new tab" opens a window that cannot be moved or resized | Desktop | Fixed, watching | clients/desktop/src/main/windows.ts | 2026-11-26 |
| BUG-0048 | Opening a page from the launcher shows "Application error" and drops the call on screen | Desktop | Fixed, watching | clients/desktop/src/main/page-router.ts | 2026-11-25 |
| BUG-0049 | Polaris desktop does not show the Christmas icon of the winter season | Desktop | Fixed, watching | clients/desktop/src/main/shortcut-icon.ts | 2026-11-26 |
| BUG-0050 | Launcher rows show a generic picture instead of the program's or game's icon | Desktop | Fixed, watching | clients/desktop/src/main/launcher-icons.ts | 2026-11-26 |
| BUG-0051 | Typing in a task while Polaris updates says "The request could not be completed. Try again." | Dashboard | Fixed, watching | dashboard/apps/web/src/lib/offline/try-now.ts | 2026-11-26 |
| BUG-0055 | Server insights report hundreds of MB/s of traffic that never happened | Servers | Fixed, watching | dashboard/apps/web/src/lib/metrics-traffic.ts | 2026-11-26 |
| BUG-0056 | The Stream 100 add-on cannot read the controller through the Hercules software from the app | Device plugins | Fixed, watching | crates/polaris-stream100/src/native/sdk.rs | 2026-11-26 |
| BUG-0057 | The desktop app's header search opens a smaller search than Alt+Space | Desktop | Fixed, watching | dashboard/apps/web/src/lib/search/open-search.ts | 2026-11-26 |
| BUG-0058 | A Polar Code chat stays on "working" after the agent's own turn, and Stop does not end it | Polar | Fixed, watching | dashboard/apps/web/src/lib/agents/acp/session-driver.ts | 2026-11-26 |
| BUG-0059 | Polar's Automatic answers on free models, or not at all, while the person's own providers work | Polar | Fixed, watching | dashboard/apps/web/src/lib/polar/models.ts | 2026-11-25 |
| BUG-0060 | Opening the vault fires a passkey prompt in the browser while handing the page to the desktop app | Vault | Fixed, watching | dashboard/apps/web/src/components/open-in-app.tsx | 2026-11-26 |
| BUG-0061 | Security and system notifications open a page that says nothing about them | Notifications | Fixed, watching | dashboard/packages/core/src/schemas/notifications.ts | 2026-11-26 |
| BUG-0062 | A device plugin's new version stays invisible until the desktop app is restarted | Device plugins | Fixed, watching | clients/desktop/src/main/plugins/manager.ts | 2026-11-26 |
| BUG-0063 | An action the host service is too old for says "update" with no way to do it | Security | Fixed, watching | dashboard/apps/security-scans/src/screens/error-line.tsx | 2026-11-27 |
| BUG-0064 | A Stream 100 knob needs five full turns to go from silent to full, and the screen stays blank without saying why | Device plugins | Fixed, watching | crates/polaris-stream100/src/encoder.rs | 2026-11-27 |
| BUG-0065 | The Stream 100's screen never shows what the plugin sets, even with Polaris' own driver | Device plugins | Fixed, watching | crates/polaris-stream100/src/screen.rs | 2026-11-27 |
| BUG-0066 | A browser never builds a shared search segment, and trusts the ones it reads | Chat | Fixed, watching | dashboard/apps/web/src/lib/chat/e2ee/device-across-tabs.ts | 2026-11-27 |
| BUG-0067 | No dashboard image was published for a day, so no install received an update | Updates | Fixed, watching | dashboard/apps/web/src/lib/polar/usage-report-shape.ts | 2026-11-27 |
| BUG-0068 | A device plugin never updates while another program holds its device, and Update gives no answer | Device plugins | Fixed, watching | clients/desktop/src/main/plugins/updates.ts | 2026-11-27 |
| BUG-0069 | A plugin installed before its driver was a requirement never gets the driver, and its page asks for a manual install | Device plugins | Fixed, watching | clients/desktop/src/main/plugins/requirements.ts | 2026-11-27 |
| BUG-0070 | The Booking.com connector shows a monogram instead of its logo | Polar | Fixed, watching | dashboard/apps/web/src/components/polar/connector-marks.tsx | 2026-11-27 |
| BUG-0071 | Opening a link from the desktop app shows Windows' "cannot access the specified device, path, or file" box | Desktop | Fixed, watching | clients/desktop/src/main/open-external.ts | 2026-11-27 |
| BUG-0072 | Setting up the Stream 100 driver opens a PowerShell window, and the controls are not found after it | Device plugins | Fixed, watching | clients/desktop/src/main/plugins/hercules-driver.ts | 2026-11-27 |
| BUG-0073 | Polar's answer shows control tags such as `<final_answer>` while it streams and once saved | Polar | Fixed, watching | dashboard/apps/web/src/lib/polar/control-tags.ts | 2026-11-27 |
| BUG-0074 | A Chat reply that asks the person a question is sent back by Enigma, and a second, odd answer follows | Polar | Fixed, watching | dashboard/apps/web/src/lib/agents/acp/pipe-commands.ts | 2026-11-28 |
| BUG-0075 | Polaris's update list shows changes that belong to a device plugin with its own update | Updates | Fixed, watching | dashboard/packages/core/src/changelog.ts | 2026-11-28 |
| BUG-0076 | The "Polaris for phones" card on Downloads takes seconds to show its files | Downloads | Fixed, watching | dashboard/packages/ui/src/downloads/account/app-releases.ts | 2026-11-28 |
