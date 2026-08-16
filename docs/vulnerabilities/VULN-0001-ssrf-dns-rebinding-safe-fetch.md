---
id: VULN-0001
title: SSRF via DNS rebinding (TOCTOU) in safe-fetch - link unfurl connects to a private address after the public one passed the check
status: fixed
severity: medium
cwe: CWE-918
stride: Information Disclosure
cvss: "4.2"
cvss_vector: CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:L/A:N
location: dashboard/apps/web/src/lib/safe-fetch.ts:118
component: chat / link-preview
reachability: AUTHENTICATED
exploitability: MEDIUM
confidence: 85
discovered: 2026-08-16
last_seen: 2026-08-16
fixed: 2026-08-16
fix_commit: null
---

## Summary

An authenticated user who can post a chat message with a link (`chat.use`) makes
the server fetch that link to build a preview card. The guard in `safe-fetch.ts`
that is supposed to keep those fetches off the internal network validates the
hostname with one DNS resolution and then hands the same hostname to `fetch`,
which resolves it a second time on its own. The two resolutions are independent,
so a name that answers with a public address on the check and a private address
on the connect walks straight past the guard and reaches loopback, the LAN, or
the cloud metadata service at 169.254.169.254. This is the classic DNS rebinding
/ time-of-check-to-time-of-use bypass, and the code's own multi-A-record defence
does not cover it.

## Root cause / data flow

External input: a URL in a chat message body. Path:

`send()` / `linkPreviewFor()` (messages.ts) -> `unfurl(link)` (link-preview.ts:146)
-> `describe(url)` -> `describePage`/`describeByOembed` -> `follow(url)`
(safe-fetch.ts:78).

Inside `follow` (safe-fetch.ts:83-104):

```
for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    if (!(await reachable(url.hostname))) return null;   // resolution #1: dns.lookup, checks every A record is public
    response = await fetch(url, { redirect: "manual", ... });  // resolution #2: undici resolves url.hostname again, then connects
    ...
}
```

`reachable()` (safe-fetch.ts:61) calls `dns.lookup(bare, { all: true })` and
returns true only when `addresses.every((a) => !core.isPrivateIp(a.address))`.
That `.every()` defends against a single response that carries both a public and
a private record at once - which is exactly what the test at
`test/chat/link-preview.test.ts:107` ("split.test" -> `93.184.216.34` + `10.0.0.5`)
asserts. It does NOT defend against the answer changing between resolution #1 and
resolution #2, because `fetch` performs its own lookup and connects to whatever
that second lookup returns. There is no IP pinning: no `setGlobalDispatcher`, no
custom undici `Agent`, and no shared `lookup` anywhere in `dashboard/apps/web`,
so the address vetted by `reachable()` is never the address `fetch` connects to.

The unit tests do not catch this because the `fetch` mock
(`test/chat/link-preview.test.ts:90`) resolves canned responses by URL string and
never re-runs DNS, collapsing the two independent resolutions into one. In
production, undici resolves the hostname itself.

The same TOCTOU is present on every redirect hop (safe-fetch.ts:114-120 re-checks
with `safeUrl` and loops back to `reachable`, but the eventual `fetch` still
re-resolves) and on the image fetch path `previewImage()` (link-preview.ts:195)
and `fetchImage()` (safe-fetch.ts:200), which reach `follow` the same way.

## Evidence

White-box source trace (repo owned by the team). No live PoC against a running
instance; the exploit requires an attacker-controlled authoritative DNS.

Attacker-controlled setup:
- Domain `rebind.attacker.example` whose authoritative DNS returns a low/zero TTL
  and alternates answers: a public IP (attacker's web host) for the first query,
  `169.254.169.254` (or `127.0.0.1`, or an internal host) for the next.

Request (as any user holding `chat.use`):

```
POST /api/chat/channels/<any-channel-i-can-post-to>/messages
(or send a plain-text message through the chat action)
body: http://rebind.attacker.example/

Then trigger the on-demand preview:
POST server action linkPreviewFor(messageId)
```

Expected (guard working): the fetch is refused because the name resolves to a
private address, `stored.ok === false`, nothing is retrieved.

Actual: resolution #1 in `reachable()` returns the public IP and passes; `fetch`
performs resolution #2, gets the private IP, and connects to it. The server issues
an HTTP GET from inside the network to the rebound address.

Exfiltration is constrained, not blind-only:
- If the internal target returns `text/html`, `describePage` (link-preview.ts:302)
  extracts its `<title>` (up to 200 chars) and `og:/meta description` (up to 400
  chars) into the preview card that is shown back to the attacker - direct
  disclosure of internal page content.
- `og:image` parsed from an attacker-served HTML page can point at a second
  rebinding host; `previewImage` then returns the raw bytes to the browser when
  the internal response content-type starts with `image/`.
- AWS IMDSv1 at 169.254.169.254 returns `text/plain`, so `describePage`'s
  `content-type includes html` check (link-preview.ts:309) blocks clean credential
  exfil through the card - the reach is confirmed but the IMDS response body is not
  returned through this channel. Blind reach of internal HTTP services and any
  state-changing GET endpoint remains.

## Impact

An authenticated chat user can make the server issue GET requests to addresses the
guard is meant to forbid: loopback services, other hosts on the LAN, and the cloud
metadata endpoint. Where an internal service answers with HTML, its title and
description are read back to the attacker through the preview card, disclosing
internal-only content. Even where the body is not returned, the attacker gains a
confirmed request-forgery primitive against the internal network (service and port
discovery by timing, and triggering of GET-actionable internal endpoints). Impact
rises to High on any deployment that exposes an internal HTTP service returning
HTML or an image, or a metadata/admin endpoint that acts on a GET.

## Remediation

Resolve the hostname once and connect to an address from that resolution - do
not let `fetch` re-resolve. Concretely, in `follow()` resolve the name (as
`reachable()` already does), reject if any/all addresses are private, then
pass the vetted address(es) to the connection so the check and the connect use
the same resolution.
With undici this is a per-request `Agent`/dispatcher whose `connect.lookup` (or
`lookup`) returns the pre-vetted address(es), keeping the original hostname for
TLS SNI and the `Host` header. Apply it on every hop, and on
`previewImage`/`fetchImage`, since all three reach the network through `follow`.
Vetting the resolved address before the connect is the fix; re-validating the
hostname string alone cannot close a TOCTOU.

## History
- 2026-08-16: discovered by Helio (source audit), status open.
- 2026-08-16: fixed. The guard now resolves the hostname inside the undici
  connector and connects to the exact address(es) it validated, so the check and
  the socket share one resolution and a rebound answer cannot slip between them.
  The `reachable` pre-check is kept as a fast refusal. `vettedAddresses` carries
  the decision and is unit-tested. Behavior for every already-covered case
  (private address, mixed public/private answer, redirect to private, credentials,
  non-http scheme, caps) is unchanged.
- 2026-08-16: the guard's own fetch and dispatcher were built from different
  copies of undici (the runtime's built-in one refuses an `Agent` it did not
  construct itself), and the connector's custom resolver returned one address to
  a caller happy-eyeballing for all of them - both broke every fetch through this
  path (link previews, their images, and Tenor GIFs) the same way a dead site
  would. Fixed by calling undici's own `fetch` alongside its `Agent`, and by
  answering the resolver's `all` option with the whole address list rather than
  the first one. See `dashboard/apps/web/src/lib/safe-fetch.ts`.
