# Repository layout

What each top-level entry is, and how the client apps came to sit under
`clients/`.

## Today

| Entry | What it is |
| --- | --- |
| `.claude/` | Claude Code commands, skills and settings for work on Polaris. |
| `.github/` | Workflows, composite actions, issue templates, dependabot, and the community files (`CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`). |
| `.dockerignore`, `.gitattributes`, `.gitignore` | Repo-wide rules. |
| `CITATION.cff`, `LICENSE`, `NOTICE.md` | Citation and legal. |
| `CLAUDE.md` | Repo-wide constraints for agents. |
| `README.md` | The project page (Spanish copy in `docs/README.es.md`). |
| `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` | The root Rust workspace (`crates/`, `vendor/`); `clients/terminal` is excluded. `Cargo.lock` is pinned by the tunnel fingerprint check. |
| `crates/` | Rust crates: core (and its node/wasm/opaque bindings), hostd, native host, stream100, tunnel. |
| `dashboard/` | The Polaris server: web app, site, extension, Stream Deck plugin, CLI, packages, Docker files, install and update scripts. |
| `clients/` | The apps that are not the server: `desktop/` (Electron), `terminal/` (Polaris Terminal, its own Cargo workspace, `docs/terminal-integration.md`) and `device-addons/` (Hercules Stream 100, with its publisher in `scripts/`). |
| `docs/` | Design notes, plans, bug and vulnerability ledgers, media. |
| `mobile/` | The Android and iOS apps. |
| `tv/` | Polaris TV: launcher, add-ons, themes, device notes, tools. |
| `vendor/` | Vendored `smoltcp`. |

## Never moves

`dashboard/` and everything an installed deployment's update reaches:
`dashboard/scripts/install.sh`, `dashboard/scripts/update.sh`,
`dashboard/docker/docker-compose.yml`, and the hostd update command, which has
the host repository path baked in at install time. Installs update only from
the Settings button (root `CLAUDE.md`), so a moved path there breaks every
deployment with no way to repair it. `crates/`, `vendor/` and the root Cargo
files stay too: the tunnel fingerprint pins `Cargo.lock`, and
`dashboard/docker/docker-compose.yml` builds hostd from
`crates/polaris-hostd/Dockerfile`.

## The regroup

The client apps moved under `clients/`:

| From | To |
| --- | --- |
| `desktop/` | `clients/desktop/` |
| `terminal/` | `clients/terminal/` |
| `device-addons/` | `clients/device-addons/` |
| `scripts/device-addons/publish.mjs` | `clients/device-addons/scripts/publish.mjs` (the root `scripts/` then goes) |

The root now holds `.claude/`, `.github/`, `clients/`, `crates/`,
`dashboard/`, `docs/`, `mobile/`, `tv/`, `vendor/` and the files above.

### What changed with it

Counted on `feat/terminal-rename` while it was planned; the regroup commit
re-ran the same `git grep`s and changed every reference to the moved folders
(mobile, TV and site entries below were for the full regroup and did not
change). One shipped link moved with it: `tv-compat/quirks.json` names a
desktop source file, which a deployed dashboard shows until it updates.

- **Relative imports one level deeper.** `desktop/`: 45 files import
  `../../../dashboard/...` (or four levels from `src/main/native-host`,
  `src/main/runner`, `test/electron`), plus `desktop/tsconfig.json` and
  `desktop/vitest.config.mts` path aliases (`../dashboard/packages/core/...`),
  `desktop/build/launcher-ui.mjs`, and `desktop/test/electron/links/run.mjs`
  (`join(DESKTOP, "../dashboard/...")`). `mobile/scripts/season-icons.mjs`
  imports `../../dashboard/...`. `tv/` has none outside itself (its `../docs`
  links are to `tv/docs`). `terminal/` has none (two commented-out paths in
  `Cargo.toml`).
- **Workflows.** `desktop.yml` (18 references: `paths`, `working-directory`,
  cache keys, artifact paths), `mobile.yml` (11), `tv.yml` (12), `site.yml` (4,
  the TV catalog), `play-screenshots.yml` (1), `device-addons.yml` (4, and the
  publisher path), and the terminal set: `terminal.yml` (`changes` patterns,
  `working-directory`, rust-cache `workspaces`, the rook.dev guard),
  `terminal-release.yml`, `terminal-auto-release.yml`,
  `.github/actions/terminal-prepare-environment`, `.github/dependabot.yml`
  (`/terminal`).
- **Root files.** `Cargo.toml` `exclude = ["terminal"]`, `.dockerignore`,
  `.gitignore` (the `tv/launcher` test-certificate exception).
- **Code and data outside the moved folders that name them.** Rust:
  `crates/polaris-native-host/src/ipc.rs`, `crates/polaris-stream100*`
  (manifest paths, tests). Dashboard: `dashboard/scripts/tv-compat-import.mjs`
  (`git log -- tv/examples`, source links), `dashboard/scripts/readme-media`,
  `dashboard/apps/site/src/lib/tv-gallery.ts`, comments in
  `dashboard/apps/web/src/lib/tv/*` and `packages/ui/src/downloads`. Desktop
  tests reading `device-addons/`. 29 Markdown files name `desktop/`, 5
  `mobile/`, 2 `device-addons/`, 4 `terminal/`.
- **Links that already shipped.** `dashboard/packages/core/src/tv-compat/*.json`
  carries `github.com/FJRG2007/polaris/tree/main/tv/examples/...` links that a
  deployed dashboard shows; GitHub does not redirect a moved path, so those 404
  on every install until it updates, and links in old releases stay broken.
  `mobile/android/fdroid/app.polaris.mobile.yml` has `subdir: mobile/android/app`
  and a source link: the copy in F-Droid's own metadata repository must change
  in the same window or F-Droid's next build fails.
- **Agent tooling.** Root `CLAUDE.md` and memory notes naming `desktop/`,
  `tv/`, `terminal/` paths; `terminal/CLAUDE.md` and its skills use paths
  relative to `terminal/`, which stay valid.

### Verify after

Desktop typecheck, tests and build; mobile and TV builds where they build on
this machine (otherwise their workflows on the push); dashboard `npm run
build`; the site build (TV catalog); `git grep` for each old prefix returns
only history notes; every workflow's `paths` and `working-directory` resolve
(`changes` jobs report, no required check left pending).

### Decided: a partial regroup

Only `desktop/`, `terminal/` and `device-addons/` (with
`scripts/device-addons/`) move to `clients/`. `tv/` and `mobile/` stay where
they are:

- `tv/` stays because deployed dashboards ship
  `github.com/FJRG2007/polaris/tree/main/tv/examples/...` links in
  `dashboard/packages/core/src/tv-compat/*.json`; GitHub does not redirect a
  moved path, so every install would show broken links until it updates, and
  old releases forever.
- `mobile/` stays because F-Droid builds from its own copy of
  `mobile/android/fdroid/app.polaris.mobile.yml` (`subdir: mobile/android/app`),
  which this repository cannot change in the same push.
