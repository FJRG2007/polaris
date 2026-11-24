# A finished block keeps its output in dense cell storage

**Symptom.** Rook holds far more memory than the text on screen can account for, and the excess grows with everything the terminal has ever printed rather than with what is visible.

This is the second half of [a pane retains every block it ever made](panes-retain-every-block.md). That one bounded *how many* blocks a pane keeps. This one is about what each retained block costs.

## Cause

The terminal has two storage formats for grid content:

- **Grid storage** - a `Vec<Row>` of `Vec<Cell>`. A `Cell` is 24 bytes, tightly packed and documented as such in `crates/rook_terminal/src/model/grid/cell.rs`, and a cell costs those 24 bytes whether it holds a character or a space. It supports insertion anywhere, which is what a live block being written to needs.
- **Flat storage** - the same content in a flat buffer with run-length-encoded attribute maps. It supports index, scan, push and pop, but not insertion in the middle. It is dramatically smaller for the long runs of identical styling that real terminal output is made of.

Scrollback beyond the visible region already lives in flat storage. The rows a block was actively writing to stay in grid storage - correctly, while the block is live.

Once a block finishes, its contents are immutable, so nothing needs insertion any more and it can all move to flat storage. Upstream has the code for exactly that, at the end of `GridHandler::finish`:

```rust
if FeatureFlag::MaximizeFlatStorage.is_enabled() {
    self.resize_storage(1, self.columns());
}
```

That flag has **two references in the entire tree**: its declaration, and this check. It is not in `RELEASE_FLAGS`, `PREVIEW_FLAGS` or `DOGFOOD_FLAGS`, and there is no Cargo feature or channel that turns it on. Upstream drives it from their feature-flag server, which a fork has no access to, so `FLAG_STATES` keeps its `false` default forever and the compaction never runs.

Every finished block therefore kept the tail of its output in the 24-bytes-a-cell format for as long as the pane held it.

## Fix

`maximize_flat_storage` is now a Cargo feature in `app/Cargo.toml`, in the default set, wired to the flag through the same `enabled_features()` table every other launched feature uses. No bundle script passes `--no-default-features`, so it is on in every Rook build.

Measured on a 200-column grid, total bytes for one finished block:

| rows | dense | compacted | |
| ---: | ---: | ---: | ---: |
| 1 | 4.0 kB | 4.0 kB | left alone |
| 3 | 6.4 kB | 6.4 kB | left alone |
| 4 | 7.7 kB | 6.6 kB | 1.2x |
| 50 | 64.3 kB | 8.0 kB | 8.1x |
| 300 | 251.0 kB | 18.7 kB | 13.4x |

### Against a real session

Applying that cost curve to the block-size distribution in a real 76 MB database - 1,618 blocks across four panes:

```
lines per block   median 3   p90 26   p99 2453   max 5002
under the five-row threshold   988 blocks (61%)

dense        127.0 MB
compacted     12.7 MB
saved        114.3 MB   (10.0x)
```

This is the measured per-block curve applied to real block sizes, not a reading of live RSS. It is also a floor: the database keeps at most 100 blocks per pane, while a live pane held every block it had ever produced, so the session this came from was carrying considerably more than 1,618.

The distribution is the argument for the threshold on its own: **61% of real blocks are under five rows.**

### The threshold is Rook's, not upstream's

Compaction is not free below about five rows, and upstream applies it unconditionally. Flat storage carries a fixed per-block overhead for its index and attribute maps, while grid storage grows a row at a time, so for a one-line block compaction *costs* 2.6 kB. Most blocks are one-line blocks - `cd`, `git status`, anything that prints a line and exits; the real database above says 61% of them - so applied unconditionally this would have been a real regression across the majority of blocks.

`MIN_ROWS_TO_COMPACT` is 5, the measured break-even. Below it the block is left in grid storage. The table above shows the result: no size is a net loss, and nothing above the threshold gives up any of the saving.

## What it costs

Reads. A row in flat storage is materialized on demand rather than borrowed, at roughly 325 ns. A full scan of a 300-row block goes from 120 us to 184 us.

That is the worst case, and rendering is not it: a frame touches only the rows on screen, at most ~50, so it pays around 16 us of a 16.6 ms budget. Select-all and find over a whole block pay the full 64 us once. Neither is perceptible, and the same path already served the great majority of scrollback before this change.

## Verification

Two tests in `crates/rook_terminal/src/model/blockgrid_tests.rs`:

```
test_finishing_a_block_compacts_it_without_changing_its_content ... ok
test_a_short_block_is_left_uncompacted ... ok
```

The first builds the same 300-line block twice, with compaction on and off, and asserts the rendered rows are identical cell for cell before asserting the memory drop. Content equality is the point: flat storage is read back by materializing rows, so a bug there would corrupt scrollback silently instead of failing. The memory assertion is a 4x floor rather than the measured 13.4x, so the ratio can move with the storage formats without the test passing over a regression that undoes the fix.

The compaction path had no test at all before this. Beyond the two above, the whole terminal suite was run single-threaded with compaction forced on and forced off: 546 passing either way, the same pre-existing failures either way.

## What this does not cover

The active block is still in dense storage, which is correct - it is being written to. A single command that prints 50,000 lines still costs what it costs until it finishes.

The four secret-redaction tests that appear to fail when compaction is toggled are a red herring: they share a global regex through `set_user_and_enterprise_secret_regexes` and fail on test ordering under parallelism, with or without this change. That flakiness is real and unfixed, just unrelated.
