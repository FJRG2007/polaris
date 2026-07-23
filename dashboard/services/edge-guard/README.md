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
`X-Polaris-Waf` (base64 of `{d: denyCidrs, l: requireLogin}`), and the `forwardAuth`
middleware pointing here. The guard reads:

- `X-Polaris-Waf` - the per-route rule (a client cannot forge it; Traefik sets it).
- `X-Forwarded-For` - the client IP (leftmost entry). Trusts Traefik's view; behind a
  further CDN the denylist matches the CDN's forwarded IP.
- `Cookie` - the `polaris.edge` signed token, for require-login routes.
- `X-Forwarded-Proto/Host/Uri` - to build the post-login return URL.

## Environment

| Var | Purpose | Default |
|---|---|---|
| `POLARIS_AUTH_SECRET` | HMAC secret to verify edge tokens (deny-only routes need none) | - |
| `POLARIS_PUBLIC_URL` | Polaris base URL to redirect to for login | - |
| `POLARIS_EDGE_COOKIE` | Edge-token cookie name | `polaris.edge` |
| `POLARIS_EDGE_GUARD_PORT` | Listen port | `8080` |

## Fail-closed behavior

- A denylist with an unresolvable client IP -> **403**.
- A malformed `X-Polaris-Waf` header -> treated as **require-login** (never dropped).
- Deny is checked before login: a denied IP is blocked even with a valid token.
