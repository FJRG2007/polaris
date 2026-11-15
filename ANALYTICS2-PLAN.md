# Analytics parity: remaining work (phase 2)

Branch `feat/analytics-parity-2`. Landed in phase 2: Pulse section of
`docs/analytics-plausible-parity.md`; UTM term/content and browser/OS versions
(migration `20271120000060`, raw-only breakdowns); year-over-year comparison
(`?compare=year`); peak hours card (Geography); `?polaris-ignore=on/off` opt-out
link; Stats API `GET /api/v1/analytics/stats` (documented in OpenAPI and
`docs/developers/analytics.md`). Extension is at `0.1.193`. Free migration
timestamps: `20271120000061`..`69`.

Still to build, highest value first:

1. **Traffic spike / drop alerts and periodic digest** - per-site threshold
   (column, code default off), checked from `lib/analytics-collector.ts`,
   delivered as Polaris notifications only (no email channel).
2. **Scroll depth and time on page** (Pulse `ScrollDepthBars`) - per-pageview
   columns filled from the tracker's leave beat, Top Pages columns; rollup
   columns or `unavailable` past 31 days.
3. **Public / password share links, report links, embed** - on
   `lib/link-guards.ts`, `components/public-shell.tsx`,
   `components/link-password-form.tsx`.
4. **Lab performance (Lighthouse)** - scheduled / on-demand runs per site in a
   throwaway container via hostd, from a maintained pinned Lighthouse/Chromium
   image (not yet researched or sourced); results charted beside the Vitals card;
   limited edition (no hostd) says lab runs need the full edition.
5. Per-site tracker options served by the collect endpoint (Pulse one-tag).
6. Pageview custom properties in the tracker.
7. Page grouping rules, ingest rejection causes, referrer drilldown, annotations,
   consolidated view, Sites API, keyboard shortcuts, CSV import into
   `AnalyticsDay`, uptime history on the site, analytics MCP tools, AI analyst
   through Polar.
8. A route test for `/api/v1/analytics/stats` (access 404, 400 on bad
   breakdown, daily source past 31 days).
