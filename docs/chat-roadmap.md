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
mentions, presence, privacy audiences, reports, calls with screen sharing, and
per-message moderation.

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
| Custom emoji per space                          | ⬜     | P1   | M    | Fluxer and Stoat both have packs. Polaris has the storage and the picker already.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Stickers                                        | ⬜     | P2   | M    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Scheduled messages                              | ⬜     | P2   | M    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Disappearing messages per conversation          | ⬜     | P1   | M    | Signal's model: a window set by either side, applied on both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Streamer mode (hide invite codes and addresses) | ⬜     | P2   | S    | Fluxer has it; cheap and genuinely useful on a screen share, which Polaris now does well.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Server discovery (a public directory)           | ⬜     | P2   | M    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 4. End-to-end encryption

**Status: ⬜ · Priority P1 · Size XL.** Asked for directly. It deserves its own
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

| Item                          | Status | Prio | Size | Notes                                                                                                                              |
| ----------------------------- | ------ | ---- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Push to talk                  | ⬜     | P1   | S    | Every voice client has it; Polaris has the key handling already (F9/F10).                                                          |
| Per-person volume in a call   | ✅     | -    | -    | Right-click a tile.                                                                                                                |
| Recording a call              | ✅     | -    | -    | Done in the browser of whoever presses record - no second container. See `call-recorder`, and the honest limits written at the top of it. |
| Combining audio in one room   | ✅     | -    | -    | Several devices sitting together share one microphone. Detected acoustically; see `call-nearby` and `call-combine`.                 |
| Watch together / streams      | ⬜     | P2   | L    |                                                                                                                                    |

### What Nextcloud Talk (spreed) has that Polaris does not

Read from the clone in `references/repos/spreed`. It is the most complete call
client of the references, and most of what is worth taking is small - the
interesting part is that almost none of it is about media plumbing, which
Polaris already has through the call server. It is about telling people what is
happening.

**Worth doing, cheapest first:**

| Item                                | Prio | Size | Where it is in spreed                                    | Why                                                                                                                                                                                                       |
| ----------------------------------- | ---- | ---- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "You seem to be talking while muted" | P0   | S    | `utils/webrtc/SpeakingWhileMutedWarner.js`               | Three seconds of speech into a dead microphone, then a warning - and a browser notification when the tab is not on screen. Polaris measures speaking already; this is the single highest value per line here. |
| Keep the screen awake in a call     | P1   | S    | `components/CallView/useWakeLock.ts`                     | Ten lines of `navigator.wakeLock`. A laptop that sleeps mid-call is a call that ends.                                                                                                                       |
| A device that changes mid-call      | P0   | M    | `composables/useDevices.js`, `MediaDevicesManager.js`    | A headset unplugged mid-call: spreed follows the change and reopens. Polaris listens for `devicechange` in the composer and the clip dialog, and **not in a call** - the call goes silent with nothing said. |
| Connection warnings that say what to do | P1  | M    | `utils/webrtc/analyzers/PeerConnectionAnalyzer.js`      | 30% loss over 5s, under 10 packets a second, or RTT over 1.5s, and it says "turn your video off" rather than "poor connection". Polaris reads encoder evidence already; this is the sentence, not the metric. |
| Check the devices before joining    | P1   | M    | `components/MediaSettings/`, `MediaDevicesSpeakerTest.vue` | A preview, a level meter and a speaker test before the call starts. Polaris opens the devices as the room opens, so a broken microphone is found by the other person.                                        |
| Background blur                     | P1   | L    | `utils/media/effects/virtual-background/`                | MediaPipe selfie segmentation, tflite model **vendored in the repo** and a WebGL compositor - no network and no vendor. It fits beside `mic-filter`, which is the same shape of thing for sound.             |
| Raise a hand, react in a call       | P2   | M    | `stores/participantActivity.ts`, `ReactionToaster.vue`   | Rides on participant state, which Polaris already broadcasts as attributes.                                                                                                                                |
| Picture-in-picture call window      | P2   | M    | `mainFloatingCall.ts`, `ViewerOverlayCallView.vue`       | Polaris shrinks a call to a bar; spreed keeps the faces in a floating window, which is what people want while reading the document being discussed.                                                          |

**Deliberately not taken:**

- **Quality by head count** (`SentVideoQualityThrottler.js`): thresholds at 20, 80
  and 120 video streams, with anybody speaking pushed to the top rung for five
  seconds after they stop. Polaris caps a call at 8, so the thresholds are dead
  code here - but the *speaker gets the best rung* rule is the good idea in it,
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

**Still open from what spreed does and Polaris does not:** recording *consent*.
Spreed can require every participant to tick a box before joining a call that may
be recorded, and refuses the join without it (`recordingConsent` on the join
endpoint). Polaris tells the room a recording is running, on every screen and to
anybody who joins afterwards, but it does not gate the join on agreement. That is
a policy decision an administrator should own, and it wants a setting rather than
a default.
