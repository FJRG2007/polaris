# Telemetry roadmap

Parity of the Telemetry app (`dashboard/apps/web/src/app/(app)/telemetry`) with
the issue side of Sentry and GlitchTip. Performance monitoring, uptime checks
and session replay are out of scope here; they are other apps.

`[x]` shipped, `[ ]` missing.

## Projects

- [x] Sentry-compatible DSN and envelope/store ingest, per-project keys and key rotation
- [x] Reporter rules: allowed addresses, user agents, required secret, refusal log
- [x] Retention per project, daily counts kept after events are pruned
- [x] Projects shared with people as view or edit, owner-only key and delete
- [x] Project list paged by cursor and searched by name in the database, debounced
- [ ] Teams as project owners (Sentry teams), beyond org and share grants
- [ ] Per-project rate limits and spike protection
- [ ] Inbound filters (browser extensions, legacy browsers, localhost, error message patterns)

## Issues

- [x] Grouping by fingerprint, title, culprit, level, first and last seen, times seen, users affected
- [x] Search syntax: `is:` `assigned:` `level:` `environment:` `release:` `project:` `firstSeen:` `lastSeen:` and free text, filtered in the database
- [x] Sort by last seen, first seen, events, users
- [x] Resolve, resolve in next release, unresolve
- [x] Regression: a resolved issue seen in another release reopens itself and fires the regression alert
- [x] Ignore forever, for 1h / 24h / 7d, or for 10 / 100 / 1000 more events; the ignore ends on its own
- [x] Reopening by regression or by an ended ignore is written in the issue's activity
- [x] Assignee, with a notification to the person assigned
- [x] Bulk resolve, ignore and assign
- [x] Comments and activity log, task created from an issue
- [x] 30-day sparkline per issue
- [ ] Resolve in a specific commit or upcoming release (needs release tracking with commits)
- [ ] Ignore until N users affected, and "until escalating"
- [ ] Merge and unmerge issues, custom fingerprint rules
- [ ] Bookmarks, subscribe/unsubscribe to one issue, "seen by"
- [ ] Negated search terms (`!level:`), tag search (`tag:value`), saved searches
- [ ] Ownership rules and suggested assignees, team assignee
- [ ] Ignored and reopened state in the bulk menu with conditions (detail page only today)

## Events

- [x] Event stream per project and per issue, paged
- [x] Stack trace with in-app frames open, source context highlighted
- [x] Breadcrumbs, tags, contexts, request, SDK, user
- [ ] Previous / next event navigation inside an issue
- [ ] Tag distribution per issue (top values of each tag)
- [ ] Source map and debug symbol upload, symbolication
- [ ] Attachments and minidumps
- [ ] User feedback attached to an event

## Releases and environments

- [x] Releases list: events and last seen per release, opening the issues of that release
- [x] Environments list: events and last seen per environment, opening the issues of that environment
- [ ] Release details: new issues in the release, commits, deploys, adoption
- [ ] Release health (crash-free sessions and users)
- [ ] Environment filter that persists across sections, hidden environments

## Alerts

- [x] Rules per project: new issue, frequency over a window, regression; level and environment filters
- [x] Delivered through Polaris notifications to members and chosen people, throttled, with history
- [ ] Rule on an ended ignore ("issue changes state from ignored")
- [ ] Rule on users affected, on event attributes or tags
- [ ] Metric alerts (error rate, event count over time)
- [ ] Webhook and chat-channel actions per rule
- [ ] Weekly digest per project
