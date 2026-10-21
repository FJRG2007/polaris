# Instant first paint audit

Every `page.tsx` under `apps/web/src/app/(app)/admin` and `(app)/account`, and
what it awaits before it renders. Enumerated with:

```sh
cd apps/web/src/app/\(app\)
for f in $(find admin account -name page.tsx | sort); do echo "== $f"; grep -n "await \|Promise.all" "$f"; done
```

Every route under `(app)` already has `loading.tsx` (`RouteSkeleton`, the
recorded shape of the screen), so a navigation never shows a blank page. The
question here is how long the page holds that skeleton before the real content
lands.

Cost key: **trivial** - session check, translations, one or two indexed
single-row reads (`Setting` by key, a row by id). **light** - a few indexed,
bounded queries run in parallel. **heavy** - an unbounded count or scan, an
external API, or a host daemon call. Only heavy reads are moved out of the page;
trivial and light ones stay server-side because a round trip from the browser
would cost more than the read itself, and the route skeleton covers them.

## Fixed in this change

| Page | What it awaited | Cost | Now |
| --- | --- | --- | --- |
| `admin/display` | `getPlatformDisplayPreferences` + `usersMayChooseTheme` | trivial (2 setting rows) | Header from the server; both cards from `GET /api/admin/display` (admin-only, same `apiAdmin` gate) via `useLiveResource`, painted from the kept sessionStorage reading, skeleton shaped like the cards only on a first visit, kept reading rewritten on save. Converted on the operator's report even though the read itself is cheap. |
| `admin/retention` | `retentionPolicy`, then `retentionTotals` (six `count()` calls, three of them unfiltered over `notification`, `activity`, `auditLog`), then a setting - a serial waterfall | heavy (full-table counts grow with the instance) | Page reads the policy and the mail setting in parallel; counts come from `GET /api/admin/retention/totals` (admin-only) with a kept reading and a one-line skeleton per table; refreshed after a save or a sweep. |

Game servers (`apps/game-servers`, the installed server's Mods / Plugins tab):

| List | Before | Now |
| --- | --- | --- |
| Installed mods/plugins (`minecraft-mods.tsx`) | Skeleton rows on every visit until `/minecraft/modrinth?installed=` answered: up to four dependent Modrinth round trips (projects, builds, required dependencies, their builds) plus the server's log over the host daemon | Kept reading per server + loader + release + exact list (`server-mods:` key), painted before the request leaves; the answer is merged with `mergeUnchanged` so an unchanged list does not redraw. Skeleton only when nothing was ever read for that list. |
| Marketplace browse (same file) | Skeletons until the search answered, and the default shelf waited out the 400 ms typing debounce first | Kept answer per server + shelf + query painted at once; an empty query (the shelf a tab opens on) is asked without the debounce. |
| Client mods, ARK mods, ARK shelves | Already painted from kept snapshots | Unchanged. |

Server side the route already batches: Modrinth answers are memoized per URL for
five minutes as shared promises (so the three readers of the same `projects?ids=`
address make one request), per-project walks run eight at a time, and jar
metadata is resolved by hash in one `version_files` request. The remaining
dependency chain in `readRequirements` is inherent (the dependencies are only
known once the builds are read) and is now hidden behind the kept reading.

## Left server-side (trivial or light)

| Page | Awaits | Cost | Why it stays |
| --- | --- | --- | --- |
| `account/activity`, `ai-keys`, `api-keys/reference`, `cli`, `devices`, `extension`, `shortcuts`, `admin/activity`, `consumption`, `domains`, `evidence`, `page`, `setup`, `storage` | session + translations | trivial | Their data is already fetched by client views after paint. |
| `admin/billing`, `diagnostics`, `email`, `roles`, `sso`, `inbox/channels/connect`, `account/privacy/schedule` | one setting / small config table / last stored result | trivial | Indexed single reads. `bridgeConfigured` reads stored config, it does not call the bridge. |
| `admin/chat`, `security`, `settings`, `organizations`, `uploads`, `integrations`, `integrations/models`, `agents`, `policies`, `groups`, `safety`, `users`, `users/[id]` | several settings rows and bounded lists, in one `Promise.all` | light | Parallel, indexed, bounded; the admin lists page in the database. `listWhereabouts` reads stored rows and an in-memory cache, no network. |
| `admin/inbox`, `inbox/channels`, `inbox/contacts`, `inbox/logs` | the caller's channels / contacts / activity | light | Owner-scoped indexed reads. |
| `account/page`, `details`, `access`, `preferences`, `notifications`, `privacy`, `privacy/activity`, `security`, `sessions`, `friends`, `scan`, `standing`, `connections`, `assistants`, `downloads`, `api-keys`, `api-keys/new`, `api-keys/[keyId]`, `api-keys/[keyId]/usage` | the account's own rows (settings, sessions, keys, links), in parallel | light | Scoped to one user and indexed. `account/standing` already reads game sanctions behind its own boundary. |
| `account/domains`, `organizations/[slug]/domains` | owner domains, `getPublicIp`, grades | light | `getPublicIp` reads two settings and a local file (`host-address.ts`), not the network; grades are one query for every badge, cards read details after paint. |
| `account/organizations`, `organizations/[slug]/*` | the organization and its members/teams/roles/spaces/billing | light | One organization's indexed rows. |

## Not measured

No browser or production data here: the times above are by query shape, not
timings. The display, retention and mods changes are covered by component tests
(kept paint, refresh swap, rewrite on save, pages rendering without the read);
none of it has been exercised against a running deployment.
