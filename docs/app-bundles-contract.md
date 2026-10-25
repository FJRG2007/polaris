# App bundles: versions and updates of their own

Each installable app (Game servers, Places, Calendar, CRM, ...) is a bundle
loaded into the dashboard's process (see
[installable-apps-plan.md](installable-apps-plan.md)). This note is the
contract that lets an app and the dashboard sit on different versions, and an
app update alone, the way Home Assistant add-ons and Grafana plugins do.

## The host API version

- The dashboard provides one API to apps: the services of `host` / `hostUi` and
  the shared libraries a bundle takes instead of carrying. Its version is
  `HOST_API` in `@polaris/app-host/version` (`MAJOR.MINOR`), mirrored as
  `hostApi` in `packages/app-host/package.json`, which is what the bundler
  reads. A test keeps the two equal.
- Add a service: raise the minor. Remove one, or change what one takes or
  returns: raise the major.
- An app may declare `polaris.hostApi` in its package.json; it defaults to the
  dashboard it is built beside. The bundler writes it into `manifest.json` and
  refuses a value that dashboard does not provide.
- A dashboard runs a bundle when the major is the same and its minor is at
  least the bundle's (a caret range). A bundle with no `hostApi` was built
  before this existed and is read as `1.0`.
- Checked before a line of the bundle runs (`checkCompatible` in
  `lib/app-bundles/loader.ts`): format, host API, shared libraries. A miss is
  `BundleIncompatible`, which names the side to update. The app's screen then
  says "needs an update" with the button for it, never a crash.

## Releases and updates

- Every bundle is published by CI as an OCI artifact in the dashboard's own
  package, and `latest-app-<id>` is moved with `latest`. Its OCI manifest
  carries the app's version, host API, the commit and the first item of the
  app's `CHANGELOG.md` as annotations. The zip itself has no commit in it, so
  an app that did not change keeps its digest and is not downloaded again.
- Settings -> Apps reads each installed app's channel, shows the installed and
  available build and the change line, and updates or rolls back one app
  (`lib/app-bundles/releases.ts`).
- Trust is the image's: TLS to the registry the dashboard is pulled from, the
  manifest has to hash to the digest the registry names, the zip to the digest
  and size in the manifest. Then the bundle has to load. Only then is it swapped
  in; anything short of that leaves the running build serving.
- The swap is one map entry in the process. Requests inside the old build
  finish there; pages opened before it still load their browser files from the
  old folder. The old build's work keeps running (a server's container, a copy
  in progress) and the new build's `onBoot` is not run on a swap.
- `state.json` in `$POLARIS_DATA_DIR/apps/<id>/` records the build in use, the
  one before it (kept for rollback) and the image bundle it was pinned under.
  A dashboard update brings the image's own bundle; an install with no state
  gets the image's bundle, as before. Nothing needs the host daemon, so the
  limited edition works the same.
- While an app that was not running is being brought up, its pages show
  "Updating", its routes answer 503 with `Retry-After`.

## Not exercised here

Pulling from the real registry and swapping inside a running container have
not been run on the development machine; the tests stub the registry.
