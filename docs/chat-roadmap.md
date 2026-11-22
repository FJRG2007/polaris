# Chat — feature roadmap (parity with Fluxer / Stoat / Element / Signal)

What the reference chat platforms have that Polaris Chat does not, with an honest
size against each. Intentionally larger than one work session: pick items
top-down. Keep it updated as things land.

**Status:** ✅ done · 🟡 partial · ⬜ todo
**Priority:** P0 (core) · P1 (high) · P2 (nice-to-have)
**Size:** S (an afternoon) · M (a day or two) · L (a week) · XL (weeks, changes other features)

Reference clones live in `references/repos/` (gitignored): `fluxer` (Discord-like,
Rust + TS), `stoatchat` (formerly Revolt, Rust), `element-web` and `matrix-spec`
(Matrix), `ess-helm` (Element's deployment charts), `platform` (Huly), `meet`,
`jitsi-meet`, `spreed` (Nextcloud Talk, PHP + Vue - the most complete call
client of the set; see section 5).

---

## What Polaris already has

Worth stating, because most of the obvious list is done: spaces, channels, direct
messages, groups, voice channels, threads, replies, reactions, forwarding,
starring, pins, edit history, read receipts, typing and recording indicators,
mutes, per-conversation and per-space notification levels, invites, search,
attachments, voice notes, link previews, rich text with Markdown storage,
mentions, presence, game and Spotify activity status with listen along, privacy
audiences, reports, calls with screen sharing, and per-message moderation.

---

## 1. Identity and automation

| Item                                         | Status | Prio | Size | Notes                                                                                                                                                                                            |
| -------------------------------------------- | ------ | ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Bots**                                     | ⬜     | P0   | L    | See the design below. Default is that a person **cannot** create one.                                                                                                                            |
| Webhooks (post into a channel from outside)  | ⬜     | P1   | M    | Fluxer and Discord both have this. Far cheaper than a bot and covers most "let my server tell me something" uses - a URL with a token that posts as a named sender. Worth doing **before** bots. |
| Applications / OAuth for third-party clients | ⬜     | P2   | L    | Polaris already has connected accounts the other way round.                                                                                                                                      |
| Audit log for a space                        | ⬜     | P1   | M    | Who changed what in a server. Polaris has a generic Activity table already ([[cross-cutting-tables]]) - this is a view over it plus the writes.                                                  |

### Bots — the design

Stoat's model is the one to copy, and it is simple: **a bot is a user with an
owner.** It gets a row in the user table with a `bot: { ownerId }`, so it appears
in rosters, has an avatar and a name, can be messaged, can be added to a space,
and every permission check that already exists applies to it unchanged. No second
identity system, no parallel membership table.

What it needs:

- A `chat.bots` permission. **Not in `CHAT_CAPABILITIES` and not in the `member`
  role**, so granting somebody the chat does not grant them this - an
  administrator ticks the box per role. This is the stated default: people cannot
  create bots.
- A `Bot` row: owner, token, whether anybody may invite it, and a per-owner cap
  on how many (Stoat has one; without it a single account can mint a thousand
  users).
- A bot may not own a bot.
- A token that authenticates as that user for the message API. Polaris already
  has API keys with per-client limits ([[api-key-client-limits]]); the honest
  question is whether a bot token is one of those with a bot principal attached,
  which would save building a second credential path.
- The message send path needs to accept a bot principal and stamp the message
  with it. Everything downstream - rate limits, attachments, moderation, the
  block list - then applies without changes.

Deliberately **not** in the first cut: a gateway for bots to receive events (they
can poll), slash commands, and interactions. Those are what turn a bot feature
into a bot platform, and none of them is needed for "my server posts a message
when a deploy finishes".

---

## 2. Moderation and safety

| Item                                                    | Status | Prio | Size | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ------ | ---- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slowmode per channel                                    | ✅     | P0   | S    | A ladder from off to six hours in channel settings, measured from the last thing each person said. Counted down above the composer on the same arithmetic the server refuses on. Moderators exempt; deleted messages still count; edits never held.                                                                                                                                                                                                                                                            |
| Timeout, kick and ban from a server                     | ✅     | P0   | M    | Right-click somebody in the roster. A timeout is a moment so it ends on its own; a ban is a row checked wherever anybody is let in, with a "kept out" list on the server menu to lift one. A group has no ban - it has no door to stand at.                                                                                                                                                                                                                                                                    |
| Block somebody                                          | ✅     | P0   | M    | An account setting rather than a chat one, so it also stops a friend request and a search result. In either direction nobody can open a conversation, be added to a group, ring a telephone or be reached by `@everyone`; what a blocked account writes is taken and carried nowhere, and folds away where it lands. Set from the menu on anybody's name, lifted from there or from Privacy. Never announced - one sentence for both directions, and nothing that appears only when somebody has been blocked. |
| Mature-content gate on an attachment                    | ⬜     | P2   | M    | Fluxer has `mature_content`; a per-space switch plus a click-to-reveal.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Trusted domains (warn before following an unknown link) | ⬜     | P1   | S    | Fluxer's `trusted_domain`. Polaris already unfurls links, so the domain is known at render time - this is a confirmation step on anything outside a list.                                                                                                                                                                                                                                                                                                                                                      |
| Virus scanning on upload                                | ⬜     | P2   | M    | Stoat runs ClamAV over attachments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Message retention / auto-delete per channel             | ⬜     | P1   | M    | Matrix and Signal both have it. A sweep plus a per-channel window.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

---

## 3. Everyday things people expect

| Item                                            | Status | Prio | Size | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ------ | ---- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mark a conversation unread                      | ✅     | P0   | S    | The one write that moves the read mark backwards, which every other path refuses to do. From the conversation's own menu it leaves the last thing somebody said waiting; from a message it picks up there. The boundary is only ever something the badge would count, so it never marks a conversation unread and then shows nothing in it. Receipts are not retracted - they were read.                                                                                                                                                                              |
| A link to Polaris renders as the thing          | ✅     | P1   | M    | A conversation pasted into a conversation is a `#name`, a voice room is a card with who is in it now and a way in, a message is the message quoted where it was pasted, a task is its chip. The address itself comes out of the sentence wherever the thing is drawn underneath - it said nothing the card does not say better. Resolved per reader on every read, never stamped into the message: who is in a voice room is true for a minute, and a name is the reader's to be allowed or not. Out of reach carries nothing at all - not the name, not the excerpt. |
| Custom emoji per space                          | ✅     | -    | -    | Discord's model: an emoji belongs to one space and works only there. 50 still + 50 animated, uploaded by the owner and administrators on the space's Emoji page; `:name:` in the box, a section in the picker, reactions, jumbo when a message is only emoji. Stored as `<:name:id>`; the server writes any other as its name (`lib/chat/custom-emoji.ts`).                                                                                                                                                                                                           |
| Stickers                                        | ⬜     | P2   | M    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Scheduled messages                              | ⬜     | P2   | M    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Disappearing messages per conversation          | 🟡     | P1   | M    | Done for direct conversations and groups outside spaces (`lib/chat/vanish.ts`, see section 6 row 8); space channels are the retention row in section 2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Documents sent to be seen once                  | ⬜     | P2   | M    | PDFs, spreadsheets, Markdown and anything else Polaris previews, opened once in the phone app's protected viewer like photos, videos, voice notes and text are today. |
| Streamer mode (hide invite codes and addresses) | ⬜     | P2   | S    | Fluxer has it; cheap and genuinely useful on a screen share, which Polaris now does well.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Server discovery (a public directory)           | ⬜     | P2   | M    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Quick switcher                                  | ✅     | P0   | M    | A field above the conversation list, and Ctrl+K anywhere in Chat, opens the dashboard search narrowed to Chat with filters for people, conversations, channels and messages (`lib/search/chat-lookup.ts`). Each kind is bounded the way its own screen is: people are who can be messaged, conversations and channels are the reader's rail, messages go through `searchMessages`. A person opens the conversation with them (`/chat/with/<id>`).                                                                                                                     |
| Resize every panel, and put the layout back     | ✅     | P1   | S    | Every side panel is dragged within its own limits and remembered per runtime (`side-pane.tsx`, `use-chat-pane.ts`). A right-click on the line offers "Reset to default" for that panel and "Reset layout" for all of them; a double press still resets one.                                                                                                                                                                                                                                                                                                           |
| Close a conversation with Escape                | ✅     | P1   | S    | As in WhatsApp: back to the empty screen, a side panel first if one is open, nothing left or deleted. Also "Close chat" on the open conversation's row menu. Anything that takes the key first (a dialog, a menu, the emoji picker, an edit) keeps it (`close-on-escape.ts`).                                                                                                                                                                                                                                                                                         |

---

## 4. End-to-end encryption

**Status: ⬜ · Priority P1 · Size XL.** The full design proposal (protocol, feature by
feature, recovery, phases) is in [chat-e2ee-proposal.md](chat-e2ee-proposal.md). Asked for directly. It deserves its own
section because it is not a feature so much as a different set of rules for
everything else.

Polaris already has the hard part working elsewhere: the Vault is zero-knowledge
and speaks the Bitwarden client protocol, so key derivation, a master key that
never reaches the server, and a recovery path all exist in this codebase already
([[polaris-vault-app]]). That is the foundation, and it is a real head start.

What it would cost, stated plainly, because these are the things that quietly
stop working the day a room becomes encrypted:

- **Search stops.** The server cannot index what it cannot read. Element solves
  this with a local index per device; every message ever sent has to be
  downloaded and indexed on each device that wants to search.
- **Link previews stop**, unless the sending client fetches them and sends the
  card as part of the message - which is what Signal does, and it leaks which
  links you paste to whoever hosts the page.
- **Attachments** need per-file keys and a client-side decrypt before display.
  Every viewer in Polaris - the image viewer, the PDF and spreadsheet editors,
  the audio player - would have to take bytes rather than a URL.
- **Notifications** cannot say what the message was. The server pushing "you have
  a message" is all it can honestly say.
- **Bots and webhooks cannot read an encrypted room** without being given keys,
  which mostly defeats the point of both.
- **Moderation cannot read reported messages.** A report has to carry the
  plaintext the reporter saw, signed, or it carries nothing.
- **Every device needs verifying**, and a lost device without a recovery key
  means lost history. Element's whole "key storage / recovery key / verify with
  emoji" flow exists because there is no way around this.

The sane shape, if it is wanted:

1. Direct messages and groups only at first. A space channel with fifty members
   and a rotating roster is where key management gets genuinely hard.
2. Per-conversation opt-in, off by default, and said plainly on screen - Element
   draws a line in the room when it is not encrypted, and that honesty is the
   feature.
3. Reuse the Vault's key derivation and recovery-key flow rather than inventing a
   second one.
4. Accept that search, previews and bots are off inside an encrypted
   conversation, and say so where somebody turns it on rather than letting them
   discover it.

The alternative worth weighing first: Polaris is self-hosted, so the server is
already the operator's own machine. Encryption at rest plus transport security
gets most of the real-world benefit for a fraction of the cost, and the threat it
does not cover - an operator reading their own users' messages - is a different
argument to have than a technical one.

---

## 5. Calls

Recently done and listed so it is not repeated: quality ladders with an automatic
walk that aims at the top and backs off on encoder evidence, a quality bar per
source, screen shares on a stage rather than in the sharer's own tile, several
shares at once, and walking into a voice channel by opening it.

| Item                                         | Status | Prio | Size | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ------ | ---- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push to talk                                 | ⬜     | P1   | S    | Every voice client has it; Polaris has the key handling already (F9/F10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Per-person volume in a call                  | ✅     | -    | -    | Right-click a tile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Recording a call                             | ✅     | -    | -    | Done in the browser of whoever presses record - no second container. See `call-recorder`, and the honest limits written at the top of it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Combining audio in one room                  | ✅     | -    | -    | Several devices sitting together share one microphone. Detected acoustically; see `call-nearby` and `call-combine`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Raise a hand, react in a call                | ✅     | -    | -    | A hand is a queue, drawn above the faces with who is next and a way for the chair to lower one; a raised hand also plays a quiet sound to whoever is chairing. Reactions are the emoji menu on a tile. See `call-hands-panel` and `call-signals`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A DM share arrives as a card, not taken over | ✅     | -    | -    | Direct messages only - a room or channel call still opens a share straight away, because it has the room to spare. Arrives as a card beside the faces; one press opens it, and watching sits the stream to the left of the people rather than above them, with the faces kept in a narrow column beside it (a row under it on a phone) instead of taken over. Never offered back to whoever just pressed Share. See `call-room.tsx`, `call-media.ts`. Discord's fullscreen-with-people-underneath is not this - that is fullscreen on the call rather than on the tile, and is a separate change.                                                                                                                                                                                      |
| A stream's own volume, mute and pop-out      | ✅     | -    | -    | Right-click a stream once it is being watched: its volume and mute, per sharer and per browser, kept apart from that person's voice volume so turning a film down is not turning the friend down; a floating window that keeps playing while another conversation is read; and how far it lowers everybody's voices while it plays, a voice setting defaulted to 30%. Its sound plays only while watched, on the stage or popped out. See `call-menus.tsx`, `call-stream-audio.ts`, `voice-settings.ts`.                                                                                                                                                                                                                                                                               |
| Backgrounds in a call                        | ✅     | -    | -    | Blur, blurred heavily, one of nine pictures Polaris ships, or one of your own. Set from the call's camera menu or from Voice & Video, where the preview draws it for real. The model is staged by the build and fetched the first time somebody turns one on; a picture of your own never leaves the browser it was chosen in. See `camera-filter` and `camera-background`.                                                                                                                                                                 |
| Watch together / streams                     | ⬜     | P2   | L    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Seeing a call without joining it             | ✅     | -    | -    | A call in a direct message used to be one line of text above the messages - the only sign anything was happening on a call of five. Now it draws the same faces the call itself would, at the same size, so joining does not resize anybody; nothing of the call reaches the browser, only the seats Polaris already keeps (no video, no sound, nobody in the call told anybody is looking). Can be put away to the one line, which is also the way back - remembered per browser and per call, since a screen's own state came back on the next conversation or a reload. The voice room's own roster lists rather than lines up, reusing the row Tasks' assignee picker and the members column use. See `call-preview.tsx`, `call-hidden.ts`, `CallRosterList` in `call-roster.tsx`. |

### What Nextcloud Talk (spreed) has that Polaris does not

Read from the clone in `references/repos/spreed`. It is the most complete call
client of the references, and most of what is worth taking is small - the
interesting part is that almost none of it is about media plumbing, which
Polaris already has through the call server. It is about telling people what is
happening.

**Worth doing, cheapest first:**

| Item                                    | Prio | Size | Where it is in spreed                                      | Why                                                                                                                                                                                                           |
| --------------------------------------- | ---- | ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "You seem to be talking while muted"    | P0   | S    | `utils/webrtc/SpeakingWhileMutedWarner.js`                 | Three seconds of speech into a dead microphone, then a warning - and a browser notification when the tab is not on screen. Polaris measures speaking already; this is the single highest value per line here. |
| Keep the screen awake in a call         | P1   | S    | `components/CallView/useWakeLock.ts`                       | Ten lines of `navigator.wakeLock`. A laptop that sleeps mid-call is a call that ends.                                                                                                                         |
| A device that changes mid-call          | P0   | M    | `composables/useDevices.js`, `MediaDevicesManager.js`      | A headset unplugged mid-call: spreed follows the change and reopens. Polaris listens for `devicechange` in the composer and the clip dialog, and **not in a call** - the call goes silent with nothing said.  |
| Connection warnings that say what to do | P1   | M    | `utils/webrtc/analyzers/PeerConnectionAnalyzer.js`         | 30% loss over 5s, under 10 packets a second, or RTT over 1.5s, and it says "turn your video off" rather than "poor connection". Polaris reads encoder evidence already; this is the sentence, not the metric. |
| Check the devices before joining        | P1   | M    | `components/MediaSettings/`, `MediaDevicesSpeakerTest.vue` | A preview, a level meter and a speaker test before the call starts. Polaris opens the devices as the room opens, so a broken microphone is found by the other person.                                         |
| ~~Background blur~~ ✅                   | -    | -    | `utils/media/effects/virtual-background/`                  | Done. MediaPipe selfie segmentation, staged out of the installed package into `public/video` by the build and fetched only when somebody turns it on. Blur, heavy blur, or a picture of their own that never leaves the browser. See `camera-filter` and `camera-background`. |
| Picture-in-picture call window          | P2   | M    | `mainFloatingCall.ts`, `ViewerOverlayCallView.vue`         | Polaris shrinks a call to a bar; spreed keeps the faces in a floating window, which is what people want while reading the document being discussed.                                                           |

**Deliberately not taken:**

- **Quality by head count** (`SentVideoQualityThrottler.js`): thresholds at 20, 80
  and 120 video streams, with anybody speaking pushed to the top rung for five
  seconds after they stop. Polaris caps a call at 8, so the thresholds are dead
  code here - but the _speaker gets the best rung_ rule is the good idea in it,
  and it is what to copy if the cap is ever raised.
- **Grid pagination and tile ordering** (`CallView/Grid/`): the same story. It is
  what a call of forty needs, and Polaris is a lookup of column classes because
  eight is the ceiling.
- **Live transcription** (`stores/liveTranscription.ts`): needs a speech service
  behind it, which is a container an operator would have to run.
- **Breakout rooms**, **SIP dial-in**: both are large, and both are features of an
  organisation running scheduled meetings rather than of a chat with calls in it.
- **Server-side recording** (`docs/recording.md`): a headless browser joins the
  call, records it, and uploads through a chunked public WebDAV share. It is the
  right answer for an installation with an operator, and the wrong one here - see
  the note at the top of `call-recorder`.

**Still open from what spreed does and Polaris does not:** recording _consent_.
Spreed can require every participant to tick a box before joining a call that may
be recorded, and refuses the join without it (`recordingConsent` on the join
endpoint). Polaris tells the room a recording is running, on every screen and to
anybody who joins afterwards, but it does not gate the join on agreement. That is
a policy decision an administrator should own, and it wants a setting rather than
a default.

---

## 6. WhatsApp privacy and security parity (ledger, 2026-11-21)

Every user-facing privacy, security and restriction feature WhatsApp ships as of
late 2026, checked against this repository. This section builds nothing; it is
the list to assign from.

Polaris is read for who will run it: intelligence services, governments,
militaries, hospitals and large companies. So each row also states the
**security bar** the feature has to meet (a control a breached server or an
administrator can walk through is not the feature) and the **policy** an
organization or instance administrator needs over it (enforce, forbid, default).
Where WhatsApp leans on a phone number, Polaris adapts it to the account handle
and email. Where WhatsApp leans on the phone OS (screenshot blocking), the web
client cannot do it at all and the row says so.

**Status:** Present (evidence given) · Partial (what is missing) · Missing ·
E2EE plan (covered by a section of [chat-e2ee-proposal.md](chat-e2ee-proposal.md)) · N/A (no Polaris equivalent to protect)

Note: the "Disappearing messages per conversation" row in section 3 was marked
todo; it exists for direct conversations (row 8 below) and is now marked partial.
Only space channels lack it, which is the retention row in section 2.

### 6.1 Locking and hiding

| # | Feature | WhatsApp | Polaris status and evidence | What to build (security bar · admin policy) | Size |
| --- | --- | --- | --- | --- | --- |
| 1 | Chat Lock, locked-chats folder, secret code, hide locked chats | Lock a chat behind device auth or a separate secret code; locked chats go to a folder that can be hidden entirely and revealed by typing the code in search [1][2] | **Partial; reveal-by-code done (2026-11-21).** "Hide the Locked chats entry too" (`ChatLock.hideEntry`, default off, needs a code of known length) removes the entry; typing the code into Chat search proves it through `openLockedChatsAction` (a POST, counted against the same 8-per-15-min guesses) and opens the shelf (`chat/lock-reveal.ts`, `components/command-palette.tsx`). A number no longer than the code is never sent as a search, so neither the code nor a prefix of it reaches an address or a log. **Under E2EE:** the code (or a passkey PRF / platform biometric key) derives a wrapping key on the device with a memory-hard KDF; the conversation keys of locked chats are kept in the local key cache only wrapped by it, so without the code a device holds ciphertext it cannot open and a server breach yields nothing; the server-side check stays only as the throttle. Still missing: biometric and passkey unlock. Before: Lock, own code (scrypt, throttled), text-free notifications, "hide locked" and a signed per-tab unlock proof exist: `lib/chat/chat-lock.ts` (header, `hideLocked` l.85), `chat/lock-dialogs.tsx`, `lib/chat/lock-timing.ts`. Missing: hidden locked chats are reached through the "Locked chats" shelf (`chat/chat-sidebar.tsx` l.677), and no reveal-by-typing-the-code in search was found; no biometric or passkey unlock in the phone and desktop apps | Reveal-by-code in the search field with no visible entry when hidden; biometric (Android BiometricPrompt, iOS LocalAuthentication) and WebAuthn user verification as alternatives to the code. **Bar:** today the code is checked by the server, so a database breach or an administrator can bypass it; with E2EE the code (or a biometric-bound key) must wrap the conversation's local key cache on the device, so a server breach yields nothing. **Policy:** org may require chat lock on chosen spaces; default off | M |
| 2 | App lock | Biometric or PIN to open the app [14] | **Partial (not built in the 2026-11-21 pass).** The phone apps now blank their app-switcher snapshot on iOS while a protected screen is open (row 36); biometric/passkey unlock, idle auto-lock and the org policy remain. Per-app PIN locks, unlocks kept per browser session: `lib/app-lock-service.ts`, `app/(app)/app-lock/`. Biometric exists only for the Vault on Android (`mobile/android/app/src/main/java/app/polaris/mobile/VaultAuthActivity.java`) | Biometric or passkey unlock for app locks on web (WebAuthn UV), Android and iOS; auto-lock after idle; blank the task-switcher snapshot in the phone apps. **Policy:** org "require Chat lock, max idle N min" | M |

### 6.2 Advanced Chat Privacy and media

| # | Feature | WhatsApp | Polaris status and evidence | What to build (security bar · admin policy) | Size |
| --- | --- | --- | --- | --- | --- |
| 3 | Advanced Chat Privacy (per chat) | Any member turns it on: nobody can export the chat, media is not auto-saved to phones, and messages cannot be used with Meta AI [3] | **Partial (built 2026-11-21).** `ChatChannel.advancedPrivacy` (`lib/chat/advanced-privacy.ts`): any member of a direct message or group, or a space channel's administrators, switch it, with a notice line. Server-enforced: Polar and `/polar` answer without the history or the replied-to message, the attachment route refuses `?download=1`, forwarding out of it is refused and not offered, and the file, audio and video downloads are hidden. Still missing: the org default and forced-on policy, and an export check once chat export exists. Was: **Missing.** No per-conversation switch. Polar reads the conversation's recent history when mentioned (`lib/chat/polar-mention.ts` ~l.297-301); attachments can be downloaded and saved (`chat/media-download.ts`); forwarding is only a per-author audience (`UserPrivacy.forwarding`). There is no chat export today, so nothing to block there yet | `ChatChannel.advancedPrivacy`, toggled by any member, with a notice line. Enforced server-side: `@polar`, app commands and any summary refuse to read the history; download and save-to-Drive routes refuse; forward is hidden and refused; any future export checks it. **Bar:** server-enforced now; under E2EE it becomes client-enforced, so it must be described as binding honest clients only, attestable on verified apps (E2EE plan 4.7). **Policy:** org default on, or forced on and locked for classified orgs | M |
| 4 | Disable link previews | Per-account switch; also forced by Strict Account Settings [7] | **Done (2026-11-21).** Three switches, all on by default: instance (/admin/privacy, `chat.linkPreviews`), conversation (chat menu, `ChatChannel.linkPreviews`, same permission as its other rules) and author (account privacy, `UserPrivacy.linkPreviews`); off means no fetch, no card and no embedded player (`lib/chat/link-preview-policy.ts`, enforced in `unfurlLater`, `linkPreviewFor` and `decorateMessages`). Was partial: Previews are fetched by the server under a policy (`lib/link-preview/policy.ts`) and links are reputation-checked (`lib/chat/link-safety.ts`); no switch stops them | Per-user "no previews for what I send" and per-conversation off. **Bar:** the E2EE plan (section 5) fetches previews through the server, which learns every URL; an org must be able to turn that off. **Policy:** org forbid or allow; default on | S |
| 5 | Media auto-download | Choose which media downloads automatically per network; ACP stops auto-saving [3] | **Done (2026-11-22).** Account > Privacy "Pictures that load on their own in Chat" (`UserPrivacy.chatAutoDownload`: from everyone, from friends and colleagues, from nobody) over the instance's choice in Chat admin settings > Moderation policy (`autoDownload`, default everyone, which is how Chat behaved before). Resolved per page of messages (`lib/chat/auto-download.ts`, `autoLoad` on the message view); a held picture shows its blur, type and size behind a Load button and fetches nothing until pressed, and a held video drops its still. Videos, recordings and documents already wait for play or open, so one choice covers what loads. Per network (Wi-Fi or cellular) in the phone apps is not built. Was: **Missing.** Media loads as soon as a message renders; no setting found | Per-user policy per media kind (and Wi-Fi or cellular in the phone apps): a click-to-load placeholder with size and type. **Policy:** org default (for example "never auto-load from people outside the org") | M |

### 6.3 Ephemeral content

| # | Feature | WhatsApp | Polaris status and evidence | What to build (security bar · admin policy) | Size |
| --- | --- | --- | --- | --- | --- |
| 6 | View once (photo, video, voice) and its screenshot block | Opened once, cannot be forwarded, saved or screenshotted; voice notes since Dec 2023 [15] | **Partial (not built in the 2026-11-21 pass:** an iOS viewer needs a Secure Enclave device key registered through `lib/mobile/device-proof.ts` and a native signed fetch, verifiable only on a device; the desktop window needs the same device proof; the org switch and the moderator hand-off were left to their own change). Server-enforced: bytes refused to everything but the Android app, which signs a fresh challenge with a keystore key; the open is recorded before streaming; reader name and time watermarked: `lib/chat/view-once.ts`, `chat/view-once-card.tsx`, `chat/view-once-menu.tsx`, `UserPrivacy.viewOnceWatermark`; `ViewOnceActivity.java` l.68 sets `FLAG_SECURE`. Missing: the iOS app has no protected viewer (nothing under `mobile/ios/Polaris`), so iPhone readers cannot open one; the desktop app has `setContentProtection` but uses it only on call overlays (`desktop/src/main/windows.ts` l.291). Web: screenshot blocking is impossible, and refusing the bytes there is correct | iOS viewer that blanks while `UIScreen.isCaptured` and records screenshots; desktop protected viewer window. A report must be able to hand a view-once item to moderators, as WhatsApp's does. **Bar:** today the server holds the plaintext; under E2EE a per-message key is released once and deleted server-side, with the device attestation kept. **Policy:** org allow or forbid view once (it conflicts with record-keeping duties); watermark forced on | L |
| 7 | Documents view once | - | Already listed in section 3 ("Documents sent to be seen once") | See section 3 | M |
| 8 | Disappearing messages and default timer | Per-chat timer 24 h / 7 d / 90 d, a default for new chats, group admins can restrict who changes it [16] | **Present** for direct conversations and groups outside spaces: `lib/chat/vanish.ts`, `lib/chat/vanish-rules.ts` l.21 (off, 24 h, 7 d, 30 d, 90 d), `app/api/cron/chat-disappearing`, default timer `UserPrivacy.chatVanishAfter` with `account/privacy/chat-timer-card.tsx`, instance mode in `admin/apps/[appId]/settings/_chat/direct-rules-view.tsx`. Space channels: retention row in section 2 | Space channel retention (section 2). **Bar:** under E2EE every client deletes its local copy and the server deletes the ciphertext; notification previews must not outlive the message. **Policy:** org minimum and maximum timer, legal hold override (E2EE plan section 9) | - |
| 9 | Keep in chat | A recipient keeps a disappearing message; the sender is told and can undo; the sender can forbid it; group admins can restrict it [4] | **Done (2026-11-21).** "Keep in chat" in the message menu (`lib/chat/keep.ts`, `ChatMessageKeep`): a kept message has its `expiresAt` cleared and the old expiry parked in `ChatMessage.keptExpiresAt`, so every reader and the sweep skip it with no other change; the last keep removed puts the timer back. A notice line says who kept or unkept; the author can "Unkeep for everybody" and "Do not allow keeping" (`ChatMessage.keepable`); a group owner's "Let anybody keep messages" (`ChatChannel.membersMayKeep`); the instance policy can forbid keeping everywhere (`lib/chat/moderation-policy.ts`). Still missing: a "Kept" list beside the saved view, and org legal hold (none exists yet). Was: **Missing.** The expiry sweep has no exception (`lib/chat/vanish.ts`) | `ChatMessageKeep` row, sender notice with undo, per-message "cannot be kept", group owner-only option, a "Kept" view beside `chat/saved/saved-view.tsx`; the sweep skips kept rows. **Policy:** org legal hold supersedes; org may forbid keeping | M |

### 6.4 Calls

| # | Feature | WhatsApp | Polaris status and evidence | What to build (security bar · admin policy) | Size |
| --- | --- | --- | --- | --- | --- |
| 10 | Silence unknown callers | Calls from unknown numbers do not ring but appear in the call list [5] | **Done (2026-11-21).** A refused one-to-one call leaves a "called - silenced" line in the conversation, one per caller and conversation per 10 minutes (`lib/chat/missed-call.ts` `silencedCallDue`, `chat/meeting-actions.ts` `startCallAction`). Was: Who may ring is an audience, friends and colleagues by default (`lib/privacy-service.ts` `mayRing` l.214, field `calls`); a refused call is refused, not silenced and listed | A "silenced" outcome: no ring, an entry in missed calls marked silenced (`lib/chat/missed-call.ts`), so a legitimate caller is not lost. **Policy:** org default audience | S |
| 11 | Protect IP address in calls | Relays calls through WhatsApp servers so the other side never learns your IP [6] | **Present by architecture.** Calls go through the SFU (`chat/use-sfu-call.ts`); there is no peer-to-peer `RTCPeerConnection` in the chat code, so participants never see each other's addresses (the server does) | Nothing for parity. For high-risk deployments: a TURN-over-TLS-only option so a network observer cannot tell a call from web traffic. **Policy:** org "relay only" | - |

### 6.5 Who sees and reaches me

| # | Feature | WhatsApp | Polaris status and evidence | What to build (security bar · admin policy) | Size |
| --- | --- | --- | --- | --- | --- |
| 12 | Privacy Checkup | Guided walk through the privacy and security settings [5] | **Done (2026-11-21).** /account/privacy/checkup: one step per `PRIVACY_SECTIONS` group with `RECOMMENDED_PRIVACY` beside each row and "Use recommended", saved through `savePrivacyAction`, locked fields shown and not offered, then a security step (two-step verification, passkeys, sessions). **Not done:** an org requiring it at first sign-in. Was missing: No guided flow | One page that walks `PRIVACY_SECTIONS` and the security card (2FA, passkeys, sessions) with a recommended preset per step, reusing `account/privacy/privacy-view.tsx`. **Policy:** org may require it at first sign-in | M |
| 13 | Last seen, online, profile photo, about, incl. "my contacts except" | Per-field audiences incl. "My contacts except..." and "Nobody"; hiding yours hides others' from you [14] | **Done (2026-11-21): locks.** An administrator locks any field to its default on /admin/privacy (`privacy.locks.<field>`, `lib/privacy-service.ts` `setPrivacyLock`); a lock overrides the stored choice everywhere it is resolved and `setPrivacy` ignores writes to it. Was present: `packages/core/src/schemas/privacy.ts` l.44 audiences (`everyoneExcept`, `friendsExcept`, `only`, `nobody`, ...), l.192 fields (`lastSeen`, `lastActive`, `avatar`, `photoFullSize`, `profile`, `typing`, `activity`); reciprocity in `lib/presence-service.ts` l.94; administrator defaults in `lib/privacy-service.ts` l.51 | **Policy:** org may lock a field (for example force `lastSeen` to colleagues); today the administrator sets defaults only | S |
| 14 | Read receipts | Off per account, reciprocal [14] | **Present.** `readReceipts` field; per-group switch with reciprocity in `lib/chat/group-receipts.ts` l.79; `chat/chat-privacy-section.tsx` | Under E2EE receipts shrink to "last read" (E2EE plan 2.2) | - |
| 15 | Status privacy | Audience for status updates [14] | **N/A.** Polaris has no stories; activity status has its own audience (`activity`) | If stories are built, they take an audience from day one | - |
| 16 | Who can add me to groups | Everyone / My contacts / except; a refused add becomes a private invite [14] | **Done (2026-11-21).** Privacy field `groupAdds` (default friends + colleagues = the old rule) enforced in `group-reach.ts` `groupAddable` and the group picker. Adding someone it refuses to an existing group sends an invitation instead (`ChatGroupInvite`, `lib/chat/group-invites.ts`, /chat/invites, notification `chat.groupInvite`); accepting re-checks the group, the inviter and blocks; a decline holds for 30 days. Starting a new group with such a person is still refused, with a sentence saying to add them afterwards. Was partial: A fixed rule: only friends and colleagues may add somebody (`lib/chat/group-reach.ts` l.47-50); not the person's choice, and a refused add is only refused | Privacy field `groupAdds` with the usual audiences and the current rule as default; a refused add sends a one-to-one invitation to join instead. **Policy:** org default | S |
| 17 | Who can message me / unknown senders | Strict Account Settings blocks high-volume messages from unknown accounts; usernames add an optional key [7][8] | **Done (2026-11-21).** Privacy field `messages` (default everybody = the old rule; lockable and with an admin default like every field). A new one-to-one from somebody it leaves out (colleagues count as friends) opens as a request: the recipient's member row carries `requestedAt` and is muted, so it is off the rail, rings nothing, counts toward no badge and sends no read receipt (`markRead`/`markChannelsRead` skip it). /chat/requests (`lib/chat/message-requests.ts`) lists them with a preview and a count; Accept, Delete (leaves and frees the one-to-one key) or Block. Replying accepts. Existing conversations are untouched. **Not done:** Report on a request waits for the moderation rows; the org-wide policy is the field's admin default + lock (e.g. friends, where colleagues count as friends) rather than a separate switch | Privacy field `messages` (audience) and a message-requests inbox for senders outside it: first message held, no read receipt, accept, block or report. **Policy:** org "senders from outside the org land in requests" | M |
| 18 | Usernames, hidden phone number, username key | Usernames hide the phone number; an optional key a stranger must also know before messaging (2026) [8] | **Present** for the handle and hidden identifiers: `account/username-field.tsx`; `UserPrivacy.email` and `phone` default to nobody, `findByEmail`, `findByPhone`, `discoverable`. **Missing:** the key | Optional "contact key" asked when a stranger finds the handle and starts a conversation (pairs with 17). **Bar:** compared server-side in constant time and throttled | S |
| 19 | Message yourself | A chat with yourself, synced to your devices [14] | **Done (2026-11-21).** "Message yourself" in the chat rail opens a one-member conversation keyed to you alone (`directAllowed` accepts a list naming only yourself; `openDirect`; `ChatChannelView.self`), pinned above the other conversations, with the full composer. **Not done:** the E2EE form (a one-member group across your devices) waits on section 4. Was missing: `directAllowed` refuses an empty list (`lib/chat/chat-service.ts` l.1974, `pickSomebodyToMessage`); starred messages exist (`chat/saved/saved-view.tsx`) | A self conversation pinned at the top, with files, voice notes and the full composer. **Bar:** under E2EE it is a one-member group across your own devices | S |

### 6.6 Groups and communities

| # | Feature | WhatsApp | Polaris status and evidence | What to build (security bar · admin policy) | Size |
| --- | --- | --- | --- | --- | --- |
| 20 | Approve new participants | Joining through a link waits for an admin [13] | **Missing.** A space invite admits whoever holds the code (`lib/chat/invites.ts` header) | Per-space "require approval": a pending queue for owners and administrators with accept and reject, and a notice to them. **Policy:** org forces approval on org spaces | M |
| 21 | Only admins send / edit info / add members | Group settings restrict sending, editing info and adding members to admins [14] | **Done (2026-11-21).** `ChatChannel.membersMaySend`: a group owner's "Let anybody send messages" and a space channel's "Announcement channel" switch; `sendClosed()` in `lib/chat/access.ts` is asked by `requirePostable` and by the composer; reactions and poll votes stay open. Was: **Partial.** Groups have `membersMayEdit`, `membersMayInvite`, `membersMayMention` (`packages/db/prisma/schema.prisma` l.10604-10608, `setGroupOptions` in `chat-service.ts` l.1464). No "only admins may send" on groups and no read-only announcement channel in spaces (`mayPost` reflects only a timeout, `lib/chat/access.ts` l.405) | `membersMaySend` on groups; an announcement flag on space channels, enforced on the send path and drawn in the composer | M |

### 6.7 Safety and abuse

| # | Feature | WhatsApp | Polaris status and evidence | What to build (security bar · admin policy) | Size |
| --- | --- | --- | --- | --- | --- |
| 22 | Block | Stops messages and calls [11] | **Present** (section 2) | - | - |
| 23 | Report, with the last five messages | A report sends the last five messages from that person or group; report then block [11] | **Done (2026-11-21) for today's server-read chat.** "Report conversation" in the conversation menu (`ChatReport.kind = "conversation"`) and "Report" on a member from a conversation (`SafetyCase.context`) carry the last five messages the reporter can read (`lib/chat/report-context.ts`: their history floor, no one-reader messages, nothing from a conversation they cannot reach), copied at report time and shown only in the admin queues. Message franking under E2EE is still the E2EE plan's. Was: **Partial.** Per-message reports with excerpt and files (`ChatReport` model, `lib/chat/reports.ts`), block offered afterwards (`components/block-after-report.tsx`). No report of a person or a conversation carrying recent context | "Report conversation" and "Report person" attaching the last N messages the reporter can see. **Bar:** under E2EE a report must carry signed plaintext (message franking) or it proves nothing (E2EE plan section 6) | M |
| 24 | Account restriction for spam | Many blocks or reports restrict starting new chats, creating groups, adding members and linking devices for a while; existing chats keep working; a countdown is shown [12] | **Partial (built 2026-11-21, on by default).** `lib/chat/spam-restriction.ts`: an account blocked or reported by N different people within D days (reports a moderator kept or dismissed do not count) cannot open a new one-to-one, create a group, or add people to a channel or space for H hours after the latest; existing conversations keep working, and the standing page shows it with its end time. Owner decision (2026-11-21): on for every install, existing ones included, at N=5, D=7, H=24; administrators change or switch it off in Chat admin settings > Moderation policy (`lib/chat/moderation-policy.ts`). Device linking (2026-11-22): approving a QR sign-in for another device is refused while restricted (`lib/qr-sign-in-service.ts`); signing in there with the password is untouched. Exemptions (2026-11-22): inside an organization, its owner and administrators (a grant the organization made) are exempt, and a member adding only fellow members reaches nobody new (`exemptFromRestriction`). Not built: a per-account exemption an instance administrator grants by hand. Was: **Partial.** Per-conversation spam limits (`lib/chat/spam-guard.ts`), account standing (`lib/account-standing-service.ts`, `account/standing/`). No automatic, time-limited restriction driven by blocks and reports | Automatic restriction with a visible end time and reason on the standing page; it reaches only new contacts, groups and device links. **Policy:** org thresholds; exemptions only by explicit grant | M |
| 25 | Strict Account Settings (Jan 2026) | One switch that locks the account to its most restrictive settings: two-step verification and security notifications on, link previews off, unknown high-volume messages blocked, group adds limited, last seen/photo/about to contacts; changeable only from the primary device [7] | **Partial.** Lockdown exists as an emergency stop, not a hardening preset (`account/security/lockdown-card.tsx`); security alerts already cannot be muted (`lib/notifications/security-events.ts`) | "Strict mode" that applies rows 4, 13, 16, 17 and the view-once watermark, requires a second factor, and turns off only with step-up from an existing trusted device. **Policy:** org enforces it for chosen members | M |
| 26 | Parent-managed accounts | A parent manages a teen's account [17] | **N/A (adapted).** Organizations already manage their members' access; no minor-specific mode | - | - |

### 6.8 Account security

| # | Feature | WhatsApp | Polaris status and evidence | What to build (security bar · admin policy) | Size |
| --- | --- | --- | --- | --- | --- |
| 27 | Two-step verification (now alphanumeric) | PIN or password when the account is registered again [9] | **Present.** `account/security/two-factor-methods-card.tsx`, `pin-dialogs.tsx`, `backup-codes-card.tsx` | **Policy:** org "require 2FA" (confirm it covers Chat sessions) | - |
| 28 | Passkeys (several) | Passkey sign-in, more than one per account [9] | **Present.** `account/security/passkeys-card.tsx`, `auto-passkey-card.tsx` | - | - |
| 29 | Email verification | A verified email to recover the account [18] | **Present.** `account/emails-view.tsx` (the email is the account identity) | - | - |
| 30 | Linked devices and new-device notices | List and remove linked devices; notice when one is added [14] | **Present.** `account/sessions/sessions-view.tsx`, `trusted-devices-card.tsx`, `account/devices/`; alerts in `lib/notifications/security-events.ts` | Under E2EE a new device is a key event shown in every conversation (E2EE plan section 9) | - |
| 31 | Account Protect / device verification | Moving the account to a new phone needs approval on the old one [10] | **Present (audited 2026-11-21).** Account > Security "require approval": a new session starts `pending` and waits on `/oauth/pending` until an existing approved, fully signed-in session allows it (`lib/session-guard.ts` `createSessionState` l.~530, `settings.requireLoginApproval`); skipped when an authenticator is armed (that sign-in already answered a challenge) or when no approver exists. **Policy done (2026-11-21):** Management > Security "Approve new sign-ins from an open session" (`InstanceSecurityPolicy.requireLoginApproval`, default off) holds every account with a quick unlock PIN, authenticator or not (`lib/login-approval.ts`); an account without a PIN is not held, since allowing a sign-in asks for it. Per-organization scoping would follow the instance policy if orgs gain security policies. New-device grace (`lib/device-grace.ts`), QR sign-in (`lib/qr-sign-in-service.ts`), session binding (`account/security/session-binding-card.tsx`) | Confirm a new device's first sign-in can require approval from an existing trusted device. **Policy:** org forces it | S |

### 6.9 Encryption

| # | Feature | WhatsApp | Polaris status and evidence | What to build (security bar · admin policy) | Size |
| --- | --- | --- | --- | --- | --- |
| 32 | End-to-end encryption of messages and calls | On for every chat and call | **E2EE plan** (whole proposal; phases in section 14) | - | XL |
| 33 | End-to-end encrypted backups (password, 64-digit key, passkey; HSM key vault) | Backups encrypted with a key Meta cannot read; passkey option since late 2025; HSM vault hardened in 2026 [19][20] | **E2EE plan** sections 3.2 and 3.5 (account key closures, organization recovery) | Make a passkey (PRF) one of the 3.2 closures | - |
| 34 | Security code verification and "security code changed" notices | Compare a QR or 60-digit number; optional notice in the chat when a contact's key changes [10] | **E2EE plan (done 2026-11-21):** section 4.6 now has optional 60-digit/QR verification per pair, key-change notices and the org policy. Before: Section 4.6 verifies automatically through key transparency, and requirement 1 drops manual verification | Add to the plan: optional manual verification (QR or number) and per-conversation key-change notices, which high-risk users expect even with transparency. **Policy:** org forces key-change notices on | M |
| 35 | Key transparency (auditable key directory) | Append-only directory that clients check automatically [21] | **E2EE plan** section 4.6 | - | - |
| 36 | Screenshot block on profile photos | Profile photos cannot be screenshotted on Android [14] | **Done (2026-11-21).** While a full-size photo is open (`components/avatar.tsx`) the page asks `protectScreen` (`lib/mobile-bridge.ts`): Android sets `FLAG_SECURE` on the page window (`MainActivity.protectScreen`), iOS covers the page while the screen is recorded or mirrored and in the app-switcher snapshot (`WebViewController.swift`); iOS lets no app refuse a still screenshot. Older apps lack the method and simply open the photo; the web says nothing. Before: `photoFullSize` decides who may open a photo full size; nothing protects the open view | Android and iOS: a protected window while a full-size photo is open. Web: impossible, and the screen says nothing it cannot keep | S |

### Sources

1. WhatsApp FAQ, Turn chat lock on or off - https://whatsapp.com/faq/en/android/28000010
2. WhatsApp blog, Introducing secret code for chat lock - https://blog.whatsapp.com/introducing-secret-code-for-chat-lock
3. WhatsApp blog, Introducing Advanced Chat Privacy - https://blog.whatsapp.com/introducing-advanced-chat-privacy ; EFF analysis - https://www.eff.org/deeplinks/2025/09/what-whatsapps-advanced-chat-privacy-really-does
4. WhatsApp blog, Keep in chat - https://blog.whatsapp.com/keep-in-chat-your-new-sender-superpower
5. WhatsApp blog, Silence unknown callers and Privacy Checkup - https://blog.whatsapp.com/new-privacy-features-silence-unknown-callers-and-privacy-checkup
6. Meta engineering, WhatsApp calls: enhancing security (Protect IP address) - https://engineering.fb.com/2023/11/08/security/whatsapp-calls-enhancing-security/
7. WhatsApp blog, Strict Account Settings (2026-01-27) - https://blog.whatsapp.com/whatsapps-latest-privacy-protection-strict-account-settings ; what it changes, per MacRumors - https://www.macrumors.com/2026/01/28/whatsapp-launches-strict-account-settings/
8. Usernames and username key (reservations from 2026-06-29; secondary sources, the official post was not retrievable) - https://thenextweb.com/news/whatsapp-usernames-reserve-phone-number-privacy ; https://www.techrepublic.com/article/news-whatsapp-usernames-phone-number-privacy/
9. WhatsApp blog, One billion people protected with passkeys (multiple passkeys, alphanumeric two-step verification) - https://blog.whatsapp.com/one-billion-people-are-now-protected-with-passkeys-on-whatsapp-plus-more-account-security-features
10. WhatsApp blog, Account Protect, Device Verification, Automatic Security Codes - https://blog.whatsapp.com/new-security-features-account-protect-device-verification-automatic-security-codes
11. WhatsApp FAQ, How to block and report someone - https://faq.whatsapp.com/1142481766359885/
12. WhatsApp FAQ, About restricted accounts - https://faq.whatsapp.com/717472490411581/
13. Approve new participants (secondary source) - https://beebom.com/how-approve-new-participants-whatsapp-groups
14. WhatsApp FAQ, How to change your privacy settings - https://faq.whatsapp.com/3307102709559968/
15. WhatsApp blog, Voice messages just got more private (view once voice) - https://blog.whatsapp.com/voice-messages-just-got-more-private
16. WhatsApp blog, Default disappearing messages and multiple durations - https://blog.whatsapp.com/more-control-and-privacy-with-default-disappearing-messages-and-multiple-durations
17. WhatsApp FAQ, Block and report on parent-managed accounts - https://faq.whatsapp.com/1561915401728939/
18. Email verification (beta report; current rollout not confirmed) - https://www.phonearena.com/news/whatsapps-email-verification-feature-expanded-beta-release_id152300
19. Meta, Making it easier to encrypt WhatsApp chat backups (passkeys) - https://about.fb.com/news/2025/10/making-it-easier-to-encrypt-whatsapp-chat-backups/
20. Meta engineering, Strengthening end-to-end encrypted backups (HSM Backup Key Vault) - https://engineering.fb.com/2026/05/01/security/meta-strengthening-end-to-end-encrypted-backups/
21. Meta engineering, WhatsApp key transparency - https://engineering.fb.com/2023/04/13/security/whatsapp-key-transparency/

Not verified against an official page: the exact format of WhatsApp's username
key (reports disagree), and whether hidden locked chats stay hidden on linked
devices.

## 7. Discord channel types parity (ledger, 2026-11-22)

What Discord's Create Channel dialog offers in a server, and what Polaris has in a space. Discord's own list of channel types: text, voice, category, announcement, stage, forum and media, plus threads inside them and direct/group messages outside servers [D1]. User features only.

| # | Discord | How it behaves there | Polaris | Missing | Plan | Size |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Create Channel dialog | Type picked from cards (icon, name, one line), name field with the type's icon, Private switch [D2] | **Done (2026-11-22).** `new-channel-dialog.tsx`: radio cards for Text, Voice and Announcement, the type's icon in the name field, Private switch | Forum and Stage cards, once those types exist | Add a card per type as each lands (`CHAT_CHANNEL_CREATE_TYPES` in `packages/core/src/schemas/chat.ts`) | S |
| 2 | Text (#) | Messages, files, threads | **Done.** `kind = "text"` | - | Unchanged | - |
| 3 | Voice | A room people walk into; text chat beside it; user limit | **Done.** `kind = "voice"`, walk-in join, `userLimit` | - | Unchanged | - |
| 4 | Private channel | Only selected members and roles can see it; chosen at creation [D2] | **Done.** `ChatChannel.private`; members are picked in the channel, and teams and roles reach it through access grants (`chat.channel` in `lib/access/sharing-service.ts`) | Picking members and roles inside the Create dialog itself (today: after creating, in the channel's settings) | Add the people/roles picker to the dialog when Private is on | S |
| 5 | Category | Headings that group channels; collapse; sync permissions [D3] | **Done.** `ChatCategory`, drag to reorder, create a channel under a heading | Permission sync from a category to its channels | Category-level access grant inherited by its channels | M |
| 6 | Announcement | Only allowed roles post; other servers **follow** it into one of their channels; a message is **published** to every follower (crosspost) [D4] | **Partial (2026-11-22).** A Create Channel type: a text channel with `membersMaySend` off (`core.isAnnouncementChannel`), the same column as the "Announcement channel" switch, so every channel made with the switch already is one; megaphone icon in the rail and header. Members read and react, administrators post (`sendClosed()`) | Follow into another space's channel; Publish a message to followers | `ChatChannelFollow` (source channel, target channel, who followed); Follow from the channel header listing channels the follower administers; a Publish action on administrators' messages copying it, with a "from #channel in Space" origin line, to every following channel | L |
| 7 | Forum | Posts are threads with a title and a first message; list with tags, sort by latest activity or creation date, search, posting guidelines, required tags, moderator-only tags, default reaction [D5] | **Missing.** Threads exist inside text channels | The whole type | `kind = "forum"`: the channel view is the list of its threads (`parentId` roots) with title; `ChatForumTag` per channel and tags on the root message; guidelines and `requireTag` on the channel; sort and search on the list; the Create card | L |
| 8 | Media | A forum whose posts are pictures and videos, drawn as a gallery [D6] | **Missing** | The whole type | Forum with a gallery layout and an attachment required on the first message | S on top of Forum |
| 9 | Stage | Speakers and an audience; audience is listen-only and raises a hand to speak; moderators invite to speak and move speakers back; a topic for the live stage [D7] | **Missing.** Calls have a stage *layout* (`call-stage.tsx`) and raised hands (`call-hands-panel.tsx`), not a Stage channel | The whole type | `kind = "stage"` on the voice-room machinery: audience joins with publish permission off in the LiveKit token, request to speak reuses raised hands, a moderator's "Invite to speak"/"Move to audience" updates the participant's publish permission, topic shown over the room; the Create card | L |
| 10 | Directory (student hubs) | Lists servers of a hub [D1] | Not applicable: spaces are found through the space list and invites | - | None | - |

Sources:

- D1. Discord developer docs, Channel resource, channel types - https://discord.com/developers/docs/resources/channel
- D2. Discord support, Channels FAQ (creating channels, private channels) (support.discord.com)
- D3. Discord support, Channel categories (support.discord.com)
- D4. Discord support, Announcement channels (support.discord.com)
- D5. Discord support, Forum channels FAQ (support.discord.com)
- D6. Discord support, Media channel (support.discord.com)
- D7. Discord support, Stage channels FAQ (support.discord.com)
