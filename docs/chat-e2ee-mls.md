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
`put-history-keys`). Each device that reads it seals it to its own account as
well; the first envelope per account and epoch wins. `historyKey(channel,
epoch)` returns the key this run holds, else opens the account's envelope - how
an account's new device reads the past. Sealing needs the account key's HPKE
pair (`account` option, once unlocked); without it a device still reads keys in
the group. Every application message carries a one-byte kind: 0 content, 1 a
history key.

Crash safety: an operation's state changes and its request are written in one
transaction before the request is sent. A commit the server took while the
device never heard the answer comes back `staleEpoch` on resend; the device then
finds its own commit in the log and merges it.

In a browser the member is the WebAssembly build staged at `public/core-rs/mls`
(by `scripts/copy-core-rs-assets.mjs`, digest-named, fetched only when a device
is opened), the state is `IndexedDbMlsStore`, and the device id and group notes
are in `localStorage`.

## Not built yet

- Sealing chat message bodies with `sealMessage` and the history key, the
  `ChatMessage` columns that carry them, and the reader path.
- The `org` history-key envelope. The organisation recovery key (proposal 3.5)
  has no public key stored anywhere yet - its custodian setup is not built - so
  nothing can serve it and no `org` envelope can be sealed until it is.
- Envelopes for dormant members (accounts in the conversation with no device
  in the group, proposal 4.2 item 4): the committer seals only to itself and
  to the accounts it adds; the rest seal their own when a device reads the key.
- Server-run members (Polar, webhooks) through the Node binding and
  `mls-store.ts`.
- A per-message device signature.
