# Domain zones

Polaris hands out hostnames constantly - one per deployed service, per share link,
per preview. Zones make that a one-time DNS job instead of a per-hostname one.

## The model

A **zone** is a DNS label under a base domain the operator controls:

| Zone      | Scope   | Hostname              | Wildcard record         |
| --------- | ------- | --------------------- | ----------------------- |
| `polaris` | polaris | `polaris.example.com` | `*.polaris.example.com` |
| `plr`     | deploy  | `plr.example.com`     | `*.plr.example.com`     |

- `scope: "polaris"` - Polaris itself (dashboard, share links, drop points).
- `scope: "deploy"` - services deployed through Deploy. Several are allowed; one is
  the default new services land in.
- An **empty label** means the base domain itself, so `example.com` +
  `*.example.com` serve everything. The base can be a subdomain too
  (`plr.polaris.com`), which is how a single registered domain hosts several
  Polaris instances.
- Two scopes may share a label - a Polaris zone and a deploy zone both on the base
  domain is exactly the layout above - because one wildcard record answers for both.
  Two zones of the _same_ scope on one label are a duplicate and the second is
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

A zone hostname rides its wildcard, so the zones bound what the picker can offer on
their own. Two ways to leave that:

- **Straight on the base domain**, with no zone in front of it. The picker offers the
  base domain as an entry of its own (`BASE_ZONE_KEY` in `domain-zones.ts`) whenever no
  zone already sits on that label, and it is offered but never preselected - a name that
  resolves nowhere is a worse default than the free subdomain. It rides no wildcard, so
  the record for the exact hostname it returns is written when the domain is added
  (through the connected Cloudflare account, or the screen names the record to create by
  hand), and adding it is not gated on `domain.zones.verified` the way a zone hostname is.
- **A name on a completely different domain** is added as a custom domain instead, which
  needs no wildcard behind it either: `provisionHostnameDns()` (domain-dns) writes that
  one A record through the connected Cloudflare token, and the panel reports what to do
  by hand when it cannot.

A record already pointing somewhere else is never repointed - the name may be a live
site - and the domain is added either way, since DNS that is not there yet only
delays the certificate.

## Game servers

A game server's name lives under its game's own label - `survival.mc.example.com`,
`island.ark.example.com` - so two games' servers can never collide on one subdomain.
Each of those labels needs **one** wildcard record, and without it every server writes
an A record of its own: a zone that grows at one or two records per server, against a
provider cap that is usually 200. An operator running Polaris as hosting hits it long
before they run out of machine.

The labels are not stored in `domain.zones`. They are derived from the games whose
manager app is installed (`lib/apps/game-zones`), so a game turned on later adds its
record to the checklist and one removed stops asking for it, with nothing to migrate
and no zone left behind pointing at a game that is gone. `gameZoneRecords` names them,
the guided setup lists and creates them beside the zones proper, and
`provisionHostnameDns` then finds each new server's name already resolving here and
writes nothing.

They are checked but never counted towards `domain.zones.verified`. That flag gates
deploy hostname minting, and a game wildcard is not part of what makes the domain work

- folding it in would mean installing a game silently stopped a working instance from
  minting hostnames.

### One port for every Java server

A wildcard cannot replace the SRV record that keeps the port out of a Minecraft: Java
address, because a wildcard may only be the leftmost label - `_minecraft._tcp.*.mc` is
not one. So the SRV record was the last thing that still grew per server.

A Java client puts the address it dialled into its handshake packet, before login and
in the clear, so a router reading that field can serve every world from one port.
`mc-router` does that, watching a table Polaris writes (`lib/apps/minecraft/router-service`)
in the same shape as the edge's own dynamic config - a file in a shared volume, no API
and no token between them. A routed server costs no DNS record at all.

It is opt-in per server, from the server's Address card, for three reasons worth
keeping in view:

- The router binds 25565 on the host, so it ships behind the `mcrouter` compose profile
  and is off unless asked for. An existing install whose first Minecraft server was
  pinned to that port would otherwise fail to start the whole stack.
- Connections reach the server from the router, so the address half of the player list
  (`player-access`, which reads the address off the join line) cannot be enforced
  through it. Turning routing on is refused while that is in use rather than quietly
  weakening it.
- Turning it on removes the SRV record, so it is also refused when nothing is listening
  on the router's port - otherwise it would take a working address away and leave
  nothing in its place.

PROXY protocol is deliberately not enabled: vanilla servers do not speak it, and
turning it on while backends keep their own published ports would let a client that
dials one directly forge its source address. Bedrock and ARK are UDP and name no
address in the connection, so they keep a port in theirs - they just no longer cost a
DNS record each.

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

| Detected               | Offered                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Cloudflare             | Polaris creates the records itself                                                                               |
| Another known provider | The provider is named, plus a link straight to where that zone's records are edited wherever it has a stable URL |
| Nothing recognized     | The nameservers that answered, which is usually enough to recognize who the domain is with                       |

An undetected provider keeps the Cloudflare offer open: a lookup that failed is not
evidence the domain is not on Cloudflare. A domain served by someone else does not get
it, since a token could only ever fail against a zone it cannot reach.

### The DNS check

The check runs on save, whenever the setup is opened while the layout is still
unproven, and on the DNS step. It records **two** separate facts, because they gate
different things and only one of them can be established reliably from this side:

| Flag        | Proven by                                                         | Gates                                                                                                          |
| ----------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `verified`  | The zone host _and_ a random name under it resolve to this server | Minting hostnames: `getNetworkStatus()` reporting `wildcard`, `deployHostname`, the zone picker                |
| `reachable` | An HTTP request to the zone host is answered at all               | Handing links to other people: `sharingBaseUrl`, moving the dashboard's URL, standing the fallback tunnel down |

Any HTTP status counts as an answer, including the edge's own 404 - a zone host is not
a site Polaris serves (services live _under_ it), so requiring a particular response
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
