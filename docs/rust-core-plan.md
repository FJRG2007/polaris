# Rust core: plan and ledger rules

Decided on 2026-11-23. Polaris becomes **Rust-first for shared logic**: anything
that can be standardized and sped up in Rust is written once in Rust and built
for every place Polaris runs - the server (Node), the browser and the extension
(WebAssembly), the desktop app (Node inside Electron) and, later, native mobile
screens. The UI stays the React UI it is today.

This replaces the 2026-11-13 line in [the roadmap](roadmap.md) that started a
Rust core "only when a measured client bottleneck needs it". The UI decision in
that roadmap (desktop stays on Electron, no React-to-Rust UI rewrite) still
stands; the research behind it found no tool that converts React to a Rust UI
and no case of agents doing it, and Discord's Project Phoenix numbers come from
rebuilding its UI by hand.

## 1. The rule nobody may bend: the user notices nothing

Polaris must look and behave **exactly** as before every step of this plan:
the same screens, the same pixels, the same flows, the same errors, the same
data on disk and on the wire. The only visible difference allowed is that it is
faster or lighter. Concretely:

1. **No UI change rides along.** A unit in this plan never edits a component,
   a style, a translation or a route. If a unit seems to need one, it stops and
   the change is proposed separately.
2. **Same API.** Each Rust module sits behind a TypeScript facade with the
   exact signature, types, errors and edge behaviour of the TypeScript code it
   replaces. Callers do not change.
3. **Same data.** Byte-identical output wherever output is stored or sent
   (ciphertexts excepted where randomness is part of the format, in which case
   decryption parity is the bar). Old data written by TypeScript reads in Rust
   and the reverse, for as long as both exist.
4. **Always a way back.** Every module has a per-module switch and falls back to
   the TypeScript implementation by itself when the Rust one fails to load,
   panics or times out. A fallback is logged server-side, never shown.
5. **First paint never waits on Rust.** WebAssembly is fetched lazily, after
   the screen is drawn, and only by the screens that use it.
6. **It ships only if it is measured better.** A module serves real traffic
   only after a benchmark shows it faster or lighter than the TypeScript one on
   the same inputs, on every target it runs on.

## 2. What "done" means, and what is not done

Agents (and people) tend to round up. These are the rules that stop it.

- **No simulation.** A stub, a mock in runtime code, a `todo!()`,
  `unimplemented!()`, `unreachable!()` on a reachable path, an `#[ignore]`d test,
  a `panic!` used as "not supported yet", a TypeScript `throw new Error("not
  implemented")`, or a facade that silently calls the TypeScript version while
  claiming to be Rust: each of these is a unit **not done**. CI greps for them
  in `crates/` and in the facades (see 4.6).
- **No "equivalent for now".** If the Rust version cannot be faithful (a
  library is missing, a target cannot do it), the unit is marked **blocked** in
  the ledger with the reason. It is never replaced by a simpler stand-in.
- **1:1 is checked, not claimed.** A unit is done only when every check in
  section 4 for it has run and passed, and the ledger row links the CI run.
- **Nothing pending.** A unit is not split into "done" plus a follow-up that
  carries part of its acceptance criteria. Either all of its criteria pass, or
  it is not done.
- **Every unit is in the ledger before work starts** (`docs/rust-core-ledger.md`,
  section 7). Work that is not in the ledger is not part of this plan.

## 3. Architecture

### 3.1 Layout

```
Cargo.toml                       workspace (exists: polaris-hostd, polaris-tunnel)
crates/
  polaris-core/                  pure logic, no I/O, no platform code; one module per domain
    src/<domain>/...             e.g. phone, mls, search, sync, media
  polaris-core-node/             napi-rs binding -> @polaris/core-native (server, Electron main)
  polaris-core-wasm/             wasm-bindgen binding -> @polaris/core-wasm (browser, extension, WebView)
  polaris-core-ffi/              uniffi binding -> Kotlin/Swift (native mobile screens, later)
  polaris-core-vectors/          golden test vectors shared by every target (JSON fixtures + generator)
dashboard/packages/
  core-rs/                       the TypeScript facades: one file per domain, same API as today,
                                 picks Rust or TypeScript by switch, runs shadow mode, falls back
```

- `polaris-core` holds no transport, no filesystem, no clock it does not take as
  an argument, and no randomness it does not take as an argument (randomness is
  injected so tests are deterministic and parity is checkable).
- Bindings are thin: they convert types and map errors. No logic lives in a
  binding; a test checks the binding crates contain no domain code beyond
  conversion.
- Errors cross the boundary as the same error codes and messages the
  TypeScript code throws today.

### 3.2 Targets and how each gets the code

| Where it runs | Binding | Packaging | Notes |
|---|---|---|---|
| Dashboard server (Next.js, Node) | napi-rs | prebuilt `.node` per platform in the image: linux-x64-musl and linux-arm64-musl at least, matching the image base | loaded once per process; falls back to TS if the `.node` is missing |
| Desktop (Electron main) | napi-rs | prebuilt per platform (win-x64, mac-x64, mac-arm64, linux-x64) inside the app, ABI checked against Electron 44 | signed with the app |
| Browser dashboard | wasm-bindgen | `.wasm` emitted as a hashed static asset, fetched lazily | `wasm-opt -Oz`, brotli budget per module |
| Browser extension | wasm-bindgen | packaged in the extension, MV3 CSP `wasm-unsafe-eval` | Firefox MV2 build checked separately |
| Android/iOS WebView apps | the browser build | same as the browser | WebKit checked in CI (headless WebKit) |
| Native mobile screens (later) | uniffi | Kotlin/Swift packages | only when a native screen exists |

### 3.3 The switch, shadow mode and fallback

Each domain has a mode, set per instance with a default in code (so every
existing install works with no setup, per CLAUDE.md):

- `ts` - TypeScript only (the starting default of every module).
- `shadow` - both run; the TypeScript answer is served; the outputs are compared
  and any difference is recorded (domain, input hash, both outputs' hashes,
  never the plaintext of anything private).
- `rust` - the Rust answer is served; on load failure, panic or timeout the
  TypeScript one is served and the fallback is recorded.

A module moves `ts -> shadow -> rust` only through the gates in section 5. The
mode lives in one place per domain inside `core-rs`, and a test lists every
domain and its mode so a change is visible in review.

## 4. The testing standard (the tunnel bar)

`crates/polaris-tunnel` is the reference: 35 unit tests in `src`, seven
integration suites under `tests/` driving real sockets on a current-thread
runtime like production, deterministic seeds, fixtures, and a "hostile network"
suite (`tests/review.rs`). Every module in this plan meets at least that, plus
the parity checks a replacement needs. A unit is not done until **all** of
these exist and pass in CI:

### 4.1 Golden vectors
- A generator runs the **current TypeScript implementation** over a corpus of
  inputs (real-shaped, edge, empty, huge, unicode, malformed) and writes the
  outputs to `crates/polaris-core-vectors/<domain>/*.json`.
- The Rust crate, the napi build and the wasm build each replay every vector
  and must produce identical output. Vectors are committed; regenerating them
  is a reviewed change.
- For standards (MLS RFC 9420, E.164), the official test vectors are replayed
  too.

### 4.2 Property equivalence
- `fast-check` in TypeScript generates random inputs and asserts
  `rust(input) == ts(input)` through the napi build, at least 10,000 cases per
  property in CI, seed printed on failure.
- `proptest` in Rust covers invariants (round-trips, idempotence, ordering).

### 4.3 Fuzzing
- `cargo fuzz` target per parser/decoder entry point; a CI job runs each for a
  fixed time on every change to that domain; crashes become regression vectors.

### 4.4 Cross-target parity
- The same vector set runs on: native Rust, napi on Node (Linux, Windows,
  macOS runners), wasm in headless Chromium, WebKit and Firefox, and wasm in
  Node. Any divergence between targets fails the build.

### 4.5 Integration and failure injection
- The facade is tested with the Rust build present, absent (file deleted),
  failing to instantiate, panicking, and slower than its timeout: in each case
  the caller gets the TypeScript answer and a fallback is recorded.
- Shadow mode is tested: a planted difference is recorded with hashes only.
- The existing TypeScript test suites of the callers run unchanged with the
  domain forced to `rust` and to `shadow`. They must pass without editing a
  single test.

### 4.6 No-simulation guard
- CI fails on `todo!`, `unimplemented!`, `#[ignore]`, `dbg!`, `println!` in
  library code, and on `not implemented` strings, under `crates/polaris-core*`
  and `dashboard/packages/core-rs`.
- A test asserts each facade's Rust path really calls the binding (a spy on the
  binding, not on the TypeScript implementation).

### 4.7 Performance and size budgets
- `criterion` benchmarks in Rust and a matching Node benchmark of the
  TypeScript version on the same vectors; results committed per module.
- The module may serve only if median and p95 are better on every target, and
  memory per operation is not worse.
- Each wasm module has a brotli size budget written in its ledger row; CI fails
  when it is exceeded. First paint is measured on the dashboard before and
  after: it may not move.

### 4.8 Visual and behavioural non-regression
- The dashboard's existing render/component tests and the headless UI harness
  run in `rust` mode; a screenshot set of the screens that use the domain is
  compared pixel by pixel between `ts` and `rust` modes.

## 5. Rollout gates per module

1. **Built**: 4.1-4.6 green, ledger row filled.
2. **Shadow**: deployed with mode `shadow` by default; runs on real traffic for
   at least 7 days with zero recorded differences, or every difference
   explained, fixed and turned into a vector.
3. **Serving**: 4.7 and 4.8 green; mode `rust` by default; fallback rate
   watched; any non-zero rate of panics is a stop.
4. **TypeScript removed**: after 30 days serving with no fallback caused by a
   Rust defect, the TypeScript implementation is deleted - except where old
   clients (desktop, extension, mobile on older versions, see the version-skew
   memory) still need it; then it stays until those versions age out.

## 6. Phases and work units

Each unit below becomes one or more ledger rows. A unit is sized so one agent
can finish it, with every check, in one session.

### Phase 0 - Foundations (nothing user-facing changes)

| Unit | What | Done when |
|---|---|---|
| F1 | `crates/polaris-core` skeleton in the workspace; `polaris-core-vectors` with the vector format and loader | builds on Linux/Windows/macOS; vector loader tested |
| F2 | `polaris-core-node` with napi-rs; prebuilt `.node` for linux-x64-musl, linux-arm64-musl, win-x64, mac-x64, mac-arm64 | a trivial exported function returns the same value on every platform in CI |
| F3 | `polaris-core-wasm` with wasm-bindgen, `wasm-opt`, lazy loader that never blocks first paint | loads in headless Chromium, WebKit, Firefox and Node; size budget enforced |
| F4 | `dashboard/packages/core-rs` facade framework: per-domain mode, shadow comparison with hash-only records, fallback on missing/failed/panicking/slow binding | 4.5 failure-injection tests pass with a test domain |
| F5 | CI: a `rust-core` workflow (fmt, clippy `-D warnings`, tests, fuzz smoke, cross-target parity, size and benchmark jobs, no-simulation guard) | runs on every change under `crates/polaris-core*` and `core-rs` |
| F6 | Packaging: the dashboard image carries the `.node` for its platform; Electron carries its builds; the extension carries the `.wasm` with the right CSP | each artifact built in CI and checked to load in a smoke test |
| F7 | The ledger file and its CI check (every domain in `core-rs` has a ledger row and vice versa) | check fails on a missing row |

### Phase 1 - Pilot: phone numbers (smallest, fully deterministic)

`dashboard/packages/core/src/phone.ts` (parse, validate, format, country list on
`libphonenumber-js/min`). Chosen first because it is pure, used on client and
server, and has official vectors.

| Unit | Done when |
|---|---|
| P1 | Rust implementation matching `phone.ts` exactly, including `libphonenumber-js/min` metadata behaviour (which numbers are valid, as-you-type formatting) | 4.1-4.6 green against vectors generated from `phone.ts` |
| P2 | Facade `@polaris/core-rs/phone` with the same exports as `phone.ts`; all callers' tests pass in `rust` and `shadow` modes | 4.5, 4.8 green |
| P3 | Shadow, then serving | gates 2-3 |

If the Rust phone library cannot match `libphonenumber-js/min` validity 1:1, P1
is **blocked**, not approximated.

### Phase 2 - End-to-end encryption (MLS)

Chat E2EE phase 2 has not started; OpenMLS compiled by us to WebAssembly was
chosen in phase 0 (`docs/chat-e2ee-phase0.md`, spike in
`dashboard/experiments/mls-spike`). This is new code, so "parity" is against
the MLS standard and the plan in `docs/chat-e2ee-proposal.md`, not against a
TypeScript version.

| Unit | Done when |
|---|---|
| E1 | `polaris-core::mls` over OpenMLS: group create, add/remove, commit, welcome, external join, application messages, with injected randomness and storage traits | RFC 9420 test vectors pass on every target |
| E2 | Storage provider on IndexedDB (wasm) and on the server's store (napi) | crash/restart mid-commit tests pass |
| E3 | Interop: native, napi and wasm members in one group exchange messages | cross-target group test passes |
| E4 | Scale tests at 2, 50, 1,000 and 5,000 members matching or beating the spike's numbers | benchmark committed |
| E5 | Wiring behind the existing internal E2EE flag only; nothing user-visible until the E2EE plan says so | chat suites pass with the flag on and off |

The chat E2EE rules (invisible to users, every chat migrated, gov-grade) apply
in full.

### Phase 3 - Existing chat crypto

`dashboard/packages/chat-crypto` (account key, hybrid envelope, locks, QR
approval) and `vault-crypto` (TOTP). Byte-identical outputs for deterministic
parts; decryption parity both ways for randomized parts; old stored data must
open.

### Phase 4 - Local search index

A shared index for the dashboard search, the extension launcher and the desktop
launcher (Alt+Space). Today's search is server-side; the client index is new, so
its parity bar is "same results and ranking as the server search for the same
data", checked on vectors, plus memory and latency budgets per target.

### Phase 5 - Sync, cache and offline

The stale-while-revalidate cache and live updates moved into one core with the
same observable behaviour; starts only after Phases 0-4 are serving. Its units
are written when Phase 4 is serving, from a fresh inventory of where caching
lives in the dashboard today.

### Phase 6 - Shared validation and parsers

Zod schemas stay the source of truth for forms. Only parsers that are hot or
duplicated (file parsing in `packages/file-parse`, Markdown in
`genoffice-markdown`, archive reading) are candidates, one ledger row each,
each with its own vectors.

### Phase 7 - Media

Server thumbnails and image work (today `sharp`), audio processing for calls
and the notetaker. Output must be pixel- or sample-identical where it is stored;
where the codec allows variation, the bar is a perceptual-difference threshold
written in the ledger before work starts.

Phases 3-7 each get their unit table, in the same shape as Phases 1 and 2, when
the phase before them reaches "serving". They are not started from this summary.

## 7. The ledger

`docs/rust-core-ledger.md` holds one row per unit:

| Column | Meaning |
|---|---|
| Unit | id from this plan (F1, P1, ...) |
| TS source | the files it replaces, or "new" |
| State | not started / in progress / built / shadow / serving / TS removed / blocked |
| Checks | links to the CI run for each of 4.1-4.8 that applies |
| Budgets | size (brotli), latency median/p95 per target, memory |
| Shadow | start date, differences seen, how each was resolved |
| Blocker | reason, if blocked |

A unit changes state only with the CI link that proves it. The ledger is
reconciled at the end of every session that touches this plan.

## 8. Risks

- **Size.** WebAssembly adds weight (OpenMLS is ~371 KB brotli). Mitigation:
  per-module lazy loading and budgets; never in the first paint path.
- **Boundary cost.** Calling Rust for tiny functions can be slower than staying
  in JavaScript. Mitigation: 4.7 decides; a module that is not faster stays TS.
- **Platform builds.** Five native targets plus wasm multiply CI time.
  Mitigation: build only on changes under `crates/polaris-core*`; cache by
  input hash (see the CI policy); no paid runners.
- **Version skew.** Desktop, extension and mobile apps on older versions talk
  to newer servers. Wire and storage formats must not change in a way older
  clients cannot read.
- **Two implementations at once.** Until removal, every change to a migrated
  domain is made in both and the vectors catch drift.
