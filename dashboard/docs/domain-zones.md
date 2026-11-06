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
  by hand when it cannot. The record points at whichever machine's edge actually
  answers for that domain - the remote server's own address when its app is on a
  remote target and served by that server's edge, Polaris's own address otherwise -
  never at Polaris for a domain it does not serve. A remote server with no public
  IPv4 Polaris can see is left for the operator to point by hand.

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

New Java servers are routed by default, and existing ones are moved over only once it
is proven to work. The Address card still switches any one server either way. Three
things shape when a server is routed:

- The router binds 25565 on the host, so it is not running until something asks for
  it: an existing install whose first Minecraft server was pinned to that port would
  otherwise fail to start the whole stack. Routing a server starts it - the
  dashboard deploys it as its own one-service project through the daemon
  (`lib/minecraft-router.ts`), reading the network and the routes volume off its own
  container, because both are named after the compose project this Polaris was
  installed as. The `mcrouter` compose profile still works and is left alone. "Is
  the router up" is a connect to the service name `mc-router` on the dashboard's
  network, not to the host port, so a Minecraft server holding 25565 never reads as
  the router; when the port is held by something else, starting it fails and the
  server keeps its SRV record.
- Connections reach the server from the router, so the address half of the player
  list (`player-access`, which reads the address off the join line) cannot be
  enforced through it. A server is only routed while its list survives that
  (`addressesSurviveRouting`): no rule names an address (or the address half is off)
  and no linked player follows their sign-ins. The switch is read as the enforcement
  pass reads it - absent is on - so a server that never touched it is not routed and
  its players are not refused for arriving from the router.
- Routing a server removes its SRV record, so the router has to be answering first.
  For a new server the SRV record is written, then `routeNewServer` routes it and
  drops the record; any failure leaves the record. An existing server nobody
  switched (`routed` absent) is adopted by the sweep in two passes: first it is added
  to the table as a candidate (`routeCandidate`) with its SRV record untouched, and
  on a later pass the router is asked for it by name with a status ping
  (`routeAnswers`). Only a reply from the server itself switches it over. The sweep
  never starts the router for this. The table is written before a router is started:
  mc-router watches that file and exits at startup if it does not exist.

Bedrock and ARK are UDP and name no address in the connection, so they keep a port in
theirs - they just no longer cost a DNS record each.

### PROXY protocol, and why it stays off

PROXY protocol would carry the player's address through the router and let the
address half of the list work for routed servers. Checked against mc-router's own
source at the pinned tag (`server/configs.go`, v1.46.2) and the current one
(v1.54.2): `-use-proxy-protocol` (`USE_PROXY_PROTOCOL`) is one switch for the whole
router, sending a PROXY v2 header to every backend. There is no per-route setting.
The backends that accept it are Paper and its forks (`config/paper-global.yml`,
`proxies.proxy-protocol`) and Velocity (`velocity.toml`, `[advanced]
haproxy-protocol`). Vanilla servers do not, and anything not listed here is treated
the same way: a backend that does not expect the header fails every connection that
carries one.

So one router cannot serve a mixed fleet with it on, and turning it on would break
every routed server that is not Paper. Paper's setting names no trusted senders,
so a backend with it on would also take a header from anyone who dials its published
port directly, which every server here still has. Until both are solved (a second router instance for
PROXY-capable backends, and backends reachable only from the router), it stays off
and the refusal stays.

### How far one table goes

What mc-router does with the table, from its source (`server/routes_config_loader.go`):

- A change is read five seconds after the file goes quiet, as the whole file:
  `os.ReadFile`, one `json.Unmarshal`, every mapping registered again. Each write is
  O(servers) inside the router, however small the change.
- The watch registers mappings over the ones it holds and never clears first (it
  calls `Load`; only SIGHUP runs `Reload`, which resets). A name left out of the file
  stays routed to its old port. Polaris writes each dropped name with a backend on
  port 0 instead (`retiredRoutes`), so a reused port never takes an old name to
  another server's world. Retired names stay in the file.
- The watch is on the file itself. A rename over it replaces the watched inode and
  stops every later reload, so the table is written in place, not with
  `writeDynamicFile`. A half-written file fails to parse and the router keeps the
  routes it has.
- Its REST API (`POST /routes`, `DELETE /routes/{serverAddress}`, enabled by
  `-api-binding`) saves the whole table back to the same file after every call, so
  it is not cheaper per change.

On the Polaris side the table is built a page of installs at a time, with one
application query per page, and is only written when it changed.

That holds for a single host. Every route dials `POLARIS_APP_DIAL_HOST` by its
published port, so one router only serves the servers on its own host, and the servers
on one host are bounded by its own published ports. By estimate (about 70 bytes a
mapping), a few hundred thousand names is a file of tens of megabytes, re-read in
full on every change; this was not measured against a running router. Two million servers
is not one table: it is many hosts, each with its own router and its own table of
its own servers - sharding by host, the same way the edge is per host. Running the
router on each server host is not built yet. Today the router runs beside the
dashboard and routes the servers on that host.

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
dashboard's own address, the sharing domain, the names it answers on, the DNS records -
or the manual controls for settings the setup already wrote. Those (Network & exposure,
DuckDNS) sit behind an **Advanced** disclosure with a Save each, so that one setting is
never edited by two panels under one button.

The rest of the subject has pages of its own, under the Domains heading of the
Platform rail:

| Page                           | Holds                                                                  |
| ------------------------------ | ---------------------------------------------------------------------- |
| `/admin/domains/remote-access` | Backup access (relay, Cloudflare tunnel, carrier-NAT check), Tailscale |
| `/admin/domains/ports`         | Game server ports and their policy, call ports, router steps           |
| `/admin/domains/certificates`  | The `polaris.local` root certificate, the certificate contact          |
| `/admin/domains/security`      | The domain security inventory                                          |

A link to an anchor that moved (`/admin/domains#backup-access` in a notification stored
before the split) is sent on to the page that holds it - see
`apps/web/src/app/(app)/admin/domains/moved-anchors.ts`.

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
