# A pane retains every block it ever made

**Symptom.** Three complaints that turn out to be one bug:

- It gets worse the longer it stays open, and restarting makes it good again for a while.
- The more panes are open, the worse it is.
- The more agent sessions and the heavier the workload, the worse it is.

Worst on machines with 16 GB of RAM, which is what having less headroom before paging looks like.

## Cause

A pane accumulates one block per command and never frees any of them.

Searching the whole tree for a removal path turns up only two: `ClearMode::ResetAndClear` (the `clear` command), which drops everything but the current block, and removing one block explicitly. There is **no automatic eviction**.

The per-pane cap of 100 blocks that does exist, `MAX_TERMINAL_BLOCKS_TO_PERSIST_PER_SESSION`, applies to what reaches the database. Nothing capped what was held in memory.

Each block holds its output as a grid of cells, and `maximum_grid_size` - 50,000 rows - is the limit **per block**, not per pane. Deriving the cost from the actual structures:

```
Cell = char(4) + fg(5) + bg(5) + Flags:u16(2) + Option<Box<CellExtra>>(8)  ->  24 bytes
row of 120 columns                                                        ->  ~2.8 KB
one block at its cap                                                      ->  ~140 MB
```

That is not theoretical: one block in the real database held 9.76 MB of serialized output, roughly 10 MB as a live grid.

Every symptom follows from this:

- **Worse over time** - within a session blocks only accumulate.
- **Restarting helps** - only 100 blocks per pane are restored, so memory drops back.
- **More panes** - N panes, each unbounded.
- **More agent output** - a coding agent prints enormously, and each command becomes a block resident for the life of the pane.

## Fix

A pane now has a budget for retained output, and drops its oldest blocks when it exceeds it.

The budget is **lines of output, not a block count**, because a block count says nothing about memory: five hundred `ls` blocks and five hundred agent blocks differ by orders of magnitude. Lines are proportional to what is actually held.

`terminal.max_retained_output_lines` defaults to 20,000 - about 56 MB of output per pane, so many panes stay affordable on a 16 GB machine, while still keeping far more scrollback than the 100 blocks per pane that reach disk. For scale, Windows Terminal ships 9,001 lines and iTerm2 1,000. Set it to 0 to retain everything.

Eviction runs when a block is created, so the check happens once per command rather than per write, and costs one pass over a list the budget itself keeps short. It goes through `remove_command_blocks_at_indices`, the same path block removal already used, which drops the selection and the saved scroll position before removing - both can point into a block that is about to go.

`app/src/terminal/settings.rs`, `app/src/terminal/model/block.rs`, `app/src/terminal/model/blocks.rs`, `app/src/terminal/terminal_manager.rs`.

Those per-pane figures are the pre-compaction cost of a retained line. [Compacting a finished block](finished-blocks-keep-dense-cell-storage.md) cuts it by roughly an order of magnitude, so the same 20,000-line budget now costs a few MB a pane rather than tens.

### Two decisions made while implementing

**Only finished blocks are evicted.** The active block is being written to, and the background block sits directly before it and may still be receiving output. Both live at the end of the list, so stopping at the first unfinished block leaves them alone. Without this guard a busy pane could have dropped a background block mid-write.

**Blocks attached to an agent conversation are evicted.** This was considered and rejected as an exclusion: `remove_command_blocks_for_conversation` already removes those same blocks through the same helper, so it is a supported operation - and they are precisely the blocks that fill memory, so excluding them would have left the fix without effect in the case that motivated it.

## Verification

Two tests in `app/src/terminal/model/blocks_tests.rs`, run and passing:

```
test_retention_budget_stops_a_pane_growing_without_bound ... ok
test_retention_budget_of_zero_retains_everything ... ok
test result: ok. 2 passed; 0 failed
```

The first drives 40 commands against a deliberately tiny budget and asserts the pane stops growing with the number of commands rather than tracking it. It asserts the invariant rather than an exact block count, because the count depends on how the budget divides into block heights and a brittle number would not say anything more useful.

The second pins the opt-out: `0` has to keep meaning "retain everything", since `test_utils::block_size()` uses it and every other test in that file depends on eviction staying out of the way.

## What this does not cover

The active block cannot be evicted, and it is still bounded only by `maximum_grid_size` at 50,000 rows. The real ceiling per pane is therefore around 70,000 lines rather than 20,000. Lowering that second number truncates the output of a single command, which is far more visible, so it was left alone.
