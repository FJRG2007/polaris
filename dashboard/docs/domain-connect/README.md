# Domain Connect templates

Not active yet. These are the templates Polaris would publish so an operator whose
domain is on Cloudflare can point it at their server without pasting an API token.

## Why

Today the guided setup writes the records through Cloudflare's API, which needs a
token. Domain Connect replaces that with a redirect: the operator lands on
Cloudflare already signed in, sees the records, approves, and Cloudflare writes
them. No token, no DNS panel.

It does not replace the token everywhere. Named tunnels are created through the
API, so the token stays for that path and for any provider that does not implement
Domain Connect.

## The templates

| File | Applied at | Records |
| ---- | ---------- | ------- |
| `polaris.example.polaris-zone.json` | a zone label, or the domain itself | `plr.example.com` and `*.plr.example.com`, or `example.com` and `*.example.com` |
| `polaris.example.polaris-service.json` | one hostname | `app.example.com`, or `example.com` |

The zone template is the wildcard pair from [domain zones](../domain-zones.md),
applied once per zone. A setup with a Polaris zone and a deploy zone runs the flow
twice.

The service template covers the other way an operator gives a service a name:
attaching a domain of their own instead of taking a zone subdomain, so a service
answers on `app.example.com` or on `example.com` rather than
`app.plr.example.com`. That domain needs one record and no wildcard, and it is
often on a different domain from the zones, which is why it is a separate
template rather than a variant of the first.

Neither sets `hostRequired`, so both apply at a label or at the apex. The server
address arrives as the `%ip4%` variable.

`syncBlock` is false and `syncPubKeyDomain` is set because Cloudflare only supports
the synchronous flow and requires every apply URL to be signed.

## What is still missing

1. **A signing key.** Generate an RSA keypair. The private half never enters this
   repo or a Polaris image.
2. **The provider domain.** `providerId` and `syncPubKeyDomain` read
   `polaris.example` here, which is a reserved name and resolves nowhere. They
   have to become a domain the project controls before the templates are
   published, and the filenames have to follow - `providerId` is the filename.
3. **The public half in DNS**, as a TXT record at `_dcpubkeyv1.dc.<provider
   domain>`, valued `p=1,a=RS256,d=<base64 public key>`. Split across records
   with `p=2`, `p=3` if it does not fit in one.
4. **A signing endpoint.** Cloudflare verifies a signature over the apply URL's
   query string, minus the `sig` and `key` parameters. A self-hosted instance
   cannot hold the private key, so the URL has to be signed by a service the
   project runs. It is only reached while an operator is setting a domain up, so
   nothing deployed through Polaris depends on it at runtime.
5. **Upstream publication.** Open a PR against
   [Domain-Connect/templates](https://github.com/Domain-Connect/templates), then
   ask Cloudflare to onboard the merged templates.
6. **The client side**, once the templates are onboarded: read the
   `_domainconnect` TXT record of the operator's domain to find the provider, then
   send them to the signed apply URL instead of asking for a token. Two entry
   points, the guided setup for zones and the domain field on a service.

`logoUrl` is omitted until there is a logo served from a stable public URL. It is
what the operator sees on Cloudflare's approval screen, so it is worth adding
before the PR.

## Changing the identifiers

`syncPubKeyDomain` can move later with a version bump and a re-onboarding.
`providerId` is the template's filename and the identity Cloudflare onboards, so
changing it after publication means new templates and deprecating the old ones -
which is why the placeholder is worth replacing deliberately rather than with
whatever is to hand. It has to be a domain the project controls rather than a
GitHub Pages address, which cannot carry the TXT record step 3 needs.
