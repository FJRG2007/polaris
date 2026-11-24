# The window stops responding while another program writes many files

**Symptom.** Rook goes "Not responding" for anything from 20 seconds to three
minutes, then recovers on its own, without anything being typed into it.

## How it was established

Nothing in Rook's own log explains a stall; the log only shows the hole. The
15-second autosave writes a line on the main thread, so a gap in those lines is
a gap in the main thread:

| Stall starts (UTC) | Length |
| --- | --- |
| 10:57:07 | 176 s |
| 11:00:20 | 77 s |
| 11:33:40 | 72 s |
| 11:54:10 | 97 s |
| 11:56:14 | 99 s |

Windows logged no Application Hang event for any of them.

**It is work, not waiting.** The main thread's CPU time as Windows reports it
(`ProcessThread.TotalProcessorTime`): 932 s by 12:03, then 84 s over the next
25 idle minutes - 3.4 s a minute. At that rate, the 99 minutes since launch account for ~340 s. The other
~590 s is almost exactly the ~565 s the stalls add up to, so for the length of
a stall the main thread is busy the whole time.

**What the work is.** A sampler outside Rook read the main thread's stack every
10 seconds while `IsHungAppWindow` was true (suspend, `GetThreadContext`,
resume, unwind with dbghelp). It caught a 37-second stall at 13:13:45. Every
capture had the main thread in `CreateFileW` or `NtClose`, called from the same
few addresses in `rook-oss.exe`: file handles opened and closed one after
another, for the whole stall.

The release carried no PDB, so those addresses have no names. What named them
was asking what was writing files at 13:13. Of the directories open in Rook's
tabs, one had changed:

```
C:\...\polaris  1,860,647 files, 316,332 written 13:12:30-13:16:30Z
    314,426  .claude\worktrees
```

A Claude Code session was creating git worktrees in a repository open in a
Rook tab. The stall at 10:57 matches in the same way: `cargo check`, started by
rust-analyzer, filled `rook\target\`, which holds ~100,000 files now. The
others were not checked against file activity; later writes have since
replaced the timestamps that would show it.

## Cause

`DirectoryWatcher::handle_watcher_event` runs on the main thread and, for every
path in every filesystem event, calls `Repository::check_gitignore_status`. That
called `path.is_dir()` - on Windows `CreateFileW`, a query and `CloseHandle`,
the exact frames in the samples - to pass the path's kind to the gitignore
matcher. The watcher cannot be told to skip ignored subtrees:
`ReadDirectoryChangesW` watches the whole tree and reports everything under it.
A tree of 300,000 new files is 300,000 stats on the UI thread.

Without symbols the sampled frames cannot be pinned to this function by name.
It is the one per-path stat on the main thread in the event path, and it scales
with the flood that was under way; the first capture on a build that kept its
PDB will confirm it or not.

The code is upstream's, unchanged. It shows here because several Claude
sessions create worktrees and build artifacts inside repositories that are open
in Rook tabs.

## Fix

`check_gitignore_status` now asks for the kind only when the answer depends on
it (`matches_gitignores_of_unknown_kind` in `crates/repo_metadata/src/entry.rs`).
Parents are always matched as directories; the path's own kind matters only to
a directory-only pattern such as `node_modules/` naming that path itself, which
is the one case where matching it as a file and as a directory disagree. Every
other path - everything inside `target/`, every unignored source file, every
path in a worktree - is settled by the patterns with no disk access. The result
is identical to the old one in every case, which the test checks, along with
which paths are allowed to cause a stat.

## Ruled out along the way

Each was measured against the main thread's CPU on the running build:

- **The skills watcher on `~/.claude`.** 500 appends to a file there, the way a
  transcript grows: 0.69 s of main-thread CPU against a 0.88 s baseline.
- **Floods under `target/`, at small scale.** 2000 files created and deleted:
  no change. That result was misleading. Even at an assumed 100 us a stat,
  2000 of them are 0.2 s, lost in the noise; the stalls needed hundreds of
  thousands.
- **rust-analyzer as such.** Stalls continued after it was killed - but its
  `cargo check` is one of the file floods above.
- **The autosave's own disk access.** It canonicalizes one directory per tab;
  every tab here is on a local disk.

## What this does not cover

- The watcher still visits every path on the main thread, and every subscriber
  receives a copy of the update. With the stat gone that is in-memory work, but
  it is proportional to the flood. Moving event classification off the main
  thread is the complete fix.
- `.git/info/exclude` was not among the patterns `Repository` loads, only the
  root `.gitignore` and the global one. That is why the worktrees above counted
  as not ignored. It is loaded now - see
  [git-info-exclude-is-never-loaded.md](git-info-exclude-is-never-loaded.md),
  which also explains why that stops the work downstream of the tag but not,
  on Windows, the events themselves.
- Release builds did not keep their PDB until `74836d7`, and it was named wrong
  until `d21de84`. From the next release on, a stack like the ones above can be
  resolved to function names.
