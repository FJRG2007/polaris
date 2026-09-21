# The Polaris browser extension

Polaris in the toolbar. Chrome and Firefox from one source, built with
[WXT](https://wxt.dev).

## The first step is connecting the browser, not opening a vault

This extension connects to your **account**. You point it at your Polaris, it
shows a short code, and you approve that code in a Polaris you are already signed
in to (`/account/extension`). What it holds afterwards is one token for that
connection, and the connection is listed on your own Sessions screen beside every
browser you are signed in on - so you can see it, see where it was last used, and
end it from there, which cuts this browser off on its next request.

Your logins are the first thing that connection is used for and not the way in: a
connected extension can be let into your vault, which is a second approval made in
the vault itself, and ending the connection closes the vault with it. An account
with no vault still has a working extension - it has nothing to fill yet.

More than one account in this browser means more than one connection: Polaris
issues and ends them per account, so each one is approved on its own and travels
with the account you switch to. Ending one says nothing about the others.

An extension that was signed in to a vault before any of this existed is asked to
connect like any other, and fills nothing until it has. Its vault is kept rather
than discarded: connecting adopts it, and it is usable again the moment the
connection is approved.

A connection answers to the same controls a browser session does. It can be tied
to the address it was last seen at, from its row or by the account's rule for
computers, and one that turns up from another address is ended. Signing out
everywhere else, closing the account or an administrator ending its sessions
ends the extension's connections too.

The routes involved are `POST /api/extension/authorize`, its `/claim`, and
`GET`/`DELETE /api/extension/session` - the last of which is what a disconnection
is answered on, with a 401 that tells this browser to drop everything it holds.

## Why it can speak to the vault at all

Polaris already answers the Bitwarden client protocol at `https://<your
polaris>/vault` - that is how the official clients work against it, and it is
documented in `dashboard/docs/vault.md`. This extension is another client of that
same surface, so it adds no server code: it is let in through
`/vault/identity/connect/authorize` and its `/claim`, reads everything from
`/vault/api/sync`, refreshes at `/vault/identity/connect/token`, and polls
`/vault/api/accounts/revision-date` to know when to sync again.

Signing in is asking Polaris itself, not typing a password into this extension. A
tab opens on the dashboard, somebody who is already signed in and has their vault
open approves the request, and the vault key arrives sealed to a pair this
extension made for the exchange - the same shape as a TV app signing in to a
streaming service. The master password is not a way in: it only unlocks a vault
that has already signed in and since locked itself. More than one account can be
signed in at once; the popup's account line switches between them without
signing out.

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
src/lib/link.ts          the connection to the account: ask, collect, check, end
src/lib/protocol.ts      the Bitwarden protocol client: be let in, sync, refresh
src/lib/accounts.ts      more than one signed-in account, and switching between them
src/lib/matching.ts      whether an item belongs to this page, and which comes first
src/lib/lock.ts          when an open vault locks itself again
src/lib/unlock.ts        the master password, and why it did not open the vault
src/lib/save.ts          what was typed for a new login, before it is encrypted
src/lib/item.ts          the item to send back when only its password changes
src/lib/update.ts        whether a newer build is out, and who is going to install it
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

## Saving a login

"Save a login for this page" writes into your own vault, prefilled with the site
you are on. It is encrypted in the extension and sent to `POST /vault/api/ciphers`,
the same endpoint every other client uses.

It cannot put an item into a vault you share with somebody else, and that is on
purpose rather than missing: which collection it goes in and whose key it is
encrypted under are decisions an extension should not make for you. Do that in the
Polaris screens, where moving an item re-encrypts it under that vault's key.

"New" beside a login replaces its password, and the old one moves into that item's
history. The vault has no endpoint for one field, so this re-uploads the whole item -
which is why the item that goes out is the one that came down, with the password
swapped, rather than one rebuilt from what the extension happens to read. A field
left out of that rebuild would be a field deleted from your vault by a save that
said it worked, so `src/lib/item.ts` is a module of its own with tests that assert
every field survives. If somebody changed the same item elsewhere first, the save is
refused, your copy is refreshed, and you are told - never silently overwritten.

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

Getting back in is the master password **or** the approval again, and the locked
screen offers both. Two of the three ways a password can be refused are nothing
to do with what was typed - this browser may no longer be holding the wrapped
keys, or the extension may be too old to run the key derivation the account has
been moved to - and a password field on its own could only be read as "you have
forgotten it", which is the one thing nobody can mend. `src/lib/unlock.ts` tells
the three apart and the popup says which.

An account on Argon2id is opened through a WebAssembly build, and manifest v3
refuses to run one unless the manifest asks: the Chromium build declares
`'wasm-unsafe-eval'` for that and nothing else. Without it the master password
that opens the vault on the dashboard is refused here, so read the built
`.output/<target>/manifest.json` rather than `wxt.config.ts` after touching it.

## Finding out it is out of date

An extension loaded by hand never updates itself, and nothing in a browser will
ever mention it. So the worker asks - when the browser starts, and twice a day
after that - and the popup carries a line above whichever screen is showing when
there is something to say.

It asks **your Polaris**, not GitHub. The manifest declares no host permission,
the one origin this may reach is the one you named, and the dashboard already
makes and caches that release lookup for its own downloads page. A second host
here would be permission every install stands on, permanently, to read a version
number. The route is `GET /api/polaris/extension`, and it needs no session: a
locked vault should still be able to find out it is months behind.

What you are told depends on how this copy got here, which `management.getSelf()`
reports - the one method of that API that needs no `management` permission.
Installed from a package, the browser updates it once the store has reviewed the
new version and there is nothing for you to do. Loaded from disk, whether as an
unpacked folder or Firefox's temporary add-on, it has to be loaded again the same
way, and the line points at the steps on your own Polaris rather than repeating
them in a 360-pixel panel. Anything else - put there by other software, or by
policy - is told the same as loaded-by-hand, because Polaris cannot promise those
are being kept current.

## Lifting it out of this monorepo

It depends on exactly two workspace packages - `@polaris/core` for the wire
vocabulary and URI matching, `@polaris/vault-crypto` for the cryptography - and on
nothing in `apps/web`. If the repository is ever split, publish those two and this
directory moves as it is, with its dependency versions turned from workspace links
into published ones.
