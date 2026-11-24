# A restored pane comes back in the home directory

**Symptom.** Restore session is on and the tabs do come back, with their names
and their blocks, but every one of them starts in the home directory instead of
the directory it was in. The directory is lost for good: the first save after
the restart writes the home directory over the one that was stored.

## Cause: a pane with no shell yet is persisted as having no directory

`TerminalPane::snapshot` took the directory from `TerminalView::pwd_if_local`,
which reads the current working directory out of the active block's metadata.
A shell reports that at its first prompt, so between the moment a pane is
created and the moment its shell finishes bootstrapping there is none, and the
pane is snapshotted as `cwd: None`.

Nothing prevents a save inside that window. The autosave runs every 15 seconds,
and a window move, a focus change or an exit all take a snapshot of their own.
A restart that ends before the shells bootstrap - installing an update is the
ordinary way to get one - therefore stores a session whose panes have no
directory at all, and the launch after it has nothing to start them in.

`create_pty` passes the directory through to the spawn as `start_dir`, and on
Windows `CreateProcessW` is given `USERPROFILE` when there is none:

```rust
let start_directory = options
    .start_dir
    .filter(|start_dir| start_dir.is_dir())
    .or_else(|| std::env::var_os("USERPROFILE") ... );
```

So the pane opens in the home directory, reports it at its first prompt, and
that is what the next save stores. One short restart is enough to erase every
directory in the window, and nothing recovers them afterwards.

### How it was established

From the user's own database and logs, not reasoned about.

`terminal_panes` holds a distinct, correct directory per pane while the app is
running, so the save path works:

| pane | stored cwd |
| --- | --- |
| 1 | `<dev>/polaris` |
| 3 | `<dev>/ByteHide` |
| 6 | `<dev>/rook` |

The `blocks` table records the directory each command ran in. After the launch
at 08:32:40, the panes above ran their next commands here:

| block | time | pwd |
| --- | --- | --- |
| 49-51 | 09:58-09:59 | `<home>` |
| 47 | 09:49:38 | `<home>` |
| 40-42 | 09:09-09:48 | `<home>` |

The launch before it explains why they had nothing to restore. It was a
three-second session, ended by an update:

```
02:45:33Z Starting rook ...
02:45:33Z dispatching global action for root_view:open_from_restored
02:45:33Z Creating terminal model with 4 restored blocks      (x6)
02:45:34Z Starting direct shell process: powershell.exe       (x6)
02:45:35Z Failed to resize pseudoconsole: The pipe is being closed.
02:45:36Z Downloaded update to v0.2026.09.10.21.32.oss_00
02:45:36Z dispatching global action for workspace:save_app
02:45:36Z application will terminate
```

Six shells spawned, none of them bootstrapped, and a save two seconds later.

## The fix

`TerminalPane::snapshot` now persists `pwd_or_startup_path_if_local`, which
falls back to the directory the session was started in when the shell has not
reported one. That value is what the pane was created with, in the same native
form the current directory is persisted in, so a pane that has not bootstrapped
round-trips its directory unchanged however many restarts it takes.

`startup_path_for_new_session` reaches for the same value when a new tab
inherits its directory from a session that is still bootstrapping, but it also
converts a WSL startup path out of its unix form. That conversion is not
repeated here: the field is written only when the model is constructed and
every caller passes a native path, so converting one again would corrupt it.

`shell_launch_data` was read from the live session the same way and lost the
same way - persisted as null during the window, restored as the preferred shell
rather than the one the pane had, and then saved over the original. It now
falls back to `active_shell_launch_data`, which the shell starter sets before
bootstrapping begins and which persists afterwards. The fallback is reached
only when the live session reports nothing, so it cannot override a live value.

Both fallbacks take a lock on the model of their own, so `is_read_only` is now
read before the snapshot rather than inside it. A lock taken inside a struct
literal is not released until the whole literal has been evaluated, so the
field that held one left every field after it unable to take its own. The
directory was only safe there because it was read first.

## What it does not cover

- A shell killed after the user has changed directory, where the pane is
  snapshotted with no live session: the startup path is restored rather than
  the last directory. On Windows this is not the shutdown path - Rook saves on
  `WM_ENDSESSION` while the shells are still alive - so what it affects is a
  shell that crashes and a pane left behind it.
- A WSL pane whose startup path was stored in its unix form rather than the
  native one. Nothing writes the field that way - it is set only when the model
  is constructed, and every caller passes a native path - and the existence
  check drops such a value rather than persisting it, so the pane restores as
  it did before this fix rather than in a converted directory.
- No automated test covers the fix. The behavior only appears on a snapshot
  taken before a real shell bootstraps, which the mock terminal used by the
  pane-group unit tests never does, so the deterministic seam for it does not
  exist yet.
