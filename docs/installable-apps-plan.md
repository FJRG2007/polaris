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

3. **Bundles.** Built and loaded; the in-image copy is still compiled in and is
   what answers unless a server is switched to bundles. How it was built, and
   where it departs from the model above:

   - **The bundler** is `packages/app-host/bundler/build.mjs` (esbuild). An app
     says what it is in its package.json under `polaris`: its catalog id, its
     extension, the component that draws its slots. The server half is one
     CommonJS file whose entry lists the extension, every route by the path it
     answers (the file's place under `src/routes`) and every server action
     module; routes and actions load on first use. The browser half is ES
     modules, one entry per `"use client"` module plus shared chunks. A bundle
     is a zip, deterministic: an app that did not change between two builds has
     the same digest, so an update does not download it again.
   - **Shared libraries** are not resolved by a Node module hook but by a table
     the dashboard fills from its own webpack-compiled modules
     (`lib/app-bundles/shared-server.ts`, `components/app-bundles/runtime.ts`).
     A hook would have resolved `@polaris/db` to the copy in `node_modules`,
     which is a second database client, not the dashboard's. Every name is read
     when the app reads it, because Next compiles the dashboard once per layer
     and the layer that draws server components (React without hooks, client
     components as references) may register its copies after an app has loaded.
   - **Screens.** An app page is a server component drawn by a catch-all route
     per surface (`/places/[[...path]]`, `/apps/games/[[...path]]`; API routes
     under `/api/home`, `/api/minecraft`, `/api/apps/games`,
     `/api/apps/installed/[id]`), matched against the bundle's route list with
     Next's precedence (`lib/app-bundles/route-match.ts`). Where the app imported
     a client component, the server half has a reference that draws
     `AppBundleMount`, which imports the app's browser module (no import map:
     the dashboard's chunks are not ES modules) and draws it with the same props.
   - **Server actions** cannot be registered with Next after the build, so the
     browser half's are calls to `/api/app-bundles/action`, which runs only a
     function the bundle declares as an action, refuses another origin as Next
     does, carries `Date`/`Map`/`Set`/`BigInt` (`wire.ts`), and answers a
     `redirect()` and a revalidation the way Next's own actions do.
   - **Verified** against a production build served locally: every Places page
     and the Game servers page rendered from the bundles, their client modules
     loaded, their actions answered, a mutation revalidated, a call with no
     session was sent to sign-in and one from another origin refused.
     `test/app-bundles/bundles.test.ts` builds both real bundles, unpacks them
     and evaluates every route and action module in Node.

4. **Delivery.** CI builds the bundles in the image build (`app-bundles` stage)
   and the image keeps only `app-bundles/index.json`: each app's bundle by
   digest. They are published into the dashboard's own GHCR package as OCI
   artifacts (`docker/app-bundles.sh`), pushed untagged with the image and
   tagged `latest-app-<id>` by the job that moves `latest`; `ghcr-prune.yml`
   keeps those tags and deletes every older bundle like an older image. A
   separate package would have needed making public by hand.

   The dashboard fetches what it needs itself (`lib/app-bundles/lifecycle.ts`),
   at boot for every installed app - `isAppInstalled`, which counts a game
   server or a per-game manager as Game servers installed - and on install. A
   bundle is accepted only if it hashes to the digest its own image names, and
   is unpacked onto `polaris-data` (`/var/lib/polaris/apps/<id>/<digest>`), the
   previous build's removed. So an update needs no updater support and works the
   same in the limited edition: the new dashboard boots, finds no bundle for its
   build, fetches it from the registry it has just been pulled from. An image
   built on the host (the `build` update source) carries its bundles inside,
   since nothing published them. Uninstalling unloads the app and deletes its
   folder; its data stays.

   During this release a server serves apps from bundles only when
   `/var/lib/polaris/apps/use-bundles` exists, and falls back to the in-image
   copy for any app whose bundle is not loaded. Removing the in-image copy is
   the next step, once a live box has run on bundles.
5. **Places** went through the same phases with Game servers.
