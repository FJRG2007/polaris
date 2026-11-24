# The session is not saved on shutdown

**Symptom.** Restore session is on, but after shutting the machine down and
starting it again the tabs do not come back. Usually a couple return, often
stale, sometimes none, and their names and order are gone.

This was diagnosed twice. The first pass found a real gap and fixed it with a
timer; the timer then ran for two days without writing anything, because of a
second defect that hid it. Both are recorded here, because the second one is
the interesting one and the first one alone reads as a complete explanation.

## Cause 1: nothing wrote the session while it was closing

`save_app` in `app/src/workspace/global_actions.rs` is the only producer of
`ModelEvent::Snapshot`. It was reached from four window callbacks - move,
resize, focus change, close - plus scattered dispatches from menu and agent
code. `on_window_will_close` returns early once the stage is `Terminating`,
and `on_will_terminate` stopped the persistence writer without snapshotting
first, so what came back was the layout as of the last window move or focus
change, arbitrarily far behind.

The fix was a snapshot on the way out and a write every 15 seconds, the
latter bounding what an abrupt stop can take.

## Cause 2: the timer's dispatch was dropped before it reached the handler

The timer ran. Its saves did nothing.

There are two `dispatch_global_action` methods, and they want opposite
arguments for the same action:

```rust
// AppContext: takes the argument by value, then boxes it for the downcast.
pub fn dispatch_global_action<T: 'static + Any>(&self, name: &str, arg: T)

// MutableAppContext: takes it already erased.
pub fn dispatch_global_action(&mut self, name: &str, arg: &dyn Any)
```

An action registered for `()` must be given `()` through the first and `&()`
through the second. Passing `&()` to the first makes `T = &()`, the downcast
to `()` fails, and the dispatch is discarded.

Every call site in the tree is on the second method and correct, except one:
the autosave, which is on the first and passed `&()`. Finding that took two
wrong sweeps. The first changed all of them and the compiler rejected the
fifteen it could see; the second missed thirteen more in `app_menus.rs`,
which is `#[cfg(target_os = "macos")]` and so is not compiled by a Linux or
Windows job at all. Only the macOS runner reports on that file.

Nothing about that fails to compile - both forms are valid `T` - and in a
release build nothing is visible either. `add_global_action` carries a
`debug_assert!` on the failed downcast and a `report_error!`, and in a build
with assertions off and no telemetry host the only trace is one line in the
log file:

```
[ERROR] Could not downcast argument for action [action=workspace:save_app]
```

### How it was established

Counted in the user's own logs, not reasoned about:

| Log | save_app dispatched | dropped by the downcast |
| --- | --- | --- |
| The session open across the shutdown | 35 | 23 |
| A longer session the next day | 313 | 92 |

The dropped ones are exactly 15 seconds apart - 04:00:01, 04:00:16, 04:00:31,
04:00:46, 04:01:01 - which identifies them as the timer rather than anything
a user did. The window-event saves, which pass `&()` through the reference
method, are in the other column and had been working all along. That is why
the loss looked arbitrary: some tabs survived, on the schedule of whenever a
window had last been moved or focused.

## Cause 3: shutdown persists the app taking itself apart

Closing the last window tears the workspace down a tab at a time, and every
one of those closes dispatches `save_app` again. From the same log:

```
04:01:03Z storing data for closed tab
04:01:03Z dispatching global action for workspace:save_app
04:01:03Z dispatching global action for workspace:save_app
04:01:03Z dispatching typed action: PaneGroupAction::HandleFocusChange
04:01:03Z dispatching global action for workspace:save_app
04:01:03Z No windows left, terminating app
04:01:03Z application will terminate
```

Those saves are on the reference method, so they were not dropped. Each one
records a workspace with one fewer tab than the last, and the final state on
disk is whatever the teardown had reached. `save_app_state` deletes before it
inserts, so a snapshot with no windows at all does not fail - it leaves
nothing to restore.

## Cause 4: the OS kills the shells first, and each dead shell closed its tab

This is the one that survives every fix above, and the reason the symptom was
"exactly one tab comes back" rather than "a few". Found on the build that
already carried causes 1 to 3 fixed, after a Windows Update restart:

```
03:20:24Z Block finished with new state DoneWithNoExecution   (x5)
03:20:24Z storing data for closed tab                         (x5)
03:20:36Z dispatching global action for workspace:save_app    (every 15s)
...
03:21:59Z No windows left, terminating app
```

Five shells ended in the same second, at an idle prompt, with no key pressed,
and nothing happened to the window until the last shell died 95 seconds later
and took the last tab with it. `terminal_pane.rs` closed a pane whenever its
shell exited, so each tab was removed as its shell died. The autosave then did
its job and wrote, every 15 seconds, a session with one tab in it.

Nothing was lost in the write. The workspace had genuinely been reduced to
one tab by the time anything was saved, which is why the cure was never
going to be another save path.

### Why the shells went first

Csrss ends a session one process at a time, in descending order of shutdown
level (*Windows Internals*, "Shutdown"). A GUI process is sent
`WM_QUERYENDSESSION` and `WM_ENDSESSION`; a console process gets
`CTRL_LOGOFF_EVENT`. Every process starts at level 0x280, so Rook and the
shells in its tabs were in no particular order. `conhost` opts out entirely
(level 0) and exits with its clients.

Rook would not have noticed its turn anyway. Winit does not handle
`WM_QUERYENDSESSION` or `WM_ENDSESSION`, and `TerminationRequestSource::System`
was only ever produced on macOS; on Windows the default window procedure
approved the shutdown and nothing reached the app.

### The fix

What Windows Terminal does - `WindowEmperor.cpp` handles both messages on a
hidden top-level window - plus a place in the shutdown order:

- At startup Rook calls `SetProcessShutdownParameters(0x300, 0)`, the bottom
  of the range reserved for applications that go first. Csrss now reaches
  Rook before any shell.
- Each window is subclassed (`SetWindowSubclass`) for the two messages winit
  drops. `WM_QUERYENDSESSION` sets a process-wide flag,
  `rookui::windowing::is_os_session_ending()`, and approves;
  `WM_ENDSESSION` with `FALSE` - another application refused - clears it.
  `WM_ENDSESSION` with `TRUE` posts `CustomEvent::SessionEnded`, which the
  event loop turns into `should_terminate_app(TerminationRequestSource::System)`:
  the path a macOS logout already takes, which saves the session and never
  cancels.
- While the flag is set, a shell exit does not close its pane. Outside it,
  `exit`, `Ctrl+D` and a crashed shell close the tab exactly as upstream does.

Windows may end the process as soon as `WM_ENDSESSION` returns, so the posted
event is a courtesy: Rook saves once more and stops the writer cleanly if it
gets the time. The fix does not depend on it. The shells are still alive when
Rook is reached, no tab has closed, and the autosave already holds all of them.

`crates/rookui/src/windowing/winit/windows/session_end.rs`,
`crates/rookui_core/src/windowing/session.rs`,
`app/src/pane_group/pane/terminal_pane.rs`.

### The first attempt at this cause

Before the ordering was understood, a pane was kept whenever its shell exited
without `exit` or `logout` at the prompt. That covered the shutdown but read
the wrong signal: `Ctrl+D` sends no command, so on bash, zsh and fish it left
the tab open behind a "process terminated" banner, as did any shell that
crashed or was ended by a script. It was replaced by the flag above, which
changes nothing outside a session that is actually ending.

## Fix

- The autosave dispatches `()` through the by-value method.
- `save_app` stops writing once the stage is `Terminating`, and refuses a
  snapshot with no windows.
- The session is captured where it is still whole: on entry to
  `on_should_terminate_app`, which is where a logout, a restart or an OS
  shutdown arrives, and immediately before the last window closes. The
  snapshot in `on_will_terminate` is gone; by the time it ran there were no
  windows left to record.

`app/src/lib.rs`, `app/src/persistence/mod.rs`,
`app/src/workspace/global_actions.rs`.

## Durability

Writes that complete survive a power cut. The connection runs in WAL with
SQLite's default `synchronous`, so each commit is flushed. The problem was
never that writes were lost, only that they were not made.

The database showed repeated `A WAL mode database file was recovered`
warnings, which is how it was established that ungraceful exits actually
happen here rather than being hypothetical.

## What this does not cover

Anything changed in the last 15 seconds before an abrupt stop is still lost.

A shutdown that skips the messages - a forced one, or power lost - still
kills the shells and Rook together. Whatever the last autosave held is what
comes back; a tab closed in the second between them is not.

A text scan cannot tell the two dispatch methods apart, so there is no test
for the argument shape; the `debug_assert!` in `add_global_action` is the
guard, and it only fires where assertions are on. A dispatch whose action
name matches nothing registered is checked, in
`app/src/workspace/global_actions_tests.rs` - `root_view::open_new` in the
URI handler had a second colon and reached no handler at all.
