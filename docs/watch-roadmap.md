# Watch

What Polaris knows about whether things are working, and what it should know
next. Written after reading CheckCle, which is the closest open-source thing to
the part of Polaris that watches - so the comparison below is against it
specifically, and the parts where Polaris is already further along are said
plainly rather than left out.

**Status:** ✅ done · 🟡 partial · ⬜ todo

## What Polaris already has, and CheckCle does not

Worth stating first, because it decides what is worth copying and what is not.

- **A rollup tier.** Samples are kept raw for 8 days and hourly for 90
  (`lib/metrics-shared.ts`), and a chart asks for whichever the span needs.
  CheckCle's retention is deletion by age with no aggregation, so a year-old
  question has no answer at all there.
- **Typed columns.** `MetricSample` and `MetricRollup` store numbers as numbers.
  CheckCle stores server metrics, ping round trips and even a retry count as
  text.
- **No agent to install.** Polaris reads a remote machine over the transport it
  already has - SSH and the container daemon - so nothing is installed on a
  server to be watched. CheckCle's agent is a `curl … | sudo bash` with a token,
  which this product cannot ask anybody to run.
- **Container watching**, already in `/watch/containers`, off the same cached
  stats the rest of the screen uses.
- **An edge that repairs itself.** The probe treats the proxy's own 404 as down
  and republishes the routes when it finds a hostname unrouted
  (`lib/watch/health-probe.ts`), which is the one outage Polaris can end without
  a terminal.

## The gap, in the order it is worth closing

| Item | Status | Prio | Size | Notes |
| --- | --- | --- | --- | --- |
| **The two pollers under the leased scheduler** | ⬜ | P0 | S | `startDomainHealthPoller` and `startAlarmEvaluator` are bare `setInterval`s outside `SCHEDULED_JOBS`, so during a rollover - when two web containers serve at once - both sweep. The probe survives it by writing before it notifies; the alarm evaluator has no such guard, so one alarm can be announced twice. Every other job that touches something shared takes a lease for exactly this reason. |
| **A check-result history table** | ⬜ | P0 | M | The probe overwrites the last result onto `Domain` and keeps nothing, so there is no uptime percentage, no latency history and no heatmap - none of them are features to design, they are all one table away. Mirror `MetricSample`/`MetricRollup`, including the purge. |
| **Uptime over 24h, 7d and 30d, and a bar for it** | ⬜ | P0 | S | Falls out of the row above. The reading everybody wants first and the only one the cards cannot draw today. |
| **A keyword and the status codes that count as up** | ⬜ | P0 | S | The verdict is `status < 500`, so a page that returns 200 with a stack trace in it reads as healthy. The body is already read for the edge-404 check, so the bounded read exists. |
| **Certificate expiry, with staged warnings** | 🟡 | P1 | S | `expiresAt` is stored for a managed certificate and nothing warns about it; a certificate the operator supplied has no expiry tracked at all. A lapsed certificate is the classic self-hosted outage. Copy CheckCle's one genuinely good idea here: a per-certificate ledger of which stage has been announced, so a month of daily warnings is one message per stage. |
| **Per-monitor interval, retries and timeout** | ⬜ | P1 | M | 60 seconds, three failures and six seconds are constants for everything. A NAS on a slow link and a public site do not want the same numbers. |
| **Maintenance windows that suppress alerts** | 🟡 | P1 | M | Only a sleeping app is exempt today. Anything planned - an update, a move, a disk swap - announces itself as an outage. |
| **TCP, and a name resolving** | 🟡 | P1 | M | The primitives exist and are wired to games, mail, Drive and SSH, but there is no monitor somebody can point at a port or a hostname themselves. |
| **A heartbeat somebody's job can call** | ⬜ | P1 | S | CheckCle does NOT have this, and for a home server it is the most useful monitor of all: a backup or a cron that stops running is invisible to everything that probes from outside. A URL to call and an expected interval. |
| **Incidents with a cause and what was done** | ⬜ | P2 | M | `AlarmEvent` records the transition. What it was, and what fixed it, is the part worth having a month later. |
| **A public status page** | ⬜ | P2 | M | Components pointing at a domain, an app or a machine, in an order somebody chose, with the history bar from the row above. |
| **Mute one monitor** | 🟡 | P2 | S | The account's notification rules are all-or-nothing per event; the noisy one is usually a single monitor. |
| **Host metrics read from the host** | 🟡 | P2 | M | Host CPU is the sum of container shares clamped to 100, and a remote server's disk is deliberately unmeasured. Read `/proc` and `statfs` over the SSH transport that is already open - not a new agent. |

## Not worth copying

- **An agent installed by piping a script into a shell**, with a token in the
  command line. It contradicts the first rule of this product and duplicates a
  transport Polaris already has. Take what the agent measures, not how it gets
  there.
- **Probes from several regions.** One instance has one vantage point. The
  outside-in checks Polaris already makes for a game server or a mail server are
  the right-sized version of the same idea.
- **Editable message templates per metric.** Eighteen text fields to say what one
  sentence already says.
- **Alert configuration with no repeat interval, no cooldown and no escalation.**
  Worth noting because it is the shape to avoid rather than adopt: a fan-out to
  ten channels is not an escalation policy, and without a cooldown a flapping
  monitor is a pager that never stops.
