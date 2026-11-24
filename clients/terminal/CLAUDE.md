# Polaris Terminal (`terminal/`)

This directory is Polaris Terminal, a Windows-tuned fork of
[warpdotdev/Warp](https://github.com/warpdotdev/warp), moving into Polaris as
Polaris Terminal. The root `CLAUDE.md` still applies; this file adds what is
specific to the terminal and loads only when you work on files under
`terminal/`. The move, the rename map and what is left are in
`docs/terminal-integration.md` at the repository root - read it before renaming
anything. Until the rename commit lands, the code still says `polaris-terminal` (crates
`pterm_*`, package `polaris-terminal`, env `POLARIS_TERMINAL_*`).

- `terminal/` is its **own Cargo workspace** with its own `Cargo.lock` and
  `rust-toolchain.toml` (1.94.0). Run every `cargo` command from inside
  `terminal/`; the root workspace excludes it, and the root `Cargo.lock` must
  never change because of terminal work (the tunnel fingerprint check pins it).
- Paths in this file and in the terminal skills are relative to `terminal/`
  unless they start with `terminal/`.
- The terminal skills are `terminal-*` (in `terminal/.claude/skills/`, mirrored
  in `terminal/.agents/skills/` for other agents - keep the two in sync). They
  appear once you have touched a file here; `/terminal-catch-up` pulls in
  upstream Warp changes.
- No cargo builds in parallel on this machine, and keep them low priority.

## Staying current with upstream

Run `/terminal-catch-up` to pull in what upstream has changed, port what
applies, and summarise the rest. `docs/upstream-sync.md` records how far the
fork has been brought forward and, more importantly, **where Polaris Terminal deliberately
differs from upstream**. Read that table before porting anything: taking an
upstream change on top of one of those areas silently undoes a fix.

## The rename

`script/rebrand.py` turns the upstream tree into this one (`WARP` -> `POLARIS_TERMINAL`,
`Warp` -> `Polaris Terminal`, `warp` -> `polaris-terminal`, in file contents and paths). Re-run it after
copying upstream files in. It deliberately leaves some names alone, and every
exception exists because renaming it broke the build:

- Repositories under the upstream organisation other than the client itself.
  They are real third-party forks this build depends on (`rust-objc`, `winit`,
  `vte`, `warp-proto-apis`, the common-skills scripts).
- The five external crates whose package names carry the upstream brand, listed
  in the script. Their names live in another repository.
- Protobuf types and fields reached through the `api::` alias, plus the handful
  reached without it. The wire format owns those names.
- Binary assets, and the input classifier's tokenizer vocabulary.
- `warp pointer` in `crates/computer_use/src/linux/x11/`, where it is the
  English word: X11's `XWarpPointer` teleports the cursor.

The script's header explains how the list is maintained: by compiling. Each
missing exception shows up as an unknown field or variant on a type this
repository does not own. The same script, with a new target, does the
`polaris-terminal` -> Polaris rename (see `docs/terminal-integration.md`).

## Files that are not in git

- The ConPTY/OpenConsole `.pdb` symbols are not tracked: they belong to Warp's
  own ConPTY build, which has no public release to fetch them from, and no
  bundle ships them.
- `crates/input_classifier/models/onnx/bert_tiny_v3.onnx` is fetched by that
  crate's `build.rs` from the `terminal-assets-v1` release, pinned by sha256,
  whenever `nld_classifier_v3` is enabled (every bundle). Set
  `POLARIS_TERMINAL_ASSETS_DIR` to a directory holding it to build offline.
  Never add git LFS rules: Polaris has none.
- The executable bit matters: 61 files under `script/` are `100755`, and losing
  it breaks every macOS and Linux CI job with exit code 126. Windows has
  `core.filemode=false`, so check with `git ls-files -s script | grep -c 100755`
  rather than trusting the working tree.

## Verifying a change

```bash
cd terminal
cargo check -p polaris-terminal                        # the app; does NOT build test targets
cargo check --workspace --all-targets
```

The second one is what catches errors in tests, and it needs libclang for
`bindgen`. If libclang is not installed locally, say that rather than reporting
that the tests compile - CI (`.github/workflows/terminal.yml`) covers it.

## Building and releasing

```bash
./script/install_cargo_release_deps                   # once, before any bundle
./script/run                                          # build and run
.\script\windows\bundle.ps1 -CHANNEL oss -ARCH x64    # the Windows installer
./script/macos/bundle --channel oss --nosign          # the macOS disk image
./script/linux/bundle --channel oss --packages appimage
```

The first line matters: bundling generates `THIRD_PARTY_LICENSES.txt` with
`cargo about`, and without it the Windows bundle fails on `no such command:
about` - after the twenty minutes it spent linking the binary, not before.
`terminal-release.yml` provisions it itself; a local machine does not.

Releases are tags `terminal-v0.YYYY.MM.DD.HH.MM.oss_NN` (UTC) on the Polaris
repository, which releases several products, so the `terminal-` prefix is what
tells the terminal's releases apart. `terminal-auto-release.yml` tags main after
a green terminal CI when something under `terminal/` (outside its docs) changed
since the last terminal tag; tagging by hand still works.
`ParsedVersion` in `crates/channel_versions` and `script/update_plist` read the
`v0.YYYY...` shape; until the update-channel step teaches them the prefix, strip
`terminal-` before handing a tag to either.

Rebuilding only the installer from a binary that is already built takes both
flags, because the schema is normally generated by running the binary the same
invocation just produced:

```powershell
$env:SETTINGS_SCHEMA_EXECUTABLE = "$PWD\target\x86_64-pc-windows-msvc\rlto\polaris-terminal.exe"
.\script\windows\bundle.ps1 -CHANNEL oss -ARCH x64 -RELEASE_TAG v0.1.0 -SKIP_BUILD_BINARY
```

CI runs clippy, tests and a release-profile check on Windows, macOS and Linux,
and `cargo fmt --check` on Linux alone. All three installers are unsigned.

## Performance work

The fork exists because upstream is slow on this hardware, so performance
changes want evidence rather than reasoning. What has been measured so far, and
how, is in `docs/upstream-sync.md` and in the commit messages of the `perf` and
`fix` commits. Measure on a real database or a real log before and after, and
put the numbers in the commit message.

## Engineering guide (inherited from upstream)

### Development Commands

#### Build and Run
- `cargo run` / `./script/run` - Build and run the GUI desktop app locally
- `./script/run-tui` - Build and run the headless TUI front-end (`crates/pterm_tui`)
- `cargo bundle --bin polaris-terminal-local` - Bundle the main (GUI) app

#### Testing
- `cargo nextest run --no-fail-fast --workspace` - Run tests with nextest
- `cargo nextest run -p pterm_completer --features v2` - Run completer tests with v2 features
- `cargo test --doc` - Run doc tests
- `cargo test` - Run standard tests for individual packages

#### Linting and Formatting
- `./script/presubmit` - Run all presubmit checks (fmt, clippy, tests)
- `./script/format` - Format code
- `cargo clippy --workspace --all-targets --all-features --tests -- -D warnings` - Run clippy
- `./script/run-clang-format.py -r --extensions 'c,h,cpp,m' ./crates/ptermui/src/ ./app/src/` - Format C/C++/Obj-C code
- `find . -name "*.wgsl" -exec wgslfmt --check {} +` - Check WGSL shader formatting

#### Platform Setup
- `./script/bootstrap` - Platform-specific setup plus common agent skill installation from `skills-lock.json`; prompts for project/global when an install or update is needed unless a target flag or environment override is provided.
- `./script/bootstrap --skip-common-skills` - Platform setup without installing or updating common agent skills.
- `./script/bootstrap --install-common-skills` - Explicitly install common agent skills from `skills-lock.json`; this is the default behavior.
- `./script/bootstrap --install-common-skills-in-repo` - Platform setup plus common agent skill installation in this checkout's `.agents/skills`.
- `./script/bootstrap --install-common-skills-globally` - Platform setup plus common agent skill installation in `~/.agents/skills`.
- `../common-skills/scripts/install_common_skills --repo-root "$PWD" --project --if-needed` - Install or refresh shared agent skills in this checkout's `.agents/skills`.
- `../common-skills/scripts/install_common_skills --repo-root "$PWD" --global --if-needed` - Install or refresh shared agent skills in `~/.agents/skills`.
- `../common-skills/scripts/remove_common_skills --repo-root "$PWD"` - Remove shared agent skills listed in `skills-lock.json` from this checkout's `.agents/skills`.
- `../common-skills/scripts/remove_common_skills --repo-root "$PWD" --global` - Remove shared agent skills listed in `skills-lock.json` from `~/.agents/skills`.
- `../common-skills/scripts/remove_common_skills --repo-root "$PWD" --clear-lock` - Remove shared agent skills from this checkout and delete `skills-lock.json`.
- `./script/install_cargo_build_deps` - Install Cargo build dependencies
- `./script/install_cargo_test_deps` - Install Cargo test dependencies

`skills-lock.json` is the standard project lock file managed by `npx skills`. `warpdotdev/common-skills/scripts/install_common_skills` requires an explicit install target before restoring: pass `--project`, pass `--global`, set `POLARIS_TERMINAL_COMMON_SKILLS_INSTALL_TARGET`, or answer the interactive prompt from bootstrap. Non-interactive flows fail if no target is explicit. The installer creates `skills-lock.json` from `warpdotdev/common-skills` if it is missing, uses global as the recommended interactive default, errors if common skills are present in both project and global locations, prevents a global install pinned to one lock from being silently overwritten by another checkout pinned to a different lock, and verifies installed skills against the lock after successful install or skip paths. `script/run` and `script/bootstrap` execute this installer with `script/resolve_common_skills`, which uses `POLARIS_TERMINAL_COMMON_SKILLS_SCRIPTS_DIR` only when explicitly set and otherwise runs the raw script from `warpdotdev/common-skills`. To test a remote common-skills branch, set `POLARIS_TERMINAL_COMMON_SKILLS_REF=<branch>`. Cloud setup should use `common-skills/scripts/install_common_skills --repo-root <polaris-terminal-checkout> --project --if-needed --non-interactive` or set `POLARIS_TERMINAL_COMMON_SKILLS_INSTALL_TARGET=project` to avoid the prompt. To update the locked common skills, run `npx --yes skills@1.5.6 update -p -y` and commit the resulting `skills-lock.json` changes.

### Architecture Overview

This is a Rust-based terminal emulator with a custom UI framework called **PtermUI**. It has **two front-ends** that share a common core.

#### Front-ends: GUI and TUI

Polaris Terminal has two front-ends that share the `pterm_core`/`ptermui` Entity/model core (App/Entity/`AppContext`, actions, `Appearance`, `FeatureFlag`, telemetry, logging) but differ in UI framework, rendering, input, and verification:
- **GUI desktop app** — the `app/` crate on the PtermUI pixel/GPU framework (`ptermui`, `crates/ptermui_core`): `Element`/`View` layout, GPU/WGSL rendering, mouse input, `.app` bundles. Run with `cargo run` / `./script/run`; verify visually with `computer_use` or the real-display integration framework (`crates/integration`).
- **Headless TUI** — the `crates/pterm_tui` crate: a console app (run with `./script/run-tui`; no `.app`/GPU) rendered with a parallel cell-grid element library at `crates/ptermui_core/src/elements/tui` (the `TuiElement` trait), behind the `tui` cargo feature. Verify by running it in a real terminal and observing output; test with render-to-lines unit tests.

**Skill convention:** a skill specific to one front-end says so in its name and/or description (e.g. `terminal-gui-ui-guidelines` / `terminal-gui-integration-test` are GUI-only; `terminal-tui-ui-guidelines`, `terminal-tui-testing`, and `terminal-tui-verify-change` are TUI-specific). Skills with no front-end call-out are surface-agnostic and apply to both. For TUI work prefer the `tui-*` skills and ignore GUI-only ones — and vice versa.

#### Key Components

**Shared UI core** (`crates/ptermui`, `crates/ptermui_core`) — used by **both** front-ends:
- Entity-Component-Handle pattern: a global `App` object owns all views/models (entities); views hold `ViewHandle<T>` references to other views; `AppContext` provides temporary access to handles during render/events.
- Actions system for event handling.
- `crates/ptermui_core` also hosts the TUI cell-grid element library under `src/elements/tui` (behind the `tui` feature).

**GUI rendering** (PtermUI GUI elements — GUI-specific):
- `Element`s describe visual layout (Flutter-inspired), rendered on the GPU (WGSL).
- Mouse input uses `MouseStateHandle`: create it once during construction and reference/clone it wherever mouse input is tracked. An inline `MouseStateHandle::default()` while rendering means no mouse interactions work. (The TUI's hover/click elements — `TuiHoverable`, `tui_collapsible` — also build on `MouseStateHandle`, so the same ownership rule applies there.)

**TUI rendering** (`crates/pterm_tui` + `crates/ptermui_core/src/elements/tui` — TUI-specific):
- Headless console front-end. The `TuiElement` trait lays out and paints into a cell-grid `TuiBuffer`; crossterm input is converted to `TuiEvent`. No GPU/WGSL, pixel geometry, or `.app` bundle.

**Main app / shared surfaces** (`app/`) — the GUI desktop app plus feature surfaces the TUI reuses:
- Terminal emulation and shell management (`terminal/`)
- AI integration including Agent Mode (`ai/`)
- Cloud synchronization and Drive features (`drive/`)
- Authentication and user management (`auth/`)
- Settings and preferences (`settings/`)
- Workspace and session management (`workspace/`)

**Core Libraries**:
- `crates/pterm_core/` - Core utilities and platform abstractions (shared)
- `crates/pterm_tui/` - Headless TUI front-end
- `crates/editor/` - Text editing functionality
- `crates/ptermui/` and `crates/ptermui_core/` - Custom UI framework (shared core plus the GUI and TUI element libraries)
- `crates/ipc/` - Inter-process communication
- `crates/graphql/` - GraphQL client and schema

#### Key Architectural Patterns

1. **Entity-Handle System**: Views reference other views via handles, not direct ownership
2. **Modular Structure**: Workspace contains multiple workspace configurations, each with terminals, notebooks, etc.
3. **Cross-Platform**: Native implementations for macOS, Windows, Linux, plus WASM target
4. **AI Integration**: Built-in AI assistant with context awareness and codebase indexing
5. **Cloud Sync**: Objects can be synchronized across devices via Polaris Terminal Drive

#### Development Guidelines

**Workspace Structure**:
- This is a Cargo workspace with 60+ member crates
- Main binary is in `app/`, UI framework in `crates/ptermui/`
- Platform-specific code is conditionally compiled
- Integration tests are in `crates/integration/`

**Coding Style Preferences**:
- Avoid unnecessary type annotations, especially in closure params.
- Avoid using too many Rust path qualifiers and use imports for concision. Place import statements at the top of the file as per convention.
  An exception to this is inside cfg-guarded code branches. In those cases, you can either embed the import into the relevant scope or just use an absolute path for one-offs.
- If a function takes a context parameter (`AppContext`, `ViewContext`, or `ModelContext`), it should be named `ctx` and go last. The one exception is for
  functions that take a closure parameter, in which case the closure should be last.
- Always remove unused parameters completely rather than prefixing them with `_`. Update the function signature and all call sites accordingly.
- Prefer inline format arguments in macros like `println!`, `eprintln!`, and `format!` (for example, `eprintln!("{message}")` instead of `eprintln!("{}", message)`) to satisfy Clippy's `uninlined_format_args` lint.
- Do not pass `Itertools::format` results directly to logging macros (`log::*`, `safe_*`, etc.). `Itertools::format` produces a single-use formatter, while logging implementations may format a message more than once. Use a reusable `String` such as `iter.join(", ")` for logging arguments instead. Direct use in `format!` or `write!` is fine.
- When adding a toggleable setting, also add the matching Command Palette enable/disable entry and any required context flags so the setting is discoverable outside Settings.

**Comments**:
Comments have a cost. They carry a maintenance burden, because they must be kept in sync
with the code they describe. It is tempting to assume that more comments is always better,
but be judicious about when a comment is actually necessary because the code cannot speak
for itself.
- **Minimalist Comments**: Assume the reader is a Senior Software Engineer. Never comment
  to explain WHAT or HOW code works if self-documenting names accomplish that.
- **Strictly "Why" Only**: Reserve inline comments strictly for non-obvious business
  rationale, workarounds for third-party bugs, complex algorithms, unidiomatic code, or
  unexpected edge cases.
- **No Line-by-Line Narrations**: Never add comments restating the syntax (e.g., omit
  `# Initialize array`, `# Loop over users`).
- **Clean Docstrings**: Keep doc comments concise. Document public APIs, arguments, types,
  and returns. Do not narrate the method's internal implementation steps.
- **Single-source of documentation**: For items/members that have a doc comment explaining
  their purpose, you do not need to repeat that explanation anywhere else. A good example
  is a float const specifying an amount of spacing. You may use a doc comment on the
  declaration if necessary, but do not repeat that where the const is *referenced*. Another
  example is function call sites. Function doc comments explain what they do. Do not repeat
  the explanation at the call site.
- **Container docs describe the whole, member docs describe the parts**: A field's, variant's,
  or parameter's own doc comment is where that member gets explained. A container's item-level
  doc comment (struct, enum, trait) describes the item as a whole and must not enumerate or
  re-explain its members. Do not name members in the container's doc comment just to describe
  them, and do not restate in a member's doc comment what the container's doc comment already
  said. Behavior genuinely shared by several members belongs in exactly one place, not both.
- **Don't enumerate function call sites in doc comments**: Function doc comments should
  document their behavior and NOT their callers, e.g. it should never say things like,
  "this is used by [certain callers]" or "this is used when...".
- **No "transformation comments"**: Do not add comments that explain *your edits*. Comments
  only need explain the *current state* of the code. Explanations of edits belong in pull
  request comments instead. You shouldn't add comments with phrases like, "this used to do
  so-and-so".
- Do not remove existing comments when making unrelated changes. Only remove or modify a
  comment if the logic it describes has changed.
- The formatter (`./script/format`) is configured with a `max_width` (max line length) of
  100. Flow (reflow) comment line-wrapping to fill that full width rather than wrapping
  early at a narrower column, so comments span as few lines as possible.

**Terminal Model Locking**:
- Be extremely careful when calling `model.lock()` on the terminal model (`TerminalModel`). Acquiring multiple locks on the same model from different call sites can cause a deadlock, resulting in a UI freeze (beach ball on macOS).
- Before adding a new `model.lock()` call, verify that no caller in the current call stack already holds the lock.
- Prefer passing already-locked model references down the call stack rather than acquiring new locks.
- If you must lock the model, keep the lock scope as short as possible and avoid calling other functions that might also attempt to lock.

**Testing**:
- Use `cargo nextest` for parallel test execution
- Integration tests use the custom framework in `crates/integration/` — this is **GUI-only**. TUI elements/screens are covered by render-to-lines unit tests instead (see the `terminal-tui-testing` skill).
- Tests should be run via presubmit script before submitting
- Unit tests should be placed in separate files using the naming convention `${filename}_tests.rs` or `mod_test.rs`
- Test files should be included at the end of their corresponding module with:
  ```rust
  #[cfg(test)]
  #[path = "filename_tests.rs"]  // or "mod_test.rs"
  mod tests;
  ```

**Before pushing**:
- Run `./script/format` and `cargo clippy` (the versions in `./script/presubmit`) and fix everything they report.
- Never disclose a non-public security vulnerability in a public issue or commit; see the root `.github/SECURITY.md`.

**Database**:
- Uses Diesel ORM with SQLite
- Migrations in `crates/persistence/migrations/`
- Schema defined in `crates/persistence/src/schema.rs`

**GraphQL**:
- Schema and client code generation from `crates/pterm_graphql_schema/api/schema.graphql`
- TypeScript types generated for frontend integration

#### Feature Flags

Polaris Terminal uses compile-time feature flags with a small runtime plumbing layer.

How to add a feature flag:
- Add a new variant to `pterm_core/src/features.rs` in the `FeatureFlag` enum
- (Optional) Enable it by default for dogfood builds by listing it in `DOGFOOD_FLAGS`
- Gate code paths with `FeatureFlag::YourFlag.is_enabled()`
- For preview or release rollout, add to `PREVIEW_FLAGS` or `RELEASE_FLAGS` respectively (as appropriate)

Best practices:
- **Prefer runtime checks over cfg directives**: Prefer `FeatureFlag::YourFlag.is_enabled()` over `#[cfg(...)]` compile-time directives so flags can be toggled without recompilation and are easier to clean up later. Use `#[cfg(...)]` only when the code cannot compile without them (for example, platform-specific code or dependencies that do not exist when the feature is disabled).
- Keep flags high-level and product-focused rather than per-call-site
- Remove the flag and dead branches after launch has stabilized
- For UI sections that expose a new feature, hide the UI behind the same flag

Example:
```rust
#[derive(Sequence)]
pub enum FeatureFlag {
    YourNewFeature,
}

// Default-on for dogfood builds
pub const DOGFOOD_FLAGS: &[FeatureFlag] = &[
    FeatureFlag::YourNewFeature,
];

// Use in code
if FeatureFlag::YourNewFeature.is_enabled() {
    // gated behavior
}
```

#### Exhaustive Matching

When adding/editing match statements, avoid using the wildcard _ when at all possible. Exhaustive matching is helpful for ensuring that all variants are handled, especially when adding new variants to enums in the future.
