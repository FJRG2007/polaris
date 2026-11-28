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
any `<app>.<action>` shape, `expandPermissions` keeps it), and `hasPermission`
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
