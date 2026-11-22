# Rust core ledger

One row per unit of [the Rust core plan](rust-core-plan.md). A unit changes
state only with a link to the CI run that proves it; "blocked" carries its
reason. Phases 3-7 get their rows when the phase before them is serving.

| Unit | TS source | State | Checks | Budgets | Shadow | Blocker |
|---|---|---|---|---|---|---|
| F1 crate skeleton + vectors | new | not started | | | | |
| F2 napi binding, 5 platforms | new | not started | | | | |
| F3 wasm binding + lazy loader | new | not started | | | | |
| F4 facade framework (mode, shadow, fallback) | new | not started | | | | |
| F5 `rust-core` CI workflow | new | not started | | | | |
| F6 packaging (image, Electron, extension) | new | not started | | | | |
| F7 ledger check | new | not started | | | | |
| P1 phone in Rust | `dashboard/packages/core/src/phone.ts` | not started | | | | |
| P2 phone facade | `dashboard/packages/core/src/phone.ts` callers | not started | | | | |
| P3 phone shadow -> serving | - | not started | | | | |
| E1 MLS core over OpenMLS | new | not started | | | | |
| E2 MLS storage providers | new | not started | | | | |
| E3 MLS cross-target interop | new | not started | | | | |
| E4 MLS scale benchmarks | new | not started | | | | |
| E5 MLS wiring behind the E2EE flag | new | not started | | | | |
