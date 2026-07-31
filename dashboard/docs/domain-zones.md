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
- Two scopes may share a label - a Polaris zone and a deploy zone both on the base
  domain is exactly the layout above - because one wildcard record answers for both.
  Two zones of the *same* scope on one label are a duplicate and the second is
  dropped.

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

## Hostnames outside a zone

A zone hostname rides its wildcard, so the zones bound what the picker can offer. Any
other name - `app.example.com` straight on the base domain, or a name on a completely
different domain - is added as a custom domain instead, which needs no wildcard behind
it: `provisionHostnameDns()` (domain-dns) writes that one A record through the
connected Cloudflare token, and the panel reports what to do by hand when it cannot.

A record already pointing somewhere else is never repointed - the name may be a live
site - and the domain is added either way, since DNS that is not there yet only
delays the certificate.

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
3. **Domain and zones**, then the DNS records to create - with a check that resolves
   both names each zone needs and asks the hostname for an HTTP answer, plus one-click
   record creation when the domain is served by a provider Polaris can drive.

Saving writes the environment, the exposure mode, the chosen strategy and the zone
layout in one action, so they cannot drift apart. Only a wildcard strategy stores a
base domain: a tunnel publishes each service itself, so its domain lives with the
tunnel's credentials under Integrations and no DNS record is asked for here.

The strategy is kept in a Setting of its own (`domain.setup.strategy`) instead of being
read back from what it left behind, because the traces do not tell the strategies apart:
both tunnels store the exposure mode `tunnel` and no domain, and a free subdomain stores
exactly what an unconfigured box holds. Without the answer itself, reopening the setup
would offer the environment's recommendation in place of what the box is actually
running. A stored value this version does not know is treated as unrecorded, and the
layout is used to infer the strategy - the same fallback a setup saved before this key
existed gets.

Everything else on `/admin/domains` is either a question the setup does not answer - the
dashboard's own address, the sharing domain, the root certificate that makes
`polaris.local` trusted - or the manual controls for settings the setup already wrote.
Those (Network & exposure, DuckDNS) sit behind an **Advanced** disclosure with a Save
each, so that one setting is never edited by two panels under one button.

### Reopening and resuming

- Unfinished answers are kept in the browser (`localStorage`, under a versioned key and
  re-validated on read, so a shape this version cannot parse is dropped rather than
  half-applied) until the setup is saved. A reload does not throw away a half-typed
  layout. The DuckDNS token is the deliberate exception: a secret is not written there,
  so it is the one answer that has to be typed again.
- A draft that merely repeats what the server already holds is discarded instead of
  resumed - otherwise opening the setup to look at it would reopen it as an unfinished
  form. A resumed draft says so, and can be dropped with **Start over**.
- With nothing unfinished and a domain already configured, the setup opens on the DNS
  step - the state of that domain, rather than the first question again - and the
  configured domain is shown beside the step markers on every step.

### Which provider answers

The domain being typed is looked up as it goes (`src/lib/dns-provider.ts`): its
nameservers are resolved - walking up label by label, since the zone base is usually a
subdomain while only the registrable domain is delegated - and matched against a table of
nameserver fragments per provider. The nameservers are the signal rather than the
registrar, because a domain is very often bought in one place and served in another, and
it is whoever serves it that holds the records.

A hint, never a gate: the lookup is debounced, bounded to a single try with a short
timeout, and a domain that resolves nowhere yet - the normal case while typing - simply
produces none. What it decides is what the setup offers:

| Detected | Offered |
| -------- | ------- |
| Cloudflare | Polaris creates the records itself |
| Another known provider | The provider is named, plus a link straight to where that zone's records are edited wherever it has a stable URL |
| Nothing recognized | The nameservers that answered, which is usually enough to recognize who the domain is with |

An undetected provider keeps the Cloudflare offer open: a lookup that failed is not
evidence the domain is not on Cloudflare. A domain served by someone else does not get
it, since a token could only ever fail against a zone it cannot reach.

### The DNS check

The check runs on save, whenever the setup is opened while the layout is still
unproven, and on the DNS step. It records **two** separate facts, because they gate
different things and only one of them can be established reliably from this side:

| Flag | Proven by | Gates |
| ---- | --------- | ----- |
| `verified` | The zone host *and* a random name under it resolve to this server | Minting hostnames: `getNetworkStatus()` reporting `wildcard`, `deployHostname`, the zone picker |
| `reachable` | An HTTP request to the zone host is answered at all | Handing links to other people: `sharingBaseUrl`, moving the dashboard's URL, standing the fallback tunnel down |

Any HTTP status counts as an answer, including the edge's own 404 - a zone host is not
a site Polaris serves (services live *under* it), so requiring a particular response
would require something that by design does not exist. What it rules out is a refused
connection or a timeout: DNS pointed at a router whose ports were never forwarded.

The two are apart because the probe leaves this box. Plenty of routers will not send a
request back to their own public address, so a domain that works perfectly from the
internet can look dead from the inside - which must not be allowed to block minting,
or such a setup could never publish anything. It is allowed to keep the tunnel up,
where being wrong costs nothing but a redundant hop.

A wildcard base typed by hand under Advanced > Network & exposure is the operator's own
statement about DNS they manage and needs no such proof.

### Creating the records

One-click creation on Cloudflare only adds records and repoints the ones already
pointing here. A name that answers with a different address - the apex, when a zone
has an empty label - is reported back instead, and is only replaced if the operator
confirms it. Creating them runs the check again, which is where a zone is first seen
answering, so the panels below re-read what that changed - the exposure mode it promotes,
the dashboard moving onto the Polaris zone.

The API token this needs is asked for on that step rather than under Integrations: a
detour to another page mid-setup is where a domain gets put down and not picked up again.
The link opens Cloudflare's own token form with the two permissions Polaris uses already
ticked - DNS Edit to write the records, Zone Read to find the zone they belong to - so
the token is created, pasted back, and the records are written without a second button.
It is stored as the same account-level token Integrations holds (encrypted at rest), but
a token created from that link carries neither more nor less than those two permissions:
it will not provision named tunnels, which need the account-level tunnel permission the
Integrations page asks for.

## Tunnels

When no wildcard can reach the box - carrier NAT being the usual reason - hostnames
come from an outbound tunnel instead: a Cloudflare named tunnel on the operator's own
domain, a throwaway `*.trycloudflare.com` quick link, or ngrok. Each is configured
under Integrations and offered per service in Deploy.

A self-hosted option - publishing through a server the operator already owns, over a
reverse SSH tunnel - is being built on `feat/server-tunnels`.
