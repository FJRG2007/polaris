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
src/lib/matching.ts      whether an item belongs to this page, and which comes first
src/lib/lock.ts          when an open vault locks itself again
src/lib/messages.ts      what the popup may ask the worker for, as a closed list
src/entrypoints/         background worker and popup
test/                    the decisions that can do harm: what matches, and when it locks
```

The background worker owns everything that touches the network or a key, and
nothing is declared into your pages: the function that types into a form is
injected onto the tab in front of you at the moment you ask for it, and it is
handed the two strings and nothing else. A declared content script would itself
be a host permission - `<all_urls>` at install time - which is the access this
manifest is written to avoid, and a page can read anything running inside it.

## When it locks

An open vault locks itself after a spell of disuse, which you pick in the popup
under "Lock after". The key lives in the worker's memory and nowhere else, so on
Chrome it also goes whenever the browser recycles the service worker - but that is
not something to rely on: a Firefox background page is persistent and is never
recycled, so without a deadline of its own a vault there stayed open until the
browser closed. The deadline is what makes the two behave alike, and an alarm
enforces it whether or not you open the popup.

The longest choice is the browser session. There is no "never", because that would
mean keeping the key somewhere a restart cannot take it.

## Lifting it out of this monorepo

It depends on exactly two workspace packages - `@polaris/core` for the wire
vocabulary and URI matching, `@polaris/vault-crypto` for the cryptography - and on
nothing in `apps/web`. If the repository is ever split, publish those two and this
directory moves as it is, with its dependency versions turned from workspace links
into published ones.
