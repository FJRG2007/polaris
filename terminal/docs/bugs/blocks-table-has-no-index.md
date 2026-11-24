# The blocks table has no index

**Symptom.** Work proportional to the whole command history on every completed command and at every startup, growing with the size of the database.

## Evidence

`warp.sqlite` on the machine this was diagnosed on: 76 MB plus an 11 MB WAL, of which 71 MB was `stylized_output` on the `blocks` table.

The table had no index at all. `explain query plan` on the two queries that run against it:

```
retention COUNT(*)   ->  SCAN blocks
session restore      ->  SCAN blocks
```

Both are full scans over 18,668 pages. The first runs inside `save_block` after **every** completed command; the second runs at startup in `get_all_restored_blocks`.

Timed on that database, the retention count:

```
before   2.14 ms
after    0.02 ms      SEARCH blocks USING COVERING INDEX idx_blocks_pane_leaf_uuid
```

Separately, **1,596 of 1,640 rows (97%) were orphaned** - their pane no longer existed. `blocks.pane_leaf_uuid` has no foreign key, deliberately (see the note on `model::NewBlock`: a pane removed before a new snapshot would violate it), and nothing ever cleaned them up. They were unreachable, since restore only considers panes that still exist, but they sat in every scan of the table and accounted for most of its size.

## Cause

Two independent defects:

1. No index on `blocks(pane_leaf_uuid)`, so every lookup by pane was a scan.
2. No cleanup path for blocks whose pane is gone, so the table only ever grew.

The per-pane cap of 100 blocks that does exist is enforced in `save_block` for the pane being written, which is why it never reclaimed the orphans.

## Fix

A migration adds `idx_blocks_pane_leaf_uuid` on `(pane_leaf_uuid, is_background)` - `is_background` is included so the retention count is answered from the index alone - plus two indexes for the shapes command history is queried by.

Orphaned blocks are deleted in `setup_database`, after migrations. Startup is the one point where no session is running and the set of live panes is settled. A failure there is logged and ignored: it costs disk space, not correctness.

`crates/persistence/migrations/2026-09-07-120000_index_blocks_and_command_history`, `app/src/persistence/block_list.rs`, `app/src/persistence/sqlite.rs`.

## Verification

Both measured against a copy of the real database. The index change was verified by query plan and timing, shown above. The prune:

```
real database (76 MB, 1,613 orphans)        47 ms
inflated to 4.8 GB / 116,914 orphans      3,234 ms, once
```

The second is the shape of upstream [#8835](https://github.com/warpdotdev/warp/issues/8835), where the app hangs indefinitely instead. Paid once; afterwards the table stays small.

## What this does not cover

The prune frees pages for reuse, it does not shrink the file. SQLite only returns space to the filesystem on `VACUUM`, which rewrites the whole database and is far too expensive to run at startup. Growth stops either way.

One block row held 9.76 MB of output on its own. Nothing caps the size of a single block's persisted output; see [A pane retains every block it ever made](panes-retain-every-block.md) for the memory side of the same thing.
