# The vault

Polaris keeps passwords, keys and secrets in a vault that it cannot read, and
speaks the Bitwarden client protocol so the apps people already use - the browser
extension, the phone, the CLI - work against it.

## What is encrypted, and by whom

| Thing                                                    | Encrypted where                                              | Polaris can read it                                   |
| -------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| Vault items (logins, notes, cards, identities, SSH keys) | The browser or the client                                    | No                                                    |
| Sends                                                    | The browser or the client; the key is in the link's fragment | No                                                    |
| Snippets                                                 | The server, under `POLARIS_MASTER_KEY`                       | Yes - which is what lets it highlight and search them |
| Sealed snippets and sealed drop-point submissions        | The browser; the key is in the link's fragment               | No                                                    |

The master password is never sent. The browser derives a key from it, wraps the
vault's own key under that, and hands over the wrapping. Losing the master
password loses the vault; no administrator can reset it.

## How long a browser keeps it open

The opened key lives in the browser, in a session shared by every vault screen
(`vault-session.tsx`) so moving between them does not ask for the master
password again. How long it may be kept while idle is the account's own setting
under Vault settings:

| Choice | Where the key is kept |
| ------ | --------------------- |
| As soon as I leave the vault | Memory only. Leaving `/vault` drops it. |
| 1 minute to 4 hours | The tab's `sessionStorage`, with a deadline that moves forward while the vault is used. |
| When I close the tab | The tab's `sessionStorage`, with no deadline. |

Never `localStorage` and never a cookie: `sessionStorage` is per tab and is gone
when the tab closes, so nothing survives to disk or to the next browser session.
Anything running in this origin can read the key either way - a key in memory is
not hidden from script already on the page - so what the setting buys is the
size of the window, which is why the strictest choice is offered and is one
click away.

## Sharing

A **folder** is how one person arranges their own vault. Its name is encrypted
under their own key, so it can never mean anything to anybody else, and it is
not how a password is shared.

A **collection** is. It belongs to an organization, everything in it is
encrypted under that organization's key, and holding that key is the whole of
access - being on the Polaris roster is not enough and cannot be made enough.
Somebody who already holds it has to wrap it to your public key first, in their
browser. That step is what `/vault/shared` exists for:

- Giving an organization a vault mints its key and pair in the browser and wraps
  the key to the creator's public key, so the server never sees an openable one.
- Adding somebody puts them on the list and hands them nothing. "Let them in"
  unwraps the organization's key in an administrator's browser and wraps it
  again to that person's public key.
- The Polaris permission `vault.manage` gates who may do any of that. It gates
  the SHAPE of the vault, never its contents: a permission cannot hand over a
  key.
- Sharing one item into a collection is one-way, from the item itself. It is
  re-encrypted under the organization's key and the personal copy is replaced.

Somebody removed from a vault keeps whatever they already synced - a key cannot
be un-given - so change what they knew if it matters.

## Connecting a client

Point any Bitwarden client at:

```
https://<your polaris>/vault
```

Clients derive the rest from it (`/vault/api`, `/vault/identity`,
`/vault/notifications`, `/vault/icons`, `/vault/events`). The paths are served by a rewrite in
`next.config.mjs` into `app/api/bw/[...path]`, which dispatches the route table
in `lib/vault/api/routes.ts` - that file is the list of everything the surface
answers.

Sign in with the address on the Polaris account and the master password. If the
account has an authenticator armed in Polaris, the client asks for a code from
it: the vault's second factor IS the account's, not a second one.

## What is deliberately different from Bitwarden's own server

- **No registration from a client.** Accounts are made in Polaris; a client's
  "create account" is refused with a message saying so.
- **No personal API keys.** The `client_credentials` grant is not offered: it
  would be a second credential for the vault with none of the master password's
  guarantees.
- **Organizations are set up in Polaris.** Clients read them and work inside
  them, but creating an organization vault and confirming a member both need a
  browser holding an unlocked vault to wrap a key, so both live in the Polaris
  screens (`/vault/shared`).
- **Icons are fetched by this server**, not by Bitwarden's icon service - a
  request per saved site is a list of the sites somebody has accounts on.
- **The notifications hub answers `negotiate` with no transports.** Polaris does
  not push yet, and a client told a WebSocket exists would hold an idle
  connection open instead of syncing on its own schedule.
- **Send links minted by Polaris use `/vs/<id>#<key>`**, a public path. The
  `<origin>/vault/#/send/...` shape an official client mints lands inside the
  dashboard, which asks a stranger to sign in - so for somebody outside, copy the
  link from Polaris.

## Not implemented yet

Named here rather than left to be discovered:

- Emergency access (Bitwarden's trusted-contact recovery). The tables exist; the
  flows do not. Polaris has its own account successor, which is a different
  thing and does not reach the vault.
- Push notifications, and therefore live sync between clients. They sync on
  their own schedule.
- Organization member management from a client (inviting, confirming, changing a
  role). Read-only from clients; done in Polaris at `/vault/shared`.
- Per-collection access rules from a screen. The rows and the endpoint exist
  (`setCollectionAccessAction`), and today every confirmed member of an
  organization reaches all of its collections.
- Reading a KeePass `.kdbx` directly. It is a database rather than an export;
  KeePass writes XML or CSV from File > Export and both are read.
- The breached-password report, and the `/api/hibp/breach` endpoint behind it.

## Where things live

```
packages/core/src/vault.ts              the wire vocabulary (types, EncString)
packages/core/src/schemas/vault.ts      what a request may contain
apps/web/src/lib/vault/crypto.ts        the browser's cryptography (never imported by the server)
apps/web/src/lib/vault/portability.ts   reading and writing every import/export format
apps/web/src/lib/vault/api/routes.ts    every path the surface answers
apps/web/src/app/(app)/vault/           the Polaris screens
apps/web/src/app/(app)/vault/vault-session.tsx  where the opened key is held
apps/web/src/app/(app)/vault/share-actions.ts   the organization side
apps/web/src/app/vs/[id]/               the public Send viewer
```

## Import and export

Both run entirely in the browser; the file holds passwords in the clear either
way, and handing it to a server that cannot read a vault would undo the point.

Read: Bitwarden's unencrypted JSON, KeePass 2 XML (what KeePass and KeePassXC
write from File > Export), and CSV from anything else - the columns are matched
by vocabulary rather than by position, so a KeePass 1 export whose title column
is called "Account", a LastPass file whose folder column is called "grouping"
and a browser's export all read correctly. Folders survive.

Written: the same three. `test/vault/portability.test.ts` round-trips each one.

`lib/vault/crypto.ts` is pinned against Bitwarden's own test vectors in
`test/vault/crypto.test.ts`. A change there that passes the tests keeps every
client working; one that does not would produce a vault only Polaris can open,
and nothing in the app would say so.
