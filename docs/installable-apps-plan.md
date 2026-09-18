# Installable apps: an app's code only on a server that installed it

Game servers and Places ship inside the one dashboard image today. Installing
either only writes a row, and every Polaris carries every line of both whether
anybody uses them or not. The goal:

- an app that is not installed has no code on the server;
- installing it from the marketplace brings its code, uninstalling it removes it,
  at any time, from the interface;
- nothing an existing install already has is lost or broken by getting there;
- Polaris and its apps use as little memory and disk as possible.

The last point decides the shape. A container per app costs a Node process per
app - a few hundred megabytes each for a Next.js server - on a machine that is
often a home server. So an app is a **bundle loaded into the dashboard's own
process**, not a service of its own: one container, one runtime, and the app's
code present only while it is installed.

## Where things stand

Done (2026-09-17):

- Installing and uninstalling Game servers and Places is real at runtime. The
  rail entry, the scheduled jobs, the camera watcher and Places' container
  upgrade all do nothing while the app is not installed. Uninstalling Game
  servers is refused while servers exist. Uninstalling Places brings its helper
  containers down and keeps their data; reinstalling brings them back.
- Existing instances keep their screens: a game server or an old per-game
  manager counts as Game servers being installed.

Phase 1 is done too (below): core no longer imports any Game servers or Places
module.
`test/build/app-boundaries.test.ts` fails the build if that changes, and
`test/build/app-extensions-empty.test.ts` runs core with no app registered.

What that does not do is take the code away. That is the rest of this plan.

## The model

An **app bundle** is a versioned archive published by CI next to the dashboard
image, one per app and per Polaris build:

```
game-servers-<build>.tgz
  manifest.json      id, version, the dashboard build it was compiled against,
                     permissions, scheduled jobs, routes, rail sections
  server/index.mjs   the server half: services, route handlers, job bodies
  client/index.mjs   the screens, as React components
  assets/            what the screens load
```

- **Installing** downloads the bundle for the running build into the
  `polaris-apps` volume, checks its signature and build, and registers it.
  **Uninstalling** unregisters it and deletes the folder. Updating Polaris
  replaces each installed bundle with the one for the new build, in the same
  updater run - never a dashboard on one build with an app from another.
- **One process.** The dashboard loads `server/index.mjs` with a dynamic
  `import()` of the file on the volume. Shared libraries (`react`, `@polaris/*`,
  `zod`, `@polaris/db`) are never inside a bundle: they are resolved to the
  dashboard's own copies through a Node module resolution hook, so an app adds
  its own code and nothing else to memory.
- **Screens** are served by one catch-all route per app surface
  (`/apps/games/[...path]`, `/places/[...path]`). It asks the loaded bundle which
  component renders that path and hands it the data its server half returned.
  The client half is an ES module loaded by the browser with an import map that
  points shared libraries at the chunks the dashboard already serves.
- **Everything core needs from an app goes through one contract**, the app
  extension registry (below). Core never imports an app's module by path.
- **Data** stays in the one Postgres schema. The tables are additive and
  untouched by uninstalling, so reinstalling finds everything where it was. An
  explicit "delete this app's data" is a separate, confirmed action.

## The extension contract

What core asks an app today, grouped by the core screen that asks:

| Core area                                            | What it needs from Game servers                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| Deploy (`deploy-service`)                            | which image a Minecraft server's release runs                              |
| Marketplace / install (`install-service`, `catalog`) | port allocation for game ports, loader and software defaults, ARK map list |
| Access (`install-access`, `container-files`)         | per-server permissions, container file access                              |
| Admin > Domains                                      | game ports to forward, their live reachability, the port policy            |
| Firewall                                             | the per-server player access panel                                         |
| Backups                                              | the Minecraft world backup source                                          |
| Overview and home widgets                            | counts and state of game servers                                           |
| Router guide                                         | which ports the router has to forward                                      |
| Cron                                                 | the game-\* jobs                                                           |

The registry is a typed interface in core with one implementation per installed
app. Core asks the registry and treats a missing app as "nothing to show". The
app registers its implementation when its bundle loads.

An extension module is loaded by every core module that asks the registry
anything, not only by the app it belongs to, so it imports nothing heavy at the
top: each hook loads the services it needs when it runs. Without that, an app
extension that reached the database, the session or a container runtime would
load those into a core path that never uses them.

## Phases

1. **Core stops importing app code.** Done for Game servers and Places (#186). The registry is
   `lib/app-extensions/` (types, registry, and `installed.ts`, the one list);
   the client half is `components/app-extensions/installed-client.tsx`. Game
   servers registers `lib/apps/games-extension.ts`, its jobs moved to
   `lib/apps/games-jobs.ts`, its firewall section and install panels are drawn
   by `app/(app)/apps/games/extension-slot.tsx`. Catalog data and port policy
   (`games-catalog`, `ark-maps`, `port-advice`, `port-block*`, `game-logo`) are
   core. Places registers `apps/places/src/lib/places-extension.ts`: its jobs,
   what it starts at boot (its container upgrade and the camera watcher) and who
   it reaches through a lent camera or door. Its footage storage setting
   (`lib/footage-storage.ts`) is core; the zoom arithmetic moved on to `@polaris/ui/zoom`.
2. **Move the app's code under its own workspace** (`apps/game-servers`,
   `apps/places`): services, routes, screens, jobs, tests - including the
   routes that still sit in the dashboard's tree (`app/(app)/apps/games`, the
   game tabs under `app/(app)/apps/installed/[id]`, `app/api/apps/games`,
   `app/api/minecraft`, and the `app/api/cron/game-*` triggers). Still compiled
   into the image, loaded through the registry. Verifiable here.

   Both have moved. Places lives in `apps/places` (`@polaris-app/places`) and
   Game servers in `apps/game-servers` (`@polaris-app/game-servers`): their
   services, screens and route bodies live there, their Next routes are one-line
   bridges in the dashboard, and `test/build/app-packages.test.ts` fails if
   either side reaches past that.

   What both sides read as plain data - the list of games, the probe timeout -
   lives in `@polaris/core` rather than on the host, because the host offers
   functions only (an app may take a service before the dashboard has provided
   it, and only a function can stand in for one). The few synchronous helpers an
   app calls while rendering are offered as they are and named, each with its
   reason, in `test/build/app-host-contract.test.ts`; everything else loads on
   first use, and on the client anything with a graph of its own - the charts,
   the log viewer, the sharing dialog - is loaded when it is first drawn.

   The host API is `@polaris/app-host`. An app takes the dashboard's services
   from `host.<area>.<name>` and its client pieces from `hostUi.<area>.<name>`;
   the dashboard fills both in - `lib/app-host/server.ts` and
   `components/app-host/client.tsx` - and those two files are the whole of what
   an app may reach. `AppHost` and `AppHostTypes` are augmented there, so an app
   is type-checked against the running dashboard and a service taken away breaks
   the app at compile time rather than at runtime.

   Four rules the implementation is held to:

   - Every server service is loaded when it is first called, so importing the
     host costs nothing and a test that replaces a dashboard module replaces it
     for the apps too.
   - That turns a synchronous service into a promise, which nothing in the types
     objects to inside a template string, so
     `test/build/app-host-contract.test.ts` refuses one whose module is not
     already asynchronous unless every call in every app awaits it.
   - Every service the host offers is a function, so a name an app takes before
     the dashboard has provided anything - a module evaluated at its top level,
     ahead of the request that would otherwise have provided them - gets back a
     stand-in that finds the real service when it is called rather than when it
     is looked up. Only calling one before boot still fails, and says so.
     `instrumentation.ts` imports `lib/app-host/server` first, before anything
     else runs, so that window is only ever a module reached outside a normal
     page, route or server action.
   - What is pure and shared moves to a package instead of the host: the zoom
     arithmetic went to `@polaris/ui/zoom`, `LOCAL_TARGET` was already in
     `@polaris/core`. So does anything an app runs in the browser: the server
     host exists only in the Node process, which is why the item search the
     game panels run on every keystroke is `@polaris/core/catalog-search`, and
     `app-host-contract.test.ts` fails if a module a client component reaches
     imports the server host.

3. **Bundles.** Build each app workspace into a bundle in CI; add the loader,
   the resolution hook, the catch-all routes and the import map; stop compiling
   the app workspaces into the dashboard image. Needs a container to verify.
4. **Install, uninstall and update deliver bundles**, including the updater
   replacing installed bundles on update, and the migration for existing
   instances: an instance that has the app installed gets its bundle on the
   update that ships phase 3, before the old code is gone from the image.
   Needs a container to verify.
5. **Places** through the same phases.

Phases 3 and 4 change how every deployment is updated and cannot be exercised
on the development machine, which has no Docker. They are verified on a staging
host before release, and phase 3 ships with the in-image copy still present so a
bundle that fails to load falls back to it for one release.
