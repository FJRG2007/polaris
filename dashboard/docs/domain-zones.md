# Domain zones

Polaris hands out hostnames constantly - one per deployed service, per share link,
per preview. Zones make that a one-time DNS job instead of a per-hostname one.

## The model

A **zone** is a DNS label under a base domain the operator controls:

| Zone     | Scope   | Hostname            | Wildcard record       |
| -------- | ------- | ------------------- | --------------------- |
| `polaris`| polaris | `polaris.example.com` | `*.polaris.example.com` |
| `plr`    | deploy  | `plr.example.com`     | `*.plr.example.com`     |

- `scope: "polaris"` - Polaris itself (dashboard, share links, drop points).
- `scope: "deploy"` - services deployed through Deploy. Several are allowed; one is
  the default new services land in.
- An **empty label** means the base domain itself, so `example.com` +
  `*.example.com` serve everything. The base can be a subdomain too
  (`plr.polaris.com`), which is how a single registered domain hosts several
  Polaris instances.

Each zone needs exactly two A records - the host and its wildcard - both pointed at
the server's public IP. After that Polaris mints hostnames without touching DNS
again, which is what keeps hostname allocation O(1) as services grow.

Config lives in one `domain.zones` Setting (JSON, Zod-validated on every read) and
is the single source of truth for the wildcard base: `getNetworkStatus()` derives
`wildcardDomain` from the default deploy zone, and `resolveAutoDomain()` builds
`<slug>-<hash>.<zone>` from it. A stored value this version cannot parse is treated
as unconfigured rather than trusted - a malformed layout would mint hostnames that
resolve nowhere.

## Hostnames

- Deterministic: `<slug>-<hash>.plr.example.com`, stable across redeploys, so a
  service keeps its URL.
- Random: `<random>.plr.example.com`, for unguessable or throwaway exposure.

Services on a **remote** server never get a Polaris zone hostname: the zone's
wildcard points at the Polaris host. They use their own server's domain instead -
see below.

## Per-server wildcards

Each registered server carries an optional `wildcardDomain` (`Host.wildcardDomain`,
set from the server's dialog under Servers). Services deployed there get
`<slug>-<hash>.<that domain>`, served with Let's Encrypt by that server's own edge.

Resolution order for a service on a remote server:

1. The server's wildcard domain, if set.
2. A subdomain encoding the server's IP (`sslip.io`) - public certificate when the
   address is routable, internal CA and a LAN-only label when it is not.
3. Nothing, when the server is reached by hostname and has no wildcard: there is no
   address to encode, so the UI asks for a domain instead of inventing one.

This keeps routing per-topology: a home box and a data-centre box each answer for
their own hostnames, and Polaris never inserts itself into the request path of the
services it deployed.

## Guided setup

`/admin/domains` asks three questions and applies them together, because each one
constrains the next:

1. **Where does this server run?** (`home-nat`, `home-cgnat`, `vps`, `cloud`)
   Detected first, then confirmed - no probe can see a router's port forwarding or
   a CGNAT line from the inside.
2. **How should services be reachable?** Options ranked free-first, fewest
   third-party dependencies first (`src/lib/domain-strategies.ts`). On carrier NAT,
   port-forwarding options are shown as unavailable with the reason instead of being
   hidden.
3. **Domain and zones**, then the DNS records to create - with a resolver check that
   queries a random name inside each zone (only a real wildcard answers), and
   one-click record creation when a Cloudflare API token is connected.

Saving writes the environment, the exposure mode and the zone layout in one action,
so they cannot drift apart. Only a wildcard strategy stores a base domain: a tunnel
publishes each service itself, so its domain lives with the tunnel's credentials
under Integrations and no DNS record is asked for here.

The resolver check runs on save and again on the DNS step, and it is what marks the
layout as resolving here. Everything that hands a hostname to someone else waits for
that flag: share links (`sharingBaseUrl`) and the dashboard's own URL, which the
setup only *asks* to move onto the Polaris zone - the move happens on the first
check that passes, since every invite, notification and login link is built from it.

## Tunnels

When no wildcard can reach the box - carrier NAT being the usual reason - hostnames
come from an outbound tunnel instead: a Cloudflare named tunnel on the operator's own
domain, a throwaway `*.trycloudflare.com` quick link, or ngrok. Each is configured
under Integrations and offered per service in Deploy.

A self-hosted option - publishing through a server the operator already owns, over a
reverse SSH tunnel - is being built on `feat/server-tunnels`.
