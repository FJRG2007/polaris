# Rook

A terminal built from the open-source [Warp](https://github.com/warpdotdev/warp) client, with the performance work upstream has not done. Windows, macOS and Linux.

**10x less memory for the output a session holds, and a per-command database check 100x cheaper.** Both come from a real 76 MB session: the database figure timed directly, the memory figure a measured per-block cost applied to that session's actual blocks. The table below says what each number measures and what it does not.

Upstream is an excellent terminal that behaves poorly under sustained use: input and scrolling stutter on machines with a discrete GPU, opening a tab stalls, tabs vanish after a restart, and it gets slower the longer it stays open. Rook keeps the terminal and fixes what was behind those symptoms.

Every change below rests on a measurement taken on a real machine, not on reasoning about what ought to be faster. `docs/bugs/` records each one: the symptom, the evidence, the cause, and what the fix does not cover.

## Measured against upstream

Each row is one operation on one machine, not a benchmark suite, and each says what it measures. The gains are in what Rook *consumes* - memory and work per command. Nothing here measures how fast the terminal feels, so nothing here claims it.

| | Upstream | Rook | Measured on |
| --- | ---: | ---: | --- |
| Retention check after every command | 2.14 ms | 0.02 ms | A real 76 MB database. The `blocks` table had no index, so the check scanned all of it. |
| Memory held by retained output | 127 MB | 12.7 MB | The block-size distribution in that same database - 1,618 blocks - against the per-block cost measured below. |
| One finished 300-row block | 251 kB | 18.7 kB | A 200-column grid. Upstream keeps it as 24-byte cells; Rook compacts it once the block can no longer change. |
| CLI-agent hook, per tool call | ~400 ms | 97 ms | The Claude Code plugin's hooks, rewritten to one process each. |
| Orphaned rows in the database | 97% | 0 | That 76 MB database. Blocks whose pane had been closed were never deleted. |

Two of those want the fine print. The memory row is a measured per-block cost curve applied to real block sizes rather than a reading of live RSS, and it is a floor: the database keeps at most 100 blocks per pane while the running session kept every one. And reading compacted output costs ~325 ns a row, so a frame pays around 16 us of its 16.6 ms budget - real, and far below what anyone can see.

Not measured, and so not claimed: the GPU fix, session persistence and tab restore are correctness, and how much faster the terminal *feels* is not something this table can tell you.

## What differs from upstream

**Rendering runs on the discrete GPU.** Upstream sets `prefer_low_power_gpu` to true on Windows, so a machine with a dedicated card renders the terminal on the integrated one. Every repaint pays for it: typing, scrolling, selecting text, switching panes. Rook defaults to the discrete GPU there and keeps the integrated one as the crash fallback, so an unstable driver still recovers on its own. Override with `system.prefer_low_power_gpu`.

**The blocks table is indexed.** `blocks` shipped with no index at all, so the retention check that runs after every completed command scanned the whole table, as did session restore at startup. Measured on a 76 MB database: 2.14 ms per command before, 0.02 ms after. Blocks belonging to closed panes are deleted now rather than accumulating forever - 97% of the rows in that database were orphaned.

**A pane stops growing without bound.** Panes kept every block they had ever produced, and each block holds its output as a grid of cells, so a long session with a lot of agent output grew until the pane was closed. That is why it got worse the longer it ran and better after a restart. Panes now keep a budget of output, `terminal.max_retained_output_lines`, and drop their oldest blocks past it.

**Finished output costs a fraction of what it did.** A block held its output as a grid of 24-byte cells, which is what a live block needs and pure waste once it has finished. Upstream has the code to compact one into its run-length-encoded form on finish, behind a flag only its feature-flag server can turn on - so in a fork it never ran. Rook turns it on, above a five-row threshold upstream does not have, because below that the compaction costs more than it saves and most blocks are one-line blocks. A 300-row block: 251 kB, now 18.7 kB.

**The session is actually saved.** Upstream wrote it on window move, resize, focus change and close, and skipped it entirely while shutting down, so a restart restored whatever the layout happened to be some time earlier. Rook writes it every 15 seconds and again on the way out.

**The CLI-agent plugins cost a fraction of what they did.** The Claude Code, Codex and Gemini CLI integrations spent around 400 ms of process spawning after *every tool call*. They live in `plugins/` now, rewritten to one process per hook: 97 ms.

**Updates come from GitHub.** Upstream's version server refuses the `oss` channel that Rook ships on, so its update pipeline could never have served this fork. Rook asks the GitHub releases API instead and tells you when a newer release exists. It does not install it: there is no unattended installer here, and the button opens the releases page.

## Install

Download from [Releases](https://github.com/FJRG2007/rook/releases):

| Platform | File |
| --- | --- |
| Windows | `RookOssSetup.exe` |
| macOS | `.dmg` |
| Linux | `.AppImage` |

Nothing is code-signed, because this project holds no Apple or Windows certificate. Windows SmartScreen warns on first run: choose "More info" then "Run anyway". macOS refuses an unsigned app until you right-click it and pick Open, or clear the quarantine flag with `xattr -dr com.apple.quarantine /Applications/RookOss.app`. On Linux, `chmod +x` the AppImage and run it.

Verify a download against the checksum on the release page if you would rather not take that on faith.

## Build from source

Rust is pinned by `rust-toolchain.toml`, and Git LFS is required for the bundled assets.

```bash
./script/bootstrap    # installs the platform's build dependencies
./script/run          # build and run
./script/presubmit    # fmt, clippy, and tests
```

Windows additionally needs Git for Windows and Visual Studio Build Tools 2022.

To produce an installer:

```bash
./script/linux/bundle --channel oss --packages appimage    # Linux
./script/macos/bundle --channel oss --nosign               # macOS
```

```powershell
.\script\windows\bundle.ps1 -CHANNEL oss -ARCH x64         # Windows
```

CI runs clippy, tests and a release-profile check on all three platforms, and `cargo fmt --check` on Linux alone, since formatting is platform independent. Pushing a `v*` tag builds every installer and attaches them to the GitHub release.

## The CLI-agent plugins

`plugins/` holds Rook's integrations for Claude Code, Codex, Gemini CLI and OpenCode, and the terminal installs them from here. They are the upstream plugins with their hook cost removed; Rook does not accept the upstream builds, because those still carry it.

## Tracking upstream

`script/rebrand.py` performs the rename, so upstream changes can be merged by copying the new files in and running it again. It preserves what the rename must not touch: third-party repositories under the upstream organization, the external crates whose package names carry the upstream brand, the protobuf identifiers reached through `api::`, licence files, binary assets, and the classifier's tokenizer vocabulary.

`/catch-up` does the whole pass, and `docs/upstream-sync.md` records where Rook deliberately differs so a port does not silently undo one of these fixes.

## License and attribution

Rook is a fork of [warpdotdev/warp](https://github.com/warpdotdev/warp) and inherits its licensing. The `rookui_core` and `rookui` crates are [MIT](LICENSE-MIT); everything else is [AGPL v3](LICENSE-AGPL). The bundled plugins under `plugins/` are MIT and keep their own licence files. Warp is a trademark of its owners and this project is not affiliated with or endorsed by them.
