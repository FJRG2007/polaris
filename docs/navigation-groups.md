# Navigation groups

The left rail draws an app's screens from `APP_SECTIONS` in
`dashboard/apps/web/src/lib/apps.ts`. A screen with a `group` is drawn under that
heading; headings follow in the order they first appear, and screens with no
group sit at the top under the app's own name. Group names are translated through
the `labels` of the `nav` catalogs, like every other rail label.

`test/navigation/rail-group-sizes.test.ts` keeps the Management and Apps rails at
no more than 8 entries per heading, each heading declared in one run, and every
screen they offered before still present.

## Where the groups come from

Consoles with many settings converge on short headings of a handful of entries
each, split by the question the reader arrives with rather than by feature
(headings paraphrased; each product renames them from time to time):

- GitHub organization settings: Access, Code planning and automation, Security,
  Integrations, Archive.
- Vercel team settings: General, Billing, Members, Security & Privacy, Domains,
  Integrations.
- Nextcloud administration: Basic settings, Sharing, Security, Theming, Logging,
  Overview.
- Google Workspace admin: Directory, Devices, Apps, Security, Reporting, Billing,
  Account.

## Management rail

Only the former Platform heading changed. Overview, Activity and Evidence stay
ungrouped; People, Access and Communication are as they were.

| Screen | Path | Before | After |
| --- | --- | --- | --- |
| Get started | `/admin/setup` | Platform | General |
| Updates & settings | `/admin/settings` | Platform | General |
| Display defaults | `/admin/display` | Platform | General |
| Domains | `/admin/domains` | Platform | General |
| Integrations | `/admin/integrations` | Platform | Integrations & AI |
| AI provider keys | `/admin/integrations/models` | Platform | Integrations & AI |
| Agent defaults | `/admin/agents` | Platform | Integrations & AI |
| Storage locations | `/admin/storage` | Platform | Storage & data |
| Uploads | `/admin/uploads` | Platform | Storage & data |
| Keeping records | `/admin/retention` | Platform | Storage & data |
| Consumption | `/admin/consumption` | Platform | Usage & health |
| Billing | `/admin/billing` | Platform | Usage & health |
| Diagnostics | `/admin/diagnostics` | Platform | Usage & health |

## Apps rail

Deploy and Marketplace stay ungrouped at the top. Mail server and Network filter
appear only once installed.

| Screen | Path | Before | After |
| --- | --- | --- | --- |
| Agents | `/apps/agents` | (ungrouped) | Development |
| Code | `/apps/code` | (ungrouped) | Development |
| Runners | `/apps/runners` | Machines | Development |
| Servers | `/apps/servers` | Machines | Machines |
| Compare | `/apps/servers/compare` | Machines | Machines |
| Insights | `/apps/servers/insights` | Machines | Machines |
| Rollouts | `/apps/servers/rollouts` | Machines | Machines |
| Security scans | `/apps/servers/security` | Machines | Machines |
| Cloud servers | `/apps/servers/cloud` | Machines | Machines |
| Containers | `/apps/containers` | Machines | Machines |
| Tunnels | `/apps/tunnels` | Machines | Network |
| Firewall | `/apps/firewall` | Operations | Network |
| Network filter | `/apps/network-filter` | Operations | Network |
| Databases | `/apps/databases` | Operations | Data & services |
| Backups | `/apps/backups` | Operations | Data & services |
| Mail server | `/apps/mail-server` | Operations | Data & services |
| Analytics | `/apps/analytics` | Operations | Observability |
| Telemetry | `/apps/telemetry` | Operations | Observability |

Paths, permissions (`needs`, `adminOnly`, `requiresApp`) and search keywords did
not change, so search and breadcrumbs find every screen where they did before.
