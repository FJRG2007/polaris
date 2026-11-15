# Analytics: Plausible parity review

What [Plausible Analytics](https://github.com/plausible/analytics) offers, how
Polaris Analytics compares, and what was decided for each feature. Plausible
behaviour is taken from its documentation at <https://plausible.io/docs>; Polaris
file references are relative to `dashboard/`.

Status on this branch: built - tracker downloads, forms, contact links, 404
pages, hash routing; Core Web Vitals; contains / does-not-contain filters.
Every other **build** row, and the Pulse (https://github.com/ciphera-net/pulse)
review, is in `ANALYTICS-PLAN.md`.

Decisions:

- **build** - implemented on branch `feat/analytics-plausible-parity`, or listed
  in `ANALYTICS-PLAN.md` when it did not fit the batch.
- **have** - Polaris already does it.
- **n/a** - does not apply to a self-hosted Polaris, with the reason.

Project rules that shaped the decisions: there is no outbound email channel in
Polaris, so reports and alerts go to Polaris notifications; geography stays on
the server (`CF-IPCountry`, the local DB-IP country database, then the time
zone) and never calls an outside service; sessions stay cookieless and
daily-unique; ranges over 31 days read the `AnalyticsDay` rollup and report the
dimensions it lacks as `unavailable`.

Size: S under a day, M one to three days, L more.

## Collection and the script

| Feature | Plausible | Polaris today | Gap | Decision | Size |
| --- | --- | --- | --- | --- | --- |
| Script-free counting | Script only ([plausible-script](https://plausible.io/docs/plausible-script)) | Edge log counts every deployed service with no script (`apps/web/src/lib/analytics-ingest.ts`) | Polaris ahead | have | - |
| Lightweight script | Under 1 KB gzipped, no cookies | `apps/web/public/analytics.js`, no cookies, no storage, idle-scheduled | none | have | - |
| Cookieless visitors | Daily-rotating salt hash ([data policy](https://plausible.io/data-policy)) | Same model (`packages/core/src/analytics-report.ts` `visitSessionId`) | none | have | - |
| SPA / History API | Automatic pushState tracking | Wraps `pushState`/`replaceState`, `popstate` | none | have | - |
| Hash-based routing | `hashBasedRouting` option ([script-extensions](https://plausible.io/docs/script-extensions)) | `location.hash` ignored | Hash routers count one page | built: `data-hash="true"` records the hash as part of the page, listens to `hashchange` | S |
| Manual pageviews | `autoCapturePageviews: false` + manual call | `data-auto="false"` + `polaris.view()` | none | have | - |
| Transform / filter beats | `transformRequest` | `data-before-send` | none | have | - |
| Restrict to hostnames | [subdomain-hostname-filter](https://plausible.io/docs/subdomain-hostname-filter) | `data-domains`, per-site hostnames | none | have | - |
| Localhost capture off | `captureOnLocalhost` | Counted unless `data-domains` excludes it | minor | n/a: `data-domains` already covers it | - |
| Outbound link clicks | `Outbound Link: Click`, `url` prop ([outbound-link-click-tracking](https://plausible.io/docs/outbound-link-click-tracking)) | `data-outbound="true"` -> `outbound-link-click` with `url` | none | have | - |
| Email and phone link clicks | [email-phone-link-tracking](https://plausible.io/docs/email-phone-link-tracking) | not recorded | gap | built: `mailto:`/`tel:` clicks recorded under `data-outbound` as `contact-link-click` | S |
| File downloads | `File Download`, `url` prop, configurable extensions ([file-downloads-tracking](https://plausible.io/docs/file-downloads-tracking)) | not recorded | gap | built: `data-downloads="true"` (or a comma list of extensions) -> `file-download` with `url` | S |
| Form submissions | `Form: Submission` ([form-submissions-tracking](https://plausible.io/docs/form-submissions-tracking)) | not recorded | gap | built: `data-forms="true"` -> `form-submit` with the form's path (`action`) and `id` | S |
| 404 pages | Event `404` sent by the error page ([error-pages-tracking-404](https://plausible.io/docs/error-pages-tracking-404)) | possible by hand with `polaris.event("404")`, not documented | gap | built: `data-404="true"` on the error page's tag sends `404` with `path`; documented | S |
| Tagged events | CSS class `plausible-event-name=...` ([custom-event-goals](https://plausible.io/docs/custom-event-goals)) | `data-polaris-event` + `data-polaris-event-<prop>` attributes | none | have | - |
| Custom properties | Props on events and pageviews ([custom-props](https://plausible.io/docs/custom-props/introduction)) | Event props + identify data, property breakdown (`analytics-reports.ts` `eventProperties`, `sessionProperties`) | pageview props not sent | have (events, visitor data); pageview props: plan | S |
| Revenue goals | Amount + currency on an event ([ecommerce-revenue-tracking](https://plausible.io/docs/ecommerce-revenue-tracking)) | `revenue` + `currency` props, per-currency report (`analytics-reports.ts` `revenue`) | none | have | - |
| Scroll depth | 1-100 % per pageview, Top Pages column ([scroll-depth](https://plausible.io/docs/scroll-depth)) | not measured | gap | plan: needs a per-pageview column, ingest from the leave beat and a rollup column | M |
| Time on page | Engaged time per page ([metrics-definitions](https://plausible.io/docs/metrics-definitions)) | Visit duration per session from leave beats; not per page | gap | plan: same per-pageview storage as scroll depth | M |
| Core Web Vitals | [core-web-vitals](https://plausible.io/docs/core-web-vitals) (custom events) | not measured | gap | built: `data-vitals` (LCP, INP, CLS, FCP, TTFB), `AnalyticsVital`, p75 overall and per page under **Pages**; raw ranges only, `unavailable` past 31 days | M |
| Impressions / element visibility | [content-impressions-tracking](https://plausible.io/docs/content-impressions-tracking) | custom events | none | have (custom events) | - |
| Visitor opt-out | `localStorage.plausible_ignore` ([excluding-localstorage](https://plausible.io/docs/excluding-localstorage)) | `localStorage polaris.disabled` | none | have | - |
| Exclude IPs | [excluding](https://plausible.io/docs/excluding) | Ignored addresses incl. IPv4 CIDR (`ignored-traffic.tsx`) | none | have | - |
| Exclude pages | Script `exclude` / settings | Ignored pages with `*` prefix | none | have | - |
| Bot filtering | [bot-traffic-filtering](https://plausible.io/docs/bot-traffic-filtering) | UA bot markers, `countBots` setting (`analytics-visit.ts`) | datacenter-IP lists | have (UA); datacenter lists n/a: needs an outside list Polaris would have to fetch | - |
| Proxying the script | [proxy](https://plausible.io/docs/proxy/introduction) | Script and endpoint already first-party on the operator's Polaris; `data-host` | none | have | - |
| Consent platforms | [consent-management-platforms](https://plausible.io/docs/consent-management-platforms) | No consent needed (no storage) | none | n/a | - |
| NPM package | [npm-package](https://plausible.io/docs/npm-package) | Script tag and framework snippets | no package | n/a: a published package needs a release pipeline outside this repo | - |

## Dashboard

| Feature | Plausible | Polaris today | Gap | Decision | Size |
| --- | --- | --- | --- | --- | --- |
| Top graph metrics | Visitors, visits, pageviews, views per visit, bounce rate, visit duration ([guided-tour](https://plausible.io/docs/guided-tour)) | Same overview (`analytics-report.ts` `overviewOf`, `analytics-view.tsx`) | none | have | - |
| Compare to previous period | [compare-stats](https://plausible.io/docs/compare-stats) | Previous-period deltas on every card (`analytics-reports.ts` `previousPeriod`) | year-over-year, custom period | plan: year-over-year mode | S |
| Annotations | [annotations](https://plausible.io/docs/annotations) | none | gap | plan | M |
| Filters: is / is not | [filters-segments](https://plausible.io/docs/filters-segments) | `negate` on every filter, applied to every panel on raw ranges (`analytics-reports.ts` `sessionWhere`) | none | have | - |
| Filters: contains / does not contain | Same page | exact match only | gap | built: a `contains` flag beside `negate` (is, is not, contains, does not contain), case-insensitive, raw ranges; daily ranges keep reporting `filtersIgnored` | M |
| Saved segments | Same page | Segment reports (`AnalyticsReport` kind `segment`) | none | have | - |
| Realtime | [realtime-dashboard](https://plausible.io/docs/realtime-dashboard) | `/analytics/realtime`, last 30 minutes (`analytics-lists.ts` `realtimeSnapshot`) | none | have | - |
| Sources, channels | [top-referrers](https://plausible.io/docs/top-referrers) | Referrer + channel breakdowns | none | have | - |
| UTM source / medium / campaign | Campaigns tab | `referrerSource`, `medium`, `campaign` on the session, filters + breakdown | none | have | - |
| UTM term / content | Campaigns tab | not stored | gap | build: `term` and `content` on the session, filters, raw-only breakdowns (reported `unavailable` on daily ranges) | M |
| Referrer drilldown | Full referrer URLs per source | Source host only | gap | plan: needs the referrer path stored | M |
| Top / entry / exit pages | [top-pages](https://plausible.io/docs/top-pages) | `path`, `entry`, `exit` dimensions | exit rate column | have | - |
| Countries | [countries](https://plausible.io/docs/countries) | Country from proxy header, local DB-IP, then time zone | none | have | - |
| Regions, cities | Same page | Not stored | gap | n/a: needs a city database Polaris does not download; country stays the finest level without setup | - |
| Devices, browsers, OS | [devices](https://plausible.io/docs/devices) | `device`, `browser`, `os` | versions | plan: browser/OS version columns + parser | M |
| Goals and conversion rate | [goal-conversions](https://plausible.io/docs/goal-conversions) | Goal reports with visitors, events and the window's visitors (`analytics-reports.ts` `goals`) | none | have | - |
| Funnels | [funnel-analysis](https://plausible.io/docs/funnel-analysis) | Funnel reports (`analytics-reports.ts` `funnel`) | none | have | - |
| User journeys / Explore | [user-journeys](https://plausible.io/docs/user-journeys) | Journey reports | none | have | - |
| Time-spent goals | [time-spent-tracking](https://plausible.io/docs/time-spent-tracking) | none | gap | plan: depends on per-page time | M |
| Consolidated view | [consolidated-views](https://plausible.io/docs/consolidated-views) | Site list with totals (`/analytics/sites`) | combined dashboard | plan | M |
| Google Search Console keywords | [google-search-console-integration](https://plausible.io/docs/google-search-console-integration) | none | gap | n/a: needs an OAuth app registered with Google per install; not a no-setup feature | - |
| Keyboard shortcuts | [keyboard-shortcuts](https://plausible.io/docs/keyboard-shortcuts) | none | gap | plan | S |
| Retention | not in Plausible | Retention report over `distinctId` | Polaris ahead | have | - |
| Individual sessions | not in Plausible | Session list and journey | Polaris ahead | have | - |

## Sharing, reports, data access

| Feature | Plausible | Polaris today | Gap | Decision | Size |
| --- | --- | --- | --- | --- | --- |
| Team roles | [users-roles](https://plausible.io/docs/users-roles) | Site sharing with view / edit grants (`site-access.ts`, `analytics.site` grant) | none | have | - |
| Public dashboard | [visibility](https://plausible.io/docs/visibility) | none | gap | plan: public page on the shared link primitives (`lib/link-guards.ts`) | L |
| Shared links with password | [shared-links](https://plausible.io/docs/shared-links) | Grants to people only | gap | plan: same as public dashboard, with `link-password-form` | L |
| Embed dashboard | [embed-dashboard](https://plausible.io/docs/embed-dashboard) | none | gap | plan: depends on public links | M |
| Email reports | [email-reports](https://plausible.io/docs/email-reports) | none | - | n/a: Polaris has no outbound email channel; see weekly digest | - |
| Slack reports | [slack-reports](https://plausible.io/docs/slack-reports) | none | - | n/a: outbound channels are not part of Polaris; notifications are the channel | - |
| Traffic spike and drop alerts | [traffic-spikes](https://plausible.io/docs/traffic-spikes) | none | gap | plan: a per-site threshold checked by the collector loop, delivered as a Polaris notification | M |
| Weekly digest | email reports | none | gap | plan: delivered as a Polaris notification | M |
| Stats API | [stats-api](https://plausible.io/docs/stats-api) | Session-bound actions only | gap | build: `GET /api/v1/analytics/stats` with a Polaris API key, same filters and ranges as the screen | M |
| Events API | [events-api](https://plausible.io/docs/events-api) | `POST /api/analytics/collect` (public, keyed by the site key) | server-side callers must fake an origin | have: the collect endpoint is the events API; server-side use documented | - |
| Sites API | [sites-api](https://plausible.io/docs/sites-api) | Actions only | gap | plan | M |
| CSV export | [export-stats](https://plausible.io/docs/export-stats) | Raw CSV of pages and events (`api/analytics/export`) | none | have | - |
| CSV / GA import | [csv-import](https://plausible.io/docs/csv-import), [google-analytics-import](https://plausible.io/docs/google-analytics-import) | none | gap | plan: import of daily totals into `AnalyticsDay` | L |
| Raw data export | [raw-data-export](https://plausible.io/docs/raw-data-export) | CSV export covers raw rows | none | have | - |
| Reset / delete site data | [reset-site-data](https://plausible.io/docs/reset-site-data) | **Delete data** in site settings | none | have | - |
| Reporting time zone | [general](https://plausible.io/docs/general) | UTC days in the rollup | gap | n/a: the rollup is keyed on UTC midnight; changing it rewrites history | - |
| Change domain | [change-domain-name](https://plausible.io/docs/change-domain-name) | Site hostnames editable | none | have | - |
| White-label | [white-label](https://plausible.io/docs/white-label) | - | - | n/a: Polaris is self-hosted | - |
| Looker Studio connector | [looker-studio](https://plausible.io/docs/looker-studio) | - | - | n/a: Google-hosted connector | - |
| Billing, trial | [trial](https://plausible.io/docs/trial) | - | - | n/a: self-hosted | - |
