# The command still running at quit is missing from the restored session

**Symptom.** Restore session is on and the tabs come back, but a command that
was still running when Rook quit - typically an agent such as `claude` left
open when the machine was shut down - is not among them, while everything
before it returns. The `blocks` table showed why: every `claude` row there is
one that was exited by hand, and none exists for a session that ended with it
running.

## Cause: a block is only saved when it finishes

Every save path - `save_block`, the autosave, the quit path added for
[the session-not-saved-on-shutdown fix](session-not-saved-on-shutdown.md) -
persists a block from `ModelEvent::SaveBlock`, which is only ever sent when a
command completes. A command still executing when the process ends has never
reached that point, so it was never written, however close to the snapshot it
was.

## The fix

`on_should_terminate_app` now calls `workspace::save_running_blocks` right
after the session snapshot, so a logout, a restart, and the Windows shutdown
path it already reaches before the shells are ended all cover it the same way.

For each terminal pane in every tab and window, apart from one already being
closed, `TerminalView::interrupted_running_block`
builds a block from the one actually executing - skipping a background block,
an in-band command block, and one whose shell has not finished bootstrapping
to its first prompt - stamped with `completed_ts: Local::now()` and exit code
130, the code already used for Ctrl-C and shown by the block list as
interrupted rather than failed.

The quit can still be cancelled after this runs, so `save_block` now deletes
any existing row for the same pane and block id before inserting: the command
finishing normally later overwrites its interrupted copy instead of appearing
twice.

`app/src/lib.rs`, `app/src/workspace/global_actions.rs`,
`app/src/pane_group/mod.rs`, `app/src/terminal/view.rs`,
`app/src/persistence/block_list.rs`.

## What it does not cover

- A background block, a block for an in-band command, or a pane whose shell
  has not reached its first prompt yet: none of these produce an interrupted
  block, the same as before this fix.
- A forced quit or a power cut that skips `on_should_terminate_app` entirely -
  the same gap `session-not-saved-on-shutdown.md` describes for the rest of
  the session.
