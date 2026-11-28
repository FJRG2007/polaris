# Release scope: who gets a new version, and when

Every client Polaris ships has its own way to reach people: the browser
extension through its `extension-v*` releases, the desktop app through
`desktop-v*`, the device plugins through the signed catalogue, the Stream Deck
plugin and the Companion module through their own tags, and the host through the
dashboard image's `latest` tag and the Update card. The rule for all of them is
the same:

> A client gets a new version, and anybody running it is asked to update, only
> when what it actually ships changed.

A version for anything else is an update every installation is offered for
nothing, and it teaches people to ignore the one prompt that also delivers
security fixes. The opposite mistake - a change that ships without a version -
never reaches anybody. Each check below is built to catch the second without
causing the first.

"What it ships" is decided from the client's build graph wherever one can be
read, the way Nx's and Turborepo's affected graph, esbuild's metafile or a
reproducible-build digest see a project: by what the build reads, not by which
folder a file is in.

## The rules

| Client | Versioned by | Counts as shipped | Checked by |
|---|---|---|---|
| Browser extension | `version` in `dashboard/apps/extension/package.json`, tagged by `extension-auto-release.yml` | Its build graph: `.github/scripts/extension-closure.mjs` | `extension-version-check.yml` (`bumped`, required) |
| Desktop app | `version` in `clients/desktop/package.json`, a `desktop-v*` tag pushed by hand | `clients/desktop/**` and the inputs listed in `desktop.yml`'s `paths` | Nothing automatic: only a pushed tag releases |
| Device plugins | `version` in each `clients/device-plugins/<id>/manifest.json` | The plugin's folder (not `listing.json` or its pictures) and its native crates, without tests, benches, examples or docs | `clients/device-plugins/scripts/version-guard.mjs` |
| Stream Deck plugin | Next `streamdeck-v*` tag, decided by CI | `dashboard/apps/streamdeck` without tests, docs and install scripts | `streamdeck.yml` plan step |
| Companion module | Next `companion-v*` tag, decided by CI | `dashboard/apps/companion` and the Stream Deck sources it imports | `companion.yml` plan step |
| Host (dashboard image) | The commit `latest` was built from | `WEB_IMAGE_PATHS` minus `NOT_SHIPPED` | `dashboard-publish.yml` `changes` job, mirrored by `update-service.ts` |

### Browser extension

`extension-closure.mjs` lists every repository file the extension's build turns
into what it ships:

1. Its own folder, all of it but `test/`, `vitest.config.ts` and Markdown.
2. The workspace modules the bundle renders code from. Rollup - the bundler
   WXT's Vite uses, at the lockfile's version - bundles the entrypoints WXT
   builds (each file in `src/entrypoints`, and the script each
   `<name>/index.html` loads), with `@polaris/*` imports resolved to their
   sources through each package's `exports`, and TypeScript stripped by esbuild
   as Vite does. A module whose `renderedLength` is zero in every chunk - used
   for its types only, or re-exported by `@polaris/core`'s barrel and shaken
   out - is not shipped. A stylesheet or picture counts once it is imported.
3. The `package.json` of every workspace package the bundle resolved into.
4. What the build reads besides imports: the on-page launcher's stylesheet
   (`scripts/search-styles.mjs` reads `@polaris/ui`'s tokens, Tailwind preset
   and the sources `searchSources()` names) and the binding's staging
   (`packages/core-rs/scripts/wasm-assets.mjs`).
5. The Rust crates the WebAssembly binding is compiled from (`polaris-core-wasm`
   and its path dependencies), as `crates/<name>/` prefixes without `tests/`,
   `benches/`, `examples/` or Markdown. `Cargo.lock` counts when
   `lock-reaches.py polaris-core-wasm` says the change reaches that crate.

The check computes the graph at the commit the branch left main from and at its
head, and fails only when a changed file is in either one (a change can take a
module out of the bundle as well as bring one in) and the version did not move
past main's and past the latest `extension-v*` tag. A change that touches none
of the extension, the workspace packages or the crates passes in seconds,
without installing anything. When the graph cannot be read the check counts
every source of the packages the extension depends on, the way it did before.

**Why the barrel still costs something.** `@polaris/core`'s root export
re-exports every module, no workspace package declares `sideEffects`, and a
module whose top level calls something a bundler cannot prove pure (a zod
schema, `Object.keys` of a table) is kept in the bundle. So roughly 160 of
core's 290 modules really are in the extension today: a change to
`permissions.ts` changes the bytes browsers download, and still needs a bump. A
change to `changelog.ts` does not, and no longer asks for one. The extension
importing subpaths alone does not shrink this: `@polaris/vault-crypto` imports
the root barrel too, and with that one import moved to `@polaris/core/vault`
(plus the extension's own imports and a dozen new subpath entries in core) the
list falls to about 25 core modules. That change reaches what the web app and
the vault package import, so it is left for a change of its own.

**Why the version is not decided by CI.** The Stream Deck plugin and the
Companion module are numbered by CI from their tags, with no bump commit. The
extension is not, on purpose: its version is part of the store listings and of
the update the extension runs itself (`src/lib/update.ts` downloads the asset of
the tag it reads), the package's version is what WXT writes into the manifest,
and `extension-auto-release.yml` tags what main says. CI choosing the number
would mean either a bot commit on main - which breaks the fast-forward-only
pushes everybody makes there - or a manifest whose version differs from the
checkout's, so a local build and a released one of the same commit would not
compare. The digest of the built package cannot decide it either without
building the extension on every pull request; the graph above answers the same
question - "did the output change?" - in about a second.

### Desktop app

Released only by a pushed `desktop-v*` tag: nothing in CI raises its version, so
nothing in CI can over-release it. The rule for whoever tags is the table's: a
change outside `clients/desktop/**` and the shared inputs in `desktop.yml`'s
`paths` (the TV compatibility list, `search-text.ts`, the Rust core binding and
the native messaging host) is no reason for a desktop release. The device
plugin catalogue reaches the desktop app at runtime and needs no desktop
version.

### Device plugins

A desktop app compares versions, not bytes, so a plugin whose package changed
under a published version is refused (`version-guard.mjs`). A change that is
not part of the package does not ask for a version: the plugin's `listing.json`
and pictures (the catalogue shows them), and in its native crates the tests,
benches, examples and docs that `cargo build` never compiles.

### Host

The Update card offers whatever commit `latest` was built from, and
`dashboard-publish.yml` moves `latest` only when an image's sources changed.
Those sources are matched against the changed files after `NOT_SHIPPED` is taken
out: a package's or crate's own test folder, `*.test.*` files and the test
runner's config are in the build context but in no image anybody runs. The
dashboard's `update-service.ts` holds the same two patterns (`WEB_IMAGE_PATHS`,
`NOT_SHIPPED`), so the card never says a build is on its way for a commit that
publishes none; `test/updates/web-image-paths.test.ts` fails when either copy
drifts from the workflow.

What the update list shows inside a range is decided from commit messages
(`packages/core/src/changelog.ts`), because GitHub's comparison names the
range's files but not each commit's. Device plugin commits leave it
(BUG-0075). A commit scoped to another client (`feat(extension)`,
`feat(desktop)`) stays listed: about two in five of those also change the
dashboard, and without each commit's files there is no telling which.

## Verifying

- Extension graph: `node .github/scripts/extension-closure.mjs` prints the list
  (Rollup and esbuild found by node, or in the folder `CLOSURE_TOOLS` names).
  `git diff --name-only <base> <head> | node .github/scripts/extension-closure.mjs shipped <checkout of base> .`
  prints the changed files that ship.
- Its tests: `node --test .github/scripts/extension-closure.test.mjs`; the ones
  that bundle run when `CLOSURE_TOOLS` is set, which the version check does
  whenever the script changes.
- Device plugins: `node --test clients/device-plugins/scripts/device-plugins.test.mjs`.
- Host: `test/updates/web-image-paths.test.ts` in the dashboard's suite.

Measured on the two bumps that started this (November 2026): 0.1.327 was raised
for `changelog.ts`, which the bundle does not contain, and would not be asked
for now; 0.1.328 was raised for `permissions.ts` and three other core modules
the barrel keeps, and still would be.
