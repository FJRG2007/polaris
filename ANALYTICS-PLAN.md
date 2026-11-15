# Analytics parity: remaining work

Rows decided **build** in `docs/analytics-plausible-parity.md` that are not on
branch `feat/analytics-plausible-parity` yet, highest value first.

Built on this branch: tracker downloads / forms / contact links / 404 / hash
routing; Core Web Vitals (`data-vitals`, `AnalyticsVital`, migration
`20271120000010`, card under **Pages**); contains / does-not-contain filters.
Next free migration timestamps: `20271120000011`..`19`. Extension already at
`0.1.188`.

1. **Stats API** - `GET /api/v1/analytics/stats` with `requireApiKey` (scope
   `deploy.manage`); resolve the site with `siteAccess(principal.userId,
   scopes.includes("system.manage"), ...)`; reuse `readAnalytics` and
   `reports.*`; Zod query (`scopeType`, `scopeId`, `range`, `filters`,
   `breakdown`); wrap with `withKeyUsage`; document in `docs/developers`.
2. **UTM term / content** - `term`, `content` on `AnalyticsSession`
   (additive migration), `parseUtm` returns them, filters, raw-only
   breakdowns added to `RAW_ONLY` so long ranges report `unavailable`.
3. **Traffic spike / drop alerts and weekly digest** - per-site threshold
   (column, code default off), checked from the collector loop
   (`analytics-collector.ts`), delivered as Polaris notifications only (no
   email channel exists).
4. **Scroll depth and time on page** (Plausible + Pulse `ScrollDepthBars`) -
   per-pageview columns filled from the leave beat, Top Pages columns; rollup
   gets summed columns or the metrics report `unavailable` past 31 days.
5. **Year-over-year comparison** - `previousPeriod` with a mode.
6. **Peak hours** (Pulse `PeakHours.tsx`) - 24x7 grid from raw events.
7. **Public / password shared links, report links, embed** (Plausible shared
   links, Pulse `app/share/[id]`, `app/r/[token]`) - on `lib/link-guards.ts`,
   `components/public-shell.tsx`, `components/link-password-form.tsx`.
8. **Browser and OS versions** (Plausible devices, Pulse `TechSpecs.tsx`) -
   parser + columns, raw-only breakdown.
9. **Opt-out link** `?polaris-ignore=on/off` (Pulse `?pulse-ignore` +
   `script.note.js`), and per-site tracker options served by the server
   (Pulse one-tag settings) instead of tag attributes.
10. **Pageview custom properties** in the tracker.
11. Referrer drilldown (store the referrer path), annotations, consolidated
    view, Sites API, keyboard shortcuts, CSV/GA import into `AnalyticsDay`
    (Pulse `lib/import`), uptime history for the site's service (Pulse
    uptime), analytics MCP tools (Pulse `lib/mcp`), AI analyst through Polar
    (Pulse `components/analyst`).
12. **Lab performance checks** (Pulse Performance: scheduled Lighthouse /
    PageSpeed runs with performance, accessibility, best-practices and SEO
    scores, audits, filmstrip). Blocked on a decision: it needs a headless
    Chromium on the server (none is bundled) or Google's PageSpeed API (an
    outside service and a key, against the no-setup rule). Field vitals were
    built instead.

Pulse rows decided n/a: Search Console / Bing keywords (OAuth app per
install), Bunny CDN statistics (one vendor), click-label interactions script
(reads page text; tagged events cover it), never storing IPs (Polaris keeps
them for the firewall on purpose). No Pulse code was copied, so `NOTICE.md`
needs no entry; the vitals thresholds come from https://web.dev/articles/vitals.
The Pulse section of the parity doc is still to be written row by row from
this list.
