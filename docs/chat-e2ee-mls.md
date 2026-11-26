# Chat MLS: delivery service and devices

How chat end-to-end encryption moves MLS messages between devices
(docs/chat-e2ee-proposal.md; units E1-E5 of docs/rust-core-plan.md). Everything
here is behind the internal flag `POLARIS_INTERNAL_CHAT_E2EE` (`flag.ts`), which
is off: the route answers 404 and no screen opens a device.

## Roles

- **Devices** run the cryptography: a `MlsMember` from `@polaris/core-rs` (the
  WebAssembly build in a browser, the Node binding on the server), its state in
  a store that commits each operation together with what it has to send.
- **The delivery service** (`apps/web/src/lib/chat/e2ee/mls-delivery.ts`, RFC
  9750's DS role) stores and routes bytes it cannot read, and decides one
  thing: the order of commits.

## Tables (migration `20280101000000_chat_mls_delivery`, additive)

| Model | Holds |
|---|---|
| `MlsDevice` | a device per account (`userId` + `device`), its signature key and declared protocol version |
| `MlsKeyPackage` | one-use key packages per device and suite, plus at most one last-resort package |
| `MlsGroup` | one group per conversation: group id, suite, current epoch, latest GroupInfo |
| `MlsGroupEvent` | the group's ordered log: commits, application messages, and Welcomes addressed to one device |
| `ChatHistoryKey` | the conversation's history key per epoch, sealed to one account's key or to `org` |

## Route: `POST /api/e2ee/mls`

One JSON body per op, validated by `mlsBody` (`schemas.ts`), handled by
`mls-handler.ts`. Every op needs a session; every op about a conversation needs
the account to reach it, and so does every account the op names.

| Op | Does |
|---|---|
| `register-device` | record the device; answers how many one-use key packages it still has |
| `publish-key-packages` | add one-use packages (at most 100 held) or replace the last-resort one |
| `claim-key-packages` | take one package per device of the named accounts (one-use first, then last resort) |
| `roster` | of up to 1,000 accounts holding a leaf in the caller's copy of the group, the ones that no longer reach the conversation (`departed`), and up to 100 people in it with a key package who hold none (`joinable`); people on the conversation's list are answered from it, anybody else named through `channelAccess`, at most 100 per call |
| `group` / `create-group` | read the conversation's group; create it (the first device wins, the rest get `groupExists`) |
| `commit` | accepted only for the epoch the group is at, as one compare-and-set; the loser gets `staleEpoch` |
| `application` | an MLS application message for the whole group |
| `events` | the log after a sequence number: group-wide rows and this device's own Welcomes |
| `put-history-keys` / `history-keys` | store envelopes (first write wins); read the ones sealed to the caller |
| `edit-sealed` | a new version of one of the caller's own sealed messages: every plain-edit check, then the device, epoch and signature checks of a send, and exactly the next revision; answers the edit time |
| `account-keys` | the public account keys (signing, HPKE) of up to 100 named accounts that reach the conversation; an account outside it is left out exactly like one with no key, never refused, so the answer says nothing about accounts the caller shares no conversation with |

Retention: the log keeps the last 256 epochs, pruned every 32 inside the commit
transaction. A device further behind rejoins from the group's latest GroupInfo
by an external commit.

## A device (`mls-client.ts`, `mls-browser.ts`)

`MlsDevice.open` restores the member from its store (a fresh one on first use)
and resends whatever an earlier run committed and never sent. Then:

- `register` refreshes the device and tops its key packages up to 20 when fewer
  than 10 are left.
- `ensureGroup` returns the conversation's group: the one the device is in, the
  one a waiting Welcome puts it in, a new one when none exists, or the existing
  one joined by an external commit (a member's new device, a lost store, or the
  loser of two simultaneous creates).
- `addAccounts` claims packages, commits the add and sends one Welcome per
  device; on `staleEpoch` it drops its pending commit, reads the winner's and
  tries again (three attempts). `removeAccounts` commits the removal of every
  device of accounts that left, the same way. A retry after a lost epoch
  leaves out the accounts the winning commit already added.
- `reconcile` brings the group's leaves in line with the conversation
  (`roster`): every device of the accounts that left is removed, then the
  devices of the people in it with no leaf are added (a Welcome each, and the
  new epoch's history key sealed to them). `sendSealed` runs it before it
  seals, so however somebody was added or left - the member list, an invite,
  a join request, a space, an organisation, an account deleted - nothing said
  afterwards is sealed to a key of somebody who left, and a newcomer reads it
  without having opened the conversation since. A failed removal fails the
  send (never sent in the clear instead); a failed add is logged and
  tried again on the next send, and the newcomer still joins by its own
  external commit when it opens the conversation.
- A rejoin (external commit) first drops the device's own copy of the group
  (`forgetGroup`): a forked copy, one too far behind, or the previous attempt's
  join the server refused for a lost epoch race. A device that kept its key has
  its old leaf replaced by the external commit itself; one that lost its store
  has a new key, so once back it removes the leaf of its own address under the
  old key. A Welcome for a key the device no longer holds is skipped.
- A device that reads its own removal forgets the group; a later Welcome, or a
  rejoin the server allows (the account still reaches the conversation), brings
  it back.
- **Every tab of a browser shares its device** (`device-across-tabs.ts`). One
  store and one leaf per browser and account, but each tab holds the member in
  memory, so before this a second tab acted on a copy the first had moved past:
  its sends failed ("no group with that id"), it rejoined, and the group's epoch
  climbed with every turn between tabs. Each operation now holds the device's
  Web Lock (`polaris-mls/device/<device>`, one holder across the browser), and a
  tab whose last operation predates another tab's write to the store opens the
  device again from it first. Writes move a generation noted in localStorage
  (`polaris-mls/generation/<device>`); reads do not, so tabs that only read never
  make the others reload. Without the Web Locks API (an old browser, or a page
  over plain HTTP, where it is not offered) one tab's operations still run in
  turn and each starts from the newest store; only two tabs acting in the same
  instant can still meet. `hasGroup` and `groupOf` answer from the shared notes
  at once.
- `sendApplication` catches up first, so a message is never sealed in an epoch
  the group has left; `sync` reads the log and returns the messages from others.

History keys: the device that moves the group to a new epoch (create, add,
remove, rejoin) makes that epoch's `HK`, sends it to the group as an MLS
application message, and seals it to its own account and to every account it
added (`sealHistoryKey`, public keys from `account-keys`, stored with
`put-history-keys`), and to every other member of the conversation with an
account key (`member-account-keys`, 100 per page, the people `@` offers), so a
dormant member - one with no device in the group - opens it from its first
device (proposal 4.2 item 4). A committer reads at most 100 pages (10,000
members) and puts 100 envelopes per request. Each device that reads it seals it to its own account as
well; the first envelope per account and epoch wins. `historyKey(channel,
epoch)` returns the key this run holds, else opens the account's envelope - how
an account's new device reads the past. Sealing needs the account key's HPKE
pair (`account` option, once unlocked); without it a device still reads keys in
the group. Every application message carries a one-byte kind: 0 content, 1 a
history key.

A device keeps every history key it reads or makes across restarts in
`IndexedDbHistoryKeyStore` (`mls-history-keys.ts`, `historyKeys` option),
one database per device. Never in the clear: each key is sealed with
AES-256-GCM under a key and nonce derived (HKDF) from a non-extractable
wrapping key held in the same database, bound to the device, conversation and
epoch, and a slot is written once. Signing the account out of the browser
deletes the device's MLS store and these keys.

Sealed messages: `sendSealed(channel, plaintext)` catches up, seals the content
with `sealMessage` under the current epoch's history key (message id = the
send's `clientKey`, bound to the sender's leaf), and signs it with the
device's MLS signature key (`signContent`, Ed25519 over
`CONTENT_SIGNATURE_LABEL || canonical(..., SHA-256(sealed))`). The route op
`send-sealed` takes it only from the session's own device, for a group at or
past that epoch, with a signature that verifies under the key the server holds
for the device; it copies that key onto the row and stores the message through
the ordinary `send` with an empty body, so every posting rule still applies and
nothing that reads a body has anything to read. `ChatMessage` carries
`e2eeCiphertext`, `e2eeEpoch`, `e2eeSenderLeaf`, `e2eeDevice`, `e2eeSignature`
and `e2eeSignatureKey` (migration `20280102000000_chat_sealed_messages`,
additive; its header has the reverse). `readSealed(channel, ids)` (op
`read-sealed`, at most 100, only messages the account may see) checks each
signature, then opens the content with the epoch's history key; a message that
fails either comes back with `opened: null`. Each row comes back with
`sender`, the signing device's `${account}/${device}`: the author's, or for a
row the server's own member posted (no author), the service account it signs
as (`signer` on the wire). Verifying needs WebCrypto Ed25519
(Node 20+, current browsers).

Editing (`editSealed`, op `edit-sealed`): the server first asks everything a
plain edit asks (`messages.requireRewritable`: the author's own, a service
row is never editable, not deleted, not a poll, readable this far back, inside
the scope's edit window), then that the row is sealed, the device is the
caller's own, the epoch is no newer than the group's and no older than the
row's (`olderEpoch`: an older key may be held by somebody removed since), and
that the signature verifies over the same binding as the send, with the row's
`clientKey` as the message id and the next revision (see "Revisions" below).
It writes the new sealed columns and
`editedAt`, clears `translation`, and publishes the row as changed; no link is
looked up. Where the scope keeps history, the version replaced goes into
`ChatMessageEdit` with an empty `body` and its sealed columns as they were
(migration `20281126000000_chat_sealed_edit_history`, additive, reverse in its
header), and `editHistory` hands them back in base64url, so the history dialog
opens each one on the reader's device (`openSealedVersions`) and marks one
that does not open there. A chat refusal (`ChatAccessError`) comes back as
`{ error: "refused", text }`, the sentence in the reader's language.

The device (`MlsDevice.editSealed`) reads the row's `clientKey`, brings the
group up to date (`pull`, `reconcile`) as a send does, and seals under the
current epoch's history key. The screen (`editSealedMessage`) shows the new
text at once from this page's opened copy, never by writing it into the row,
and puts the old one back if the edit is refused. Opened copies are keyed by
id and `sealedEditedAt` (the row's edit time, on the view and on the list's
last line), so every device that opened the earlier version opens it again.

Revisions: each version of a message is a revision - 0 as sent, one more per
edit - and the revision is in what the content is derived from and what the
device signs (`MessageBinding.revision`; revision 0 binds exactly as before
revisions existed, so every message already stored opens). The server keeps
it in `e2eeRevision` on the message and on each version its history keeps
(migration `20281127000000_chat_sealed_revision`, additive, null is 0) and
takes an edit only as the next revision of the stored one (`staleRevision`
otherwise); the row moves only from the revision it was read at, so of two
edits racing one lands and the other device seals again over it. A version
relabelled as another revision does not verify. A device remembers the
highest revision it has seen of each edited message (its notes, keyed by
conversation and message; an opened history version raises it past that
version), and from then on refuses a lower one as the message - it opens to
nothing, and its author's device does not edit over it. What no client can
tell is an edit it has never seen at all: a device that saw only an earlier
version is shown that one until the server hands it the latest, as with any
message the server holds back.

Crash safety: an operation's state changes and its request are written in one
transaction before the request is sent. A commit the server took while the
device never heard the answer comes back `staleEpoch` on resend; the device then
finds its own commit in the log and merges it.

In a browser the member is the WebAssembly build staged at `public/core-rs/mls`
(by `scripts/copy-core-rs-assets.mjs`, digest-named, fetched only when a device
is opened), the state is `IndexedDbMlsStore`, and the device id and group notes
are in `localStorage`.

## Chat screens (`sealed-chat.ts`, `opened-sealed.ts`)

The chat layout passes `chatE2eeEnabled()` to the chat provider, which hands
the account to `configureSealedChat`; off, it hands `null`, nothing loads the
device or its WebAssembly, and every send and read is the plain one. On:

- **Sending.** The outbox's `deliver` (and `sendNow`, for a box that could
  not keep the message, and the thread composer) seals through this browser's
  device: `ensureGroup`, then `sendSealed` with the outbox key as the message
  id, the thread as `parentId` and the message answered as `replyToId` (both
  metadata, as every posting rule needs them). A refusal (4xx but 429) fails
  the entry; anything else leaves it queued. It is never sent in the clear
  instead. The device is opened with the account key's HPKE pair from this
  browser's own lock (`deviceAccountHpke`), when it holds one.
- **Waiting on the device.** What the outbox keeps (a message, or an edit
  made with Polaris out of reach) has its words sealed at rest under a
  non-extractable AES-256-GCM key in the same store (`lib/offline/at-rest`),
  never in the clear; with no WebCrypto it is not kept at all and is sent at
  once. A kept edit of a sealed message is sealed through the group only when
  it is sent, as the next revision over the version it replaced.
- **What is sealed.** `{"v":1,"body":...,"translation"?:...}` as UTF-8 JSON,
  parsed on open against the same schema as a plain send; anything else opens
  to nothing.
- **Reading.** A row with `e2eeEpoch` set is `sealed: true` in
  `ChatMessageView` (its ciphertext is not selected with the page).
  `MessageList` runs `useOpenedSealed`: sealed rows not opened yet are read
  with `read-sealed` (100 per request) without joining the group - the
  history keys sealed to the account open them - and drawn with the body they
  opened to. Opened bodies stay in memory for the page (5,000 at most), and a
  sender's own text is kept the moment the server takes it, so a row never
  blinks empty after its draft. A row that does not open keeps its empty body.

### Other places a message is shown

Nothing below ever sends a sealed message's words to the server; each opens it
on the device, through `openSealed`, with the same page cache.

- **Conversation list.** `lastMessages` marks a sealed last message with its
  id (`sealedId`); the row (`useOpenedLast`) opens it and shows a line of it,
  and says nothing until it does - never "attachment".
- **Peek, pins, search hits.** Each list runs its messages through
  `useOpenedSealed` / `useOpenedWithin` and draws what they open to.
- **Notices.** `messageToasts` marks a sealed message `sealed` with the general
  "Sent a message" line; the shell's notice handler opens it on the device and
  shows its words instead (one behind the reader's chat lock stays redacted).
  An answer typed into the notice of a sealed conversation is sealed too
  (`sendSealedMessage`), then the conversation is read up to it. Chat
  messages are not sent as server pushes, so no notice is drawn anywhere the
  device could not open it.
- **Search** (`sealed-search-index.ts`, `chat/sealed-search.ts`). The server
  searches bodies, and a sealed one is empty, so a sealed message's words are
  matched on the device. Every sealed message the browser opens, sends or
  edits is kept in the device's index (`polaris-mls-search/<device>` in
  IndexedDB): each entry sealed with AES-256-GCM under a non-extractable key in
  the same database, the message id in the additional data, the conversation
  inside the seal; beside it only the id and the time of its last edit, so a
  version already kept is not sealed again. The newest version wins; at most
  20,000 entries, the oldest dropped first. A search with words asks the
  server for plain matches as before and, at the same time, the index for up
  to 200 sealed matches, newest first; those ids (never the words) go to
  `searchSealedAction`, which answers only sealed rows among them through the
  same reach, chat lock, age gate, history and filters, and names the ones that
  are deleted or out of reach, which the device drops. Both answers are one
  list, newest first; a sealed hit that opens to words that no longer match
  (edited elsewhere) is left out. The index is deleted with the device at
  sign-out. Its limit: it finds only what this browser opened, so a message
  never scrolled to here, or opened on another device, is found by who, where,
  when and what is attached to it, not by its words. The launcher's Chat
  lookup (`search/sealed-lookup.ts`, loaded only while sealed chat is on, for
  the scopes that list messages) asks the same index and the same action with
  no unlock proof, as its server lookup does, so a locked or hidden
  conversation stays out; a row shows the words this device opened, and a hit
  whose kept words are an older version than the server's is left out.
- **Link cards.** Not made for a sealed message: the server makes a card by
  fetching the link, which would tell it what was sent. The link is still a
  link. A card the sender makes and seals beside the message is the way to
  have one, and is not built.
- **Edits.** Sealed too (see "Editing" above), with the history kept sealed
  where the scope keeps one. A plain edit of a sealed message is still refused
  (`errors.sealedNotEditable`), since it would put the new words in the clear;
  the pencil, the menu item and the edit key are offered on a sealed row only
  while sealed chat is on in that browser (`rewritable.ts`).

## Server-run members: the design (decided; access built)

Polar and webhooks take part as MLS members the server runs (proposal 7),
through the Node binding and `mls-store.ts`:

- **Who they are.** Each kind is a fixed service account id, a UUID with
  version nibble 0, which neither `uuid(7)` nor `gen_random_uuid()` can ever
  give a person: Polar `00000000-0000-0000-0000-000000000001`, webhooks
  `00000000-0000-0000-0000-000000000002`. The address shape stays
  `${userId}/${device}`, so the schemas, `MlsDevice` and the log need nothing
  new.
- **One device per conversation.** Polar's device id is the conversation id
  without dashes; a webhook's is the webhook id without dashes (a webhook
  belongs to one channel). A member is restored from all of its store at once,
  so a single device across every group would load every group for every
  message; per conversation, each store holds one group. The store's `device`
  key is the full address.
- **Who it reaches.** A service account reaches a conversation only through
  what puts it there: Polar where it was added as a member ("Can read
  messages", visible in the member list), a webhook in its own channel. The
  same test answers `channelAccess` for it everywhere the route checks an
  account - claiming its key packages, a Welcome addressed to it, its
  history-key envelope - so a person adds or removes Polar the way they add
  anybody.
- **Where "Polar was added" lives (built).** A `ChatServiceMember` row
  (`channelId`, `service: "polar"`, `addedById`, `addedAt`; migration
  `20281124000000_chat_service_member`, additive), not a `ChatChannelMember`
  one: that row is an account's - a read mark, a role, a timeout, a foreign key
  to `User` - and Polar has no account and none of those. It goes with the
  channel (cascade) and is kept when whoever added it leaves. A webhook needs no
  row: `ChatWebhook.channelId` already says where it belongs.
  `lib/chat/service-members.ts` holds the ids, the device id rule and
  add/remove, and `channelAccess` answers a service account from it (a member
  that posts and administers nothing; an archived conversation is closed to it),
  so the route's per-account checks need no change.
- **Transport.** In-process: the ops run against `mls-delivery.ts` and
  `sealed-messages.ts` directly, as the service account, with no session and
  no route. Polar's replies and a webhook's posts go through
  `MlsDevice.sendSealed`, so they are signed by the service device's leaf
  like anybody's.
- **Crash safety.** The outbox the device store needs is kept in
  `MlsStoreEntry` under a reserved key prefix, committed in the same
  transaction as the member's changes and left out of what `restore` reads.
- **One writer.** Two server instances must never run the same service device
  at once (they would fork its ratchet): each operation holds a lease on the
  device's address for its length.
- **Honesty.** What reaches a service member is read by whoever runs Polaris
  and, for Polar, the model provider; the member list says so.

What is built on top of it:

- **A sealed conversation** (server side) is one with an `MlsGroup` row while
  `chatE2eeEnabled()` is on (`conversationSealed` in `sealed-messages.ts`).
- **Adding Polar** (`lib/chat/polar-member.ts`, the "Polar in this chat"
  switch in the conversation's info, drawn only while sealed chat is on): the
  same check as adding a person - whoever runs a channel, a group's owner, or
  anybody in a group whose owner left adding open. Added, its device opens once
  and joins the group (a Welcome, or its own external commit), so it opens what
  is said from then on and nothing before. Taken out, its `ChatServiceMember`
  row goes, everything `MlsStoreEntry` held for its device is dropped
  (`forgetServiceDevice`, in turn with its operations), and the remover's
  device takes its leaf out of the group (`removeSealedAccounts`).
- **Polar answering** (`e2ee/sealed-polar.ts`): every sealed message a person
  sends, where Polar is a member, is opened by Polar's device; one that asks it
  (`@polar`, or a reply to Polar) is answered through `answerPolarMention` with
  a `SealedReply`: the conversation before it is opened by the same device, the
  answer is sealed and posted by it as a reply. Only the MLS work holds the
  device's lease; the model's answer is written outside it. A sealed answer
  streams no draft in the clear. It has the asker's tools, as a plain answer
  does: a read runs at once and what it found reaches the conversation only
  inside the sealed answer. A change it offers is written, with what it would
  do, into that sealed answer, Approve and Cancel go on the row after it
  (`callComponents`), and the `PolarChatCall` row that waits for the approval
  keeps only the tool's name readable: its input and the changes done before
  it are sealed together in `done` under POLARIS_MASTER_KEY - the key Polar's
  device state there is already sealed under - with the row's id inside, so a
  value copied onto another row does not open. "Approve"
  (`approveSealedPolar`) has Polar's device open the question first - a
  question it can no longer open runs nothing and answers the press as gone -
  then runs the change as the asker and seals the next answer over the offer;
  "Cancel" (`cancelSealedPolar`) seals the cancelled sentence over it. Either
  way the buttons come off. An answer that is not one
  gets the same way out as a plain one - "Set up providers" (the link moves out
  of the sealed text to it) or "Try again" - put on the row after the sealed
  post, not marked as an edit; the buttons say nothing of what was asked.
  "Try again" (`retrySealedPolar`) has Polar's device open the question again
  and seal the new answer over its own row as the next revision (`editSealed`
  takes that from Polar only for its own sealed answer, signed by the device
  that posted it, with no edit window), the old version kept sealed where the
  scope keeps history, and the button taken off.
- **A webhook posting** (`postThroughWebhook`): in a sealed conversation the
  webhook's device seals the post; the name and picture the call gave stay
  metadata beside it, and no link card is made.

## Not built yet

- Sealed link cards (see "Other places a message is shown").
- The `org` history-key envelope. The organisation recovery key (proposal 3.5)
  has no public key stored anywhere yet - its custodian setup is not built - so
  nothing can serve it and no `org` envelope can be sealed until it is.
- Server-run members (Polar, webhooks): who they are, where they reach and the
  service device are built (`service-device.ts`: the Node binding's member
  through `nativeMlsMember`, its store, outbox, notes and history keys in
  `MlsStoreEntry` under the reserved prefix `\0polaris/`, a lease per device
  address, ops in-process through `answerMls`; a service's sealed message is
  stored with no author under Polar's or the webhook's name). Polar answering,
  a webhook posting and the member list's switch are built too (see below).

## Turning it on: what is missing (2026-11-24)

`POLARIS_INTERNAL_CHAT_E2EE` stays off until every row marked "Yes" below is
done and verified. Ordered by what has to land first; the percentage is a rough
share of the work, not of the code.

| # | Gap | Blocks default-on? | Done |
| --- | --- | --- | --- |
| 1 | **Real-browser run of the sealed flows.** The text flows passed end to end against a production build on 2026-11-24 (see the note under this table). Also passed in a browser (2026-11-24, round 18): the launcher's Chat search finding a sealed message by its words on the sender's and the reader's browser; a webhook posting over HTTP into a sealed group (204, stored sealed under the given name, opened by both members, `?wait=true` answered); two tabs of one browser sending in turn and at once, every message opened by the other side - which showed the tabs fighting over the device, now fixed ("Every tab of a browser shares its device"; the fix itself is unit-tested and not yet re-run in a browser). Not yet: the chat panel's own search, the "Polar in this chat" switch (the driver did not reach it through the info panel), Polar's Approve and Cancel (needs a provider). | Yes | ~65% |
| 2 | **Sealed only, enforced by the server.** Built: once a conversation has an `MlsGroup` (and sealed chat is on), every write in the clear from a person is refused with `errors.sealedOnly` - `messages.send` without sealed columns (so `sendAction`, replies from a notice, forwards, polls, attachments and saved media, locations, forum posts, the HTTP API, MCP tools, invite and game cards), a plain `edit`, and `scheduleMessage` at scheduling time (`refusePlainIfSealed`, `lib/chat/e2ee/sealed-conversation.ts`; see "Sealed only"). A page loaded before sealed chat was on is told to reload instead (`errors.sealedOnlyReload`, see "Sealed only"). A conversation the migration cut is sealed only before any browser has made its group (`conversationSealed` reads `ChatMigration`). Left: a sealed form for editing an old plain message in a sealed conversation. | Yes | ~85% |
| 3 | **Message kinds that are still plain.** Built (2026-11-25): attachments, see "Sealed files"; polls, see "Sealed polls" (question and answers sealed; votes sealed with the tally in each browser, see "Sealed votes"; public or anonymous chosen at creation, see "Public and anonymous votes"); forum post titles, see "Sealed forum posts". Left: voice notes recorded in a sealed conversation ride the sealed-file path (their length and shape are inside the seal) but are not verified in a browser; sealed reactions (proposal: "votos cifrados; recuento en el cliente"; votes done), scheduled messages, server-side translations, link cards, files sent to be seen once and files left in a Drive (refused in a sealed conversation, nothing sent in the clear). Until each has its sealed form a sealed conversation cannot send it. | Yes | ~56% (text, edits, replies, threads, Polar, webhooks, files - with the gallery, forum list and video stills - poll questions, answers and votes, forum post titles are sealed) |
| 4 | **Default-on switch.** Built (2026-11-25): `chatE2eeEnabled()` is `chatE2eeFrom(env, CHAT_E2EE_DEFAULT_ON)` in `flag.ts` - `1` on, `0` off, anything else the default - so turning it on is changing `CHAT_E2EE_DEFAULT_ON` to `true` in a release, on with nothing set and `0` kept as the kill switch, as `passwordLockEnabled()` does, because existing installs never get new `.env` keys (repo CLAUDE.md); tested in `test/chat/e2ee/flag.test.ts`. Left: the flip itself (last), and a kill switch that does not lock anybody out of a conversation already sealed only (today `0` makes every sealed route answer 404). | Yes | ~40% |
| 5 | **Migration of existing chats** (proposal 8): built (2026-11-25, see "Migration of existing chats"): the per-conversation state (`ChatMigration`), the server-side migrator sealing every plain text message and its edit history under a one-time `HK(c, legacy)` sealed to each member's account key, verification of every row before the cut (M3), the cut (sealed only, plain text moved to `ChatMigrationRollback`), resume after a crash, the backup gate, a pass every 10 minutes from the dashboard itself. Verified against a real PostgreSQL. Built 2026-11-25 (round 26, see "Rollback, purge and late members"): the admin line (Management > Security), the per-conversation rollback from `ChatMigrationRollback` and "Seal it again", the purge after 30 days (decision 4), and members whose account key came after the cut getting the legacy key from a member's browser (`legacy-key-gaps`). Left: attachments/polls/system rows (row 3), a "history before [date]" label, members nobody holding the key ever meets again (needs `ORK`, row 6). Not verified: the admin line and rollback in a browser and against a real PostgreSQL. | Yes (owner: every existing chat migrated) | ~65% |
| 6 | **Recovery.** Password lock, passkey PRF lock, device lock and the QR hand-over exist. Missing: the organisation recovery key (proposal below), which is also what the migration seals legacy history to for members with no account key yet (proposal 8.4), and admin account recovery handing an account back with its history. Without `ORK`, an account with no factor of its own on a new browser (magic link, SSO, admin reset) loses its history. | Yes, for "nobody loses history" | ~45% |
| 7 | **Key transparency** (proposal 4.6): built (2026-11-25, see "Safety numbers"): the 60-digit safety number and its QR in a one-to-one conversation's info; scanning the other person's QR in the app; the verified mark; the key-change line in the conversation (per browser, trust on first use). Left: `AccountKeyVerifier` still has no log behind it, so a server could hand out a substitute account key to somebody who never verifies - the append-only key log with a signed root and inclusion and consistency checks in the browser, and each account monitoring its own entries; key changes of group members (no number in a group). | Yes, for "government-grade" | ~30% |
| 8 | **Device hygiene**: built (2026-11-25, see "Device hygiene"): a signed-out browser's device is retired and its leaf leaves every group at the next member's send; a device unseen for 30 days (decision 7) likewise, and it rejoins on its own when back; retired devices are handed out to nobody. Left: the screen for the instance limit (the `Setting` key is read, 7-90) and the organisation's own limit, the "new device added" notice on the account's other devices, a device list with revoke. | Yes, for post-compromise security | ~50% |
| 9 | **Server features that read chat text**: built (2026-11-25): moderation reports of a sealed message with its files, and the sealed lines of a whole-conversation or person report, see "Sealed reports". Built 2026-11-26 (round 30): moving a whole Polaris (Settings transfer) now re-seals the bare envelopes it used to miss - the MLS store of server-run members (Polar, webhooks), the OPAQUE server setup, automation secrets - and carries each OPAQUE record's password tag as the hash it fingerprints, keyed again on arrival (before, the setup failed to open on the new instance, every OPAQUE record was deleted, and accounts whose password was set over OPAQUE could not sign in nor open their account key or sealed history). Sealed rows, `ChatHistoryKey` and account-key envelopes travel as they are, so a sealed conversation opens after the move. Not carried by the transfer at all (every file, sealed or not): attachment and Drive bytes on disk or a storage connection; a Polar change waiting for Approve is answered as gone; a Polaris database backup is not restorable from the screen and only opens on the instance with the same master key. Left: retention and compliance export (proposal 9), automations that read messages. Each needs its sealed answer or an explicit "not in sealed conversations". | Partly (export/import must round-trip) | ~48% |
| 10 | **Search on a new browser** (proposal 6.1, encrypted shared index segments): the device index finds only what this browser opened. | No (documented limit) | ~40% |
| 11 | **Web code trust** (proposal 4.7): published hash of the crypto bundle, extension and desktop checking it, strict CSP and Trusted Types on message rendering. | No for default-on; yes for intelligence deployments | ~10% |
| 12 | **Large channels**: built (2026-11-25): `reconcile` adds at most 100 newcomers per send (`ADD_BATCH`, one `claim-key-packages` call's worth); the roster's pages together could name more, which the claim refused, so every add in a channel past 1,000 leaves failed and was retried forever. The rest are added by later sends or join by their own external commit on open (decision 9). Removals go at most 100 per commit (`REMOVE_BATCH`), as many commits as it takes, all before anything is sealed: every removed leaf blanks its path and the committer then encrypts to each node left under a blank, so one commit taking out thousands could pass the 1 MiB commit limit and never land (tested: five leaving with a batch of two take three commits, and none of them opens what is sealed after). Left: steady-state commit size with a filled tree is unmeasured (phase 0). | For big spaces | ~38% |

Rough overall to "on by default, every existing chat migrated, recoverable":
about 44%. Text messaging between people on the web, with edits, Polar and
webhooks, is built and covered by tests against the real MLS binding; the
migration, the plain-write cut, the other message kinds, `ORK` and
transparency are the bulk of what is left.

Real-browser run (2026-11-24): `next build` served with `next start` against a
real PostgreSQL 17 started natively (no Docker) with every migration applied,
two seeded accounts and a DM, sealed chat on, the MLS WebAssembly binding built
and staged (`build:rust`, `copy-core-rs-assets.mjs`), driven by Playwright in
headless Chromium with three browser contexts. Passed, each checked in the
database as well as on screen: an account key created at password sign-in for
both accounts; a send stored with an empty body and ciphertext; the other
account opening it live; the reply opening on the first; both opening after a
reload; a sealed edit from the message menu stored as revision 1 with the body
still empty, and opened by the other side; a second browser of the same account
opening history sent before it existed, and a message from it opening on both
other browsers; three MLS devices registered; a plain write over the HTTP API
into the sealed DM refused with 403 and `errors.sealedOnly`, with no plain row
stored; no row in the DM with a body. No console errors on any page.

Found on the way: a build without the MLS binding staged (a Rust toolchain
missing at build time) ships sealed chat switched on but unable to open a
device - every send stays "not sent yet" in the outbox, and nothing is sent in
the clear instead. CI sets `POLARIS_CORE_RS_REQUIRED=1`, so a published image
always carries it.

## Safety numbers (built 2026-11-25)

A one-to-one conversation's info has a "Safety number" row while sealed chat is
on (`safety-number.tsx`, view `safety` of `conversation-info.tsx`): 60 digits in
12 groups of 5, a QR of them (`polaris-safety-number:1:` followed by the
digits) and a copy button, for the two people to compare in person or on a
call. Nothing waits on it; it is for whoever does not want to take the server's
word for whose key their browser seals to.

- **Derivation** (`@polaris/chat-crypto/safety-number`): Signal's numeric
  fingerprint (libsignal `rust/protocol/src/fingerprint.rs`; WhatsApp's
  security code is the same construction). Per account: SHA-512 over a version,
  the key, the account id and the key again, then 5,199 rounds of SHA-512 over
  the previous digest and the key; the first 30 bytes as six big-endian 40-bit
  numbers mod 100,000 are that account's 30 digits. The "key" is both public
  halves of the account key (Ed25519 and X-Wing) under the package's canonical
  length-prefixed encoding, so swapping either half changes the number; the
  version is `0x0001`, never read as a Signal number; the two halves are ordered
  by account id (proposal 4.6), so both sides agree without comparing digits.
  Cross-checked against an independent Python implementation of the same steps;
  a fixed vector in `test/safety-number.test.ts` keeps it stable across releases.
- **Inputs**: this account's published keys (`/api/e2ee/keys` `state`) and the
  other person's (`/api/e2ee/mls` `account-keys`, which answers only people who
  reach the conversation) - deliberately what the server publishes, since that
  is what a substituted key would show up in. `pairSafetyNumber()` in
  `account-key-client.ts`; the person with no account key yet gets "has not
  opened sealed chat yet", a failure a retry.
- **Groups**: no number (each pair compares its own, proposal 4.6); a member's
  number is reached from the one-to-one conversation with them.

### Key changes and the verified mark (built 2026-11-25)

- **Memory** (`lib/chat/e2ee/peer-keys.ts`): per browser and signed-in
  account, in `localStorage`, the SHA-256 of the other person's published keys
  as last seen, whether it changed, and the safety number verified with them.
  Trust on first use, as Signal and WhatsApp: the first key is remembered
  silently; a different one later is a change, and it takes away a
  verification (a verification only lands on the key it was made against).
  At most 2,000 people, the least recently seen dropped first. Storage that
  is blocked means no line and no mark, never a refused message.
- **The line** (`key-change-bar.tsx`, above the box of a one-to-one sealed
  conversation): the key is checked once each time the conversation opens,
  after the first frame (one `account-keys` call); a change shows "Your safety
  number with X changed" with Verify (the safety number in a dialog) and
  Dismiss. Opening the safety number records the key too.
- **Verifying**: "Scan their code" reads the other screen's QR with the
  camera, a pasted screenshot or a picture (the vault's scanner, now
  `components/qr-scan-dialog.tsx`), and marks the person verified when it
  carries exactly this pair's digits; a different number says so. "Mark as
  verified" is for digits compared by voice. The mark is the digits, so a
  later change of either account key takes it away; it shows in the safety
  view and as "Verified" on the info row.
- **Not covered**: the memory is per browser (Signal syncs verification across
  linked devices; ours does not yet), and groups show no line (each pair
  compares in their one-to-one conversation).

Prior art read for the rest of row 7: Signal safety numbers (above); WhatsApp
Key Transparency, an auditable key directory (AKD, a Merkle-patricia tree of
key versions with published epoch roots, 2023); CONIKS (Melara et al., USENIX
Security 2015: per-user key histories in a signed Merkle prefix tree, clients
monitoring their own entries and checking the server does not fork the tree);
IETF KEYTRANS (draft-ietf-keytrans-architecture, -protocol). The next step
follows them: an append-only log of account key versions (RFC 6962-style tree),
a signed tree head, the browser checking inclusion of every key it seals to and
consistency with the last head it saw, and each account's own devices
monitoring its entries - which is what turns a substituted key from invisible
into a failed check.

## Device hygiene (built 2026-11-25)

A leaf that nobody uses any more is a key that still receives everything said
in the group: a browser signed out (its store deleted, the leaf left behind), a
lost laptop, a device last opened months ago. Removing those leaves is what
gives MLS its post-compromise security in practice: a leaf that never
updates keeps the keys it had when it was last seen. WhatsApp logs a linked
device out after 30 days unused and Signal unlinks an inactive one (the proposal
cites 45 days); Matrix keeps a device until it is signed out. Decision 7 of the
proposal: 30 days by default, 7 to 90 adjustable.

- **Retired devices.** A device is retired when its record is gone (signed out,
  or never known) or its `lastSeenAt` is older than the limit
  (`retiredDevices`, `inactiveCutoff`, `mls-delivery.ts`). The limit is
  `INACTIVE_DEVICE_DAYS` (30) unless the `Setting` key
  `chat.e2ee.inactiveDeviceDays` holds another, clamped to 7-90, so it works on
  every install with nothing set.
- **Sign-out retires the browser's device** while the session still stands
  (`retireBrowserDevice` in `mls-browser.ts`, called by `signOut` before the
  sign-out request; op `retire-device`): the server deletes the device and its
  key packages. It waits at most 3 seconds and never fails the sign-out; a
  device it did not reach is retired by the limit instead. "Sign out of all"
  and a session ended from another device are covered by the limit only.
- **Use keeps a device in.** Registering sets `lastSeenAt`; every op a device
  makes as itself (`events`, `commit`, `application` - a send reads the log first) moves it at most
  once an hour (`touchDevice`), so a tab left open for weeks stays in.
- **Members take the leaves out.** `roster` takes the device addresses of the
  group's leaves (`devices`, at most 1,000 per call; older callers send none)
  and answers `retired`, only for the accounts the call names or the caller's
  own, so it says nothing about anybody outside the caller's group.
  `reconcile` - run before every sealed send - removes retired leaves in the
  same commit as the devices of accounts that left, the account's own other
  browsers included. A member the server runs (Polar, a webhook) is never
  retired for being quiet: its device lives on the server and registers each
  time it acts.
- **Nobody adds a retired device.** `claim-key-packages` skips a device past
  the limit and deletes its key packages; it publishes fresh ones when back.
- **Coming back needs nothing.** A retired device that opens again registers,
  and rejoins each conversation by its own external commit when it opens it
  (the account still reaches it); the past comes from its account's history
  keys, so no history is lost.
- **What the server can do with it.** A server lying in `retired` can only
  make members remove a live device, which then rejoins by itself: a denial
  of service it could cause anyway by withholding messages. It cannot add a
  device this way.

Tests: `mls-delivery.test.ts` (the route's `retired` answer, the limit and its
clamp, the hourly touch, claims skipping a stale device; against the real MLS
binding, a send that removes a signed-out phone and an unseen PC in one commit,
the remaining phone still reading, the removed PC reading its removal, and the
PC rejoining), `retire-browser-device.test.ts`.

## Sealed files (built 2026-11-25)

Proposal 10b, first part. `@polaris/chat-crypto/file-content` seals a file
under a fresh 256-bit key in 64 KiB AES-256-GCM chunks (nonce = counter and a
last-chunk flag, so a cut, reordered or extended blob does not open) and
checks the SHA-256 of the clear bytes after opening.

- Sending (`send-with-files.ts`, `sealed-files.ts`): with sealed chat on, every
  file is sealed in the browser and uploaded with `?sealed=1`; the server keeps
  it as `name = "file"`, `application/octet-stream`, `ChatUpload.sealed` /
  `ChatAttachment.sealed` (migration `20281201000000_chat_sealed_files`). The
  message's seal carries, per file, the attachment id (the upload id is kept as
  the attachment id), key, digest, name, type, size, picture shape, sound and
  cover (`sealedFileSchema`). No still is uploaded for a sealed video.
- Server (`sealed-messages.sendSealed`, op `send-sealed` field `uploads`): a
  sealed send claims only sealed uploads, a plain send only plain ones, under
  `chat.attach` and the conversation's file limit; a retry answers the stored
  message; a failed send removes the claimed bytes; Polar and webhooks cannot
  attach. Saved media refuses a sealed file.
- Reading (`opened-sealed.ts`): an opened message's sealed files are fetched,
  opened and checked against the digest, and drawn from object URLs (256 MiB
  kept per page, oldest revoked first); until then, or if one does not open,
  the row shows the file's name with nothing to fetch. An edit keeps the
  message's files and keys.
- Once opened, a sealed file opens in the file viewer and the picture viewer
  from its opened bytes, and is saved from them (`saveFile` hands a `blob:`
  address over as it is). The media setting keeps the sealed blob ahead
  (`prefetchMedia`, by the type and size its seal names), so the offline copy
  holds it too; it is opened from there like any other time.
- The info page's photos and videos (`shared-media.tsx`): the server lists a
  message with a sealed file among them without knowing its type and sends the
  sealed message along; the page opens it, keeps its pictures and videos
  (`sharedTiles`, `shared-media-items.ts`; a covered one is left out as a plain
  one is) and opens only those files. A tile still opening is drawn and cannot
  be opened yet; one that did not open, or anything that is not a picture or a
  video, leaves the grid. The forum list opens a sealed post the same way and
  draws its picture (forum posts themselves are still refused in a sealed
  conversation, row 3).
- A sealed video's still is taken on the reader's page from the bytes it
  opened (`sealed-stills.ts`, the sender's `posterFor`), once per file and up
  to 300 per page, and drawn in the conversation, the gallery and the forum
  list. None is uploaded: a still on the server would be a picture of the
  video in the clear. Its blur (the seal's thumbhash) is drawn until then.
- Not covered yet: a sealed file is opened whole in memory (100 MiB ceiling);
  per-author deduplication and blob reference counting (10b.2) are not built.

Verified: unit tests (`packages/chat-crypto/test/file-content.test.ts`,
`apps/web/test/chat/e2ee/sealed-files.test.ts`,
`apps/web/test/chat/e2ee/sealed-media.test.ts`). Not run in a browser yet.

## Sealed polls (built 2026-11-25)

With sealed chat on, the poll dialog (`send-poll.ts`) seals the question as the
body and the answers as `poll.options` (`sealedPollSchema`, 2-10 answers of
up to 100 characters) and sends them with `send-sealed`, which carries only
`poll: { options: <count>, multiple, hideResults, anonymous, hours }`. The server
(`sealed-messages.sendSealed`) writes the usual `ChatPoll` with one answer row
per answer and no words in it; a poll from Polar or a webhook, or one with
files, is refused (`pollRefused`). Readers name the answers from the seal by
position (`openedPoll` in `opened-sealed.ts`), and a card refreshed from the
live frame keeps the words it already drew (`keepTexts`). A sealed poll is not
editable, as a plain one is not.

What the server still sees: how many answers, the rules, when it closes, and
who has voted and when. Which answer anybody picked is sealed: see "Sealed
votes".

### Sealed votes (built 2026-11-25)

In a sealed conversation a vote is a ballot sealed in the voter's browser, and
the tally is made in each member's browser. The server can no longer link a
voter to an answer.

How others do it. Signal sends a vote as an end-to-end encrypted group message
(`PollVote`: the poll it answers, the option indexes, and a per-poll
`voteCount` that grows with each re-vote so the newest wins), and every client
counts ([Signal blog, "Signal Polls"](https://signal.org/blog/polls/); a 2026
advisory on Signal iOS, [GHSL-2026-112/113](https://securitylab.github.com/advisories/GHSL-2026-112_GHSL-2026-113_Signal-iOS/),
was a vote accepted for a poll in another conversation - the binding below
rules that out). WhatsApp encrypts each vote under a key derived from the
poll's own message secret, the poll id, its creator and the voter, with the
SHA-256 of each picked option inside (as implemented by the open
`whatsmeow` client, `msgsecret.go`). Matrix polls
([MSC3381](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/3381-polls.md))
are `m.poll.response` events, encrypted like any event in an encrypted room;
clients count only each sender's latest response before the poll ends. In all
three the server learns that somebody voted and when, never what. Polaris does
the same, with the server keeping one ballot per voter so a vote is counted
once without anybody's browser having to replay a log.

- A ballot is three bytes, the version and a 16-bit mask of the picked
  positions (`encodeBallot`), so every sealed ballot is 20 bytes whatever it
  picks. It is sealed under the conversation's `HK(c, e)` for the current
  epoch (`sealBallot`, `packages/chat-crypto/src/message-content.ts`) with
  key and nonce derived from `canonical(LABEL, "ballot", conversation, epoch,
  poll, ballotId, voter)`: `ballotId` is fresh and random per ballot, `voter`
  the account id on a public poll and empty on an anonymous one. A ballot
  moved to another poll, conversation, epoch or (public) voter does not open;
  a message never opens as a ballot or the reverse.
- `ChatPollBallot` (migration `20281203000000_chat_poll_ballots`) holds one
  row per poll and voter: one vote per person, a new ballot replaces it,
  taking the vote back deletes it (`castBallot`, `lib/chat/poll-ballots.ts`,
  `castBallotAction`). The usual checks hold: the room allows reacting, the
  poll is open, the epoch is one the group reached, the size is a ballot's.
- `readBallots` (`pollBallotsAction`, pages of 1,000 by `ballotId`) hands out
  only the reader's own ballot while a poll hides its results; an anonymous
  poll's ballots without voters, in the order of their random ids; a public
  poll's with their voters, which is what "See votes" lists in the browser.
- Each browser (`sealed-votes.ts`) opens the ballots, discards any that pick no
  answer, an answer the poll does not have, or several on a one-answer poll
  (the server cannot check this), and adds them to the counts. A plain vote on
  a sealed poll is refused (`errors.sealedOnlyReload`); a page without sealed
  chat shows the poll read-only. Votes cast in the clear before a poll took
  sealed ballots are still counted by the server, and go with that voter's
  first ballot.

What the server still knows: who has voted on which poll and when (also how
many have), not what. Limits: on an anonymous poll every member's browser can
open every ballot but not tell whose it is; the server could still tell a
member which row is whose, so an anonymous poll is anonymous to the server and
to members separately, not to the two colluding. A ballot is not signed by a
device: the server cannot make one (it holds no history key), but it could
withhold a ballot or hand back an older one of the same voter, as it could
withhold a message. Timing is visible: a member watching counts change right
after a live frame can guess who just voted, as on a plain poll.

Verified: unit tests (`packages/chat-crypto/test/ballot.test.ts`,
`apps/web/test/chat/e2ee/sealed-votes.test.ts`: ballots really sealed and
opened through the server's rules, `test/chat/poll-card.test.tsx`). Not run
in a browser yet, and the migration not yet run against a real PostgreSQL.

### Public and anonymous votes (built 2026-11-25)

Every poll, plain or sealed, is asked either anonymous or public, and the
choice cannot be changed afterwards (`ChatPoll.anonymous`, migration
`20281202000000_chat_poll_anonymous`). This follows Telegram, whose polls are
anonymous or public and fixed at creation, with a "view votes" list on a public
one; Discord's polls always show who voted, and Slack has no poll of its own
(apps such as Polly offer both modes).

- Anonymous is the default in the dialog and in the schema
  (`chatPollCreateSchema.anonymous`, and the sealed `poll.anonymous` a tab
  from before the choice omits), and every poll asked before the choice existed
  was migrated as anonymous: those votes were cast with nobody able to see them.
- An anonymous poll only ever shows counts. `readPollVoters`
  (`lib/chat/polls.ts`, `pollVotersAction`) refuses it for everybody, the asker
  and moderators included (`errors.pollAnonymous`); no export, notification or
  live frame names a voter (the "posted" frame carries no actor).
- A public poll gets "See votes" on the card once its counts show: who picked
  each answer, up to `MAX_POLL_VOTERS_LISTED` per answer with "and N more". A
  poll that hides its results keeps the list back until it closes
  (`errors.pollVotersHidden`).
- One vote per person and changing your vote work the same in both modes.
- Meeting chat polls are answered by seats, half of them guests, and stay
  count-only; the dialog does not offer the choice inside a call.

What the server still holds for an anonymous plain poll: the vote rows (who
picked which answer), which one vote per person and changing your vote are
enforced from. No screen or API reads them back as names; the database itself,
and so a database backup, still has them. In a sealed conversation it holds
sealed ballots instead (see "Sealed votes").

Verified: unit tests (`apps/web/test/chat/e2ee/sealed-polls.test.ts`,
`test/chat/polls.test.ts`, `poll-card.test.tsx`, `poll-dialog.test.tsx`). Not
run in a browser yet.

## Migration of existing chats (built 2026-11-25)

`lib/chat/e2ee/legacy-migration.ts`, run by the dashboard every 10 minutes
(`instrumentation-node.ts`, one process via `whenAlone`). Nothing runs while
sealed chat is off, or while there is no available backup of Polaris's own
database (`ProtectedResource` kind `polaris-database`) from the last 24 hours
(proposal 8.5). Per conversation with plain text messages:

1. `HK(c, legacy)` and a one-time Ed25519 key are made in memory. `HK` is sealed
   to every member account key (`ChatHistoryKey`, epoch `LEGACY_EPOCH` =
   2^63-1, above any epoch an MLS group reaches) before anything is sealed
   under it. Nobody with an account key: `pending` / `noAccountKey`.
2. Every `kind = "text"` row with words and no device seal is sealed exactly as
   a browser seals one: same content (`encodeSealedContent`, with its
   translation), `messageId` its `clientKey` (set to the row id when it had
   none), sender leaf 0, device `migration`, signed by the one-time key. Its
   edit history is revisions 0..n-1, the message revision n. Readers open these
   with no change (`openStored` checks the row's signature key and fetches
   the account envelope for the epoch).
3. M3: every row is opened again with `HK` and compared with its plain text; a
   row edited meanwhile is sealed again; a version that does not open to its
   text, or text a reader could not open, leaves the conversation `failed`,
   exactly as it was.
4. Cut: state `cut` (from then `conversationSealed` refuses plain writes), then
   each row's text is moved to `ChatMigrationRollback` and emptied in one
   transaction, guarded on the text still being what was verified. Rows that
   raced the cut are sealed in up to five catch-up rounds; any left are
   logged and recorded as `reason = stragglers`.
5. `HK` is zeroed. A cut is never repeated: the key is gone.

Resumable: any state but `cut` clears what an earlier run sealed (those rows
still hold their text) and the legacy envelopes, then starts over. Deleting a
message deletes its rollback copy; deleting a conversation deletes its state
and copies (foreign keys, migration `20281130000000_chat_legacy_migration`).

Verified: unit tests (`test/chat/e2ee/legacy-migration.test.ts`: the seal
verifies and opens with the reader's checks, bindings, envelope to an account
key) and one run against a real PostgreSQL 17 with every migration applied: a
crashed half-done run resumed, two messages and one edit sealed, verified and
cut, envelopes for both members, the history opened with a member's account
key and every signature checked, the rollback copy holding the three texts,
plain writes refused, a second run changing nothing, and the state and copies
gone with the conversation. Not exercised: a running dashboard doing it on its
timer, a large instance (throughput unmeasured).

### Rollback, purge and late members (built 2026-11-25)

- **Admin line** (Management > Security, only while sealed chat is on): how
  many conversations with earlier history are sealed, a warning while no
  backup from the last day exists, the failed count, and the 20 latest
  conversations an admin can act on. A direct or group message is named
  "Direct message": who talks to whom is not the admin's to see.
- **Rollback** (`rollBackConversation`, audit `chat.migration.rollback`): for
  a cut conversation inside the 30 days, each message still holding the
  migrator's seal gets its text, translation and edit history back from its
  copy and loses the seal, one transaction per message, guarded on the row
  still being the migrator's. A message edited sealed after the cut keeps its
  seal and copy (`reason = keptEdited`). The legacy envelopes go once no row
  needs them. State `rolledBack`: the migrator skips it until "Seal it again"
  (`migrateAgain`, audit `chat.migration.retry`) puts it back to `pending`.
  New writes stay sealed only if the conversation has its own MLS group.
- **Purge** (`purgeRollbackCopies`, every pass while sealed chat is on, before
  the backup gate): copies older than 30 days are deleted 1,000 at a time.
  After that a cut conversation cannot be rolled back (`expired`).
- **Late members**: the server forgets `HK(c, legacy)` at the cut, so a member
  with no account key then has nothing to open that history with. Before
  each send a member's browser asks `legacy-key-gaps` (at most every ten
  minutes per conversation): answered only to a member holding a legacy
  envelope, it lists up to 100 people in the conversation's audience who have
  an account key and no envelope; the browser seals the key it opened to each
  and stores them with `put-history-keys` (first write wins). The audience is
  the one the migration sealed to, so this gives the history to nobody the
  plain history was not shown to. Same trust in server-given account keys as
  every epoch's envelope (row 7).

Verified: `test/chat/e2ee/legacy-rollback.test.ts` (restore, kept rows,
envelopes kept while needed, refused when not cut or expired, repeatable,
migrate again, batched purge, the gap query, the browser sealing to a late
member's account key and that key opening it, the throttle). Not exercised:
a real PostgreSQL (the purge is raw SQL on `ctid`), the card in a browser.

## Sealed forum posts (built 2026-11-25)

With sealed chat on, a new post (`sendForumPost`, `forum-view.tsx`) seals its
title inside the content of its first message (`title` in the sealed content),
with the words and files, and `send-sealed` carries only `forum: { tagIds }`.
The server (`sealed-messages.sendSealed`) writes the `ChatForumPost` row with an
empty title in the same transaction as the message, under every forum rule
(`checkForumPost`); in a media forum a sealed file stands in for the picture or
video, whose type only the seal knows, and the sender's composer holds it to the
rule. A forum post from Polar or a webhook, or one that is also a poll, is
refused (`forumRefused`).

Readers name the post from its opened first message (`sealed-forum.ts`:
`hasSealedTitle`, `openedPost`). A search sends back every sealed post beside
the plain title matches, and the browser keeps the ones whose title or words
hold what was typed; the device search index records the title with the words.
A sealed title changes only by a sealed edit of the first message (so by its
author, inside the edit window); `updatePost` refuses a plain title for it with
`errors.sealedOnly`, and tags stay beside the post on the server, which filters
on them. A post migrated from before the group keeps its plain title (row 5).

What the server still sees: that a post exists, its tags, when it was opened
and its last activity.

## Sealed reports (built 2026-11-25)

A moderator has to read what was reported, and the server cannot read a sealed
message. So the reader hands that one message over: the report dialog
(`report-dialog.tsx`, `sealedIn`) asks this browser's device for the message's
own key and nonce (`discloseSealed`: the HKDF output of `HK(c, e)` for that
message's binding, `messageDisclosure` in `@polaris/chat-crypto`), and only
once the stored row's signature checks and the message opens here. It goes
with the report as `disclosure`, 44 bytes in base64url.

The disclosure opens that version of that message and nothing else: every
message and every revision derives its own key from its own binding, and HKDF
says nothing about `HK`. The server does not take the words on the reporter's
word (`e2ee/sealed-report.ts`, `openReported`): the stored ciphertext must carry
the sender device's signature under the key held for that device, and the
disclosure must open that same ciphertext under its binding (conversation,
epoch, message id, sender leaf, revision). A reader cannot put words in the
sender's mouth - finding a second key that passes GCM's tag over a signed,
fixed ciphertext and AAD is a 2^-128 guess - nor point a disclosure at another
message. What opens is copied onto the report as its excerpt, post title first,
under the same greeting rule as a plain report.

A disclosure that does not open the message is refused (`reportSealedUnreadable`,
"reload and report again"). A report with none - an older client, a device
that cannot open the message - is filed with no excerpt rather than refused, so
reporting never stops working.

A report of a whole conversation carries its last five lines the reporter can
read (`report-context.ts`). The sealed ones among them are handed over the same
way, one disclosure each: the dialog asks which of those lines are sealed
(`conversationReportSealedAction`, the same rows the report will take, behind
the same access check), its device discloses each that opens here
(`discloseSealedMany`), and the report goes with `disclosures`, by message id,
five at most. `recentReadable` opens each with `openReported`; a line with no
disclosure goes with no words, a disclosure that does not open its line refuses
the report (`reportSealedUnreadable`), and a disclosure for a message that is
not among those lines is never read. A report of a person from a conversation
(`safety-queue.ts`, `personReportSealedAction`) carries their sealed lines the
same way; a disclosure that does not open refuses it as "That account could not
be reported."

A reported sealed message's files: what opens with the disclosure names, per
file, its key, digest, name, type, size and shape, and `copyOntoReport` writes
those onto the report's file row (`ChatReportFile.sealedKey`, `sealedDigest`,
migration `20281206000000_chat_report_sealed_files`, additive). The queue
draws it by its real name and shape, and the moderator's route
(`/api/chat/reports/[reportId]/files/[fileId]`) opens it whole with that key
(`readReportFile`, `openFile`, no ranges) and checks the digest: bytes that do
not open to it answer "gone", never as it. The key opens that one file and
nothing else. A sealed file reported without a disclosure stays the sealed blob,
drawn as "file"; a second press with one gives the rows their keys.

## Sealed only (built 2026-11-24)

A conversation with an MLS group takes only sealed writes from people. The check
sits in the one place every person-authored message passes through:
`messages.send` refuses a send that carries no sealed columns
(`refusePlainIfSealed`), `messages.edit` refuses a plain edit of an older plain
message, and `scheduleMessage` refuses at scheduling time, because a scheduled
message is stored in the clear until it goes. The sentence is
`errors.sealedOnly`; it is what a call to the API or a kind of message with no
sealed form yet (row 3: locations, invite and
game cards) gets in a sealed conversation. A browser with sealed chat on never
reaches it with text, because its outbox seals every text send.

The page that does not seal is told to reload (`errors.sealedOnlyReload`,
`messages.refusalForPage`). The desktop app, the extension and the phone apps
draw chat from the instance's own pages, so the client that sends text in the
clear into a sealed conversation is a page loaded before sealed chat was on
there: a tab left open across the update, a desktop window not reloaded since.
`sendAction` (the `/api/chat/send` route) and `replyFromNoticeAction` answer
that sentence, since a page that seals never sends text through them.
`editAction` answers it unless the page says it seals (its second argument,
`sealedChatActive()`; a build from before that sends nothing and is told to
reload): a page that seals still edits a plain message from before the group in
the clear, which reloading would not fix, so it keeps `errors.sealedOnly`
until that edit has a sealed form (row 5). Scheduling keeps `errors.sealedOnly`
everywhere: no page can schedule sealed yet.

Not refused, on purpose: what the server writes itself - Polar's and Tasks'
answers (`agent-message.ts`; Polar's go sealed through `polar-member.ts` when
the conversation is), join and leave notices, activity cards, copies of a
followed announcement channel. The server authored that text, so storing it in
the clear tells it nothing it did not already hold; each still needs its sealed
form for row 3, so a reader's screen shows one kind of row. While
`POLARIS_INTERNAL_CHAT_E2EE` is off, `conversationSealed` answers false before
touching the database and nothing is refused anywhere.

## Proposal: the organisation recovery key (not built)

Goal: an account that loses every factor of its own gets its account key and
history back without the server ever being able to do it alone (proposal 3.4
mode A). Nothing below needs a new `.env` key.

- **The key.** `ORK` is an X-Wing HPKE pair (the account key's suite,
  `@hpke/hybridkem-x-wing`, its own label), one per organisation and one for
  the instance (the shared chat), each with a version. It is generated in a
  custodian's browser, never on the server.
- **Custodians and quorum.** The admin who sets it up names N custodians among
  the organisation's admins and a threshold M (proposal: 2 of 3; 1 of 1 allowed
  on a single-admin instance with the security screen saying so). The private
  key is split with Shamir M-of-N over GF(256) in the browser, through a vetted
  implementation in `core-rs` and the existing wasm build, never a hand-rolled
  one; each share is HPKE-sealed to that custodian's account key
  (`hybrid-envelope.ts`) and the whole key is wiped. The server stores only the
  public key and the sealed shares.
- **Why the server cannot swap it.** The public key goes out inside a statement
  `{orgId, version, publicKey, custodians, M}` signed by every custodian's
  account signing key. A client seals to `ORK` only after checking at least M
  signatures from admins of that organisation whose account keys it has
  verified (with 4.6, through the transparency log). A statement it cannot
  verify means nothing is sealed to `ORK`, never a fallback.
- **What is sealed to it.** (a) The `org` history-key envelope:
  `sealHistoryKey` adds one envelope per epoch for the conversation's `ORK`
  (the organisation's for an organisation conversation, the instance's for the
  shared chat, one per organisation for a DM across organisations), bound to
  channel, epoch and `ORK` version. (b) An `org` account-key lock: the account
  key sealed to its organisation's `ORK`, written by the account's own browser
  after sign-in like the other locks. (c) Legacy history the migration seals for
  members with no account key.
- **Recovery.** After a full sign-in (with the second factor if the account has
  one), the recovering browser opens a request carrying a fresh ephemeral HPKE
  key. Each approving custodian's browser opens its share with its own account
  key and reseals it to that ephemeral key; the server only relays sealed
  shares. With M shares the recovering browser rebuilds the private key in
  memory, opens the account's `org` lock, re-creates its own locks and wipes
  `ORK`. Every request and approval goes into the chained audit log and
  notifies the account and every custodian; requests expire and are rate
  limited per account.
- **Rotation.** A custodian change makes a new version. Old versions stay valid
  for what was sealed under them until a custodian's browser, with the quorum,
  rebuilds the old key and reseals its envelopes to the new version in batches;
  then the old shares are deleted. A departing custodian's share alone opens
  nothing below M.
- **No-intervention delegation** (proposal 3.5) stays a separate,
  off-by-default setting that the security screen labels as server custody for
  the accounts it covers.
- **Schema (additive).** `ChatRecoveryKey` (`orgId` null for the instance,
  `version`, `publicKey`, `statement`, `signatures`, `threshold`, `createdAt`,
  `retiredAt`), `ChatRecoveryShare` (`keyId`, `custodianId`, `envelope`),
  `ChatRecoveryRequest` and `ChatRecoveryApproval` (sealed share, expiry). The
  `org` envelope reuses `ChatHistoryKey` with a recipient kind.
- **Owner decisions.** Default threshold, whether mode B (no `ORK`) is offered
  per organisation, and the request expiry.
