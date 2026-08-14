# The vault

Polaris keeps passwords, keys and secrets in a vault that it cannot read, and
speaks the Bitwarden client protocol so the apps people already use - the browser
extension, the phone, the CLI - work against it.

## What is encrypted, and by whom

| Thing | Encrypted where | Polaris can read it |
| --- | --- | --- |
| Vault items (logins, notes, cards, identities, SSH keys) | The browser or the client | No |
| Sends | The browser or the client; the key is in the link's fragment | No |
| Snippets | The server, under `POLARIS_MASTER_KEY` | Yes - which is what lets it highlight and search them |
| Sealed snippets and sealed drop-point submissions | The browser; the key is in the link's fragment | No |

The master password is never sent. The browser derives a key from it, wraps the
vault's own key under that, and hands over the wrapping. Losing the master
password loses the vault; no administrator can reset it.

## Connecting a client

Point any Bitwarden client at:

```
https://<your polaris>/vault
```

Clients derive the rest from it (`/vault/api`, `/vault/identity`,
`/vault/notifications`, `/vault/icons`). The paths are served by a rewrite in
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
  screens.
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
  role). Read-only from clients; done in Polaris.
- The breached-password report, and the `/api/hibp/breach` endpoint behind it.

## Where things live

```
packages/core/src/vault.ts              the wire vocabulary (types, EncString)
packages/core/src/schemas/vault.ts      what a request may contain
apps/web/src/lib/vault/crypto.ts        the browser's cryptography (never imported by the server)
apps/web/src/lib/vault/api/routes.ts    every path the surface answers
apps/web/src/app/(app)/vault/           the Polaris screens
apps/web/src/app/vs/[id]/               the public Send viewer
```

`lib/vault/crypto.ts` is pinned against Bitwarden's own test vectors in
`test/vault/crypto.test.ts`. A change there that passes the tests keeps every
client working; one that does not would produce a vault only Polaris can open,
and nothing in the app would say so.
