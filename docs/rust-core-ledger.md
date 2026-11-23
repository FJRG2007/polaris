# Rust core ledger

One row per unit of [the Rust core plan](rust-core-plan.md). A unit changes
state only with a link to the CI run that proves it; "blocked" carries its
reason. Phases 3-7 get their rows when the phase before them is serving.
`Domain` names the `@polaris/core-rs` domain a row owns (`-` for none); the
ledger check (`npm run check:ledger -w @polaris/core-rs`) fails when a domain in
`src/domains.json` has no row naming it, or a started row names a domain that
does not exist. A unit becomes `built` only with the CI run that proves it.

| Unit | Domain | TS source | State | Checks | Budgets | Shadow | Blocker |
|---|---|---|---|---|---|---|---|
| F1 crate skeleton + vectors | - | new | built | [rust-core run 45086056887](https://github.com/FJRG2007/polaris/actions/runs/45086056887) (commit e1c9dc7786): `cargo test -p polaris-core -p polaris-core-vectors` 19 passed (8 loader, 6 probe unit, 5 vector replays + proptests x10,000) on Linux x64 glibc, Windows x64, macOS x64, macOS arm64 and Alpine x64/arm64; `cargo fmt --check`, `cargo clippy --all-targets -D warnings` and clippy on wasm32 clean | | | |
| F2 napi binding, 5 platforms | - | new | built | [rust-core run 45086056887](https://github.com/FJRG2007/polaris/actions/runs/45086056887): `.node` built for win32-x64-msvc, darwin-x64, darwin-arm64, linux-x64-musl, linux-arm64-musl (musl in node:22-alpine, C runtime linked dynamically) and uploaded as artifacts; on each, `test:native` 11 passed (vector files raw and via facade, fast-check x10,000, present/absent/corrupt/copied/panic/slow/shadow) | | | |
| F3 wasm binding + lazy loader | - | new | built | [rust-core run 45086056887](https://github.com/FJRG2007/polaris/actions/runs/45086056887): wasm-bindgen 0.2.130 + wasm-opt 133 (`-Oz`); `test:wasm` 5 passed; `test:browsers` Chromium 156, WebKit 27.2, Firefox 157 headless: all vectors match, module fetched lazily; `check:size` ok; `.wasm` uploaded as an artifact | 8,628 B brotli (21,236 B raw) in CI, budget 10,240 B (`wasm-budget.json`) | | |
| F4 facade framework (mode, shadow, fallback) | `probe` | new | built | [rust-core run 45086056887](https://github.com/FJRG2007/polaris/actions/runs/45086056887): `npm test` 46 passed on all five binding platforms (facade modes, shadow hash-only records, fallback on missing/load-failed/stale/panic/slow/loading) plus the real-binding failure injection in `test:native` (5 platforms) and `test:wasm`; `tsc --noEmit` clean | | | |
| F5 `rust-core` CI workflow | - | new | in progress | [rust-core run 45086056887](https://github.com/FJRG2007/polaris/actions/runs/45086056887): `.github/workflows/rust-core.yml` green on every job - fmt, clippy `-D warnings` (native and wasm32), cargo tests, no-simulation guard, binding check (plan 3.1, `check:bindings`), ledger check, napi on 5 platforms, wasm in Node and 3 browsers, size budget; runs on every push and pull request, skips its work when nothing under the Rust core changed, one always-reporting `rust-core` job | | | Missing from its acceptance: the fuzz smoke job (no `cargo fuzz` target exists yet) and the benchmark job (no criterion benchmark yet) |
| F6 packaging (image, Electron, extension) | - | new | in progress | local (Windows 11 x64, 2026-11-23; CI pending): `smoke.mjs` (load the shipped binding through the facade, 12 inputs Rust == TypeScript incl. errors) passes on `native/` win32-x64, the web bundle's staged `public/core-rs`, and the extension's `.output/chrome-mv3/core-rs` and `firefox-mv2/core-rs`; `--manifest` passes on both manifests (MV3 `wasm-unsafe-eval`, MV2 default); desktop `npm run build` puts `dist/native/polaris-core.win32-x64-msvc.node`, typecheck + 1160 tests pass; `docker-manifests`/`docker-context`/`web-image-paths` tests pass. Not exercised locally: the Docker image (no Docker here; its build runs the check in the runner stage) and the packaged Electron app (`electron-forge package` stops without output on this machine) - desktop.yml runs `build/core-rs-smoke.mjs` per target. The image ships linux-x64-gnu, not musl: its base is glibc | |  | |
| F7 ledger check | - | new | built | [rust-core run 45086056887](https://github.com/FJRG2007/polaris/actions/runs/45086056887): `check:ledger` 15 rows, 0 problems; its failure cases in `test/unit/checks.test.ts` (46 passed); `check:guard` 34 files, 0 violations | | | |
| P1 phone in Rust | phone | `dashboard/packages/core/src/phone.ts` | not started | |  | |  |
| P2 phone facade | phone | `dashboard/packages/core/src/phone.ts` callers | not started | |  | |  |
| P3 phone shadow -> serving | phone | - | not started | |  | |  |
| E1 MLS core over OpenMLS | - | new | not started | |  | |  |
| E2 MLS storage providers | - | new | not started | |  | |  |
| E3 MLS cross-target interop | - | new | not started | |  | |  |
| E4 MLS scale benchmarks | - | new | not started | |  | |  |
| E5 MLS wiring behind the E2EE flag | - | new | not started | |  | |  |
