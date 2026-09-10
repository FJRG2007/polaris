# Compliance: what Polaris gives a SOC 2 or ISO 27001 audit

**Polaris is not certified against SOC 2, ISO 27001 or any other standard.** Neither
standard certifies software. A SOC 2 report and an ISO 27001 certificate are the result of
an audit of the organization that runs a system - its people, its processes and the tools
it uses. What Polaris can do is hold controls an auditor will ask about, and produce dated
evidence that they were in force.

This page maps Polaris's features to the areas those audits review. It names areas, not
control numbers: the official control lists are licensed documents and are not
reproduced or cited here. Your auditor maps these areas to the controls in your scope.

## The evidence screen

**Management > Evidence** (`/admin/evidence`, administrators only) reads the controls in
force from the database and settings and shows each with where it is set and who last
changed it according to the audit trail. **Export** writes the same facts, read at one
moment, as:

- a JSON file for tools, and
- a printable Markdown report,

both stamped with the time and the instance's address and build. The report quotes the
SHA-256 of the JSON, and the export itself is recorded in the audit trail
(`evidence.export`) with that hash, so a copy that turns up later can be checked against
the sealed trail.

The screen also lists what Polaris cannot see: whether the host's disks are encrypted,
where copies of keys are kept outside the instance, and the organization's own processes.

## Access control

- **Administrators** are a separate flag on an account, granted and withdrawn under
  Management > Users. Both are recorded (`user.promote`, `user.demote`). Polaris refuses
  to remove the last administrator.
- **Roles and policies** decide what each account, group and organization role may do
  (Management > Roles, Management > Policies).
- **Project access** gives a person a set of capabilities on one project, optionally for
  some environments only and until a date. **Project tokens** reach one project and
  nothing else.
- **Firewall** rules sit in front of every service and in front of Polaris itself:
  managed rule packs, custom rules, address allow and deny lists, a required Polaris
  sign-in, SQL injection and cross-site scripting checks, and bans (Firewall).
- **Rate limits and security headers** are set per service (Service > Settings > Traffic
  protection, Security headers).

## Authentication

- **Second factor**: the instance can require one of every account, and chooses which
  factors count (Management > Security). It is on by default. The evidence reports how
  many active accounts have one, and which administrators do not.
- **Passkeys, authenticator apps, emailed codes and trusted devices** are set per account
  (My account > Security).
- **Passwords** have a minimum length. The setup, invitation and account recovery forms
  also refuse a password found in known breaches.
- **Sessions** last a fixed time and are renewed at most once a day. Each account can
  shorten its own sessions, lock when idle, tie sessions to the browser and system that
  opened them (on by default) or to their address, and require new sign-ins to be
  approved from an open session.
- **Step-up**: irreversible account actions ask for the second factor again at the
  moment of the act.

## Logging and monitoring

- **Audit trail** (Management > Activity): every meaningful action, who took it, from
  which session, with the address stored hashed. Entries are sealed into a keyed hash
  chain, so an entry edited, removed or inserted after sealing breaks the chain. The
  chain is checked daily and on demand, and the last result is shown with its time.
- **Export** of the trail as CSV or JSON, narrowed by person, area and time. The JSON
  opens with the chain head - the value to keep outside Polaris, since removing the
  newest entries is only caught against a copy of it. Every export is itself recorded.
- **Monitoring**: health checks on every service domain, and alarms on health, outages,
  resource spikes, full disks and network traffic (Watch > Alarms).

## Change management

- Configuration changes are recorded in the audit trail with the actor and what changed:
  the instance security policy, retention, firewall rules, edge settings, domains and
  certificates, variables and secrets, backup plans and destinations, administrator
  rights.
- **Deploys** are recorded per service with the commit they built, and reported back to
  the commit on GitHub.
- **Updates** to Polaris itself are installed from Management > Updates & settings, which
  shows the commit an update would install and whether it passed its checks.

## Encryption

- **Secrets at rest**: secret variables, runner secrets, backup source credentials and
  the private keys of uploaded certificates are encrypted with the instance's master
  key, which is not stored in the database. Revealing a secret is recorded. The evidence counts secret variables stored
  encrypted and any that are not.
- **Backups**: every copy that leaves the thing it protects is encrypted with AES-256-GCM
  under a backup key, which can be kept elsewhere as a recovery key. Copies kept on the
  disk of the thing they protect are not encrypted, by design.
- **In transit**: service domains are served over HTTPS with a Let's Encrypt
  certificate, a certificate from the instance's own authority, or one you supply. The
  evidence counts domains served over plain HTTP.

## Backup and recovery

- **Backups** (Backups): databases, volumes, game worlds, mail servers and NAS paths,
  on a schedule or on demand, to one or more destinations, with retention by count, age
  and size. The evidence lists every protected item with its schedule, whether its newest
  copy is encrypted, its last good copy and its last result.
- **Restore** from any copy, recorded in the audit trail. Failed backups notify.

## Retention

- **Keeping records** (Management > Keeping records) sets how long notifications, the
  activity log and the audit log are kept. The audit log defaults to a year. Retention
  removes the oldest sealed entries only, and records where it cut so the chain stays
  verifiable.
- Retention changes are recorded (`retention.set`).

## What stays with the organization

An audit also covers what no software can show: access reviews, joiners and leavers,
security training, vendor management, incident response, physical security, where keys
and the chain head are kept offline, and the encryption of the machines Polaris runs on.
Polaris's evidence names these as outside its view rather than answering for them.
