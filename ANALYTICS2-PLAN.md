# Analytics parity: remaining work (phase 2)

Branch `feat/analytics-parity-2`. Landed in phase 2: Pulse section of
`docs/analytics-plausible-parity.md`; UTM term/content and browser/OS versions
(migration `20271120000060`, raw-only breakdowns); year-over-year comparison
(`?compare=year`); peak hours card (Geography); `?polaris-ignore=on/off` opt-out
link; Stats API `GET /api/v1/analytics/stats` (documented in OpenAPI and
`docs/developers/analytics.md`). Extension is at `0.1.193`. Free migration
timestamps: `20271120000063`..`69`.

Landed after that: Stats API route test (`test/analytics/stats-api.test.ts`);
traffic spike / drop alerts and weekly / monthly summary as notifications
(`AnalyticsAlert`, migration `20271120000061`, job `analytics-alerts`, events
`analytics.traffic` / `analytics.digest`, card "Your notifications" on the site
panel); scroll depth and time on page (`AnalyticsEvent.scrollPct` /
`engagedMs`, migration `20271120000062`, leave beat `scroll`, card on Pages).

Still to build, highest value first:

1. **Public / password share links, report links, embed** - on
   `lib/link-guards.ts`, `components/public-shell.tsx`,
   `components/link-password-form.tsx`; constant-time password compare, rate
   limited; growth report link with 7 / 30 / 90 day expiry.
2. **Lab performance (Lighthouse)** - research Pulse (`lib/api/performance.ts`,
   AGPL-3.0, attribute in NOTICE.md if code is copied); run in a throwaway
   container via the hostd / deploy exec path from a pinned, sourced image tag;
   bounded result history per page beside the Vitals card; limited edition (no
   hostd) says lab runs need the full edition.
3. Per-site tracker options served by the collect endpoint (Pulse one-tag).
4. Pageview custom properties in the tracker.
5. Page grouping rules, ingest rejection causes, referrer drilldown, annotations,
   consolidated view, Sites API, keyboard shortcuts, CSV import into
   `AnalyticsDay`, uptime history on the site, analytics MCP tools, AI analyst
   through Polar.
6. Scroll / time columns in the daily rollup, so ranges past 31 days answer them.
