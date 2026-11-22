# Rust core ledger

One row per unit of [the Rust core plan](rust-core-plan.md). A unit changes
state only with a link to the CI run that proves it; "blocked" carries its
reason. Phases 3-7 get their rows when the phase before them is serving.
`Domain` names the `@polaris/core-rs` domain a row owns (`-` for none); the
ledger check (`npm run check:ledger -w @polaris/core-rs`) fails when a domain in
`src/domains.json` has no row naming it, or a started row names a domain that
does not exist. Until the F5 workflow runs, Checks quotes the local commands and
results, marked local; a unit becomes `built` only with the CI run.

| Unit | Domain | TS source | State | Checks | Budgets | Shadow | Blocker |
|---|---|---|---|---|---|---|---|
| F1 crate skeleton + vectors | - | new | in progress | local (Windows 11 x64, 2026-11-23; CI pending F5): `cargo test -p polaris-core -p polaris-core-vectors` 19 passed (8 loader, 6 probe unit, 3 vector replays + 3 proptests x10,000); `cargo clippy --all-targets -D warnings`, `cargo fmt --check` clean; `cargo check --target x86_64-unknown-linux-musl` ok. Linux and macOS builds not run yet | |  | |
| F2 napi binding, 5 platforms | - | new | in progress | local (Windows 11 x64, 2026-11-23; CI pending F5): `npm run build:rust` -> `polaris-core.win32-x64-msvc.node`; `npm run test:native` 9 passed (both vector files raw and via facade, 2 fast-check properties x10,000 incl. unpaired surrogates, present/absent/corrupt/copied/panic/slow/shadow). linux-x64-musl, linux-arm64-musl, mac-x64, mac-arm64 builds not run yet (F5) | |  | |
| F3 wasm binding + lazy loader | - | new | in progress | local (Windows 11 x64, 2026-11-23; CI pending F5): `npm run test:wasm` 5 passed (vectors via facade, fast-check x10,000, lazy load, real trap, bad module); `npm run test:browsers`: Chromium 156, WebKit 27.2, Firefox 157 headless all vectors match, .wasm not fetched before a Rust-backed call; `npm run check:size` ok | 8,558 B brotli (21,068 B raw), budget 10,240 B (`wasm-budget.json`) | |  |
| F4 facade framework (mode, shadow, fallback) | `probe` | new | in progress | local (Windows 11 x64, 2026-11-23; CI pending F5): `npm test -w @polaris/core-rs` (unit: facade modes, shadow hash-only records, fallback on missing/load-failed/stale/panic/slow/loading) plus the real-binding failure injection in `test:native` and `test:wasm`; `tsc --noEmit` clean | |  | |
| F5 `rust-core` CI workflow | - | new | not started | |  | |  |
| F6 packaging (image, Electron, extension) | - | new | not started | |  | |  |
| F7 ledger check | - | new | in progress | local (Windows 11 x64, 2026-11-23; CI pending F5): `npm run check:ledger` 0 problems; its failure cases in `test/unit/checks.test.ts`; `npm run check:guard` (plan 4.6) 0 violations | |  | |
| P1 phone in Rust | phone | `dashboard/packages/core/src/phone.ts` | not started | |  | |  |
| P2 phone facade | phone | `dashboard/packages/core/src/phone.ts` callers | not started | |  | |  |
| P3 phone shadow -> serving | phone | - | not started | |  | |  |
| E1 MLS core over OpenMLS | - | new | not started | |  | |  |
| E2 MLS storage providers | - | new | not started | |  | |  |
| E3 MLS cross-target interop | - | new | not started | |  | |  |
| E4 MLS scale benchmarks | - | new | not started | |  | |  |
| E5 MLS wiring behind the E2EE flag | - | new | not started | |  | |  |
