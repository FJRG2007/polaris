# Code integrity

End-to-end encryption and OPAQUE sign-in are only as strong as the code that runs
them. A page that was changed on its way to the browser, or on the server itself,
can read a password as it is typed or a key as it is unwrapped, and no amount of
cryptography underneath stops it. This document says how Polaris detects that the
code it runs is not the code that was built, and - as plainly - what it cannot
detect.

## Prior art

- Meta Code Verify (WhatsApp Web, Messenger): a browser extension compares the
  scripts a page loaded with hashes published by a third party (Cloudflare).
  Polaris follows the same model; GitHub plays Cloudflare's part.
- Subresource Integrity (W3C SRI): a `<script integrity="sha256-...">` the browser
  refuses to run when the bytes differ.
- Strict CSP with nonces or hashes, and Trusted Types (W3C, web.dev "strict CSP"):
  limit what a page can execute to what it was built with.
- Sigstore (cosign, Fulcio, Rekor): keyless signing tied to a CI identity, every
  signature written to a public, append-only transparency log.
- Electron fuses (`OnlyLoadAppFromAsar`, `EnableEmbeddedAsarIntegrityValidation`):
  the desktop binary refuses an app archive that was changed after it was signed.
- Android Play Integrity and iOS App Attest: the platform vouches that a request
  comes from the genuine, unmodified app on a genuine device.
- Chrome Isolated Web Apps / signed web bundles: the strongest form of the same
  idea, where the browser itself checks a signed package. Not available for a
  self-hosted origin today.

Debugger detection, code obfuscation and other "anti-tamper" tricks are not used.
They slow down the honest reader and stop no one who controls the machine.

## Threat model

| Who | What they can do | Detected? |
| --- | --- | --- |
| Someone on the network path (rogue proxy, a TLS-terminating middlebox the operator did not set up) | Replace or add a script in a page | Yes, by the browser extension on Chromium: a served file that differs from the signed manifest, or one the manifest does not list, is reported as changed |
| Someone with write access to the server's files or its image (a compromised host, a modified image pulled from elsewhere) | Serve changed scripts from the server itself | Yes, the same way - the manifest is not taken from the server |
| A compromised build on GitHub Actions | Build, sign and publish changed code | No. The signature is genuine. The Rekor log makes it public and auditable after the fact |
| Someone who controls the browser or the computer (malware, a hostile extension) | Anything | No. Nothing running inside a machine can prove that machine is honest |
| A host that answers with a build stamp no manifest exists for | Downgrade the result to "cannot verify" | Shown as "cannot verify", never as "verified" |

## What is built and signed

Every published dashboard image comes with an integrity manifest: the SHA-256 of
every script, stylesheet and WebAssembly file the web server can serve from
`/_next/static/` and `public/`. The build writes it
(`dashboard/scripts/integrity-manifest.mjs`), and the publish workflow:

1. signs it with keyless cosign under the workflow's GitHub identity, which writes
   the signature to the public Rekor log;
2. signs the image digest the same way;
3. publishes the manifest and its Sigstore bundle on the repository's `integrity`
   branch as `manifests/<build stamp>.json` and `.sigstore.json`.

The build stamp is the same opaque value `/api/version` already serves (the first
16 hex characters of the SHA-256 of the commit), so a lookup never needs the commit
itself, which a deployment does not hand out.

Anyone can check a manifest against its log entry:

```sh
cosign verify-blob manifests/<stamp>.json \
  --bundle manifests/<stamp>.sigstore.json \
  --certificate-identity-regexp '^https://github.com/FJRG2007/polaris/.github/workflows/dashboard-publish.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Who checks

**The browser extension.** On a page of a Polaris server the person added, it
asks the server for its build stamp, fetches that build's manifest from GitHub (not
from the server), hashes every script, stylesheet and WebAssembly file the page
loaded from its own origin, and compares. Three outcomes:

- **Verified** - every file matches.
- **Cannot verify** - the server has no build stamp (a source build), or no
  manifest exists for it (a build from before manifests were published, or one not
  published by Polaris' CI). Nothing is blocked; the reason is shown on request.
- **Changed** - a file differs from the manifest, or the page loaded one the
  manifest does not list. The extension covers the page with a warning, empties
  its password fields, makes them read-only and stops keystrokes reaching them.

The check runs on Chromium browsers (`dashboard/apps/extension/src/entrypoints/integrity.ts`,
registered on every saved server). Firefox's manifest v2 build cannot register a
page script at runtime, so it does not check yet.

**The desktop app.** The Polaris window runs the same check as the extension
(`desktop/src/preload/integrity.ts`, `desktop/src/main/integrity.ts`, both on
`@polaris/core/integrity` and `@polaris/core/integrity-guard`): the preload
hashes what the page loaded, the main process fetches the manifest from GitHub
through the window's own session (so a pinned local certificate still works)
and judges it. A changed page gets the same warning and locked password fields,
and the chat key's device lock (`keyWrap`) refuses it for as long as the window
lives. Fields marked `data-polaris-secret` are locked with the password fields.

**The server itself.** A minute after every start - every update is a new
start - the dashboard hashes the files of code it serves on disk and compares
them with its build's manifest from GitHub (`apps/web/src/lib/integrity/self-check.ts`).
Management > Security shows the result, with Check again. It catches an image
that was not built by Polaris' CI and files changed inside a running container.
It cannot vouch for itself against someone who controls the server, who can
change this check too; that is what the clients are for. It checks the files
against the signed manifest, not the image digest's cosign signature: the
container does not know the digest it was started from.

**The browser, on its own.** Every page carries a strict script policy
(`apps/web/src/lib/integrity/csp.ts`): a fresh nonce per response and
`'strict-dynamic'`, so an injected script does not run. It is sent
**report-only** for now; `/api/csp-report` logs what it would have blocked.
It is enforced once those reports stop, since a page that writes its own
inline script, or a prerendered page served without a nonce, would break.
SRI is not added: the `integrity` attribute travels in the same HTML as the
scripts, so it adds nothing against a changed server that the manifest check
does not already catch, and Next.js' `experimental.sri` is not in use here.

The desktop app's own code is protected by Electron fuses: `RunAsNode`, `NODE_OPTIONS` and the inspector are off, the app loads only
from its archive, and the archive's integrity is checked against the hash embedded
in the binary (`desktop/forge.config.js`). How an update is checked depends on the
system (`desktop/src/main/updates.ts`):

- **macOS**: Squirrel.Mac applies an update only when its code signature matches
  the running app's, and the app updates itself only when it is Developer ID signed.
- **Windows**: Squirrel.Windows checks each package against the SHA-1 in the
  release's `RELEASES` file. Both come from the same GitHub release over TLS; the
  package's Authenticode signature is not checked before it is applied.
- **Linux (AppImage)**: the new AppImage is checked against the release's checksums
  file, again from the same release.

So on Windows and Linux an update is as trustworthy as the GitHub release it came
from, not independently signed.

## Honest limits

- Only files are checked. The HTML document and the inline scripts Next.js writes
  into it change with every request (they carry the page's data) and cannot be
  listed ahead of time. A changed inline script is not detected by the manifest;
  the Content-Security-Policy is what limits it.
- The checker fetches a file again to hash it. A server that answers the page and
  the checker with different bytes for the same address defeats that. The fetch is
  made from the browser's cache where the browser allows it, which narrows this
  but does not close it.
- A page found changed has already run. The warning and the blocked password
  fields stop a person from typing into it; they cannot undo what its scripts did
  before the check finished, and a script that hooks keystrokes before the checker
  starts sees them. Treat "changed" as "sign out on another device and tell the
  operator", not as "contained".
- "Cannot verify" is not "safe". It is the honest answer for older servers, source
  builds, and anyone who strips the build stamp.
- Trust rests on GitHub (the repository, its Actions identity, and serving the
  `integrity` branch over TLS) and on the Sigstore log for after-the-fact audit.
  Neither the extension nor the desktop app verifies the Sigstore bundle itself.
  The only browser verifier, `@freedomofpress/sigstore-browser`, is a 0.x
  release of about 0.5 MB unpacked with two more packages of its own, and the
  official `sigstore` package needs Node. Verifying in the client also needs the
  Sigstore trusted root kept current through TUF, which is more code that runs
  before the page is judged. Revisit when a 1.x browser verifier exists.

## Mobile app attestation (designed, not built)

The Android and iOS apps will prove to the server that a request comes from the
genuine, unmodified app on a genuine device:

1. The app asks the server for a one-time challenge (random, bound to the
   session, valid for two minutes).
2. Android requests a Play Integrity token with the challenge as its nonce; iOS
   generates an App Attest key once, attests it with the challenge's hash, and
   afterwards signs each sensitive request with an assertion.
3. The server verifies: for Play Integrity, it decodes the token through
   Google's `decodeIntegrityToken` and requires `PLAY_RECOGNIZED`,
   `MEETS_DEVICE_INTEGRITY` and the challenge; for App Attest, it checks the
   attestation's certificate chain to Apple's App Attest root, the app id, the
   challenge, and a counter that only grows.
4. The result is recorded on the session. Sensitive operations (OPAQUE sign-in
   finishing, unwrapping an E2EE key) are refused only when the server's flag
   is on and the app version is one that attests.

It stays off until the app releases that attest ship, and it is never required
of the browser or the desktop app. What blocks building the server check now:
Play Integrity's server-side decode needs a Google Cloud project linked to the
Play Console listing with a service account, and App Attest needs the Apple
team id and bundle id of the published app; neither exists for these apps yet.
Self-hosted servers will verify through a small relay run by Polaris, so the
operator configures nothing.

## Not done yet

- Enforcing the strict script policy (report-only today, see above).
- Verifying the Sigstore bundle in the clients (see Honest limits).
- The server checking its image digest's cosign signature (see The server itself).
- Mobile attestation (designed above).
