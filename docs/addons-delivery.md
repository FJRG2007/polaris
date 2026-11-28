# Add-on delivery without a Polaris update

An installed Polaris finds new apps and device plugins the way a phone's store
finds an app published after the phone was bought: from a signed catalogue it
reads at runtime. A new app does not need a new dashboard image.

## The two catalogues

| | Device plugins | Apps |
| --- | --- | --- |
| Published by | `.github/workflows/device-plugins.yml` | `app-catalog` job in `.github/workflows/dashboard-publish.yml` |
| Built by | `clients/device-plugins/scripts/publish.mjs` | `dashboard/scripts/app-catalog.mjs` |
| Served from | release `device-plugins` (and `device-addons`) | release `app-catalog` |
| Read by | desktop app, dashboard (`lib/device-plugins-catalog.ts`) | dashboard (`lib/apps/runtime-catalog.ts`) |
| Shape | `core/src/device-plugins.ts` | `lib/apps/runtime-catalog-schema.ts` |

Both are `catalog.json` plus `catalog.json.sig` (`{"keyId", "signature"}`,
Ed25519 over the exact bytes), signed with the same key: the repository secret
`DEVICE_ADDONS_SIGNING_KEY` (key id `addons-2026-11`), whose public half is
`PLUGIN_CATALOG_KEYS` in `@polaris/core/device-plugins`. No new secret and no
key in the repository. The app catalogue says `"kind": "apps"` and has no
`plugins` list, so neither can be read as the other.

## Publishing an app

1. Add a `polaris.catalog` section to the app's `package.json`:

   ```json
   "polaris": {
       "id": "bakery",
       "extension": "src/lib/extension.ts#bakeryExtension",
       "catalog": {
           "minPolaris": "0.1.140",
           "name": { "en-US": "Bakery", "es-ES": "Panaderia" },
           "summary": { "en-US": "Run a bakery." },
           "description": { "en-US": "Orders, ovens and the till." },
           "category": "Productivity",
           "keywords": ["bread"],
           "nav": { "category": "work", "permission": "bakery.use" },
           "permissions": ["bakery.use"],
           "permissionDefs": [
               { "key": "bakery.use", "label": { "en-US": "Take orders" } }
           ],
           "coreTables": false
       }
   }
   ```

   `minPolaris` is the first Polaris release that runs the app, and what an older
   host shows as "Needs Polaris X - Update". Its source is the dashboard version
   (`dashboard/apps/web/package.json`, the number the `dashboard-v*` tags carry) on
   `origin/main` at the first commit that ships the app; for Hospitality that is
   `0.4.5`. That version has not moved since 2026-07-21, so it is a coarse floor:
   what actually decides whether an install runs an app is its host API, its
   permissions and `coreTables`, not this number. `writes: true` on a permission
   puts it in the read-only policy template's denies. A missing or malformed field
   fails the publish instead of reaching installs.
2. Merge to main. `dashboard-publish.yml` builds every bundle, pushes it to
   `ghcr.io/fjrg2007/polaris-dashboard` by digest (`docker/app-bundles.sh push`),
   and the `tag` job names it `latest-app-<id>` once the suites are green, which
   keeps `ghcr-prune.yml` from deleting it.
3. The `app-catalog` job then lists every opted-in app with that bundle's file,
   digest and size, signs the catalogue and uploads it to the `app-catalog`
   release. It runs only after `tag`, so the catalogue never names a bundle that
   is not kept.

## On an installed Polaris

- **Reading.** `runtime-catalog.ts` answers from the copy it holds and refreshes
  behind it every 15 minutes. The last good copy (bytes and signature) is kept
  under `<data>/apps/.catalog/` and checked again when read back, so a server
  that restarts offline still lists and runs its apps. A catalogue issued earlier
  than the one held is never taken, so an old signed copy cannot bring back a
  withdrawn app. Nothing about the server is sent, and neither hostd nor the
  updater is involved, so the limited edition works the same.
- **Listing.** Each entry is merged into the app catalog every screen reads
  (`setRuntimeApps` in `lib/apps/catalog.ts`) and its nav entry into the rail,
  on the server and in the browser (`RuntimeAppsRegistrar` in the app layout).
  An id the image already carries stays the image's.
- **Installing.** Installing records the app as a builtin; its bundle is fetched
  by `ensureBundle` from the image's own registry by the digest the catalogue
  pins (the catalogue never names where to fetch from) and refused unless it
  hashes to it. Screens are served under `/x/<id>`, one route in every image.
- **Compatibility.** An entry is runnable when its host API is satisfied
  (`@polaris/app-host/version`, the caret rule), every permission it uses is one
  this dashboard knows or one it declares itself, and it keeps no tables in the
  core schema. Otherwise it is
  listed as "Needs Polaris X - Update", linking to Settings > Updates. An entry
  written for a host API this dashboard has moved past is not listed. An entry
  this dashboard cannot read is dropped on its own; the rest of the catalogue
  still applies.

The device plugin catalog follows the same per-entry rule: a plugin from a newer
catalog no longer hides every other plugin from an older host or desktop app.

## The rule: an app never edits core

Adding an app touches only the app's own folder. It never adds a line to
`dashboard/packages/core` (permissions, minors, policy templates, own paths) or
to a per-app list in `apps/web` (nav, catalog, logos, marketplace), because a
core change forces an extension bump and a host update for something that is
only the app's, and does not scale to hundreds of apps.

What an app needs from those registries it declares in its manifest, and the
host registers it at runtime:

| Registry | Built-in defaults (unchanged) | An app's own entries |
| --- | --- | --- |
| Permissions, roles editor, role schema, API keys, view-as | `PERMISSIONS` / `PERMISSION_META` in `core/src/permissions.ts` | `permissionDefs` -> `registerAppPermissions`, read through `knownPermissions()` / `permissionMeta()` / `isKnownPermission()` / `permissionSchema` |
| Minors | `MINOR_FLOOR` and the stage table in `core/src/minors.ts` | denied to a minor until a guardian allows them (`deniedPermissions` covers every known permission) |
| Own paths (firewall) | `POLARIS_ROUTE_ROOTS` | none needed: every catalogue app is served under the one root `/x` |
| Nav, catalog, logo, names | `POLARIS_APPS`, `POLARIS_APP_CATALOG`, `catalog` messages | `nav`, `name`/`summary`/`description` per locale, `logo` |

An app may only declare permissions under its own id (`<id>.<action>`); a key
outside it, or one a built-in permission already has, is ignored, so an app can
never take over or widen a permission it does not own. The hard-coded entries
stay as the built-in defaults, so every existing install and every stored role
that names one (`hospitality.use` included) resolves exactly as before.

An app's permissions are offered everywhere a built-in one is:

- MCP scopes: `mcpScopes()`, `isMcpScope()` and `mcpScopeListSchema` in
  `lib/mcp/scope-table.ts`, filed under productivity.
- API keys: the key schemas in `core/src/schemas/account-security.ts` use
  `permissionSchema`; the picker labels them with `scopeLabel()` and files them
  under the app's name (`lib/api-key-scopes.ts`).
- Sharing: `core/src/schemas/sharing.ts` and `apps/installed/[id]/access-actions.ts`.
- Policy templates: a template applies as it stands now (`policyTemplateStatements`,
  read live in `auth/src/policies.ts`), so read-only also denies each app's
  `writes` permissions.

A grant of a permission no app registers now - one whose app the catalogue
dropped, or one not read yet - is stored and inert. Saving a role, a key or a
share that holds it is neither refused nor stripped (`permissionSchema` accepts
any `<app>.<action>` shape outside a built-in area such as `drive.`, and
`expandPermissions` keeps it), and `hasPermission`
grants nothing for it, not even to the wildcard, until the app is back.

## Limits

- An app whose tables live in the core Prisma schema (`coreTables: true`) still
  needs the dashboard release that carries their migration.
- An app that uses a permission it does not declare itself, and this dashboard
  does not know, needs a newer dashboard.
- Hospitality is the first app with a `polaris.catalog` section. It keeps tables
  in the core schema, so a host without it is told to update rather than offered
  an install; every current image carries it anyway, and an id the image carries
  stays the image's.

## App-owned data

An app that keeps data needs no dashboard release for its tables. It ships SQL
migrations in its bundle and the host applies them into a Postgres schema of
its own, `app_<id>` (dashes become underscores), never into the core Prisma
schema. This is the technique Odoo modules (per-module migrations run on module
upgrade), Directus extensions and Strapi plugins (each plugin's migrations
tracked in its own table) and PocketBase (ordered, forward-only migration files)
converged on. Code: `apps/web/src/lib/app-bundles/migrations.ts`.

- **Shipping.** `polaris.assets.migrations` points at the app's `migrations/`
  folder; each file is `NNNN_name.sql` and they apply in name order.
- **When.** Before any of the app's code is loaded: on install, on every boot,
  and when its bundle changes (`migrate()` in `lifecycle.ts`).
- **Tracking.** `app_<id>._polaris_migrations` (name, sha256, applied_at). An
  applied migration never runs again; one whose text changed after it was
  applied stops the app instead of being skipped.
- **Rules, checked before anything runs.** Additive only: no DROP, TRUNCATE,
  RENAME, or DELETE without WHERE. Its own schema only: a statement naming any
  other schema, or touching the search path, roles or grants, is refused.
- **Safety.** One transaction per run, under `pg_advisory_xact_lock` keyed to
  the app, with `SET LOCAL search_path` to the app's schema. A failure keeps
  nothing of the run and leaves the app off with a sentence naming the
  migration, shown where any app failure is (`appFailure`); two servers
  installing at once apply each migration exactly once.
- **Reading and writing.** `appDatabase(id)` gives the app a client scoped to
  its schema (parameters bound, never string-built). Users and permissions stay
  behind the host APIs; an app never reads core tables.

A bundle reaches it as `host.appData.openAppDatabase(id)` (host API 1.3).
Hospitality's tables stay in the core schema for now, with `coreTables: true`.
Moving them later: ship `0001_*.sql` creating the same tables in
`app_hospitality`, copy the rows across in a one-off host step run once under
the same advisory lock, switch the app to `appDatabase`, keep the core tables
read-only for one release as the rollback path, then drop them from the Prisma
schema in a later release.

## The host API version is the gate

`HOST_API` in `dashboard/packages/app-host/src/version.ts` (kept equal to
`hostApi` in that package's `package.json`) is the host contract version,
`MAJOR.MINOR`, and the only thing that decides whether a dashboard runs an app.
It only ever goes up: a new host service or shared library raises the minor,
taking one away or changing what one takes or returns raises the major. Every
change to the contract bumps it in the same commit. An app runs on a dashboard
with the same major and at least its minor (`hostApiVerdict`).

`minPolaris` is optional and only shown ("Needs Polaris X - Update"); without
it the card says "Needs a newer Polaris - Update". The dashboard's package
version (`apps/web/package.json`) has not moved since 2026-07-21 and gates
nothing.

## Extension points: where each comes from

Every contribution an app makes has to arrive with the app (its bundle's
`AppExtension`, or its manifest), never from an edit to core or `apps/web`.
Inventory of today's per-app registries:

| Extension point | Comes from | Status |
| --- | --- | --- |
| Permissions, roles, scopes, minors, policy templates | manifest `permissionDefs` -> `registerAppPermissions` | runtime |
| Nav entry, name, logo, marketplace listing | manifest (`nav`, `name`, `logo`) | runtime |
| Automation trigger events | manifest `events` (name, label, typed `fields`, `permission`: one of the app's own, else its `nav.permission`) -> `registerAppEvents` (`core/src/automation-app-events.ts`); built-in `APP_EVENTS` stay as defaults | runtime: offered in the trigger picker under the app to who holds the permission (`appEventViews` in `lib/automations/app-events.ts`), picked as an "On event" trigger on its name, its fields offered to later steps as `trigger.payload.<field>`; an event with no usable permission fires but is offered to nobody; a withdrawn app's events stop being events, so its triggers are reported as problems instead of firing |
| Naming an app's step or trigger | the manifest's own words: the editor's detail (`appSteps`, `appEvents`), a run's answer (`appWords`, `lib/automations/app-words.ts`, reader's language), else the manifests the browser registered (`app-step-words.ts`) | runtime: a run opened from a link names them without the editor |
| Automation actions (nodes), typed input and output | bundle `AppExtension.automationNodes`, schema-checked (`lib/automations/node-registry.ts`) | runtime already; a run reaching an uninstalled app's node is refused with `appMissing` |
| Scheduled jobs | bundle `AppExtension.jobs` | runtime already |
| Search / launcher records, favorites | bundle `searchRecords`, `favorites` | runtime already |
| MCP tools | bundle `mcpTools`, `mcpToolLabels` | runtime already |
| Calendar events, presence, backups, game server cards | bundle `upcomingEvents`, `presence*`, `backupSources`, `gameServer*` | runtime already |
| Page slots inside core screens | bundle `AppSlot` (`withBundleSlot`) | runtime already |
| Own tables | bundle migrations (`app_<id>` schema) | runtime |
| Emitting an app's events from its bundle | `host.automations.emitOwnAppEvent({ app, name, payload, key, permission })` (host API 1.3) | runtime: only an event the app's manifest declared, payload checked against it, received only by runners holding the app's own `permission` while the app is installed |
| Home / overview widgets | built-in cards: `app/(app)/home/widgets/*`; an app's: bundle `AppExtension.overviewWidgets` (`kind`, `defaultSize`, `describe` in the reader's language, `targets`/`read`/`act` through the host, optional `permission` under the app's id) | runtime: offered once installed, a card whose reader lost the permission reads "no longer have access" without asking the app, and an uninstalled app's card reads "not available" |
| Notification kinds | manifest `notificationKinds` (`<id>.<kind>`, label, description, level, a target among the app's own pages, defaults) -> `registerAppNotificationKinds` | runtime: listed under "From your apps" in Account > Notifications (only to who can open the app), accepted by `notify`, never critical, refused again once the app is withdrawn |
| Settings sections | manifest `settingsAt` (`/x/<id>/...`), drawn at Admin > Apps > <app> > Settings | runtime: an address outside the app's own screens is dropped |
| Cross-app actions ("create task from order") | manifest `automationSteps` (`<id>.action.<name>`, label, description, one of the app's own permissions, typed `fields` and `output`) -> `registerAppSteps`; the bundle's `AppExtension.automationSteps` only does the work (`lib/automations/app-steps.ts`) | runtime: listed in the editor under the app to who holds the permission, settings drawn and checked from the declared fields, refused for a runner without the permission, answer checked against the declared output; chained with any app's events and steps in one automation |
| Outgoing webhooks for an app's events | automation `http` node on an app trigger | works once the events are emitted |

Hospitality's manifest declares its first trigger events, each matching code
that exists in the app today: `hospitality.order-sent` (`sendLines`),
`hospitality.bill-paid` (`pay`), `hospitality.shift-closed` (`closeShift`,
with `counted`, `expected` and `difference`, so "till difference over X" is a
condition on `difference`), and `hospitality.product-availability`
(`setAvailability`). "Table waiting longer than X" has no event in the code
yet and is left out. The hospitality code does not emit them yet: that needs the
emit service above and a change in the hospitality app itself.

## Every host surface: manifest or not yet

The rule above holds for every place the host lists something per app, not only
the ones already done. "Bundle" means the app's own bundle supplies it at
runtime through `AppExtension` (`apps/web/src/lib/app-extensions/types.ts`):
it already reaches an install without a Polaris update, but it is code, not a
declared field, so the host cannot check its shape or gate it on a permission
before the bundle loads. "Manifest" means a catalogue field, parsed by
`runtime-catalog-schema.ts` and registered under the app's id and permissions.

| Surface | Manifest field | State |
| --- | --- | --- |
| Permissions (roles editor, server checks) | `permissionDefs` | manifest |
| Rail entry | `nav` (`category`, `permission`) | manifest |
| Nav sections, search and launcher pages | `sections` (label, `/x/<id>/...` path, own `permission`, keywords) -> `APP_SECTIONS` in `runtime-apps.ts` | manifest: the rail, global search and the launcher list them; a page or permission outside the app is left out; an app built into the image keeps its own |
| Settings page | `settingsAt` | manifest |
| Overview cards | bundle `overviewWidgets` (`permission`: own id) | bundle, gated |
| Notification kinds | `notificationKinds` | manifest |
| Automation trigger events | `events` (+ `permission`) | manifest, offered in the picker |
| Automation steps | `automationSteps` | manifest |
| Automation nodes with their own settings UI | bundle `automationNodes` / slots | bundle |
| MCP tools | `mcpTools` (`<id>_<name>`, own `permission` = scope, typed `fields`, `output`, optional `items`) -> `core/src/app-mcp-tools.ts`; bundle `mcpToolHandlers` does the work (`lib/mcp/app-manifest-tools.ts`) | manifest: input checked by the server, answer checked against the declared shape; a delivered app's undeclared bundle `mcpTools` are not listed; apps built into the image keep `mcpTools` in code |
| MCP search providers | bundle `mcpSearch` | bundle; to do: manifest |
| MCP resources and prompts | none | Polaris's MCP server speaks tools only (no `resources/*` or `prompts/*` methods in `lib/mcp/protocol.ts`), so there is nothing for an app to declare until the server serves them |
| Polar agent tools and connectors | none found per app (Polar reaches apps through the MCP list) | to check |
| Launcher / global search results | bundle `searchRecords`, `favorites` | bundle; to do: manifest launcher commands ("open table X") |
| Deck (Stream Deck) actions | bundle `deckActions` | bundle |
| Chat slash commands (`/<name> ...`) | `chatCommands` (name, description, hint, own `permission`) -> `core/src/app-chat-commands.ts`; bundle `chatCommandHandlers` answers (`lib/chat/app-commands.ts`) | manifest: listed in the composer and run only for a writer holding the permission while the app is installed, rate limited, reply posted under the app's name, a refusal shown to the writer alone; reserved and taken names are refused. Linked game servers' `answerChatCommand` stays bundle |
| Chat message components | none per app | to do |
| Deep links, `polaris://` routes | `lib/open-in-app.ts`, `lib/desktop-bridge.ts` | to check: per-app routes hard-coded? |
| Context menus, quick actions | `lib/context-menu/` | to check |
| Share targets | none found | missing |
| Whole-Polaris export/import sections | `lib/backups/sources/*` (built-in), bundle `backupSources` | bundle; to do: manifest declaration |
| Audit event types | `audit-service.ts` | to check |
| API key scopes | `permissionDefs` (`scopeLabel`/`scopeAppArea` in `api-key-scopes.ts`, `appScopes` in `lib/mcp/scope-table.ts`) | manifest already: an app's permissions are offered as key and MCP scopes under its name |
| i18n catalogs | the app's own (`apps/<id>/src/lib/i18n.ts`), manifest words localized per field | manifest for declared words; bundle for screens |
| TV / phone surfaces | not inventoried | to check |

"To check" rows were found by name only and not yet read; each needs the file
read before it can be called hard-coded or not.
