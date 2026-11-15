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

Landed after that: public / password links and embed (migration
`20271120000063`, `AnalyticsShareLink`, `lib/analytics-share.ts`, pages
`/sa/<token>` and `/sa/embed/<token>`, unlock action `app/sa/actions.ts` rate
limited 8 / 10 min per link and address, 60 opens / min per link and address,
owner-only "Public links" card on the site panel, `sa` added to
`TOKEN_PATH_PREFIXES`, `sa/embed/` the only analytics path left out of
`FRAMEABLE_EXCEPT_EMBEDS`; test `test/analytics/share-links.test.ts`).
Free migration timestamps now `20271120000064`..`69`.

Still to build, highest value first:

1. **Lab performance (Lighthouse)** - research done, nothing written yet:
   - Pulse runs no Lighthouse in its public repo: `lib/api/performance.ts` is
     a client of a private backend ("self-hosted Lighthouse runner"). Nothing
     to copy, so no NOTICE.md entry is needed unless code is taken later.
     Shape worth matching: one check = median of 3 runs per strategy
     (mobile / desktop); scores performance / accessibility / best-practices
     / seo; metrics `lcp_ms cls tbt_ms fcp_ms si_ms tti_ms`;
     `triggered_by` scheduled | manual; `status` ok | error with `error`;
     `lighthouse_version`; config `enabled` + `frequency` daily / weekly /
     monthly + `next_check_at`; history endpoint defaults to 90 days;
     on-demand trigger answers 202 and the screen polls the latest.
   - Image: `patrickhulce/lhci-client` on Docker Hub (read from
     `hub.docker.com/v2/repositories/patrickhulce/lhci-client/tags`,
     2026-11-15). Tags: `0.16.1` (2026-11-11, digest
     `sha256:7ee0fbc1...f9ea1b`), `0.16.0` (2026-11-03, digest
     `sha256:01d84636...2340b`), `0.15.1` (2025-06-25, digest
     `sha256:558210c5e422a7babaaa09c285b7469da3f00fac1a9880c37883c65d666a7fc9`).
     Pick `0.15.1` pinned by digest (the 0.16 tags are under two weeks old),
     and confirm the image's entrypoint and that it ships the `lighthouse`
     CLI and Chromium before relying on it (not verified yet).
   - Container path: reuse the one-shot pattern in
     `lib/storage-moves/service.ts` `runOneShot` / `plan.ts` `oneShot`
     (`getPorts()` -> `composeUp` spec with `restart: "no"`, poll `inspect`,
     read `logs`, `composeDown`). `logs` is read with `tail: 40`, so the
     container must print ONE compact summary line (e.g. pipe the JSON report
     through `node -e` and print `POLARIS_LH {...}` with only scores and
     metrics), never the full report. Limited edition (no hostd): say lab runs
     need the full edition. Docker is not available on the dev machine, so the
     container path will not have been exercised - say so.
   - Storage: `AnalyticsLabRun` (siteId, url, strategy, scores, metrics,
     triggeredBy, status, error, lighthouseVersion, createdAt), capped per
     site+url (keep last 90 or 90 days), index (siteId, url, createdAt).
     Scheduled through the existing cron pattern (`api/cron/analytics-alerts`).
     UI beside the Vitals card on Pages.
2. Per-site tracker options served by the collect endpoint (Pulse one-tag).
3. Pageview custom properties in the tracker.
4. Page grouping rules, ingest rejection causes, referrer drilldown, annotations,
   consolidated view, Sites API, keyboard shortcuts, CSV import into
   `AnalyticsDay`, uptime history on the site, analytics MCP tools, AI analyst
   through Polar.
5. Scroll / time columns in the daily rollup, so ranges past 31 days answer them.
