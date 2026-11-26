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
- **Automations.** "New chat message" (`chat.message`, `lib/automations/app-events.ts`)
  fires for a sealed message as for any other, with its id, conversation,
  author and thread, and an empty `body`: the server holds no words to give
  it. An automation that matches on the text never matches in a sealed
  conversation; one that reacts to "somebody wrote here" still works. Posting
  into a sealed conversation goes through the webhook's own MLS device (see
  "Server-run members").
- **Game chat** (`game-relay.ts`). A sealed message reaches a player in the
  game with no words, which the game draws as "Sent a message" with the
  author and the conversation, like the corner notice. A conversation an
  operator shows in a game's chat for everybody playing shows the same line:
  the words would need a game bridge that is a member of the group, which is
  not built.
- **Retention and compliance.** Neither reads chat: the retention sweep
  (`lib/retention-service.ts`) trims activity, the audit log and notices, and
  the compliance evidence export (`lib/compliance/*`) lists accounts, domains,
  certificates, backups and bans. Disappearing messages and "Keep in chat"
  (`keep.ts`) go by `expiresAt` alone and work the same on a sealed message.
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

## Shared search segments: the design (row 10, not built)

The device index (`sealed-search-index.ts`) finds only what this browser
opened. Proposal 6.1 closes that with index segments every member can read;
this is how it fits what is built. Decided here, nothing of it is code yet.

- **One segment, one history key.** A segment indexes up to 5,000 sealed
  messages of one conversation sealed in one epoch `e`, and is sealed with an
  index key derived from that epoch's history key: `IK(c, e) =
  HKDF-SHA256(HK(c, e), salt = channel id, info = "polaris chat index v1" ||
  epoch)`. Whoever can read the messages (holds `HK(c, e)`, the same rule as
  history visibility and `ChatHistoryKey`) can read their segment, and nobody
  else: a member removed at `e` never holds `IK(c, e+1)`. A long epoch takes
  several segments (`seq` 0, 1, ...).
- **What is inside.** Deflated, then AES-256-GCM under `IK` with the
  conversation, epoch, seq and generation in the additional data: the message
  ids with the time of each one's last edit, and an inverted index from term
  (the device index's `NFKC` + lowercase tokens) to positions in that id list.
  No words beyond the terms, no names. Padded to the next power of two from
  4 KiB, at most 512 KiB, so its size tells the server little more than the
  message count it already sees.
- **Table** `ChatSearchSegment` (additive): channel, epoch, seq, generation,
  ciphertext, nonce, the builder's device and its signature over the
  ciphertext, created at; unique on (channel, epoch, seq, generation). The
  server never reads it; deleting the conversation deletes its segments.
- **Who builds it.** The first member device that has the whole stretch open
  (it read or sent those messages), in the background after the epoch ends or
  the stretch fills, through a lease the route hands out with a
  compare-and-set (`claim-index-build`, ten minutes), so one device builds
  each segment instead of every member. Migrated history is indexed by the
  migration itself, which already holds the words.
- **Edits and deletions.** A sealed edit adds the message to a small
  correction segment of the same epoch (`generation` + 1, same key); a reader
  keeps, per message id, the entry with the newest edit time. Deletions need
  nothing: `searchSealedAction` already drops deleted and out-of-reach ids.
  When corrections pass a quarter of the base, the next builder writes a new
  base and the older generations are removed.
- **A new browser.** Lists the segments of the conversations it may read
  (`index-segments`: only epochs the account holds a history key for, newest
  first, 50 per page), fetches them in parallel, opens them in a Worker and
  searches in memory, adding the hits to what the device index finds. Recent
  results show at once, older ones as they arrive. A private window keeps
  them in memory only.
- **A lying segment.** A member could upload a segment that is wrong. Every
  hit is still opened before it is shown (a hit whose words do not match is
  left out, as today), so a bad segment can hide matches but never show one;
  a device that finds a message of a segment missing from it while opening
  the conversation rebuilds that segment. The signature names the device that
  built it.
- **What the server learns.** How many segments a conversation has, their
  padded sizes and when they were written; never a term. Deterministic search
  tokens stay rejected (proposal v1 4.4): they leak frequencies and access
  patterns.
- **Measure before building (phase 0):** segment size and build time for
  5,000 messages of 150 bytes, and open-plus-search time in a Worker for 90
  days of a busy account.

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
| 3 | **Message kinds that are still plain.** Built (2026-11-25): attachments, see "Sealed files"; polls, see "Sealed polls" (question and answers sealed; votes sealed with the tally in each browser, see "Sealed votes"; public or anonymous chosen at creation, see "Public and anonymous votes"); forum post titles, see "Sealed forum posts"; reactions, and the clear reactions and votes left from before a conversation was sealed, written 2026-11-26 (rounds 32-33, see "Sealed reactions") but not yet built, tested or run. Left: voice notes recorded in a sealed conversation ride the sealed-file path (their length and shape are inside the seal) but are not verified in a browser; scheduled messages, server-side translations, link cards, files sent to be seen once and files left in a Drive (refused in a sealed conversation, nothing sent in the clear). Until each has its sealed form a sealed conversation cannot send it. | Yes | ~56% (text, edits, replies, threads, Polar, webhooks, files - with the gallery, forum list and video stills - poll questions, answers and votes, forum post titles are sealed) |
| 4 | **Default-on switch.** Built (2026-11-25): `chatE2eeEnabled()` is `chatE2eeFrom(env, CHAT_E2EE_DEFAULT_ON)` in `flag.ts` - `1` on, `0` off, anything else the default - so turning it on is changing `CHAT_E2EE_DEFAULT_ON` to `true` in a release, on with nothing set and `0` kept as the kill switch, as `passwordLockEnabled()` does, because existing installs never get new `.env` keys (repo CLAUDE.md); tested in `test/chat/e2ee/flag.test.ts`. The kill switch never locks anybody out (built 2026-11-25, see "The kill switch"): `0` holds sealed chat - nothing new becomes sealed, every conversation already sealed keeps opening, sending sealed and refusing plain writes. Left: the flip itself (last); a held page in a browser. | Yes | ~70% |
| 5 | **Migration of existing chats** (proposal 8): built (2026-11-25, see "Migration of existing chats"): the per-conversation state (`ChatMigration`), the server-side migrator sealing every plain text message and its edit history under a one-time `HK(c, legacy)` sealed to each member's account key, verification of every row before the cut (M3), the cut (sealed only, plain text moved to `ChatMigrationRollback`), resume after a crash, the backup gate, a pass every 10 minutes from the dashboard itself. Verified against a real PostgreSQL. Built 2026-11-25 (round 26, see "Rollback, purge and late members"): the admin line (Management > Security), the per-conversation rollback from `ChatMigrationRollback` and "Seal it again", the purge after 30 days (decision 4), and members whose account key came after the cut getting the legacy key from a member's browser (`legacy-key-gaps`). Left: attachments/polls/system rows (row 3), a "history before [date]" label, members nobody holding the key ever meets again (needs `ORK`, row 6). Not verified: the admin line and rollback in a browser and against a real PostgreSQL. | Yes (owner: every existing chat migrated) | ~65% |
| 6 | **Recovery.** Password lock, passkey PRF lock, device lock and the QR hand-over exist. Missing: the organisation recovery key (proposal below), which is also what the migration seals legacy history to for members with no account key yet (proposal 8.4), and admin account recovery handing an account back with its history. Without `ORK`, an account with no factor of its own on a new browser (magic link, SSO, admin reset) loses its history. | Yes, for "nobody loses history" | ~45% |
| 7 | **Key transparency** (proposal 4.6): built (2026-11-25, see "Safety numbers"): the 60-digit safety number and its QR in a one-to-one conversation's info; scanning the other person's QR in the app; the verified mark; the key-change line in the conversation (per browser, trust on first use). Built 2026-11-26, not yet run (see "Account key log"): the append-only key log (RFC 6962 tree, signed head), the browser checking the signature, consistency with the last head it saw and inclusion of every key before the QR hand-over, a safety number, a remembered peer key or a sealed history key trusts it; each account's browsers monitoring their own entries; the group form of the key-change line (first 100 members); the log's own key recorded with a signed hand-over or an unsigned reset, browsers following a signed chain and asking the user before trusting a reset key (exactly that key, still consistency-checked); a key that rotated between asks rechecked before it is reported; a dismissed notice coming back for a different problem; the append lock as a bounded try-lock. Left: no test (written, not run), typecheck or build has run on it, nor a real PostgreSQL or browser; nothing calls `rotateLogKey`, so a master key change, the only way the log key changes today, always shows the reset notice and rests on the user's judgement; no gossip between browsers and no third-party auditor, so a fork shown to one browser alone is caught only when its own later heads meet it; no non-membership proofs (own-entry monitoring trusts the server to list every entry); the pinned log key and the last head are per browser. | Yes, for "government-grade" | ~70% |
| 8 | **Device hygiene**: built (2026-11-25, see "Device hygiene"): a signed-out browser's device is retired and its leaf leaves every group at the next member's send; a device unseen for 30 days (decision 7) likewise, and it rejoins on its own when back; retired devices are handed out to nobody; the instance limit on /admin/privacy ("Sealed chat devices", 7 to 90 days, shown while sealed chat is on, audited). Built 2026-11-26 (code and unit tests, not yet run in a browser or against a real Postgres): the organisation's own limit (only tighter, organisation settings, strictest of instance and every organisation applies per account), a "new device" security notice when an account with another device registers one, and a device list with remove on /account/sessions. Left: seeing the three screens rendered, the migration applied on a real database. | Yes, for post-compromise security | ~85% |
| 9 | **Server features that read chat text**: built (2026-11-25): moderation reports of a sealed message with its files, and the sealed lines of a whole-conversation or person report, see "Sealed reports". Built 2026-11-26 (round 30): moving a whole Polaris (Settings transfer) now re-seals the bare envelopes it used to miss - the MLS store of server-run members (Polar, webhooks), the OPAQUE server setup, automation secrets - and carries each OPAQUE record's password tag as the hash it fingerprints, keyed again on arrival (before, the setup failed to open on the new instance, every OPAQUE record was deleted, and accounts whose password was set over OPAQUE could not sign in nor open their account key or sealed history). Sealed rows, `ChatHistoryKey` and account-key envelopes travel as they are, so a sealed conversation opens after the move. Not carried by the transfer at all (every file, sealed or not): attachment and Drive bytes on disk or a storage connection; a Polar change waiting for Approve is answered as gone; a Polaris database backup is not restorable from the screen and only opens on the instance with the same master key. Confirmed 2026-11-26 (round 31), see "Other places a message is shown": retention (`lib/retention-service.ts`: activity, audit log, notices) and the compliance evidence export (`lib/compliance/*`: accounts, domains, certificates, backups, bans) read no chat table at all; disappearing messages go by `expiresAt` alone, so they expire and are kept the same sealed or not; automations get "New chat message" for a sealed message with an empty body (they are told it was sent, by whom and where, not what), and post into a sealed conversation through a webhook's own MLS device; game chat shows a sealed message as "Sent a message". Left: a sealed-aware game bridge (a server-run member, like webhooks) so a conversation shown in a game shows words again. Not checked: whether the transfer carries the new `ChatSealedReaction` rows and the sweep's `reaction`/`vote` rollback copies (the transfer names no chat table, so they should travel like `ChatPollBallot`; no round trip has been run). | Partly (export/import must round-trip) | ~55% |
| 10 | **Search on a new browser** (proposal 6.1, encrypted shared index segments): the device index finds only what this browser opened. Designed 2026-11-26 (round 31), see "Shared search segments": one segment per history-key epoch, keyed from that epoch's history key, built once under a lease, corrected by small generations, every hit still opened before it is shown. Left: phase-0 measurement, the table, the route ops and the Worker. | No (documented limit) | ~45% |
| 11 | **Web code trust** (proposal 4.7): published hash of the crypto bundle, extension and desktop checking it, strict CSP and Trusted Types on message rendering. | No for default-on; yes for intelligence deployments | ~10% |
| 12 | **Large channels**: built (2026-11-25): `reconcile` adds at most 100 newcomers per send (`ADD_BATCH`, one `claim-key-packages` call's worth); the roster's pages together could name more, which the claim refused, so every add in a channel past 1,000 leaves failed and was retried forever. The rest are added by later sends or join by their own external commit on open (decision 9). Removals go at most 100 per commit (`REMOVE_BATCH`), as many commits as it takes, all before anything is sealed: every removed leaf blanks its path and the committer then encrypts to each node left under a blank, so one commit taking out thousands could pass the 1 MiB commit limit and never land (tested: five leaving with a batch of two take three commits, and none of them opens what is sealed after). Left: steady-state commit size with a filled tree is unmeasured (phase 0). A harness is written (`apps/web/test/chat/e2ee/mls-commit-size.test.ts`, skipped unless `POLARIS_MLS_MEASURE` names group sizes, e.g. `100,500,1000`) and has not been run. Designed, not built: a Welcome without the `ratchet_tree` extension (RFC 9420, 12.4.3.3), the joiner taking the tree from the `GroupInfo` the server already stores, so a Welcome into a large group stays small. | For big spaces | ~38% |
| 13 | **Client readiness**: built (2026-11-26, see "Client readiness"): an app too old for sealed chat is refused a device and told to update; Android's sealed notices read "New message" in the reader's language; a live location ends once its conversation is sealed. Left: iOS 0.1.4 (the first with the native key store) released in the App Store. | Yes (iOS release) | ~85% |

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

## The kill switch (built 2026-11-25)

Once the default is on, `POLARIS_INTERNAL_CHAT_E2EE=0` is for an incident. It
must never lock anybody out: a conversation already sealed only has no plain
copy to fall back to (decision 4: E2EE-only after the cut), so a `0` that
404s the sealed routes, as today, makes its whole history unreadable and its
box unusable. The shape, after `passwordLockEnabled()` (stop adopting, keep
serving whoever is already on it):

- `flag.ts` answers three states: `on`; `held` (`0` set); `off` (unset with
  the default off - today's installs, where nothing is sealed and nothing
  changes). `chatE2eeEnabled()` keeps meaning `on`; a new
  `sealedChatServed()` is `on` or `held`.
- **Held stops starting**: no `create-group` (refused, so no conversation
  becomes sealed), no migration pass (`legacy-migration.ts` already answers
  `off`), no new sealed Polar or webhook member in a conversation without a
  group.
- **Held keeps serving what is sealed**: `/api/e2ee/mls` and
  `/api/e2ee/keys` answer every other op; `conversationSealed` keeps refusing
  plain writes into a sealed conversation (never a plain write beside
  ciphertext); the chat layout keeps configuring sealed chat; account keys at
  sign-in and the QR hand-over keep working, so a new browser still opens its
  history.
- **The page needs to know which conversations are sealed**: the outbox seals
  every text send while sealed chat is on, so in `held` a conversation with no
  group must send plain. The layout passes the state; the outbox seals only
  where `group` answers one (or the migration cut it) and sends plain
  elsewhere.
- Tests: the flag's three states; every route op in `held` (create-group
  refused, the rest answered); a sealed conversation in `held` reading its
  history, sending sealed and refusing plain; an unsealed one sending plain.

As built: `chatE2eeState()` / `sealedChatServed()` in `flag.ts`; every route,
action and sign-in path that serves what is sealed reads `sealedChatServed()`
(the MLS and account-key routes, `conversationSealed`, Polar's sealed device,
the QR hand-over, the device limit on /admin/privacy), and only the migration
and `create-group` read `chatE2eeEnabled()`. `create-group` answers `409
held` unless the conversation is sealed already (the migration cut it), and
the `group` op answers `sealed` beside the group, so a page can tell. The
chat layout passes `sealedHeld`; `sealsSendsIn(channelId)` (`sealed-chat.ts`)
is what the outbox, polls, files and forum posts ask before sealing: every
send while on, while held only into a conversation sealed already (asked once
per conversation; an unanswered question keeps the message waiting, never
plain). A message queued as sealed and delivered while held into a
conversation that never got a group goes plain, since that conversation is
not sealed. Tests: `flag.test.ts`, `mls-delivery.test.ts` (held),
`sealed-only.test.ts` (held), `sealed-held.test.ts`.

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

### The encrypted notice (built 2026-11-26)

WhatsApp opens every chat with a centred line, "Messages and calls are
end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read
or listen to them. Tap to learn more.", and its contact info carries an
"Encryption" row ("Tap to verify") that leads to the security code; Signal puts
"View safety number" in the conversation settings. Polaris follows WhatsApp's
placement and wording (`sealed-notice.tsx`):

- **The line** sits above the first message once there is nothing older to load
  (and above "Nothing here yet" in an empty conversation): "Messages are
  end-to-end encrypted. No one outside this chat, not even Polaris, can read
  them." with a lock. Calls are not named, because they are not sealed by MLS.
- **The lock** sits beside the conversation's name in its header.
- **Both open the explainer** (a dialog): what is sealed, and in a one-to-one
  conversation the safety number with its QR, scan and verified mark (the same
  `SafetyNumberView` as the info page); in a group, where each pair compares in
  their own one-to-one, a sentence saying so. A sealed group's info page has an
  "Encryption" row with the same text; a one-to-one keeps its "Safety number" row.
- **Only where it is true.** All three ask `sealsSendsIn` - the same answer the
  composer, polls, files and forum posts send by - so nothing is shown while
  sealed chat is off, in a conversation that still sends in the clear while it
  is held, before the answer is known, or when it cannot be had. Tests:
  `test/chat/e2ee/sealed-notice.test.tsx`. Not run in a browser.

## Account key log (built 2026-11-26, not yet run)

Nothing here has run yet: no test, typecheck or build, no PostgreSQL (the
`unnest` node read and the advisory lock), no browser. Tests are written for
the tree, the hand-over chain, the server's lock retry and key changes, and
the browser's chain, reset trust and rotation recheck, but none has run. The tree code was
cross-checked against a Python port (every inclusion proof for sizes 1-40 and
every consistency pair) and the RFC test vectors.

- **The tree** (`@polaris/chat-crypto/key-log`): RFC 6962 leaf and node hashing
  (`0x00`/`0x01` prefixes), RFC 9162 2.1.3/2.1.4 inclusion and consistency
  verifiers, a leaf per (account, key version) carrying both public keys. The
  server keeps only the leaves and the hashes of complete subtrees, which never
  change once written, so a root or proof is one indexed read.
- **The server** (`lib/chat/e2ee/key-log.ts`, migration
  `20281212000000_chat_key_log`, additive): `ChatKeyLogEntry` and
  `ChatKeyLogNode`. An append takes `pg_try_advisory_xact_lock` in its
  transaction, so two appends never take one index; a busy lock ends the
  transaction at once and is retried with a jittered backoff (6 tries, about
  1.5 s), the transaction bounded at `{ maxWait: 2 s, timeout: 5 s }`; past
  that the route answers 503 and the browser asks again later. The unique
  (account, version) makes a repeat a no-op. Nothing updates an entry or node,
  or deletes one. A key published before the
  log existed is appended the first time somebody asks for it (`ensureLogged`):
  existing installs need no backfill and no setting. The head's Ed25519 key is
  made on first use and kept sealed in the settings table
  (`chat.e2ee.keyLog.ed25519`), never in `.env`. Route `POST /api/e2ee/key-log`:
  `proofs` (at most 100 accounts, scoped to a conversation the caller reaches,
  as `account-keys` is) and `own` (the caller's newest 64 entries).
- **The log's own key** (`ChatKeyLogHandover`, same migration): every key the
  heads were ever signed with is recorded before it signs anything, with the
  head at the change. `rotateLogKey` has the old key sign the new key and that
  head (`handoverMessage`), stored before the new key is; a hand-over whose new
  key then failed to store is deleted again, the one row this module deletes,
  and nothing was ever signed by it. When the master key changes, the stored
  log key no longer opens, `storedSigningKey` makes a new one, and
  `currentLogKey` records the change unsigned: a reset, never presented as a
  hand-over. Another dashboard process that still holds the old key sees the
  newer recorded one and reloads instead of signing with it. A browser sends
  the log key it pinned (`logKey`) and gets every hand-over since, each with a
  consistency proof to the current head. **Nothing in the product calls
  `rotateLogKey` today**: the only way the log key changes on a real install is
  a master key change, which is always the reset path below.
- **The browser** (`key-log-client.ts`): every answer is checked whole or not
  used - signed by the log key this browser saw first (pinned, as a CT client
  pins its log), consistent with the last head it saw (never smaller, never a
  different root at the same size), every entry included under it. The head is
  then remembered per account in `localStorage`, only ever forward; asks run
  one at a time per account, so two answers are never checked against the same
  old head. A failed check is the server contradicting itself: it is reported
  above every sealed conversation ("keyLogFailed") and the key is not trusted.
  A log key other than the pinned one is taken only through the hand-overs
  from it (`followHandovers`): each step signed by the key before it, and each
  step's head a prefix of the current tree (a hand-over to a forked log is
  still a fork). A chain that does not reach the current key, or a signature
  that does not hold, is "log-key". A chain with a reset in it is "log-reset":
  the notice ("keyLogReset") says the log was re-keyed without the old key's
  word, and keys it vouches for are not used until the user chooses "Trust
  this key" and confirms it in a dialog. That trusts exactly the key the notice
  was shown for (`trustLogReset(ownId, key)`: a different reset since then
  trusts nothing and asks again), is spent once that key is pinned, and still
  needs the log under it to extend the head this browser saw - a reset cannot
  be used to rewind or fork it.
- **The notice** (`KeyLogNotice`): a dismissed notice stays away for the page,
  remembered by what it said - the problem kind, the reset key, or the count of
  foreign own entries - so a different problem found later in the same page is
  shown again rather than swallowed by the earlier dismissal.
- **Where it is required**: the QR hand-over (`publishedKeyVerifier`) fails
  without the log's entry for that exact key and version; a safety number is
  not shown for a key the log contradicts (`unlogged`); a peer key is
  remembered only when vouched, and while the log cannot be asked only peers
  already remembered are updated (no first sight on the server's word); a
  history key is sealed only to vouched keys, and an unreachable log fails the
  distribution, which is retried (`vouch` in `mls-client.ts`). The log answers
  an account's latest version, the keys were served a moment before, so a key
  that rotated between the two asks would look like a contradiction: a
  mismatch is checked once more with keys served afresh (`refetchServed`).
  A fresh key the log holds is not reported (the stale one is still not
  vouched, and is sealed to next time); a fresh key that still differs is
  "inclusion"; a key no longer served, or a refetch that did not arrive,
  reports nothing and vouches for nothing. A safety number whose pair does not
  match is likewise computed once more from fresh keys before it is refused.
- **Monitoring**: the account's own browsers compare every logged key of the
  current version or newer with the key they hold (`ownKeyAlarm`); one they did
  not make is what anybody else would be handed, and is shown ("keyLogForeign").
- **Group members**: `GroupKeyChangeBar` checks the first 100 members of a
  conversation (`PEERS_PER_CHECK`, one `account-keys` page) and names those whose
  key changed. Members past the 100th get no line; sealing to them is still
  checked page by page.

Limits, stated:

- **No gossip, no auditors.** A signed head is evidence, not honesty. A server
  that shows one browser a fork and never reconciles it is caught only when
  that browser's own later heads meet the fork; two browsers are never compared
  with each other and nobody outside Polaris checks the heads. CT closes this
  with gossip and monitors, WhatsApp AKD with published epoch roots audited by
  a third party.
- **No non-membership proofs.** An RFC 6962 log proves an entry is in it, not
  that an account has no other one. `own` relies on the server listing every
  entry of the account; AKD and CONIKS use a prefix tree for this.
- **Per-browser memory.** The pinned log key and the last head live in
  `localStorage`. A cleared store (or a new browser) starts over on trust on
  first use: it accepts whatever head and log key it is shown next, including
  one rewound or forked from what that browser saw before; no other copy is
  kept to catch it.
- **A master key change is a reset, and a reset rests on the user.** The old
  log key is unreadable then, so nothing can sign the change: every browser
  that pinned it shows "keyLogReset", and until its user trusts the new key its
  QR hand-overs fail and it seals history keys to nobody. A server that lies
  about a master key change gets the same notice, so the button is only as
  good as the user's reason to believe it (the copy says to trust it only when
  the administrator changed that key); what it cannot do is rewrite what the
  browser already saw. A signed hand-over exists (`rotateLogKey`) but nothing
  calls it, so no install has a planned key rollover today.
- **Entries are permanent**, even after the account is deleted (the account id
  and public keys stay). Indexes are 32-bit: 2^31 leaves.
- Verification memory (safety numbers, the verified mark) stays per browser.

Prior art: RFC 6962 and RFC 9162 (Certificate Transparency), CT clients
pinning log keys, CONIKS self-monitoring, WhatsApp Key Transparency (AKD),
IETF KEYTRANS, Signal safety numbers.

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
  (`retiredDevices`, `inactiveCutoffs`, `mls-delivery.ts`). The limit is
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
- **The limit's screen**: /admin/privacy, "Sealed chat devices" (7, 14,
  30, 45, 60 or 90 days; a value set otherwise shows as itself), shown only
  while sealed chat is on; `setSealedDeviceDaysAction` takes a whole number
  in 7-90, stores it and writes `settings.chat-sealed-device-days` to the
  audit log. The next roster and claim read it.
- **An organisation's own limit** (built 2026-11-26): `Organization.sealedDeviceDays`
  (nullable, additive migration `20281210000000_org_sealed_device_days`; null is
  the instance's limit, which every existing organisation keeps). Set from the
  organisation's settings ("Encrypted chat devices") by someone with
  `settings.manage`, only while sealed chat is served and only shorter than the
  instance's (`setOrgSealedDeviceDaysAction`, audited as
  `org.sealed-device-days`). Each account gets the strictest of the instance's
  and every organisation it belongs to or owns (`strictestDays`,
  `inactiveCutoffs`: two indexed reads for any number of accounts), and
  `retiredDevices` and `claim-key-packages` use that per-account cutoff.
- **A new device is announced** (built 2026-11-26): `registerDevice` sends the
  account's security notice (`notifySealedDeviceAdded`, links to
  /account/sessions) when a device it did not know registers while the account
  already has another. Polar and webhooks are skipped; a failed notice is
  logged and never fails the register. A browser signed out and back counts as
  new, so it is announced again.
- **The account's device list** (built 2026-11-26): /account/sessions lists the
  account's sealed-chat devices (at most 100, with when each was added and last
  used), marks "This browser" from the browser's own store without creating a
  device, and removes any other one (`removeSealedDeviceAction`: retires it,
  audited as `account.chat-device.removed`, which raises the security notice).
  A removed device still signed in rejoins as a new device, so the copy says to
  end its session too.
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
- A poll sent in the clear before its conversation was sealed is voted on
  sealed from then on (`sealedPoll` decides by the message's epoch or by
  `conversationSealed`): a clear vote there would tell the server what the
  sealed messages around it keep from it. Its earlier clear votes are sealed
  by the server's sweep (see "Sealed reactions"), or by each voter's first
  ballot, whichever comes first.

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

## Sealed reactions (built 2026-11-26, not run)

In a sealed conversation a reaction is sealed in the reactor's browser and the
counts are made in each member's browser. The server no longer learns who put
which emoji on what.

How others do it. Signal sends a reaction as an end-to-end encrypted
`DataMessage.Reaction` (`emoji`, `targetAuthorAci`, `targetSentTimestamp`,
`remove`), delivered like any message, and every client keeps the newest one
per person (`SignalService.proto` in Signal's open clients). WhatsApp
reactions are end-to-end encrypted messages naming their target message key
(`ReactionMessage` in the open `whatsmeow` client). Matrix `m.reaction` is an
`m.annotation` relation (client-server spec, "Event annotations and
reactions"): in an encrypted room the relation stays in the clear so the server can
aggregate it, and only the content is encrypted, so the key (the emoji)
leaks with it in most clients. MLS apps such as Wire send a reaction as an
ordinary application message. Polaris follows Signal and WhatsApp - nothing of
the emoji reaches the server - with the server keeping one sealed set per
person and message so a page of history loads its reactions in one read
instead of replaying a log.

- A set is all of one person's emoji on one message (at most 20, each 1-100
  bytes), padded to a fixed 2,048-byte plaintext (`encodeReactions`), so every
  sealed set is the same size whatever it holds. It is sealed under the
  conversation's `HK(c, e)` for the current epoch (`sealReactions`,
  `packages/chat-crypto/src/message-content.ts`), key and nonce derived from
  `canonical(LABEL, "reactions", conversation, epoch, message, setId,
  reactor)`: moved to another message, person, epoch or conversation it does
  not open, and it never opens as a message or a ballot.
- `ChatSealedReaction` (migration `20281211000000_chat_sealed_reactions`,
  additive) holds one row per message and person; a new set replaces it, an
  empty one deletes it (`putReactions`, `lib/chat/sealed-reactions.ts`). The
  usual checks hold: the room allows reacting, the message is readable and not
  an ephemeral answer, the epoch is one the group reached. `readReactions`
  hands out the sets of the messages a reader may read, a page of 1,000.
- A plain reaction in a sealed conversation is refused
  (`errors.sealedOnlyReload`). The browser (`app/(app)/chat/sealed-reactions.ts`)
  routes every reaction of a sealed conversation through the set, folds the
  person's earlier clear reactions on the message into their first set (the
  server drops those rows in the same transaction), and draws the counts from
  the opened sets wherever a message list is drawn (`useOpenedSealed`: the
  channel, threads, the message sheet, pins and search hits). Whether a press
  puts an emoji on or takes it off is read from the list as drawn, so an emoji
  in the reader's sealed set is taken back.
- Reactions put on before the conversation was sealed, and plain-poll votes
  likewise, are sealed by the server's sweep (`annotation-sweep.ts`, run after
  each migration pass under the same backup rule): a one-time key at a fresh
  sweep epoch (`SWEEP_EPOCH_TOP` down, one per run, just below
  `LEGACY_EPOCH`) sealed to every member first; each person's clear rows on a
  message become one set, and each clear vote one ballot (voter named only on a
  public poll); each is opened again and compared before anything is cut; the
  clear rows move to `ChatMigrationRollback` (kinds `reaction` and `vote`) in
  the transaction that deletes them, and are purged after 30 days with the
  rest. Rerunnable: each person is swept whole or not at all. Rolling a
  migrated conversation back puts them back where the set or ballot is still
  the sweep's (`annotation-rollback.ts`); one the person changed since stays.

What the server still knows: who reacted to which message and when, as a
reaction sent as a message tells Signal's and WhatsApp's servers. Limits: a
set is not signed by a device, so the server could withhold one or hand back
an older one of the same person; the sweep's key is passed on to members
whose account key came later by nobody yet (the migration's `legacy-key-gaps`
covers `LEGACY_EPOCH` only), so they do not count swept reactions until it
is; a person's clear reactions beyond 20 on one message, or an emoji over 100
bytes, are kept only in the rollback copy. A conversation with its own group
but never cut by the migration has no rollback screen, so its swept copies
only wait out the 30 days.

Verified: nothing run yet (code only, round 33). Tests written:
`apps/web/test/chat/e2ee/sealed-reactions.test.ts` (sets, server rules, the
counts and the take-back), `annotation-sweep.test.ts` (sweep, rerun,
superseded rows, rollback), `legacy-rollback.test.ts`.

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

A live location is the one person-authored write that keeps arriving after
the message: the phone's `LiveLocationService` posts a new point to
`/api/chat/location/live` every few seconds, and `moveLive`
(`lib/chat/locations.ts:164`) writes it onto a message sent earlier. A share
started before its conversation was sealed (the migration's cut, or a browser
making the group) is ended there instead of moved (`locations.ts:199`), asked
once per conversation per move, and the conversation is told so its card stops
saying "live". Sweep of every other writer of message content
(`grep -rnE "\.chat(Message|Location|Poll\w*|Attachment|Reaction|MessageEdit)\.(create|update|upsert|createMany|updateMany)"`,
2026-11-26): person-authored text goes through `messages.send`/`edit`/
`scheduleMessage` (refused above), forum posts through `forum.ts:173`, votes on
a sealed poll are refused in the clear (`polls.ts:329`), webhooks seal
(`webhooks.ts:272`); the rest are the server's own text (agent answers, notices,
activity cards, followed copies), state on a message (pins, keeps, delivery,
reads, vanish, view-once, expiry) or the migration itself. Still written in the
clear in a sealed conversation, each waiting on its sealed form in row 3:
reactions (`messages.ts:1700`) and votes on a plain poll sent before the seal
(`polls.ts:352`).

## Client readiness (2026-11-26)

Every Polaris app draws chat from the instance's own page, so what an app can
still get wrong is what it adds natively: the key store that locks the account
key's device lock, notices built outside the page, and the live location.

| Surface | How it reaches chat | Sealed state | Evidence |
| --- | --- | --- | --- |
| Desktop (Electron) | the dashboard page itself; OS notices raised by the page over IPC | ready: the page opens sealed rows; a toast opens a sealed notice on the device before it is shown | `apps/web/src/components/message-toasts.tsx:119-137`, `clients/desktop/src/main/ipc.ts:282-322`, `clients/desktop/src/main/notices.ts:59` |
| Desktop native key store | `keyStore` bridge (safeStorage) | first in desktop-v0.1.56 (commit caa836866b) | `clients/desktop/src/main/key-wrap.ts`, `clients/desktop/src/shared/bridge.ts:338` |
| Desktop User-Agent | Electron's default, never overridden (no `setUserAgent`/`userAgentFallback` in `clients/desktop/src`) | `... Polaris/<version> Chrome/<v> Electron/<v> ...`: Electron builds it from `app.name` (productName `Polaris`, `clients/desktop/package.json:3`) with spaces removed and `app.getVersion()` (`shell/common/application_info.cc`, `BuildApplicationUserAgent`). productName has been `Polaris` since the app was added (7e38cec31a), so every release sends it and no desktop change or version bump is needed | `apps/web/src/lib/chat/e2ee/client-version.ts:52`, `test/chat/e2ee/client-version.test.ts` |
| Android app, foreground | WebView of the dashboard, agent `<WebView> PolarisMobile/<v> (Android)` since the first release | ready | `mobile/android/.../AppAgent.java:18`, `HomeActivity.java:187` |
| Android background notices | native `NoticeService` reading `/api/mobile/notices` | ready: a sealed message reads the sender and "New message" in the reader's language, with `sealed: true` (Signal's "Name only" level; the service holds no MLS device, which lives in the WebView's IndexedDB) | `apps/web/src/app/api/mobile/notices/route.ts:132`, `NoticeService.java:216` |
| Android native key store | `window.PolarisKeyStore` | first in android-v0.1.15 | `mobile/android/.../ChatKeyStore.java`, `apps/web/src/lib/chat/e2ee/platform-key-wrap.ts:7` |
| Android live location | native `LiveLocationService` -> `moveLive` | ready: ended once the conversation is sealed (see "Sealed only") | `apps/web/src/lib/chat/locations.ts:199` |
| Android view-once | native `ViewOnceActivity` | refused in sealed conversations (row 3) | `ViewOnceActivity.java:87` |
| iOS app | WKWebView, `applicationNameForUserAgent = "PolarisMobile/<v> (iOS)"` since its first commit | page ready; no message notices at all (the notices stream rings calls only), not E2EE-specific | `mobile/ios/Polaris/WebViewController.swift:64`, `mobile/ios/Polaris/IncomingCalls.swift:17` |
| iOS native key store | `webkit.messageHandlers.polarisKeyStore` | first in iOS 0.1.4; **no iOS build has been released** | `mobile/ios/Polaris/ChatKeyStore.swift`, `mobile/ios/project.yml:9` |
| Browser extension | Polar side panel (`/polar/embed`), no chat, no account key | not applicable | `apps/extension/src/lib/polar-panel.ts:4-9` |
| TV, launchers, Stream Deck | counts and labels only; the deck's `chat.send` is plain and refused in a sealed conversation | ready | `apps/web/src/app/api/tv/state/route.ts:61-79`, `apps/web/src/lib/deck/core-actions.ts:171-201` |

An app older than its minimum is refused a device by the delivery route (426
`updateApp`, `mls-handler.ts:84`), and its chat shows "Update" where the message
box was, linking to the app's own update screen (`chat/outdated-app-gate.tsx`,
wired at `channel-view.tsx:2870`). Only while sealed chat is on; a browser or an
agent this cannot read is never held back. The minimums live in one place,
`SEALED_CHAT_MINIMUM` (`client-version.ts:33`), sourced from
`git tag --contains caa836866b`.

Flip checklist:

1. Desktop >= 0.1.56 published (tagged and released).
2. Android >= 0.1.15 published (tagged and released).
3. **iOS >= 0.1.4 approved in the App Store - not yet; blocks the flip.**
4. Extension: nothing needed.
5. A later client change sealed chat comes to depend on raises its row in
   `SEALED_CHAT_MINIMUM`, and is released before the flip.
6. Then `CHAT_E2EE_DEFAULT_ON = true` (`flag.ts:7`).

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
