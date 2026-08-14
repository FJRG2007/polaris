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

| Choice                       | Where the key is kept                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| As soon as I leave the vault | Memory only. Leaving `/vault` drops it.                                                 |
| 1 minute to 4 hours          | The tab's `sessionStorage`, with a deadline that moves forward while the vault is used. |
| When I close the tab         | The tab's `sessionStorage`, with no deadline.                                           |

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

A **collection** is. It belongs to a vault, everything in it is encrypted under
that vault's key, and holding that key is the whole of access - being on the
Polaris roster is not enough and cannot be made enough. Somebody who already
holds it has to wrap it to your public key first, in their browser.

## More than one vault

Every account starts with one vault of its own. Beside it, `/vault/vaults` makes
as many as `MAX_OWNED_VAULTS` more, and an organization can be given one:

| Kind                | Who owns it              | Who may change its shape                       | What it is called            |
| ------------------- | ------------------------ | ---------------------------------------------- | ---------------------------- |
| The account's own   | The account              | Its owner                                      | "My own vault"               |
| One of your own     | The account that made it | Its owner, or a member made an administrator   | Whatever it was named        |
| An organization's   | The Polaris organization | Anybody with the `vault.manage` permission     | The organization's name      |

The two extra kinds are one row and one set of rules: a vault is a key and the
people who hold it, and "mine alone" is that with one member. Clients read both
as organizations, which is why they work in the browser extension and the phone
apps without knowing the difference.

The name is the one thing about a vault the server can read. Everything in it -
items, collection names, attachments - is encrypted under the vault's key.

### Letting somebody in, and how much they reach

- Creating a vault mints its key and pair in the browser and wraps the key to the
  creator's public key, so the server never sees an openable one.
- Adding somebody puts them on the list and hands them nothing. "Let them in"
  unwraps the vault's key in an administrator's browser and wraps it again to
  that person's public key.
- The same dialog asks how much of it they reach: the whole vault, or named
  collections, each read-only or not. It is asked the same way the first time and
  every time after, and it can be changed later without handing the key again.
- The Polaris permission `vault.manage` gates all of that for an ORGANIZATION's
  vault. It gates the SHAPE of the vault, never its contents: a permission cannot
  hand over a key. For a vault of somebody's own, owning it is what gates it.
- Being added does not need the other person's agreement, so leaving does not
  need the adder's: anybody let into a vault can leave it from the same screen.
- A scope is what the server shows a member and lets them write. The key opens
  the whole vault either way, and no arithmetic hands over half of one - so it is
  a real boundary against the clients people use and a paper one against somebody
  who keeps the key and writes their own. Share what you would not hand over
  entirely as a second vault, not as a narrower scope.

### Moving an item

Moving one item between vaults - into one, into another, or back to the account's
own - happens from the item itself. It is re-encrypted under the key of wherever
it is going and the old ciphertext is replaced; there is no row to reassign,
because which key opens it IS where it lives.

Whoever already synced it keeps their copy, and somebody removed from a vault
keeps whatever they already synced - a key cannot be un-given - so change what
they knew if it matters.

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
- **Vaults are set up in Polaris.** Clients read them and work inside them, but
  creating one and confirming a member both need a browser holding an unlocked
  vault to wrap a key, so both live in the Polaris screens (`/vault/vaults`).
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
- Member management from a client (inviting, confirming, changing a role).
  Read-only from clients; done in Polaris at `/vault/vaults`.
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
apps/web/src/app/(app)/vault/share-actions.ts   vaults, members and scopes
apps/web/src/lib/vault/orgs.ts          a vault of any kind, and who is in it
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
An export leaves out any organization item this account does not hold the key
for, rather than writing it as a row of blanks, and says how many it left out.
An import is capped at 500 folders and 10,000 items (`VAULT_IMPORT_MAX_FOLDERS`,
`VAULT_IMPORT_MAX_CIPHERS` in `packages/core/src/schemas/vault.ts`) and lands in
one transaction, so a failure part-way through never leaves folders standing
with only some of their items in them.

`lib/vault/crypto.ts` is pinned against Bitwarden's own test vectors in
`test/vault/crypto.test.ts`. A change there that passes the tests keeps every
client working; one that does not would produce a vault only Polaris can open,
and nothing in the app would say so.
