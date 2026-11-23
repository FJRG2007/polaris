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
| `group` / `create-group` | read the conversation's group; create it (the first device wins, the rest get `groupExists`) |
| `commit` | accepted only for the epoch the group is at, as one compare-and-set; the loser gets `staleEpoch` |
| `application` | an MLS application message for the whole group |
| `events` | the log after a sequence number: group-wide rows and this device's own Welcomes |
| `put-history-keys` / `history-keys` | store envelopes (first write wins); read the ones sealed to the caller |
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
  device of accounts that left, the same way.
- A rejoin (external commit) first drops the device's own copy of the group
  (`forgetGroup`): a forked copy, one too far behind, or the previous attempt's
  join the server refused for a lost epoch race. A device that kept its key has
  its old leaf replaced by the external commit itself; one that lost its store
  has a new key, so once back it removes the leaf of its own address under the
  old key. A Welcome for a key the device no longer holds is skipped.
- A device that reads its own removal forgets the group; a later Welcome, or a
  rejoin the server allows (the account still reaches the conversation), brings
  it back.
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
fails either comes back with `opened: null`. Verifying needs WebCrypto Ed25519
(Node 20+, current browsers).

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
- **Search.** The server searches bodies, and a sealed one is empty, so a
  sealed message is found only by who, where, when and what is attached to it;
  its text is not searchable. Searching sealed text needs a local index on the
  device over every message it has opened, which is not built. This is the
  limit, stated where search is documented for people when the flag goes on.
- **Link cards.** Not made for a sealed message: the server makes a card by
  fetching the link, which would tell it what was sent. The link is still a
  link. A card the sender makes and seals beside the message is the way to
  have one, and is not built.
- **Edits.** A plain edit of a sealed message is refused
  (`errors.sealedNotEditable`), since it would put the new words in the clear,
  and the pencil, the menu item and the edit key are not offered on a sealed
  row (`rewritable.ts`), so nobody is shown an action only to be refused.
  A sealed edit (re-sealing under the same message id at the current epoch) is
  not built.

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

## Not built yet

- Searching sealed text, sealed link cards and sealed edits (see "Other
  places a message is shown").
- The `org` history-key envelope. The organisation recovery key (proposal 3.5)
  has no public key stored anywhere yet - its custodian setup is not built - so
  nothing can serve it and no `org` envelope can be sealed until it is.
- Server-run members (Polar, webhooks): who they are, where they reach and the
  service device are built (`service-device.ts`: the Node binding's member
  through `nativeMlsMember`, its store, outbox, notes and history keys in
  `MlsStoreEntry` under the reserved prefix `\0polaris/`, a lease per device
  address, ops in-process through `answerMls`; a service's sealed message is
  stored with no author under Polar's or the webhook's name). Not built: the
  member list's "Add Polar", Polar reading a sealed question and answering it,
  and a webhook's route posting sealed in a sealed conversation.
- Sign-out deletes the browser's MLS device, but its leaf stays in each group
  until another member removes it.
