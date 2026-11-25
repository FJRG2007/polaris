---
id: BUG-0038
title: Every page of the public domain is shown as "Not secure" although its certificate is valid
status: fixed-watching
area: dashboard
location: dashboard/apps/web/src/lib/local-address.ts
related:
  - dashboard/apps/web/src/components/connection-banner.tsx
  - dashboard/apps/web/public/offline.html
  - dashboard/apps/web/src/lib/lan-hostname.ts
  - dashboard/apps/web/src/app/(app)/vault/item-icon.tsx
  - docs/bugs/BUG-0024-integrity-flags-dynamic-route-chunks.md
  - docs/bugs/BUG-0039-integrity-flags-previous-build-after-update.md
reported: 2026-11-25
fixed: 2026-11-25
fix_commit: "3ac23e35d5"
---

## What was seen

Chrome showed a red "Not secure" on every page of the public dashboard domain.
The site panel said "Certificate is valid", and its Security panel said:
"Resources - active content with certificate errors. You have recently allowed
content loaded with certificate errors (such as scripts or iframes) to run on
this site." An incognito window showed no warning. Nothing on the server, in
the stored data or in the page's own resources loaded anything over plain
`http://`.

A false positive in the sense that nothing was intercepted or changed: the
browser was reporting, correctly, that the public page had once talked to a
host whose certificate it does not trust.

## Cause (confirmed with the edge's access log and by the reporter)

When the public domain stopped answering for a moment (two 503s), the
connection banner looked for the same Polaris on the local network:
`findLocalAddress()` sent a cross-origin `POST /api/instance/challenge` from the
public page to every address in the instance record, including the LAN IP and
`polaris.local`. Those are served with Polaris's own local CA certificate. The
reporter had at some point clicked through that certificate warning, so Chrome
let the request run and then flagged the public origin as having run active
content with certificate errors. `offline.html`, served by the service worker
when the gateway fails, made the same request.

The browser extension was ruled out: on the dashboard's own origin it only runs
the integrity check, which fetches same-origin files.

## Fix

- The public page never contacts a host served with the local CA: the banner and
  `offline.html` offer that address as a link instead of probing it.
- The LAN address gets a name under the operator's own domain
  (`lan-<ip>.<base>`), with a public certificate through the existing wildcard,
  the way Plex does it. The banner probes and switches to that name in the same
  tab, with no warning. Where the router blocks public names that point at a
  private address, or no DNS token exists, the banner only offers the link.
- Vault item icons are no longer loaded from LAN hosts.
- The LAN sign-in card offers the local CA root for installation.

## Verified / not verified

- Verified: unit tests for "a local address is never fetched yet is still
  offered", the LAN name preferred, the fallback; typecheck.
- Not verified: a real DNS record for the LAN name, the edge serving it, and
  Chrome's behaviour live.
- A browser that already accepted the certificate keeps the red mark until it is
  fully restarted.

## If it happens again

Chrome's Security panel (F12) names the cause. If it says "active content with
certificate errors", collect the origins it lists and the time; the edge's
access log on the server shows which page asked for which host.
