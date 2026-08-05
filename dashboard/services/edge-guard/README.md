# polaris-edge-guard

A tiny stateless sidecar that enforces the deploy WAF's **denylist** and
**require-login** controls at the edge. Traefik forwardAuths to it for every request
to a protected route; it replies 200 (allow), 403 (block), or 302 (redirect to a
Polaris login).

## Why it exists

Traefik natively enforces an IP **allowlist** (`ipAllowList`), so that control needs
no guard. It has no native **denylist**, and a Polaris login can only be checked with
the shared secret - neither can be done in Traefik config alone. The guard fills that
gap while preserving the deploy resilience contract: it runs on the same server as
the app and Traefik, holds **no rule state** (every rule arrives per request in the
`X-Polaris-Waf` header that Traefik stamps on), and verifies login tokens **offline**
with the shared secret. So the WAF keeps enforcing when the Polaris control plane is
down; only minting a *new* login token needs Polaris up.

## Request contract

Traefik chains two middlewares ahead of the guard: a `headers` middleware that sets
`X-Polaris-Waf` (base64 of `{d: denyCidrs, l: requireLogin, a: loginUrl,
n: admittedPrincipals, y: refusedPrincipals}`), and the `forwardAuth` middleware
pointing here. The guard reads:

- `X-Polaris-Waf` - the per-route rule (a client cannot forge it; Traefik sets it).
- `X-Forwarded-For` - the client IP (leftmost entry). Trusts Traefik's view; behind a
  further CDN the denylist matches the CDN's forwarded IP.
- `Cookie` - the `polaris.edge` signed token, for require-login routes.
- `X-Forwarded-Proto/Host/Uri` - to build the post-login return URL.

## Environment

| Var | Purpose | Default |
|---|---|---|
| `POLARIS_AUTH_SECRET` | HMAC secret to verify edge tokens (deny-only routes need none) | - |
| `POLARIS_PUBLIC_URL` | Fallback Polaris base URL for a login redirect, used only when the route's rule carries none (see below) | - |
| `POLARIS_EDGE_COOKIE` | Edge-token cookie name | `polaris.edge` |
| `POLARIS_EDGE_GUARD_PORT` | Listen port | `8080` |

## Where the login lives

`a` carries the address Polaris answers on, and the guard prefers it over
`POLARIS_PUBLIC_URL`. The environment is written when this sidecar is deployed and
defaults to the LAN name, so a guard trusting it sends anyone off the network to
`polaris.local` - a name that resolves on that network and nowhere else. The rule is
rewritten whenever routes are published, so it follows the configured domain. A value
that is not an absolute http(s) URL is dropped rather than redirected to.

## Who the login admits

A rule can name the users, groups and roles its login lets through (`n`: one list per
firewall scope that named anybody, and a visitor must satisfy every list, so a narrower
scope can only restrict a broader one) and the ones it never lets through (`y`: every
scope's refusals together, and a refusal beats any list that admits the same visitor).
Naming nobody means any account, which is what require-login meant before this existed.

Each entry can carry a window (`f`/`u`, unix seconds) it applies in. It is read on
every request against this guard's clock, so a grant starts and lapses when it says it
does rather than when the holder's token happens to expire.

The token carries the principals its holder resolved to when Polaris minted it, so
this is answered offline like the login itself - and membership is therefore as fresh
as the token, not as fresh as the database.

A visitor no list names, or one a refusal names, is **403** rather than redirected:
Polaris checks the same thing before minting, from the live rule, while the guard checks
the rule its edge was last written with. On a remote server those two disagree until the
next deploy, and bouncing the visitor back would loop. The exception is a token minted
before this existed, which carries no principals at all and is sent back for one that
does - that cannot loop, because what it returns with is precisely the field it lacked.

## What a blocked visitor sees

A block answers with a page rather than a bare status: what happened, what to do about
it, the address the rules were judged against, and a reference to quote. Traefik serves
a non-2xx forwardAuth response to the client as it stands, so the page is written here.

The page never names the rule that matched - the reason stays with the decision, for the
operator, because wording that changes with the rule is a ruleset anyone can map by
probing. A client that did not ask for `text/html` gets the same facts as plain text.

The reference is generated per response and stored nowhere, so it currently identifies
nothing. It becomes the recorded block id once blocks are recorded.

## What a visitor to an empty hostname sees

Deploy hostnames sit under a wildcard, so every name in the zone reaches the edge
whether or not anything was deployed on it. The guard's proxy listener serves the page
for those, on two paths Traefik rewrites to:

| Path | Reached from | Answers |
|---|---|---|
| `/__polaris/vacant` | the catch-all router, for a name no app claims | **404**, "there is nothing running here" |
| `/__polaris/vacant/down` | an app router's `errors` middleware on 502/503/504 | **502**, "this app is not running" |

Both are served before the signed-origin check, since the point is that there is no
origin. The state is the path and not a parameter: Traefik's rewrite keeps the visitor's
own query string, so a `?state=` would be theirs to set.

Every response carries `X-Polaris-Page: vacant`. Polaris fetches the path and checks for
it before pointing the edge here at all - a sidecar too old to know these paths answers
with its generic `Bad gateway`, and an app's error page pointed at that would be worse
than the 502 it replaced.

## Fail-closed behavior

- A denylist with an unresolvable client IP -> **403**.
- A malformed `X-Polaris-Waf` header -> treated as **require-login** (never dropped),
  admitting any account: an unreadable rule must send a visitor to a login, not lock
  out the operator on their way to fix it.
- Deny is checked before login: a denied IP is blocked even with a valid token.
