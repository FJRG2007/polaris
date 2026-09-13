# The Polaris browser extension

The vault in the toolbar: unlock, find the login for the page you are on, fill
it. Chrome and Firefox from one source, built with [WXT](https://wxt.dev).

## Why it can speak to Polaris at all

Polaris already answers the Bitwarden client protocol at `https://<your
polaris>/vault` - that is how the official clients work against it, and it is
documented in `dashboard/docs/vault.md`. This extension is another client of that
same surface, so it adds no server code: it signs in at
`/vault/identity/connect/token`, reads everything from `/vault/api/sync`, and
polls `/vault/api/accounts/revision-date` to know when to sync again.

The cryptography is not reimplemented here either. `@polaris/vault-crypto` is the
module the Polaris web vault uses, pinned against Bitwarden's own test vectors, so
an item saved in one opens in the other by construction rather than by luck.

## Running it

```sh
npm run dev            # Chrome, with the extension loaded and reloading
npm run dev:firefox    # Firefox
npm run build          # unpacked build in .output/chrome-mv3
npm run zip            # a package to upload
```

Point it at your Polaris the first time it opens: type the address you use for
the dashboard. The extension then asks the browser for permission to talk to that
one origin - no host permission is declared in the manifest, because a
self-hosted server has no address known at build time and a wildcard would be
asking to read every page you open.

## Where things are

```
src/lib/server.ts        which Polaris this belongs to, and permission for it
src/lib/protocol.ts      the Bitwarden protocol client: sign in, sync, refresh
src/entrypoints/         background worker, popup, content script
```

The background worker owns everything that touches the network or a key. A
content script never holds either: it is handed the two strings to type into a
form and nothing else, because a page can read anything a script in it holds.

## Lifting it out of this monorepo

It depends on exactly two workspace packages - `@polaris/core` for the wire
vocabulary and URI matching, `@polaris/vault-crypto` for the cryptography - and on
nothing in `apps/web`. If the repository is ever split, publish those two and this
directory moves as it is, with its dependency versions turned from workspace links
into published ones.
